import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Credits from '../src/index.ts'
import { productModelLimitsScope } from '../src/model-limits.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

const reference = credentialRef('MODEL_LIMITS_SYNTHETIC_RELAY')
const first = 'fixture-capacity-one'
const second = 'fixture-capacity-two'
let context: Context | undefined
let upstream: Server | undefined
let directory: string | undefined
let loginAccount = 7
let catalog: Record<string, unknown>[] = []
let modelStatus = 200
let signInCount = 0
const requests: { method: string; path: string; body?: Record<string, unknown> }[] = []

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
async function post(base: string, path: string, body: object) {
  return object(await (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json())
}
async function signIn(base: string) {
  signInCount++
  const challenge = await post(base, '/api/session/challenge', { phone: '+8613800000000', idempotencyKey: `challenge-${signInCount}` })
  expect(challenge.ok).toBe(true)
  expect((await post(base, '/api/session/verify', {
    challengeId: object(challenge.payload).challenge_id, code: '123456', idempotencyKey: `login-${signInCount}`,
  })).ok).toBe(true)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (upstream !== undefined) await new Promise<void>((resolve, reject) => {
    upstream!.close((error) => { if (error === undefined) resolve(); else reject(error) })
    upstream!.closeAllConnections()
  })
  upstream = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  loginAccount = 7
  catalog = []
  modelStatus = 200
  signInCount = 0
  requests.length = 0
})

async function boot(models: readonly Record<string, unknown>[] = [{ id: first }, { id: second }], withAgent = false) {
  directory = await mkdtemp(join(tmpdir(), 'dsh-model-limits-'))
  const root = directory
  upstream = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        if (path === '/harness/v1/chat/completions' && Buffer.isBuffer(chunk)) chunks.push(chunk)
      }
      const body = path === '/harness/v1/chat/completions'
        ? object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : undefined
      requests.push({ method: request.method ?? 'GET', path, ...body === undefined ? {} : { body } })
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown) => response.end(JSON.stringify({ success: true, data }))
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: `fixture-challenge-${signInCount}`, delivery_status: 'accepted',
          expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 0, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=synthetic; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: `fixture-access-${loginAccount}`, access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: `sk-fixture-relay-${loginAccount}`, relay_key_id: loginAccount,
          session: { sid: `fixture-session-${loginAccount}`, current: true },
          user: { id: loginAccount, username: 'fixture', quota: 1000000 } }); return
      }
      if (path === '/harness/api/user/self') {
        const id = Number(request.headers.authorization?.replace(/^Bearer fixture-(?:access|renewed)-/u, ''))
        answer({ id, username: 'fixture', group: 'default', quota: 1000000 }); return
      }
      if (path === '/harness/api/user/auth/refresh') {
        response.setHeader('set-cookie', 'new_api_refresh=synthetic-rotated; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: `fixture-renewed-${loginAccount}`, access_expires_at: Math.floor(Date.now() / 1000) + 900,
          user: { id: loginAccount } }); return
      }
      if (path === '/harness/api/user/auth/logout') { answer({}); return }
      if (path === '/harness/api/pricing') { answer(catalog.map(row => ({ model_name: row.id, kind: 'chat' }))); return }
      if (path === '/harness/api/client-activity/heartbeat') {
        answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 30, online_timeout_seconds: 90 }); return
      }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe(`Bearer sk-fixture-relay-${loginAccount}`)
        response.writeHead(modelStatus)
        response.end(JSON.stringify({ data: catalog.map(row => ({ supported_endpoint_types: ['openai'], ...row })) })); return
      }
      if (path === '/harness/v1/chat/completions') {
        expect(request.headers.authorization).toBe(`Bearer sk-fixture-relay-${loginAccount}`)
        response.setHeader('content-type', 'text/event-stream')
        const common = { id: 'chatcmpl-synthetic-limits', object: 'chat.completion.chunk', created: 1, model: body?.model }
        response.end([
          { ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic response.' }, finish_reason: null }] },
          { ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 16, completion_tokens: 2, total_tokens: 18 } },
        ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
        return
      }
      response.writeHead(404); response.end('{}')
    })().catch(() => response.destroy())
  })
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('Expected listener')
  const api = `http://127.0.0.1:${address.port}/harness`
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi], ['@deepseek-ai/dsh-credits-index', Credits],
    ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-projection', SessionProjections],
    ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  const mount = async () => {
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = { version: 'v2', loadCache: new Map(),
      async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      },
    } as NonNullable<typeof context.loader.internal>
    const configuration = join(root, 'cordis.yml')
    await writeFile(configuration, JSON.stringify([
      { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
      { name: '@deepseek-ai/dsh-tools' }, { name: '@deepseek-ai/dsh-system-prompt' },
      { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(root, 'credentials.yaml'), dshHome: root, watch: false } },
      { name: '@deepseek-ai/dsh-llm' },
      ...withAgent ? [{ name: '@deepseek-ai/dsh-session' }, { name: '@deepseek-ai/dsh-session-projection' },
        { name: '@deepseek-ai/dsh-agent' }, { name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } }] : [],
      { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'yunshu-local': {
        api: 'openai-completions', baseURL: api + '/v1', apiKeyEnv: reference, models,
      } } } },
      { name: '@deepseek-ai/dsh-credits-index', config: { stateDir: join(root, 'credits'), newApiBaseUrl: api,
        relayTokenEnv: reference, accountReadMinIntervalMs: 0, accountReadFailureCooldownMs: 1 } },
    ]))
    await profileComposition(context, root, configuration)
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    const base = `http://127.0.0.1:${context.webServer.port}/credits`
    return base
  }
  return { base: await mount(), api, refresh: () => context!.harnessAccount.refreshModels(api + '/v1'),
    restart: async () => { await context!.fiber.dispose(); return await mount() },
  }
}

