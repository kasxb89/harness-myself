import { mkdir, mkdtemp, rm, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { buildModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import LlmRuntime, { createUserMessage, ReasoningEffortId, ToolCallId, type FinishReason } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Artifacts from '@deepseek-ai/dsh-artifacts-index'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Credits from '../src/index.ts'
import * as VideoProjectTools from '../src/video-project-tools.ts'
import { CreativeStore } from '../src/creative-store.ts'
import type { VideoProjectOptions } from '../src/video-project-types.ts'
import { prepareVideoProject, readVideoProject, runVideoProject } from '../src/video-project.ts'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { VideoEditor } from '../src/video-edit.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

const relayRef = credentialRef('HARNESS_INTEGRATION_RELAY')
let context: Context | undefined
let upstream: Server | undefined
let directory: string | undefined
const calls: { path: string; authorization?: string; origin?: string; cookie?: string; body: unknown }[] = []
const videoHeaders: { path: string; source: string | string[] | undefined; contentType: string | undefined }[] = []
let quotaPerUnit = 500_000
let exchangeRate = 7.3
let statusAvailable = true
let clientModelConfig: unknown
let balanceQuota = 68_493
let selfId = 7
let access = 'access-user'
let refreshes = 0
let refreshStatus = 200
let refreshRetryAfter: string | undefined
let creations = 0
let pricingRows: unknown[] = []
let videoTaskStatus: string | undefined
let videoResultUrl = 'https://ignored.invalid/content.mp4'
let videoRejection: unknown
let imageResponse: unknown
let imageTaskStatus: string | undefined
let imageTaskHttpStatus = 200
const internalUploadResponses: { status: number; body?: unknown; disconnect?: boolean }[] = []
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
  videoHeaders.length = 0
  quotaPerUnit = 500_000
  exchangeRate = 7.3
  statusAvailable = true
  clientModelConfig = undefined
  balanceQuota = 68_493
  selfId = 7
  access = 'access-user'
  refreshes = 0
  refreshStatus = 200
  refreshRetryAfter = undefined
  creations = 0
  pricingRows = []
  videoTaskStatus = undefined
  videoResultUrl = 'https://ignored.invalid/content.mp4'
  videoRejection = undefined
  imageResponse = undefined
  imageTaskStatus = undefined
  imageTaskHttpStatus = 200
  internalUploadResponses.length = 0
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
  defaultSelection?: { provider: string; model: string; followPolicy?: boolean },
  creditsConfig: Partial<Credits.Config> = {},
  profileName?: string,
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
      if (/^\/harness\/v1\/(?:video\/generations|videos)(?:\/|$)/u.test(url.pathname)) {
        videoHeaders.push({ path: url.pathname, source: request.headers['x-yunshu-client'], contentType: request.headers['content-type'] })
      } else expect(request.headers['x-yunshu-client']).toBeUndefined()
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
        answer({ quota_per_unit: quotaPerUnit, usd_exchange_rate: exchangeRate,
          ...clientModelConfig === undefined ? {} : { client_model_config: clientModelConfig } }); return
      }
      if (url.pathname === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: '+8613800000000', delivery_status: 'accepted',
          expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
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
        if (refreshStatus !== 200) {
          if (refreshRetryAfter !== undefined) response.setHeader('retry-after', refreshRetryAfter)
          response.writeHead(refreshStatus)
          response.end('')
          return
        }
        access = 'access-renewed'
        response.setHeader('set-cookie', 'new_api_refresh=refresh-two; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: access, access_expires_at: Math.floor(Date.now() / 1000) + 900, user: { id: 7 } }); return
      }
      if (url.pathname === '/harness/api/user/auth/logout') { answer(null); return }
      if (url.pathname === '/harness/api/client-activity/heartbeat') {
        answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 30, online_timeout_seconds: 90 }); return
      }
      if (url.pathname === '/harness/api/pricing') { answer(pricingRows); return }
      if (url.pathname === '/harness/v1/uploads/images') {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        const upload = internalUploadResponses.shift()
        if (upload?.disconnect === true) { response.destroy(); return }
        response.writeHead(upload?.status ?? 500)
        response.end(JSON.stringify(upload?.body ?? {})); return
      }
      if (url.pathname === '/harness/toapis/v1/images/generations') {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        if (imageResponse === 'disconnect') { response.destroy(); return }
        response.setHeader('X-Oneapi-Request-Id', 'fixture-image-request')
        response.end(JSON.stringify({ id: 'fixture-image-task' })); return
      }
      if (url.pathname === '/harness/toapis/v1/images/generations/fixture-image-task') {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        response.writeHead(imageTaskHttpStatus)
        response.end(JSON.stringify({ status: imageTaskStatus ?? 'succeeded', result: imageResponse })); return
      }
      if (url.pathname === '/harness/fixtures/image.png') {
        response.setHeader('content-type', 'image/png')
        response.end(Buffer.from('unexpected old-account download')); return
      }
      if ((url.pathname === '/harness/v1/images/generations' || url.pathname === '/harness/v1/images/edits') && imageResponse !== undefined) {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        if (imageResponse === 'disconnect') { response.destroy(); return }
        if (imageResponse !== null && typeof imageResponse === 'object' && 'error' in imageResponse) response.writeHead(403)
        response.end(JSON.stringify(imageResponse)); return
      }
      if (url.pathname === '/harness/v1/video/generations' || url.pathname === '/harness/v1/videos') {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        if (videoRejection !== undefined) { response.writeHead(403); response.end(JSON.stringify(videoRejection)); return }
        response.end(JSON.stringify(videoTaskStatus === undefined ? {} : { code: 'success', data: { task_id: 'fixture-video-task' } })); return
      }
      if (url.pathname === '/harness/v1/video/generations/fixture-video-task' || url.pathname === '/harness/v1/videos/fixture-video-task') {
        if (request.headers.authorization !== `Bearer ${relayKey}`) { response.writeHead(403); response.end('{}'); return }
        response.end(JSON.stringify({ code: 'success', data: { status: videoTaskStatus, result_url: videoResultUrl } })); return
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
    ['@deepseek-ai/dsh-agent-default-model', DefaultModel],
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
    ...defaultSelection === undefined ? [] : [{ name: '@deepseek-ai/dsh-agent-default-model', config: defaultSelection }],
    { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
      'yunshu-local': { api: 'openai-completions', baseURL: api + '/v1', apiKeyEnv: relayRef, models },
      'other-provider': { api: 'openai-completions', baseURL: 'https://synthetic.invalid/v1', models: [{ id: 'other-chat' }] },
    } } },
    ...managedOutput ? [{ name: '@deepseek-ai/dsh-artifacts-index', config: {
      defaultOutputDirectory: join(directory, 'selected-output'), stateDirectory: join(directory, 'artifact-settings'), roots: [join(stateDir, 'media')],
    } }] : [],
    { name: '@deepseek-ai/dsh-credits-index', config: { stateDir, newApiBaseUrl: api, relayTokenEnv: relayRef, ...creditsConfig } },
  ]
  const configuration = join(directory, 'cordis.yml')
  await writeFile(configuration, JSON.stringify(entries))
  await profileComposition(context, directory, configuration, profileName)
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

