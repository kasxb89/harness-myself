import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as Credits from '../src/index.ts'
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
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
async function post(base: string, path: string, body: object) {
  return object(await (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json())
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
})

async function boot() {
  directory = await mkdtemp(join(tmpdir(), 'dsh-media-specifications-'))
  const root = directory
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body = chunks.length === 0 ? {} : object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      calls.push({ path, body })
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown) => response.end(JSON.stringify({ success: true, data }))
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: '+8613800000000', delivery_status: 'accepted', expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=synthetic; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'fixture-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-fixture-relay', relay_key_id: 9, session: { sid: 'fixture-session', current: true }, user: { id: 7, username: 'fixture', quota: 1000000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'fixture', group: 'default', quota: 1000000 }); return }
      if (path === '/harness/api/pricing') { answer(rows); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 30, online_timeout_seconds: 90 }); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-fixture-relay')
        response.end(JSON.stringify({ data: rows.map(row => ({ id: row.model_name, supported_endpoint_types: ['openai'] })) })); return
      }
      if (path === '/harness/v1/images/generations') {
        expect(request.headers.authorization).toBe('Bearer sk-fixture-relay')
        response.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8R8AAAAASUVORK5CYII=' }] })); return
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
  const api = `http://127.0.0.1:${address.port}/harness`
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem], ['@deepseek-ai/dsh-credits-index', Credits],
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
    { name: '@deepseek-ai/dsh-tools' }, { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-fs-local', config: { cwd: root } },
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(root, 'credentials.yaml'), dshHome: root, watch: false } },
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'yunshu-local': {
      api: 'openai-completions', baseURL: api + '/v1', apiKeyEnv: reference, models: [{ id: 'ycapi-minimax-m3' }],
    } } } },
    { name: '@deepseek-ai/dsh-credits-index', config: { stateDir: join(root, 'credits'), newApiBaseUrl: api,
      relayTokenEnv: reference, accountReadMinIntervalMs: 0, accountReadFailureCooldownMs: 1, mediaCatalogCacheTtlMs: 0 } },
  ]))
  await profileComposition(context, root, configuration)
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const base = `http://127.0.0.1:${context.webServer.port}/credits`
  const challenge = await post(base, '/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'challenge' })
  expect(challenge.ok).toBe(true)
  expect((await post(base, '/api/session/verify', { challengeId: object(challenge.payload).challenge_id, code: '123456', idempotencyKey: 'login' })).ok).toBe(true)
  return base
}

describe('complete media specifications through the shipped Host Loader', () => {
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
