import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { ArtifactStorageService, ArtifactWriteRequest } from '@deepseek-ai/dsh-artifacts-index'
import { audioRequestFingerprint, type AudioRequest } from '../src/audio-generation.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

const reference = credentialRef('AUDIO_ROUTES_SYNTHETIC_RELAY')
const speechId = 'fixture-speech'
const wav = Buffer.alloc(46)
wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28)
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40)
const request: AudioRequest = { model: speechId, input: '一条本地合成朗读测试', voice: 'calm', response_format: 'wav' }
const sessionId = 'audio-chat'
const rows = [{ model_name: speechId, kind: 'audio', parameters: {
  properties: { voice: { enum: ['calm'] }, response_format: { enum: ['wav'] }, input: { maxLength: 2000 }, instructions: false },
  x_client_audio_execution: { protocol: 'openai-speech-v1', quoteRoute: '/v1/audio/quote', taskRoute: '/v1/tasks' },
} }]
let userId = 7
let pending = false
let completedTask = false
let quotes = 0
let quoteReply: 'normal' | 'busy' | 'disconnect' | 'malformed' = 'normal'
let context: Context | undefined
let upstream: Server | undefined
let directory: string | undefined
const calls: { path: string; method: string; body: Record<string, unknown>; idempotency: string | undefined }[] = []
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
async function post(base: string, path: string, body: object, cookie?: string, signal?: AbortSignal) {
  return object(await (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json',
    ...cookie === undefined ? {} : { cookie } }, body: JSON.stringify(body), ...signal === undefined ? {} : { signal } })).json())
}
async function get(base: string, path: string, cookie: string) {
  return object(await (await fetch(base + path, { headers: { cookie } })).json())
}
async function signIn(base: string): Promise<void> {
  const challenge = await post(base, '/api/session/challenge', { phone: '+8613800000000', idempotencyKey: randomUUID() })
  expect(challenge.ok).toBe(true)
  expect((await post(base, '/api/session/verify', { challengeId: object(challenge.payload).challenge_id,
    code: '123456', idempotencyKey: randomUUID() })).ok).toBe(true)
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
  calls.length = 0
})

