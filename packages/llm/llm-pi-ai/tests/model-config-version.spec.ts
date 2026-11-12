import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmRetry from '../../llm-retry/src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as PiAi from '../src/index.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { Config, resolveProfiles, type PiAiProviderProfile } from '../src/config.ts'
import type { HarnessAccount, HarnessModelConfigRequest } from '../src/harness-account.ts'
import { harnessFetch } from '../src/harness-fetch.ts'
import { memoryAuth } from './auth-double.ts'
import { textEvents } from './mock-server.ts'

const provider = 'yunshu-local', model = 'versioned-model', scope = 'model-config-account-a'
const baseURL = 'http://127.0.0.1:33117/harness/v1'
const first = brandString<Branded<'ModelConfigVersion'>>('a'.repeat(64))
const second = brandString<Branded<'ModelConfigVersion'>>('b'.repeat(64))
const rawGoFixture = readFileSync(new URL('./fixtures/model-config-go-http.json', import.meta.url))
const parsedGoFixture: unknown = JSON.parse(rawGoFixture.toString('utf8'))
if (!Array.isArray(parsedGoFixture)) throw new Error('Expected captured Go HTTP cases')
const goCases: readonly unknown[] = parsedGoFixture
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected fixture object')
  return value as Record<string, unknown>
}
function goCase(name: string): { body: Record<string, unknown>; status: number; headers: Headers } {
  const row = goCases.map(record).find(value => value.name === name)
  if (row === undefined || typeof row.status !== 'number') throw new Error('Expected captured Go case')
  const headers = new Headers()
  for (const [key, value] of Object.entries(record(row.headers))) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Expected captured header values')
    for (const item of value) headers.append(key, String(item))
  }
  return { body: record(row.body), status: row.status, headers }
}
const profile = (version = first, contextWindow = 32768, maxTokens = 8192): PiAiProviderProfile => ({
  api: 'openai-completions', baseURL, managedLimitsScope: scope, compat: { maxTokensField: 'max_tokens' },
  models: [{ id: model, managedLimits: { scope, authoritative: true, modelConfigVersion: version, contextWindow, maxTokens } }],
})
const expected = (version = first, contextWindow = 32768, maxTokens = 8192): HarnessModelConfigRequest =>
  ({ baseURL, model, scope, modelConfigVersion: version, contextWindow, maxTokens })