function configuredRoute() {
  const value = context!.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')?.value
  return object(object(object(value).providers)['yunshu-local'])
}
async function capacity(id: string) {
  const model = await context!.llm.resolveModelInfo('yunshu-local', id)
  return { contextWindow: model.context?.contextWindow, maxOutputTokens: model.maxOutputTokens, defaultMaxTokens: model.defaultMaxTokens }
}

describe('gateway display names through real Host model synchronization', () => {
  it('shows gateway display names for new and ID-only entries while preserving manual names and request IDs', async () => {
    const fresh = 'ys-fixture-new'
    catalog = [{ id: first, display_name: 'qq-Fixture One' },
      { id: second, display_name: 'qq-Fixture Two' }, { id: fresh, display_name: 'qq-Fixture New' }]
    const { base, refresh } = await boot([{ id: first, name: first }, { id: second, name: 'My own label' }])
    await signIn(base)
    await refresh()
    expect(configuredRoute().models).toMatchObject([
      { id: first, gatewayDisplayName: 'qq-Fixture One' },
      { id: second, name: 'My own label', gatewayDisplayName: 'qq-Fixture Two' },
      { id: fresh, gatewayDisplayName: 'qq-Fixture New' },
    ])
    const models = await context!.llm.listModels('yunshu-local')
    expect(models.map(model => ({ id: model.id, name: model.name }))).toEqual([
      { id: first, name: 'qq-Fixture One' }, { id: second, name: 'My own label' }, { id: fresh, name: 'qq-Fixture New' },
    ])
    catalog = [{ id: first, display_name: 'Gateway One' }, { id: second, display_name: 'Gateway Two' },
      { id: fresh, display_name: 'Gateway New' }]
    await refresh()
    expect((await context!.llm.listModels('yunshu-local')).map(model => ({ id: model.id, name: model.name }))).toEqual([
      { id: first, name: 'Gateway One' }, { id: second, name: 'My own label' }, { id: fresh, name: 'Gateway New' },
    ])
    expect(requests.filter(request => request.path === '/harness/v1/chat/completions')).toHaveLength(0)
    const prepared = await context!.llm.prepareCall({ provider: 'yunshu-local', model: fresh })
    for await (const _chunk of prepared.stream({ ...prepared.config, messages: [] })) { /* Drain the local fixture response. */ }
    expect(requests.filter(request => request.path === '/harness/v1/chat/completions').map(request => request.body?.model)).toEqual([fresh])
  })

  it('keeps synchronized names across restart and does not rewrite or notify on unchanged listings', async () => {
    catalog = [{ id: first, display_name: 'qq-Fixture One' }]
    const { base, refresh, restart } = await boot([{ id: first, name: 'qq-Fixture One' }])
    await signIn(base)
    await refresh()
    const revision = () => context!.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')!.revision
    const changed = vi.fn()
    context!.on('api-session/model-catalog-changed', changed)
    catalog = [{ id: first, display_name: 'Gateway One' }]
    await refresh()
    expect(changed).toHaveBeenCalledTimes(1)
    const before = revision()
    await refresh()
    expect(revision()).toBe(before)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(requests.filter(request => request.path === '/harness/v1/chat/completions')).toHaveLength(0)
    await restart()
    expect((await context!.llm.resolveModelInfo('yunshu-local', first)).name).toBe('Gateway One')
    catalog = [{ id: first, display_name: 'Renamed after restart' }]
    await refresh()
    expect((await context!.llm.resolveModelInfo('yunshu-local', first)).name).toBe('Renamed after restart')
  })

  it.each([
    ['qq-deepseek-v4.1-flash-1017', 'yunshu-flash'],
    ['My own label', 'My own label'],
  ])('refreshes the published Yunshu Flash label from %s to %s', async (savedName, expectedName) => {
    const id = 'ys-deepseek-v4.1-flash-1017'
    catalog = [{ id, display_name: 'yunshu-flash' }]
    const { base, refresh } = await boot([{ id, name: savedName }])
    await signIn(base)
    await refresh()
    const models = await context!.llm.listModels('yunshu-local')
    expect(models.map(model => ({ id: model.id, name: model.name }))).toEqual([{ id, name: expectedName }])
    expect(requests.filter(request => request.path === '/harness/v1/chat/completions')).toHaveLength(0)
  })

  it('ignores absent, blank and malformed remote labels without replacing existing names', async () => {
    catalog = [{ id: first, display_name: 'qq-Fixture One' }, { id: second, display_name: '  ' }]
    const { base, refresh } = await boot([{ id: first }, { id: second }])
    await signIn(base)
    await refresh()
    for (const display_name of [undefined, '', '  ', null, 42, { name: 'invalid' }]) {
      catalog = [{ id: first, display_name }, { id: second, display_name }]
      await refresh()
      expect((await context!.llm.resolveModelInfo('yunshu-local', first)).name).toBe('qq-Fixture One')
      expect((await context!.llm.resolveModelInfo('yunshu-local', second)).name).toBe(second)
    }
  })
})