async function boot(managedOutput = false) {
  userId = 7; pending = false; completedTask = false; quotes = 0; quoteReply = 'normal'
  directory = await mkdtemp(join(tmpdir(), 'dsh-audio-routes-'))
  const root = directory
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary request chunk')
        chunks.push(chunk)
      }
      const body = chunks.length === 0 ? {} : object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      calls.push({ path, body, method: request.method ?? 'GET', idempotency: typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : undefined })
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown) => response.end(JSON.stringify({ success: true, data }))
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: '+8613800000000', delivery_status: 'accepted', expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=synthetic; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: `fixture-access-${userId}`, access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-fixture-relay', relay_key_id: 9, session: { sid: 'fixture-session', current: true }, user: { id: userId, username: 'fixture', quota: 1000000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: userId, username: 'fixture', group: 'default', quota: 1000000 }); return }
      if (path === '/harness/api/pricing') { answer(rows); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 30, online_timeout_seconds: 90 }); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-fixture-relay')
        response.end(JSON.stringify({ data: rows.map(row => ({ id: row.model_name, kind: row.kind, supported_endpoint_types: ['audio'] })) })); return
      }
      if (path === '/harness/v1/audio/quote') {
        expect(request.headers.authorization).toBe('Bearer sk-fixture-relay')
        if (quoteReply === 'busy') {
          response.writeHead(429)
          response.end(JSON.stringify({ error: { message: 'synthetic-private-provider-error' } })); return
        }
        if (quoteReply === 'disconnect') { response.destroy(); return }
        if (quoteReply === 'malformed') { response.end('{synthetic-private-provider-error'); return }
        const parameters: AudioRequest = { model: speechId, input: body.input as string, voice: body.voice as string, response_format: 'wav' }
        const created = Math.floor(Date.now() / 1000)
        response.end(JSON.stringify({ object: 'audio.quote', schema_version: 1, quote_id: `quote-${++quotes}`,
          account_binding: `owner-${userId}`, model: speechId, request_fingerprint: audioRequestFingerprint(parameters),
          total_quota: 1000, estimated_total: '0.0146', currency: 'CNY', pricing_revision: 'rev-1',
          created_at: created, expires_at: created + 60, estimate_only: true, charged: false, submitted: false, reserved: false })); return
      }
      if (path === '/harness/v1/audio/speech') {
        expect(request.headers.authorization).toBe('Bearer sk-fixture-relay')
        if (pending) { response.writeHead(202); response.end(JSON.stringify({ task_id: 'task_audio_original', model: speechId, status: 'queued' })); return }
        if (completedTask) {
          response.setHeader('x-request-id', 'known-audio-request')
          response.end(JSON.stringify({ task_id: 'task_audio_original', model: speechId, status: 'completed',
            result: { audio: { format: 'wav', data: wav.toString('base64') } } })); return
        }
        response.setHeader('content-type', 'audio/wav'); response.end(wav); return
      }
      if (path === '/harness/v1/tasks/task_audio_original') {
        expect(request.method).toBe('GET')
        expect(request.headers.authorization).toBe('Bearer sk-fixture-relay')
        answer({ task_id: 'task_audio_original', model: speechId, status: 'completed',
          result: { audio: { format: 'wav', data: wav.toString('base64') } } }); return
      }
      response.writeHead(404); response.end('{}')
    })().catch(() => response.destroy())
  })
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('Expected listener')
  const api = `http://127.0.0.1:${address.port}/harness`
  const outputDirectory = join(root, 'selected-audio-output')
  const outputWrites: ArtifactWriteRequest[] = []
  let failedWrites = 0
  let outputGate: Promise<void> | undefined
  let outputEntered: (() => void) | undefined
  const storage: ArtifactStorageService = {
    capture: async (signal) => {
      signal.throwIfAborted()
      await mkdir(outputDirectory, { recursive: true })
      return { directory: outputDirectory }
    },
    validate: async (destination, signal) => {
      signal.throwIfAborted()
      expect(destination.directory).toBe(outputDirectory)
    },
    write: async (request) => {
      outputWrites.push(request)
      expect(request.destination.directory).toBe(outputDirectory)
      request.signal.throwIfAborted()
      if (failedWrites > 0) { failedWrites -= 1; throw new Error('Synthetic output write failure') }
      outputEntered?.()
      await outputGate
      request.signal.throwIfAborted()
      const path = join(request.destination.directory, request.filename)
      await writeFile(path, request.bytes, { flag: 'wx' })
      return { path }
    },
    publish: async () => { throw new Error('Audio must publish its owned bytes with write') },
  }
  const outputControl = {
    writes: outputWrites,
    failNextWrite: (): void => { failedWrites += 1 },
    holdWrites: () => {
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      outputEntered = () => { entered.resolve(undefined) }
      outputGate = release.promise
      return { entered: entered.promise, release: () => { release.resolve(undefined) } }
    },
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem], ['@deepseek-ai/dsh-credits-index', Credits],
    ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-client-connection', Connection],
    ['fixture-audio-output', { name: 'fixture-audio-output', apply(ctx: Context) { ctx.provide('artifactStorage', storage) } }],
    ['fixture-audio-auth-index', { name: 'fixture-audio-auth-index', inject: ['webServer', 'connection'], apply(ctx: Context) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/', handler: (request, response) => {
        if (ctx.connection.authorizeIndex(request, response)) response.end('ready')
      } }), 'audio fixture browser authentication')
    } }],
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
    { name: '@deepseek-ai/dsh-session' }, { name: '@deepseek-ai/dsh-client-connection' }, { name: 'fixture-audio-auth-index' },
    ...managedOutput ? [{ name: 'fixture-audio-output' }] : [],
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'yunshu-local': {
      api: 'openai-completions', baseURL: api + '/v1', apiKeyEnv: reference, models: [{ id: 'fixture-chat' }],
    } } } },
    { name: '@deepseek-ai/dsh-credits-index', config: { stateDir: join(root, 'credits'), newApiBaseUrl: api,
      relayTokenEnv: reference, accountReadMinIntervalMs: 0, accountReadFailureCooldownMs: 1, mediaCatalogCacheTtlMs: 0 } },
  ]))
  await profileComposition(context, root, configuration)
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const base = `http://127.0.0.1:${context.webServer.port}/credits`
  await signIn(base)
  context.sessions.create(SessionId(sessionId), { meta: { cwd: root } })
  context.sessions.create(SessionId('audio-other-chat'), { meta: { cwd: root } })
  const authorization = await fetch(context.connection.authenticatedUrl(new URL(base).origin + '/'), { redirect: 'manual' })
  const cookie = authorization.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined) throw new Error('Expected authenticated Host cookie')
  const models = await get(base, '/api/audio/models', cookie)
  expect(models).toMatchObject({ ok: true, models: [{ id: speechId, kind: 'audio' }] })
  if (typeof models.accountId !== 'string') throw new Error('Expected model account owner')
  return { base, cookie, accountId: models.accountId, root, api, outputDirectory, outputControl }
}

