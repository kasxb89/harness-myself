import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { Config, resolveProfiles, type PiAiProviderProfile } from '../src/config.ts'
import { MAX_CAPACITY_TOKENS, type PiAiModelProfile } from '../src/catalog.ts'
import { memoryAuth } from './auth-double.ts'
import { textEvents } from './mock-server.ts'

const provider = 'managed-gateway'
const scope = 'backend-account-a'
const base: PiAiProviderProfile = { api: 'openai-completions', baseURL: 'https://managed-limits.invalid/v1',
  compat: { maxTokensField: 'max_tokens' }, managedLimitsScope: scope }
const model = (id: string, contextWindow: number, maxTokens: number): PiAiModelProfile =>
  ({ id, managedLimits: { scope, contextWindow, maxTokens } })

function memoryRequests(api: 'chat/completions' | 'responses' = 'chat/completions'): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toBe(`https://managed-limits.invalid/v1/${api}`)
    const body: unknown = await request.json()
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected SDK JSON request')
    calls.push(body as Record<string, unknown>)
    if (api === 'responses') return Response.json({ error: { message: 'Synthetic completed wire observation' } }, { status: 400 })
    return new Response(textEvents.map(event => `data: ${event}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }))
  return calls
}
function adapterFor(profile: PiAiProviderProfile): { adapter: PiAiAdapter; update: (profile: PiAiProviderProfile) => void } {
  let profiles = resolveProfiles({ [provider]: profile })
  return {
    adapter: new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-key', auth: memoryAuth() }),
    update: (profile) => { profiles = resolveProfiles({ [provider]: profile }) },
  }
}
async function drain(adapter: PiAiAdapter, id: string, maxTokens?: number): Promise<void> {
  const chunks = []
  for await (const chunk of adapter.stream({ provider, model: id, messages: [], ...maxTokens === undefined ? {} : { maxTokens } })) {
    chunks.push(chunk)
  }
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
}
afterEach(() => { vi.unstubAllGlobals() })

describe('account-scoped managed capacities', () => {
  it('keeps absent managed declarations absent through the settings schema', () => {
    const options = Config({ providers: { [provider]: { ...base, models: [{ id: 'legacy' }] } } }).providers.get()
    expect(options[provider]?.models?.[0]?.managedLimits).toBeUndefined()
    expect(() => Config({ providers: { [provider]: { ...base, models: [{ id: 'broken', managedLimits: { scope, maxTokens: Infinity } }] } } }))
      .toThrow()
  })
  it('uses each model’s real context and output limits rather than the smaller unknown-model defaults', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [model('large', 1_048_576, 393_216), model('small', 32_768, 8192)] })
    expect(await adapter.resolveModel(provider, 'large')).toMatchObject({ context: { contextWindow: 1_048_576 }, maxOutputTokens: 393_216 })
    expect(await adapter.resolveModel(provider, 'large')).toHaveProperty('defaultMaxTokens', 393_216)
    expect(await adapter.resolveModel(provider, 'small')).toMatchObject({ context: { contextWindow: 32_768 }, defaultMaxTokens: 8192, maxOutputTokens: 8192 })
    await drain(adapter, 'large'); await drain(adapter, 'small')
    expect(calls.map(call => [call.model, call.max_tokens])).toEqual([['large', 393_216], ['small', 8192]])
    expect(JSON.stringify(calls)).not.toMatch(/managedLimits|backend-account-a/)
  })
  it('applies both increases and decreases to later requests while prepared calls retain their original snapshot', async () => {
    const calls = memoryRequests()
    const { adapter, update } = adapterFor({ ...base, models: [model('dynamic', 65_536, 8192)] })
    const prepared = await adapter.prepareCall(provider, 'dynamic')
    update({ ...base, models: [model('dynamic', 1_048_576, 393_216)] })
    await drain(adapter, 'dynamic')
    expect(await adapter.resolveModel(provider, 'dynamic')).toMatchObject({ context: { contextWindow: 1_048_576 }, maxOutputTokens: 393_216 })
    for await (const _chunk of prepared.stream({ provider, model: 'dynamic', messages: [] })) { /* Consume the frozen call. */ }
    update({ ...base, models: [model('dynamic', 32_768, 4096)] })
    await drain(adapter, 'dynamic', 500_000)
    expect(calls.map(call => call.max_tokens)).toEqual([393_216, 8192, 4096])
  })
  it('keeps smaller manual limits and clamps an explicitly larger request before the real SDK serializes it', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [{ ...model('manual', 1_048_576, 393_216), contextWindow: 65_536, maxTokens: 2048 }] })
    expect(await adapter.resolveModel(provider, 'manual')).toMatchObject({ context: { contextWindow: 65_536 }, defaultMaxTokens: 2048, maxOutputTokens: 2048 })
    await drain(adapter, 'manual', 90_000)
    await drain(adapter, 'manual', 512)
    expect(calls.map(call => call.max_tokens)).toEqual([2048, 512])
  })
  it('tightens a larger manual default and bounds a partially refreshed output by the effective context', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [{ ...model('refreshing', 8192, 393_216), maxTokens: 400_000 }] })
    expect(await adapter.resolveModel(provider, 'refreshing')).toMatchObject({ context: { contextWindow: 8192 }, defaultMaxTokens: 4096, maxOutputTokens: 4096 })
    await drain(adapter, 'refreshing', 1_000_000)
    expect(calls[0]?.max_tokens).toBe(4096)
  })
  it('does not transfer another account’s limits or turn the legacy fallback into a hard output ceiling', async () => {
    const calls = memoryRequests()
    const { adapter, update } = adapterFor({ ...base, managedLimitsScope: 'backend-account-b', models: [model('shared-id', 1_048_576, 393_216)] })
    const resolved = await adapter.resolveModel(provider, 'shared-id')
    expect(resolved).toMatchObject({ context: { contextWindow: 262_144 } })
    expect(resolved).not.toHaveProperty('maxOutputTokens')
    expect(resolved).not.toHaveProperty('defaultMaxTokens')
    await drain(adapter, 'shared-id', 65_536)
    update({ ...base, models: [model('shared-id', 1_048_576, 393_216)] })
    await drain(adapter, 'shared-id')
    expect(calls.map(call => call.max_tokens)).toEqual([65_536, 393_216])
  })
  it('keeps the output ceiling while the SDK further reduces wire tokens for nonempty history', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [model('near-context', 8192, 8192)] })
    const info = await adapter.resolveModel(provider, 'near-context')
    expect(info.maxOutputTokens).toBe(4096)
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(8000) }], source: { kind: 'user' } }),
      createAssistantMessage({ content: [{ type: 'text', text: 'y'.repeat(2000) }], source: { provider, model: 'near-context' } }),
      createUserMessage({ content: [{ type: 'text', text: 'z'.repeat(2000) }], source: { kind: 'user' } }),
    ]
    for await (const _chunk of adapter.stream({ provider, model: 'near-context', messages, maxTokens: 1_000_000 })) {
      // Consume the real SDK stream; no provider-network call leaves the in-memory fetch.
    }
    expect(calls[0]?.max_tokens).toBe(1096)
    expect(calls[0]?.max_tokens).toBeLessThan(info.maxOutputTokens ?? 0)
  })
  it('rejects malformed request budgets before any SDK request is sent', async () => {
    const calls = memoryRequests()
    const { adapter } = adapterFor({ ...base, models: [model('bounded', 1_048_576, 393_216)] })
    for (const invalid of [0, -1, 0.5, NaN, Infinity, MAX_CAPACITY_TOKENS + 1]) {
      await expect(drain(adapter, 'bounded', invalid)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(calls).toEqual([])
  })
  it('refuses out-of-range declared limits instead of converting them into usable caps', () => {
    for (const invalid of [0, -1, 0.5, NaN, Infinity, MAX_CAPACITY_TOKENS + 1]) {
      expect(() => resolveProfiles({ [provider]: { ...base, models: [{ id: 'invalid', managedLimits: { scope, maxTokens: invalid } }] } }))
        .toThrow(/managedLimits.maxTokens/)
    }
  })
  it('rejects managed Responses limits the real SDK would raise or omit, preserving unmanaged compatibility', async () => {
    const calls = memoryRequests('responses')
    const responses: PiAiProviderProfile = { api: 'openai-responses', baseURL: base.baseURL ?? '', managedLimitsScope: scope }
    const legacySmall = adapterFor({ ...responses, models: [{ id: 'small-response', contextWindow: 32_768, maxTokens: 8 }] }).adapter
    for await (const _chunk of legacySmall.stream({ provider, model: 'small-response', messages: [], maxTokens: 8 })) { /* Observe actual SDK JSON. */ }
    expect(calls[0]?.max_output_tokens).toBe(16)
    expect(() => adapterFor({ ...responses, models: [model('small-response', 32_768, 8)] })).toThrow(/Responses minimum/)
    const noOutput = { ...responses, compat: { supportsMaxOutputTokens: false } }
    const legacyOmitted = adapterFor({ ...noOutput, models: [{ id: 'omitted-response', contextWindow: 32_768, maxTokens: 2048 }] }).adapter
    for await (const _chunk of legacyOmitted.stream({ provider, model: 'omitted-response', messages: [] })) { /* Observe actual SDK JSON. */ }
    expect(calls[1]).not.toHaveProperty('max_output_tokens')
    expect(() => adapterFor({ ...noOutput, models: [model('omitted-response', 32_768, 2048)] })).toThrow(/max_output_tokens support/)
    expect(calls).toHaveLength(2)
  })
  it('keeps valid Responses budgets on the wire and rejects smaller explicit budgets before dispatch', async () => {
    const calls = memoryRequests('responses')
    const { adapter } = adapterFor({ api: 'openai-responses', baseURL: base.baseURL ?? '', managedLimitsScope: scope,
      models: [model('bounded-response', 32_768, 2048)] })
    await expect(drain(adapter, 'bounded-response', 8)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(calls).toEqual([])
    for await (const _chunk of adapter.stream({ provider, model: 'bounded-response', messages: [], maxTokens: 16 })) { /* Observe actual SDK JSON. */ }
    expect(calls[0]?.max_output_tokens).toBe(16)
  })
  it('rejects Responses history whose remaining room would make the SDK raise a budget above its available context', async () => {
    const calls = memoryRequests('responses')
    const { adapter } = adapterFor({ api: 'openai-responses', baseURL: base.baseURL ?? '', managedLimitsScope: scope,
      models: [model('full-response', 8192, 2048)] })
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(16_384) }], source: { kind: 'user' } })]
    await expect(async () => {
      for await (const _chunk of adapter.stream({ provider, model: 'full-response', messages })) { /* No SDK request is allowed. */ }
    }).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(calls).toEqual([])
  })
  it('leaves native protocol profiles unchanged without managed limits and rejects unsupported managed combinations', () => {
    const anthropic: PiAiProviderProfile = { api: 'anthropic-messages', baseURL: 'https://managed-limits.invalid',
      models: [{ id: 'native-model', maxTokens: 2048 }] }
    expect(() => adapterFor(anthropic)).not.toThrow()
    expect(() => adapterFor({ ...anthropic, managedLimitsScope: scope, models: [model('native-model', 32_768, 2048)] }))
      .toThrow(/managed output limits are not supported/)
  })
  it('does not dispatch managed official Responses with credentials that cause the SDK to omit output limits', async () => {
    const calls = memoryRequests('responses')
    const profiles = resolveProfiles({ openai: { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', managedLimitsScope: scope,
      models: [model('managed-openai', 32_768, 2048)] } })
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-oauth-token', auth: memoryAuth() })
    await expect(async () => {
      for await (const _chunk of adapter.stream({ provider: 'openai', model: 'managed-openai', messages: [] })) { /* No request is allowed. */ }
    }).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(calls).toEqual([])
  })
})