describe('product model capacities through the real Host Loader and HTTP listing', () => {
  it('keeps an expected model scope valid through same-account access-token renewal', async () => {
    catalog = [{ id: first, context_window: 32768, max_output_tokens: 8192 }]
    const { base, api, refresh } = await boot()
    await signIn(base)
    await refresh()
    const scope = productModelLimitsScope(api, '7')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 860_000)
    try {
      expect(await context!.harnessAccount.resolveRelayKey(api + '/v1', scope)).toBe('sk-fixture-relay-7')
    } finally { clock.mockRestore() }
    expect(requests.filter(request => request.path === '/harness/api/user/auth/refresh')).toHaveLength(1)
    expect(configuredRoute().managedLimitsScope).toBe(scope)
    expect(await capacity(first)).toEqual({ contextWindow: 32768, maxOutputTokens: 8192, defaultMaxTokens: 8192 })
    expect(requests.filter(request => request.path === '/harness/v1/chat/completions')).toHaveLength(0)
  })

  it('rejects an old account prepared call before it can use a replacement account relay key', async () => {
    catalog = [{ id: first, context_window: 1_048_576, max_output_tokens: 384_000 }]
    const { base, api, refresh } = await boot()
    await signIn(base)
    await refresh()
    const firstScope = productModelLimitsScope(api, '7')
    const prepared = await context!.llm.prepareCall({ provider: 'yunshu-local', model: first })
    expect(prepared.config.maxTokens).toBe(384_000)
    expect(await context!.harnessAccount.resolveRelayKey(api + '/v1', firstScope)).toBe('sk-fixture-relay-7')
    expect((await post(base, '/api/session/logout', {})).ok).toBe(true)
    loginAccount = 8
    catalog = [{ id: first, context_window: 32768, max_output_tokens: 8192 }]
    await signIn(base)
    await refresh()
    const replacementScope = productModelLimitsScope(api, '8')
    expect(await context!.harnessAccount.resolveRelayKey(api + '/v1', firstScope)).toBeUndefined()
    expect(await context!.harnessAccount.resolveRelayKey(api + '/v1', replacementScope)).toBe('sk-fixture-relay-8')
    const rejected: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) rejected.push(chunk)
    expect(rejected.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
    expect(requests.filter(request => request.path === '/harness/v1/chat/completions')).toHaveLength(0)
    const fresh = await context!.llm.prepareCall({ provider: 'yunshu-local', model: first })
    expect(fresh.config.maxTokens).toBe(8192)
    const completed: StreamChunk[] = []
    for await (const chunk of fresh.stream({ ...fresh.config, messages: [] })) completed.push(chunk)
    expect(completed.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(requests.filter(request => request.path === '/harness/v1/chat/completions').map(request => request.body?.max_tokens))
      .toEqual([8192])
  })

  it('records refreshed default and explicit output caps in real Agent headers and SDK HTTP requests', async () => {
    catalog = [{ id: first, context_window: 1_048_576, max_output_tokens: 384_000 }]
    const { base, refresh } = await boot(undefined, true)
    await signIn(base)
    await refresh()
    const agent = await context!.agentLoop.create(SessionId('managed-capacity-default'), { provider: 'yunshu-local', model: first })
    const send = async (text: string) => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
    }
    await send('Reply briefly with a synthetic acknowledgement.')
    catalog = [{ id: first, context_window: 32768, max_output_tokens: 8192 }]
    await refresh()
    await send('Reply briefly again after the model capacity refresh.')
    const headers = agent.session.snapshotEvents().flatMap(event => event.type === 'request/header' ? [event.data.header] : [])
    expect(headers.map(header => ({ maxTokens: header.config.maxTokens, adapterDefaults: header.adapterDefaults }))).toEqual([
      { maxTokens: 384_000, adapterDefaults: { maxTokens: true } },
      { maxTokens: 8192, adapterDefaults: { maxTokens: true } },
    ])
    const explicit = await context!.agentLoop.create(SessionId('managed-capacity-explicit'), {
      provider: 'yunshu-local', model: first, maxTokens: 384_000,
    })
    explicit.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Reply briefly with the explicit budget capped.' }] }))
    await explicit.whenIdle()
    const explicitHeaders = explicit.session.snapshotEvents().flatMap(event => event.type === 'request/header' ? [event.data.header] : [])
    expect(explicitHeaders.map(header => ({ maxTokens: header.config.maxTokens, adapterDefaults: header.adapterDefaults })))
      .toEqual([{ maxTokens: 8192, adapterDefaults: undefined }])
    const wire = requests.filter(request => request.path === '/harness/v1/chat/completions').map(request => ({
      model: request.body?.model, max_tokens: request.body?.max_tokens, stream: request.body?.stream,
    }))
    expect(wire).toEqual([
      { model: first, max_tokens: 384_000, stream: true },
      { model: first, max_tokens: 8192, stream: true },
      { model: first, max_tokens: 8192, stream: true },
    ])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(2)
    expect(explicit.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
  })

  it('applies distinct exact model capacities without overwriting a smaller manual setting', async () => {
    catalog = [{ id: first, context_window: 1_048_576, max_output_tokens: 384_000 },
      { id: second, context_window: 32768, max_output_tokens: 8192 }]
    const { base, api, refresh } = await boot([{ id: first, contextWindow: 65536, maxTokens: 2048 }, { id: second }])
    await signIn(base)
    await refresh()
    expect(await capacity(first)).toEqual({ contextWindow: 65536, maxOutputTokens: 2048, defaultMaxTokens: 2048 })
    expect(await capacity(second)).toEqual({ contextWindow: 32768, maxOutputTokens: 8192, defaultMaxTokens: 8192 })
    const route = configuredRoute()
    expect(route.managedLimitsScope).toBe(productModelLimitsScope(api, '7'))
    expect(route.models).toMatchObject([
      { id: first, contextWindow: 65536, maxTokens: 2048,
        managedLimits: { scope: route.managedLimitsScope, contextWindow: 1_048_576, maxTokens: 384_000 } },
      { id: second, managedLimits: { scope: route.managedLimitsScope, contextWindow: 32768, maxTokens: 8192 } },
    ])
    expect(requests.some(request => request.path.includes('chat/completions'))).toBe(false)
  })

  it('refreshes increases and decreases without retaining an automatic value as a manual cap', async () => {
    catalog = [{ id: first, context_window: 32768, max_output_tokens: 8192 }]
    const { base, refresh } = await boot()
    await signIn(base)
    await refresh()
    expect(await capacity(first)).toMatchObject({ contextWindow: 32768, maxOutputTokens: 8192, defaultMaxTokens: 8192 })
    const changes = vi.fn()
    context!.on('api-session/model-catalog-changed', changes)
    catalog = [{ id: first, context_window: 1_048_576, max_output_tokens: 384_000 }]
    await refresh()
    expect(await capacity(first)).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 384_000, defaultMaxTokens: 384_000 })
    expect(changes).toHaveBeenCalledTimes(1)
    catalog = [{ id: first, context_window: 16384, max_output_tokens: 2048 }]
    await refresh()
    expect(await capacity(first)).toMatchObject({ contextWindow: 16384, maxOutputTokens: 2048, defaultMaxTokens: 2048 })
    expect(changes).toHaveBeenCalledTimes(2)
    await refresh()
    expect(changes).toHaveBeenCalledTimes(2)
    const models = configuredRoute().models
    if (!Array.isArray(models)) throw new Error('Expected configured models')
    expect(object(models[0])).not.toHaveProperty('maxTokens')
  })

  it('retains same-owner valid fields when the endpoint omits, invalidates or fails its metadata', async () => {
    catalog = [{ id: first, context_window: 32768, max_output_tokens: 8192 }]
    const { base, refresh } = await boot()
    await signIn(base)
    await refresh()
    for (const entry of [{ id: first }, { id: first, context_window: 0, max_output_tokens: '4096' },
      { id: first, context_window: 8192, max_output_tokens: 16384 }]) {
      catalog = [entry]
      await refresh()
      expect(await capacity(first)).toMatchObject({ contextWindow: 32768, maxOutputTokens: 8192, defaultMaxTokens: 8192 })
    }
    modelStatus = 503
    await expect(refresh()).rejects.toThrow()
    expect(await capacity(first)).toMatchObject({ contextWindow: 32768, maxOutputTokens: 8192, defaultMaxTokens: 8192 })
  })

  it('retains persisted same-owner capacities after a real Host restart with discovery unavailable', async () => {
    catalog = [{ id: first, context_window: 65536, max_output_tokens: 16384 }]
    const { base, refresh, restart } = await boot()
    await signIn(base)
    await refresh()
    modelStatus = 503
    await restart()
    await expect(refresh()).rejects.toThrow()
    expect(await capacity(first)).toMatchObject({ contextWindow: 65536, maxOutputTokens: 16384, defaultMaxTokens: 16384 })
  })

  it('does not apply retained capacities to another signed-in account', async () => {
    catalog = [{ id: first, context_window: 65536, max_output_tokens: 16384 }]
    const { base, refresh } = await boot()
    await signIn(base)
    await refresh()
    const previousScope = configuredRoute().managedLimitsScope
    expect((await post(base, '/api/session/logout', {})).ok).toBe(true)
    loginAccount = 8
    catalog = [{ id: first }]
    await signIn(base)
    await refresh()
    expect(configuredRoute().managedLimitsScope).not.toBe(previousScope)
    expect(await capacity(first)).toMatchObject({ contextWindow: 262144, maxOutputTokens: undefined, defaultMaxTokens: undefined })
    catalog = [{ id: first, context_window: 16384, max_output_tokens: 2048 }]
    await refresh()
    expect(await capacity(first)).toMatchObject({ contextWindow: 16384, maxOutputTokens: 2048, defaultMaxTokens: 2048 })
  })

  it('masks retained metadata from another backend while preserving explicit manual limits', async () => {
    catalog = [{ id: first }]
    const { base, refresh } = await boot([{ id: first, contextWindow: 65536, maxTokens: 4096,
      managedLimits: { scope: productModelLimitsScope('https://another.example/harness', '7'), contextWindow: 8192, maxTokens: 1024 } }])
    await signIn(base)
    await refresh()
    expect(await capacity(first)).toEqual({ contextWindow: 65536, maxOutputTokens: undefined, defaultMaxTokens: 4096 })
  })
})


