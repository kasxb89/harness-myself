import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Tools from '@deepseek-ai/dsh-tools'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as Credits from '../src/index.ts'
import { CreativeStore } from '../src/creative-store.ts'
import { ImageResultStore, type ImageResultRef } from '../src/image-result-store.ts'
import { imageServerTaskId } from '../src/image-server-task.ts'
import candidateImages from './fixtures/codebloom-image-parameters-offline.json' with { type: 'json' }
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

const reference = credentialRef('MEDIA_SPECIFICATION_SYNTHETIC_RELAY')
const imageId = 'ycapi-gemini-3.1-flash-image'
const videoId = 'ycapi-seedance-2-0-official'
const rows = [
  { model_name: imageId, kind: 'image', parameters: { properties: {
    n: { enum: [1] }, reference_images: { maxItems: 0 }, output_format: { enum: ['png'] },
  }, oneOf: [
    { properties: { size: { const: '1024x1024' }, resolution: { const: '1k' }, quality: { const: 'pro' } } },
    { properties: { size: { const: '1024x1024' }, resolution: { const: '2k' }, quality: { const: 'max' } } },
  ] } },
  { model_name: videoId, kind: 'video', parameters: { properties: {
    frame_images: { maxItems: 0 }, reference_images: { maxItems: 0 }, reference_videos: { maxItems: 0 }, reference_audios: { maxItems: 0 },
    ratio: { const: '16:9' }, mode: { enum: [] },
  }, oneOf: [
    { properties: { resolution: { const: '720p' }, seconds: { const: 5 }, quality: { const: 'mini' } } },
    { properties: { resolution: { const: '720p' }, seconds: { const: 5 }, quality: { const: 'fast' } } },
    { properties: { resolution: { const: '1080p' }, seconds: { const: 10 }, quality: { const: 'standard' } } },
  ] } },
  { model_name: 'ycapi-minimax-m3', kind: 'text' },
  { model_name: 'ycapi-gpt-mini-tts', kind: 'audio' },
  { model_name: 'fixture-invalid-kind', kind: 'unrecognized' },
]
let context: Context | undefined
let upstream: Server | undefined
let directory: string | undefined
const calls: { path: string; body: Record<string, unknown> }[] = []
const imageWireCalls: { method: string; path: string; authorization: string | undefined; prefer?: string }[] = []
const retainedTaskId = 'task_codebloom_http_fixture'
const retainedTaskPath = `/harness/v1/tasks/${retainedTaskId}`
interface RetainedImageFixture {
  readonly body: 'truncated' | 'complete' | 'gateway-error' | 'accepted'
  readonly bytes?: Buffer
  readonly manifest?: 'wrong-task' | 'wrong-key' | 'wrong-prefix'
  readonly existingModel?: string
  readonly unknownReads?: number
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
async function post(base: string, path: string, body: object, headers: Record<string, string> = {}) {
  return object(await (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).json())
}
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (upstream !== undefined) await new Promise<void>((resolve, reject) => {
    upstream!.close((error) => { if (error === undefined) resolve(); else reject(error) })
    upstream!.closeAllConnections()
  })
  upstream = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  calls.length = 0
  imageWireCalls.length = 0
})