describe('speech through the real authenticated Host Loader', () => {
  it('recovers the checkpointed original task after a completed response cannot enter the private cache', async () => {
    const { base, cookie, accountId, root, api } = await boot()
    completedTask = true
    const body = { account_id: accountId, session_id: sessionId, ...request }
    const estimate = await post(base, '/api/audio/quote', body, cookie)
    const id = randomUUID()
    const backend = createHash('sha256').update(api).digest('hex')
    const scope = createHash('sha256').update(JSON.stringify([backend, accountId])).digest('hex')
    const cacheDirectory = join(root, 'credits', 'audio', scope)
    const blocked = join(cacheDirectory, `${id}.wav`)
    await mkdir(blocked, { recursive: true })
    const input = { ...body, quote_id: object(estimate.quote).quote_id, submission_id: id }
    const failed = await post(base, '/api/audio/generate', input, cookie)
    expect(failed).toMatchObject({ ok: false, code: 'AUDIO_LOCAL_STORAGE' })
    expect(JSON.stringify(failed)).not.toContain(root)
    const checkpoint = object(JSON.parse(await readFile(join(cacheDirectory, `${id}.json`), 'utf8')))
    expect(checkpoint).toMatchObject({ status: 'pending', taskId: 'task_audio_original', requestId: 'known-audio-request' })
    expect(calls.filter(call => call.path === '/harness/v1/audio/speech')).toHaveLength(1)
    expect(calls.filter(call => call.path.startsWith('/harness/v1/tasks/'))).toHaveLength(0)
    await rm(blocked, { recursive: true })
    expect(await post(base, '/api/audio/generate', input, cookie)).toMatchObject({ ok: true, status: 'pending', taskId: 'task_audio_original' })
    const recovered = await post(base, '/api/audio/recover', { account_id: accountId, session_id: sessionId, submission_id: id }, cookie)
    expect(recovered).toMatchObject({ ok: true, status: 'completed', submissionId: id, taskId: 'task_audio_original' })
    expect(await readFile(blocked)).toEqual(wav)
    expect(await readFile(join(root, 'credits', 'media', String(recovered.filename)))).toEqual(wav)
    expect(calls.filter(call => call.path === '/harness/v1/audio/speech')).toHaveLength(1)
    expect(calls.filter(call => call.path.startsWith('/harness/v1/tasks/')).map(call => call.path))
      .toEqual(['/harness/v1/tasks/task_audio_original'])
  })

  it('keeps saved audio playable and publishes it once locally when concurrent save recovery follows output failure', async () => {
    const { base, cookie, accountId, outputDirectory, outputControl } = await boot(true)
    outputControl.failNextWrite()
    const body = { account_id: accountId, session_id: sessionId, ...request }
    const estimate = await post(base, '/api/audio/quote', body, cookie)
    const id = randomUUID()
    const completed = await post(base, '/api/audio/generate', { ...body, quote_id: object(estimate.quote).quote_id, submission_id: id }, cookie)
    expect(completed).toMatchObject({ ok: true, status: 'completed', code: 'AUDIO_SAVE_PENDING', submissionId: id })
    const playable = await fetch(new URL(base).origin + String(completed.mediaUrl), { headers: { cookie } })
    expect(playable.status).toBe(200)
    expect(Buffer.from(await playable.arrayBuffer())).toEqual(wav)
    expect(outputControl.writes).toHaveLength(1)
    const restore = { account_id: accountId, session_id: sessionId, submission_id: id }
    const gate = outputControl.holdWrites()
    const saving = post(base, '/api/audio/recover', restore, cookie)
    try {
      await gate.entered
      expect(outputControl.writes).toHaveLength(2)
      const concurrent = await post(base, '/api/audio/recover', restore, cookie, AbortSignal.timeout(3000))
      expect(concurrent).toMatchObject({ ok: true, status: 'completed', code: 'AUDIO_SAVE_PENDING' })
      expect(outputControl.writes).toHaveLength(2)
      gate.release()
      const saved = await saving
      expect(saved).toMatchObject({ ok: true, status: 'completed', submissionId: id })
      expect(saved.code).toBeUndefined()
      expect(await readFile(join(outputDirectory, String(saved.filename)))).toEqual(wav)
      expect(await post(base, '/api/audio/recover', restore, cookie)).toEqual(saved)
      expect(outputControl.writes).toHaveLength(2)
      expect(calls.filter(call => call.path === '/harness/v1/audio/speech')).toHaveLength(1)
      expect(calls.filter(call => call.path.startsWith('/harness/v1/tasks/'))).toHaveLength(0)
    } finally { gate.release(); await Promise.allSettled([saving]) }
  })

  it.each([
    ['busy', 'AUDIO_BUSY'], ['disconnect', 'AUDIO_NETWORK'], ['malformed', 'AUDIO_RESPONSE_INVALID'],
  ] as const)('keeps a failed %s estimate distinct from model readiness and never submits speech', async (mode, code) => {
    const { base, cookie, accountId } = await boot()
    quoteReply = mode
    const body = { account_id: accountId, session_id: sessionId, ...request }
    const failed = await post(base, '/api/audio/quote', body, cookie)
    expect(failed).toMatchObject({ ok: false, code })
    expect(failed.code).not.toBe('AUDIO_NOT_READY')
    expect(JSON.stringify(failed)).not.toContain('synthetic-private-provider-error')
    expect(await post(base, '/api/audio/generate', { ...body, quote_id: 'unconfirmed-quote', submission_id: randomUUID() }, cookie))
      .toMatchObject({ ok: false, code: 'AUDIO_QUOTE_EXPIRED' })
    expect(calls.filter(call => call.path === '/harness/v1/audio/speech')).toHaveLength(0)
  })

  it('quotes, saves and plays one binary file; replaying a submission never issues another speech POST', async () => {
    const { base, cookie, accountId, root } = await boot()
    const body = { account_id: accountId, session_id: sessionId, ...request }
    const estimate = await post(base, '/api/audio/quote', body, cookie)
    expect(estimate.ok).toBe(true)
    expect(calls.filter(call => call.path === '/harness/v1/audio/speech')).toHaveLength(0)
    const id = randomUUID()
    const input = { ...body, quote_id: object(estimate.quote).quote_id, submission_id: id }
    const completed = await post(base, '/api/audio/generate', input, cookie)
    expect(completed).toMatchObject({ ok: true, status: 'completed', submissionId: id, model: speechId })
    expect(typeof completed.filename).toBe('string')
    expect(await readFile(join(root, 'credits', 'media', String(completed.filename)))).toEqual(wav)
    expect(completed.mediaUrl).toBe(`/credits/api/audio/content?session_id=${sessionId}&submission_id=${id}`)
    const playable = await fetch(new URL(base).origin + String(completed.mediaUrl), { headers: { cookie } })
    expect(playable.status).toBe(200); expect(playable.headers.get('content-type')).toBe('audio/wav')
    expect(Buffer.from(await playable.arrayBuffer())).toEqual(wav)
    expect(await post(base, '/api/audio/generate', input, cookie)).toEqual(completed)
    expect(calls.filter(call => call.path === '/harness/v1/audio/speech')).toEqual([
      { path: '/harness/v1/audio/speech', method: 'POST', idempotency: id, body: { ...request, quote_id: object(estimate.quote).quote_id } },
    ])
    const history = await get(base, `/api/audio/submissions?account_id=${accountId}&session_id=${sessionId}`, cookie)
    expect(history).toMatchObject({ ok: true, submissions: [{ submissionId: id, model: speechId, status: 'completed', filename: completed.filename, mediaUrl: completed.mediaUrl }] })
    expect(JSON.stringify(completed)).not.toMatch(/fixture-access|sk-fixture-relay|request_fingerprint|account_binding/)
  })

  it('recovers a pending original task with a GET and preserves independent submission identity', async () => {
    const { base, cookie, accountId } = await boot()
    pending = true
    const body = { account_id: accountId, session_id: sessionId, ...request }
    const estimate = await post(base, '/api/audio/quote', body, cookie)
    const id = randomUUID()
    const original = await post(base, '/api/audio/generate', { ...body, quote_id: object(estimate.quote).quote_id, submission_id: id }, cookie)
    expect(original).toMatchObject({ ok: true, status: 'pending', taskId: 'task_audio_original', submissionId: id })
    const recovered = await post(base, '/api/audio/recover', { account_id: accountId, session_id: sessionId, submission_id: id }, cookie)
    expect(recovered).toMatchObject({ ok: true, status: 'completed', submissionId: id })
    expect(calls.filter(call => call.path === '/harness/v1/audio/speech')).toHaveLength(1)
    expect(calls.filter(call => call.path === '/harness/v1/tasks/task_audio_original').map(call => call.method)).toEqual(['GET'])
    expect(await post(base, '/api/audio/recover', { account_id: accountId, session_id: sessionId, submission_id: id }, cookie)).toEqual(recovered)
    expect(calls.filter(call => call.path === '/harness/v1/tasks/task_audio_original')).toHaveLength(1)
    expect(await post(base, '/api/audio/recover', { account_id: accountId, session_id: 'audio-other-chat', submission_id: id }, cookie))
      .toMatchObject({ ok: false, code: 'AUDIO_RESULT_UNAVAILABLE' })
  })

  it('rejects missing Host authentication, stale account selection and expired estimates before any speech dispatch', async () => {
    const { base, cookie, accountId } = await boot()
    const body = { account_id: accountId, session_id: sessionId, ...request }
    expect(await post(base, '/api/audio/quote', body)).toMatchObject({ ok: false, code: 'CREATIVE_HOST_AUTH_REQUIRED' })
    const estimate = await post(base, '/api/audio/quote', body, cookie)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    expect(await post(base, '/api/audio/generate', { ...body, quote_id: object(estimate.quote).quote_id, submission_id: randomUUID() }, cookie))
      .toMatchObject({ ok: false, code: 'AUDIO_QUOTE_EXPIRED' })
    clock.mockRestore()
    const current = await post(base, '/api/audio/quote', body, cookie)
    userId = 8
    await signIn(base)
    expect(await post(base, '/api/audio/generate', { ...body, quote_id: object(current.quote).quote_id, submission_id: randomUUID() }, cookie))
      .toMatchObject({ ok: false, code: 'CREATIVE_ACCOUNT_CHANGED' })
    const models = await get(base, '/api/audio/models', cookie)
    expect(models.accountId).not.toBe(accountId)
    expect(await post(base, '/api/audio/generate', { ...body, account_id: models.accountId, quote_id: object(current.quote).quote_id, submission_id: randomUUID() }, cookie))
      .toMatchObject({ ok: false, code: 'AUDIO_QUOTE_EXPIRED' })
    expect(calls.filter(call => call.path === '/harness/v1/audio/speech')).toHaveLength(0)
  })
})