describe('gateway text declarations through real Host model synchronization', () => {
  const declaration = { tools: false, vision: false, reasoning: false, stream: true, max_input_tokens: 32000 }
  it('syncs scoped capabilities, output-aware input room, explicit removal and account replacement', async () => {
    catalog = [{ id: first, context_window: 1000000, max_output_tokens: 8192,
      parameters: { 'x-text-capabilities': declaration } }, { id: second, context_window: 65536, max_output_tokens: 4096 }]
    const { base, refresh } = await boot([{ id: first, input: ['text', 'image'] }, { id: second }])
    await signIn(base)
    await refresh()
    const info = await context!.llm.resolveModelInfo('yunshu-local', first)
    expect(info).toMatchObject({ textCapabilities: { maxInputTokens: 32000, tools: false, vision: false },
      inputModalities: ['text'], context: { contextWindow: 40192 }, maxOutputTokens: 8192 })
    const small = await context!.llm.prepareCall({ provider: 'yunshu-local', model: first, maxTokens: 2048 })
    expect(small.context?.contextWindow).toBe(34048)
    expect((await context!.llm.resolveModelInfo('yunshu-local', second)).textCapabilities).toBeUndefined()
    expect((await context!.llm.listModels('yunshu-local')).find(model => model.id === first)?.textCapabilities?.tools).toBe(false)
    catalog = [{ id: first, context_window: 1000000, max_output_tokens: 8192 }]
    await refresh()
    expect((await context!.llm.resolveModelInfo('yunshu-local', first)).textCapabilities).toBeUndefined()
    expect((await context!.llm.resolveModelInfo('yunshu-local', first)).inputModalities).toEqual(['text', 'image'])
    catalog = [{ id: first, context_window: 1000000, max_output_tokens: 8192, parameters: { 'x-text-capabilities': declaration } }]
    await refresh()
    expect((await post(base, '/api/session/logout', {})).ok).toBe(true)
    loginAccount = 8
    catalog = [{ id: first }]
    await signIn(base)
    await refresh()
    expect((await context!.llm.resolveModelInfo('yunshu-local', first)).textCapabilities).toBeUndefined()
  })
  it('does not replace a valid capability declaration with a malformed successful response', async () => {
    catalog = [{ id: first, context_window: 1000000, max_output_tokens: 8192, parameters: { 'x-text-capabilities': declaration } }]
    const { base, refresh } = await boot()
    await signIn(base)
    await refresh()
    catalog = [{ id: first, parameters: { 'x-text-capabilities': { tools: true } } }]
    await expect(refresh()).rejects.toThrow()
    expect((await context!.llm.resolveModelInfo('yunshu-local', first)).textCapabilities?.tools).toBe(false)
  })
})