async function boot(visibleModels: readonly string[] = rows.map(row => row.model_name), authenticated = true,
  pricingRows: readonly { readonly model_name: string }[] = rows, retainedImage?: RetainedImageFixture) {
  directory = await mkdtemp(join(tmpdir(), 'dsh-media-specifications-'))
  const root = directory
  const pngBytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer()
  let api = '', generatedModel = retainedImage?.existingModel ?? '', taskReads = 0
  const contentUrl = () => `${api}/v1/tasks/${retainedTaskId}/artifacts/image-1/content?access=synthetic-content-capability`
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      let body: Record<string, unknown> = {}
      if (request.headers['content-type']?.startsWith('multipart/form-data')) {
        const form = await new Response(new Uint8Array(raw), { headers: { 'content-type': request.headers['content-type'] } }).formData()
        for (const [name, value] of form.entries()) {
          if (typeof value === 'string') body[name] = value
          else body[name] = { type: value.type, size: value.size,
            sha256: createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex') }
        }
      } else if (raw.length > 0) body = object(JSON.parse(raw.toString('utf8')))
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      calls.push({ path, body })
      imageWireCalls.push({ method: request.method ?? '', path, authorization: request.headers.authorization,
        ...typeof request.headers.prefer === 'string' ? { prefer: request.headers.prefer } : {} })
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown) => response.end(JSON.stringify({ success: true, data }))
      if (path === '/harness/api/status') {
        answer({ quota_per_unit: 500000, usd_exchange_rate: 7.3,
          client_media_defaults: { schema_version: 1, default_image_model: imageId, default_video_model: videoId } }); return
      }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: '+8613800000000', delivery_status: 'accepted', expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=synthetic; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'fixture-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-fixture-relay', relay_key_id: 9, session: { sid: 'fixture-session', current: true }, user: { id: 7, username: 'fixture', quota: 1000000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'fixture', group: 'default', quota: 1000000 }); return }
      if (path === '/harness/api/pricing') { answer(pricingRows); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 30, online_timeout_seconds: 90 }); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-fixture-relay')
        response.end(JSON.stringify({ data: pricingRows.filter(row => visibleModels.includes(row.model_name))
          .map(row => ({ id: row.model_name, supported_endpoint_types: ['openai'] })) })); return
      }
      if (path === '/harness/v1/uploads/images') {
        const file = object(body.file)
        answer({ id: 'file-synthetic-reference', url: 'https://assets.token6688.com/sha256/ab/' + 'c'.repeat(62) + '.png',
          mime_type: file.type, size: file.size }); return
      }
      if (retainedImage !== undefined && path === retainedTaskPath) {
        taskReads += 1
        response.end(JSON.stringify({ task_id: retainedTaskId, model: generatedModel,
          status: taskReads <= (retainedImage.unknownReads ?? 0) ? 'UNKNOWN' : 'SUCCESS' })); return
      }
      if (retainedImage !== undefined && path === `${retainedTaskPath}/artifacts`) {
        response.end(JSON.stringify({ task_id: retainedImage.manifest === 'wrong-task' ? 'task_another' : retainedTaskId,
          artifacts: [{ key: retainedImage.manifest === 'wrong-key' ? 'image-2' : 'image-1', type: 'image',
            content_url: retainedImage.manifest === 'wrong-prefix' ? contentUrl().replace('/harness/', '/other-prefix/') : contentUrl() }] })); return
      }
      if (retainedImage !== undefined && path === `${retainedTaskPath}/artifacts/image-1/content`) {
        expect(request.url).toBe(`${retainedTaskPath}/artifacts/image-1/content?access=synthetic-content-capability`)
        response.setHeader('content-type', 'image/png')
        response.end(retainedImage.bytes ?? pngBytes); return
      }
      if (path === '/harness/v1/images/generations' || path === '/harness/toapis/v1/images/generations' || path === '/harness/v1/images/edits') {
        expect(request.headers.authorization).toBe('Bearer sk-fixture-relay')
        if (retainedImage !== undefined) {
          generatedModel = String(body.model)
          response.setHeader('x-new-api-task-id', retainedTaskId)
          response.setHeader('x-oneapi-request-id', 'retained-fixture-request')
          if (retainedImage.body === 'accepted') {
            response.writeHead(202)
            response.end(JSON.stringify({ id: retainedTaskId, task_id: retainedTaskId, model: generatedModel, status: 'pending' })); return
          }
          if (retainedImage.body === 'gateway-error') {
            response.writeHead(502)
            response.end(JSON.stringify({ error: { message: 'Synthetic interrupted gateway response' } })); return
          }
          if (retainedImage.body === 'truncated') {
            response.setHeader('content-length', 512)
            response.setHeader('connection', 'close')
            response.flushHeaders()
            response.end('{"data":['); return
          }
          response.end(JSON.stringify({ data: [{ url: contentUrl() }] })); return
        }
        response.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] })); return
      }
      if (path === '/harness/v1/videos') {
        expect(request.headers.authorization).toBe('Bearer sk-fixture-relay')
        response.end('{}'); return
      }
      response.writeHead(404); response.end('{}')
    })().catch(() => response.destroy())
  })
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('Expected listener')
  api = `http://127.0.0.1:${address.port}/harness`
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem], ['@deepseek-ai/dsh-credits-index', Credits],
    ['@deepseek-ai/dsh-session', SessionStore],
  ])
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
    { name: '@deepseek-ai/dsh-client-connection' },
    { name: '@deepseek-ai/dsh-tools' }, { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-fs-local', config: { cwd: root } },
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(root, 'credentials.yaml'), dshHome: root, watch: false } },
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'yunshu-local': {
      api: 'openai-completions', baseURL: api + '/v1', apiKeyEnv: reference, models: [{ id: 'ycapi-minimax-m3' }],
    } } } },
    { name: '@deepseek-ai/dsh-credits-index', config: { stateDir: join(root, 'credits'), newApiBaseUrl: api,
      relayTokenEnv: reference, accountReadMinIntervalMs: 0, accountReadFailureCooldownMs: 1, mediaCatalogCacheTtlMs: 0,
      ...retainedImage === undefined ? {} : { imagePollIntervalMs: 1 } } },
  ]))
  await profileComposition(context, root, configuration)
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const base = `http://127.0.0.1:${context.webServer.port}/credits`
  if (!authenticated) return base
  const challenge = await post(base, '/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'challenge' })
  expect(challenge.ok).toBe(true)
  expect((await post(base, '/api/session/verify', { challengeId: object(challenge.payload).challenge_id, code: '123456', idempotencyKey: 'login' })).ok).toBe(true)
  return base
}

describe('complete media specifications through the shipped Host Loader', () => {
  it('limits signed-in creation menus to the account relay model directory without submitting generation', async () => {
    const base = await boot([imageId])
    const current = object(await (await fetch(base + '/api/media/catalog')).json())
    expect(current.ok).toBe(true)
    const catalog = object(current.payload)
    expect(catalog.image).toEqual([expect.objectContaining({ id: imageId })])
    expect(catalog.video).toEqual([])
    expect(catalog.audio).toEqual([])
    const active = context
    if (active === undefined) throw new Error('Expected current Host')
    const login = new URL(active.connection.authenticatedUrl(new URL(base).origin))
    const headers: Record<string, string> = {}
    active.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: login.host } }, {
      writeHead(_status, values) { Object.assign(headers, values) }, end() {},
    })
    const cookie = headers['set-cookie']?.split(';')[0]
    if (cookie === undefined) throw new Error('Expected authenticated Host cookie')
    const preference = object(await (await fetch(base + '/api/media/preferences/catalog', { headers: { cookie } })).json())
    expect(preference, JSON.stringify(preference)).toMatchObject({ ok: true })
    const defaults = object(object(preference.payload).defaults)
    expect(defaults.image).toMatchObject({ model: imageId, configured: true, available: true })
    expect(defaults.video).toMatchObject({ model: videoId, configured: true, available: false })
    expect(calls.filter(call => call.path === '/harness/v1/models').length).toBeGreaterThan(0)
    expect(calls.filter(call => call.path === '/harness/v1/images/generations' || call.path === '/harness/v1/videos')).toEqual([])
  })

  it('keeps unsigned public draft menus available without reading a relay model list', async () => {
    const base = await boot([], false)
    const current = object(await (await fetch(base + '/api/media/catalog')).json())
    expect(current.ok).toBe(true)
    const catalog = object(current.payload)
    expect(catalog.image).toEqual([expect.objectContaining({ id: imageId })])
    expect(catalog.video).toEqual([expect.objectContaining({ id: videoId })])
    expect(calls.filter(call => call.path === '/harness/v1/models')).toEqual([])
  })

  it('submits exactly one declared image with its quality/resolution and blocks count or reference escalation', async () => {
    const base = await boot()
    const body = { model: imageId, prompt: 'A synthetic test image', size: '1024x1024', resolution: '1k', quality: 'pro' }
    expect(await post(base, '/api/image/generate', { ...body, count: 2 })).toMatchObject({ ok: false, code: 'COUNT_NOT_SUPPORTED' })
    expect(await post(base, '/api/image/generate', { ...body, references: ['ma_synthetic'] })).toMatchObject({ ok: false, code: 'REFERENCES_NOT_SUPPORTED' })
    expect(await post(base, '/api/image/generate', { ...body, quality: 'max' })).toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
    expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toHaveLength(0)
    expect(await post(base, '/api/image/generate', { ...body, count: 1 })).toMatchObject({ ok: true })
    expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toEqual([{ path: '/harness/v1/images/generations',
      body: { model: imageId, prompt: body.prompt, n: 1, response_format: 'b64_json', size: '1024x1024', resolution: '1k', quality: 'pro' } }])
  })

  it('requires an unambiguous video quality and sends its complete native parameters without changing count', async () => {
    const base = await boot()
    const body = { model: videoId, prompt: 'A synthetic test clip', durationSeconds: 5, resolution: '720p', ratio: '16:9' }
    expect(await post(base, '/api/video/tasks?source=newapi-generate', body)).toMatchObject({ ok: false, code: 'SPECIFICATION_REQUIRED' })
    expect(await post(base, '/api/video/tasks?source=newapi-generate', { ...body, quality: 'standard' })).toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
    expect(await post(base, '/api/video/tasks?source=newapi-generate', { ...body, quality: 'fast', referenceVideos: ['ma_synthetic'] })).toMatchObject({ ok: false, code: 'REFERENCES_NOT_SUPPORTED' })
    expect(calls.filter(call => call.path === '/harness/v1/videos')).toHaveLength(0)
    expect(await post(base, '/api/video/tasks?source=newapi-generate', { ...body, quality: 'fast' })).toMatchObject({ ok: false, code: 'NO_TASK_ID' })
    expect(calls.filter(call => call.path === '/harness/v1/videos')).toEqual([{ path: '/harness/v1/videos', body: {
      model: videoId, prompt: body.prompt, duration: 5, seconds: 5, resolution: '720p', size: '720p', ratio: '16:9', aspect_ratio: '16:9',
      quality: 'fast', metadata: { ratio: '16:9' },
    } }])
  })

  it('keeps speech and invalid pricing classifications out of the agent model picker', async () => {
    await boot()
    expect((await context!.llm.listModels('yunshu-local')).map(model => model.id)).toEqual(['ycapi-minimax-m3'])
  })
})


