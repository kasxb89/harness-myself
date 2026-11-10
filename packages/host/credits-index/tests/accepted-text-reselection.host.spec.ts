/** Real Go HTTP capture through the SDK, shipping loop, account fence and model recovery. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai/src/adapter.ts'
import { resolveProfiles, type PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { memoryAuth } from '../../../llm/llm-pi-ai/tests/auth-double.ts'
import { createSessionTestRemote } from '../../../api/session-controller/tests/test-remote.ts'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { ApiSessionAgentController } from '../../../api/session-controller/src/agent.ts'
import { registerProductTextModelPolicy } from '../src/text-model-policy.ts'

interface GoCase {
  name: string
  body: string
  status: number
  headers: Record<string, string>
  request: { model: string }
  provider_posts: number
  consumption_logs: number
}
interface HarnessOptions {
  output?: number
  window?: number
  input?: string
  ownerChange?: boolean
  cancel?: boolean
  noMeter?: boolean
  authGate?: boolean
  authGateAt?: number
  toolRound?: boolean
  firstResponseGate?: boolean
}
const fixture = JSON.parse(readFileSync(new URL('../../../llm/llm-pi-ai/tests/fixtures/text-reselection-go-http.json', import.meta.url), 'utf8')) as { cases: GoCase[] }
function captured(name: string): GoCase {
  const value = fixture.cases.find(item => item.name === name)
  if (value === undefined) throw new Error(`Missing actual Go case: ${name}`)
  return value
}
const scope = 'synthetic-backend-account'
const endpoint = 'https://8.133.202.230/harness/v1/chat/completions'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function harness(first: GoCase, options: HarnessOptions = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Retry)
  if (!options.noMeter) await ctx.plugin(TokenMeter)
  registerProductTextModelPolicy(ctx, { revision: () => 1 })
  let owner = 'synthetic-opaque-login-owner'
  ctx.on('api-session/prompt-owner', () => owner)
  const source = first.request.model
  const target = source === 'gpt-4o' ? 'replacement-text' : 'gpt-4o'
  const capabilities = { schemaVersion: 2 as const, revision: 'fixture', tools: true, vision: false, reasoning: false,
    stream: true, maxInputTokens: 1_048_576,
    verification: { tools: 'supported' as const, vision: 'unsupported' as const, reasoning: 'unsupported' as const } }
  const profile: PiAiProviderProfile = {
    api: 'openai-completions', baseURL: 'https://8.133.202.230/harness/v1', apiKeyEnv: 'SYNTHETIC', managedLimitsScope: scope,
    compat: { maxTokensField: 'max_tokens', supportsStore: false, supportsDeveloperRole: false },
    retryPolicy: { mode: 'always' },
    models: [
      { id: source, managedLimits: {
        scope, authoritative: true, contextWindow: 1_048_576, maxTokens: 32768, textCapabilities: capabilities,
      } },
      { id: target, managedLimits: { scope, authoritative: true, contextWindow: options.window ?? 131072, maxTokens: options.output ?? 4096,
        textCapabilities: { ...capabilities, maxInputTokens: 131072 } } },
    ],
  }
  let profiles = resolveProfiles({ product: profile })
  const authEntered = Promise.withResolvers<undefined>()
  const authRelease = Promise.withResolvers<undefined>()
  let authCalls = 0
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => {
    authCalls++
    if (options.authGate && authCalls === (options.authGateAt ?? 2)) { authEntered.resolve(undefined); await authRelease.promise }
    return 'synthetic-key'
  }, auth: memoryAuth() })
  ctx.llm.registerAdapter(['product'], adapter)
  ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'echo', parameters: {},
    async execute() { return [{ type: 'text', text: 'echo' }] } }))
  let mounted: ReturnType<typeof createSessionTestRemote> | undefined
  const mount = Object.assign((owner: Context) => {
    mounted = createSessionTestRemote(owner, { defaultModelSelection: () => ({ provider: 'product', model: target }), cwd: '/tmp' })
  }, { inject: SessionController.inject.filter(key => ctx.get(key) !== undefined) })
  const apiFiber = await ctx.plugin(mount)
  if (mounted === undefined) throw new Error('Expected the API plugin owner')
  const remote = mounted
  const sessionId = SessionId('accepted-zero-send')
  expect(await remote.create({ sessionId, cwd: '/tmp' })).toMatchObject({ ok: true })
  expect(await remote.selectModel({ sessionId, provider: 'product', model: source })).toMatchObject({ ok: true })
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Expected a shipping-loop Agent')
  const wire: Record<string, unknown>[] = []
  const replayed: GoCase[] = []
  const firstResponseEntered = Promise.withResolvers<undefined>()
  const firstResponseRelease = Promise.withResolvers<undefined>()
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toBe(endpoint)
    expect(request.method).toBe('POST')
    expect(request.headers.get('X-Yunshu-Text-Reselection')).toBe('1')
    wire.push(await request.json() as Record<string, unknown>)
    if (wire.length === 1) {
      if (options.ownerChange) owner = 'different-opaque-login-owner'
      if (options.cancel) agent.cancel({ kind: 'user' })
      if (options.firstResponseGate) { firstResponseEntered.resolve(undefined); await firstResponseRelease.promise }
    }
    if (options.toolRound && wire.length === 2) {
      const base = { id: 'synthetic-tool-reply', object: 'chat.completion.chunk', created: 1700000000, model: target }
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-echo', type: 'function',
          function: { name: 'echo', arguments: '{}' } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
      ]
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const response = wire.length === 1 ? first : captured('completed once')
    replayed.push(response)
    return new Response(response.body, { status: response.status, headers: response.headers })
  })
  vi.stubGlobal('fetch', transport)
  const run = async () => {
    expect(await remote.prompt({ sessionId, requestId: 'one-human-request' as SessionRequestId, mode: 'queue',
      content: [{ type: 'text', text: options.input ?? 'Synthetic local fixture' }] })).toMatchObject({ ok: true })
    await agent.whenIdle()
  }
  return { ctx, agent, apiFiber, adapter, source, target, wire, replayed, transport, run,
    authEntered, authRelease, firstResponseEntered, firstResponseRelease,
    update: (value: PiAiProviderProfile) => { profiles = resolveProfiles({ product: value }) }, profile }
}

describe('accepted human request with actual Go zero-send proof', () => {
  it.each([4096, 393216])('reselects once with a new window and output ceiling %s without another human message or settlement', async (output) => {
    const f = await harness(captured('missing channel'), { output })
    await f.run()
    expect(f.wire.map(value => value.model)).toEqual([f.source, f.target])
    expect(f.wire[0]?.max_tokens).toBe(32768)
    expect(Number(f.wire[1]?.max_tokens)).toBeGreaterThan(0)
    expect(Number(f.wire[1]?.max_tokens)).toBeLessThanOrEqual(131072)
    if (output === 4096) expect(f.wire[1]?.max_tokens).toBe(4096)
    expect(f.replayed.reduce((sum, item) => sum + item.provider_posts, 0)).toBe(1)
    expect(f.replayed.reduce((sum, item) => sum + item.consumption_logs, 0)).toBe(1)
    const events = f.agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(f.agent.session.requestContext()).toMatchObject({ provider: 'product', model: f.target, contextWindow: 131072 })
    expect(f.agent.session.requestHeader()?.config.model).toBe(f.target)
  })

  it('never expands the prepared window when fresh metadata grows while the final guard is pending', async () => {
    const f = await harness(captured('missing channel'), { window: 32768 })
    f.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      const selected = f.ctx.sessionProjections.snapshot(f.agent.session).values.modelSelection?.next?.model
      return selected === f.target ? { ...assembled,
        sections: [...assembled.sections, { name: 'large-reassembled-context', text: '界'.repeat(160_000) }] } : assembled
    })
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const original = f.ctx.llm.resolveModelInfo.bind(f.ctx.llm)
    let waiting = false
    vi.spyOn(f.ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, model, signal) => {
      if (!waiting && model === f.target && f.agent.session.requestContext()?.model === f.target) {
        waiting = true; entered.resolve(undefined); await gate.promise
      }
      return await original(provider, model, signal)
    })
    const run = f.run()
    void run.catch(() => {})
    try {
      await entered.promise
      f.update({ ...f.profile, models: (f.profile.models ?? []).map((model) => {
        if (model.id !== f.target) return model
        if (model.managedLimits === undefined) throw new Error('Expected scoped fixture limits')
        return { ...model, managedLimits: { ...model.managedLimits, contextWindow: 131072 } }
      }) })
      gate.resolve(undefined)
      await run
      expect(f.transport).toHaveBeenCalledOnce()
      expect(f.agent.session.requestContext()).toMatchObject({ model: f.target, contextWindow: 32768 })
      expect(f.ctx.tokenMeter.measure(f.agent.session).totalTokens).toBeGreaterThan(32768)
    } finally { gate.resolve(undefined); await run }
  })

  it('drains a cancelled final preparation before API unload and sends no replacement after disposal', async () => {
    const f = await harness(captured('missing channel'))
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const original = f.ctx.llm.resolveModelInfo.bind(f.ctx.llm)
    let waiting = false
    vi.spyOn(f.ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, model, signal) => {
      if (!waiting && model === f.target && f.agent.session.requestContext()?.model === f.target) {
        waiting = true; entered.resolve(undefined); await gate.promise
      }
      return await original(provider, model, signal)
    })
    const run = f.run()
    void run.catch(() => {})
    let disposal: Promise<void> | undefined
    try {
      await entered.promise
      disposal = f.apiFiber.dispose()
      gate.resolve(undefined)
      await Promise.all([run, disposal])
      expect(f.transport).toHaveBeenCalledOnce()
    } finally { gate.resolve(undefined); await Promise.all([run, disposal]) }
  })

  it('carries the API lifetime into SDK authentication so unloading after the guard cannot dispatch later', async () => {
    const f = await harness(captured('missing channel'), { authGate: true })
    const aborted = Promise.withResolvers<undefined>()
    let replacementSignal: AbortSignal | undefined
    f.ctx.on('llm/stream', (request, next) => {
      if (request.model === f.target) {
        replacementSignal = request.signal
        request.signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      }
      return next()
    })
    const run = f.run()
    void run.catch(() => {})
    let disposal: Promise<void> | undefined
    try {
      await f.authEntered.promise
      disposal = f.apiFiber.dispose()
      await aborted.promise
      expect(replacementSignal?.aborted).toBe(true)
      f.authRelease.resolve(undefined)
      await Promise.all([run, disposal])
      expect(f.transport).toHaveBeenCalledOnce()
    } finally { f.authRelease.resolve(undefined); await Promise.all([run, disposal]) }
  })

  it('keeps the recovered owner through a tool continuation and cancels step-two authentication before dispatch', async () => {
    const f = await harness(captured('missing channel'), { toolRound: true, authGate: true, authGateAt: 3 })
    const aborted = Promise.withResolvers<undefined>()
    let continuationSignal: AbortSignal | undefined
    let targetAttempts = 0
    f.ctx.on('llm/stream', (request, next) => {
      if (request.model === f.target && ++targetAttempts === 2) {
        continuationSignal = request.signal
        request.signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      }
      return next()
    })
    const run = f.run()
    void run.catch(() => {})
    let disposal: Promise<void> | undefined
    try {
      await f.authEntered.promise
      expect(f.wire.map(request => request.model)).toEqual([f.source, f.target])
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
      disposal = f.apiFiber.dispose()
      await aborted.promise
      expect(continuationSignal?.aborted).toBe(true)
      f.authRelease.resolve(undefined)
      await Promise.all([run, disposal])
      expect(f.transport).toHaveBeenCalledTimes(2)
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    } finally { f.authRelease.resolve(undefined); await Promise.all([run, disposal]) }
  })

  it('unloads a recovery waiting for an unrelated image admission without waiting for that gate or committing later', async () => {
    const serialization = vi.spyOn(ApiSessionAgentController.prototype, 'serializeImageAdmission')
    const f = await harness(captured('missing channel'), { firstResponseGate: true })
    const run = f.run()
    void run.catch(() => {})
    const imageGate = Promise.withResolvers<undefined>()
    const imageEntered = Promise.withResolvers<undefined>()
    let image: Promise<void> | undefined
    let disposal: Promise<void> | undefined
    try {
      await f.firstResponseEntered.promise
      const admissionOwner = serialization.mock.contexts[0]
      if (!(admissionOwner instanceof ApiSessionAgentController)) throw new Error('Expected the real admission controller')
      image = admissionOwner.serializeImageAdmission(f.agent, async () => { imageEntered.resolve(undefined); await imageGate.promise })
      await imageEntered.promise
      const previousCalls = serialization.mock.calls.length
      f.firstResponseRelease.resolve(undefined)
      await vi.waitFor(() => { expect(serialization).toHaveBeenCalledTimes(previousCalls + 1) })
      disposal = f.apiFiber.dispose()
      await Promise.all([run, disposal])
      expect(f.transport).toHaveBeenCalledOnce()
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'model/selection'
        && event.data.model === f.target)).toHaveLength(0)
      imageGate.resolve(undefined)
      await Promise.allSettled([image, serialization.mock.results.at(-1)?.value])
      expect(f.transport).toHaveBeenCalledOnce()
    } finally {
      f.firstResponseRelease.resolve(undefined); imageGate.resolve(undefined)
      await Promise.allSettled([run, image, disposal, serialization.mock.results.at(-1)?.value])
    }
  })

  it.each(['legacy request unchanged', 'provider spoofed receipt', 'provider timeout', 'partial output'])('does not reselect or SDK-retry %s', async (name) => {
    const f = await harness(captured(name))
    await f.run()
    expect(f.transport).toHaveBeenCalledOnce()
    expect(f.agent.session.requestHeader()?.config.model).toBe(f.source)
  })

  it.each(['owner', 'cancel', 'no meter'] as const)('refuses a valid proof after %s', async (mode) => {
    const f = await harness(captured('missing channel'), { ownerChange: mode === 'owner', cancel: mode === 'cancel', noMeter: mode === 'no meter' })
    await f.run()
    expect(f.transport).toHaveBeenCalledOnce()
    expect(f.agent.session.requestHeader()?.config.model).toBe(f.source)
  })

  it('retains oversized input and sends no replacement POST when its measured pressure exceeds the smaller model window', async () => {
    const f = await harness(captured('missing channel'), { input: '界'.repeat(800_000) })
    await f.run()
    expect(f.ctx.tokenMeter.measure(f.agent.session).totalTokens).toBeGreaterThan(131072)
    expect(f.transport).toHaveBeenCalledOnce()
    expect(f.agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error' } } })
  })
})