describe('unchanged execution metadata after real settings normalization', () => {
  const declaration = { tools: false, vision: false, reasoning: false, stream: true, max_input_tokens: 32000 }
  it('does not rewrite normalized capabilities or emit catalog/adapters changes on repeated reads', async () => {
    catalog = [{ id: first, context_window: 1000000, max_output_tokens: 8192,
      parameters: { 'x-text-capabilities': declaration } }, { id: second, context_window: 65536, max_output_tokens: 4096 }]
    const { base, refresh } = await boot()
    await signIn(base)
    await refresh()
    const descriptor = () => context!.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')!
    const initialRevision = descriptor().revision
    expect(typeof initialRevision).toBe('number')
    const settingsChanged = vi.fn()
    context!.on('settings/document-updated', (ns) => { if (ns === 'llm-pi-ai') settingsChanged() })
    const catalogChanged = vi.fn()
    context!.on('api-session/model-catalog-changed', catalogChanged)
    const adaptersChanged = vi.fn()
    context!.on('llm/adapters-updated', adaptersChanged)
    const before = requests.length
    for (let count = 0; count < 6; count++) await refresh()
    expect(descriptor().revision).toBe(initialRevision)
    expect(settingsChanged).not.toHaveBeenCalled()
    expect(catalogChanged).not.toHaveBeenCalled()
    expect(adaptersChanged).not.toHaveBeenCalled()
    expect(requests.slice(before).filter(row => row.path === '/harness/v1/models')).toHaveLength(6)
    expect(requests.slice(before).filter(row => row.path === '/harness/api/pricing')).toHaveLength(6)
    expect(requests.slice(before).filter(row => row.path === '/harness/api/status')).toHaveLength(6)
    catalog = [catalog[1]!, catalog[0]!]
    await refresh()
    expect(catalogChanged).toHaveBeenCalledTimes(1)
    const reorderedModels = configuredRoute().models
    expect(Array.isArray(reorderedModels) ? reorderedModels.map(entry => object(entry).id) : undefined).toEqual([second, first])
    const changedRevision = descriptor().revision
    const changedSettingsCount = settingsChanged.mock.calls.length
    const changedAdaptersCount = adaptersChanged.mock.calls.length
    await refresh()
    expect(descriptor().revision).toBe(changedRevision)
    expect(settingsChanged).toHaveBeenCalledTimes(changedSettingsCount)
    expect(adaptersChanged).toHaveBeenCalledTimes(changedAdaptersCount)
    expect(catalogChanged).toHaveBeenCalledTimes(1)
  })
  it('settles one real model change and the consumer refresh it triggers without a feedback loop', async () => {
    catalog = [{ id: first, context_window: 1000000, max_output_tokens: 8192,
      parameters: { 'x-text-capabilities': declaration } }]
    const { base, refresh } = await boot()
    await signIn(base)
    await refresh()
    let consumerRefreshes = 0
    let feedback = Promise.resolve()
    const changed = vi.fn()
    context!.on('api-session/model-catalog-changed', () => {
      changed()
      // Bound a broken feedback chain so the regression fails without hanging the process.
      if (consumerRefreshes < 4) {
        consumerRefreshes++
        feedback = feedback.then(async () => { await refresh() })
      }
    })
    catalog = [{ id: first, context_window: 1000000, max_output_tokens: 8192,
      parameters: { 'x-text-capabilities': { ...declaration, max_input_tokens: 24000 } } }]
    const before = requests.length
    await refresh()
    for (let count = 0; count < 6; count++) {
      const pending = feedback
      await pending
      if (pending === feedback) break
    }
    expect(changed).toHaveBeenCalledTimes(1)
    expect(consumerRefreshes).toBe(1)
    expect(requests.slice(before).filter(row => row.path === '/harness/v1/models')).toHaveLength(2)
    expect((await context!.llm.resolveModelInfo('yunshu-local', first)).textCapabilities?.maxInputTokens).toBe(24000)
  })
})


