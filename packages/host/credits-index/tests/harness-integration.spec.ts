import { mkdir, mkdtemp, rm, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
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
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import LlmRuntime, { createUserMessage, ToolCallId, type FinishReason } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Artifacts from '@deepseek-ai/dsh-artifacts-index'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Credits from '../src/index.ts'
import * as VideoProjectTools from '../src/video-project-tools.ts'
import type { VideoProjectOptions } from '../src/video-project-types.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

const relayRef = credentialRef('HARNESS_INTEGRATION_RELAY')
let context: Context | undefined
let upstream: Server | undefined
let directory: string | undefined
const calls: { path: string; authorization?: string; origin?: string; cookie?: string; body: unknown }[] = []
let quotaPerUnit = 500_000
let exchangeRate = 7.3
let statusAvailable = true
let balanceQuota = 68_493
let selfId = 7
let access = 'access-user'
let refreshes = 0
let creations = 0
let pricingRows: unknown[] = []
let videoTaskStatus: string | undefined
let imageResponse: unknown
let relayKey = 'sk-owned-relay'
let upstreamGate: ((path: string, response: ServerResponse) => Promise<void>) | undefined
let releaseUpstreamGate: (() => void) | undefined
const generatedVideo = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])
const initialRelayModels = () => [
  { id: 'deepseek-v4-flash', object: 'model', supported_endpoint_types: ['openai'] },
  { id: 'gpt-image-2', object: 'model', supported_endpoint_types: ['image-generation', 'openai'] },
  { id: 'MiniMax-H3', object: 'model', supported_endpoint_types: ['openai-video'] },
]
let relayModels = initialRelayModels()
let modelsStatus = 200
let modelsBarrier: Promise<void> | undefined
let modelReadStarted: (() => void) | undefined
let releaseModels: (() => void) | undefined
let releaseRefresh: (() => void) | undefined
let refreshBarrier: Promise<void> | undefined

afterEach(async () => {
  releaseUpstreamGate?.()
  releaseRefresh?.()
  releaseModels?.()
  await context?.fiber.dispose()
  context = undefined
  if (upstream !== undefined) await new Promise<void>((resolve, reject) => {
    upstream?.close((error) => { if (error === undefined) resolve(); else reject(error) })
    upstream?.closeAllConnections()
  })
  upstream = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  calls.length = 0
  quotaPerUnit = 500_000
  exchangeRate = 7.3
  statusAvailable = true
  balanceQuota = 68_493
  selfId = 7
  access = 'access-user'
  refreshes = 0
  creations = 0
  pricingRows = []
  videoTaskStatus = undefined
  imageResponse = undefined
  relayKey = 'sk-owned-relay'
  upstreamGate = undefined
  releaseUpstreamGate = undefined
  relayModels = initialRelayModels()
  modelsStatus = 200
  modelsBarrier = undefined
  modelReadStarted = undefined
  releaseModels = undefined
  releaseRefresh = undefined
  refreshBarrier = undefined
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object')
  return value as Record<string, unknown>
}

async function boot(
  models: readonly Record<string, unknown>[] = [{ id: 'deepseek-v4-flash' }],
  managedOutput = false,
  authenticatedHost = false,
): Promise<{ base: string; api: string; stateDir: string }> {
  directory = await mkdtemp(join(tmpdir(), 'harness-product-integration-'))
  const stateDir = join(directory, 'credits')
  await mkdir(stateDir)
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const body: unknown = chunks.length === 0 ? null : request.headers['content-type']?.includes('multipart/form-data')
        ? { multipart: bytes.toString('base64') } : JSON.parse(bytes.toString('utf8'))
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      calls.push({ path: url.pathname + url.search, body,
        ...request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization },
        ...request.headers.origin === undefined ? {} : { origin: request.headers.origin },
        ...request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie },
      })
      await upstreamGate?.(url.pathname, response)
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown): void => { response.end(JSON.stringify({ success: true, data })) }
      if (url.pathname === '/harness/api/status') {
        if (!statusAvailable) { response.writeHead(503); response.end('{}'); return }
        answer({ quota_per_unit: quotaPerUnit, usd_exchange_rate: exchangeRate }); return
      }
      if (url.pathname === '/harness/api/user/phone/challenge') {
        answer({ resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (url.pathname === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=refresh-one; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: access, access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: relayKey, relay_key_id: 9, session: { sid: 'session-one', current: true },
          user: { id: selfId, username: 'test-user', quota: balanceQuota } }); return
      }
      if (url.pathname === '/harness/api/user/auth/refresh') {
        refreshes += 1
        await refreshBarrier
        access = 'access-renewed'
        response.setHeader('set-cookie', 'new_api_refresh=refresh-two; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: access, access_expires_at: Math.floor(Date.now() / 1000) + 900, user: { id: 7 } }); return
      }
      if (url.pathname === '/harness/api/user/auth/logout') { answer(null); return }
      if (url.pathname === '/harness/api/pricing') { answer(pricingRows); return }
      if ((url.pathname === '/harness/v1/images/generations' || url.pathname === '/harness/v1/images/edits') && imageResponse !== undefined) {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        if (imageResponse === 'disconnect') { response.destroy(); return }
        response.end(JSON.stringify(imageResponse)); return
      }
      if (url.pathname === '/harness/v1/video/generations') {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        response.end(JSON.stringify(videoTaskStatus === undefined ? {} : { code: 'success', data: { task_id: 'fixture-video-task' } })); return
      }
      if (url.pathname === '/harness/v1/video/generations/fixture-video-task') {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        response.end(JSON.stringify({ code: 'success', data: { status: videoTaskStatus, result_url: 'https://ignored.invalid/content.mp4' } })); return
      }
      if (url.pathname === '/harness/v1/videos/fixture-video-task/content') {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        response.setHeader('content-type', 'video/mp4'); response.end(generatedVideo); return
      }
      if (url.pathname === '/harness/v1/models') {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        const rows = structuredClone(relayModels)
        modelReadStarted?.()
        await modelsBarrier
        response.writeHead(modelsStatus)
        response.end(JSON.stringify({ data: rows })); return
      }
      if (url.pathname === '/harness/v1/chat/completions') {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        response.setHeader('content-type', 'text/event-stream')
        response.end([
          'data: {"choices":[{"delta":{"role":"assistant","content":"hello"},"index":0,"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          'data: [DONE]', '',
        ].join('\n\n'))
        return
      }
      if (request.headers.authorization !== `Bearer ${access}`) {
        response.writeHead(401); response.end(JSON.stringify({ success: false, message: 'expired' })); return
      }
      if (url.pathname === '/harness/api/user/self') {
        answer({ id: selfId, username: 'test-user', group: 'default', quota: balanceQuota }); return
      }
      if (url.pathname === '/harness/api/user/wechat/native') {
        creations += 1
        answer({ out_trade_no: 'order-one', code_url: 'weixin://wxpay/bizpayurl?pr=fixture',
          expires_at: Math.floor(Date.now() / 1000) + 300, quota: 68_493, amount: 1 }); return
      }
      if (url.pathname === '/harness/api/user/wechat/order') {
        answer({ out_trade_no: 'order-one', amount: 1, quota: 68_493, status: 'pending' }); return
      }
      response.writeHead(404); response.end(JSON.stringify({ success: false, message: 'Unexpected API route' }))
    })().catch(() => { response.destroy() })
  })
  await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('Missing fixture listener')
  const api = `http://127.0.0.1:${String(address.port)}/harness`
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-credits-index', Credits],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
    ['@deepseek-ai/dsh-artifacts-index', Artifacts],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['fixture-auth-index', { name: 'fixture-auth-index', inject: ['webServer', 'connection'], apply(ctx: Context) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/', handler: (request, response) => {
        if (ctx.connection.authorizeIndex(request, response)) response.end('ready')
      } }), 'fixture browser launch authentication')
    } }],
  ])
  context = new Context()
  context.baseUrl = pathToFileURL(directory).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    loadCache: new Map(),
    async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (!modules.has(specifier)) throw new Error(`Unexpected module: ${specifier}`)
      return modules.get(specifier)
    },
  } as NonNullable<typeof context.loader.internal>
  const entries = [
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-tools' }, { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-fs-local', config: { cwd: directory } },
    { name: '@deepseek-ai/dsh-attachment-local', config: { dshHome: join(directory, 'attachment-home') } },
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(directory, 'credentials.yaml'), dshHome: directory, watch: false } },
    ...authenticatedHost ? [{ name: '@deepseek-ai/dsh-session' }, { name: '@deepseek-ai/dsh-client-connection' }, { name: 'fixture-auth-index' }] : [],
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
      'yunshu-local': { api: 'openai-completions', baseURL: api + '/v1', apiKeyEnv: relayRef, models },
      'other-provider': { api: 'openai-completions', baseURL: 'https://synthetic.invalid/v1', models: [{ id: 'other-chat' }] },
    } } },
    ...managedOutput ? [{ name: '@deepseek-ai/dsh-artifacts-index', config: {
      defaultOutputDirectory: join(directory, 'selected-output'), stateDirectory: join(directory, 'artifact-settings'), roots: [join(stateDir, 'media')],
    } }] : [],
    { name: '@deepseek-ai/dsh-credits-index', config: { stateDir, newApiBaseUrl: api, relayTokenEnv: relayRef } },
  ]
  const configuration = join(directory, 'cordis.yml')
  await writeFile(configuration, JSON.stringify(entries))
  await profileComposition(context, directory, configuration)
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return { base: `http://127.0.0.1:${String(context.webServer.port)}/credits`, api, stateDir }
}