async function uploadImage(base: string, cookie: string, filename: string, bytes: Buffer): Promise<Record<string, unknown>> {
  const response = await fetch(base + '/api/assets', { method: 'POST', headers: {
    cookie, 'content-type': 'image/png', 'x-file-name': encodeURIComponent(filename), 'x-idempotency-key': Buffer.from(filename).toString('hex'),
  }, body: new Uint8Array(bytes) })
  const uploaded = object(await response.json())
  expect(uploaded.ok).toBe(true)
  return object(uploaded.asset)
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
  it('exposes safe platform-failure narration and unknown-outcome recovery on both native media tools', async () => {
    await boot()
    for (const name of ['generate_image', 'generate_video']) {
      const tool = context!.tools.schemas().find(tool => tool.name === name)
      expect(tool?.description).toContain('safe Simplified Chinese summary')
      expect(tool?.description).toContain('connection failures and timeouts do not establish whether the cause is local, network, platform or upstream')
      expect(tool?.description).toContain('unknown causes remain unconfirmed')
      expect(tool?.description).toContain('never repeat raw HTTP responses, diagnostic JSON, error codes, stacks, internal paths or credentials')
      expect(tool?.description).toContain('confirmed sign-in, product-credit, file-validation')
      expect(tool?.description).toContain('cancellation')
      expect(tool?.description).toContain('check existing tasks and artifacts first; do not immediately retry or automatically resubmit')
      expect(tool?.description).toContain('Preserve real tool results')
      expect(tool?.description).toContain('software or code diagnostics explicitly requested by the user')
      expect(tool?.description).toMatchSnapshot(name)
    }
    expect(calls.filter(call => /\/v1\/(?:images|video)\//.test(call.path))).toEqual([])
  })

  it('keeps three normalized image uploads, reports a corrupt middle file and serves only owned previews', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    const origin = new URL(base).origin
    await signIn(base)
    const sources = [
      { name: '同名.png', mediaType: 'image/jpeg', sourceFormat: 'png', contentType: 'image/png', width: 9, height: 7,
        bytes: await sharp({ create: { width: 9, height: 7, channels: 4, background: '#cc552280' } }).png().toBuffer() },
      { name: '手机照片.heic', mediaType: '', sourceFormat: 'heic', contentType: 'image/jpeg', width: 64, height: 32,
        bytes: await readFile(new URL('./fixtures/reference-normalization.heic', import.meta.url)) },
      { name: '同名.png', mediaType: 'video/ogg', sourceFormat: 'webp', contentType: 'image/jpeg', width: 11, height: 5,
        bytes: await sharp({ create: { width: 11, height: 5, channels: 3, background: '#2288cc' } }).webp().toBuffer() },
    ]
    const upload = async (name: string, mediaType: string, bytes: Buffer): Promise<Record<string, unknown>> => {
      const response = await fetch(base + '/api/assets', { method: 'POST', headers: {
        cookie, 'content-type': mediaType, 'x-file-name': encodeURIComponent(name),
        'x-idempotency-key': `dsh-asset-${globalThis.crypto.randomUUID()}`,
      }, body: new Uint8Array(bytes) })
      expect(response.status).toBe(200)
      return object(await response.json())
    }
    const retained: { id: string; previewUrl: string; bytes: Buffer }[] = []
    for (const [index, source] of sources.entries()) {
      if (index === 1) {
        const refused = await upload('损坏的照片.png', 'image/png', sources[0]!.bytes.subarray(0, 36))
        expect(refused).toMatchObject({ ok: false, code: 'IMAGE_DECODE_FAILED', filename: '损坏的照片.png' })
        expect(refused).not.toHaveProperty('asset')
      }
      const answer = await upload(source.name, source.mediaType, source.bytes)
      expect(answer.ok).toBe(true)
      const asset = object(answer.asset)
      expect(asset).toMatchObject({ kind: 'reference_image', originalName: source.name, sourceFormat: source.sourceFormat,
        contentType: source.contentType, firstFrameOnly: false, width: source.width, height: source.height })
      if (source.sourceFormat !== 'png') expect(asset.converted).toBe(true)
      if (typeof asset.assetId !== 'string' || typeof asset.filename !== 'string' || typeof asset.previewUrl !== 'string') {
        throw new Error('Expected the retained normalized image and preview')
      }
      expect(asset.previewUrl).toBe(`/credits/api/assets/preview?asset_id=${asset.assetId}`)
      const bytes = await readFile(join(stateDir, 'refs', asset.filename))
      expect(asset.sizeBytes).toBe(bytes.length)
      expect(await sharp(bytes).metadata()).toMatchObject({ format: source.contentType === 'image/png' ? 'png' : 'jpeg',
        width: source.width, height: source.height })
      expect(object(JSON.parse(await readFile(join(stateDir, 'refs', `${asset.filename}.json`), 'utf8')))).toMatchObject({
        originalName: source.name, mediaType: source.contentType, accountId: '7',
      })
      const preview = await fetch(origin + asset.previewUrl, { headers: { cookie } })
      expect(preview.status).toBe(200)
      expect(preview.headers.get('content-type')).toBe(source.contentType)
      expect(preview.headers.get('cache-control')).toBe('no-store')
      expect(preview.headers.get('x-content-type-options')).toBe('nosniff')
      expect(Buffer.from(await preview.arrayBuffer())).toEqual(bytes)
      retained.push({ id: asset.assetId, previewUrl: asset.previewUrl, bytes })
    }
    expect(new Set(retained.map(asset => asset.id)).size).toBe(3)
    expect(await readdir(join(stateDir, 'refs'))).toHaveLength(6)
    for (const asset of retained) {
      const preview = await fetch(origin + asset.previewUrl, { headers: { cookie } })
      expect(Buffer.from(await preview.arrayBuffer())).toEqual(asset.bytes)
      const head = await fetch(origin + asset.previewUrl, { method: 'HEAD', headers: { cookie } })
      expect(head.status).toBe(200)
      expect(head.headers.get('cache-control')).toBe('no-store')
      expect(head.headers.get('content-length')).toBe(String(asset.bytes.length))
      expect(await head.text()).toBe('')
      expect((await fetch(origin + asset.previewUrl)).status).toBe(401)
    }
    expect(calls.filter(call => call.path.includes('/v1/images/') || call.path.includes('/v1/media/')
      || call.path.includes('/v1/video/'))).toEqual([])
    await post(base, '/api/session/logout', {}, cookie)
    const signedOut = await fetch(origin + retained[0]!.previewUrl, { headers: { cookie } })
    expect(await signedOut.json()).toMatchObject({ ok: false, sessionInvalid: true })
    selfId = 8
    await signIn(base)
    const otherAccount = await fetch(origin + retained[0]!.previewUrl, { headers: { cookie } })
    expect(otherAccount.status).toBe(404)
    expect(await otherAccount.json()).toMatchObject({ ok: false, code: 'IMAGE_PREVIEW_UNAVAILABLE' })
  })

  it('preserves exact image user balance rejection while upstream channel quota stays generic', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    context!.sessions.create(SessionId('funding-image-chat'), { meta: { cwd: stateDir } })
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    for (const [upstreamCode, type, expected] of [
      ['insufficient_user_quota', 'new_api_error', 'INSUFFICIENT_BALANCE'],
      ['insufficient_quota', 'upstream_error', 'HTTP_403'],
    ]) {
      imageResponse = { error: { code: upstreamCode, type, message: 'channel balance exhausted' } }
      const before = calls.filter(call => call.path === '/harness/v1/images/generations').length
      const result = await post(base, '/api/image/generate', {
        session_id: 'funding-image-chat', account_id: '7', prompt: 'A cup', model: 'gpt-image-2',
      }, cookie)
      expect(result).toMatchObject({ ok: false, code: expected })
      if (expected === 'INSUFFICIENT_BALANCE') expect(result.message).toBe('余额不足，请充值')
      expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toHaveLength(before + 1)
    }
  })

  it.each(['panel', 'chat'] as const)('preserves exact single-video funding rejection through %s without resubmitting an unconfirmed plan', async (entry) => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    let sessionId = ''
    let agent = videoAgent(stateDir)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]
    const args = { prompt: 'A synthetic cup in sunlight', model: 'MiniMax-H3', duration_seconds: 4 }
    const execute = async (extra: object = {}) => object((await context!.tools.execute({ name: 'generate_video', arguments: { ...args, ...extra }, agent,
      callId: ToolCallId('funding-video'), signal: new AbortController().signal })).value)
    const listing = async () => projects(object(await (await fetch(base + `/api/creative/projects?session_id=${sessionId}`, { headers: { cookie } })).json()))
    for (const { body, expected } of [
      { body: { code: 'insufficient_user_quota', message: 'gateway funding rejection' }, expected: 'INSUFFICIENT_BALANCE' },
      { body: { error: { code: 'insufficient_quota', type: 'upstream_error', message: 'insufficient_user_quota' } }, expected: 'HTTP_403' },
      { body: { error: { code: 'permission_denied', type: 'new_api_error', message: 'insufficient_user_quota' } }, expected: 'HTTP_403' },
    ]) {
      sessionId = `funding-video-chat-${String(calls.length)}`
      context!.sessions.create(SessionId(sessionId), { meta: { cwd: stateDir } })
      agent = videoAgent(stateDir, sessionId)
      videoRejection = body
      const before = calls.filter(call => call.path === '/harness/v1/video/generations').length
      const existing = new Set((await listing()).map(project => project.id))
      const result = entry === 'chat' ? await execute() : await post(base, '/api/video/tasks?source=newapi-generate', {
        prompt: args.prompt, model: args.model, durationSeconds: 4, session_id: sessionId, account_id: '7',
      }, cookie)
      expect(result).toMatchObject(entry === 'chat' ? { status: expected === 'INSUFFICIENT_BALANCE' ? 'unknown' : 'failed', code: expected, task_id: '' } : { ok: false, code: expected, taskId: null })
      const project = (await listing()).find(item => !existing.has(item.id))
      if (project === undefined) throw new Error('Expected retained video project')
      expect(project).toMatchObject({ kind: 'video', status: expected === 'INSUFFICIENT_BALANCE' ? 'unknown' : 'failed',
        tasks: [{ status: expected === 'INSUFFICIENT_BALANCE' ? 'unknown' : 'failed', errorCode: expected === 'INSUFFICIENT_BALANCE' ? 'SUBMISSION_UNKNOWN' : expected }], outputs: [] })
      if (expected === 'INSUFFICIENT_BALANCE') {
        expect(result.message).toBe('余额不足，请充值；提交结果尚未确认，请先检查已有任务，不要重复提交。')
        expect(await execute({ plan_id: project.id, shot_id: 'shot_1' })).toMatchObject({ status: 'failed', code: 'CREATIVE_SUBMISSION_UNKNOWN' })
      }
      expect(calls.filter(call => call.path === '/harness/v1/video/generations')).toHaveLength(before + 1)
      expect(calls.some(call => call.path.startsWith('/harness/v1/video/generations/'))).toBe(false)
    }
  })

  it('sends normalized image bytes and matching multipart MIME types and extensions for image edits', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    context!.sessions.create(SessionId('normalized-edit-chat'), { meta: { cwd: stateDir } })
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    const sources = [
      { name: '手机照片.heic', bytes: await readFile(new URL('./fixtures/reference-normalization.heic', import.meta.url)) },
      { name: '参考.webp', bytes: await sharp({ create: { width: 8, height: 6, channels: 3, background: '#54b372' } }).webp().toBuffer() },
    ]
    const retained: { id: string; bytes: Buffer }[] = []
    for (const source of sources) {
      const uploaded = object(await (await fetch(base + '/api/assets', { method: 'POST', headers: {
        cookie, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(source.name),
        'x-idempotency-key': `dsh-asset-${globalThis.crypto.randomUUID()}`,
      }, body: source.bytes })).json())
      expect(uploaded.ok).toBe(true)
      const asset = object(uploaded.asset)
      if (typeof asset.assetId !== 'string' || typeof asset.filename !== 'string') throw new Error('Expected normalized image')
      retained.push({ id: asset.assetId, bytes: await readFile(join(stateDir, 'refs', asset.filename)) })
    }
    const generated = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#345678' } }).png().toBuffer()
    imageResponse = { data: [{ b64_json: generated.toString('base64') }] }
    const answer = await post(base, '/api/image/generate', { session_id: 'normalized-edit-chat', account_id: '7',
      prompt: '保留两张参考图的人物和场景', model: 'gpt-image-2', references: retained.map(asset => asset.id) }, cookie)
    expect(answer.ok).toBe(true)
    const edit = calls.find(call => call.path === '/harness/v1/images/edits')
    const encoded = object(edit?.body).multipart
    if (typeof encoded !== 'string') throw new Error('Expected multipart image edit')
    const multipart = Buffer.from(encoded, 'base64')
    const text = multipart.toString('utf8')
    expect(text.match(/name="image\[\]"/gu)).toHaveLength(2)
    expect(text.match(/Content-Type: image\/jpeg/gu)).toHaveLength(2)
    expect(text.match(/filename="[^"\r\n]+\.jpg"/gu)).toHaveLength(2)
    expect(text).not.toMatch(/filename="[^"\r\n]+\.(?:heic|webp)"/gu)
    for (const asset of retained) expect(multipart.includes(asset.bytes)).toBe(true)
    expect(calls.filter(call => call.path === '/harness/v1/images/edits')).toHaveLength(1)
    expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toEqual([])
  })

  it('shares panel images with chat plans, editable revisions, real outputs and authenticated reference thumbnails', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    const origin = new URL(base).origin
    await signIn(base)
    context!.sessions.create(SessionId('panel-chat'), { meta: { cwd: stateDir } })
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    const png = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#cc552280' } }).png().toBuffer()
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
        'x-idempotency-key': 'panel-reference' }, body: new Uint8Array(png),
    })).json())
    expect(upload.ok).toBe(true)
    const assetId = object(upload.asset).assetId
    if (typeof assetId !== 'string') throw new Error('Expected uploaded reference id')
    const referenceBytes = await readFile(join(stateDir, 'refs', `${assetId}.png`))
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
    expect(Buffer.from(await reference.arrayBuffer())).toEqual(referenceBytes)
    const head = await fetch(origin + referenceUrl, { method: 'HEAD', headers: { cookie } })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(referenceBytes.length))
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
      expect(record.operations).toMatchObject([{ status: 'unknown', outputs: [], submissionStarted: true }])
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
      expect(record.operations).toMatchObject([{ status: 'cancelled', outputs: [], submissionStarted: false }])
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

  it.each(['panel', 'chat'] as const)('uploads internal image references before the shared generation task through %s', async (entry) => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } }).png().toBuffer()
    imageResponse = { data: [{ b64_json: png.toString('base64') }] }
    const sources = [
      await uploadImage(base, cookie, '妈妈参考.png', png),
      await uploadImage(base, cookie, '孩子参考.jpg', await sharp(png).jpeg().toBuffer()),
    ]
    const urls = ['https://files.toapis.cn/uploads/first.png', 'https://files.toapis.com/uploads/second.jpg']
    internalUploadResponses.push(...sources.map((asset, index) => ({ status: 200, body: { success: true, data: {
      id: `upload_${String(index)}`, url: urls[index], mime_type: asset.contentType, size: asset.sizeBytes,
    } } })))
    const references = sources.map(asset => String(asset.assetId))
    const prompt = '保留妈妈和孩子的外貌，换成温暖的客厅'
    let saved: string
    if (entry === 'panel') {
      context!.sessions.create(SessionId('internal-image-chat'), { meta: { cwd: stateDir } })
      const result = await post(base, '/api/image/generate', {
        session_id: 'internal-image-chat', account_id: '7', model, prompt, references,
      }, cookie)
      expect(result).toMatchObject({ ok: true, mode: 'edit' })
      saved = String(object(result.payload).path)
    } else {
      const result = object((await context!.tools.execute({
        name: 'generate_image', arguments: { model, prompt, reference_images: references },
        agent: videoAgent(stateDir), callId: ToolCallId('internal-image'), signal: new AbortController().signal,
      })).value)
      expect(result).toMatchObject({ status: 'succeeded', model })
      saved = String(result.path)
    }
    expect(await readFile(saved)).toEqual(png)
    const requests = calls.filter(call => call.path.includes('/uploads/images') || call.path.includes('/toapis/'))
    expect(requests.map(call => call.path)).toEqual([
      '/harness/v1/uploads/images', '/harness/v1/uploads/images',
      '/harness/toapis/v1/images/generations', '/harness/toapis/v1/images/generations/fixture-image-task',
    ])
    expect(requests.every(call => call.authorization === 'Bearer sk-owned-relay')).toBe(true)
    for (const [index, request] of requests.slice(0, 2).entries()) {
      const multipart = Buffer.from(String(object(request.body).multipart), 'base64')
      expect(multipart.toString()).toContain('name="model"\r\n\r\nyunshu-internal-gpt-image-2')
      expect(multipart.toString()).toContain('name="file"; filename="reference.')
      expect(multipart.toString()).toContain(`Content-Type: ${String(sources[index]!.contentType)}`)
      expect(multipart.includes(await readFile(join(stateDir, 'refs', String(sources[index]!.filename))))).toBe(true)
    }
    expect(requests[2]!.body).toEqual({ model, prompt, n: 1, reference_images: urls })
    expect(calls.some(call => call.path === '/harness/v1/images/edits' || call.path === '/harness/v1/images/generations')).toBe(false)
    expect(internalUploadResponses).toEqual([])
  }, 15_000)

  it.each(['panel', 'tool'] as const)('rejects unsupported internal image controls and invalid counts through %s before upload or generation', async (entry) => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    const agent = videoAgent(stateDir, 'invalid-internal-image-controls')
    context!.sessions.create(SessionId(agent.id), { meta: { cwd: stateDir } })
    const generate = (extra: Record<string, unknown>) => entry === 'panel'
      ? post(base, '/api/image/generate', { session_id: agent.id, account_id: '7', model, prompt: 'Validate before billing',
        references: ['ma_missing'], ...extra }, cookie)
      : context!.tools.execute({ name: 'generate_image', arguments: { model, prompt: 'Validate before billing',
        reference_images: [], ...extra }, agent, callId: ToolCallId('invalid-internal-image'), signal: new AbortController().signal })
        .then(result => object(result.value))
    for (const size of entry === 'tool' ? ['1024x1024', '16:9'] : ['1024x1024', '16:9', null]) {
      expect(await generate({ size })).toMatchObject({ code: 'SIZE_NOT_SUPPORTED', submission_state: 'not-submitted' })
    }
    const unsupported = entry === 'tool' ? [] : [
      { quality: 'high' }, { background: 'transparent' }, { format: 'webp' },
      { compression: 75 }, { moderation: 'low' }, { seed: 42 }, { output_format: 'webp' }, { output_compression: 75 }, { aspect_ratio: '16:9' },
    ]
    for (const extra of unsupported) expect(await generate(extra)).toMatchObject({ code: 'PARAMETER_NOT_SUPPORTED', submission_state: 'not-submitted' })
    const counts = entry === 'tool' ? [1.5, Number.MAX_SAFE_INTEGER + 1, 0, 2] : [null, '2', 1.5, Number.MAX_SAFE_INTEGER + 1, 0, 2]
    for (const count of counts) {
      expect(await generate({ count })).toMatchObject({ code: 'COUNT_NOT_SUPPORTED', submission_state: 'not-submitted' })
    }
    expect(calls.filter(call => call.path.includes('/uploads/images') || call.path.includes('/toapis/')
      || call.path === '/harness/v1/images/generations' || call.path === '/harness/v1/images/edits')).toEqual([])
  })

  it.each((['panel', 'tool'] as const).flatMap(entry => ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21']
    .map(size => ({ entry, size }))))('forwards the published image ratio $size and every tier through $entry with references', async ({ entry, size }) => {
    const { base, stateDir } = await boot(undefined, false, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    const sizes = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21']
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'], parameters: { type: 'object', properties: {
      size: { type: 'string', enum: sizes, default: '1:1' }, resolution: { type: 'string', enum: ['1k', '2k', '4k'], default: '1k' },
    } } }]
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ccbbaa' } }).png().toBuffer()
    imageResponse = { data: [{ b64_json: png.toString('base64') }] }
    const asset = await uploadImage(base, cookie, 'live-ratio-reference.png', png)
    const agent = videoAgent(stateDir, 'image-ratio-chat')
    context!.sessions.create(SessionId(agent.id), { meta: { cwd: stateDir } })
    const referenceUrl = 'https://files.toapis.cn/uploads/live-ratio-reference.png'
    for (const resolution of ['1k', '2k', '4k']) {
      internalUploadResponses.push({ status: 200, body: { success: true, data: {
        id: 'ratio_reference', url: referenceUrl, mime_type: asset.contentType, size: asset.sizeBytes,
      } } })
      const answer = entry === 'panel'
        ? await post(base, '/api/image/generate', { session_id: agent.id, account_id: '7', model, prompt: 'Exact published image settings',
          size, resolution, references: [String(asset.assetId)] }, cookie)
        : object((await context!.tools.execute({ name: 'generate_image', arguments: { model, prompt: 'Exact published image settings',
          size, resolution, reference_images: [String(asset.assetId)] }, agent, callId: ToolCallId('live-image-ratio'),
        signal: new AbortController().signal })).value)
      expect(answer).toMatchObject(entry === 'panel' ? { ok: true } : { status: 'succeeded' })
      expect(calls.filter(call => call.path === '/harness/toapis/v1/images/generations').at(-1)?.body).toEqual({
        model, prompt: 'Exact published image settings', n: 1, size, resolution, reference_images: [referenceUrl],
      })
    }
    expect(calls.filter(call => call.path === '/harness/toapis/v1/images/generations')).toHaveLength(3)
  })

  it.each([['panel', '1k'], ['tool', '2k'], ['panel', '4K']] as const)('preserves references with the named internal image tier through %s at %s', async (entry, resolution) => {
    const { base, stateDir } = await boot(undefined, false, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation', 'openai'], enable_groups: ['default', 'product'],
      billing_usage_schema: { image_count: { type: 'number' }, resolution: { enum: ['1k', '2k', '4k'] } },
    }]
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } }).png().toBuffer()
    imageResponse = { data: [{ b64_json: png.toString('base64') }] }
    const asset = await uploadImage(base, cookie, 'tier-reference.png', png)
    const url = 'https://files.toapis.cn/uploads/tier-reference.png'
    internalUploadResponses.push({ status: 200, body: { success: true, data: {
      id: 'upload_tier', url, mime_type: asset.contentType, size: asset.sizeBytes,
    } } })
    const references = [String(asset.assetId)]
    const agent = videoAgent(stateDir, 'image-tier-chat')
    context!.sessions.create(SessionId(agent.id), { meta: { cwd: stateDir } })
    const generate = (tier: unknown) => entry === 'panel'
      ? post(base, '/api/image/generate', { session_id: agent.id, account_id: '7', model,
        prompt: '按参考图创作', references, resolution: tier }, cookie)
      : context!.tools.execute({ name: 'generate_image', arguments: { model, prompt: '按参考图创作', reference_images: references, resolution: tier },
        agent, callId: ToolCallId('image-tier'), signal: new AbortController().signal }).then(result => object(result.value))
    expect(await generate(resolution)).toMatchObject(entry === 'panel' ? { ok: true } : { status: 'succeeded' })
    expect(calls.find(call => call.path === '/harness/toapis/v1/images/generations')?.body)
      .toEqual({ model, prompt: '按参考图创作', n: 1, resolution: resolution.toLowerCase(), reference_images: [url] })
    const dispatches = calls.filter(call => call.path.includes('/uploads/images') || call.path.includes('/toapis/')).length
    expect(await generate('1080p')).toMatchObject({ code: 'RESOLUTION_NOT_SUPPORTED' })
    expect(calls.filter(call => call.path.includes('/uploads/images') || call.path.includes('/toapis/'))).toHaveLength(dispatches)
  })

  it.each(['panel', 'tool'] as const)('retains accepted image identity after local cancellation and resumes through %s using GET only', async (entry) => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } }).png().toBuffer()
    imageResponse = { data: [{ b64_json: png.toString('base64') }] }
    const agent = videoAgent(stateDir)
    const abort = new AbortController()
    upstreamGate = async (path) => { if (path.endsWith('/fixture-image-task')) abort.abort() }
    await context!.tools.execute({ name: 'generate_image', arguments: { model, prompt: '保留原任务' },
      agent, callId: ToolCallId('accepted-before-cancel'), signal: abort.signal })
    const listing = async () => projects(object(await (await fetch(base + '/api/creative/projects?session_id=reference-audio-chat', { headers: { cookie } })).json()))
    expect(await listing()).toMatchObject([{ status: 'unknown', tasks: [{ status: 'unknown', canQuery: true,
      imageReceipt: { taskId: 'fixture-image-task', requestId: 'fixture-image-request', phase: 'accepted' } }] }])
    const retained = (await listing())[0]!
    if (!Array.isArray(retained.tasks)) throw new Error('Expected retained task records')
    const result = { plan_id: String(retained.id), operation_id: String(object(retained.tasks[0]).id) }
    const submission = calls.filter(call => call.path === '/harness/toapis/v1/images/generations')
    expect(submission).toHaveLength(1)
    expect(object((await context!.tools.execute({ name: 'generate_image', arguments: { model, prompt: '再次生成', plan_id: result.plan_id, shot_id: 'shot_1' },
      agent, callId: ToolCallId('blocked-paid-retry'), signal: new AbortController().signal })).value))
      .toMatchObject({ status: 'failed', code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    upstreamGate = undefined
    const args = { plan_id: result.plan_id, operation_id: result.operation_id }
    if (entry === 'tool') {
      expect(object((await context!.tools.execute({ name: 'query_image_task', arguments: args,
        agent, callId: ToolCallId('query-original-image'), signal: new AbortController().signal })).value))
        .toMatchObject({ status: 'succeeded', task_id: 'fixture-image-task', request_id: 'fixture-image-request' })
    } else {
      const response = await fetch(base + '/api/creative/image/recover', { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: agent.id, project_id: args.plan_id, operation_id: args.operation_id }) })
      expect(response.status).toBe(202)
      expect(object(await response.json()).ok).toBe(true)
    }
    await vi.waitFor(async () => { expect(await listing()).toMatchObject([{ status: 'completed', tasks: [{ status: 'completed', canQuery: false }], outputs: [{ kind: 'image' }] }]) })
    expect(calls.filter(call => call.path === '/harness/toapis/v1/images/generations')).toHaveLength(1)
    expect(calls.filter(call => call.path.endsWith('/fixture-image-task')).length).toBeGreaterThanOrEqual(2)
    expect(context!.tools.schemas().find(tool => tool.name === 'query_image_task')).toMatchSnapshot('GET-only retained image query tool')
  })

  it('atomically retains an accepted image receipt after its first persistence callback fails and recovers with GET only', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } }).png().toBuffer()
    imageResponse = { data: [{ b64_json: png.toString('base64') }] }
    // oxlint-disable-next-line typescript/unbound-method -- the spy invokes the original implementation with each store receiver.
    const receipt = CreativeStore.prototype.receipt
    let interrupted = false
    vi.spyOn(CreativeStore.prototype, 'receipt').mockImplementation(function (this: CreativeStore, operation, received) {
      if (received.phase === 'accepted' && !interrupted) {
        interrupted = true
        return Promise.reject(new Error('private transient receipt write failure'))
      }
      return receipt.call(this, operation, received)
    })
    const agent = videoAgent(stateDir)
    const submitted = object((await context!.tools.execute({ name: 'generate_image', arguments: { model, prompt: '保留首次受理回执' },
      agent, callId: ToolCallId('interrupted-receipt-write'), signal: new AbortController().signal })).value)
    expect(submitted).toMatchObject({ status: 'pending', submission_state: 'pending', code: 'IMAGE_RECEIPT_UNAVAILABLE',
      task_id: 'fixture-image-task', request_id: 'fixture-image-request' })
    expect(interrupted).toBe(true)
    expect(calls.filter(call => call.path.endsWith('/fixture-image-task'))).toEqual([])
    const record = object(JSON.parse(await readFile(join(stateDir, 'creative-projects', String(submitted.plan_id), 'project.json'), 'utf8')))
    expect(record.operations).toMatchObject([{ id: submitted.operation_id, status: 'unknown',
      imageReceipt: { phase: 'accepted', taskId: 'fixture-image-task', requestId: 'fixture-image-request' } }])
    const [retained] = projects(object(await (await fetch(base + '/api/creative/projects?session_id=reference-audio-chat', { headers: { cookie } })).json()))
    expect(retained).toMatchObject({ tasks: [{ canQuery: true, imageReceipt: { taskId: 'fixture-image-task' } }] })
    const discover = async (args: object, owner = agent) => object((await context!.tools.execute({ name: 'query_image_task', arguments: args,
      agent: owner, callId: ToolCallId('discover-retained-image'), signal: new AbortController().signal })).value)
    expect(await discover({})).toMatchObject({ status: 'listed', tasks: [{ plan_id: submitted.plan_id,
      operation_id: submitted.operation_id, status: 'unknown', can_query: true,
      task_id: 'fixture-image-task', request_id: 'fixture-image-request' }] })
    expect(await discover({}, videoAgent(stateDir, 'other-image-chat'))).toMatchObject({ status: 'listed', tasks: [] })
    expect(await discover({ plan_id: 'unrelated-plan' })).toMatchObject({ status: 'listed', tasks: [] })
    expect(await discover({ operation_id: submitted.operation_id })).toMatchObject({ status: 'failed', code: 'CREATIVE_INVALID' })
    expect(calls.filter(call => call.path.endsWith('/fixture-image-task'))).toEqual([])
    const recovered = object((await context!.tools.execute({ name: 'query_image_task', arguments: {
      plan_id: submitted.plan_id, operation_id: submitted.operation_id,
    }, agent, callId: ToolCallId('recover-interrupted-receipt-write'), signal: new AbortController().signal })).value)
    expect(recovered).toMatchObject({ status: 'succeeded', plan_id: submitted.plan_id, operation_id: submitted.operation_id,
      task_id: 'fixture-image-task', request_id: 'fixture-image-request' })
    expect(await readFile(String(recovered.path))).toEqual(png)
    expect(calls.filter(call => call.path === '/harness/toapis/v1/images/generations')).toHaveLength(1)
    expect(calls.filter(call => call.path.endsWith('/fixture-image-task'))).toHaveLength(1)
  })

  it.each(['running', 'succeeded'])('stops original image reads and saving after logout during %s and later recovers the same account task without another POST', async (status) => {
    const { base, api, stateDir } = await boot(undefined, true, true, undefined, { imagePollIntervalMs: 1, imageQueryRetryLimit: 0 })
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    const agent = videoAgent(stateDir)
    const abort = new AbortController()
    upstreamGate = async (path) => { if (path.endsWith('/fixture-image-task')) abort.abort() }
    await context!.tools.execute({ name: 'generate_image', arguments: { model, prompt: '原账户的图片' },
      agent, callId: ToolCallId('image-before-logout'), signal: abort.signal })
    const [retained] = projects(object(await (await fetch(base + '/api/creative/projects?session_id=reference-audio-chat', { headers: { cookie } })).json()))
    expect(retained).toMatchObject({ status: 'unknown', tasks: [{ imageReceipt: { taskId: 'fixture-image-task' } }] })
    if (!Array.isArray(retained!.tasks)) throw new Error('Expected original image task')
    const submitted = { plan_id: retained!.id, operation_id: object(retained!.tasks[0]).id }
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    releaseUpstreamGate = () => { release.resolve(undefined) }
    upstreamGate = async (path) => {
      if (!path.endsWith('/fixture-image-task')) return
      entered.resolve(undefined)
      await release.promise
    }
    imageTaskStatus = status
    imageResponse = status === 'succeeded' ? { data: [{ url: api + '/fixtures/image.png' }] } : undefined
    const storage = context!.get('artifactStorage')
    if (storage === undefined) throw new Error('Expected managed image output')
    const writes = vi.spyOn(storage, 'write')
    const args = { plan_id: submitted.plan_id, operation_id: submitted.operation_id }
    const recovering = context!.tools.execute({ name: 'query_image_task', arguments: args, agent,
      callId: ToolCallId('query-during-account-switch'), signal: new AbortController().signal })
    try {
      await entered.promise
      await post(base, '/api/session/logout', {})
      selfId = 8; access = 'access-second-account'; relayKey = 'sk-second-account-relay'
      await signIn(base)
      release.resolve(undefined)
      expect(object((await recovering).value)).toMatchObject({ status: 'failed', code: 'CREATIVE_ACCOUNT_CHANGED' })
      expect(calls.filter(call => call.path.endsWith('/fixture-image-task'))).toHaveLength(2)
      expect(calls.filter(call => call.path.endsWith('/fixtures/image.png'))).toEqual([])
      expect(writes).not.toHaveBeenCalled()
      const record = object(JSON.parse(await readFile(join(stateDir, 'creative-projects', String(submitted.plan_id), 'project.json'), 'utf8')))
      expect(record.owner).toMatchObject({ accountId: '7' })
      expect(record.operations).toMatchObject([{ outputs: [], imageReceipt: {
        phase: 'accepted', taskId: 'fixture-image-task', requestId: 'fixture-image-request',
      } }])
      expect(projects(object(await (await fetch(base + '/api/creative/projects?session_id=reference-audio-chat', { headers: { cookie } })).json()))).toEqual([])
      await post(base, '/api/session/logout', {})
      selfId = 7; access = 'access-returned-account'; relayKey = 'sk-owned-relay'
      await signIn(base)
      upstreamGate = undefined
      imageTaskStatus = 'succeeded'
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } }).png().toBuffer()
      imageResponse = { data: [{ b64_json: png.toString('base64') }] }
      const recovered = object((await context!.tools.execute({ name: 'query_image_task', arguments: args, agent,
        callId: ToolCallId('query-after-original-account-returned'), signal: new AbortController().signal })).value)
      expect(recovered).toMatchObject({ status: 'succeeded', plan_id: submitted.plan_id, operation_id: submitted.operation_id })
      expect(await readFile(String(recovered.path))).toEqual(png)
      expect(writes).toHaveBeenCalledOnce()
      expect(calls.filter(call => call.path === '/harness/toapis/v1/images/generations')).toHaveLength(1)
      expect(calls.filter(call => call.path.endsWith('/fixture-image-task'))).toHaveLength(3)
    } finally { release.resolve(undefined); await recovering }
  })

  it('rejects a delayed original-image recovery listing after the account changes instead of returning old project data', async () => {
    const { base, stateDir } = await boot(undefined, true, true, undefined, { imagePollIntervalMs: 1, imageQueryRetryLimit: 0 })
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    const agent = videoAgent(stateDir)
    const abort = new AbortController()
    upstreamGate = async (path) => { if (path.endsWith('/fixture-image-task')) abort.abort() }
    await context!.tools.execute({ name: 'generate_image', arguments: { model, prompt: '旧账号私有项目' },
      agent, callId: ToolCallId('private-image-before-listing'), signal: abort.signal })
    const [retained] = projects(object(await (await fetch(base + '/api/creative/projects?session_id=reference-audio-chat', { headers: { cookie } })).json()))
    if (!Array.isArray(retained!.tasks)) throw new Error('Expected original image task')
    const submitted = { plan_id: retained!.id, operation_id: object(retained!.tasks[0]).id }
    imageTaskStatus = 'running'
    upstreamGate = undefined
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    releaseUpstreamGate = () => { release.resolve(undefined) }
    // oxlint-disable-next-line typescript/unbound-method -- the spy invokes the original implementation with each store receiver.
    const list = CreativeStore.prototype.projects
    vi.spyOn(CreativeStore.prototype, 'projects').mockImplementationOnce(async function (this: CreativeStore, owner) {
      const retained = await list.call(this, owner)
      expect(retained).toMatchObject([{ id: submitted.plan_id }])
      entered.resolve(undefined)
      await release.promise
      return retained
    })
    const recovering = fetch(base + '/api/creative/image/recover', { method: 'POST',
      headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({
        session_id: agent.id, project_id: submitted.plan_id, operation_id: submitted.operation_id,
      }) })
    try {
      await entered.promise
      await post(base, '/api/session/logout', {})
      selfId = 8; access = 'access-second-account'; relayKey = 'sk-second-account-relay'
      await signIn(base)
      release.resolve(undefined)
      const response = await recovering
      expect(response.status).toBe(409)
      const answer: unknown = await response.json()
      expect(answer).toMatchObject({ ok: false, code: 'CREATIVE_ACCOUNT_CHANGED' })
      expect(object(answer).payload).toBeUndefined()
      expect(JSON.stringify(answer)).not.toContain(String(submitted.plan_id))
      expect(JSON.stringify(answer)).not.toContain('旧账号私有项目')
      expect(JSON.stringify(answer)).not.toContain('fixture-image-task')
      expect(calls.filter(call => call.path === '/harness/toapis/v1/images/generations')).toHaveLength(1)
    } finally { release.resolve(undefined); await recovering }
  })

  it.each(['pending', 'unknown'] as const)('keeps the panel original %s image lock after fresh listings and refuses a new paid plan', async (state) => {
    const { base, stateDir } = await boot(undefined, true, true, undefined, { imagePollIntervalMs: 1, imageQueryRetryLimit: 0 })
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    context!.sessions.create(SessionId('uncertain-panel-image'), { meta: { cwd: stateDir } })
    imageResponse = state === 'unknown' ? 'disconnect' : undefined
    imageTaskHttpStatus = 503
    const body = { session_id: 'uncertain-panel-image', account_id: '7', model, prompt: '一次付费的原始图片' }
    const submitted = await post(base, '/api/image/generate', body, cookie)
    expect(submitted).toMatchObject({ ok: false, submission_state: state,
      task_id: state === 'pending' ? 'fixture-image-task' : null,
      request_id: state === 'pending' ? 'fixture-image-request' : null })
    expect(submitted.plan_id).toBeTypeOf('string')
    expect(submitted.operation_id).toBeTypeOf('string')
    for (const prompt of [body.prompt, '刷新后不应产生第二次付费']) {
      const listed = projects(object(await (await fetch(base + '/api/creative/projects?session_id=uncertain-panel-image', { headers: { cookie } })).json()))
      expect(listed).toMatchObject([{ id: submitted.plan_id, status: 'unknown', tasks: [{ id: submitted.operation_id, status: 'unknown' }] }])
      expect(listed).toHaveLength(1)
      expect(await post(base, '/api/image/generate', { ...body, prompt }, cookie)).toMatchObject({
        ok: false, code: 'CREATIVE_SUBMISSION_UNKNOWN', submission_state: state,
        plan_id: submitted.plan_id, operation_id: submitted.operation_id,
        task_id: submitted.task_id, request_id: submitted.request_id,
      })
    }
    expect(await readdir(join(stateDir, 'creative-projects'))).toEqual([submitted.plan_id])
    expect(calls.filter(call => call.path === '/harness/toapis/v1/images/generations')).toHaveLength(1)
  })

  it('names an internal reference upload failure, rejects unsafe receipts and never submits or retries generation', async () => {
    const { base } = await boot(undefined, false, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#aabbcc' } }).png().toBuffer()
    const asset = await uploadImage(base, cookie, '妈妈参考.png', png)
    const data = { id: 'upload_one', url: 'https://files.toapis.cn/uploads/verified.png', mime_type: asset.contentType, size: asset.sizeBytes }
    const attempts = [
      ...[401, 403, 413, 415, 429, 502, 504].map(status => ({ status, body: { error: { message: 'secret upstream diagnostic' } } })),
      { status: 200, disconnect: true },
      { status: 200, body: { success: false, data } },
      { status: 200, body: { success: true, data: { ...data, url: 'http://files.toapis.cn/uploads/unsafe.png' } } },
      { status: 200, body: { success: true, data: { ...data, url: 'https://user:password@files.toapis.cn/uploads/unsafe.png' } } },
      { status: 200, body: { success: true, data: { ...data, url: 'https://example.test/uploads/unsafe.png' } } },
      { status: 200, body: { success: true, data: { ...data, url: 'https://files.toapis.cn/other/unsafe.png' } } },
      { status: 200, body: { success: true, data: { ...data, url: `${data.url}?secret=value` } } },
      { status: 200, body: { success: true, data: { ...data, url: `${data.url}#fragment` } } },
      { status: 200, body: { success: true, data: { ...data, url: `${data.url}?` } } },
      { status: 200, body: { success: true, data: { ...data, url: `${data.url}#` } } },
      { status: 200, body: { success: true, data: { ...data, id: '' } } },
      { status: 200, body: { success: true, data: { ...data, mime_type: 'image/webp' } } },
      { status: 200, body: { success: true, data: { ...data, size: 0 } } },
    ]
    for (const attempt of attempts) {
      internalUploadResponses.push(attempt)
      const before = calls.filter(call => call.path === '/harness/v1/uploads/images').length
      const result = await post(base, '/api/image/generate', { model, prompt: '修改这张图', references: [asset.assetId] }, cookie)
      expect(result).toMatchObject({ ok: false })
      expect(result.code).toMatch(/^IMAGE_REFERENCE_UPLOAD_(?:FAILED|INVALID)$/u)
      expect(result.message).toContain('妈妈参考.png')
      expect(result.message).toContain('尚未提交生成')
      expect(JSON.stringify(result)).not.toMatch(/secret upstream|password|verified\.png/u)
      expect(calls.filter(call => call.path === '/harness/v1/uploads/images')).toHaveLength(before + 1)
      expect(internalUploadResponses).toEqual([])
    }
    expect(calls.some(call => call.path.includes('/toapis/') || call.path.includes('/v1/images/'))).toBe(false)
  }, 15_000)

  it.each([
    [408, '上传等待响应超时，原因尚未确认，请稍后重试'],
    [504, '上传等待响应超时，原因尚未确认，请稍后重试'],
    [500, '上传服务暂时不可用，请稍后重试'],
    [503, '上传服务暂时不可用，请稍后重试'],
    [404, '上传未完成，原因尚未确认，请稍后重试'],
    [422, '上传未完成，原因尚未确认，请稍后重试'],
  ] as const)('classifies internal reference upload HTTP %s without submitting generation', async (status, reason) => {
    const { base } = await boot(undefined, false, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#aabbcc' } }).png().toBuffer()
    const asset = await uploadImage(base, cookie, '妈妈参考.png', png)
    internalUploadResponses.push({ status, body: { error: { message: 'private upstream diagnostic' } } })
    const result = await post(base, '/api/image/generate', { model, prompt: '修改这张图', references: [asset.assetId] }, cookie)
    expect(result).toMatchObject({
      ok: false, code: 'IMAGE_REFERENCE_UPLOAD_FAILED', submission_state: 'not-submitted',
      message: `参考图「妈妈参考.png」${reason}；尚未提交生成。`,
    })
    expect(calls.filter(call => call.path === '/harness/v1/uploads/images')).toHaveLength(1)
    expect(calls.filter(call => call.path.includes('/toapis/') || call.path.includes('/v1/images/'))).toEqual([])
    expect(creations).toBe(0)
    expect(JSON.stringify(result)).not.toContain('private upstream diagnostic')
    expect(JSON.stringify(result)).not.toContain('服务器繁忙')
  })

  it('validates all internal reference files before uploading any bytes', async () => {
    const { base, stateDir } = await boot(undefined, false, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'yunshu-internal-gpt-image-2'
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#aabbcc' } }).png().toBuffer()
    const valid = await uploadImage(base, cookie, '有效.png', png)
    const invalid = await uploadImage(base, cookie, '第二张.png', png)
    const path = join(stateDir, 'refs', String(invalid.filename))
    for (const [bytes, mediaType, accountId] of [
      [Buffer.from('not an image'), 'image/png', '7'],
      [Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]), 'image/png', '7'],
      [png, 'image/jpeg', '7'],
      [png, 'image/png', '8'],
    ] as const) {
      await writeFile(path, bytes)
      await writeFile(`${path}.json`, JSON.stringify({ mediaType, originalName: '第二张.png', accountId }))
      const result = await post(base, '/api/image/generate', { model, prompt: '修改图片', references: [valid.assetId, invalid.assetId] }, cookie)
      expect(result).toMatchObject({ ok: false, code: 'IMAGE_REFERENCE_INVALID' })
      expect(result.message).toContain('第二张.png')
    }
    expect(await post(base, '/api/image/generate', { model, prompt: '修改图片', references: Array.from({ length: 7 }, () => valid.assetId) }, cookie))
      .toMatchObject({ ok: false, code: 'REFERENCES_NOT_SUPPORTED' })
    expect(await post(base, '/api/image/generate', { model, prompt: '修改图片', references: ['https://example.test/private.png'] }, cookie))
      .toMatchObject({ ok: false, code: 'IMAGE_REFERENCE_INVALID' })
    expect(calls.some(call => call.path.includes('/uploads/images') || call.path.includes('/toapis/') || call.path.includes('/v1/images/'))).toBe(false)
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
    relayModels.push({ id: 'wanx2.1-t2i-turbo', object: 'model', supported_endpoint_types: ['image-generation'] })
    pricingRows.push({ model_name: 'wanx2.1-t2i-turbo', supported_endpoint_types: ['image-generation'] })
    const unsupported = await call('valid.png', 'wanx2.1-t2i-turbo')
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
    expect(await call('generate_image', args)).toMatchObject({ status: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', submission_state: 'unknown' })
    const count = calls.filter(call => call.path.includes('/v1/images/')).length
    expect(await call('generate_image', args)).toMatchObject({ status: 'failed', code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    expect(calls.filter(call => call.path.includes('/v1/images/'))).toHaveLength(count)
    expect(await listing()).toMatchObject({ status: 'unknown',
      assets: [{ id: 'portrait', status: 'unknown', outputs: [{ kind: 'image' }, { kind: 'image' }] }, { id: 'voice' }],
      shots: [{ id: 'scene', status: 'planned', outputs: [] }], outputs: [{ kind: 'image' }, { kind: 'image' }],
    })
  })

  it('preserves native media failure codes and records missing task ids as unconfirmed without resubmission', async () => {
    const { base, stateDir } = await boot(undefined, false, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    pricingRows = [
      { model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
      { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] },
    ]
    const agent = videoAgent(stateDir)
    const call = async (name: string, args: object) => object((await context!.tools.execute({ name, arguments: args, agent,
      callId: ToolCallId('receipt-' + name), signal: new AbortController().signal })).value)
    imageResponse = 'disconnect'
    expect(await call('generate_image', { prompt: '图片', model: 'gpt-image-2' })).toMatchObject({ status: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', submission_state: 'unknown' })
    const videoArgs = { prompt: '视频', model: 'MiniMax-H3', duration_seconds: 4 }
    const video = await call('generate_video', videoArgs)
    expect(video).toMatchObject({ status: 'unknown', code: 'NO_TASK_ID', model: 'MiniMax-H3', task_id: '' })
    expect(context!.tools.get('generate_video')).toMatchObject({
      output: { schema: { properties: { code: { type: 'string' } } } },
    })
    const listed = projects(object(await (await fetch(base + '/api/creative/projects?session_id=reference-audio-chat', { headers: { cookie } })).json()))
    expect(listed.find(project => project.id === video.plan_id)).toMatchObject({ status: 'unknown', tasks: [{ status: 'unknown', errorCode: 'SUBMISSION_UNKNOWN' }] })
    expect(await call('generate_video', { ...videoArgs, plan_id: video.plan_id, shot_id: 'shot_1' }))
      .toMatchObject({ status: 'failed', code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    expect(await call('generate_video', { ...videoArgs, duration_seconds: 0 }))
      .toMatchObject({ status: 'failed', code: 'DURATION_NOT_SUPPORTED' })
    expect(calls.filter(call => call.path === '/harness/v1/video/generations')).toHaveLength(1)

    imageResponse = { data: [{ b64_json: Buffer.from('saved image').toString('base64') }] }
    vi.spyOn(CreativeStore.prototype, 'finish').mockRejectedValueOnce(new Error('private finish diagnostic'))
    const unconfirmed = await call('generate_image', { prompt: '保留生成结果', model: 'gpt-image-2' })
    expect(unconfirmed).toMatchObject({ status: 'failed', code: 'CREATIVE_OUTCOME_UNKNOWN' })
    expect(JSON.stringify(unconfirmed)).not.toContain('private finish diagnostic')
    const submissions = calls.filter(call => call.path === '/harness/v1/images/generations').length
    vi.spyOn(CreativeStore.prototype, 'begin').mockRejectedValueOnce(new Error('private preflight diagnostic'))
    const refused = await call('generate_image', { prompt: '尚未开始', model: 'gpt-image-2' })
    expect(refused).toMatchObject({ status: 'failed', code: 'CREATIVE_OPERATION_UNAVAILABLE' })
    expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toHaveLength(submissions)
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

  it('lists saved images, every long-video clip and the final file in the artifact library, and recovers historical clips without billing', async () => {
    let projectOptions: VideoProjectOptions | undefined
    const register = VideoProjectTools.registerVideoProjectTools
    vi.spyOn(VideoProjectTools, 'registerVideoProjectTools').mockImplementation((ctx, options) => {
      projectOptions = options; register(ctx, options)
    })
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    const origin = new URL(base).origin
    await signIn(base)
    if (projectOptions?.creative === undefined) throw new Error('Expected the real Loader creation store')
    const options = projectOptions
    const creative = projectOptions.creative
    const agent = videoAgent(stateDir, 'library-video-chat')
    const signal = new AbortController().signal
    const bound = await options.acquireProvider(stateDir, agent.session)
    let submitted = 0
    let failSecond = false
    const provider = {
      ...bound, model: async () => ({ id: 'MiniMax-H3', durations: [15] }),
      build: async (_input: unknown, model: string, prompt: string, durationSeconds: number) => ({ model, prompt, durationSeconds }),
      submit: async () => ({ taskId: `task-${String(++submitted)}` }),
      check: async (id: string) => ({ status: failSecond && id.endsWith('2') ? 'failed' as const : 'succeeded' as const }),
      download: async (_id: string, _request: unknown, path: string) => { await writeFile(path, generatedVideo) },
    }
    const editor: VideoEditor = {
      preflight: async () => {}, probe: async () => ({ durationSeconds: 15 }),
      compose: async (request) => {
        await mkdir(dirname(request.outputPath), { recursive: true })
        await writeFile(request.outputPath, generatedVideo)
        return { path: request.outputPath, durationSeconds: 30 }
      },
    }
    const owner = { ...provider.identity, sessionId: agent.session.id, workspaceRoot: stateDir }
    const generate = async () => {
      submitted = 0
      const manifest = await prepareVideoProject(options, { prompt: '人物在站台交谈', totalDurationSeconds: 30 },
        owner.sessionId, stateDir, provider, editor, signal)
      const operation = await creative.begin(owner, { kind: 'video', prompt: '人物在站台交谈', videoProjectId: manifest.id,
        shots: manifest.segments.map(segment => ({ prompt: segment.prompt, durationSeconds: segment.durationSeconds })) })
      const outcome = await runVideoProject(options, manifest, provider, editor,
        { id: JobId('fixture-library-video'), append: () => {}, updateProgress: () => {} }, signal)
      creative.release(operation)
      return { manifest, outcome }
    }
    const readLibrary = async () => {
      const response = await fetch(origin + '/artifacts/api/list', { headers: { cookie } })
      expect(response.status).toBe(200)
      const values = object(await response.json()).items
      if (!Array.isArray(values)) throw new Error('Expected actual artifact listing')
      return values.map(object)
    }
    pricingRows = [{ model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }]
    imageResponse = { data: [{ b64_json: Buffer.from('library generated image').toString('base64') }] }
    const image = object((await context!.tools.execute({ callId: ToolCallId('library-image'), name: 'generate_image',
      arguments: { prompt: '人物参考图', model: 'gpt-image-2' }, agent, signal })).value)
    const completed = await generate()
    expect(completed.outcome.status).toBe('completed')
    const expected = [image.path, ...completed.manifest.segments.map(segment => segment.publishedPath), completed.manifest.finalPath]
    expect((await readLibrary()).map(item => item.path)).toEqual(expect.arrayContaining(expected))
    expect((await readLibrary()).some(item => String(item.path).includes('/video-projects/'))).toBe(false)
    failSecond = true
    const partial = await generate()
    expect(partial.outcome.status).toBe('failed')
    expect(submitted).toBe(2)
    expect((await readLibrary()).map(item => item.path)).toContain(partial.manifest.segments[0]?.publishedPath)
    const oldCopy = partial.manifest.segments[0]!.publishedPath!
    await rm(oldCopy)
    delete partial.manifest.segments[0]!.publishedPath
    await writeFile(join(options.stateDirectory, partial.manifest.id, 'manifest.json'), JSON.stringify(partial.manifest))
    const before = calls.length
    const response = await fetch(base + '/api/creative/projects?session_id=library-video-chat', { headers: { cookie } })
    expect(response.status).toBe(200)
    const retained = await readVideoProject(options, partial.manifest.id, owner.sessionId, stateDir, provider.identity)
    const recoveredPath = retained.segments[0]!.publishedPath!
    expect(recoveredPath).not.toBe(oldCopy)
    expect((await readLibrary()).map(item => item.path)).toContain(recoveredPath)
    expect(submitted).toBe(2)
    expect(calls.slice(before).some(call => call.path.includes('/v1/'))).toBe(false)
    expect(await (await fetch(origin + '/artifacts/api/raw?path=' + encodeURIComponent(recoveredPath), { headers: { cookie } })).arrayBuffer())
      .toEqual(generatedVideo.buffer.slice(generatedVideo.byteOffset, generatedVideo.byteOffset + generatedVideo.byteLength))
    delete retained.segments[0]!.publishedPath
    await writeFile(join(options.stateDirectory, partial.manifest.id, 'manifest.json'), JSON.stringify(retained))
    const outputDirectory = partial.manifest.publicationDirectory!
    await rename(outputDirectory, outputDirectory + '-offline')
    const offline = await fetch(base + '/api/creative/projects?session_id=library-video-chat', { headers: { cookie } })
    expect(offline.status).toBe(200)
    const preserved = projects(object(await offline.json()))
    expect(preserved).toHaveLength(3)
    expect(preserved.find(project => Array.isArray(project.tasks)
      && object(project.tasks[0]).videoProjectId === partial.manifest.id)).toMatchObject({
      errorCode: 'ARTIFACT_PUBLISH_FAILED', outputs: [{ kind: 'video' }],
      tasks: [{ errorCode: 'ARTIFACT_PUBLISH_FAILED' }],
    })
    expect(submitted).toBe(2)
    await rename(outputDirectory + '-offline', outputDirectory)
    const refreshed = projects(object(await (await fetch(base + '/api/creative/projects?session_id=library-video-chat',
      { headers: { cookie } })).json()))
    expect(refreshed.find(project => Array.isArray(project.tasks)
      && object(project.tasks[0]).videoProjectId === partial.manifest.id)?.errorCode).toBe('PROVIDER_TASK_FAILED')
  }, 20_000)

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
    expect(await post(base, '/api/video/tasks?source=newapi-generate', {
      prompt: 'A synthetic clip', model: 'MiniMax-H3', durationSeconds: 4, mode: 'pro',
    })).toMatchObject({ ok: false, code: 'MODE_NOT_SUPPORTED' })
    for (const invalid of [{ resolution: 768 }, { resolution: '' }, { ratio: false }, { ratio: null }, { mode: 1 },
      { mode: '' }, { seed: 1.5 }, { seed: '12' }, { seed: Number.MAX_SAFE_INTEGER + 1 }, { audio: 'false' }, { audio: null }]) {
      expect(await post(base, '/api/video/tasks?source=newapi-generate', {
        prompt: 'Reject invalid explicit parameters', model: 'MiniMax-H3', durationSeconds: 4, ...invalid,
      })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    }
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

  it.each([{ input: undefined }, { input: [] }])('enables image input by default for the confirmed product alias with input $input', async ({ input }) => {
    relayModels = [{ id: 'yunshu-flash', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot(input === undefined ? [] : [{ id: 'yunshu-flash', input }])
    await signIn(base)
    expect((await context!.llm.listModels('yunshu-local')).map(model => ({ id: model.id, input: model.inputModalities })))
      .toEqual([{ id: 'yunshu-flash', input: ['text', 'image'] }])
    expect(calls.some(call => call.path.includes('chat/completions'))).toBe(false)
  })

  it.each([{ input: ['text'] }, { input: ['text', 'image'] }])('preserves explicit product alias inputs $input', async ({ input }) => {
    relayModels = [{ id: 'yunshu-flash', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot([{ id: 'yunshu-flash', input: [...input] }])
    await signIn(base)
    expect((await context!.llm.listModels('yunshu-local')).map(model => ({ id: model.id, input: model.inputModalities })))
      .toEqual([{ id: 'yunshu-flash', input: [...input] }])
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

  it('sends all current product chat IDs and historical disabled IDs through the gateway dialect', async () => {
    // Exact enabled product-group IDs from the gateway's safe model audit;
    // upstream aliases stay server-owned and do not imply optional capabilities.
    const currentIds = ['yunshu-flash', 'deepseek-flash',
      'deepseek-v4-pro', 'glm-5.1', 'glm-5.2', 'gp-5.5', 'kimi-k2.6', 'kimi-k2.7-code',
      'qwen3.6-flash', 'qwen3.6-plus', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-max', 'ys-1.0', 'claode-5']
    const disabledIds = ['deepseek-v4-flash', 'deepseek-v4-flash-0731']
    const ids = [...currentIds, ...disabledIds]
    relayModels = ids.map(id => ({ id, object: 'model', supported_endpoint_types: ['openai'] }))
    const { base } = await boot(undefined, false, false, undefined, {}, 'desktop')
    await signIn(base)
    await context!.llm.listModels('yunshu-local')
    for (const model of ids) {
      const prepared = await context!.llm.prepareCall({ provider: 'yunshu-local', model, maxTokens: 512 })
      for await (const chunk of prepared.stream({ ...prepared.config,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Synthetic local chat check' }], source: { kind: 'user' } })],
        system: 'Synthetic test system', tools: [{ name: 'synthetic_lookup', description: 'Local check', parameters: { type: 'object', properties: {} } }],
      })) {
        if (chunk.type === 'finish') expect(chunk.reason.kind).toBe('stop')
      }
    }
    const requests = calls.filter(call => call.path === '/harness/v1/chat/completions')
    expect(requests).toHaveLength(ids.length)
    expect(requests.filter(call => currentIds.includes(String(object(call.body).model)))).toHaveLength(15)
    expect(requests.map(call => object(call.body).model)).toEqual(ids)
    expect(requests[0]?.body).toMatchInlineSnapshot(`
      {
        "max_tokens": 512,
        "messages": [
          {
            "content": "Synthetic test system",
            "role": "system",
          },
          {
            "content": "Synthetic local chat check",
            "role": "user",
          },
        ],
        "model": "yunshu-flash",
        "stream": true,
        "stream_options": {
          "include_usage": true,
        },
        "tools": [
          {
            "function": {
              "description": "Local check",
              "name": "synthetic_lookup",
              "parameters": {
                "properties": {},
                "type": "object",
              },
            },
            "type": "function",
          },
        ],
      }
    `)
    for (const request of requests) {
      expect(request.authorization).toBe('Bearer sk-owned-relay')
      expect(request.body).toMatchObject({ stream: true, max_tokens: 512, stream_options: { include_usage: true },
        messages: [{ role: 'system', content: 'Synthetic test system' }, { role: 'user', content: 'Synthetic local chat check' }],
        tools: [{ type: 'function', function: { name: 'synthetic_lookup', parameters: { type: 'object', properties: {} } } }],
      })
      for (const field of ['store', 'max_completion_tokens', 'temperature', 'top_p', 'thinking', 'reasoning_effort', 'enable_thinking']) {
        expect(request.body).not.toHaveProperty(field)
      }
    }
    for (const model of ['gp-5.5', 'ys-1.0', 'claode-5']) {
      await expect(context!.llm.prepareCall({ provider: 'yunshu-local', model, reasoningEffort: ReasoningEffortId('high') }))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    }
    expect(calls.filter(call => call.path === '/harness/v1/chat/completions')).toHaveLength(ids.length)
  })

  it.each([
    { hint: undefined, maximum: 1 },
    { hint: { schema: 1, atomic_admission: true, max_parallelism: 16, model: 'MiniMax-H3', scope: 'shared_account_pool', reservation: false }, maximum: 16 },
    { hint: { schema: 1, atomic_admission: false, max_parallelism: 16, model: 'MiniMax-H3', scope: 'shared_account_pool', reservation: false }, maximum: 1 },
  ])('reads only the current account-bound enforced H3 ceiling $maximum from hint $hint', async ({ hint, maximum }) => {
    let options: VideoProjectOptions | undefined
    const register = VideoProjectTools.registerVideoProjectTools
    vi.spyOn(VideoProjectTools, 'registerVideoProjectTools').mockImplementation((ctx, value) => { options = value; register(ctx, value) })
    const { base, stateDir } = await boot(undefined, false, false, undefined, {}, 'desktop')
    await signIn(base)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'],
      parameters: { 'x-client-concurrency': hint } }]
    if (options === undefined) throw new Error('Expected the account-bound project provider')
    const provider = await options.acquireProvider(stateDir, videoAgent(stateDir).session)
    if (provider.parallelism === undefined) throw new Error('Expected the real gateway concurrency reader')
    expect(await provider.parallelism('MiniMax-H3', new AbortController().signal)).toBe(maximum)
    expect(await provider.parallelism('another-video', new AbortController().signal)).toBe(1)
    expect(calls.filter(call => call.path === '/harness/v1/models').every(call => call.authorization === 'Bearer sk-owned-relay')).toBe(true)
    expect(calls.some(call => call.path === '/harness/v1/video/generations' || call.path === '/harness/v1/videos')).toBe(false)
    await post(base, '/api/session/logout', {})
    await expect(provider.parallelism('MiniMax-H3', new AbortController().signal)).rejects.toThrow('登录')
  })

  it('rejects an H3 ceiling read whose initiating login changes before the catalog returns', async () => {
    let options: VideoProjectOptions | undefined
    const register = VideoProjectTools.registerVideoProjectTools
    vi.spyOn(VideoProjectTools, 'registerVideoProjectTools').mockImplementation((ctx, value) => { options = value; register(ctx, value) })
    const { base, stateDir } = await boot(undefined, false, false, undefined, {}, 'desktop')
    await signIn(base)
    await context!.llm.listModels('yunshu-local')
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'], parameters: {
      'x-client-concurrency': { schema: 1, atomic_admission: true, max_parallelism: 16, model: 'MiniMax-H3', scope: 'shared_account_pool', reservation: false },
    } }]
    if (options === undefined) throw new Error('Expected the account-bound project provider')
    const provider = await options.acquireProvider(stateDir, videoAgent(stateDir).session)
    if (provider.parallelism === undefined) throw new Error('Expected the real gateway concurrency reader')
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    releaseUpstreamGate = () => { release.resolve(undefined) }
    upstreamGate = async (path) => {
      if (path === '/harness/api/pricing') { started.resolve(undefined); await release.promise }
    }
    const rejected = expect(provider.parallelism('MiniMax-H3', new AbortController().signal)).rejects.toThrow('登录')
    try {
      await started.promise
      await post(base, '/api/session/logout', {})
    } finally { release.resolve(undefined) }
    await rejected
    expect(calls.some(call => call.path === '/harness/v1/video/generations' || call.path === '/harness/v1/videos')).toBe(false)
  })

  it.each(['desktop', 'web', 'headless'] as const)('labels only Desktop video requests from the %s launcher profile across chat and project operations', async (profileName) => {
    let options: VideoProjectOptions | undefined
    const register = VideoProjectTools.registerVideoProjectTools
    vi.spyOn(VideoProjectTools, 'registerVideoProjectTools').mockImplementation((ctx, value) => {
      options = value
      register(ctx, value)
    })
    const { base, stateDir, api } = await boot(undefined, false, false, undefined, {}, profileName)
    await signIn(base)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]
    videoTaskStatus = 'SUCCESS'
    videoResultUrl = api + '/fixtures/private.mp4'
    const agent = videoAgent(stateDir)
    const outcome = object((await context!.tools.execute({ callId: ToolCallId('source-chat'), name: 'generate_video',
      arguments: { prompt: 'A synthetic clip', model: 'MiniMax-H3', duration_seconds: 4 }, agent, signal: new AbortController().signal })).value)
    expect(outcome.status).toBe('succeeded')
    if (options === undefined) throw new Error('Expected the production project provider')
    const signal = new AbortController().signal
    const provider = await options.acquireProvider(stateDir, agent.session)
    const selected = await provider.model('MiniMax-H3', signal)
    const request = await provider.build({ prompt: 'A synthetic clip', totalDurationSeconds: 4 }, selected.id, 'A synthetic clip', 4, signal)
    const accepted = await provider.submit(request, signal)
    expect(await provider.check(accepted.taskId, request, signal)).toEqual({ status: 'succeeded' })
    const cache = join(stateDir, 'video-projects')
    await mkdir(cache, { recursive: true })
    const destination = join(cache, 'source-check.mp4')
    await provider.download(accepted.taskId, request, destination, signal)
    expect(await readFile(destination)).toEqual(generatedVideo)
    expect(videoHeaders.map(call => call.path)).toEqual(Array.from({ length: 2 }, () => [
      '/harness/v1/video/generations', '/harness/v1/video/generations/fixture-video-task', '/harness/v1/videos/fixture-video-task/content',
    ]).flat())
    expect(videoHeaders.map(call => call.source)).toEqual(Array<string | undefined>(6).fill(profileName === 'desktop' ? 'desktop' : undefined))
    expect(videoHeaders.filter(call => call.path === '/harness/v1/video/generations').map(call => call.contentType)).toEqual(['application/json', 'application/json'])
    expect(calls.filter(call => call.path.startsWith('/harness/v1/video')).every(call => call.authorization === 'Bearer sk-owned-relay')).toBe(true)
    expect(calls.some(call => call.path === '/harness/fixtures/private.mp4')).toBe(false)
    expect(await post(base, '/api/video/tasks?source=newapi', { prompt: 'A synthetic clip', model: 'MiniMax-H3', durationSeconds: 4 }))
      .toMatchObject({ ok: true })
    expect(videoHeaders.at(-1)).toEqual({ path: '/harness/v1/video/generations',
      source: profileName === 'desktop' ? 'desktop' : undefined, contentType: 'application/json' })
  })

  it.each(['panel', 'chat', 'linked-panel'] as const)('submits H3 through the %s entry and saves uppercase generic task success', async (entry) => {
    const linked = entry === 'linked-panel'
    const { base, stateDir } = await boot(undefined, linked, linked, undefined, {}, 'desktop')
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
    expect(videoHeaders.map(call => call.source)).toEqual(['desktop', 'desktop', 'desktop'])
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

  it('selects the backend default on the first real catalog read and orders only authorized chat models', async () => {
    clientModelConfig = { schema_version: 1, default_chat_model: 'second-chat',
      model_order: ['unauthorized', 'gpt-image-2', 'second-chat', 'deepseek-v4-flash'] }
    relayModels = [...initialRelayModels(), { id: 'second-chat', object: 'model', supported_endpoint_types: ['openai'] },
      { id: 'new-chat', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot(undefined, false, false,
      { provider: 'yunshu-local', model: 'unavailable-bootstrap', followPolicy: true })
    await signIn(base)
    const catalog = await buildModelCatalog(context!)
    expect(catalog.default).toEqual({ provider: 'yunshu-local', model: 'second-chat' })
    expect(catalog.groups.find(group => group.id === 'yunshu-local')?.models.map(model => model.id))
      .toEqual(['second-chat', 'deepseek-v4-flash', 'new-chat'])
    expect(catalog.groups.flatMap(group => group.models).map(model => model.id)).not.toContain('unauthorized')
    expect(calls.some(call => call.path === '/api/status' || call.path === '/v1/models')).toBe(false)
    expect(calls.filter(call => call.path === '/harness/api/status').every(call => call.authorization === undefined)).toBe(true)
    expect(calls.filter(call => call.path.endsWith('/chat/completions') || call.path.includes('/generations'))).toEqual([])
  })

  it.each(['deepseek-v4-flash', 'second-chat'])('refreshes a signed-out selector immediately after login with backend default %s', async (model) => {
    clientModelConfig = { schema_version: 1, default_chat_model: model, model_order: ['second-chat'] }
    relayModels = [...initialRelayModels(), { id: 'second-chat', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot(undefined, false, false,
      { provider: 'yunshu-local', model: 'deepseek-v4-flash', followPolicy: true })
    expect((await buildModelCatalog(context!)).groups.some(group => group.id === 'yunshu-local')).toBe(false)
    const refreshed: ReturnType<typeof buildModelCatalog>[] = []
    context!.on('api-session/model-catalog-changed', () => { refreshed.push(buildModelCatalog(context!)) })
    await signIn(base)
    await vi.waitFor(() => { expect(refreshed.length).toBeGreaterThan(0) })
    const catalog = await refreshed[0]!
    expect(catalog.default).toEqual({ provider: 'yunshu-local', model })
    expect(catalog.groups.find(group => group.id === 'yunshu-local')?.models.map(entry => entry.id))
      .toEqual(['second-chat', 'deepseek-v4-flash'])
    await Promise.all(refreshed)
    const changes = refreshed.length
    await buildModelCatalog(context!)
    expect(refreshed).toHaveLength(changes)
    expect(changes).toBeLessThanOrEqual(2)
    expect(calls.filter(call => call.path.endsWith('/chat/completions') || call.path.includes('/generations'))).toEqual([])
  })

  it('finishes login while catalog discovery is pending and allows a failed discovery to be retried', async () => {
    clientModelConfig = { schema_version: 1, default_chat_model: 'second-chat', model_order: [] }
    relayModels = [{ id: 'second-chat', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot(undefined, false, false,
      { provider: 'yunshu-local', model: 'deepseek-v4-flash', followPolicy: true })
    await buildModelCatalog(context!)
    const started = new Promise<void>((resolve) => { modelReadStarted = resolve })
    modelsBarrier = new Promise<void>((resolve) => { releaseModels = resolve })
    modelsStatus = 503
    const refreshed: ReturnType<typeof buildModelCatalog>[] = []
    context!.on('api-session/model-catalog-changed', () => { refreshed.push(buildModelCatalog(context!)) })
    await signIn(base)
    await started
    expect(refreshed).toHaveLength(1)
    releaseModels?.()
    const failed = await refreshed[0]!
    expect(failed.groups.some(group => group.id === 'yunshu-local')).toBe(false)
    expect(failed.failures).toContainEqual(expect.objectContaining({ id: 'yunshu-local' }))
    modelsBarrier = undefined
    modelsStatus = 200
    const recovered = await buildModelCatalog(context!)
    expect(recovered.default).toEqual({ provider: 'yunshu-local', model: 'second-chat' })
    expect(recovered.groups.find(group => group.id === 'yunshu-local')?.models.map(model => model.id)).toEqual(['second-chat'])
    await Promise.all(refreshed)
    expect(refreshed).toHaveLength(2)
  })

  it('notifies changed account model membership and ordering while retaining a manual default', async () => {
    clientModelConfig = { schema_version: 1, default_chat_model: 'deepseek-v4-flash', model_order: [] }
    const { base } = await boot(undefined, false, false, { provider: 'other-provider', model: 'other-chat' })
    await signIn(base)
    await buildModelCatalog(context!)
    const changes = vi.fn()
    context!.on('api-session/model-catalog-changed', changes)
    relayModels.push({ id: 'second-chat', object: 'model', supported_endpoint_types: ['openai'] })
    expect((await buildModelCatalog(context!)).default).toEqual({ provider: 'other-provider', model: 'other-chat' })
    expect(changes).toHaveBeenCalledTimes(1)
    clientModelConfig = { schema_version: 1, default_chat_model: 'deepseek-v4-flash', model_order: ['second-chat'] }
    const reordered = await buildModelCatalog(context!)
    expect(reordered.groups.find(group => group.id === 'yunshu-local')?.models.map(model => model.id))
      .toEqual(['second-chat', 'deepseek-v4-flash'])
    expect(reordered.default).toEqual({ provider: 'other-provider', model: 'other-chat' })
    expect(changes).toHaveBeenCalledTimes(2)
    await buildModelCatalog(context!)
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it('withdraws the authorized selector catalog immediately after logout and local session expiry', async () => {
    const { base } = await boot(undefined, false, false,
      { provider: 'yunshu-local', model: 'deepseek-v4-flash', followPolicy: true })
    await signIn(base)
    await buildModelCatalog(context!)
    const refreshed: ReturnType<typeof buildModelCatalog>[] = []
    context!.on('api-session/model-catalog-changed', () => { refreshed.push(buildModelCatalog(context!)) })
    await post(base, '/api/session/logout', {})
    await vi.waitFor(() => { expect(refreshed.length).toBeGreaterThan(0) })
    expect((await refreshed[0]!).groups.some(group => group.id === 'yunshu-local')).toBe(false)
    selfId = 8
    relayKey = 'sk-account-two'
    relayModels = [{ id: 'second-chat', object: 'model', supported_endpoint_types: ['openai'] }]
    clientModelConfig = { schema_version: 1, default_chat_model: 'second-chat', model_order: [] }
    await signIn(base)
    await Promise.all(refreshed)
    const nextAccount = await refreshed.at(-1)!
    expect(nextAccount.groups.find(group => group.id === 'yunshu-local')?.models.map(model => model.id)).toEqual(['second-chat'])
    expect(nextAccount.default).toEqual({ provider: 'yunshu-local', model: 'second-chat' })
    const count = refreshed.length
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60_000)
    await expect(context!.llm.listModels('yunshu-local')).rejects.toThrow('登录账号已变化')
    await expect(context!.llm.listModels('yunshu-local')).rejects.toThrow('请先登录产品账号')
    expect(refreshed.length).toBeGreaterThan(count)
    const expired = await refreshed.at(-1)!
    expect(expired.groups.some(group => group.id === 'yunshu-local')).toBe(false)
  })

  it.each(['gpt-image-2', 'unauthorized'])('falls back to an authorized chat when backend default %s is unusable', async (defaultModel) => {
    clientModelConfig = { schema_version: 1, default_chat_model: defaultModel,
      model_order: ['gpt-image-2', 'second-chat', 'deepseek-v4-flash'] }
    relayModels = [...initialRelayModels(), { id: 'second-chat', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot(undefined, false, false,
      { provider: 'yunshu-local', model: 'unavailable-bootstrap', followPolicy: true })
    await signIn(base)
    expect((await buildModelCatalog(context!)).default).toEqual({ provider: 'yunshu-local', model: 'second-chat' })
  })

  it('keeps an explicit user default while applying the backend product ordering', async () => {
    clientModelConfig = { schema_version: 1, default_chat_model: 'second-chat', model_order: ['second-chat'] }
    relayModels = [...initialRelayModels(), { id: 'second-chat', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot(undefined, false, false, { provider: 'other-provider', model: 'other-chat' })
    const changes = vi.fn()
    context!.on('api-session/model-catalog-changed', changes)
    await signIn(base)
    const catalog = await buildModelCatalog(context!)
    expect(catalog.default).toEqual({ provider: 'other-provider', model: 'other-chat' })
    expect(catalog.groups.find(group => group.id === 'yunshu-local')?.models.map(model => model.id))
      .toEqual(['second-chat', 'deepseek-v4-flash'])
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it('notifies a default-only change once without causing catalog reload loops', async () => {
    clientModelConfig = { schema_version: 1, default_chat_model: 'deepseek-v4-flash', model_order: [] }
    relayModels = [...initialRelayModels(), { id: 'second-chat', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot(undefined, false, false,
      { provider: 'yunshu-local', model: 'unavailable-bootstrap', followPolicy: true })
    await signIn(base)
    expect((await buildModelCatalog(context!)).default.model).toBe('deepseek-v4-flash')
    const changes = vi.fn()
    context!.on('api-session/model-catalog-changed', () => { throw new Error('unavailable observer') })
    context!.on('api-session/model-catalog-changed', changes)
    expect((await buildModelCatalog(context!)).default.model).toBe('deepseek-v4-flash')
    expect(changes).not.toHaveBeenCalled()
    clientModelConfig = { schema_version: 1, default_chat_model: 'second-chat', model_order: [] }
    expect((await buildModelCatalog(context!)).default.model).toBe('second-chat')
    expect(changes).toHaveBeenCalledTimes(1)
    expect((await buildModelCatalog(context!)).default.model).toBe('second-chat')
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('refreshes automatic defaults and retains the last valid preferences during malformed or unavailable status reads', async () => {
    clientModelConfig = { schema_version: 1, default_chat_model: 'deepseek-v4-flash', model_order: [] }
    relayModels = [...initialRelayModels(), { id: 'second-chat', object: 'model', supported_endpoint_types: ['openai'] }]
    const { base } = await boot(undefined, false, false,
      { provider: 'yunshu-local', model: 'unavailable-bootstrap', followPolicy: true })
    await signIn(base)
    expect((await buildModelCatalog(context!)).default.model).toBe('deepseek-v4-flash')
    clientModelConfig = { schema_version: 1, default_chat_model: 'second-chat', model_order: ['second-chat'] }
    expect((await buildModelCatalog(context!)).default.model).toBe('second-chat')
    for (const unavailable of ['malformed', 'http-error']) {
      clientModelConfig = { schema_version: 9, default_chat_model: 'deepseek-v4-flash', model_order: [] }
      statusAvailable = unavailable !== 'http-error'
      const catalog = await buildModelCatalog(context!)
      expect(catalog.default.model).toBe('second-chat')
      expect(catalog.groups.find(group => group.id === 'yunshu-local')?.models.map(model => model.id))
        .toEqual(['second-chat', 'deepseek-v4-flash'])
    }
    statusAvailable = true
    clientModelConfig = { schema_version: 1, default_chat_model: '', model_order: [] }
    const cleared = await buildModelCatalog(context!)
    expect(cleared.default.model).toBe('deepseek-v4-flash')
    expect(cleared.groups.find(group => group.id === 'yunshu-local')?.models.map(model => model.id))
      .toEqual(['deepseek-v4-flash', 'second-chat'])
  })

  it.runIf(process.env.YUNSHU_CLIENT_MODEL_QA_ORIGIN !== undefined)('applies real local API status preferences through the product Loader without granting unavailable models', async () => {
    const origin = new URL(process.env.YUNSHU_CLIENT_MODEL_QA_ORIGIN!)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/harness') {
      throw new Error('Live client model QA requires the isolated loopback Harness API')
    }
    const response = await fetch(origin.href + '/api/status', { redirect: 'error', signal: AbortSignal.timeout(5000) })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const status = object(await response.json())
    expect(status.success).toBe(true)
    clientModelConfig = object(status.data).client_model_config
    expect(clientModelConfig).toEqual({ schema_version: 1, default_chat_model: 'qa-second-chat',
      model_order: ['qa-second-chat', 'deepseek-qa-chat', 'gpt-image-qa'] })
    relayModels = [
      { id: 'deepseek-qa-chat', object: 'model', supported_endpoint_types: ['openai'] },
      { id: 'gpt-image-qa', object: 'model', supported_endpoint_types: ['image-generation'] },
    ]
    const { base } = await boot(undefined, false, false,
      { provider: 'yunshu-local', model: 'unavailable-bootstrap', followPolicy: true })
    await signIn(base)
    const restricted = await buildModelCatalog(context!)
    expect(restricted.default.model).toBe('deepseek-qa-chat')
    expect(restricted.groups.find(group => group.id === 'yunshu-local')?.models.map(model => model.id)).toEqual(['deepseek-qa-chat'])
    relayModels.push({ id: 'qa-second-chat', object: 'model', supported_endpoint_types: ['openai'] })
    const granted = await buildModelCatalog(context!)
    expect(granted.default.model).toBe('qa-second-chat')
    expect(granted.groups.find(group => group.id === 'yunshu-local')?.models.map(model => model.id))
      .toEqual(['qa-second-chat', 'deepseek-qa-chat'])
    expect(calls.filter(call => call.path.endsWith('/chat/completions') || call.path.includes('/generations'))).toEqual([])
  })

  it('uses the first available chat without backend preferences and withdraws its default on account logout', async () => {
    const { base } = await boot(undefined, false, false,
      { provider: 'yunshu-local', model: 'unavailable-bootstrap', followPolicy: true })
    await signIn(base)
    expect((await buildModelCatalog(context!)).default.model).toBe('deepseek-v4-flash')
    await post(base, '/api/session/logout', {})
    expect(context!.agentDefaultModel.currentSelection().model).toBe('unavailable-bootstrap')
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

  it('reports semantic local video failures once using the original account access token without delaying the tool', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    await signIn(base)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]
    const result = await context!.tools.execute({ name: 'generate_video',
      arguments: { model: 'MiniMax-H3', prompt: 'private story must not be reported', duration_seconds: 30 },
      agent: videoAgent(stateDir), callId: ToolCallId('local-rejected-video'), signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'failed', code: 'DURATION_NOT_SUPPORTED' })
    await vi.waitFor(() => { expect(calls.filter(call => call.path === '/harness/api/client-errors')).toHaveLength(1) })
    const reports = calls.filter(call => call.path === '/harness/api/client-errors')
    expect(reports[0]).toEqual({ path: '/harness/api/client-errors', authorization: 'Bearer access-user',
      body: { tool: 'generate_video', code: 'DURATION_NOT_SUPPORTED', stage: 'preflight', model: 'MiniMax-H3' } })
    expect(calls.filter(call => ['/harness/v1/videos', '/harness/v1/video/generations'].includes(call.path))).toHaveLength(0)
    // The fixture's old API returns 404 for reports: the tool result and session remain intact.
    expect((await post(base, '/api/session/phone-recovery', {})).ok).toBeDefined()
  })

  it('returns the original tool result while its diagnostic HTTP response is still pending', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    await signIn(base)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]
    const started = Promise.withResolvers<undefined>()
    const held = Promise.withResolvers<undefined>()
    let reportOpen = false
    upstreamGate = async (path) => {
      if (path !== '/harness/api/client-errors') return
      reportOpen = true
      started.resolve(undefined)
      await held.promise
      reportOpen = false
    }
    try {
      const result = await context!.tools.execute({ name: 'generate_video', arguments: {
        model: 'MiniMax-H3', prompt: 'A quiet cup', duration_seconds: 30,
      }, agent: videoAgent(stateDir), callId: ToolCallId('nonblocking-diagnostic'), signal: new AbortController().signal })
      await started.promise
      expect(reportOpen).toBe(true)
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ status: 'failed', code: 'DURATION_NOT_SUPPORTED' })
      expect(calls.filter(call => call.path === '/harness/api/client-errors')).toHaveLength(1)
      expect(calls.filter(call => ['/harness/v1/videos', '/harness/v1/video/generations'].includes(call.path))).toHaveLength(0)
    } finally { held.resolve(undefined) }
  })

  it('exposes current account video controls to chat without guessing audio or dispatching generation', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    await signIn(base)
    const model = 'k2-sd2.5-720p'
    pricingRows = ['MiniMax-H3', model, 'model_5'].map(model_name => ({ model_name, supported_endpoint_types: ['openai-video'] }))
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['openai-video'] })
    const listed = await context!.tools.execute({ name: 'list_video_models', arguments: {}, agent: videoAgent(stateDir),
      callId: ToolCallId('video-catalog'), signal: new AbortController().signal })
    expect(listed.isError ? listed.error : undefined).toBeUndefined()
    const result = object(listed.value)
    expect(result.status).toBe('listed')
    const models = result.models
    if (!Array.isArray(models)) throw new Error('Expected current account video controls')
    expect(models.map(entry => object(entry).id)).toEqual(['MiniMax-H3', model])
    expect(models.map(entry => object(entry))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'MiniMax-H3', durations: Array.from({ length: 12 }, (_, index) => index + 4), audio_output: 'supported', audio_toggle: false }),
      expect.objectContaining({ id: model, durations: [30], audio_output: 'unknown', audio_toggle: false, ratios: [] }),
    ]))
    expect(calls.filter(call => ['/harness/v1/videos', '/harness/v1/video/generations'].includes(call.path))).toHaveLength(0)
    for (const audio of [true, false]) {
      const rejected = await post(base, '/api/video/tasks?source=newapi-generate', { model, prompt: 'A speaker', durationSeconds: 30, audio })
      expect(rejected).toMatchObject({ ok: false, code: 'AUDIO_NOT_SUPPORTED' })
      expect(object(rejected).message).toContain('没有独立音频开关')
      expect(object(rejected).message).not.toContain('不支持生成音频')
    }
    expect(calls.filter(call => ['/harness/v1/videos', '/harness/v1/video/generations'].includes(call.path))).toHaveLength(0)
  })

  it('submits all 15 authorized BlackRxAI models with exact integer defaults and gateway-only JSON fields', async () => {
    const { base, stateDir } = await boot(undefined, true, true, undefined, { videoSubmitTimeoutMs: 1 })
    const cookie = await hostCookie(base)
    await signIn(base)
    const deadlines = vi.spyOn(AbortSignal, 'timeout')
    const cases = [
      ['lec-mj-seedance-2-5-cd-720p', 30], ['sd-25-900-2', 30], ['k2-sd2.5-720p', 30], ['lec-sz-sd2-full-480p', 30],
      ['video-sd25-480p', 30], ['model_5', 30], ['sd2.5-720p-x2', 30], ['sd2-th-2.0-720p', 15], ['bt-seedance-2.0', 15],
      ['lec-rs-seedance-2-0-fast', 15], ['sd20-933-720p', 15], ['sd2-hn2-480-pro', 15], ['v3-sd2.0-933-720p', 15],
      ['sd-20-9/3/3-1', 15], ['sd-20-903', 15],
    ] as const
    pricingRows = cases.map(([model_name]) => ({ model_name, display_name: `云枢视频 ${model_name}`, supported_endpoint_types: ['openai-video'] }))
    relayModels.push(...cases.map(([id]) => ({ id, object: 'model', supported_endpoint_types: ['openai-video'] })))
    context!.sessions.create(SessionId('blackrx-json'), { meta: { cwd: stateDir } })
    const catalog = object(await (await fetch(base + '/api/media/catalog')).json())
    const video = object(catalog.payload).video
    expect(Array.isArray(video) && video.map(model => object(model).displayName)).toEqual(cases.map(([id]) => `云枢视频 ${id}`))
    videoTaskStatus = 'SUCCESS'
    for (const [model, seconds] of cases) {
      expect(await post(base, '/api/video/tasks?source=newapi-generate', {
        session_id: 'blackrx-json', account_id: '7', model, prompt: 'A synthetic cup moves',
      }, cookie)).toMatchObject({ ok: true, taskId: 'fixture-video-task', submission_state: 'completed' })
      const submission = calls.filter(call => call.path === '/harness/v1/videos').at(-1)
      expect(submission).toMatchObject({ authorization: 'Bearer sk-owned-relay', body: {
        model, prompt: 'A synthetic cup moves', seconds, size: '1280x720', gen_type: 'text_to_video', n: 1,
      } })
      expect(Object.keys(object(submission?.body)).sort()).toEqual(['gen_type', 'model', 'n', 'prompt', 'seconds', 'size'])
    }
    expect(calls.filter(call => call.path === '/harness/v1/videos')).toHaveLength(15)
    expect(deadlines.mock.calls.filter(([milliseconds]) => milliseconds === 180_000)).toHaveLength(15)
    expect(calls.filter(call => call.path === '/harness/v1/videos/fixture-video-task/content')).toHaveLength(15)
    expect(calls.some(call => call.path.startsWith('/harness/v1/video/generations'))).toBe(false)
    pricingRows = [{ model_name: 'video-sd25-480p', supported_endpoint_types: ['openai-video'], parameters: { oneOf: [
      { properties: { resolution: { const: '1280x720' }, seconds: { enum: [15] } } },
      { properties: { resolution: { const: '720x1280' }, seconds: { enum: [30] } } },
    ] } }]
    for (const [resolution, seconds] of [['1280x720', 15], ['720x1280', 30]] as const) {
      expect(await post(base, '/api/video/tasks?source=newapi-generate', {
        session_id: 'blackrx-json', account_id: '7', model: 'video-sd25-480p', prompt: 'Use this live size menu', resolution,
      }, cookie)).toMatchObject({ ok: true })
      expect(calls.filter(call => call.path === '/harness/v1/videos').at(-1)?.body).toMatchObject({ seconds, size: resolution })
    }
  }, 15_000)

  it('retains all BlackRxAI multipart references and rejects unsupported combinations before a paid POST', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'k2-sd2.5-720p'
    pricingRows = [{ model_name: model, supported_endpoint_types: ['openai-video'] }]
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['openai-video'] })
    context!.sessions.create(SessionId('blackrx-references'), { meta: { cwd: stateDir } })
    const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#5533cc' } }).png().toBuffer()
    const first = await uploadImage(base, cookie, 'reference-one.png', png)
    const second = await uploadImage(base, cookie, 'reference-two.png', png)
    const video = generatedVideo
    const audio = Buffer.from('RIFF0000WAVEdata', 'ascii')
    const upload = async (type: string, filename: string, bytes: Buffer): Promise<string> => {
      const response = await fetch(base + '/api/assets', { method: 'POST', headers: {
        cookie, 'content-type': type, 'x-file-name': filename, 'x-idempotency-key': filename,
      }, body: new Uint8Array(bytes) })
      const result = object(await response.json())
      expect(result.ok).toBe(true)
      return String(object(result.asset).assetId)
    }
    const videoId = await upload('video/mp4', 'reference.mp4', video)
    const audioId = await upload('audio/wav', 'reference.wav', audio)
    const generate = (extra: object = {}) => post(base, '/api/video/tasks?source=newapi-generate', {
      session_id: 'blackrx-references', account_id: '7', model, prompt: 'All four references',
      durationSeconds: 30, resolution: '720x1280', referenceImages: [first.assetId, second.assetId],
      referenceVideos: [videoId], referenceAudios: [audioId], ...extra,
    }, cookie)
    for (const [extra, code] of [
      [{ durationSeconds: 15 }, 'DURATION_NOT_SUPPORTED'], [{ durationSeconds: 30.5 }, 'DURATION_NOT_SUPPORTED'],
      [{ resolution: '720p' }, 'RESOLUTION_NOT_SUPPORTED'], [{ ratio: '16:9' }, 'PARAMETER_NOT_SUPPORTED'],
      [{ referenceImages: Array.from({ length: 31 }, () => first.assetId) }, 'REFERENCES_NOT_SUPPORTED'],
      [{ frameImages: [first.assetId] }, 'REFERENCES_NOT_SUPPORTED'], [{ referenceAudios: [videoId] }, 'REFERENCE_MISSING'],
    ] as const) expect(await generate(extra)).toMatchObject({ ok: false, code })
    expect(calls.filter(call => call.path === '/harness/v1/videos')).toHaveLength(0)
    videoTaskStatus = 'SUCCESS'
    expect(await generate()).toMatchObject({ ok: true })
    const submitted = calls.filter(call => call.path === '/harness/v1/videos')
    expect(submitted).toHaveLength(1)
    const encoded = object(submitted[0]?.body).multipart
    if (typeof encoded !== 'string') throw new Error('Expected a real multipart video request')
    const multipart = Buffer.from(encoded, 'base64')
    const text = multipart.toString('utf8')
    expect(text.match(/name="images";/gu)).toHaveLength(2)
    expect(text.match(/name="videos";/gu)).toHaveLength(1)
    expect(text.match(/name="audios";/gu)).toHaveLength(1)
    expect(text).toContain('name="seconds"\r\n\r\n30')
    expect(text).toContain('name="size"\r\n\r\n720x1280')
    expect(text).toContain('name="gen_type"\r\n\r\nreference_to_video')
    expect(text).not.toMatch(/name="(?:metadata|resolution|ratio|duration|_blackrxReferences)"|data:(?:image|video|audio)\//u)
    expect(multipart.includes(await readFile(join(stateDir, 'refs', String(first.filename))))).toBe(true)
    expect(multipart.includes(await readFile(join(stateDir, 'refs', String(second.filename))))).toBe(true)
    expect(multipart.includes(video)).toBe(true)
    expect(multipart.includes(audio)).toBe(true)
    const meta = join(stateDir, 'refs', String(first.filename) + '.json')
    await writeFile(meta, JSON.stringify({ ...JSON.parse(await readFile(meta, 'utf8')), accountId: '8' }))
    expect(await generate()).toMatchObject({ ok: false, code: 'REFERENCE_MISSING' })
    expect(calls.filter(call => call.path === '/harness/v1/videos')).toHaveLength(1)
  }, 15_000)

  it('preserves every product video duration and size through project preparation and real relay HTTP', async () => {
    let options: VideoProjectOptions | undefined
    const register = VideoProjectTools.registerVideoProjectTools
    vi.spyOn(VideoProjectTools, 'registerVideoProjectTools').mockImplementation((ctx, value) => { options = value; register(ctx, value) })
    const { base, stateDir } = await boot()
    await signIn(base)
    const variable = Array.from({ length: 16 }, (_, index) => index + 15)
    const policies = [
      ['lec-mj-seedance-2-5-cd-720p', [30], 9, 0, 0], ['sd-25-900-2', [30], 9, 0, 0],
      ['k2-sd2.5-720p', [30], 30, 10, 10], ['lec-sz-sd2-full-480p', [30], 30, 0, 10],
      ['video-sd25-480p', variable, 30, 10, 10], ['model_5', variable, 30, 10, 10],
      ['sd2.5-720p-x2', variable, 30, 10, 10], ['sd2-th-2.0-720p', [15], 9, 0, 3],
      ['bt-seedance-2.0', [10, 15], 8, 0, 0], ['lec-rs-seedance-2-0-fast', [15], 9, 0, 0],
      ['sd20-933-720p', [15], 9, 3, 3], ['sd2-hn2-480-pro', [15], 9, 3, 3],
      ['v3-sd2.0-933-720p', [15], 9, 3, 3], ['sd-20-9/3/3-1', [15], 9, 0, 3],
      ['sd-20-903', [15], 9, 0, 3],
    ] as const
    pricingRows = [...policies.map(([model_name]) => ({ model_name, supported_endpoint_types: ['openai-video'] })),
      { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]
    relayModels.push(...policies.map(([id]) => ({ id, object: 'model', supported_endpoint_types: ['openai-video'] })))
    videoTaskStatus = 'SUCCESS'
    if (options === undefined) throw new Error('Expected the real project provider')
    const provider = await options.acquireProvider(stateDir, videoAgent(stateDir).session)
    const signal = new AbortController().signal
    let submitted = 0
    for (const [model, durations] of policies) {
      const selected = await provider.model(model, signal)
      expect(selected.durations).toEqual(durations)
      for (const resolution of ['1280x720', '720x1280', '1792x1024', '1024x1792']) {
        for (const seconds of durations) {
          const request = await provider.build({ prompt: 'A synthetic parameter check', totalDurationSeconds: seconds,
            resolution }, model, 'A synthetic parameter check', seconds, signal)
          await expect(provider.submit(request, signal)).resolves.toEqual({ taskId: 'fixture-video-task' })
          expect(calls.at(-1)).toMatchObject({ path: '/harness/v1/videos', authorization: 'Bearer sk-owned-relay', body: {
            model, prompt: 'A synthetic parameter check', seconds, size: resolution, gen_type: 'text_to_video', n: 1,
          } })
          expect(Object.keys(object(calls.at(-1)?.body)).sort()).toEqual(['gen_type', 'model', 'n', 'prompt', 'seconds', 'size'])
          submitted += 1
        }
      }
    }
    const h3 = await provider.model('MiniMax-H3', signal)
    expect(h3.durations).toEqual(Array.from({ length: 12 }, (_, index) => index + 4))
    for (const resolution of ['768P', '2K']) for (const seconds of h3.durations) {
      const request = await provider.build({ prompt: 'A synthetic H3 check', totalDurationSeconds: seconds,
        resolution, ratio: '16:9', audio: true }, h3.id, 'A synthetic H3 check', seconds, signal)
      await expect(provider.submit(request, signal)).resolves.toEqual({ taskId: 'fixture-video-task' })
      expect(calls.at(-1)).toMatchObject({ path: '/harness/v1/video/generations', body: {
        model: 'MiniMax-H3', prompt: 'A synthetic H3 check', duration: seconds, seconds, resolution, size: resolution,
        ratio: '16:9', aspect_ratio: '16:9', metadata: { ratio: '16:9', resolution },
      } })
      expect(object(calls.at(-1)?.body)).not.toHaveProperty('generate_audio')
      submitted += 1
    }
    const posts = calls.filter(call => call.path === '/harness/v1/videos' || call.path === '/harness/v1/video/generations')
    expect(posts).toHaveLength(submitted)
    expect(submitted).toBe(268)

    const image = await uploadImage(base, '', 'parameter-reference.png', await sharp({
      create: { width: 3, height: 2, channels: 3, background: '#663399' },
    }).png().toBuffer())
    const upload = async (type: string, filename: string, bytes: Buffer): Promise<string> => {
      const response = await fetch(base + '/api/assets', { method: 'POST', headers: {
        'content-type': type, 'x-file-name': filename, 'x-idempotency-key': filename,
      }, body: new Uint8Array(bytes) })
      const answer = object(await response.json())
      expect(answer.ok).toBe(true)
      return String(object(answer.asset).assetId)
    }
    const video = await upload('video/mp4', 'parameter-reference.mp4', generatedVideo)
    const audio = await upload('audio/wav', 'parameter-reference.wav', Buffer.from('RIFF0000WAVEdata', 'ascii'))
    for (const [model, durations, images, videos, audios] of policies) {
      const seconds = durations[0]
      const request = await provider.build({ prompt: 'Retain every accepted reference', totalDurationSeconds: seconds,
        resolution: '720x1280', referenceImages: Array<string>(images).fill(String(image.assetId)),
        referenceVideos: Array<string>(videos).fill(video), referenceAudios: Array<string>(audios).fill(audio),
      }, model, 'Retain every accepted reference', seconds, signal)
      await expect(provider.submit(request, signal)).resolves.toEqual({ taskId: 'fixture-video-task' })
      const encoded = object(calls.at(-1)?.body).multipart
      if (typeof encoded !== 'string') throw new Error('Expected multipart references')
      const multipart = Buffer.from(encoded, 'base64').toString('utf8')
      expect(multipart.match(/name="images";/gu) ?? []).toHaveLength(images)
      expect(multipart.match(/name="videos";/gu) ?? []).toHaveLength(videos)
      expect(multipart.match(/name="audios";/gu) ?? []).toHaveLength(audios)
      expect(multipart).toContain('name="gen_type"\r\n\r\nreference_to_video')
      expect(multipart).not.toMatch(/name="(?:metadata|resolution|ratio|duration|_blackrxReferences)"|data:(?:image|video|audio)\//u)
      await expect(provider.build({ prompt: 'Reject the excess reference', totalDurationSeconds: seconds,
        referenceImages: Array<string>(images + 1).fill(String(image.assetId)),
      }, model, 'Reject the excess reference', seconds, signal)).rejects.toMatchObject({ code: 'REFERENCES_NOT_SUPPORTED' })
      await expect(provider.build({ prompt: 'Reject the frame slot', totalDurationSeconds: seconds,
        frameImages: [String(image.assetId)],
      }, model, 'Reject the frame slot', seconds, signal)).rejects.toMatchObject({ code: 'REFERENCES_NOT_SUPPORTED' })
    }
    const request = await provider.build({ prompt: 'All H3 media slots', totalDurationSeconds: 15, resolution: '2K', ratio: 'adaptive',
      referenceImages: Array<string>(9).fill(String(image.assetId)), referenceVideos: Array<string>(3).fill(video),
      referenceAudios: Array<string>(3).fill(audio),
    }, h3.id, 'All H3 media slots', 15, signal)
    await expect(provider.submit(request, signal)).resolves.toEqual({ taskId: 'fixture-video-task' })
    const content = object(object(calls.at(-1)?.body).metadata).content
    if (!Array.isArray(content)) throw new Error('Expected complete H3 media content')
    expect(content.filter(item => object(item).role === 'reference_image')).toHaveLength(9)
    expect(content.filter(item => object(item).role === 'reference_video')).toHaveLength(3)
    expect(content.filter(item => object(item).role === 'reference_audio')).toHaveLength(3)
    const frames = await provider.build({ prompt: 'H3 first and last frames', totalDurationSeconds: 5, resolution: '768P',
      frameImages: [String(image.assetId), String(image.assetId)], ratio: 'adaptive',
    }, h3.id, 'H3 first and last frames', 5, signal)
    await expect(provider.submit(frames, signal)).resolves.toEqual({ taskId: 'fixture-video-task' })
    const frameMetadata = object(object(calls.at(-1)?.body).metadata)
    expect(frameMetadata.first_frame_image).toMatch(/^data:image\/(?:png|jpeg);base64,/u)
    expect(frameMetadata.last_frame_image).toBe(frameMetadata.first_frame_image)
    expect(calls.filter(call => call.path === '/harness/v1/videos' || call.path === '/harness/v1/video/generations')).toHaveLength(285)
    pricingRows.push({ model_name: 'unknown-video', supported_endpoint_types: ['openai-video'] })
    relayModels.push({ id: 'unknown-video', object: 'model', supported_endpoint_types: ['openai-video'] })
    const unknown = await provider.model('unknown-video', signal)
    for (const [control, code] of [[{ resolution: '2K' }, 'RESOLUTION_NOT_SUPPORTED'], [{ ratio: '16:9' }, 'RATIO_NOT_SUPPORTED']] as const) {
      await expect(provider.build({ prompt: 'No undeclared control', totalDurationSeconds: 4, ...control }, unknown.id,
        'No undeclared control', 4, signal)).rejects.toMatchObject({ code })
    }
    expect(calls.filter(call => call.path === '/harness/v1/videos' || call.path === '/harness/v1/video/generations')).toHaveLength(285)
  })

  it.each(['panel', 'tool'] as const)('recovers the original accepted BlackRxAI video through %s with GET only after local cancellation', async (entry) => {
    const { base, stateDir } = await boot(undefined, true, true)
    const cookie = await hostCookie(base)
    await signIn(base)
    const model = 'bt-seedance-2.0'
    pricingRows = [{ model_name: model, supported_endpoint_types: ['openai-video'] }]
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['openai-video'] })
    const agent = videoAgent(stateDir, 'blackrx-recovery')
    context!.sessions.create(SessionId(agent.id), { meta: { cwd: stateDir } })
    videoTaskStatus = 'SUCCESS'
    const abort = new AbortController()
    upstreamGate = async (path) => { if (path === '/harness/v1/videos/fixture-video-task') abort.abort() }
    await context!.tools.execute({ name: 'generate_video', arguments: {
      prompt: 'One accepted ten second task', model, duration_seconds: 10, resolution: '1792x1024',
    }, agent, callId: ToolCallId('blackrx-stop'), signal: abort.signal })
    const listing = async () => projects(object(await (await fetch(base + '/api/creative/projects?session_id=blackrx-recovery', { headers: { cookie } })).json()))
    expect(await listing()).toMatchObject([{ status: 'unknown', tasks: [{ status: 'unknown', canQuery: true,
      videoReceipt: { route: '/v1/videos', model, taskId: 'fixture-video-task', phase: 'accepted' } }] }])
    const project = (await listing())[0]!
    if (!Array.isArray(project.tasks)) throw new Error('Expected the retained video operation')
    const planId = String(project.id)
    const operationId = String(object(project.tasks[0]).id)
    expect(await post(base, '/api/video/tasks?source=newapi-generate', {
      session_id: 'blackrx-recovery', account_id: '7', model, prompt: 'Do not generate a replacement', durationSeconds: 10,
    }, cookie)).toMatchObject({ ok: false, code: 'CREATIVE_SUBMISSION_UNKNOWN', submission_state: 'pending', taskId: 'fixture-video-task' })
    expect(object((await context!.tools.execute({ name: 'generate_video', arguments: {
      prompt: 'Do not retry this paid plan', model, duration_seconds: 10, plan_id: planId, shot_id: 'shot_1',
    }, agent, callId: ToolCallId('blackrx-block-retry'), signal: new AbortController().signal })).value)).toMatchObject({ status: 'failed', code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    upstreamGate = undefined
    if (entry === 'tool') {
      expect(object((await context!.tools.execute({ name: 'query_video_task', arguments: { plan_id: planId, operation_id: operationId },
        agent, callId: ToolCallId('blackrx-get-original'), signal: new AbortController().signal })).value)).toMatchObject({ status: 'succeeded', task_id: 'fixture-video-task' })
    } else {
      const response = await fetch(base + '/api/creative/video/recover', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: agent.id, project_id: planId, operation_id: operationId }) })
      expect(response.status).toBe(202)
      expect(object(await response.json()).ok).toBe(true)
    }
    await vi.waitFor(async () => { expect(await listing()).toMatchObject([{ status: 'completed', tasks: [{ status: 'completed', canQuery: false }], outputs: [{ kind: 'video' }] }]) })
    const submissions = calls.filter(call => call.path === '/harness/v1/videos')
    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.body).toEqual({ model, prompt: 'One accepted ten second task', seconds: 10, size: '1792x1024', gen_type: 'text_to_video', n: 1 })
    expect(calls.filter(call => call.path === '/harness/v1/videos/fixture-video-task').length).toBeGreaterThanOrEqual(2)
    expect(calls.filter(call => call.path === '/harness/v1/videos/fixture-video-task/content')).toHaveLength(1)
  }, 15_000)

  it('keeps accepted image-material receipts in a video plan out of video-task discovery', async () => {
    const { base, stateDir } = await boot(undefined, true, true)
    await signIn(base)
    const agent = videoAgent(stateDir, 'video-plan-image-receipt')
    const call = async (name: string, args: object) => object((await context!.tools.execute({ name, arguments: args, agent,
      callId: ToolCallId('mixed-plan-' + name), signal: new AbortController().signal })).value)
    const plan = await call('update_creation_plan', { kind: 'video', title: 'A video with an image material', brief: 'One portrait',
      assets: [{ id: 'portrait', name: 'Portrait', kind: 'image', source_path_or_asset_id: '' }],
      shots: [{ id: 'scene', order: 1, title: 'One scene', prompt: 'A person moves', asset_ids: ['portrait'] }],
    })
    const model = 'yunshu-internal-gpt-image-2'
    pricingRows = [{ model_name: model, supported_endpoint_types: ['image-generation'] }]
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['image-generation'] })
    const abort = new AbortController()
    upstreamGate = async (path) => { if (path.endsWith('/fixture-image-task')) abort.abort() }
    await context!.tools.execute({ name: 'generate_image', arguments: { model, prompt: 'A portrait', plan_id: plan.plan_id, asset_id: 'portrait' },
      agent, callId: ToolCallId('accepted-image-material'), signal: abort.signal })
    upstreamGate = undefined
    expect(await call('query_image_task', { plan_id: plan.plan_id })).toMatchObject({ status: 'listed', tasks: [{ can_query: true, task_id: 'fixture-image-task' }] })
    expect(await call('query_video_task', { plan_id: plan.plan_id })).toMatchObject({ status: 'listed', tasks: [] })
    expect(calls.filter(call => call.path === '/harness/toapis/v1/images/generations')).toHaveLength(1)
    expect(calls.filter(call => call.path === '/harness/v1/videos')).toHaveLength(0)
    // Older image-material records retain assetId but have no receipt carrier.
    const path = join(stateDir, 'creative-projects', String(plan.plan_id), 'project.json')
    const legacy = object(JSON.parse(await readFile(path, 'utf8')))
    if (!Array.isArray(legacy.operations)) throw new Error('Expected the legacy operation fixture')
    delete object(legacy.operations[0]).imageReceipt
    await writeFile(path, JSON.stringify(legacy))
    expect(await call('query_video_task', { plan_id: plan.plan_id })).toMatchObject({ status: 'listed', tasks: [] })
    const modelId = 'bt-seedance-2.0'
    pricingRows.push({ model_name: modelId, supported_endpoint_types: ['openai-video'] })
    relayModels.push({ id: modelId, object: 'model', supported_endpoint_types: ['openai-video'] })
    videoTaskStatus = 'SUCCESS'
    context!.sessions.create(SessionId(agent.id), { meta: { cwd: stateDir } })
    expect(await post(base, '/api/video/tasks?source=newapi-generate', {
      session_id: agent.id, account_id: '7', model: modelId, prompt: 'A separate authorized video', durationSeconds: 10,
    }, await hostCookie(base))).toMatchObject({ ok: true })
    expect(calls.filter(call => call.path === '/harness/v1/videos')).toHaveLength(1)
  })

  it('snapshots BlackRxAI project references privately and dispatches the same bytes through multipart', async () => {
    let options: VideoProjectOptions | undefined
    const register = VideoProjectTools.registerVideoProjectTools
    vi.spyOn(VideoProjectTools, 'registerVideoProjectTools').mockImplementation((ctx, value) => { options = value; register(ctx, value) })
    const { base, stateDir } = await boot()
    await signIn(base)
    const id = 'model_5'
    pricingRows = [{ model_name: id, supported_endpoint_types: ['openai-video'] }]
    relayModels.push({ id, object: 'model', supported_endpoint_types: ['openai-video'] })
    const workspace = join(stateDir, 'blackrx-workspace')
    await mkdir(workspace)
    const wav = Buffer.from('RIFF0000WAVEdata', 'ascii')
    await writeFile(join(workspace, 'voice.wav'), wav)
    const agent = videoAgent(workspace)
    if (options === undefined) throw new Error('Expected the registered durable video provider')
    const provider = await options.acquireProvider(workspace, agent.session)
    const model = await provider.model(id, new AbortController().signal)
    const request = await provider.build({ prompt: 'A moving cup', totalDurationSeconds: 30, referenceAudios: ['voice.wav'] },
      model.id, 'A moving cup', 30, new AbortController().signal)
    expect(request).toMatchObject({ model: id, seconds: 30, size: '1280x720', gen_type: 'reference_to_video', n: 1,
      _blackrxReferences: [{ kind: 'audio', mediaType: 'audio/wav', filename: 'reference-1.wav', base64: wav.toString('base64') }] })
    expect(JSON.stringify(request)).not.toMatch(/sk-owned|access-user|data:|voice\.wav|blackrx-workspace/u)
    await writeFile(join(workspace, 'voice.wav'), 'local file changed after preparation')
    videoTaskStatus = 'SUCCESS'
    expect(await provider.submit(request, new AbortController().signal)).toEqual({ taskId: 'fixture-video-task' })
    const encoded = object(calls.filter(call => call.path === '/harness/v1/videos')[0]?.body).multipart
    if (typeof encoded !== 'string') throw new Error('Expected multipart project submission')
    const multipart = Buffer.from(encoded, 'base64')
    expect(multipart.includes(wav)).toBe(true)
    expect(multipart.toString()).not.toMatch(/_blackrxReferences|data:|local file changed/u)
    expect(await provider.check('fixture-video-task', request, new AbortController().signal)).toEqual({ status: 'succeeded' })
    expect(calls.filter(call => call.path === '/harness/v1/videos')).toHaveLength(1)
  })

  it.each(['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-5-260628'])(
    'forwards %s reference videos and selected output parameters through typed Ark content', async (model) => {
      const { base, stateDir } = await boot()
      await signIn(base)
      pricingRows = [{ model_name: model, supported_endpoint_types: ['openai-video'] }]
      const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#cc5522' } }).png().toBuffer()
      const image = await uploadImage(base, '', 'ark-reference.png', png)
      const response = await fetch(base + '/api/assets', { method: 'POST', headers: {
        'content-type': 'video/mp4', 'x-file-name': 'ark-reference.mp4', 'x-idempotency-key': 'ark-reference-video',
      }, body: new Uint8Array(generatedVideo) })
      const video = object(await response.json())
      expect(video.ok).toBe(true)
      const request = { prompt: 'Use reference motion', model, durationSeconds: 5, resolution: '720p', ratio: '16:9', audio: false,
        referenceImages: [image.assetId], referenceVideos: [object(video.asset).assetId] }
      expect(await post(base, '/api/video/tasks?source=newapi-generate', { ...request, seed: 42 }))
        .toMatchObject({ ok: false, code: 'SEED_NOT_SUPPORTED' })
      expect(await post(base, '/api/video/tasks?source=newapi-generate', { ...request, frameImages: [image.assetId], ...(model === 'doubao-seedance-2-5-260628' ? { ratio: 'adaptive' } : {}) }))
        .toMatchObject({ ok: false, code: 'MIX_NOT_SUPPORTED' })
      expect(calls.filter(call => call.path === '/harness/v1/videos')).toHaveLength(0)
      expect(await post(base, '/api/video/tasks?source=newapi-generate', request)).toMatchObject({ ok: false, code: 'NO_TASK_ID' })
      const submissions = calls.filter(call => call.path === '/harness/v1/videos')
      expect(submissions).toHaveLength(1)
      const body = object(submissions[0]?.body)
      expect(body).toMatchObject({ model, seconds: 5, size: '720p', generate_audio: false,
        metadata: { resolution: '720p', ratio: '16:9', generate_audio: false } })
      const metadata = object(body.metadata)
      const content = metadata.content
      if (!Array.isArray(content)) throw new Error('Expected typed Ark reference content')
      expect(content.map(item => ({ type: object(item).type, role: object(item).role }))).toEqual([
        { type: 'text', role: undefined }, { type: 'image_url', role: 'reference_image' }, { type: 'video_url', role: 'reference_video' },
      ])
      expect(object(object(content[1]).image_url).url).toBe(`data:${String(image.contentType)};base64,${(await readFile(join(stateDir, 'refs', String(image.filename)))).toString('base64')}`)
      expect(object(object(content[2]).video_url).url).toBe(`data:video/mp4;base64,${generatedVideo.toString('base64')}`)
      for (const key of ['reference_video', 'reference_audio', 'first_frame_image', 'last_frame_image', 'seed']) expect(metadata).not.toHaveProperty(key)
      expect(body).not.toHaveProperty('images')
    },
  )

  it('preserves first and last frame roles and order in Ark content without duplicate image fields', async () => {
    const { base, stateDir } = await boot()
    await signIn(base)
    const model = 'doubao-seedance-2-0-260128'
    pricingRows = [{ model_name: model, supported_endpoint_types: ['openai-video'] }]
    const frames = []
    for (const [name, background] of [['first.png', '#cc5522'], ['last.png', '#2255cc']] as const) {
      frames.push(await uploadImage(base, '', name, await sharp({ create: { width: 4, height: 3, channels: 3, background } }).png().toBuffer()))
    }
    expect(await post(base, '/api/video/tasks?source=newapi-generate', { model, prompt: 'Move between frames',
      durationSeconds: 5, resolution: '720p', frameImages: frames.map(frame => frame.assetId), audio: true,
    })).toMatchObject({ ok: false, code: 'NO_TASK_ID' })
    const submissions = calls.filter(call => call.path === '/harness/v1/videos')
    expect(submissions).toHaveLength(1)
    const body = object(submissions[0]?.body)
    const metadata = object(body.metadata)
    expect(metadata).toMatchObject({ resolution: '720p', generate_audio: true })
    const content = metadata.content
    if (!Array.isArray(content)) throw new Error('Expected typed Ark frame content')
    expect(content.map(item => ({ type: object(item).type, role: object(item).role }))).toEqual([
      { type: 'text', role: undefined }, { type: 'image_url', role: 'first_frame' }, { type: 'image_url', role: 'last_frame' },
    ])
    for (const [index, frame] of frames.entries()) expect(object(object(content[index + 1]).image_url).url)
      .toBe(`data:${String(frame.contentType)};base64,${(await readFile(join(stateDir, 'refs', String(frame.filename)))).toString('base64')}`)
    expect(body).not.toHaveProperty('images')
    expect(metadata).not.toHaveProperty('first_frame_image')
    expect(metadata).not.toHaveProperty('last_frame_image')
  })

  it('requires a compatible live adaptive ratio for Seedance 2.5 frames and preserves it in the model tool', async () => {
    const { base, stateDir } = await boot()
    await signIn(base)
    const model = 'doubao-seedance-2-5-260628'
    const row = { model_name: model, supported_endpoint_types: ['openai-video'] }
    pricingRows = [row]
    relayModels.push({ id: model, object: 'model', supported_endpoint_types: ['openai-video'] })
    const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#cc5522' } }).png().toBuffer()
    const frame = await uploadImage(base, '', 'adaptive-frame.png', png)
    const body = { model, prompt: 'Move from this frame', durationSeconds: 5, resolution: '720p', frameImages: [frame.assetId] }
    expect(await post(base, '/api/video/tasks?source=newapi-generate', { ...body, ratio: '16:9' }))
      .toMatchObject({ ok: false, code: 'RATIO_NOT_SUPPORTED' })
    pricingRows = [{ ...row, parameters: { ratio: { enum: ['16:9'] } } }]
    expect(await post(base, '/api/video/tasks?source=newapi-generate', body))
      .toMatchObject({ ok: false, code: 'RATIO_NOT_SUPPORTED' })
    expect(calls.filter(call => call.path === '/harness/v1/videos')).toHaveLength(0)
    pricingRows = [{ ...row, parameters: { ratio: { enum: ['16:9', 'adaptive'] } } }]
    const listed = await context!.tools.execute({ callId: ToolCallId('frame-ratios'), name: 'list_video_models', arguments: {},
      agent: videoAgent(stateDir), signal: new AbortController().signal })
    expect(listed.value).toMatchObject({ status: 'listed', models: [expect.objectContaining({ id: model, frame_ratios: ['adaptive'], mix_frames_and_references: false })] })
    expect(await post(base, '/api/video/tasks?source=newapi-generate', body)).toMatchObject({ ok: false, code: 'NO_TASK_ID' })
    const submissions = calls.filter(call => call.path === '/harness/v1/videos')
    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.body).toMatchObject({ ratio: 'adaptive', aspect_ratio: 'adaptive', metadata: { ratio: 'adaptive',
      content: [expect.objectContaining({ type: 'text' }), expect.objectContaining({ type: 'image_url', role: 'first_frame' })] } })
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
    const image = await upload('image/png', 'image.png', await sharp({
      create: { width: 4, height: 3, channels: 4, background: '#cc552280' },
    }).png().toBuffer())
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
    expect(challenge?.body).toEqual({ phone_e164: '+8613800000000', idempotency_key: 'challenge-one', contract_version: 2 })
    expect(login?.body).toEqual({ phone_e164: '+8613800000000', code: '123456', challenge_id: '+8613800000000', idempotency_key: 'login-one', contract_version: 2 })
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

  it('renews idle Desktop presence through the Host timer without renderer account reads', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { base, api, stateDir } = await boot(undefined, false, true)
    await signIn(base)
    await context!.harnessAccount.refreshModels(api + '/v1')
    const cookie = await hostCookie(base)
    const sample = { session_id: '01234567-89ab-4cde-8fab-0123456789ab', event: 'heartbeat',
      foreground: false, platform: 'win32', app_version: '1.2.3' }
    expect(await post(base, '/api/activity', sample, cookie)).toEqual({ ok: true })
    const firstId = object(calls.find(call => call.path.endsWith('/client-activity/heartbeat'))?.body).session_id
    for (const expectedRefreshes of [1, 2]) {
      vi.setSystemTime(Date.now() + 14 * 60_000)
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => { expect(refreshes).toBe(expectedRefreshes) })
      await vi.waitFor(async () => {
        const stored = object(JSON.parse(await readFile(join(stateDir, 'session.json'), 'utf8')))
        expect(object(stored.upstream).token).toBe('access-renewed')
        expect(Date.parse(String(object(stored.upstream).expiresAt))).toBeGreaterThan(Date.now() + 60_000)
      })
      expect(await post(base, '/api/activity', sample, cookie)).toEqual({ ok: true })
      const report = calls.filter(call => call.path.endsWith('/client-activity/heartbeat')).at(-1)
      expect(report?.authorization).toBe('Bearer access-renewed')
      expect(object(report?.body).session_id).toBe(firstId)
    }
    expect(creations).toBe(0)
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

  it.each([429, 500, 503])('retains a still-valid login and shares HTTP %i cooldown across consumers', async (status) => {
    const { base, api, stateDir } = await boot(undefined, false, false, undefined, {
      refreshRetryBaseDelayMs: 10_000, refreshRecoveryRetryLimit: 0,
    })
    await signIn(base)
    const original = await readFile(join(stateDir, 'session.json'), 'utf8')
    refreshStatus = status
    refreshRetryAfter = '60'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 14 * 60_000 + 30_000)
    expect(await (await fetch(base + '/api/session')).json()).toMatchObject({ signedIn: true })
    await Promise.all([
      fetch(base + '/api/summary').then(response => response.json()),
      fetch(base + '/api/session').then(response => response.json()),
      context!.harnessAccount.refreshModels(api + '/v1'),
    ])
    expect(refreshes).toBe(1)
    expect(await readFile(join(stateDir, 'session.json'), 'utf8')).toBe(original)
    expect(await context!.credentials.resolve(relayRef)).toMatchObject({ value: 'sk-owned-relay' })
    expect(await readFile(join(stateDir, 'session.json.renewal'), 'utf8')).not.toMatch(/sk-owned|access-user|refresh-one/u)
    expect(creations).toBe(0)
  })

  it('requires login after a terminal refresh401 without retrying the revoked credential', async () => {
    const { base } = await boot()
    await signIn(base)
    refreshStatus = 401
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 16 * 60_000)
    expect(await (await fetch(base + '/api/session')).json()).toMatchObject({ signedIn: false })
    expect(await context!.credentials.resolve(relayRef)).toBeUndefined()
    await fetch(base + '/api/summary')
    await fetch(base + '/api/session')
    expect(refreshes).toBe(1)
    expect(creations).toBe(0)
  })

  it('does not repeatedly send a rejected bearer while refresh is rate limited', async () => {
    const { base } = await boot()
    await signIn(base)
    access = 'server-no-longer-accepts-the-old-bearer'
    refreshStatus = 429
    refreshRetryAfter = '60'
    expect(await (await fetch(base + '/api/session')).json()).toMatchObject({ signedIn: true, liveness: 'unknown' })
    const rejectedReads = calls.filter(call => call.path.endsWith('/user/self')).length
    for (let index = 0; index < 3; index += 1) {
      expect(await (await fetch(base + '/api/session')).json()).toMatchObject({ signedIn: true, liveness: 'unknown' })
      await fetch(base + '/api/summary')
    }
    expect(refreshes).toBe(1)
    expect(calls.filter(call => call.path.endsWith('/user/self'))).toHaveLength(rejectedReads)
    expect(await context!.credentials.resolve(relayRef)).toMatchObject({ value: 'sk-owned-relay' })
    expect(await chat()).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(calls.some(call => call.path.endsWith('/chat/completions'))).toBe(false)
  })

  it.each([7, 8])('preserves a concurrent new account %i when a captured old refresh401 arrives', async (id) => {
    const { base, stateDir } = await boot()
    await signIn(base)
    refreshStatus = 401
    refreshBarrier = new Promise<void>((resolve) => { releaseRefresh = resolve })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 16 * 60_000)
    const old = fetch(base + '/api/summary')
    try {
      await vi.waitFor(() => { expect(refreshes).toBe(1) })
      selfId = id
      relayKey = 'sk-replacement-relay'
      const challenge = await post(base, '/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'challenge-new-login' })
      const login = await post(base, '/api/session/verify', { challengeId: object(challenge.payload).challenge_id,
        code: '123456', idempotencyKey: 'login-new-account' })
      expect(login.ok).toBe(true)
      const replacement = await readFile(join(stateDir, 'session.json'), 'utf8')
      releaseRefresh?.()
      await old
      expect(await readFile(join(stateDir, 'session.json'), 'utf8')).toBe(replacement)
      expect(await context!.credentials.resolve(relayRef)).toMatchObject({ value: 'sk-replacement-relay' })
      expect(await (await fetch(base + '/api/session')).json()).toMatchObject({ signedIn: true, account: { id: String(id) } })
      expect(refreshes).toBe(1)
    } finally { releaseRefresh?.() }
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
