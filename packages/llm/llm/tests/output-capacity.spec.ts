import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo,
  LlmError, type LlmCallConfig, type StreamChunk } from '../src/index.ts'

class CapacityAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly models = new Map<string, Omit<LlmResolvedModelInfo, 'provider' | 'id' | 'name'>>()
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...this.models.get(model) })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const adapter = new CapacityAdapter()
  adapter.models.set('small', { context: { contextWindow: 32_768 }, defaultMaxTokens: 4_096, maxOutputTokens: 8_192 })
  adapter.models.set('large', { context: { contextWindow: 1_048_576 }, defaultMaxTokens: 393_216, maxOutputTokens: 393_216 })
  ctx.llm.registerAdapter(['capacity'], adapter)
  return { ctx, adapter }
}

describe('exact-model output capacity before logging and dispatch', () => {
  it('keeps each model default and caps an explicit budget to its own limit', async () => {
    const { ctx, adapter } = await fixture()
    for (const [model, requested, expected] of [['small', 100_000, 8_192], ['large', 1_000_000, 393_216]] as const) {
      const prepared = await ctx.llm.prepareCall({ provider: 'capacity', model, maxTokens: requested })
      expect(prepared.config.maxTokens).toBe(expected)
      for await (const _chunk of prepared.stream({ ...prepared.config, messages: [] })) { /* Consume the one original request. */ }
      expect(adapter.requests.at(-1)?.maxTokens).toBe(expected)
    }
    expect((await ctx.llm.prepareCall({ provider: 'capacity', model: 'small' })).config.maxTokens).toBe(4_096)
    const explicit = { provider: 'capacity', model: 'small', maxTokens: 512 }
    expect(await ctx.llm.resolveCallConfig(explicit)).toBe(explicit)
  })

  it('does not overwrite a cap while materializing a reasoning default', async () => {
    const { ctx, adapter } = await fixture()
    const effort = ReasoningEffortId('medium')
    adapter.models.set('reasoning', { maxOutputTokens: 1_024,
      reasoning: { efforts: [{ id: effort, name: 'Medium' }], defaultEffort: effort } })
    expect((await ctx.llm.prepareCall({ provider: 'capacity', model: 'reasoning', maxTokens: 8_192 })).config)
      .toMatchObject({ maxTokens: 1_024, reasoningEffort: effort })
  })

  it('refreshes defaults on the next call while retaining an already prepared snapshot', async () => {
    const { ctx, adapter } = await fixture()
    const original = await ctx.llm.prepareCall({ provider: 'capacity', model: 'large' })
    adapter.models.set('large', { context: { contextWindow: 32_768 }, defaultMaxTokens: 8_192, maxOutputTokens: 8_192 })
    expect((await ctx.llm.prepareCall({ provider: 'capacity', model: 'large' })).config.maxTokens).toBe(8_192)
    for await (const _chunk of original.stream({ ...original.config, messages: [] })) { /* Dispatch the captured registration. */ }
    expect(adapter.requests.at(-1)?.maxTokens).toBe(393_216)
  })

  it('narrows a declared default without inventing a hard limit for older adapters', async () => {
    const { ctx, adapter } = await fixture()
    adapter.models.set('bounded', { defaultMaxTokens: 10_000, maxOutputTokens: 1_000 })
    expect(await ctx.llm.resolveModelInfo('capacity', 'bounded')).toMatchObject({ defaultMaxTokens: 1_000, maxOutputTokens: 1_000 })
    adapter.models.set('legacy', { defaultMaxTokens: 1_000 })
    expect(await ctx.llm.resolveCallConfig({ provider: 'capacity', model: 'legacy', maxTokens: 10_000 }))
      .toMatchObject({ maxTokens: 10_000 })
  })

  it('observes the final routed budget without mutating caller controls or exposing messages', async () => {
    const { ctx, adapter } = await fixture()
    ctx.on('llm/stream', (options, next) => { options.model = 'small'; return next() })
    const request: GenerateOptions = { provider: 'capacity', model: 'large', maxTokens: 100_000, messages: [], stop: ['end'] }
    let observed: Readonly<LlmCallConfig> | undefined
    for await (const _chunk of ctx.llm.stream(request, (config) => { observed = config })) { /* Consume routed dispatch. */ }
    expect(observed).toEqual({ provider: 'capacity', model: 'small', maxTokens: 8_192, stop: ['end'] })
    expect(Object.isFrozen(observed)).toBe(true)
    expect(Object.isFrozen(observed?.stop)).toBe(true)
    expect(request.maxTokens).toBe(100_000)
    expect(adapter.requests.at(-1)?.maxTokens).toBe(observed?.maxTokens)
  })

  it('contains observer failure before provider dispatch', async () => {
    const { ctx, adapter } = await fixture()
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'capacity', model: 'small', messages: [] }, () => {
      throw new LlmError('Observation failed', 'OBSERVER_FAILED')
    })) chunks.push(chunk)
    expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'OBSERVER_FAILED' } } }])
    expect(adapter.requests).toEqual([])
  })

  it('does not claim a provider configuration for a middleware-only answer', async () => {
    const { ctx, adapter } = await fixture()
    ctx.on('llm/stream', async function * () { yield { type: 'finish', reason: { kind: 'stop' } } })
    let observed = false
    for await (const _chunk of ctx.llm.stream({ provider: 'capacity', model: 'small', messages: [] }, () => {
      observed = true
    })) { /* Consume the middleware-owned response. */ }
    expect(observed).toBe(false)
    expect(adapter.requests).toEqual([])
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid capacity %s', async (maxOutputTokens) => {
    const { ctx, adapter } = await fixture()
    adapter.models.set('invalid', { maxOutputTokens })
    await expect(ctx.llm.prepareCall({ provider: 'capacity', model: 'invalid' }))
      .rejects.toMatchObject({ code: 'INVALID_MODEL_MAX_TOKENS' })
    expect(adapter.requests).toEqual([])
  })

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid explicit budget %s before dispatch', async (maxTokens) => {
    const { ctx, adapter } = await fixture()
    await expect(ctx.llm.prepareCall({ provider: 'capacity', model: 'small', maxTokens }))
      .rejects.toMatchObject({ code: 'INVALID_MAX_TOKENS' })
    expect(adapter.requests).toEqual([])
  })
})