async function post(base: string, path: string, body: object, cookie?: string): Promise<Record<string, unknown>> {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...cookie === undefined ? {} : { cookie } }, body: JSON.stringify(body) })
  return object(await response.json())
}

async function hostCookie(base: string): Promise<string> {
  const auth = await fetch(context!.connection.authenticatedUrl(new URL(base).origin + '/'), { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined) throw new Error('Expected authenticated Host cookie')
  return cookie
}

function projects(answer: Record<string, unknown>): Record<string, unknown>[] {
  expect(answer.ok).toBe(true)
  const values = object(answer.payload).projects
  if (!Array.isArray(values)) throw new Error('Expected creative project list')
  return values.map(object)
}

async function signIn(base: string): Promise<void> {
  const challenge = await post(base, '/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'challenge-one' })
  expect(challenge.ok).toBe(true)
  const payload = object(challenge.payload)
  const login = await post(base, '/api/session/verify', { challengeId: payload.challenge_id, code: '123456', idempotencyKey: 'login-one' })
  expect(login.ok).toBe(true)
  expect(JSON.stringify(login)).not.toMatch(/sk-owned|access-user|refresh-one/)
}

async function chat(): Promise<FinishReason> {
  const ctx = context
  if (ctx === undefined) throw new Error('Expected the running product fixture')
  let finish: FinishReason | undefined
  for await (const chunk of ctx.llm.stream({ provider: 'yunshu-local', model: 'deepseek-v4-flash', messages: [] })) {
    if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish === undefined) throw new Error('Expected the model request to finish')
  return finish
}

/** Give file-reference tools a real workspace identity without starting an LLM turn. */
function videoAgent(workspace: string, sessionId = 'reference-audio-chat'): Agent {
  const ctx = context
  if (ctx === undefined) throw new Error('Expected a running product fixture')
  const id = SessionId(sessionId)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd: workspace })
  const unsupported = (): never => { throw new Error('Fixture inbox is not mutable') }
  return {
    id, session, ctx, options: {}, status: 'running',
    inbox: {
      nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported,
      replace: unsupported, remove: unsupported, splice: unsupported,
    },
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
}

describe('deployed Harness API through the real product Loader', () => {
  it('shares panel images with chat plans, editable revisions, real outputs and authenticated reference thumbnails', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    const origin = new URL(base).origin
    await signIn(base)
    context!.sessions.create(SessionId('panel-chat'), { meta: { cwd: stateDir } })
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=', 'base64')
    imageResponse = { data: [{ b64_json: png.toString('base64') }] }
    for (const filename of ['%ZZ', '%0Anote.png', '%20%20', 'x'.repeat(257)]) {
      const refused = await fetch(base + '/api/assets', { method: 'POST', headers: {
        cookie, 'content-type': 'image/png', 'x-file-name': filename, 'x-idempotency-key': 'invalid-filename',
      }, body: png })
      expect(refused.status).toBe(400)
      expect(await refused.json()).toMatchObject({ ok: false, code: 'MEDIA_ASSET_REQUEST_INVALID' })
    }
    const upload = object(await (await fetch(base + '/api/assets', {
      method: 'POST', headers: { cookie, 'content-type': 'image/png', 'x-file-name': encodeURIComponent('人物参考.png'),
        'x-idempotency-key': 'panel-reference' }, body: png,
    })).json())
    expect(upload.ok).toBe(true)
    const assetId = object(upload.asset).assetId
    if (typeof assetId !== 'string') throw new Error('Expected uploaded reference id')
    const generated = await post(base, '/api/image/generate', {
      session_id: 'panel-chat', account_id: '7', prompt: '红围巾女孩的人物设定图', model: 'gpt-image-2', references: [assetId],
    }, cookie)
    expect(generated.ok).toBe(true)
    const payload = object(generated.payload)
    expect(payload.plan_id).toBeTypeOf('string')
    expect(payload.path).toBeTypeOf('string')
    expect(await readFile(String(payload.path))).toEqual(png)
    const listing = async () => projects(object(await (await fetch(base + '/api/creative/projects?session_id=panel-chat', { headers: { cookie } })).json()))
    let [project] = await listing()
    if (project === undefined) throw new Error('Expected the linked panel project')
    expect(project).toMatchObject({ id: payload.plan_id, sessionId: 'panel-chat', status: 'completed',
      completedShots: 1, totalShots: 1, shots: [{ id: 'shot_1', status: 'completed', outputs: [{ kind: 'image' }] }],
      assets: [{ id: 'reference_1', name: '人物参考.png', sourcePathOrAssetId: assetId }],
      tasks: [{ status: 'completed', shotIds: ['shot_1'], model: 'gpt-image-2', outputs: [{ kind: 'image' }] }],
      outputs: [{ kind: 'image' }],
    })
    const record = object(JSON.parse(await readFile(join(stateDir, 'creative-projects', String(payload.plan_id), 'project.json'), 'utf8')))
    expect(record.owner).toMatchObject({ sessionId: 'panel-chat', workspaceRoot: stateDir, accountId: '7' })
    const outputs = project.outputs
    const assets = project.assets
    if (!Array.isArray(outputs) || !Array.isArray(assets)) throw new Error('Expected panel media and materials')
    const outputUrl = object(outputs[0]).url
    const referenceUrl = object(assets[0]).referenceUrl
    if (typeof outputUrl !== 'string' || typeof referenceUrl !== 'string') throw new Error('Expected controlled creation media URLs')
    const image = await fetch(origin + outputUrl, { headers: { cookie } })
    expect(image.status).toBe(200)
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
    const reference = await fetch(origin + referenceUrl, { headers: { cookie } })
    expect(reference.status).toBe(200)
    expect(reference.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await reference.arrayBuffer())).toEqual(png)
    const head = await fetch(origin + referenceUrl, { method: 'HEAD', headers: { cookie } })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(png.length))
    expect(await head.text()).toBe('')
    expect((await fetch(origin + referenceUrl)).status).toBe(401)
    expect((await fetch(origin + referenceUrl.replace('panel-chat', 'other-chat'), { headers: { cookie } })).status).toBe(404)
    expect((await fetch(origin + referenceUrl.replace('reference_1', 'unrelated-material'), { headers: { cookie } })).status).toBe(404)
    const charges = () => calls.filter(call => call.path.includes('/v1/images/') || call.path === '/harness/v1/video/generations').length
    expect(charges()).toBe(1)
    const initialRevision = project.planRevision
    if (typeof initialRevision !== 'string') throw new Error('Expected plan revision')
    const revise = async (change: object) => {
      const response = await fetch(base + '/api/creative/plan', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'panel-chat', project_id: project!.id, expected_revision: project!.planRevision, change }) })
      expect(response.status).toBe(200)
      const answer = object(await response.json())
      const changed = projects(answer).find(item => item.id === payload.plan_id)
      if (changed === undefined) throw new Error('Expected the same revised project')
      project = changed
    }
    await revise({ kind: 'character', value: { id: 'girl', name: '小雨', appearance: '黑色长发', clothing: '红围巾',
      personality: '坚定', voice: '年轻女声', referenceAssetIds: ['reference_1'] } })
    await revise({ kind: 'shot', id: 'shot_1', patch: { title: '站台近景', durationSeconds: 8, characterIds: ['girl'],
      scene: '清晨站台', camera: '缓慢推进', dialogue: '今天也要向前走', subtitles: '今天也要向前走' } })
    expect(project).toMatchObject({ id: payload.plan_id, status: 'completed', characters: [{ id: 'girl', name: '小雨' }],
      shots: [{ id: 'shot_1', title: '站台近景', durationSeconds: 8, characterIds: ['girl'], status: 'completed', outputs: [{ kind: 'image' }] }],
      outputs: [{ kind: 'image' }], tasks: [{ status: 'completed' }],
    })
    const stale = await fetch(base + '/api/creative/plan', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'panel-chat', project_id: payload.plan_id, expected_revision: initialRevision,
        change: { kind: 'shot', id: 'shot_1', patch: { title: '过期覆盖' } } }) })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ ok: false, code: 'CREATIVE_PLAN_STALE' })
    const crossChat = await fetch(base + '/api/creative/plan', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'other-chat', project_id: payload.plan_id, expected_revision: project.planRevision,
        change: { kind: 'shot', id: 'shot_1', patch: { title: '另一会话覆盖' } } }) })
    expect(crossChat.status).toBe(404)
    expect(await crossChat.json()).toMatchObject({ ok: false, code: 'CREATIVE_ACCESS_DENIED' })
    const agent = videoAgent(stateDir, 'panel-chat')
    const read = object((await context!.tools.execute({ name: 'get_creation_plan', arguments: { plan_id: payload.plan_id }, agent,
      callId: ToolCallId('read-panel-project-in-chat'), signal: new AbortController().signal })).value)
    expect(read).toMatchObject({ status: 'succeeded', plan_id: payload.plan_id,
      plan: { characters: [{ name: '小雨' }], shots: [{ title: '站台近景', character_ids: ['girl'], dialogue: '今天也要向前走' }] } })
    expect(read.plan).toMatchInlineSnapshot(`
      {
        "assets": [
          {
            "description": "",
            "id": "reference_1",
            "kind": "image",
            "name": "人物参考.png",
            "role": "参考素材",
            "source_path_or_asset_id": "ma_panelreference",
          },
        ],
        "brief": "红围巾女孩的人物设定图",
        "characters": [
          {
            "appearance": "黑色长发",
            "clothing": "红围巾",
            "id": "girl",
            "name": "小雨",
            "personality": "坚定",
            "reference_asset_ids": [
              "reference_1",
            ],
            "voice": "年轻女声",
          },
        ],
        "kind": "image",
        "shots": [
          {
            "action": "",
            "asset_ids": [
              "reference_1",
            ],
            "camera": "缓慢推进",
            "character_ids": [
              "girl",
            ],
            "dialogue": "今天也要向前走",
            "duration_seconds": 8,
            "id": "shot_1",
            "order": 1,
            "prompt": "红围巾女孩的人物设定图",
            "scene": "清晨站台",
            "subtitles": "今天也要向前走",
            "title": "站台近景",
          },
        ],
        "style": "",
        "title": "图片 · 红围巾女孩的人物设定图",
      }
    `)
    expect(charges()).toBe(1)
    expect(await listing()).toMatchObject([{ id: payload.plan_id, shots: [{ title: '站台近景' }] }])
    const second = await post(base, '/api/image/generate', {
      session_id: 'panel-chat', account_id: '7', prompt: '清晨车站的背景画面', model: 'gpt-image-2',
    }, cookie)
    expect(second.ok).toBe(true)
    const secondId = object(second.payload).plan_id
    expect(secondId).toBeTypeOf('string')
    expect(secondId).not.toBe(payload.plan_id)
    const retained = await listing()
    expect(retained).toHaveLength(2)
    expect(retained.find(item => item.id === payload.plan_id)).toMatchObject({ shots: [{ title: '站台近景' }] })
    expect(retained.find(item => item.id === secondId)).toMatchObject({ brief: '清晨车站的背景画面', characters: [], status: 'completed' })
    expect(charges()).toBe(2)
  }, 15_000)

  it.each(['image', 'video'] as const)('rejects unowned %s panel requests before any paid upstream submission', async (kind) => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    context!.sessions.create(SessionId('panel-chat'), { meta: { cwd: stateDir } })
    context!.sessions.create(SessionId('chat-without-workspace'))
    pricingRows = [
      { model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
      { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] },
    ]
    imageResponse = { data: [{ b64_json: Buffer.from('not submitted').toString('base64') }] }
    videoTaskStatus = 'SUCCESS'
    const route = kind === 'image' ? '/api/image/generate' : '/api/video/tasks?source=newapi-generate'
    const parameters = kind === 'image' ? { model: 'gpt-image-2' } : { model: 'MiniMax-H3', durationSeconds: 4 }
    const cases = [
      { fields: { account_id: '7' }, status: 400, code: 'CREATIVE_SESSION_INVALID', cookie },
      { fields: { account_id: '7', session_id: 'missing-chat' }, status: 409, code: 'CREATIVE_WORKSPACE_REQUIRED', cookie },
      { fields: { account_id: '7', session_id: 'chat-without-workspace' }, status: 409, code: 'CREATIVE_WORKSPACE_REQUIRED', cookie },
      { fields: { account_id: '7', session_id: '../escape' }, status: 400, code: 'CREATIVE_SESSION_INVALID', cookie },
      { fields: { account_id: '8', session_id: 'panel-chat' }, status: 409, code: 'CREATIVE_ACCOUNT_CHANGED', cookie },
      { fields: { session_id: 'panel-chat' }, status: 409, code: 'CREATIVE_ACCOUNT_CHANGED', cookie },
      { fields: { account_id: '7', session_id: 'panel-chat' }, status: 401, code: 'CREATIVE_HOST_AUTH_REQUIRED', cookie: undefined },
    ]
    for (const sample of cases) {
      const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json',
        ...sample.cookie === undefined ? {} : { cookie: sample.cookie } },
      body: JSON.stringify({ prompt: '不能计费的测试请求', ...parameters, ...sample.fields }) })
      expect(response.status, sample.code).toBe(sample.status)
      expect(await response.json()).toMatchObject({ ok: false, code: sample.code })
    }
    expect(calls.filter(call => call.path.includes('/v1/images/') || call.path === '/harness/v1/video/generations')).toEqual([])
    expect(await readdir(join(stateDir, 'creative-projects')).catch((error: unknown) => {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })).toEqual([])
  }, 15_000)

  it('aborts and settles a registered panel image request when its plugin is disposed during the paid POST', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    context!.sessions.create(SessionId('cancel-image-post'), { meta: { cwd: stateDir } })
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    imageResponse = { data: [{ b64_json: Buffer.from('should never be saved').toString('base64') }] }
    const submitted = Promise.withResolvers<undefined>()
    const closed = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    releaseUpstreamGate = () => { release.resolve(undefined) }
    upstreamGate = async (path, response) => {
      if (path !== '/harness/v1/images/generations') return
      response.once('close', () => { closed.resolve(undefined) })
      submitted.resolve(undefined)
      await release.promise
    }
    const generation = post(base, '/api/image/generate', {
      session_id: 'cancel-image-post', account_id: '7', prompt: '取消期间不能继续生成', model: 'gpt-image-2',
    }, cookie)
    try {
      await submitted.promise
      const [running] = projects(object(await (await fetch(base + '/api/creative/projects?session_id=cancel-image-post',
        { headers: { cookie } })).json()))
      expect(running).toMatchObject({ status: 'running', tasks: [{ status: 'running' }], outputs: [] })
      const fiber = [...context!.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-credits-index')?.fiber
      if (fiber === undefined) throw new Error('Expected the loaded credits plugin')
      await fiber.dispose()
      await closed.promise
      expect(await generation).toMatchObject({ ok: false })
      expect(calls.filter(call => call.path.startsWith('/harness/v1/images/')).map(call => call.path)).toEqual(['/harness/v1/images/generations'])
      const record = object(JSON.parse(await readFile(join(stateDir, 'creative-projects', String(running!.id), 'project.json'), 'utf8')))
      expect(record.operations).toMatchObject([{ status: 'cancelled', outputs: [] }])
      expect((await fetch(base + '/api/creative/projects?session_id=cancel-image-post', { headers: { cookie } })).status).toBe(404)
    } finally {
      release.resolve(undefined)
      await generation
    }
  })

  it('stops a registered panel image before billing when disposal interrupts the output destination check', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    context!.sessions.create(SessionId('cancel-image-capture'), { meta: { cwd: stateDir } })
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    imageResponse = { data: [{ b64_json: Buffer.from('should not be submitted').toString('base64') }] }
    const storage = context!.get('artifactStorage')
    if (storage === undefined) throw new Error('Expected the real managed artifact storage')
    const capture = storage.capture.bind(storage)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    releaseUpstreamGate = () => { release.resolve(undefined) }
    let captureAborted = false
    vi.spyOn(storage, 'capture').mockImplementationOnce(async (signal) => {
      const aborted = (): void => { captureAborted = true; release.resolve(undefined) }
      signal.addEventListener('abort', aborted, { once: true })
      entered.resolve(undefined)
      try {
        await release.promise
        signal.throwIfAborted()
        return await capture(signal)
      } finally { signal.removeEventListener('abort', aborted) }
    })
    const generation = post(base, '/api/image/generate', {
      session_id: 'cancel-image-capture', account_id: '7', prompt: '先检查保存位置再生成', model: 'gpt-image-2',
    }, cookie)
    try {
      await entered.promise
      const fiber = [...context!.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-credits-index')?.fiber
      if (fiber === undefined) throw new Error('Expected the loaded credits plugin')
      await fiber.dispose()
      expect(captureAborted).toBe(true)
      expect(await generation).toMatchObject({ ok: false })
      expect(calls.filter(call => call.path.startsWith('/harness/v1/images/'))).toEqual([])
      const records = await readdir(join(stateDir, 'creative-projects'))
      expect(records).toHaveLength(1)
      const record = object(JSON.parse(await readFile(join(stateDir, 'creative-projects', records[0]!, 'project.json'), 'utf8')))
      expect(record.operations).toMatchObject([{ status: 'cancelled', outputs: [] }])
    } finally {
      release.resolve(undefined)
      await generation
    }
  })

  it('never bills an earlier relay key for a panel video owned by a login completed during capability lookup', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    context!.sessions.create(SessionId('changing-video-account'), { meta: { cwd: stateDir } })
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]
    videoTaskStatus = 'SUCCESS'
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    releaseUpstreamGate = () => { release.resolve(undefined) }
    let paused = false
    upstreamGate = async (path) => {
      if (path !== '/harness/api/pricing' || paused) return
      paused = true
      entered.resolve(undefined)
      await release.promise
    }
    const generation = post(base, '/api/video/tasks?source=newapi-generate', {
      session_id: 'changing-video-account', account_id: '8', prompt: '按当前账号生成视频', model: 'MiniMax-H3', durationSeconds: 4,
    }, cookie)
    try {
      await entered.promise
      await post(base, '/api/session/logout', {})
      selfId = 8
      access = 'access-second-account'
      relayKey = 'sk-second-account-relay'
      await signIn(base)
      release.resolve(undefined)
      const result = await generation
      const submissions = calls.filter(call => call.path === '/harness/v1/video/generations')
      expect(submissions.every(call => call.authorization === 'Bearer sk-second-account-relay')).toBe(true)
      if (result.ok === true) {
        expect(submissions).toHaveLength(1)
        const record = object(JSON.parse(await readFile(join(stateDir, 'creative-projects', String(object(result.payload).plan_id), 'project.json'), 'utf8')))
        expect(record.owner).toMatchObject({ accountId: '8', sessionId: 'changing-video-account' })
      } else expect(submissions).toEqual([])
    } finally {
      release.resolve(undefined)
      await generation
    }
  }, 15_000)

  it('edits current-chat uploaded images and workspace images through the documented multipart endpoint', async () => {
    const { base, stateDir } = await boot()
    await signIn(base)
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
    imageResponse = { data: [{ b64_json: png.toString('base64') }] }
    const attachments = context!.get('attachments')!
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: '用户上传.png' })
    const normalized = await attachments.readImage(ref)
    const attachmentPath = attachments.imageHostPath(ref)
    if (attachmentPath === undefined) throw new Error('Expected the real local attachment path')
    const projectedPath = context!.fs.processPathFromHostPath(attachmentPath)
    if (projectedPath === undefined) throw new Error('Expected the current execution filesystem projection')
    const agent = videoAgent(stateDir)
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'text', text: '把这张图片改成夜晚，保留人物' }, { type: 'image', attachment: ref },
    ] }), { surfaceOp: 'append' })
    const workspaceImage = join(stateDir, 'workspace-image.png')
    await writeFile(workspaceImage, png)
    const inputs = [String(ref.attachmentId), projectedPath, workspaceImage, 'workspace-image.png']
    for (const [index, reference] of inputs.entries()) {
      const result = object((await context!.tools.execute({ name: 'generate_image', arguments: {
        model: 'gpt-image-2', prompt: '保持人物身份，改成夜晚', reference_images: [reference],
      }, agent, callId: ToolCallId(`chat-image-${String(index)}`), signal: new AbortController().signal })).value)
      expect(result).toMatchObject({ status: 'succeeded', paths: [expect.any(String)] })
      expect(await readFile(String(result.path))).toEqual(png)
      const edit = calls.filter(call => call.path === '/harness/v1/images/edits').at(-1)
      expect(edit?.authorization).toBe('Bearer sk-owned-relay')
      const encoded = object(edit?.body).multipart
      if (typeof encoded !== 'string') throw new Error('Expected a real multipart edit request')
      const multipart = Buffer.from(encoded, 'base64')
      expect(multipart.toString('utf8')).toContain('name="image[]"')
      expect(multipart.toString('utf8')).toContain('保持人物身份，改成夜晚')
      expect(multipart.includes(index < 2 ? Buffer.from(normalized.data) : png)).toBe(true)
    }
    expect(calls.filter(call => call.path === '/harness/v1/images/edits')).toHaveLength(4)
    expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toEqual([])
    expect(context!.tools.schemas().find(tool => tool.name === 'generate_image')).toMatchSnapshot('chat image reference tool')
  }, 15_000)

  it('rejects other-chat attachments, workspace escapes, corrupt images and models without edits before paid submission', async () => {
    const { base, stateDir } = await boot()
    await signIn(base)
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
    imageResponse = { data: [{ b64_json: png.toString('base64') }] }
    const attachments = context!.get('attachments')!
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png' })
    const other = videoAgent(stateDir, 'other-chat')
    other.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'image', attachment: ref },
    ] }), { surfaceOp: 'append' })
    const path = attachments.imageHostPath(ref)
    if (path === undefined) throw new Error('Expected stored image path')
    const agent = videoAgent(stateDir)
    const outside = join(directory!, 'outside.png')
    await writeFile(outside, png)
    await writeFile(join(stateDir, 'corrupt.png'), 'not an image')
    const call = async (reference: string, model = 'gpt-image-2') => object((await context!.tools.execute({
      name: 'generate_image', arguments: { model, prompt: '编辑这张图片', reference_images: [reference] },
      agent, callId: ToolCallId('refused-image'), signal: new AbortController().signal,
    })).value)
    const refusedReferences = [String(ref.attachmentId), path, outside, '../outside.png', 'corrupt.png', 'https://example.com/image.png']
    // Creating file symlinks on Windows requires privileges that local test runs need not have.
    if (process.platform !== 'win32') {
      await symlink(outside, join(stateDir, 'escape.png'))
      refusedReferences.push('escape.png')
    }
    for (const reference of refusedReferences) {
      expect(await call(reference)).toMatchObject({ status: 'failed' })
    }
    await writeFile(join(stateDir, 'valid.png'), png)
    relayModels.push({ id: 'yunshu-internal-gpt-image-2', object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows.push({ model_name: 'yunshu-internal-gpt-image-2', supported_endpoint_types: ['image-generation'] })
    const unsupported = await call('valid.png', 'yunshu-internal-gpt-image-2')
    expect(unsupported).toMatchObject({ status: 'failed' })
    expect(unsupported.message).toContain('只支持文生图')
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'image', attachment: ref },
    ] }), { surfaceOp: 'append' })
    await rm(path)
    await writeFile(path, 'corrupted stored attachment')
    expect(await call(String(ref.attachmentId))).toMatchObject({ status: 'failed', code: 'CREATIVE_REFERENCE_INVALID' })
    expect(calls.filter(call => call.path.includes('/v1/images/') || call.path.includes('/toapis/'))).toEqual([])
  }, 15_000)

  it('lists generated video-plan character materials without marking storyboard shots complete', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const origin = new URL(base).origin
    const auth = await fetch(context!.connection.authenticatedUrl(origin + '/'), { redirect: 'manual' })
    const cookie = auth.headers.get('set-cookie')?.split(';')[0]
    if (cookie === undefined) throw new Error('Expected authenticated Host cookie')
    await signIn(base)
    const agent = videoAgent(stateDir)
    const call = async (name: string, args: object) => object((await context!.tools.execute({ name, arguments: args, agent,
      callId: ToolCallId('asset-' + name), signal: new AbortController().signal })).value)
    const plan = await call('update_creation_plan', { kind: 'video', title: '动漫剧情', brief: '红围巾女孩站台对白',
      characters: [{ id: 'girl', name: '小雨', appearance: '黑色长发', reference_asset_ids: ['portrait'] }],
      assets: [
        { id: 'portrait', name: '人物设定图', kind: 'image', source_path_or_asset_id: '' },
        { id: 'voice', name: '声音参考', kind: 'audio', source_path_or_asset_id: '' },
      ], shots: [{ id: 'scene', order: 1, title: '站台', prompt: '女孩说再见', character_ids: ['girl'], asset_ids: ['portrait'] }],
    })
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=', 'base64')
    imageResponse = { data: [{ b64_json: png.toString('base64') }] }
    const args = { plan_id: plan.plan_id, asset_id: 'portrait', prompt: '黑色长发红围巾的女孩人物参考图', model: 'gpt-image-2' }
    for (const invalid of [{ ...args, asset_id: 'voice' }, { ...args, asset_id: 'missing' }, { ...args, shot_id: 'scene' }, { asset_id: 'portrait', prompt: 'image' }]) {
      expect(await call('generate_image', invalid)).toMatchObject({ status: 'failed' })
    }
    expect(calls.filter(call => call.path.includes('/v1/images/'))).toEqual([])
    expect(await call('generate_image', args)).toMatchObject({ status: 'succeeded', plan_id: plan.plan_id })
    const listing = async () => {
      const result = object(await (await fetch(base + '/api/creative/projects?session_id=reference-audio-chat', { headers: { cookie } })).json())
      const projects = object(result.payload).projects
      if (!Array.isArray(projects)) throw new Error('Expected projects')
      return object(projects[0])
    }
    const project = await listing()
    expect(project).toMatchObject({ kind: 'video', status: 'planned', outputs: [{ kind: 'image' }], shots: [{ id: 'scene', status: 'planned', outputs: [] }], assets: [
      { id: 'portrait', sourcePathOrAssetId: '', status: 'completed', outputs: [{ kind: 'image' }] }, { id: 'voice' },
    ] })
    const assets = project.assets
    if (!Array.isArray(assets)) throw new Error('Expected assets')
    const outputs = object(assets[0]).outputs
    if (!Array.isArray(outputs)) throw new Error('Expected real asset outputs')
    expect(project.outputs).toEqual(outputs)
    const output = object(outputs[0])
    if (typeof output.url !== 'string') throw new Error('Expected controlled image URL')
    expect(Buffer.from(await (await fetch(origin + output.url, { headers: { cookie } })).arrayBuffer())).toEqual(png)
    expect(await call('generate_image', { ...args, prompt: '保持人物身份，改成蓝围巾', reference_images: [output.id] })).toMatchObject({ status: 'succeeded' })
    const edit = object(calls.find(call => call.path === '/harness/v1/images/edits')?.body)
    if (typeof edit.multipart !== 'string') throw new Error('Expected reference image multipart')
    expect(Buffer.from(edit.multipart, 'base64').includes(png)).toBe(true)
    imageResponse = 'disconnect'
    expect(await call('generate_image', args)).toMatchObject({ status: 'failed' })
    const count = calls.filter(call => call.path.includes('/v1/images/')).length
    expect(await call('generate_image', args)).toMatchObject({ status: 'failed', code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    expect(calls.filter(call => call.path.includes('/v1/images/'))).toHaveLength(count)
    expect(await listing()).toMatchObject({ status: 'unknown',
      assets: [{ id: 'portrait', status: 'unknown', outputs: [{ kind: 'image' }, { kind: 'image' }] }, { id: 'voice' }],
      shots: [{ id: 'scene', status: 'planned', outputs: [] }], outputs: [{ kind: 'image' }, { kind: 'image' }],
    })
  })

  it('publishes chat plans and real image outputs through authenticated account/chat media routes', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const origin = new URL(base).origin
    const exchanged = await fetch(context!.connection.authenticatedUrl(origin + '/'), { redirect: 'manual' })
    const cookie = exchanged.headers.get('set-cookie')?.split(';')[0]
    if (cookie === undefined) throw new Error('Expected real Host browser authentication')
    expect((await fetch(base + '/api/creative/projects?session_id=reference-audio-chat')).status).toBe(401)
    await signIn(base)
    const agent = videoAgent(stateDir)
    const plan = object((await context!.tools.execute({ callId: ToolCallId('plan'), name: 'update_creation_plan', agent, signal: new AbortController().signal, arguments: {
      kind: 'image', title: '动漫角色', brief: '红围巾女孩', style: '动漫',
      characters: [{ id: 'girl', name: '小雨', appearance: '黑色长发', clothing: '红围巾' }],
      shots: [{ id: 'portrait', order: 1, title: '人物近景', prompt: '红围巾女孩的侧脸', character_ids: ['girl'] }],
    } })).value)
    expect(plan.status).toBe('saved')
    expect(context!.tools.schemas().find(tool => tool.name === 'update_creation_plan')).toMatchSnapshot('structured creation plan tool')
    const query = base + '/api/creative/projects?session_id=reference-audio-chat'
    const before = object(await (await fetch(query, { headers: { cookie } })).json())
    expect(object(before.payload).projects).toMatchObject([{ id: plan.plan_id, status: 'planned', outputs: [], characters: [{ name: '小雨' }] }])
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    imageResponse = { data: [{ b64_json: Buffer.from('actual generated image').toString('base64') }] }
    const generated = object((await context!.tools.execute({ callId: ToolCallId('planned-image'), name: 'generate_image', agent, signal: new AbortController().signal, arguments: {
      prompt: '红围巾女孩的侧脸', model: 'gpt-image-2', plan_id: plan.plan_id, shot_id: 'portrait',
    } })).value)
    expect(generated).toMatchObject({ status: 'succeeded', plan_id: plan.plan_id })
    const after = object(await (await fetch(query, { headers: { cookie } })).json())
    const projects = object(after.payload).projects
    if (!Array.isArray(projects)) throw new Error('Expected creation projects')
    const project = object(projects[0])
    expect(project).toMatchObject({ status: 'completed', shots: [{ id: 'portrait', status: 'completed' }] })
    const outputs = project.outputs
    if (!Array.isArray(outputs)) throw new Error('Expected real saved outputs')
    const url = object(outputs[0]).url
    if (typeof url !== 'string') throw new Error('Expected controlled output URL')
    expect(await (await fetch(origin + url, { headers: { cookie } })).text()).toBe('actual generated image')
    const range = await fetch(origin + url, { headers: { cookie, range: 'bytes=0-5' } })
    expect(range.status).toBe(206); expect(await range.text()).toBe('actual')
    expect((await fetch(origin + url, { method: 'HEAD', headers: { cookie } })).headers.get('content-length')).toBe('22')
    expect((await fetch(origin + url)).status).toBe(401)
    expect((await fetch(origin + url.replace('reference-audio-chat', 'other-chat'), { headers: { cookie } })).status).toBe(404)
    expect(object(object(await (await fetch(base + '/api/creative/projects?session_id=other-chat', { headers: { cookie } })).json()).payload).projects).toEqual([])
    expect(JSON.stringify(after)).not.toMatch(/access-user|sk-owned-relay|sessionFingerprint|reference-audio-chat.*workspaceRoot/u)
    await post(base, '/api/session/logout', {})
    const loggedOut = await fetch(query, { headers: { cookie } })
    expect(loggedOut.status).toBe(401); expect(await loggedOut.json()).toMatchObject({ code: 'AUTH_REQUIRED' })
    selfId = 8
    await signIn(base)
    expect(object(object(await (await fetch(query, { headers: { cookie } })).json()).payload).projects).toEqual([])
    expect((await fetch(origin + url, { headers: { cookie } })).status).toBe(404)
  })

  it('uses the real managed Host destination for chat images, creation images and video after asynchronous Loader startup', async () => {
    let projectOptions: VideoProjectOptions | undefined
    const register = VideoProjectTools.registerVideoProjectTools
    vi.spyOn(VideoProjectTools, 'registerVideoProjectTools').mockImplementation((ctx, options) => {
      projectOptions = options
      register(ctx, options)
    })
    const { base, stateDir } = await boot(undefined, true)
    await signIn(base)
    pricingRows = [
      { model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
      { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] },
    ]
    imageResponse = { data: [{ b64_json: Buffer.from('managed image bytes').toString('base64') }] }
    const storage = context!.get('artifactStorage')
    expect(storage).toBeDefined()
    const destination = await storage!.capture(new AbortController().signal)
    expect(await projectOptions?.publication?.capture(new AbortController().signal)).toEqual(destination)
    expect(destination.directory).not.toBe(join(stateDir, 'media'))
    const image = await context!.tools.execute({
      callId: ToolCallId('managed-image'), name: 'generate_image', arguments: { prompt: 'A white cup', model: 'gpt-image-2' }, signal: new AbortController().signal,
      agent: videoAgent(stateDir),
    })
    const chatImage = object(image.value)
    expect(chatImage, JSON.stringify(chatImage)).toMatchObject({ status: 'succeeded' })
    expect(String(chatImage.path).startsWith(destination.directory)).toBe(true)
    expect(await readFile(String(chatImage.path), 'utf8')).toBe('managed image bytes')
    const created = await post(base, '/api/image/generate', { prompt: 'A white cup', model: 'gpt-image-2' })
    expect(created.ok).toBe(true)
    expect(String(object(created.payload).path).startsWith(destination.directory)).toBe(true)
    expect(await readFile(String(object(created.payload).path), 'utf8')).toBe('managed image bytes')
    videoTaskStatus = 'completed'
    const video = await context!.tools.execute({
      callId: ToolCallId('managed-video'), name: 'generate_video', arguments: { prompt: 'A cup in sunlight', model: 'MiniMax-H3', duration_seconds: 4 }, signal: new AbortController().signal,
      agent: videoAgent(stateDir),
    })
    const chatVideo = object(video.value)
    expect(chatVideo.status).toBe('succeeded')
    expect(String(chatVideo.path).startsWith(destination.directory)).toBe(true)
    expect(await readFile(String(chatVideo.path))).toEqual(generatedVideo)
    const submissions = calls.filter(call => call.path === '/harness/v1/images/generations').length
    await rename(destination.directory, destination.directory + '-retained')
    await writeFile(destination.directory, 'directory unavailable')
    const refused = await post(base, '/api/image/generate', { prompt: 'A white cup', model: 'gpt-image-2' })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('ARTIFACT_DESTINATION_UNAVAILABLE')
    expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toHaveLength(submissions)
  }, 15_000)

  it('carries chat and project WAV/MP3 references through H3 native content without inventing audio switches', async () => {
    let options: VideoProjectOptions | undefined
    const register = VideoProjectTools.registerVideoProjectTools
    vi.spyOn(VideoProjectTools, 'registerVideoProjectTools').mockImplementation((ctx, value) => {
      options = value
      register(ctx, value)
    })
    const { base, stateDir } = await boot()
    await signIn(base)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]
    const workspace = join(stateDir, 'workspace')
    await mkdir(workspace)
    const wav = Buffer.from('RIFF0000WAVEdata', 'ascii')
    const mp3 = Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0])
    await writeFile(join(workspace, 'voice.wav'), wav)
    await writeFile(join(workspace, 'voice.mp3'), mp3)
    const agent = videoAgent(workspace)
    const execute = (args: Record<string, unknown>) => context!.tools.execute({
      callId: ToolCallId('reference-audio'), name: 'generate_video',
      arguments: { prompt: 'A says “你好” in Mandarin; synchronized lips; no subtitles.', model: 'MiniMax-H3', duration_seconds: 4, ...args },
      agent, signal: new AbortController().signal,
    })
    const disabled = object((await execute({ audio: false })).value)
    expect(disabled.status).toBe('failed')
    expect(disabled.message).toContain('不能关闭')
    expect(calls.filter(call => call.path === '/harness/v1/video/generations')).toEqual([])
    await execute({ audio: true, reference_audios: ['voice.wav'] })
    const first = object(calls.find(call => call.path === '/harness/v1/video/generations')?.body)
    expect(first).not.toHaveProperty('generate_audio')
    expect(first).not.toHaveProperty('native_audio')
    expect(object(first.metadata).content).toEqual([
      { type: 'text', text: 'A says “你好” in Mandarin; synchronized lips; no subtitles.' },
      { type: 'audio_url', role: 'reference_audio', audio_url: { url: `data:audio/wav;base64,${wav.toString('base64')}` } },
    ])
    const refs = await readdir(join(stateDir, 'refs'))
    const assetId = refs.find(name => name.endsWith('.wav'))?.slice(0, -4)
    if (assetId === undefined || options === undefined) throw new Error('Missing prepared reference or project bridge')
    await execute({ audio: true, reference_audios: [assetId] })
    const provider = await options.acquireProvider(workspace, agent.session)
    const model = await provider.model('MiniMax-H3', new AbortController().signal)
    const request = await provider.build({ prompt: 'A talks', totalDurationSeconds: 4, audio: true, referenceAudios: [assetId, 'voice.mp3'] }, model.id, 'A talks', 4, new AbortController().signal)
    expect(request).not.toHaveProperty('generate_audio')
    expect(request).not.toHaveProperty('native_audio')
    expect(object(request.metadata).content).toEqual([
      { type: 'text', text: 'A talks' },
      { type: 'audio_url', role: 'reference_audio', audio_url: { url: `data:audio/wav;base64,${wav.toString('base64')}` } },
      { type: 'audio_url', role: 'reference_audio', audio_url: { url: `data:audio/mpeg;base64,${mp3.toString('base64')}` } },
    ])
    await expect(provider.submit(request, new AbortController().signal)).rejects.toMatchObject({ code: 'VIDEO_SUBMIT_UNKNOWN' })
    expect(calls.filter(call => call.path === '/harness/v1/video/generations').at(-1)?.body).toEqual(request)
    expect(calls.filter(call => call.path.startsWith('/harness/v1/video')).map(call => call.path)).toEqual(Array<string>(3).fill('/harness/v1/video/generations'))
  })

  it('rejects unsafe, invalid and oversized chat audio references before any model submission', async () => {
    const { base, stateDir } = await boot()
    await signIn(base)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]
    const workspace = join(stateDir, 'workspace')
    await mkdir(workspace)
    await writeFile(join(stateDir, 'outside.wav'), Buffer.from('RIFF0000WAVEdata'))
    await writeFile(join(workspace, 'invalid.wav'), 'not a wave')
    await writeFile(join(workspace, 'oversized.wav'), Buffer.alloc(15 * 1024 * 1024 + 1))
    const agent = videoAgent(workspace)
    for (const references of [['../outside.wav'], ['invalid.wav'], ['oversized.wav'], ['ma_missing'], Array<string>(4).fill('ma_missing')]) {
      const result = await context!.tools.execute({ callId: ToolCallId('bad-audio'), name: 'generate_video', arguments: {
        prompt: 'A talks', model: 'MiniMax-H3', duration_seconds: 4, reference_audios: references,
      }, agent, signal: new AbortController().signal })
      expect(object(result.value)).toMatchObject({ status: 'failed' })
    }
    expect(calls.some(call => call.path === '/harness/v1/video/generations')).toBe(false)
  })

  it('forwards the declared audio switch only for models that expose it', async () => {
    const { base, stateDir } = await boot()
    await signIn(base)
    pricingRows = [{ model_name: 'grok-imagine-video', supported_endpoint_types: ['openai-video'], route: '/v1/video/generations' }]
    for (const audio of [true, false]) {
      await context!.tools.execute({ callId: ToolCallId(`audio-${String(audio)}`), name: 'generate_video', arguments: {
        prompt: 'A synthetic clip', model: 'grok-imagine-video', duration_seconds: 4, audio,
      }, agent: videoAgent(stateDir), signal: new AbortController().signal })
    }
    expect(calls.filter(call => call.path === '/harness/v1/video/generations').map(call => object(call.body).generate_audio)).toEqual([true, false])
    expect(calls.filter(call => call.path === '/harness/v1/video/generations').every(call => !('native_audio' in object(call.body)))).toBe(true)
  })

  it('refuses single-clip billing after the account changes while reading a workspace audio reference', async () => {
    const { base, stateDir } = await boot()
    await signIn(base)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]
    const workspace = join(stateDir, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'voice.wav'), Buffer.from('RIFF0000WAVEdata'))
    let started: (() => void) | undefined
    let release: (() => void) | undefined
    const reading = new Promise<void>((resolve) => { started = resolve })
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const read = context!.fs.readBytes.bind(context!.fs)
    vi.spyOn(context!.fs, 'readBytes').mockImplementation(async (...args) => {
      started?.()
      await barrier
      return read(...args)
    })
    const pending = context!.tools.execute({ callId: ToolCallId('account-changing-audio'), name: 'generate_video', arguments: {
      prompt: 'A talks', model: 'MiniMax-H3', duration_seconds: 4, reference_audios: ['voice.wav'],
    }, agent: videoAgent(workspace), signal: new AbortController().signal })
    try {
      await reading
      await post(base, '/api/session/logout', {})
      selfId = 8
      await signIn(base)
    } finally { release?.() }
    const stopped = object((await pending).value)
    expect(stopped.status).toBe('failed')
    expect(stopped.message).toContain('登录状态已变化')
    expect(calls.some(call => call.path === '/harness/v1/video/generations')).toBe(false)
  })

  it('fills image inputs from the exact installed catalog even when existing model IDs have not changed', async () => {
    const ids = ['deepseek-flash', 'kimi-k2.6', 'kimi-k2.7-code', 'qwen3.6-plus', 'qwen3.7-plus', 'qwen3.6-flash', 'qwen3.8-max']
    relayModels = ids.map(id => ({ id, object: 'model', supported_endpoint_types: ['openai'] }))
    const { base } = await boot(ids.map(id => ({ id, input: [] })))
    await signIn(base)
    const listed = await context!.llm.listModels('yunshu-local')
    const capabilities = listed.map(model => ({ id: model.id, input: model.inputModalities }))
    expect(capabilities).toEqual(ids.map(id => ({ id, input: ['text', 'image'] })))
    expect(capabilities).toMatchInlineSnapshot(`
      [
        {
          "id": "deepseek-flash",
          "input": [
            "text",
            "image",
          ],
        },
        {
          "id": "kimi-k2.6",
          "input": [
            "text",
            "image",
          ],
        },
        {
          "id": "kimi-k2.7-code",
          "input": [
            "text",
            "image",
          ],
        },
        {
          "id": "qwen3.6-plus",
          "input": [
            "text",
            "image",
          ],
        },
        {
          "id": "qwen3.7-plus",
          "input": [
            "text",
            "image",
          ],
        },
        {
          "id": "qwen3.6-flash",
          "input": [
            "text",
            "image",
          ],
        },
        {
          "id": "qwen3.8-max",
          "input": [
            "text",
            "image",
          ],
        },
      ]
    `)
    const descriptor = context!.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
    const configured = object(object(object(descriptor?.value).providers)['yunshu-local']).models
    expect(Array.isArray(configured) && configured.every(model => object(model).input !== undefined)).toBe(true)
    expect(calls.some(call => call.path.includes('chat/completions'))).toBe(false)
    expect(calls.every(call => call.path.startsWith('/harness/'))).toBe(true)
  })

  it('does not infer image input when installed catalogs disagree about the exact model', async () => {
    relayModels = [{ id: 'deepseek-flash', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot([{ id: 'deepseek-flash' }])
    const llm = context!.llm
    const original = llm.discoverModels.bind(llm)
    const provider = llm.listConfigurableProviders().find(entry => entry.settingsNs === 'llm-pi-ai' && entry.declared === false)?.provider
    if (provider === undefined) throw new Error('Expected an installed provider catalog')
    const discovery = vi.spyOn(llm, 'discoverModels').mockImplementation(async (ns, request, signal) => {
      const models = await original(ns, request, signal)
      return request.provider === provider
        ? [...models.filter(model => model.id !== 'deepseek-flash'), { id: 'deepseek-flash', inputModalities: ['text'] }]
        : models
    })
    try {
      await signIn(base)
      expect((await llm.listModels('yunshu-local')).map(model => ({ id: model.id, input: model.inputModalities })))
        .toEqual([{ id: 'deepseek-flash', input: ['text'] }])
      expect(calls.some(call => call.path.includes('chat/completions'))).toBe(false)
    } finally {
      discovery.mockRestore()
    }
  })

  it('keeps unknown and catalog text-only models textual without guessing aliases', async () => {
    const ids = ['gp-5.5', 'ys-1.0', 'claode-5', 'alias-kimi-k2.6', 'deepseek-v4-flash', 'qwen3.7-max']
    relayModels = ids.map(id => ({ id, object: 'model', supported_endpoint_types: ['openai'] }))
    const { base } = await boot()
    await signIn(base)
    expect((await context!.llm.listModels('yunshu-local')).map(model => ({ id: model.id, input: model.inputModalities })))
      .toEqual(ids.map(id => ({ id, input: ['text'] })))
    expect(calls.some(call => call.path.includes('chat/completions'))).toBe(false)
  })

  it('preserves explicit inputs and other model overrides when the account adds a model', async () => {
    relayModels = [{ id: 'deepseek-flash', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot([{ id: 'deepseek-flash', input: ['text'], name: 'My model', contextWindow: 65_536, maxTokens: 2048 }])
    await signIn(base)
    expect((await context!.llm.listModels('yunshu-local'))[0]).toMatchObject({ id: 'deepseek-flash', inputModalities: ['text'] })
    relayModels.push({ id: 'qwen3.6-plus', object: 'model', supported_endpoint_types: ['openai'] })
    expect((await context!.llm.listModels('yunshu-local')).map(model => ({ id: model.id, input: model.inputModalities })))
      .toEqual([{ id: 'deepseek-flash', input: ['text'] }, { id: 'qwen3.6-plus', input: ['text', 'image'] }])
    const descriptor = context!.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
    const configured = object(object(object(descriptor?.value).providers)['yunshu-local']).models
    expect(configured).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deepseek-flash', input: ['text'], name: 'My model', contextWindow: 65_536, maxTokens: 2048 }),
    ]))
    expect(calls.some(call => call.path.includes('chat/completions'))).toBe(false)
  })

  it.each(['panel', 'chat', 'linked-panel'] as const)('submits H3 through the %s entry and saves uppercase generic task success', async (entry) => {
    const linked = entry === 'linked-panel'
    const { base, stateDir } = await boot(undefined, linked, linked)
    const cookie = linked ? await hostCookie(base) : undefined
    if (linked) context!.sessions.create(SessionId('panel-video-chat'), { meta: { cwd: stateDir } })
    await signIn(base)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'], enable_groups: ['default'] }]
    videoTaskStatus = 'SUCCESS'
    const outcome = entry !== 'chat'
      ? await post(base, '/api/video/tasks?source=newapi-generate', { prompt: 'A synthetic clip', model: 'MiniMax-H3', durationSeconds: 4,
        ...linked ? { session_id: 'panel-video-chat', account_id: '7' } : {} }, cookie)
      : object((await context!.tools.execute({ callId: ToolCallId('h3-chat-route'), name: 'generate_video',
        arguments: { prompt: 'A synthetic clip', model: 'MiniMax-H3', duration_seconds: 4 }, agent: videoAgent(stateDir), signal: new AbortController().signal })).value)
    const path = entry !== 'chat' ? object(outcome.payload).path : outcome.path
    expect(outcome).toMatchObject(entry !== 'chat' ? { ok: true, taskId: 'fixture-video-task' } : { status: 'succeeded', task_id: 'fixture-video-task' })
    if (typeof path !== 'string') throw new Error('Expected the saved video path')
    expect(await readFile(path)).toEqual(generatedVideo)
    if (linked) {
      const payload = object(outcome.payload)
      const project = projects(object(await (await fetch(base + '/api/creative/projects?session_id=panel-video-chat',
        { headers: { cookie: cookie! } })).json()))[0]
      expect(project).toMatchObject({ id: payload.plan_id, sessionId: 'panel-video-chat', kind: 'video', status: 'completed',
        completedShots: 1, totalShots: 1, shots: [{ id: 'shot_1', durationSeconds: 4, status: 'completed', outputs: [{ kind: 'video' }] }],
        tasks: [{ status: 'completed', shotIds: ['shot_1'], model: 'MiniMax-H3', outputs: [{ kind: 'video' }] }],
        outputs: [{ kind: 'video' }],
      })
    }
    const videoCalls = calls.filter(call => call.path.startsWith('/harness/v1/video'))
    expect(videoCalls.map(call => call.path)).toEqual([
      '/harness/v1/video/generations', '/harness/v1/video/generations/fixture-video-task', '/harness/v1/videos/fixture-video-task/content',
    ])
    expect(videoCalls.every(call => call.authorization === 'Bearer sk-owned-relay')).toBe(true)
    expect(calls.some(call => call.path === '/harness/v1/videos' || call.path.startsWith('/v1/'))).toBe(false)
  })

  it('uses the selected H3 route for an asynchronous panel submission', async () => {
    const { base } = await boot()
    await signIn(base)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'], route: '/v1/video/generations' }]
    videoTaskStatus = 'NOT_START'
    expect(await post(base, '/api/video/tasks?source=newapi', { prompt: 'A synthetic clip', model: 'MiniMax-H3', durationSeconds: 4 })).toMatchObject({ ok: true })
    expect(calls.filter(call => call.path.startsWith('/harness/v1/video')).map(call => call.path)).toEqual(['/harness/v1/video/generations'])
  })

  it('refreshes the actual account list on each read without waiting for the periodic sync', async () => {
    const { base } = await boot()
    await signIn(base)
    relayModels = [{ id: 'ys-1.0', object: 'model', supported_endpoint_types: ['openai'] }]
    expect((await context!.llm.listModels('yunshu-local')).map(model => model.id)).toEqual(['ys-1.0'])
    relayModels = [...relayModels, { id: 'deepseek-v4-flash', object: 'model', supported_endpoint_types: ['openai'] }]
    expect((await context!.llm.listModels('yunshu-local')).map(model => model.id)).toEqual(['ys-1.0', 'deepseek-v4-flash'])
    expect((await context!.llm.listModels('other-provider')).map(model => model.id)).toEqual(['other-chat'])
    expect(calls.filter(call => call.path === '/harness/v1/models')).toHaveLength(2)
  })

  it('hides old model names for a successful empty list and rejects failed fresh reads', async () => {
    const { base } = await boot()
    await signIn(base)
    expect((await context!.llm.listModels('yunshu-local')).map(model => model.id)).toEqual(['deepseek-v4-flash'])
    modelsStatus = 503
    await expect(context!.llm.listModels('yunshu-local')).rejects.toThrow('无法读取当前账号模型列表')
    expect((await context!.llm.listModels('other-provider')).map(model => model.id)).toEqual(['other-chat'])
    modelsStatus = 200
    relayModels = []
    expect(await context!.llm.listModels('yunshu-local')).toEqual([])
    await post(base, '/api/session/logout', {})
    await expect(context!.llm.listModels('yunshu-local')).rejects.toThrow('请先登录产品账号')
  })

  it('shares one in-flight model read for concurrent catalog consumers', async () => {
    const { base } = await boot()
    await signIn(base)
    const started = new Promise<void>((resolve) => { modelReadStarted = resolve })
    modelsBarrier = new Promise<void>((resolve) => { releaseModels = resolve })
    const first = context!.llm.listModels('yunshu-local')
    const second = context!.llm.listModels('yunshu-local')
    await started
    expect(calls.filter(call => call.path === '/harness/v1/models')).toHaveLength(1)
    releaseModels?.()
    expect((await first).map(model => model.id)).toEqual(['deepseek-v4-flash'])
    expect((await second).map(model => model.id)).toEqual(['deepseek-v4-flash'])
    expect(calls.filter(call => call.path === '/harness/v1/models')).toHaveLength(1)
  })

  it('rejects a delayed old-account listing after logout and another phone sign-in', async () => {
    const { base } = await boot()
    await signIn(base)
    relayModels = [{ id: 'account-A-model', object: 'model', supported_endpoint_types: ['openai'] }]
    const started = new Promise<void>((resolve) => { modelReadStarted = resolve })
    modelsBarrier = new Promise<void>((resolve) => { releaseModels = resolve })
    const pending = context!.llm.listModels('yunshu-local').then(
      models => ({ models }), (error: unknown) => ({ error }),
    )
    await started
    await post(base, '/api/session/logout', {})
    selfId = 8
    relayModels = [{ id: 'account-B-model', object: 'model', supported_endpoint_types: ['openai'] }]
    await signIn(base)
    releaseModels?.()
    expect(await pending).toHaveProperty('error')
    modelsBarrier = undefined
    expect((await context!.llm.listModels('yunshu-local')).map(model => model.id)).toEqual(['account-B-model'])
    expect(JSON.stringify(context!.settings.describe({ redactSecrets: true }))).not.toContain('account-A-model')
  })

  it('enforces published duration combinations before model submission and forwards complete H3 references', async () => {
    const { base } = await boot()
    await signIn(base)
    const row = { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'], enable_groups: ['default'] }
    pricingRows = [{ ...row, billing_usage_schema: { seconds: { type: 'number' }, resolution: { enum: ['768P', '2K'] } } }]
    const generate = (body: object): Promise<Record<string, unknown>> => post(base, '/api/video/tasks?source=newapi-generate', { prompt: 'A synthetic clip', model: 'MiniMax-H3', ...body })
    expect(await generate({ durationSeconds: 30, resolution: '768P' })).toMatchObject({ ok: false, code: 'DURATION_NOT_SUPPORTED' })
    pricingRows = [{ ...row, parameters: { oneOf: [
      { properties: { resolution: { enum: ['480P', '768P'] }, seconds: { minimum: 4, maximum: 30 } } },
      { properties: { resolution: { const: '2K' }, seconds: { enum: [5, 10, 15] } } },
    ] } }]
    for (const durationSeconds of [0, 3, 4.2, 31, '30', null]) {
      expect(await generate({ durationSeconds, resolution: '768P' })).toMatchObject({ ok: false, code: 'DURATION_NOT_SUPPORTED' })
    }
    expect(await generate({ durationSeconds: 30, resolution: '2K' })).toMatchObject({ ok: false, code: 'DURATION_NOT_SUPPORTED' })
    expect(await generate({ durationSeconds: 30 })).toMatchObject({ ok: false, code: 'DURATION_NOT_SUPPORTED' })
    expect(calls.filter(call => call.path === '/harness/v1/video/generations')).toHaveLength(0)

    const upload = async (type: string, name: string, bytes: Buffer): Promise<string> => {
      const response = await fetch(base + '/api/assets', { method: 'POST', headers: {
        'content-type': type, 'x-file-name': name, 'x-idempotency-key': name,
      }, body: new Uint8Array(bytes) })
      const result = object(await response.json())
      expect(result.ok).toBe(true)
      return String(object(result.asset).assetId)
    }
    const image = await upload('image/png', 'image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]))
    const video = await upload('video/mp4', 'clip.mp4', Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]))
    const audio = await upload('audio/wav', 'voice.wav', Buffer.from('RIFF0000WAVEdata', 'ascii'))
    expect(await generate({ durationSeconds: 30, resolution: '768P', ratio: 'adaptive', referenceAudios: [audio] })).toMatchObject({ ok: false, code: 'RATIO_NOT_SUPPORTED' })
    expect(await generate({ durationSeconds: 30, resolution: '768P', referenceImages: [audio] })).toMatchObject({ ok: false, code: 'REFERENCE_MISSING' })
    expect(await generate({ durationSeconds: 30, resolution: '768P', referenceAudios: ['https://invalid.example/audio.wav'] })).toMatchObject({ ok: false, code: 'REFERENCE_MISSING' })
    expect(await generate({ durationSeconds: 30, resolution: '768P', ratio: 'adaptive' })).toMatchObject({ ok: false, code: 'RATIO_NOT_SUPPORTED' })
    expect(calls.filter(call => call.path === '/harness/v1/video/generations')).toHaveLength(0)
    expect(await generate({ durationSeconds: 30, resolution: '768P', ratio: '16:9',
      referenceImages: [image], referenceVideos: [video], referenceAudios: [audio],
    })).toMatchObject({ ok: false, code: 'NO_TASK_ID' })
    const submitted = calls.filter(call => call.path === '/harness/v1/video/generations')
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject({ authorization: 'Bearer sk-owned-relay', body: { duration: 30, resolution: '768P' } })
    const content = object(object(submitted[0]?.body).metadata).content
    if (!Array.isArray(content)) throw new Error('Expected complete multimodal content')
    expect(content.map(item => ({ type: object(item).type, role: object(item).role }))).toEqual([
      { type: 'text', role: undefined }, { type: 'image_url', role: 'reference_image' },
      { type: 'video_url', role: 'reference_video' }, { type: 'audio_url', role: 'reference_audio' },
    ])
    expect(object(content[0]).text).toBe('A synthetic clip')
    expect(object(object(content[1]).image_url).url).toMatch(/^data:image\/png;base64,/)
    expect(object(object(content[2]).video_url).url).toMatch(/^data:video\/mp4;base64,/)
    expect(object(object(content[3]).audio_url).url).toMatch(/^data:audio\/wav;base64,/)
    expect(object(object(submitted[0]?.body).metadata)).not.toHaveProperty('reference_video')
    expect(object(object(submitted[0]?.body).metadata)).not.toHaveProperty('reference_audio')
  })

  it('rejects audio MIME mismatches, unsupported formats and oversized files before storing them', async () => {
    const { base, stateDir } = await boot()
    await signIn(base)
    for (const [type, bytes] of [
      ['audio/wav', Buffer.from('not a wave')], ['audio/mpeg', Buffer.from('not an mp3')],
      ['audio/ogg', Buffer.from('OggS')], ['audio/mpeg', Buffer.alloc(15 * 1024 * 1024 + 1)],
    ] as const) {
      const response = await fetch(base + '/api/assets', { method: 'POST', headers: {
        'content-type': type, 'x-file-name': 'invalid', 'x-idempotency-key': 'invalid',
      }, body: new Uint8Array(bytes) })
      expect(await response.json()).toMatchObject({ ok: false, code: 'MEDIA_ASSET_REQUEST_INVALID' })
    }
    expect(await readFile(join(stateDir, 'refs', 'ma_invalid.mp3')).catch(() => null)).toBeNull()
    expect(calls.some(call => call.path.endsWith('/videos'))).toBe(false)
  })

  it('uses only the live account relay key even when an inherited environment token cannot be removed', async () => {
    vi.stubEnv(relayRef, 'sk-old-environment-token')
    const { base } = await boot()
    expect(await chat()).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(calls.some(call => call.path.endsWith('/chat/completions'))).toBe(false)
    await signIn(base)
    expect(await chat()).toMatchObject({ kind: 'stop' })
    expect(calls.filter(call => call.path.endsWith('/chat/completions'))).toMatchObject([{ authorization: 'Bearer sk-owned-relay' }])
    await post(base, '/api/session/logout', {})
    expect(await context?.credentials.resolve(relayRef)).toMatchObject({ value: 'sk-old-environment-token' })
    expect(await chat()).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(calls.filter(call => call.path.endsWith('/chat/completions'))).toHaveLength(1)
  })

  it('refuses an expired or differently bound account despite a stored relay reference', async () => {
    const { stateDir } = await boot()
    await context?.credentials.set(relayRef, 'sk-stale-managed-token')
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      token: 'old-session', expiresAt: '9999-01-01T00:00:00.000Z', backendBaseUrl: 'https://different.example/harness',
      account: { id: '7', phone: '+8613800000000' }, relay: { key: 'sk-old-session-token' },
      upstream: { token: 'old-access', expiresAt: '2000-01-01T00:00:00.000Z' },
    }))
    expect(await chat()).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(calls.some(call => call.path.endsWith('/chat/completions'))).toBe(false)
  })

  it('keeps the prefix, uses account access for management and relay for models, and clears credentials on logout', async () => {
    const { base, api, stateDir } = await boot()
    await signIn(base)
    expect(await context?.credentials.resolve(relayRef)).toMatchObject({ value: 'sk-owned-relay' })
    expect(JSON.parse(await readFile(join(stateDir, 'session.json'), 'utf8'))).toMatchObject({ backendBaseUrl: api })
    const summary = object(await (await fetch(base + '/api/summary')).json())
    expect(summary).toMatchObject({ ok: true, balance: { credits: 1000 } })
    const challenge = calls.find(call => call.path.endsWith('/phone/challenge'))
    const login = calls.find(call => call.path.endsWith('/phone/login'))
    expect(challenge?.body).toEqual({ phone_e164: '+8613800000000' })
    expect(login?.body).toEqual({ phone_e164: '+8613800000000', code: '123456' })
    expect(calls.find(call => call.path.endsWith('/user/self'))?.authorization).toBe('Bearer access-user')
    expect(await (await fetch(base + '/api/models?source=newapi')).json()).toMatchObject({
      ok: true, chat: ['deepseek-v4-flash'], image: ['gpt-image-2'], video: ['MiniMax-H3'],
    })
    expect(calls.find(call => call.path.endsWith('/v1/models'))?.authorization).toBe('Bearer sk-owned-relay')
    await post(base, '/api/session/logout', {})
    expect(await context?.credentials.resolve(relayRef)).toBeUndefined()
    const logout = calls.find(call => call.path.endsWith('/auth/logout'))
    expect(logout?.origin).toBe(new URL(api).origin)
    expect(logout?.cookie).toContain('new_api_refresh=refresh-one')
    expect(calls.every(call => call.path.startsWith('/harness/'))).toBe(true)
    expect(calls.some(call => /\/search|\/api\/v[12]\/auth|usage\/token/u.test(call.path))).toBe(false)
  })

  it('reads current conversion parameters and never substitutes a stale/default balance', async () => {
    const { base } = await boot()
    await signIn(base)
    quotaPerUnit = 1_000_000
    exchangeRate = 4
    balanceQuota = 250_000
    expect(await (await fetch(base + '/api/summary')).json()).toMatchObject({ ok: true, balance: { credits: 1000, yuan: 1 } })
    statusAvailable = false
    const failed = object(await (await fetch(base + '/api/summary')).json())
    expect(failed.ok).toBe(false)
    expect(failed.balance).toBeNull()
  })

  it('charges integer yuan, creates a real QR and exposes converted points for the same order', async () => {
    const { base } = await boot()
    await signIn(base)
    expect(await post(base, '/api/recharge/wechat', { amount: 1.5 })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(creations).toBe(0)
    const created = await post(base, '/api/recharge/wechat', { amount: 1 })
    expect(created).toMatchObject({ ok: true, payload: { outTradeNo: 'order-one', amount: 1, points: 1000 } })
    expect(object(created.payload).qrCodeDataUrl).toMatch(/^data:image\/png;base64,/u)
    expect(calls.find(call => call.path.endsWith('/wechat/native'))).toMatchObject({ authorization: 'Bearer access-user', body: { amount: 1 } })
    const order: unknown = await (await fetch(base + '/api/recharge/wechat/order?outTradeNo=order-one')).json()
    expect(order).toMatchObject({ ok: true, payload: { status: 'pending', amount: 1, points: 1000 } })
    expect(calls.some(call => call.path.endsWith('/wechat/order?out_trade_no=order-one'))).toBe(true)
  })

  it('waits for one rotating refresh before concurrent account reads', async () => {
    const { base, api } = await boot()
    await signIn(base)
    refreshBarrier = new Promise<void>((resolve) => { releaseRefresh = resolve })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 16 * 60_000)
    const first = fetch(base + '/api/summary')
    const second = fetch(base + '/api/session')
    await vi.waitFor(() => { expect(refreshes).toBe(1) })
    releaseRefresh?.()
    expect(await (await first).json()).toMatchObject({ ok: true })
    expect(await (await second).json()).toMatchObject({ ok: true, signedIn: true })
    expect(refreshes).toBe(1)
    const refresh = calls.find(call => call.path.endsWith('/auth/refresh'))
    expect(refresh?.origin).toBe(new URL(api).origin)
    expect(refresh?.cookie).toContain('new_api_refresh=refresh-one')
    expect(calls.filter(call => call.path.endsWith('/user/self')).every(call => call.authorization === 'Bearer access-renewed')).toBe(true)
  })

  it('rejects a different account instead of showing its quota or reading an admin cache', async () => {
    const { base } = await boot()
    await signIn(base)
    selfId = 8
    expect(await (await fetch(base + '/api/summary')).json()).toMatchObject({ ok: false, balance: null })
    expect(calls.some(call => /\/search|usage\/token/u.test(call.path))).toBe(false)
  })

  it('does not submit an order without valid live conversion parameters', async () => {
    const { base } = await boot()
    await signIn(base)
    quotaPerUnit = 0
    expect(await post(base, '/api/recharge/wechat', { amount: 1 })).toMatchObject({ ok: false })
    expect(creations).toBe(0)
  })

  it('does not restore a signed-out account when an earlier refresh completes', async () => {
    const { base } = await boot()
    await signIn(base)
    refreshBarrier = new Promise<void>((resolve) => { releaseRefresh = resolve })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 16 * 60_000)
    const pending = fetch(base + '/api/summary')
    try {
      await vi.waitFor(() => { expect(refreshes).toBe(1) })
      const signingOut = post(base, '/api/session/logout', {})
      await vi.waitFor(async () => { expect(await context?.credentials.resolve(relayRef)).toBeUndefined() })
      releaseRefresh?.()
      await signingOut
    } finally {
      releaseRefresh?.()
    }
    expect(object(await (await pending).json()).balance).toBeNull()
    expect(await (await fetch(base + '/api/session')).json()).toMatchObject({ signedIn: false })
    expect(await context?.credentials.resolve(relayRef)).toBeUndefined()
    expect(await chat()).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(calls.some(call => call.path.endsWith('/chat/completions'))).toBe(false)
  })
})
