/** Real Loader and loopback API fixtures for safe phone login failure and recovery. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Credits from '../src/index.ts'

let context: Context | undefined
let root: string | undefined
let upstream: Server | undefined
let release: (() => void) | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  release?.()
  release = undefined
  await context?.fiber.dispose()
  context = undefined
  if (upstream !== undefined) await new Promise<void>((resolve, reject) => {
    upstream?.close((error) => { if (error === undefined) resolve(); else reject(error) })
    upstream?.closeAllConnections()
  })
  upstream = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

type PhoneHandler = (path: string, body: Record<string, unknown>, response: ServerResponse) => Promise<void> | void

async function boot(handle: PhoneHandler) {
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      response.setHeader('content-type', 'application/json')
      if (path.includes('/phone/') || path.endsWith('/api/user/login/verify')) { await handle(path, body, response); return }
      if (path.endsWith('/user/self')) response.end(JSON.stringify({ success: true, data: { id: 7, quota: 10 } }))
      else if (path.endsWith('/api/status')) response.end(JSON.stringify({ success: true, data: { quota_per_unit: 500_000, usd_exchange_rate: 7.3 } }))
      else if (path.endsWith('/v1/models')) response.end(JSON.stringify({ data: [] }))
      else response.end(JSON.stringify({ success: true, data: {} }))
    })().catch(() => { response.destroy() })
  })
  await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('Missing fixture API listener')
  root = await mkdtemp(join(tmpdir(), 'yunshu-phone-loader-'))
  const stateDir = join(root, 'credits')
  await mkdir(stateDir)
  const api = `http://127.0.0.1:${String(address.port)}/harness`
  const file = join(stateDir, 'session.json')
  const stored = JSON.stringify({ token: 'existing-private-session', expiresAt: '9999-01-01T00:00:00.000Z',
    account: { id: '7', phone: '+8613800000000' }, backendBaseUrl: api,
    upstream: { token: 'existing-access', refresh: 'existing-refresh', expiresAt: '9999-01-01T00:00:00.000Z' },
    relay: { key: 'sk-existing-relay' } })
  await writeFile(file, stored, { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, ["- name: '@deepseek-ai/dsh-host-webserver'", '  config:', "    host: '127.0.0.1'", '    port: 0',
    "- name: '@deepseek-ai/dsh-system-prompt'", "- name: '@deepseek-ai/dsh-tools'", "- name: '@deepseek-ai/dsh-credits-index'",
    '  config:', `    stateDir: '${stateDir}'`, `    newApiBaseUrl: '${api}'`, '    timeoutMs: 1000', ''].join('\n'))
  const fixtureRoot = root
  const start = async (): Promise<string> => {
    context = new Context()
    context.baseUrl = pathToFileURL(fixtureRoot).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-credits-index', Credits],
    ])
    context.loader.internal = { version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    } } as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    return `http://127.0.0.1:${String(context.webServer.port)}/credits`
  }
  let base = await start()
  const post = async (path: string, body: Record<string, unknown>) => await (await fetch(base + '/api/session/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json() as Record<string, unknown>
  return { post, file, stored,
    readRecovery: async () => await (await fetch(base + '/api/session/phone-recovery')).json() as Record<string, unknown>,
    restart: async () => { await context?.fiber.dispose(); base = await start() },
  }
}

const bundle = { access_token: 'new-access', access_expires_at: 253402300799, relay_key: 'sk-new-relay',
  user: { id: 8, phone_e164: '+8613900000000' } }
const loginRequest = { challengeId: '+8613900000000', code: '123456', idempotencyKey: 'fixture-login' }

it('contains phone transport, malformed and incomplete login responses without changing an existing session', async () => {
  let mode = 'rate'
  const { post, file, stored } = await boot((_path, _body, response) => {
    if (mode === 'disconnect') { response.destroy(); return }
    if (mode === 'rate') { response.writeHead(429, { 'retry-after': '11' }); response.end(); return }
    if (mode === 'malformed') { response.writeHead(503); response.end('private upstream diagnostic'); return }
    if (mode === 'missing-refresh') { response.end(JSON.stringify({ success: true, data: bundle })); return }
    response.end(JSON.stringify({ success: true, data: { ...bundle, relay_key: undefined } }))
  })
  expect(await post('challenge', { phone: '+8613900000000', idempotencyKey: 'fixture-challenge' }))
    .toMatchObject({ ok: false, code: 'PHONE_RATE_LIMITED', retryAfterSeconds: 11 })
  for (mode of ['disconnect', 'malformed', 'incomplete', 'missing-refresh']) {
    const reply = await post('verify', loginRequest)
    expect(reply).toMatchObject({ ok: false, code: 'PHONE_LOGIN_UNAVAILABLE' })
    expect(JSON.stringify(reply)).not.toMatch(/private upstream|existing-access|new-access|验证码错误|过期/)
    expect(await readFile(file, 'utf8')).toBe(stored)
  }
})

it('maps independent opaque challenges to their own phones and persists only the complete recovered bundle', async () => {
  const calls: { path: string; body: Record<string, unknown> }[] = []
  let failed = true
  const { post, file } = await boot((path, body, response) => {
    calls.push({ path, body })
    if (path.endsWith('/challenge')) {
      response.end(JSON.stringify({ success: true, data: { challenge_id: `opaque-${String(body.phone_e164)}`, delivery_status: 'accepted',
        expires_at: 253402300799, resend_after_seconds: 3 } }))
    } else if (failed) { response.writeHead(503); response.end('{}') }
    else {
      response.setHeader('set-cookie', 'new_api_refresh=recovered-refresh; HttpOnly')
      response.end(JSON.stringify({ success: true, data: bundle }))
    }
  })
  await Promise.all([
    post('challenge', { phone: '+8613900000000', idempotencyKey: 'fixture-challenge-a' }),
    post('challenge', { phone: '+8613800000000', idempotencyKey: 'fixture-challenge-b' }),
  ])
  const request = { ...loginRequest, challengeId: 'opaque-+8613900000000' }
  expect(await post('verify', request)).toMatchObject({ ok: false, code: 'PHONE_LOGIN_UNAVAILABLE' })
  failed = false
  expect(await post('verify', request)).toMatchObject({ ok: true, payload: { account: { id: '8', phone: '+8613900000000' } } })
  expect(calls.filter(call => call.path.endsWith('/login')).map(call => call.body.phone_e164))
    .toEqual(['+8613900000000', '+8613900000000'])
  expect(calls.filter(call => call.path.endsWith('/login')).map(call => call.body))
    .toEqual([0, 1].map(() => ({ phone_e164: '+8613900000000', code: '123456',
      challenge_id: 'opaque-+8613900000000', idempotency_key: 'fixture-login', contract_version: 2 })))
  expect(calls.filter(call => call.path.endsWith('/challenge')).map(call => call.body.idempotency_key))
    .toEqual(['fixture-challenge-a', 'fixture-challenge-b'])
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ account: { id: '8' },
    upstream: { token: 'new-access', refresh: 'recovered-refresh' }, relay: { key: 'sk-new-relay' } })
})

it('discards a login response that arrives after logout', async () => {
  let started: (() => void) | undefined
  const dispatched = new Promise<void>((resolve) => { started = resolve })
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const { post, file } = await boot(async (_path, _body, response) => {
    started?.()
    await barrier
    response.setHeader('set-cookie', 'new_api_refresh=delayed-refresh; HttpOnly')
    response.end(JSON.stringify({ success: true, data: bundle }))
  })
  const login = post('verify', loginRequest)
  await dispatched
  await post('logout', {})
  release?.()
  expect(await login).toMatchObject({ ok: false, code: 'ACCOUNT_CHANGED' })
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({})
})


it('requires the existing MFA check without persisting a premature bundle', async () => {
  const { post, file, stored } = await boot((_path, _body, response) => {
    response.setHeader('set-cookie', 'new_api_refresh=must-not-save; HttpOnly')
    response.end(JSON.stringify({ success: true, code: 'PHONE_LOGIN_VERIFICATION_REQUIRED', data: {
      ...bundle, require_verification: true, flow_token: 'private-mfa-flow',
      methods: [{ method: '2fa', available: true }], expires_at: 253402300799,
    } }))
  })
  const reply = await post('verify', loginRequest)
  expect(reply).toMatchObject({ ok: false, code: 'PHONE_LOGIN_VERIFICATION_REQUIRED' })
  expect(JSON.stringify(reply)).not.toMatch(/private-mfa-flow|must-not-save|new-access|sk-new-relay/)
  expect(await readFile(file, 'utf8')).toBe(stored)
})

it.each(['accepted', 'unknown'])('retains an original %s SMS request after a receipt read fails without delivery data', async (delivery) => {
  let dispatches = 0
  let requests = 0
  const keys = new Set<string>()
  const receipt = { challenge_id: 'original-receipt', delivery_status: delivery,
    expires_at: 253402300799, resend_after_seconds: 0 }
  const { post, readRecovery, restart, file, stored } = await boot((_path, body, response) => {
    requests += 1
    const key = String(body.idempotency_key)
    if (!keys.has(key)) { keys.add(key); dispatches += 1 }
    if (requests === 2) {
      response.writeHead(503)
      response.end(JSON.stringify({ success: false, code: 'PHONE_CHALLENGE_UNAVAILABLE' }))
    } else response.end(JSON.stringify({ success: delivery === 'accepted',
      ...delivery === 'unknown' ? { code: 'PHONE_DELIVERY_UNKNOWN' } : {}, data: receipt }))
  })
  const request = { phone: '+8613900000000', idempotencyKey: 'original-dispatch-key' }
  await post('challenge', request)
  expect(dispatches).toBe(1)
  const unavailable = await post('challenge', request)
  expect(unavailable).toMatchObject({ ok: false, code: 'PHONE_CHALLENGE_UNAVAILABLE' })
  expect(String(unavailable.message)).not.toContain('未发送')
  await restart()
  expect(await readRecovery()).toMatchObject({ payload: { challengeKey: request.idempotencyKey,
    challengeId: receipt.challenge_id, deliveryStatus: 'unknown' } })
  expect(requests).toBe(2)
  expect(dispatches).toBe(1)
  await post('challenge', request)
  expect(dispatches).toBe(1)
  expect(keys.size).toBe(1)
  expect(await readFile(file, 'utf8')).toBe(stored)
})

it('saves the dispatch key before API contact and refuses a local conflicting phone without another dispatch', async () => {
  let observed = 0
  const { post, file } = await boot(async (_path, body, response) => {
    observed += 1
    if (root === undefined) throw new Error('Missing fixture root')
    const paths = (await readdir(join(root, 'credits'))).filter(path => path.startsWith('phone-auth-') && path.endsWith('.json'))
    const first = paths[0]
    if (first === undefined) throw new Error('Dispatch key was not persisted')
    const text = await readFile(join(root, 'credits', first), 'utf8')
    expect(text).toContain(String(body.idempotency_key))
    response.end(JSON.stringify({ success: false, code: 'PHONE_DELIVERY_UNKNOWN', data: {
      challenge_id: 'opaque-unknown', delivery_status: 'unknown', expires_at: 253402300799, resend_after_seconds: 0,
    } }))
  })
  const request = { phone: '+8613900000000', idempotencyKey: 'durable-before-send' }
  expect(await post('challenge', request)).toMatchObject({ ok: false, code: 'PHONE_DELIVERY_UNKNOWN',
    payload: { challenge_id: 'opaque-unknown', delivery_status: 'unknown' } })
  expect(await post('challenge', { ...request, phone: '+8613800000000' })).toMatchObject({ code: 'PHONE_IDEMPOTENCY_CONFLICT' })
  expect(observed).toBe(1)
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ account: { id: '7' } })
})


it('completes only a declared 2fa flow and keeps the previous account after a rejected code', async () => {
  let securityCalls = 0
  const { post, file, stored } = await boot((path, body, response) => {
    if (path.endsWith('/phone/login')) {
      response.end(JSON.stringify({ success: true, code: 'PHONE_LOGIN_VERIFICATION_REQUIRED', data: {
        require_verification: true, flow_token: 'private-security-flow',
        methods: [{ method: '2fa', available: true }], expires_at: 253402300799,
      } }))
      return
    }
    securityCalls += 1
    expect(body).toEqual({ flow_token: 'private-security-flow', method: '2fa', code: securityCalls === 1 ? '000000' : 'backup-123' })
    if (securityCalls === 1) {
      response.writeHead(401)
      response.end(JSON.stringify({ success: false, code: 'MFA_REJECTED', message: 'private diagnostic' }))
    } else {
      response.setHeader('set-cookie', 'new_api_refresh=security-refresh; HttpOnly')
      response.end(JSON.stringify({ success: true, data: bundle }))
    }
  })
  expect(await post('verify', loginRequest)).toMatchObject({ ok: false, code: 'PHONE_LOGIN_VERIFICATION_REQUIRED',
    payload: { verification: { methods: ['2fa'] } } })
  const rejected = await post('verify-security', { exchangeKey: 'fixture-login', code: '000000' })
  expect(rejected).toMatchObject({ ok: false, code: 'PHONE_SECURITY_REJECTED' })
  expect(JSON.stringify(rejected)).not.toContain('private diagnostic')
  expect(await readFile(file, 'utf8')).toBe(stored)
  expect(await post('verify-security', { exchangeKey: 'fixture-login', code: 'backup-123' })).toMatchObject({ ok: true })
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ account: { id: '8' }, upstream: { refresh: 'security-refresh' } })
})

it.each(['passkey', 'future-auth'])('does not submit unavailable 2fa or unsupported %s methods', async (method) => {
  let securityCalls = 0
  const { post, file, stored } = await boot((path, _body, response) => {
    if (path.endsWith('/phone/login')) response.end(JSON.stringify({
      success: true, code: 'PHONE_LOGIN_VERIFICATION_REQUIRED', data: {
        require_verification: true, flow_token: 'private-security-flow', expires_at: 253402300799,
        methods: [{ method: '2fa', available: false }, { method, available: true }, '2fa'],
      },
    }))
    else { securityCalls += 1; response.end('{}') }
  })
  expect(await post('verify', loginRequest)).toMatchObject({ code: 'PHONE_LOGIN_VERIFICATION_REQUIRED',
    payload: { verification: { methods: [method] } } })
  expect(await post('verify-security', { exchangeKey: 'fixture-login', code: '123456' }))
    .toMatchObject({ ok: false, code: 'PHONE_SECURITY_UNSUPPORTED' })
  expect(securityCalls).toBe(0)
  expect(await readFile(file, 'utf8')).toBe(stored)
})

it('never repeats a security exchange after an unknown response', async () => {
  let securityCalls = 0
  const { post, file, stored } = await boot((path, _body, response) => {
    if (path.endsWith('/phone/login')) response.end(JSON.stringify({ success: true, code: 'PHONE_LOGIN_VERIFICATION_REQUIRED', data: {
      require_verification: true, flow_token: 'private-security-flow',
      methods: [{ method: '2fa', available: true }], expires_at: 253402300799,
    } }))
    else { securityCalls += 1; response.destroy() }
  })
  await post('verify', loginRequest)
  const request = { exchangeKey: 'fixture-login', code: '123456' }
  expect(await post('verify-security', request)).toMatchObject({ ok: false, code: 'PHONE_SECURITY_UNCONFIRMED' })
  expect(await post('verify-security', request)).toMatchObject({ ok: false, code: 'PHONE_SECURITY_UNCONFIRMED' })
  expect(securityCalls).toBe(1)
  expect(await post('verify', loginRequest)).toMatchObject({ ok: false, code: 'PHONE_SECURITY_UNCONFIRMED' })
  expect(securityCalls).toBe(1)
  expect(await readFile(file, 'utf8')).toBe(stored)
})

it('keeps an incomplete v2 challenge unconfirmed instead of manufacturing a phone challenge ID', async () => {
  const { post, file, stored } = await boot((_path, _body, response) => {
    response.end(JSON.stringify({ success: true, data: { resend_after_seconds: 60, expires_in_minutes: 5 } }))
  })
  const reply = await post('challenge', { phone: '+8613900000000', idempotencyKey: 'incomplete-v2-challenge' })
  expect(reply).toMatchObject({ ok: false, code: 'PHONE_DELIVERY_UNKNOWN' })
  expect(reply.payload).toBeUndefined()
  expect(await readFile(file, 'utf8')).toBe(stored)
})


it('replays the same committed login after a lost response, OTP expiry and Host restart without another SMS', async () => {
  let now = Date.UTC(2026, 9, 21, 12, 0, 0)
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const otpExpiry = now + 2000
  let smsRequests = 0
  let loginRequests = 0
  let createdSessions = 0
  let committed = false
  const apiReplies: Record<string, unknown>[] = []
  const { post, file, stored, restart, readRecovery } = await boot((path, body, response) => {
    if (path.endsWith('/challenge')) {
      smsRequests += 1
      response.end(JSON.stringify({ success: true, data: { challenge_id: 'opaque-lost-success',
        delivery_status: 'accepted', expires_at: otpExpiry / 1000, resend_after_seconds: 0 } }))
      return
    }
    loginRequests += 1
    apiReplies.push(body)
    if (!committed) { committed = true; createdSessions += 1; response.destroy(); return }
    response.setHeader('set-cookie', 'new_api_refresh=replayed-refresh; HttpOnly')
    response.end(JSON.stringify({ success: true, data: { ...bundle, access_token: 'same-committed-session-access' } }))
  })
  await post('challenge', { phone: '+8613900000000', idempotencyKey: 'sms-once' })
  now += 1900
  const request = { ...loginRequest, challengeId: 'opaque-lost-success', idempotencyKey: 'same-exchange-key' }
  expect(await post('verify', request)).toMatchObject({ ok: false, code: 'PHONE_LOGIN_UNAVAILABLE' })
  expect(await readFile(file, 'utf8')).toBe(stored)
  now += 4 * 60_000
  await restart()
  expect(await readRecovery()).toMatchObject({ ok: true, payload: {
    phone: '+8613900000000', challengeId: 'opaque-lost-success', exchangeKey: 'same-exchange-key',
    expiresAt: new Date(otpExpiry).toISOString(),
  } })
  expect(loginRequests).toBe(1)
  expect(smsRequests).toBe(1)
  expect(await post('verify', request)).toMatchObject({ ok: true, payload: { account: { id: '8' } } })
  expect(createdSessions).toBe(1)
  expect(loginRequests).toBe(2)
  expect(smsRequests).toBe(1)
  expect(apiReplies[1]).toEqual(apiReplies[0])
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
    upstream: { token: 'same-committed-session-access', refresh: 'replayed-refresh' }, account: { id: '8' },
  })
})