async function recordImageSizeCase(name: string, result: object): Promise<void> {
  const output = process.env.DSH_MEDIA_SIZE_AUDIT_OUTPUT_DIR
  if (output !== undefined) await writeFile(join(output, name + '.json'), JSON.stringify(result, null, 2) + '\n')
}

const candidateIds = candidateImages.map(row => row.model_name)
const noSizeCandidates = candidateImages.filter(row => row.parameters.properties.size === false)

describe('explicit image size declarations through the shipped Host Loader', () => {
  it.for(noSizeCandidates)('$model_name refuses an explicit size when its live declaration disables sizes', async (row) => {
    const base = await boot(candidateIds, true, candidateImages)
    const result = await post(base, '/api/image/generate', { model: row.model_name, prompt: 'One synthetic image', size: '1024x1024' })
    const submitted = calls.filter(call => call.path === '/harness/v1/images/generations')
    await recordImageSizeCase(row.model_name + '-blocked-size', { model: row.model_name, result, submitted })
    expect(result).toMatchObject({ ok: false, code: 'SIZE_NOT_SUPPORTED', submission_state: 'not-submitted' })
    expect(submitted).toEqual([])
  })

  it.for(candidateImages)('$model_name submits only its declared image parameters', async (row) => {
    const base = await boot(candidateIds, true, candidateImages)
    const supportsSize = row.parameters.properties.size !== false
    const body = { model: row.model_name, prompt: 'One synthetic image', ...supportsSize ? { size: '1024x1024' } : {} }
    const rejected: { extra: object; result: Record<string, unknown> }[] = []
    for (const [extra, code] of [
      [{ quality: 'high' }, 'QUALITY_NOT_SUPPORTED'], [{ format: 'png' }, 'FORMAT_NOT_SUPPORTED'],
      [{ resolution: '2k' }, 'RESOLUTION_NOT_SUPPORTED'], [{ count: 2 }, 'COUNT_NOT_SUPPORTED'],
      [{ references: ['ma_synthetic'] }, 'REFERENCES_NOT_SUPPORTED'],
    ] as const) {
      const result = await post(base, '/api/image/generate', { ...body, ...extra })
      expect(result).toMatchObject({ ok: false, code, submission_state: 'not-submitted' })
      rejected.push({ extra, result })
    }
    if (supportsSize) {
      const result = await post(base, '/api/image/generate', { ...body, size: '2048x2048' })
      expect(result).toMatchObject({ ok: false, code: 'SIZE_NOT_SUPPORTED', submission_state: 'not-submitted' })
      rejected.push({ extra: { size: '2048x2048' }, result })
    }
    expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toEqual([])
    const result = await post(base, '/api/image/generate', body)
    expect(result).toMatchObject({ ok: true })
    const submitted = calls.filter(call => call.path === '/harness/v1/images/generations')
    expect(submitted).toEqual([{ path: '/harness/v1/images/generations', body: {
      model: row.model_name, prompt: body.prompt, n: 1, response_format: 'b64_json', ...supportsSize ? { size: '1024x1024' } : {},
    } }])
    await recordImageSizeCase(row.model_name + '-parameters', { model: row.model_name, result, rejected, submitted })
  })

  it('keeps an undeclared legacy size menu compatible with an explicit size', async () => {
    const model = 'legacy-image-provider'
    const legacy = [{ model_name: model, kind: 'image', parameters: { properties: {
      n: { enum: [1] }, reference_images: { maxItems: 0 },
    } } }]
    const base = await boot([model], true, legacy)
    const catalog = object(object(await (await fetch(base + '/api/media/catalog')).json()).payload)
    if (!Array.isArray(catalog.image)) throw new Error('Expected image catalog')
    expect(catalog.image).toHaveLength(1)
    const capability = object(catalog.image[0])
    expect(capability.id).toBe(model)
    expect(object(capability.params).sizes).toEqual([])
    expect(capability.notes).toEqual([])
    const result = await post(base, '/api/image/generate', { model, prompt: 'One synthetic legacy image', size: '640x480' })
    expect(result).toMatchObject({ ok: true })
    const submitted = calls.filter(call => call.path === '/harness/v1/images/generations')
    expect(submitted).toEqual([{ path: '/harness/v1/images/generations', body: {
      model, prompt: 'One synthetic legacy image', n: 1, response_format: 'b64_json', size: '640x480',
    } }])
    await recordImageSizeCase('legacy-undeclared-size', { model, result, submitted })
  })
})