describe('version2 metadata survives real schema normalization without refresh loops', () => {
  it.each(['enum', 'boolean', 'empty', 'unverified', 'vision-outage-mapping', 'empty-mapping'])('retains exact optional fields for %s and emits no no-op events', async (kind) => {
    const declaration = { schema_version: 2, revision: 'loop-v2-' + kind, checked_at: '2026-10-31T00:00:00Z',
      tools: true, vision: kind !== 'vision-outage-mapping', reasoning: true, stream: true, max_input_tokens: 32000,
      verification: { tools: kind === 'unverified' ? 'unverified' : 'supported', vision: kind === 'vision-outage-mapping' ? 'unverified' : 'supported', reasoning: 'supported' },
      input_modalities: kind === 'vision-outage-mapping' ? ['text'] : ['text', 'image'],
      tools_config: { protocol: 'openai-chat', roundtrip_verified: true, verified_tool_choices: ['auto'], parallel_calls: 'unverified' },
      vision_config: { verified_transports: ['data_url'], verified_mime_types: ['image/png'], billing: 'input_tokens',
        ...kind === 'vision-outage-mapping' ? { operational_status: 'temporarily_unavailable', operational_reason: 'Temporary image outage.' } : {} },
      ...kind === 'empty-mapping' ? { reasoning_control_mapping: {} } : {},
      ...kind === 'vision-outage-mapping' ? { reasoning_control_mapping: { enable_thinking_with_effort: true, omit_effort_on_none: true } } : {},
      reasoning_mode: kind === 'empty' ? 'automatic' : 'configurable',
      reasoning_controls: { type: 'object', properties: kind === 'enum' ? { reasoning_effort: { type: 'string', enum: ['none', 'high'] } }
        : kind === 'empty' ? {} : { enable_thinking: { type: 'boolean' } }, additionalProperties: false },
      reasoning_omit_behavior: 'provider_default', operational_status: 'available' }
    catalog = [{ id: first, context_window: 1000000, max_output_tokens: 8192, parameters: { 'x-text-capabilities': declaration } }]
    const { base, refresh } = await boot()
    await signIn(base); await refresh()
    const initial = context!.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')!.revision
    const changed = vi.fn()
    context!.on('api-session/model-catalog-changed', changed)
    const before = structuredClone(configuredRoute())
    for (let count = 0; count < 4; count++) await refresh()
    expect(configuredRoute()).toEqual(before)
    expect(context!.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')!.revision).toBe(initial)
    expect(changed).not.toHaveBeenCalled()
  })
})