const response = (echo: string | null = first): Response => new Response(textEvents.map(value => `data: ${value}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'model-config-request-1',
    ...echo === null ? {} : { 'X-Yunshu-Model-Config-Version': echo } },
})
async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of chunks) result.push(chunk)
  return result
}
function adapter(configured = profile(), authorizeModelConfig?: PiAi.PiAiAdapterOptions['authorizeModelConfig']) {
  let profiles = resolveProfiles({ [provider]: configured })
  return { adapter: new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'sk-local-fixture',
    ...authorizeModelConfig === undefined ? {} : { authorizeModelConfig }, auth: memoryAuth() }),
  update(value: PiAiProviderProfile) { profiles = resolveProfiles({ [provider]: value }) } }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('prepared published model versions', () => {
  it('includes the independent default in prepared authorization and blocks a stale default before provider I/O', async () => {
    const configured = profile()
    configured.models![0]!.managedLimits!.defaultMaxTokens = 2048
    const authorize = vi.fn<NonNullable<PiAi.PiAiAdapterOptions['authorizeModelConfig']>>(async (_provider, request) => request.defaultMaxTokens === 4096)
    const transport = vi.fn<typeof fetch>(async () => response())
    vi.stubGlobal('fetch', transport)
    const f = adapter(configured, authorize)
    const prepared = await f.adapter.prepareCall(provider, model)
    const chunks = await drain(prepared.stream({ provider, model, messages: [] }))
    expect(authorize).toHaveBeenCalledExactlyOnceWith(provider, { ...expected(), defaultMaxTokens: 2048 })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_CONFIG_CHANGED' } } })
    expect(transport).not.toHaveBeenCalled()
  })

  it('parses a branded version with a complete capacity pair and rejects incomplete modern pairs', () => {
    const configured = profile()
    const parsed = Config({ providers: { [provider]: configured } }).providers.get()
    expect(parsed[provider]?.models?.[0]?.managedLimits?.modelConfigVersion).toBe(first)
    for (const managedLimits of [{ scope, modelConfigVersion: first, contextWindow: 32768 },
      { scope, modelConfigVersion: first, maxTokens: 8192 }, { scope, modelConfigVersion: first, contextWindow: 8192, maxTokens: 32768 }]) {
      expect(() => resolveProfiles({ [provider]: { ...configured, models: [{ id: model, managedLimits }] } }))
        .toThrow(/invalid versioned managed capacity pair/u)
    }
  })

  it('freezes the version with its original capacities across a later configuration change', async () => {
    const calls: { headers: Headers; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init)
      const body = await request.json() as Record<string, unknown>
      calls.push({ headers: request.headers, body })
      return response(request.headers.get('X-Yunshu-Model-Config-Version'))
    }))
    const authorize = vi.fn<NonNullable<PiAi.PiAiAdapterOptions['authorizeModelConfig']>>(async () => true)
    const f = adapter(profile(), authorize), prepared = await f.adapter.prepareCall(provider, model)
    f.update(profile(second, 16384, 4096))
    await drain(prepared.stream({ provider, model, messages: [] }))
    await drain(f.adapter.stream({ provider, model, messages: [] }))
    expect(calls.map(call => [call.body.max_tokens, call.headers.get('X-Yunshu-Model-Config-Version')]))
      .toEqual([[8192, first], [4096, second]])
    expect(authorize.mock.calls.map(call => call[1])).toEqual([expected(), expected(second, 16384, 4096)])
    expect(calls.every(call => !JSON.stringify(call.body).includes('modelConfigVersion'))).toBe(true)
  })

  it('authorizes original capacities while a smaller user budget controls the wire output', async () => {
    const authorize = vi.fn<NonNullable<PiAi.PiAiAdapterOptions['authorizeModelConfig']>>(async () => true)
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      expect(await new Request(input, init).json()).toMatchObject({ model, max_tokens: 1024 })
      return response()
    })
    vi.stubGlobal('fetch', transport)
    const chunks = await drain(adapter(profile(), authorize).adapter.stream({ provider, model, messages: [], maxTokens: 1024 }))
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(authorize).toHaveBeenCalledExactlyOnceWith(provider, expected())
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each(['missing', 'rejected'] as const)('does not send a versioned request when account approval is %s', async (kind) => {
    const transport = vi.fn<typeof fetch>(async () => { throw new Error('No request allowed') })
    vi.stubGlobal('fetch', transport)
    const f = adapter(profile(), kind === 'missing' ? undefined : async () => false)
    const chunks = await drain(f.adapter.stream({ provider, model, messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_CONFIG_CHANGED' } } })
    expect(transport).not.toHaveBeenCalled()
    expect(f.adapter.providerRetryPolicy(provider)).toMatchObject({ maxRetries: 0 })
  })

  it('does not let a prepared modern call authorize another model identity', async () => {
    const f = adapter(profile(), async () => true)
    const prepared = await f.adapter.prepareCall(provider, model)
    expect(() => prepared.stream({ provider, model: 'another-model', messages: [] })).toThrow(
      expect.objectContaining({ code: 'MODEL_CONFIG_CHANGED' }))
  })

  it.each([null, second])('keeps a successful response with echo %s unconfirmed without retry authority', async (echo) => {
    const transport = vi.fn<typeof fetch>(async () => response(echo))
    vi.stubGlobal('fetch', transport)
    const chunks = await drain(adapter(profile(), async () => true).adapter.stream({ provider, model, messages: [] }))
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_CONFIG_CONFIRMATION_UNAVAILABLE' } } })
    expect(finish).not.toHaveProperty('reason.failure.textReselection')
    expect(transport).toHaveBeenCalledOnce()
  })
})

describe('Host-owned version authority and transport confinement', () => {
  it('re-registers the effective zero-retry policy when Loader upgrades an existing route to versioned models', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const retryPolicy = { mode: 'always' as const, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }
    const legacy: PiAiProviderProfile = { ...profile(), retryPolicy,
      models: [{ id: model, managedLimits: { scope, authoritative: true, contextWindow: 32768, maxTokens: 8192 } }] }
    ctx.provide('harnessAccount', { provider, refreshModels: async () => [model],
      resolveRelayKey: async () => 'sk-local-fixture',
      authorizeModelConfig: async request => request.baseURL === baseURL && request.modelConfigVersion === first })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRetry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const configured = await liveConfig(ctx, PiAi, { providers: { [provider]: legacy } })
    expect(ctx.llm.providerRetryPolicy(provider)).toMatchObject({ mode: 'always' })
    // Only model rows change, just as a previously legacy backend publishes its first versioned catalog.
    await configured.update({ providers: { [provider]: { models: profile().models } } })
    const updatedPolicy = ctx.llm.providerRetryPolicy(provider)
    expect((await ctx.llm.prepareCall({ provider, model })).config.maxTokens).toBe(8192)
    const failures: string[] = [], events: string[] = []
    ctx.on('agent/request-error', (payload, next) => { failures.push(payload.failure.code); return next() })
    ctx.on('session/event', (_session, event) => { events.push(event.type) })
    let posts = 0
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init)
      expect(request.method).toBe('POST')
      expect(request.headers.get('X-Yunshu-Model-Config-Version')).toBe(first)
      posts++
      // A second request would succeed, exposing a hidden always retry without hanging the test.
      return response(posts === 1 ? null : first)
    })
    vi.stubGlobal('fetch', transport)
    const agent = await ctx.agentLoop.create(SessionId('model-config-upgraded-route'), { provider, model })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(posts).toBe(1)
    expect(updatedPolicy).toMatchObject({ mode: 'normal', maxRetries: 0, retryableCodes: [] })
    expect(failures).toEqual(['MODEL_CONFIG_CONFIRMATION_UNAVAILABLE'])
    expect(events).not.toContain('llm/retry')
    expect(events).not.toContain('llm/retry-started')
  })

  it('rechecks live owner approval after key resolution and ignores a forged provider setting', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    let current = true
    const owner: HarnessAccount = { provider, refreshModels: async () => [model],
      resolveRelayKey: async () => { current = false; return 'sk-local-fixture' },
      authorizeModelConfig: async request => current && request.modelConfigVersion === first }
    ctx.provide('harnessAccount', owner)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(PiAi, { providers: { [provider]: profile() } })
    const transport = vi.fn<typeof fetch>(async () => { throw new Error('Changed account must not send') })
    vi.stubGlobal('fetch', transport)
    const chunks = await drain(ctx.llm.stream({ provider, model, messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'MODEL_CONFIG_CHANGED' } } })
    expect(transport).not.toHaveBeenCalled()
  })

  it('strips a user-supplied version header from an ordinary unversioned custom provider', async () => {
    const configured: PiAiProviderProfile = { api: 'openai-completions', baseURL: 'https://ordinary-provider.invalid/v1',
      models: [{ id: model }], headers: { 'x-yunshu-model-config-version': first } }
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Request(input, init).headers.has('X-Yunshu-Model-Config-Version')).toBe(false)
      return response()
    })
    vi.stubGlobal('fetch', transport)
    await drain(adapter(configured).adapter.stream({ provider, model, messages: [] }))
    expect(transport).toHaveBeenCalledOnce()
  })

  it('grants no transport to a custom loopback URL without Host authorization', () => {
    expect(harnessFetch(baseURL)).toBeUndefined()
  })

  it.each(['http://127.0.0.1:33117/v1/chat/completions', 'http://127.0.0.1:33118/harness/v1/chat/completions',
    'http://127.0.0.1:33117/harness/v1/%252e%252e/chat/completions'])(
    'refuses a trusted model request escaping its exact root: %s', async (url) => {
      const transport = vi.fn<typeof fetch>(async () => response())
      vi.stubGlobal('fetch', transport)
      const send = harnessFetch(baseURL, undefined, undefined, expected(), async () => true)
      if (send === undefined) throw new Error('Expected trusted local transport')
      await expect(send(url, { method: 'POST', body: JSON.stringify({ model }) }))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(transport).not.toHaveBeenCalled()
    },
  )

  it('does not turn a configuration conflict into a model-unavailable reselection proof', async () => {
    const requestId = 'fixture-config-conflict'
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ error: { type: 'new_api_error', code: 'model_config_changed' },
      text_reselection: { schema_version: 1, model, request_id: requestId, submission_state: 'not_submitted',
        upstream_submitted: false, billing_reserved: false, reason: 'model_unavailable' } },
    { status: 400, headers: { 'X-Oneapi-Request-Id': requestId } })))
    const observed: unknown[] = []
    const send = harnessFetch(baseURL, (_response, proof) => { observed.push(proof) },
      { model, managedScope: scope }, expected(), async () => true)
    if (send === undefined) throw new Error('Expected trusted local transport')
    await send(baseURL + '/chat/completions', { method: 'POST', body: JSON.stringify({ model }) })
    expect(observed).toEqual([undefined])
  })
})

describe('captured Go text configuration rejection', () => {
  it('keeps the exact original wire fixture bytes', () => {
    expect(createHash('sha256').update(rawGoFixture).digest('hex'))
      .toBe('f96a25202200efb2e268a51d89c3ce0ce1742abbd1ac518fc28307d662f16c5a')
  })

  it('maps the native four-field error and reserved HTTP proof to one stable terminal without reselection', async () => {
    const captured = goCase('stale-text')
    const transport = vi.fn<typeof fetch>(async () => Response.json(captured.body, captured))
    vi.stubGlobal('fetch', transport)
    const chunks = await drain(adapter(profile(), async () => true).adapter.stream({ provider, model, messages: [] }))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_CONFIG_CHANGED',
      status: 400, requestId: captured.headers.get('X-Oneapi-Request-Id') } } })
    expect(chunks[0]).not.toHaveProperty('reason.failure.textReselection')
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each(['request-id-missing', 'result-missing', 'result-unconfirmed', 'wrong-type', 'wrong-param', 'missing-message',
    'additional-error-field', 'additional-body-field', 'non-json-response'] as const)(
    'does not claim a pre-billing rejection when the captured proof is changed: %s', async (mutation) => {
      const captured = goCase('stale-text'), body = structuredClone(captured.body), error = record(body.error)
      if (mutation === 'request-id-missing') captured.headers.delete('X-Oneapi-Request-Id')
      if (mutation === 'result-missing') captured.headers.delete('X-Yunshu-Model-Config-Result')
      if (mutation === 'result-unconfirmed') captured.headers.set('X-Yunshu-Model-Config-Result', 'unknown')
      if (mutation === 'wrong-type') error.type = 'upstream_error'
      if (mutation === 'wrong-param') error.param = 'unverified'
      if (mutation === 'missing-message') delete error.message
      if (mutation === 'additional-error-field') error.upstream_submitted = false
      if (mutation === 'additional-body-field') body.model = model
      if (mutation === 'non-json-response') captured.headers.set('content-type', 'text/plain')
      const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), captured))
      vi.stubGlobal('fetch', transport)
      const observed: unknown[] = []
      const send = harnessFetch(baseURL, (_response, proof) => { observed.push(proof) },
        { model, managedScope: scope }, expected(), async () => true)
      if (send === undefined) throw new Error('Expected trusted local transport')
      expect((await send(baseURL + '/chat/completions', { method: 'POST', body: JSON.stringify({ model }) })).status).toBe(400)
      expect(observed).toEqual([undefined])
      expect(transport).toHaveBeenCalledOnce()
    },
  )

  it.each([403, 408, 429, 500])('does not infer a version rejection from HTTP %s', async (status) => {
    const captured = goCase('stale-text')
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(captured.body, { ...captured, status })))
    const send = harnessFetch(baseURL, undefined, undefined, expected(), async () => true)
    if (send === undefined) throw new Error('Expected trusted local transport')
    expect((await send(baseURL + '/chat/completions', { method: 'POST', body: JSON.stringify({ model }) })).status).toBe(status)
  })
})