function retainedCandidate() {
  const row = noSizeCandidates[0]
  if (row === undefined) throw new Error('Expected a reviewed prompt-only image candidate')
  return row
}

async function publishedImageFiles(): Promise<string[]> {
  if (directory === undefined) throw new Error('Expected current Host directory')
  try {
    return (await readdir(join(directory, 'credits', 'media'), { recursive: true }))
      .filter(name => /\.(?:png|jpe?g|webp)$/iu.test(name))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

async function recordRecoveryRoute(name: string, result: object,
  evidence?: { readonly savedPath: string; readonly facts: object }): Promise<void> {
  const output = process.env.DSH_IMAGE_RECOVERY_ROUTE_AUDIT_DIR
  if (output === undefined) return
  await mkdir(output, { recursive: true })
  const path = object(result).payload
  const savedPath = evidence?.savedPath ?? (path === null || typeof path !== 'object' || Array.isArray(path) ? undefined : object(path).path)
  let savedImage: { file: string; bytes: number; sha256: string } | undefined
  if (typeof savedPath === 'string') {
    const bytes = await readFile(savedPath)
    const file = name + extname(savedPath)
    await copyFile(savedPath, join(output, file))
    savedImage = { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  await writeFile(join(output, name + '.json'), JSON.stringify({ result, calls,
    wire: imageWireCalls.map(call => ({ method: call.method, path: call.path,
      credential: call.authorization === 'Bearer sk-fixture-relay' ? 'synthetic-owner-relay' : call.authorization === undefined ? 'none' : 'unexpected' })),
    publishedImageFiles: await publishedImageFiles(),
    ...savedImage === undefined ? {} : { savedImage },
    ...evidence === undefined ? {} : { evidence: evidence.facts },
    scope: 'Real Host Loader and loopback HTTP/file IO; synthetic metadata/account/access placeholder; image bytes supplied by the fixture. No provider POST or actual HMAC verification in this test.' }, null, 2) + '\n')
}

describe('retained image recovery through the shipped Host HTTP and file IO', () => {
  it('publishes a YCAPI result in the client project after an accepted gateway error and temporary unknown status', async () => {
    const original = retainedCandidate(), sessionId = 'ycapi-recovered-image-chat'
    const row = { ...original, model_name: 'ycapi-flux-kontext', parameters: { ...original.parameters,
      'x-task-plugin': { key: 'ycapi', version: '1.0.0', api_version: 1 },
      'x-image-receipt-recovery': { schema_version: 1, submit_model_metadata: true, original_task_artifacts: true } } }
    const inputImage = process.env.DSH_IMAGE_RECOVERY_INPUT_IMAGE
    const pngBytes = inputImage === undefined
      ? await sharp({ create: { width: 2, height: 2, channels: 3, background: '#12aabb' } }).png().toBuffer()
      : await readFile(inputImage)
    const inputMetadata = await sharp(pngBytes).metadata()
    const base = await boot([row.model_name], true, [row], { body: 'gateway-error', bytes: pngBytes, unknownReads: 1 })
    const active = context, root = directory
    if (active === undefined || root === undefined) throw new Error('Expected active Host and isolated files')
    active.sessions.create(SessionId(sessionId), { meta: { cwd: await realpath(root) } })
    const login = new URL(active.connection.authenticatedUrl(new URL(base).origin)), headers: Record<string, string> = {}
    active.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: login.host } }, {
      writeHead(_status, values) { Object.assign(headers, values) }, end() {},
    })
    const cookie = headers['set-cookie']?.split(';')[0]
    if (cookie === undefined) throw new Error('Expected authenticated Host cookie')
    const result = await post(base, '/api/image/generate', { session_id: sessionId, account_id: '7', model: row.model_name,
      prompt: 'One synthetic YCAPI recovery image' }, { cookie })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, submission_state: 'completed', task_id: retainedTaskId })
    const projects = object(object(await (await fetch(base + '/api/creative/projects?session_id=' + sessionId,
      { headers: { cookie } })).json()).payload).projects
    if (!Array.isArray(projects)) throw new Error('Expected client project projection')
    const project = projects.map(object).find(value => value.id === result.plan_id)
    expect(project).toMatchObject({ kind: 'image', tasks: [expect.objectContaining({ id: result.operation_id, status: 'completed' })] })
    if (!Array.isArray(project?.outputs)) throw new Error('Expected visible recovered image output')
    expect(project.outputs).toHaveLength(1)
    const output = object(project.outputs[0])
    if (typeof output.url !== 'string') throw new Error('Expected authenticated client preview URL')
    const preview = await fetch(new URL(output.url, base), { headers: { cookie } })
    expect(preview.status).toBe(200)
    const previewBytes = Buffer.from(await preview.arrayBuffer())
    expect(previewBytes).toEqual(pngBytes)
    expect((await sharp(previewBytes).metadata())).toMatchObject({ width: inputMetadata.width, height: inputMetadata.height, format: 'png' })
    const owner = { accountId: '7', sessionFingerprint: createHash('sha256').update('fixture-access').digest('hex'),
      sessionId, workspaceRoot: await realpath(root) }
    const restored = new CreativeStore({ directory: join(root, 'credits', 'creative-projects'),
      current: async () => owner, video: async () => { throw new Error('No video in image recovery') } })
    expect((await restored.projects(owner))[0]).toMatchObject({ id: result.plan_id,
      outputs: [expect.objectContaining({ kind: 'image' })], tasks: [expect.objectContaining({ status: 'completed' })] })
    expect(imageWireCalls.filter(call => call.method === 'POST' && call.path.endsWith('/images/generations'))).toHaveLength(1)
    expect(imageWireCalls.filter(call => call.path === retainedTaskPath)).toHaveLength(2)
    expect(imageWireCalls.filter(call => call.path === `${retainedTaskPath}/artifacts`)).toHaveLength(1)
    await recordRecoveryRoute('ycapi-gateway-error-client-preview', result)
  })

  it('stops a YCAPI image on the current older gateway before a paid submission', async () => {
    const original = retainedCandidate()
    const row = { ...original, model_name: 'ycapi-flux-kontext', parameters: { ...original.parameters,
      'x-task-plugin': { key: 'ycapi', version: '1.0.0', api_version: 1 } } }
    const base = await boot([row.model_name], true, [row])
    const result = await post(base, '/api/image/generate', { model: row.model_name, prompt: 'Do not submit this image' })
    expect(result).toMatchObject({ ok: false, code: 'IMAGE_SERVER_UPDATE_REQUIRED', submission_state: 'not-submitted' })
    expect(calls.filter(call => call.path.endsWith('/images/generations'))).toEqual([])
    expect(await publishedImageFiles()).toEqual([])
  })

  it('recovers a truncated opted-in response through only the original task, manifest and signed image', async () => {
    const row = retainedCandidate()
    const pngBytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer()
    const base = await boot([row.model_name], true, [row], { body: 'truncated', bytes: pngBytes })
    const result = await post(base, '/api/image/generate', { model: row.model_name, prompt: 'One synthetic retained image' })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, submission_state: 'completed', task_id: retainedTaskId })
    const path = object(result.payload).path
    if (typeof path !== 'string') throw new Error('Expected saved original image path')
    const saved = await readFile(path)
    expect(saved).toEqual(pngBytes)
    const decoded = await sharp(saved).raw().toBuffer({ resolveWithObject: true })
    expect(decoded.info).toMatchObject({ width: 1, height: 1, channels: 3 })
    expect(decoded.data).toEqual(Buffer.from([255, 255, 255]))
    expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toHaveLength(1)
    expect(imageWireCalls.filter(call => call.path.startsWith(retainedTaskPath))).toEqual([
      { method: 'GET', path: retainedTaskPath, authorization: 'Bearer sk-fixture-relay' },
      { method: 'GET', path: `${retainedTaskPath}/artifacts`, authorization: 'Bearer sk-fixture-relay' },
      { method: 'GET', path: `${retainedTaskPath}/artifacts/image-1/content`, authorization: undefined },
    ])
    expect(await publishedImageFiles()).toHaveLength(1)
    await recordRecoveryRoute('truncated-original-result', result)
  })

  it('recovers an original server task through Host when its linked private manifest cannot be read', async () => {
    const row = retainedCandidate()
    const pngBytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer()
    const base = await boot([row.model_name], true, [row], { body: 'complete', bytes: pngBytes, existingModel: row.model_name })
    const active = context, root = directory, address = upstream?.address()
    if (active === undefined || root === undefined || address === undefined || address === null || typeof address === 'string') {
      throw new Error('Expected current Host, private directory and loopback listener')
    }
    const login = new URL(active.connection.authenticatedUrl(new URL(base).origin))
    const authorization: Record<string, string> = {}
    active.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: login.host } }, {
      writeHead(_status, values) { Object.assign(authorization, values) }, end() {},
    })
    const cookie = authorization['set-cookie']?.split(';')[0]
    if (cookie === undefined) throw new Error('Expected authenticated Host cookie')
    const owner = { accountId: '7', sessionFingerprint: createHash('sha256').update('fixture-access').digest('hex'),
      sessionId: 'original-image-chat', workspaceRoot: await realpath(root) }
    const current = async () => ({ accountId: owner.accountId, sessionFingerprint: owner.sessionFingerprint })
    const projectsDirectory = join(root, 'credits', 'creative-projects')
    const storeOptions = { directory: projectsDirectory, current, video: async () => { throw new Error('No video in this proof') } }
    const creative = new CreativeStore(storeOptions)
    const operation = await creative.begin(owner, { kind: 'image', prompt: 'One original retained image', shots: [{ prompt: 'One original retained image' }] })
    const serverTaskId = imageServerTaskId(retainedTaskId)
    if (serverTaskId === undefined) throw new Error('Expected synthetic original server task ID')
    const receipt = { model: row.model_name, route: '/v1/images/generations', phase: 'accepted' as const, serverTaskId,
      backendFingerprint: createHash('sha256').update(`http://127.0.0.1:${address.port}/harness`).digest('hex') }
    await creative.receipt(operation, receipt)
    const resultDirectory = join(root, 'credits', 'image-results')
    const images = new ImageResultStore({ directory: resultDirectory, current })
    const scope = { owner, operationId: operation.operationId, backendFingerprint: receipt.backendFingerprint }
    let linkedReference: ImageResultRef | undefined
    await expect(images.retain(scope, receipt, [{ url: `http://127.0.0.1:${address.port}/old-private-source.png` }], async (ref) => {
      linkedReference = ref
      await creative.imageResult(operation, ref)
      // Inject an actual local atomic-publication failure after the original reference is committed.
      await mkdir(join(resultDirectory, ref, 'manifest.json'))
    })).rejects.toMatchObject({ code: 'IMAGE_RESULT_PERSISTENCE_UNAVAILABLE' })
    if (linkedReference === undefined) throw new Error('Expected the independently persisted original result reference')
    const privateManifest = join(resultDirectory, linkedReference, 'manifest.json')
    await rm(privateManifest, { recursive: true })
    await expect(images.load(scope, linkedReference)).rejects.toMatchObject({ code: 'IMAGE_RESULT_UNAVAILABLE' })
    await creative.finish(operation, { status: 'unknown' })
    creative.release(operation)
    const restored = new CreativeStore(storeOptions)
    const retained = await restored.resumeImage(owner, operation.projectId, operation.operationId)
    expect(retained).toMatchObject({ receipt, imageResultRef: linkedReference })
    restored.release(retained.operation)

    const recovering = await post(base, '/api/creative/image/recover', { session_id: owner.sessionId,
      project_id: operation.projectId, operation_id: operation.operationId }, { cookie })
    expect(recovering, JSON.stringify(recovering)).toMatchObject({ ok: true })
    let completed: Record<string, unknown> = {}
    await expect.poll(async () => {
      completed = object(await (await fetch(base + '/api/creative/projects?session_id=' + owner.sessionId, { headers: { cookie } })).json())
      const projects = object(completed.payload).projects
      if (!Array.isArray(projects)) throw new Error('Expected projects from the actual Host route')
      const project = projects.map(object).find(value => value.id === operation.projectId)
      const tasks = project?.tasks
      if (!Array.isArray(tasks)) throw new Error('Expected original project tasks')
      return tasks.map(object).find(value => value.id === operation.operationId)?.status
    }).toBe('completed')
    const projectPath = join(projectsDirectory, operation.projectId, 'project.json')
    const record = object(JSON.parse(await readFile(projectPath, 'utf8')))
    const operations = record.operations
    if (!Array.isArray(operations)) throw new Error('Expected durable original operation')
    expect(operations).toHaveLength(1)
    const original = operations.map(object).find(value => value.id === operation.operationId)
    expect(original).toMatchObject({ status: 'completed', imageResultRef: linkedReference, imageReceipt: { serverTaskId } })
    if (!Array.isArray(original?.outputs)) throw new Error('Expected original saved output')
    expect(original.outputs).toHaveLength(1)
    const savedPath = original.outputs.map(object)[0]?.path
    if (typeof savedPath !== 'string') throw new Error('Expected actual recovered image file')
    const saved = await readFile(savedPath)
    expect(saved).toEqual(pngBytes)
    expect((await sharp(saved).raw().toBuffer({ resolveWithObject: true })).info).toMatchObject({ width: 1, height: 1, channels: 3 })
    await expect(readFile(privateManifest)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(resultDirectory)).filter(name => /^ir_[a-f0-9]{64}$/u.test(name))).toEqual([linkedReference])
    expect(imageWireCalls.filter(call => call.method === 'POST' && call.path.endsWith('/images/generations'))).toEqual([])
    expect(imageWireCalls.filter(call => call.path.startsWith(retainedTaskPath))).toEqual([
      { method: 'GET', path: retainedTaskPath, authorization: 'Bearer sk-fixture-relay' },
      { method: 'GET', path: `${retainedTaskPath}/artifacts`, authorization: 'Bearer sk-fixture-relay' },
      { method: 'GET', path: `${retainedTaskPath}/artifacts/image-1/content`, authorization: undefined },
    ])
    expect(calls.filter(call => call.path === '/old-private-source.png')).toEqual([])
    expect(await publishedImageFiles()).toHaveLength(1)
    expect(JSON.stringify(completed)).not.toContain(linkedReference)
    await recordRecoveryRoute('missing-private-manifest', completed, { savedPath, facts: { recovering, originalReferencePreserved: true,
      source: 'Actual CreativeStore/ImageResultStore local atomic-publication fault; original synthetic server receipt seeded before Host query.',
      manifestStillMissing: true, noReplacementReference: true, originalServerTaskId: serverTaskId } })
  })

  it.for(['html', 'json'])('does not publish HTTP200 %s error bytes as a recovered image', async (kind) => {
    const row = retainedCandidate()
    const bytes = Buffer.from(kind === 'html' ? '<!doctype html><p>Synthetic CDN error</p>' : '{"error":"Synthetic CDN error"}')
    const base = await boot([row.model_name], true, [row], { body: 'truncated', bytes })
    const result = await post(base, '/api/image/generate', { model: row.model_name, prompt: 'One synthetic retained image' })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, submission_state: 'pending',
      task_id: retainedTaskId, code: 'IMAGE_RESULT_INVALID' })
    expect(result.payload).toBeNull()
    expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toHaveLength(1)
    expect(imageWireCalls.filter(call => call.path === `${retainedTaskPath}/artifacts/image-1/content`))
      .toEqual([{ method: 'GET', path: `${retainedTaskPath}/artifacts/image-1/content`, authorization: undefined }])
    expect(await publishedImageFiles()).toEqual([])
    await recordRecoveryRoute('non-image-' + kind, result)
  })

  it.for(['wrong-task', 'wrong-key', 'wrong-prefix'] as const)('rejects the %s manifest without downloading or generating again', async (manifest) => {
    const row = retainedCandidate()
    const base = await boot([row.model_name], true, [row], { body: 'truncated', manifest })
    const result = await post(base, '/api/image/generate', { model: row.model_name, prompt: 'One synthetic retained image' })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, submission_state: 'pending', task_id: retainedTaskId })
    expect(calls.filter(call => call.path === '/harness/v1/images/generations')).toHaveLength(1)
    expect(imageWireCalls.filter(call => call.path.startsWith(retainedTaskPath))).toEqual([
      { method: 'GET', path: retainedTaskPath, authorization: 'Bearer sk-fixture-relay' },
      { method: 'GET', path: `${retainedTaskPath}/artifacts`, authorization: 'Bearer sk-fixture-relay' },
    ])
    expect(imageWireCalls.filter(call => call.path.startsWith('/other-prefix/'))).toEqual([])
    expect(await publishedImageFiles()).toEqual([])
    await recordRecoveryRoute(manifest, result)
  })

  it.for(['missing-marker', 'unsupported-version', 'toapis'] as const)('ignores a task header for %s and preserves the unknown single submission', async (mode) => {
    const original = retainedCandidate()
    const model = mode === 'toapis' ? 'yunshu-internal-gpt-image-2' : original.model_name
    const parameters = { ...original.parameters, 'x-task-plugin': mode === 'missing-marker' ? undefined
      : { key: mode === 'toapis' ? 'toapis' : 'codebloom-image', version: mode === 'toapis' ? '1.2.1' : '1.0.1', api_version: 1 } }
    const row = { ...original, model_name: model, parameters,
      ...mode === 'toapis' ? { route: '/toapis/v1/images/generations' } : {} }
    const base = await boot([model], true, [row], { body: 'truncated' })
    const result = await post(base, '/api/image/generate', { model, prompt: 'One synthetic image' })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, submission_state: 'unknown', task_id: null })
    expect(imageWireCalls.filter(call => call.method === 'POST'
      && (call.path === '/harness/v1/images/generations' || call.path === '/harness/toapis/v1/images/generations'))).toHaveLength(1)
    expect(imageWireCalls.filter(call => call.path.startsWith(retainedTaskPath))).toEqual([])
    expect(await publishedImageFiles()).toEqual([])
    await recordRecoveryRoute(mode, result)
  })

  it.for(['png', 'jpeg', 'webp'] as const)('preserves a valid legacy Toapis %s result with an unrelated task header', async (format) => {
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).toFormat(format).toBuffer()
    const original = retainedCandidate(), model = 'yunshu-internal-gpt-image-2'
    const row = { ...original, model_name: model, route: '/toapis/v1/images/generations',
      parameters: { ...original.parameters, 'x-task-plugin': { key: 'toapis', version: '1.2.1', api_version: 1 } } }
    const base = await boot([model], true, [row], { body: 'complete', bytes })
    const result = await post(base, '/api/image/generate', { model, prompt: 'One synthetic legacy image' })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, submission_state: 'completed', task_id: null })
    const path = object(result.payload).path
    if (typeof path !== 'string') throw new Error('Expected saved legacy image path')
    const saved = await readFile(path)
    expect(saved).toEqual(bytes)
    const decoded = await sharp(saved).raw().toBuffer({ resolveWithObject: true })
    expect(decoded.info).toMatchObject({ width: 1, height: 1, channels: 3 })
    expect(path.endsWith(format === 'jpeg' ? '.jpg' : '.' + format)).toBe(true)
    expect(imageWireCalls.filter(call => call.path === '/harness/toapis/v1/images/generations')).toHaveLength(1)
    expect(imageWireCalls.filter(call => call.path === retainedTaskPath || call.path === `${retainedTaskPath}/artifacts`)).toEqual([])
    expect(await publishedImageFiles()).toHaveLength(1)
    await recordRecoveryRoute('legacy-valid-' + format, result)
  })
})

