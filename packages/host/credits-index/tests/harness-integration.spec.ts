import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
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
import LlmRuntime, { ToolCallId, type FinishReason } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Credits from '../src/index.ts'
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
  relayModels = initialRelayModels()
  modelsStatus = 200
  modelsBarrier = undefined
  modelReadStarted = undefined
  releaseModels = undefined
  releaseRefresh = undefined
  refreshBarrier = undefined
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object')
  return value as Record<string, unknown>
}

async function boot(): Promise<{ base: string; api: string; stateDir: string }> {
  directory = await mkdtemp(join(tmpdir(), 'harness-product-integration-'))
  const stateDir = join(directory, 'credits')
  await mkdir(stateDir)
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body: unknown = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      calls.push({ path: url.pathname + url.search, body,
        ...request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization },
        ...request.headers.origin === undefined ? {} : { origin: request.headers.origin },
        ...request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie },
      })
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
          relay_key: 'sk-owned-relay', relay_key_id: 9, session: { sid: 'session-one', current: true },
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
      if (url.pathname === '/harness/v1/video/generations') {
        if (request.headers.authorization !== 'Bearer sk-owned-relay') { response.writeHead(403); response.end('{}'); return }
        response.end(JSON.stringify(videoTaskStatus === undefined ? {} : { code: 'success', data: { task_id: 'fixture-video-task' } })); return
      }
      if (url.pathname === '/harness/v1/video/generations/fixture-video-task') {
        if (request.headers.authorization !== 'Bearer sk-owned-relay') { response.writeHead(403); response.end('{}'); return }
        response.end(JSON.stringify({ code: 'success', data: { status: videoTaskStatus, result_url: 'https://ignored.invalid/content.mp4' } })); return
      }
      if (url.pathname === '/harness/v1/videos/fixture-video-task/content') {
        if (request.headers.authorization !== 'Bearer sk-owned-relay') { response.writeHead(403); response.end('{}'); return }
        response.setHeader('content-type', 'video/mp4'); response.end(generatedVideo); return
      }
      if (url.pathname === '/harness/v1/models') {
        if (request.headers.authorization !== 'Bearer sk-owned-relay') { response.writeHead(403); response.end('{}'); return }
        const rows = structuredClone(relayModels)
        modelReadStarted?.()
        await modelsBarrier
        response.writeHead(modelsStatus)
        response.end(JSON.stringify({ data: rows })); return
      }
      if (url.pathname === '/harness/v1/chat/completions') {
        if (request.headers.authorization !== 'Bearer sk-owned-relay') { response.writeHead(403); response.end('{}'); return }
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
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(directory, 'credentials.yaml'), dshHome: directory, watch: false } },
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
      'yunshu-local': { api: 'openai-completions', baseURL: api + '/v1', apiKeyEnv: relayRef, models: [{ id: 'deepseek-v4-flash' }] },
      'other-provider': { api: 'openai-completions', baseURL: 'https://synthetic.invalid/v1', models: [{ id: 'other-chat' }] },
    } } },
    { name: '@deepseek-ai/dsh-credits-index', config: { stateDir, newApiBaseUrl: api, relayTokenEnv: relayRef } },
  ]
  const configuration = join(directory, 'cordis.yml')
  await writeFile(configuration, JSON.stringify(entries))
  await profileComposition(context, directory, configuration)
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return { base: `http://127.0.0.1:${String(context.webServer.port)}/credits`, api, stateDir }
}

async function post(base: string, path: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return object(await response.json())
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

describe('deployed Harness API through the real product Loader', () => {
  it.each(['panel', 'chat'] as const)('submits H3 through the %s entry and saves uppercase generic task success', async (entry) => {
    const { base } = await boot()
    await signIn(base)
    pricingRows = [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'], enable_groups: ['default'] }]
    videoTaskStatus = 'SUCCESS'
    const outcome = entry === 'panel'
      ? await post(base, '/api/video/tasks?source=newapi-generate', { prompt: 'A synthetic clip', model: 'MiniMax-H3', durationSeconds: 4 })
      : object((await context!.tools.execute({ callId: ToolCallId('h3-chat-route'), name: 'generate_video',
        arguments: { prompt: 'A synthetic clip', model: 'MiniMax-H3', duration_seconds: 4 }, signal: new AbortController().signal })).value)
    const path = entry === 'panel' ? object(outcome.payload).path : outcome.path
    expect(outcome).toMatchObject(entry === 'panel' ? { ok: true, taskId: 'fixture-video-task' } : { status: 'succeeded', task_id: 'fixture-video-task' })
    if (typeof path !== 'string') throw new Error('Expected the saved video path')
    expect(await readFile(path)).toEqual(generatedVideo)
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
