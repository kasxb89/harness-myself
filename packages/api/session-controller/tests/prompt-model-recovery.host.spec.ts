/** Automatic model selection is confined to one not-yet-admitted human request. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, LlmTextCapabilities, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { recoverPromptModel } from '../src/prompt-model.ts'
import { ApiSessionAgentController } from '../src/agent.ts'
import { createSessionTestRemote } from './test-remote.ts'

const unknown: LlmTextCapabilities = {
  schemaVersion: 2, revision: 'fixture', tools: false, vision: false, reasoning: false,
  stream: true, maxInputTokens: 32000,
  verification: { tools: 'unverified', vision: 'unverified', reasoning: 'unverified' },
  reasoningMode: 'unknown', operationalStatus: 'available',
}

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  const models = new Map<string, LlmResolvedModelInfo>([
    ['alternate', { provider: 'product', id: 'alternate', name: 'Alternate' }],
    ['preferred', { provider: 'product', id: 'preferred', name: 'Preferred' }],
  ])
  const list = vi.fn((): Promise<readonly LlmModelInfo[]> => Promise.resolve([...models.values()]))
  const resolve = vi.fn((provider: string, model: string): Promise<LlmResolvedModelInfo> => {
    const found = models.get(model)
    return found === undefined ? Promise.reject(new LlmError('synthetic removed model', 'UNKNOWN_MODEL'))
      : Promise.resolve({ ...found, provider })
  })
  const stream = vi.fn()
  ctx.llm.registerAdapter(['product'], new class extends LlmAdapter {
    override providerInfo(provider: string) { return { id: provider, name: 'Product' } }
    override listModels() { return list() }
    override resolveModel(provider: string, model: string) { return resolve(provider, model) }
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { stream() }
  }())
  const session = ctx.sessions.create()
  session.append('request/header', { header: { config: {
    provider: 'product', model: 'removed', reasoningEffort: ReasoningEffortId('high'),
  } }, reason: 'initial' })
  const admitted: UserMessage[] = []
  const followup = vi.fn((message: UserMessage) => { admitted.push(message) })
  const agent: Agent = {
    id: session.id, session, ctx, options: {}, status: 'idle',
    inbox: { ...unsupportedInbox(), nextTurn: admitted, nextStep: [] },
    followup, steer: followup, send: () => {}, inject: () => {}, cancel: () => {},
    whenIdle: () => Promise.resolve(), runMaintenance: task => task(new AbortController().signal),
  }
  await ctx.agents.register(agent)
  let preferred: ModelSelection = { provider: 'product', model: 'preferred' }
  const save = vi.fn()
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => preferred, saveDefaultModelSelection: save, cwd: '/tmp',
  })
  const request = (id = 'one', mode: 'queue' | 'steer' = 'queue'): SessionPromptRequest => ({
    sessionId: session.id, requestId: id as SessionRequestId, mode, content: [{ type: 'text', text: 'hello' }],
  })
  const selected = () => ctx.sessionProjections.snapshot(session).values.modelSelection?.next
  return { ctx, agent, models, list, resolve, stream, session, remote, request, followup, admitted, selected, save,
    setDefault: (value: ModelSelection) => { preferred = value } }
}

describe('pre-admission text model recovery', () => {
  it.each(['queue', 'steer'] as const)('uses the valid catalog default for %s, retains the request identity and does not save a global preference', async (mode) => {
    const f = await harness()
    const request = f.request('original', mode)
    expect(await f.remote.prompt(request)).toMatchObject({ ok: true, value: { accepted: true } })
    expect(f.selected()).toEqual({ provider: 'product', model: 'preferred' })
    expect(f.followup).toHaveBeenCalledOnce()
    expect(f.admitted[0]).toMatchObject({ content: request.content, source: { rpcId: request.requestId } })
    expect(f.save).not.toHaveBeenCalled()
    expect(f.stream).not.toHaveBeenCalled()
    await f.remote.prompt(request)
    expect(f.followup).toHaveBeenCalledOnce()
  })

  it('keeps a resolvable explicit model without reading the advisory directory or changing reasoning', async () => {
    const f = await harness()
    f.models.set('removed', { provider: 'product', id: 'removed', name: 'Explicit' })
    f.list.mockRejectedValue(new Error('directory unavailable'))
    expect(await f.remote.prompt(f.request())).toMatchObject({ ok: true })
    expect(f.list).not.toHaveBeenCalled()
    expect(f.session.snapshotEvents().filter(event => event.type === 'model/selection')).toEqual([])
    expect(f.save).not.toHaveBeenCalled()
  })

  it('keeps the original model if the fresh account directory restores it before admission', async () => {
    const f = await harness()
    f.setDefault({ provider: 'product', model: 'removed' })
    f.models.set('removed', { provider: 'product', id: 'removed', name: 'Restored' })
    f.resolve.mockRejectedValueOnce(new LlmError('stale configured model', 'UNKNOWN_MODEL'))
    expect(await f.remote.prompt(f.request())).toMatchObject({ ok: true })
    expect(f.session.snapshotEvents().filter(event => event.type === 'model/selection')).toEqual([])
    expect(f.followup).toHaveBeenCalledOnce()
  })

  it('skips an unavailable default and incompatible tool-history candidates without rejecting unverified facts', async () => {
    const f = await harness()
    f.models.set('preferred', { provider: 'product', id: 'preferred', name: 'Unavailable',
      textCapabilities: { ...unknown, operationalStatus: 'fixed_lane_unavailable' } })
    f.models.set('alternate', { provider: 'product', id: 'alternate', name: 'No tools',
      textCapabilities: { tools: false, vision: false, reasoning: false, stream: true, maxInputTokens: 32000 } })
    f.models.set('compatible', { provider: 'product', id: 'compatible', name: 'Unverified', textCapabilities: unknown })
    f.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'old', model: 'tool-capable' },
      content: [{ type: 'tool-call', id: ToolCallId('old-call'), name: 'read', arguments: '{}' }],
    }) }, { surfaceOp: 'append' })
    expect(await f.remote.prompt(f.request())).toMatchObject({ ok: true })
    expect(f.selected()).toEqual({ provider: 'product', model: 'compatible' })
    expect(f.followup).toHaveBeenCalledOnce()
  })

  it('recovers a confirmed route outage while a normal same-account catalog refresh changes metadata', async () => {
    const f = await harness()
    f.models.set('removed', { provider: 'product', id: 'removed', name: 'Offline',
      textCapabilities: { ...unknown, operationalStatus: 'fixed_lane_unavailable' } })
    f.list.mockImplementation(async () => {
      f.ctx.emit('api-session/model-catalog-changed')
      return [...f.models.values()]
    })
    expect(await f.remote.prompt(f.request())).toMatchObject({ ok: true })
    expect(f.selected()).toEqual({ provider: 'product', model: 'preferred' })
  })

  it('selects an image-capable replacement instead of discarding a pending image for a text-only default', async () => {
    const f = await harness()
    f.models.set('preferred', { provider: 'product', id: 'preferred', name: 'Text only', inputModalities: ['text'] })
    f.models.set('alternate', { provider: 'product', id: 'alternate', name: 'Images',
      inputModalities: ['text', 'image'], textCapabilities: unknown })
    expect(await recoverPromptModel(f.ctx, { provider: 'product', model: 'removed', reasoningEffort: 'high' },
      [{ type: 'image', mediaType: 'image/png', data: 'AQ==' }], [], undefined, () => {}))
      .toEqual({ provider: 'product', model: 'alternate' })
    expect(f.stream).not.toHaveBeenCalled()
  })

  it('reports no compatible model before enqueue and preserves the original selection', async () => {
    const f = await harness()
    f.models.clear()
    expect(await f.remote.prompt(f.request())).toMatchObject({ ok: false, error: {
      code: 'session/model-unavailable', details: { reason: 'NO_AVAILABLE_MODEL' },
    } })
    expect(f.followup).not.toHaveBeenCalled()
    expect(f.selected()).toMatchObject({ provider: 'product', model: 'removed', reasoningEffort: 'high' })
    expect(f.save).not.toHaveBeenCalled()
  })

  it('keeps a failed directory read distinct from a confirmed absence of models', async () => {
    const f = await harness()
    f.list.mockRejectedValue(new Error('synthetic directory unavailable'))
    expect(await f.remote.prompt(f.request())).toMatchObject({ ok: false, error: {
      code: 'session/provider-models-unavailable',
    } })
    expect(f.followup).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'owner', 'credential'] as const)('does not commit or enqueue after %s changes while the directory is pending', async (change) => {
    const f = await harness()
    let owner = 'first-opaque-owner'
    f.ctx.on('api-session/prompt-owner', () => owner)
    const gate = Promise.withResolvers<readonly LlmModelInfo[]>()
    f.list.mockReturnValueOnce(gate.promise)
    const controller = new AbortController()
    let pending: ReturnType<typeof f.remote.prompt> | undefined
    try {
      pending = f.remote.prompt(f.request(), controller.signal)
      await vi.waitFor(() => { expect(f.list).toHaveBeenCalledOnce() })
      if (change === 'cancel') controller.abort()
      if (change === 'owner') owner = 'replacement-opaque-owner'
      if (change === 'credential') f.ctx.emit('credentials/reference-updated', credentialRef('SYNTHETIC_REF'))
      gate.resolve([...f.models.values()])
      expect(await pending).toMatchObject({ ok: false, error: { code: change === 'cancel'
        ? 'gateway/cancelled' : 'session/model-capability-invalid' } })
      expect(f.followup).not.toHaveBeenCalled()
      expect(f.session.snapshotEvents().filter(event => event.type === 'model/selection')).toEqual([])
    } finally {
      gate.resolve([...f.models.values()])
      await pending
    }
  })

  it('singleflights one pending identity and admits distinct human requests independently of a blocked metadata hook', async () => {
    const f = await harness()
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    f.ctx.on('session/prompt-admission', async (admission, next) => {
      if (admission.requestId === 'one') { entered.resolve(undefined); await gate.promise }
      await next()
    })
    const first = f.remote.prompt(f.request())
    const duplicate = f.remote.prompt(f.request())
    try {
      await entered.promise
      expect(await f.remote.prompt(f.request('two'))).toMatchObject({ ok: true })
      expect(f.followup).toHaveBeenCalledOnce()
      gate.resolve(undefined)
      expect(await Promise.all([first, duplicate])).toMatchObject([{ ok: true }, { ok: true }])
      expect(f.followup).toHaveBeenCalledTimes(2)
      expect(f.admitted.map(message => message.source)).toMatchObject([{ rpcId: 'two' }, { rpcId: 'one' }])
    } finally {
      gate.resolve(undefined)
      await Promise.all([first, duplicate])
    }
  })

  it('admits both independent identities when simultaneous unavailable-model queries choose the same replacement', async () => {
    const f = await harness()
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    let queries = 0
    f.list.mockImplementation(async () => {
      if (++queries === 2) entered.resolve(undefined)
      await gate.promise
      return [...f.models.values()]
    })
    const first = f.remote.prompt(f.request('one'))
    const second = f.remote.prompt(f.request('two'))
    try {
      await entered.promise
      gate.resolve(undefined)
      expect(await Promise.all([first, second])).toMatchObject([{ ok: true }, { ok: true }])
      expect(f.admitted.map(({ source }) => source.kind === 'user' && 'rpcId' in source ? source.rpcId : undefined).sort())
        .toEqual(['one', 'two'])
      expect(f.followup).toHaveBeenCalledTimes(2)
      expect(f.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
      expect(f.selected()).toEqual({ provider: 'product', model: 'preferred' })
      expect(f.stream).not.toHaveBeenCalled()
    } finally { gate.resolve(undefined); await Promise.all([first, second]) }
  })

  it.each(['cancel', 'manual selection'] as const)('a blocked directory never holds the selection lock after %s', async (action) => {
    const f = await harness()
    const gate = Promise.withResolvers<readonly LlmModelInfo[]>()
    f.list.mockReturnValueOnce(gate.promise)
    const controller = new AbortController()
    const pending = f.remote.prompt(f.request('blocked'), controller.signal)
    try {
      await vi.waitFor(() => { expect(f.list).toHaveBeenCalledOnce() })
      if (action === 'cancel') {
        controller.abort()
        expect(await pending).toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
      }
      expect(await f.remote.selectModel({ sessionId: f.session.id, provider: 'product', model: 'preferred' })).toMatchObject({ ok: true })
      expect(await f.remote.prompt(f.request('independent'))).toMatchObject({ ok: true })
      expect(f.followup).toHaveBeenCalledOnce()
      gate.resolve([...f.models.values()])
      expect(await pending).toMatchObject({ ok: action === 'manual selection' })
      expect(f.selected()).toMatchObject({ provider: 'product', model: 'preferred' })
      expect(f.followup).toHaveBeenCalledTimes(action === 'manual selection' ? 2 : 1)
    } finally {
      gate.resolve([...f.models.values()])
      await pending
    }
  })

  it('revalidates a newer manual model and retains that selection when its real tool-history constraint rejects the pending input', async () => {
    const f = await harness()
    f.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'old', model: 'tool-capable' },
      content: [{ type: 'tool-call', id: ToolCallId('manual-history'), name: 'read', arguments: '{}' }],
    }) }, { surfaceOp: 'append' })
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<readonly LlmModelInfo[]>()
    f.list.mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise })
    const pending = f.remote.prompt(f.request('waiting-for-current-selection'))
    try {
      await entered.promise
      f.models.set('preferred', { provider: 'product', id: 'preferred', name: 'No tools', textCapabilities: {
        tools: false, vision: false, reasoning: false, stream: true, maxInputTokens: 32000,
      } })
      expect(await f.remote.selectModel({ sessionId: f.session.id, provider: 'product', model: 'preferred' })).toMatchObject({ ok: true })
      gate.resolve([...f.models.values()])
      expect(await pending).toMatchObject({ ok: false, error: { code: 'session/model-capability-invalid',
        details: { reason: 'MODEL_CAPABILITY_HISTORY_UNSUPPORTED' } } })
      expect(f.selected()).toEqual({ provider: 'product', model: 'preferred' })
      expect(f.followup).not.toHaveBeenCalled()
      expect(f.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
    } finally { gate.resolve([...f.models.values()]); await pending }
  })

  it('cancels an ordinary preflight commit queued behind an image gate without waiting or admitting its message later', async () => {
    const serialization = vi.spyOn(ApiSessionAgentController.prototype, 'serializeImageAdmission')
    onTestFinished(() => { serialization.mockRestore() })
    const f = await harness()
    expect(await f.remote.prompt(f.request('warmup'))).toMatchObject({ ok: true })
    const owner = serialization.mock.contexts[0]
    if (!(owner instanceof ApiSessionAgentController)) throw new Error('Expected the real admission owner')
    const imageEntered = Promise.withResolvers<undefined>()
    const imageGate = Promise.withResolvers<undefined>()
    const image = owner.serializeImageAdmission(f.agent, async () => { imageEntered.resolve(undefined); await imageGate.promise })
    const controller = new AbortController()
    let pending: ReturnType<typeof f.remote.prompt> | undefined
    try {
      await imageEntered.promise
      const previousCalls = serialization.mock.calls.length
      pending = f.remote.prompt(f.request('cancelled-commit'), controller.signal)
      await vi.waitFor(() => { expect(serialization).toHaveBeenCalledTimes(previousCalls + 1) })
      controller.abort()
      expect(await pending).toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
      expect(f.followup).toHaveBeenCalledOnce()
      imageGate.resolve(undefined)
      await Promise.allSettled([image, serialization.mock.results.at(-1)?.value])
      expect(f.admitted.map(({ source }) => source.kind === 'user' && 'rpcId' in source ? source.rpcId : undefined))
        .toEqual(['warmup'])
      expect(f.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
    } finally {
      controller.abort(); imageGate.resolve(undefined)
      await Promise.allSettled([pending, image, serialization.mock.results.at(-1)?.value])
    }
  })
})