describe('reference image edits through the shipped Host Loader', () => {
  it.each(['ycapi', 'codebloom-image'] as const)('saves the original %s edit after a truncated response and submits only once', async (plugin) => {
    const model = plugin === 'ycapi' ? 'ycapi-flux-kontext' : 'ys-gpt-image-2k'
    const size = plugin === 'ycapi' ? '1:1' : '1024x1024'
    const properties = { n: { enum: [1] }, reference_images: { maxItems: 1 }, size: { enum: [size] },
      quality: false, resolution: false, output_format: false, background: false, moderation: false, seed: false }
    const row = { model_name: model, kind: 'image', parameters: {
      type: 'object', additionalProperties: false, properties, 'x-model-kind': 'image',
      'x-task-plugin': { key: plugin, version: '1.0.0', api_version: 1 },
      ...plugin !== 'ycapi' ? {} : { 'x-image-receipt-recovery': { schema_version: 1, submit_model_metadata: true, original_task_artifacts: true } },
      'x-image-edit': { schema_version: 1, max_reference_bytes: 5 * 1024 * 1024,
        specifications: [{ properties: { size: { enum: [size] } } }],
        ...plugin !== 'ycapi' ? {} : { reference_upload: { path: '/v1/uploads/images', origin: 'https://assets.token6688.com' } } },
    } }
    const actual = process.env.DSH_IMAGE_EDIT_ORIGINAL_IMAGE
    const bytes = actual === undefined ? await sharp({ create: { width: 8, height: 8, channels: 3, background: '#9922bb' } }).png().toBuffer() : await readFile(actual)
    const referenceBytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ee2222' } }).png().toBuffer()
    const base = await boot([model], true, [row], { body: 'truncated', bytes })
    if (directory === undefined) throw new Error('Expected isolated Host directory')
    const refs = join(directory, 'credits', 'refs')
    await mkdir(refs, { recursive: true })
    await writeFile(join(refs, 'ma_edit.png'), referenceBytes)
    await writeFile(join(refs, 'ma_edit.png.json'), JSON.stringify({ mediaType: 'image/png', originalName: 'reference.png', accountId: '7' }))
    const result = await post(base, '/api/image/generate', { model, prompt: 'Change only the red circle to purple', size, references: ['ma_edit'] })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, submission_state: 'completed', task_id: retainedTaskId })
    const payload = object(result.payload)
    if (typeof payload.path !== 'string') throw new Error('Expected published original image path')
    expect(await readFile(payload.path)).toEqual(bytes)
    expect((await sharp(await readFile(payload.path)).metadata()).width).toBe((await sharp(bytes).metadata()).width)
    const edits = calls.filter(call => call.path === '/harness/v1/images/edits')
    expect(edits).toHaveLength(1)
    expect(calls.filter(call => call.path.endsWith('/images/generations'))).toHaveLength(0)
    if (plugin === 'ycapi') {
      expect(calls.filter(call => call.path === '/harness/v1/uploads/images')).toHaveLength(1)
      expect(edits[0]?.body).toMatchObject({ model, n: 1, size, image: ['https://assets.token6688.com/sha256/ab/' + 'c'.repeat(62) + '.png'] })
    } else {
      expect(calls.filter(call => call.path === '/harness/v1/uploads/images')).toHaveLength(0)
      expect(edits[0]?.body).toMatchObject({ model, n: '1', size, 'image[]': { type: 'image/png', size: referenceBytes.length,
        sha256: createHash('sha256').update(referenceBytes).digest('hex') } })
    }
    expect(imageWireCalls.filter(call => call.path === retainedTaskPath)).toHaveLength(1)
    expect(imageWireCalls.filter(call => call.path === `${retainedTaskPath}/artifacts`)).toHaveLength(1)
    await recordRecoveryRoute(plugin + '-reference-edit-original-save', result)
  })

  it('blocks an unverified edit tier, oversized reference and another account before upload or generation', async () => {
    const model = 'ycapi-gemini-3.1-flash-image'
    const row = { model_name: model, kind: 'image', parameters: { properties: { reference_images: { maxItems: 1 }, n: { enum: [1] } },
      'x-task-plugin': { key: 'ycapi', version: '1.0.0', api_version: 1 },
      'x-image-receipt-recovery': { schema_version: 1, submit_model_metadata: true, original_task_artifacts: true },
      oneOf: [{ properties: { size: { enum: ['1:1'] }, resolution: { enum: ['0.5K', '1K'] } } }],
      'x-image-edit': { schema_version: 1, max_reference_bytes: 128,
        specifications: [{ properties: { size: { enum: ['1:1'] }, resolution: { enum: ['1K'] } } }] } } }
    const base = await boot([model], true, [row])
    if (directory === undefined) throw new Error('Expected isolated Host directory')
    const refs = join(directory, 'credits', 'refs')
    await mkdir(refs, { recursive: true })
    const input = { model, prompt: 'Edit the original reference', size: '1:1', resolution: '1K', references: ['ma_edit'] }
    expect(await post(base, '/api/image/generate', { ...input, resolution: '0.5K' }))
      .toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED', submission_state: 'not-submitted' })
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ee2222' } }).png().toBuffer()
    await writeFile(join(refs, 'ma_edit.png'), bytes)
    await writeFile(join(refs, 'ma_edit.png.json'), JSON.stringify({ mediaType: 'image/png', accountId: 'another' }))
    expect(await post(base, '/api/image/generate', input)).toMatchObject({ ok: false, code: 'IMAGE_REFERENCE_INVALID', submission_state: 'not-submitted' })
    await writeFile(join(refs, 'ma_edit.png.json'), JSON.stringify({ mediaType: 'image/png', accountId: '7' }))
    await writeFile(join(refs, 'ma_edit.png'), Buffer.concat([bytes, Buffer.alloc(129)]))
    expect(await post(base, '/api/image/generate', input)).toMatchObject({ ok: false, code: 'IMAGE_REFERENCE_INVALID', submission_state: 'not-submitted' })
    expect(calls.filter(call => call.path === '/harness/v1/uploads/images' || call.path === '/harness/v1/images/edits' || call.path.endsWith('/images/generations'))).toEqual([])
  })
})

const observedEditManifest = process.env.DSH_IMAGE_EDIT_GATEWAY_REPORT
const observedEditFixtures: Record<string, unknown>[] = observedEditManifest === undefined ? []
  : (JSON.parse(readFileSync(observedEditManifest, 'utf8')) as unknown[]).map(object)

describe('actual gateway image-edit declarations and original paid image bytes through the client', () => {
  it.for(observedEditFixtures)('$label saves and exposes the original image without another submission', async (fixture) => {
    const model = fixture.model_name, label = fixture.label, imagePath = fixture.image_path, referencePath = fixture.reference_path
    if (typeof model !== 'string' || typeof label !== 'string' || typeof imagePath !== 'string' || typeof referencePath !== 'string') throw new Error('Invalid source-bound image fixture')
    const original = await readFile(imagePath), reference = await readFile(referencePath)
    const row = { model_name: model, kind: 'image', parameters: fixture.parameters }
    const base = await boot([model], true, [row], { body: model.startsWith('ycapi-') ? 'accepted' : 'truncated', bytes: original })
    const active = context, root = directory
    if (active === undefined || root === undefined) throw new Error('Expected isolated client Host')
    const sessionId = 'observed-image-edit-client'
    active.sessions.create(SessionId(sessionId), { meta: { cwd: await realpath(root) } })
    const login = new URL(active.connection.authenticatedUrl(new URL(base).origin)), headers: Record<string, string> = {}
    active.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: login.host } }, {
      writeHead(_status, values) { Object.assign(headers, values) }, end() {},
    })
    const cookie = headers['set-cookie']?.split(';')[0]
    if (cookie === undefined) throw new Error('Expected authenticated client cookie')
    const refs = join(root, 'credits', 'refs')
    await mkdir(refs, { recursive: true })
    await writeFile(join(refs, 'ma_observed.png'), reference)
    await writeFile(join(refs, 'ma_observed.png.json'), JSON.stringify({ mediaType: 'image/png', accountId: '7', originalName: 'reference.png' }))
    const request = object(fixture.request)
    const result = await post(base, '/api/image/generate', { session_id: sessionId, account_id: '7', model,
      prompt: request.prompt, ...request.size === undefined ? {} : { size: request.size },
      ...request.resolution === undefined ? {} : { resolution: request.resolution },
      ...request.quality === undefined ? {} : { quality: request.quality }, count: 1, references: ['ma_observed'] }, { cookie })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, submission_state: 'completed', task_id: retainedTaskId })
    const payload = object(result.payload)
    if (typeof payload.path !== 'string') throw new Error('Expected saved original image path')
    expect(createHash('sha256').update(await readFile(payload.path)).digest('hex')).toBe(fixture.image_sha256)
    const listing = object(object(await (await fetch(base + '/api/creative/projects?session_id=' + sessionId, { headers: { cookie } })).json()).payload)
    if (!Array.isArray(listing.projects)) throw new Error('Expected visible image project')
    const project = listing.projects.map(object).find(project => project.id === result.plan_id)
    expect(project).toMatchObject({ kind: 'image', tasks: [expect.objectContaining({ status: 'completed' })] })
    if (!Array.isArray(project?.outputs) || project.outputs.length !== 1) throw new Error('Expected one visible original output')
    const output = object(project.outputs[0])
    if (typeof output.url !== 'string') throw new Error('Expected local image preview')
    const preview = await fetch(new URL(output.url, base), { headers: { cookie } })
    expect(preview.status).toBe(200)
    const bytes = Buffer.from(await preview.arrayBuffer())
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.image_sha256)
    expect((await sharp(bytes).metadata()).width).toBe((await sharp(original).metadata()).width)
    const submissions = imageWireCalls.filter(call => call.method === 'POST' && (call.path.endsWith('/images/edits') || call.path.endsWith('/images/generations')))
    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.path).toBe('/harness/v1/images/edits')
    if (model.startsWith('ycapi-')) expect(submissions[0]?.prefer).toBe('respond-async')
    expect(imageWireCalls.filter(call => call.path === retainedTaskPath)).toHaveLength(1)
    await recordRecoveryRoute(label.replaceAll('/', '-'), result)
  })
})
