/** Real Loader, authenticated HTTP and live Sessions for exact chat billing reads. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import Sessions, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { BlockAssembler, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Credits from '../src/index.ts'

let context: Context | undefined
let root: string | undefined
let upstream: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (upstream !== undefined) await new Promise<void>((resolve, reject) => {
    upstream?.close((error) => { if (error === undefined) resolve(); else reject(error) })
    upstream?.closeAllConnections()
  })
  upstream = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
})

async function boot(options: { sessions?: boolean; projections?: boolean; concurrency?: number } = {}) {
  const calls: { path: string; requestId: string | null; authorization: string | undefined }[] = []
  const held: (() => void)[] = []
  let hold = false
  let active = 0
  let peak = 0
  let exchangeRate = 7.3
  let ledgerReceived = Promise.withResolvers<undefined>()
  const owner = new Map<string, number>()
  const missing = new Set<string>()
  let batchEnabled = false
  const batches: string[][] = []
  let heldStatus: (() => void) | undefined
  let holdStatus = false
  const statusRequested = Promise.withResolvers<undefined>()
  let rejectFirstAccess = false
  let refreshFailure = false
  let failure: { path: string; retryAfter: string; date?: string } | undefined
  upstream = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const requestId = url.searchParams.get('request_id')
    calls.push({ path: url.pathname, requestId, authorization: request.headers.authorization })
    const accountId = request.headers.authorization === 'Bearer second-access' ? 8 : 7
    response.setHeader('content-type', 'application/json')
    if (failure?.path === url.pathname) {
      response.setHeader('retry-after', failure.retryAfter)
      if (failure.date !== undefined) response.setHeader('date', failure.date)
      response.writeHead(429); response.end(); return
    }
    if (rejectFirstAccess && request.headers.authorization === 'Bearer first-access') {
      response.writeHead(401); response.end(); return
    }
    if (url.pathname === '/harness/api/user/self') response.end(JSON.stringify({ success: true, data: { id: accountId, quota: 1000 } }))
    else if (url.pathname === '/harness/api/status') {
      const answer = (): void => { if (!response.destroyed) response.end(JSON.stringify({ success: true, data: {
        quota_per_unit: 500000, usd_exchange_rate: exchangeRate,
        ...batchEnabled ? { usage_receipts: { schema_version: 1, batch_path: '/api/log/self/batch', method: 'POST',
          max_request_ids: 100, max_body_bytes: 16384, max_consume_logs: 1000, refund_state: false, final_settlement_state: false } } : {},
      } })) }
      if (holdStatus) heldStatus = answer
      else answer()
      statusRequested.resolve(undefined)
    }
    else if (url.pathname === '/harness/api/log/self/batch') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { request_ids: string[] }
        expect(Object.keys(body)).toEqual(['request_ids'])
        expect(request.method).toBe('POST')
        expect(request.headers['content-type']).toBe('application/json')
        batches.push(body.request_ids)
        response.end(JSON.stringify({ success: true, data: { schema_version: 1, lookup_window_start_unix: 0,
          items: body.request_ids.map(id => ({ request_id: id, status: missing.has(id) ? 'not_found' : 'found',
            consume_logs: missing.has(id) ? [] : [{ request_id: id, model_name: 'chat-model', quota: 100,
              prompt_tokens: 12, completion_tokens: 34, created_at: 1793000000, use_time: 2 }],
            refund_status: 'unknown', settlement_status: 'unknown' })),
        } }))
      })
    }
    else if (url.pathname === '/harness/api/log/self') {
      active++
      peak = Math.max(active, peak)
      response.once('close', () => { active-- })
      const rows = requestId === null ? [{ id: 1, user_id: accountId, type: 2, created_at: 1_792_000_800,
        model_name: 'chat-model', quota: 100, prompt_tokens: 12, completion_tokens: 34, other: '{}' }]
        : !missing.has(requestId) && owner.get(requestId) === accountId
          ? [{ user_id: accountId, type: 2, request_id: requestId, quota: 100 }] : []
      const answer = (): void => {
        if (!response.destroyed) {
          response.end(JSON.stringify({ success: true, data: { page: 1, page_size: 100, total: rows.length, items: rows } }))
        }
      }
      if (hold) held.push(answer)
      else answer()
      ledgerReceived.resolve(undefined)
    } else if (url.pathname === '/harness/api/user/auth/refresh') {
      if (refreshFailure) { response.setHeader('retry-after', '45'); response.writeHead(429); response.end(); return }
      response.setHeader('set-cookie', 'new_api_refresh=renewed-refresh; HttpOnly')
      response.end(JSON.stringify({ success: true, data: { access_token: 'renewed-access',
        access_expires_at: 253402300799, user: { id: 7 } } }))
    } else if (url.pathname === '/harness/api/user/phone/login') {
      response.setHeader('set-cookie', 'new_api_refresh=fixture-refresh; HttpOnly')
      response.end(JSON.stringify({ success: true, data: {
        access_token: 'second-access', access_expires_at: 253402300799,
        relay_key: 'sk-second-key', user: { id: 8, phone_e164: '+8613800000001' },
      } }))
    } else if (url.pathname === '/harness/api/user/auth/logout') response.end(JSON.stringify({ success: true }))
    else { response.writeHead(404); response.end() }
  })
  await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('missing mock gateway')
  const apiBase = `http://127.0.0.1:${String(address.port)}/harness`
  root = await mkdtemp(join(tmpdir(), 'yunshu-chat-ledger-'))
  const stateDir = join(root, 'credits')
  await mkdir(stateDir)
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({ token: 'first-private-login', expiresAt: '9999-01-01T00:00:00.000Z',
    account: { id: '7', phone: '+8613800000000' }, backendBaseUrl: apiBase,
    upstream: { token: 'first-access', refresh: 'first-refresh', expiresAt: '9999-01-01T00:00:00.000Z' },
    relay: { key: 'sk-first-key' } }), { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'", '  config:', `    path: '${join(root, 'credentials.yml')}'`, '    watch: false',
    "- name: '@deepseek-ai/dsh-host-webserver'", '  config:', "    host: '127.0.0.1'", '    port: 0',
    "- name: '@deepseek-ai/dsh-client-connection'", "- name: '@deepseek-ai/dsh-system-prompt'", "- name: '@deepseek-ai/dsh-tools'",
    ...options.sessions === false ? [] : ["- name: '@deepseek-ai/dsh-session'"],
    ...options.projections === false ? [] : ["- name: '@deepseek-ai/dsh-session-projection'"],
    "- name: '@deepseek-ai/dsh-credits-index'", '  config:', `    stateDir: '${stateDir}'`,
    `    newApiBaseUrl: '${apiBase}'`, '    timeoutMs: 1000', '    chatUsageCacheTtlMs: 5000', '    accountReadMinIntervalMs: 0',
    `    chatUsageConcurrency: ${String(options.concurrency ?? 2)}`, '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-session', Sessions], ['@deepseek-ai/dsh-credits-index', Credits],
    ['@deepseek-ai/dsh-session-projection', SessionProjections],
  ])
  context.loader.internal = { version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
    if (!modules.has(specifier)) throw new Error(`unexpected module: ${specifier}`)
    return modules.get(specifier)
  } } as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const base = `http://127.0.0.1:${String(context.webServer.port)}`
  const loginUrl = new URL(context.connection.authenticatedUrl(base))
  const headers: Record<string, string> = {}
  context.connection.authorizeIndex({ method: 'GET', url: loginUrl.pathname + loginUrl.search, headers: { host: loginUrl.host } }, {
    writeHead(_status, value) { Object.assign(headers, value) }, end() {},
  })
  const cookie = headers['set-cookie']?.split(';')[0]
  if (cookie === undefined) throw new Error('missing browser authorization')
  const fetchUsage = (query = 'session_id=chat-one&account_id=7', init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('cookie', cookie)
    return fetch(`${base}/credits/api/chat-usage?${query}`, { ...init, headers })
  }
  const appendTurn = (session: Session, turn: number, requestId: string, closed = true, accountId = 7): void => {
    owner.set(requestId, accountId)
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: turn })
    const replayState = { response: { gatewayReceipt: { kind: 'oneapi', version: 1, apiBaseUrl: `${apiBase}/v1`, requestId } } }
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      { type: 'finish', reason: { kind: 'stop' }, replayState },
    ]
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    session.append('assistant/message', { turn, step: turn,
      message: assembler.message({ provider: 'product', model: 'chat-model', replayState }),
      stream: chunks.map(chunk => ({ type: 'chunk', time: turn, chunk })),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: turn })
    if (closed) session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { context, base, cookie, calls, fetchUsage, appendTurn,
    batches,
    enableBatch() { batchEnabled = true },
    holdStatus() { holdStatus = true },
    releaseStatus() { holdStatus = false; heldStatus?.() },
    statusRequested: () => statusRequested.promise,
    holdLedger() { hold = true; ledgerReceived = Promise.withResolvers<undefined>() },
    releaseLedger() { hold = false; for (const answer of held.splice(0)) answer() },
    ledgerRequested: () => ledgerReceived.promise,
    peakLedger: () => peak,
    exchange: (value: number) => { exchangeRate = value },
    pending: (requestId: string) => { missing.add(requestId) },
    settle: (requestId: string) => { missing.delete(requestId) },
    ledgerCalls: () => calls.filter(call => call.path.endsWith('/api/log/self')),
    failLedger(retryAfter: string, date?: string) { failure = { path: '/harness/api/log/self', retryAfter, ...date === undefined ? {} : { date } } },
    failBatch() { failure = { path: '/harness/api/log/self/batch', retryAfter: '45' } },
    rejectAccess() { rejectFirstAccess = true },
    failRefresh() { rejectFirstAccess = true; refreshFailure = true },
    storedSession: async (): Promise<unknown> => JSON.parse(await readFile(join(stateDir, 'session.json'), 'utf8')),
  }
}

describe('authenticated chat billing through real Loader and live Sessions', () => {
  it('uses the advertised read-only batch through the real auth-refresh owner and retains receipt caches', async () => {
    const app = await boot()
    app.enableBatch()
    app.rejectAccess()
    const session = app.context.sessions.create(SessionId('chat-one'))
    for (let turn = 1; turn <= 105; turn++) app.appendTurn(session, turn, `batch-receipt-${String(turn)}`)
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: true, payload: { status: 'settled',
      settledRequests: 105, amountBasis: 'consumption-logs', refundStatus: 'unknown', settlementStatus: 'unknown' } })
    expect(app.batches.map(ids => ids.length)).toEqual([100, 5])
    expect(app.ledgerCalls()).toHaveLength(0)
    expect(app.calls.filter(call => call.path.endsWith('/auth/refresh'))).toHaveLength(1)
    expect(app.calls.filter(call => call.path.endsWith('/api/log/self/batch'))
      .every(call => call.authorization === 'Bearer renewed-access')).toBe(true)
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 6000)
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: true, payload: { settledRequests: 105 } })
    expect(app.batches).toHaveLength(2)
  })

  it('keeps a batch not-found result unknown without presenting a pending or zero charge', async () => {
    const app = await boot()
    app.enableBatch()
    app.appendTurn(app.context.sessions.create(SessionId('chat-one')), 1, 'unqueryable-receipt')
    app.pending('unqueryable-receipt')
    const outcome: unknown = await (await app.fetchUsage()).json()
    expect(outcome).toMatchObject({ ok: true, payload: { status: 'unavailable', totalRequests: 1, settledRequests: 0,
      amountBasis: 'consumption-logs', refundStatus: 'unknown', settlementStatus: 'unknown' } })
    expect(outcome).not.toHaveProperty('payload.points')
    expect(app.ledgerCalls()).toHaveLength(0)
  })

  it('does not fall back to individual GETs when an advertised batch is rate limited', async () => {
    const app = await boot()
    app.enableBatch()
    app.failBatch()
    app.appendTurn(app.context.sessions.create(SessionId('chat-one')), 1, 'batch-limited')
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: false,
      code: 'CHAT_USAGE_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 45 })
    const before = app.calls.length
    expect(await (await fetch(`${app.base}/credits/api/summary`, { headers: { cookie: app.cookie } })).json())
      .toMatchObject({ ok: false, code: 'BALANCE_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 45 })
    expect(app.calls).toHaveLength(before)
    expect(app.ledgerCalls()).toHaveLength(0)
    expect(app.calls.filter(call => call.path.endsWith('/api/log/self/batch'))).toHaveLength(1)
  })

  it.each([
    { retryAfter: '45' },
    { retryAfter: 'Mon, 26 Oct 2026 10:00:45 GMT', date: 'Mon, 26 Oct 2026 10:00:00 GMT' },
  ])('shares an empty receipt 429 with balance, session and usage without losing login: $retryAfter', async (failure) => {
    const app = await boot()
    app.appendTurn(app.context.sessions.create(SessionId('chat-one')), 1, 'limited-receipt')
    app.failLedger(failure.retryAfter, failure.date)
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: false,
      code: 'CHAT_USAGE_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 45 })
    const before = app.calls.length
    for (const [route, code] of [
      ['/session', 'ACCOUNT_RATE_LIMITED'], ['/summary', 'BALANCE_RATE_LIMITED'],
      ['/usage?start=1792000800&end=1792087199', 'USAGE_RATE_LIMITED'],
    ]) {
      expect(await (await fetch(`${app.base}/credits/api${route}`, { headers: { cookie: app.cookie } })).json())
        .toMatchObject({ ok: false, code, httpStatus: 429, retryAfterSeconds: 45 })
    }
    expect(app.calls).toHaveLength(before)
    expect(await app.storedSession()).toMatchObject({ token: 'first-private-login', account: { id: '7' },
      upstream: { token: 'first-access', refresh: 'first-refresh' } })
    expect(app.calls.some(call => call.path.endsWith('/auth/refresh'))).toBe(false)
  })

  it('renews an explicitly rejected account GET once through the shared owner for all four read routes', async () => {
    const app = await boot()
    app.appendTurn(app.context.sessions.create(SessionId('chat-one')), 1, 'renewed-receipt')
    app.rejectAccess()
    for (const route of ['/usage?start=1792000800&end=1792087199', '/summary', '/session']) {
      expect(await (await fetch(`${app.base}/credits/api${route}`, { headers: { cookie: app.cookie } })).json())
        .toMatchObject({ ok: true })
    }
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: true, payload: { status: 'settled', points: 1.46 } })
    expect(app.calls.filter(call => call.path.endsWith('/auth/refresh'))).toHaveLength(1)
    expect(app.calls.filter(call => call.authorization === 'Bearer first-access')).toHaveLength(1)
    expect(app.calls.some(call => call.authorization === 'Bearer renewed-access')).toBe(true)
    expect(await app.storedSession()).toMatchObject({ token: 'first-private-login', account: { id: '7' },
      upstream: { token: 'renewed-access', refresh: 'renewed-refresh' } })
  })

  it('retains a renewal 429 across all account read routes without treating the valid stored login as signed out', async () => {
    const app = await boot()
    app.appendTurn(app.context.sessions.create(SessionId('chat-one')), 1, 'renewal-limited')
    app.failRefresh()
    for (const [route, code] of [
      ['/usage?start=1792000800&end=1792087199', 'USAGE_RATE_LIMITED'],
      ['/chat-usage?session_id=chat-one&account_id=7', 'CHAT_USAGE_RATE_LIMITED'],
      ['/summary', 'BALANCE_RATE_LIMITED'], ['/session', 'ACCOUNT_RATE_LIMITED'],
    ]) {
      const result: unknown = await (await fetch(`${app.base}/credits/api${route}`, { headers: { cookie: app.cookie } })).json()
      expect(result).toMatchObject({ ok: false, code, httpStatus: 429, retryAfterSeconds: 45 })
    }
    expect(app.calls.filter(call => call.path.endsWith('/auth/refresh'))).toHaveLength(1)
    expect(await app.storedSession()).toMatchObject({ token: 'first-private-login', account: { id: '7' },
      upstream: { token: 'first-access', refresh: 'first-refresh' } })
  })

  it('discards an ordinary usage read when another account replaces its original identity', async () => {
    const app = await boot()
    app.holdLedger()
    const oldRead = fetch(`${app.base}/credits/api/usage?start=1792000800&end=1792087199`, { headers: { cookie: app.cookie } })
    await app.ledgerRequested()
    const login = await fetch(`${app.base}/credits/api/session/verify`, { method: 'POST',
      headers: { cookie: app.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: '+8613800000001', code: '123456', idempotencyKey: 'second-login' }) })
    expect(await login.json()).toMatchObject({ ok: true })
    app.releaseLedger()
    expect(await (await oldRead).json()).toMatchObject({ ok: false, code: 'ACCOUNT_CHANGED' })
    expect(await (await fetch(`${app.base}/credits/api/usage?start=1792000800&end=1792087199`,
      { headers: { cookie: app.cookie } })).json()).toMatchObject({ ok: true })
    expect(await app.storedSession()).toMatchObject({ account: { id: '8' }, upstream: { token: 'second-access' } })
  })

  it('discards a cancelled old-account balance read after another account replaces its identity', async () => {
    const app = await boot()
    app.holdStatus()
    const oldRead = fetch(`${app.base}/credits/api/summary`, { headers: { cookie: app.cookie } })
    await app.statusRequested()
    const login = await fetch(`${app.base}/credits/api/session/verify`, { method: 'POST',
      headers: { cookie: app.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: '+8613800000001', code: '123456', idempotencyKey: 'second-login' }) })
    expect(await login.json()).toMatchObject({ ok: true })
    app.releaseStatus()
    expect(await (await oldRead).json()).toMatchObject({ ok: false, code: 'ACCOUNT_CHANGED' })
    expect(await (await fetch(`${app.base}/credits/api/summary`, { headers: { cookie: app.cookie } })).json())
      .toMatchObject({ ok: true, account: { id: '8' } })
  })

  it('rejects anonymous and injected selectors, reads actual attached history and cleans up its route', async () => {
    const app = await boot()
    const session = app.context.sessions.create(SessionId('chat-one'))
    app.appendTurn(session, 1, 'own-receipt')
    expect((await fetch(`${app.base}/credits/api/chat-usage?session_id=chat-one`)).status).toBe(401)
    for (const query of [
      '', 'session_id=../secret', 'session_id=chat-one&session_id=chat-two', 'session_id=chat-one&turn=0',
      'session_id=chat-one&turn=1&turn=2', 'session_id=chat-one&account_id=-7', 'session_id=chat-one&request_id=other',
      'session_id=chat-one&baseUrl=https://other.test', 'session_id=chat-one&quota=100',
    ]) expect((await app.fetchUsage(query)).status).toBe(400)
    expect((await app.fetchUsage(undefined, { method: 'POST' })).status).toBe(405)
    expect((await app.fetchUsage(undefined, { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
    expect(app.calls).toHaveLength(0)
    expect(await (await app.fetchUsage('session_id=chat-one&account_id=8')).json()).toEqual({ ok: false, code: 'ACCOUNT_CHANGED' })
    const result = await app.fetchUsage('session_id=chat-one&turn=1&account_id=7')
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.json()).toEqual({ ok: true, payload: {
      scope: 'chat-model', status: 'settled', points: 1.46, settledRequests: 1, totalRequests: 1, accountId: '7',
    } })
    expect(app.ledgerCalls().map(call => call.requestId)).toEqual(['own-receipt'])
    expect(app.ledgerCalls()[0]?.authorization).toBe('Bearer first-access')
    expect(app.calls.every(call => call.path.startsWith('/harness/api/'))).toBe(true)
    const fiber = [...app.context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-credits-index')?.fiber
    await fiber?.dispose()
    expect(app.context.sessionProjections.stateOf(session, 'chatReceipts')).toBeUndefined()
    expect((await app.fetchUsage()).status).toBe(404)
  })

  it('keeps an open turn pending and unknown or detached sessions unavailable', async () => {
    const app = await boot()
    const session = app.context.sessions.create(SessionId('chat-one'))
    app.appendTurn(session, 1, 'ongoing', false)
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: true, payload: { status: 'pending' } })
    expect(await (await app.fetchUsage('session_id=not-attached')).json()).toMatchObject({ ok: true, payload: { status: 'unavailable' } })
    expect(app.calls).toHaveLength(0)
    const missing = await app.fetchUsage('session_id=chat-one&turn=2')
    expect(await missing.json()).toMatchObject({ ok: true, payload: { status: 'unavailable' } })
  })

  it('fails safely when the Session lookup service is absent', async () => {
    const app = await boot({ sessions: false })
    const result: unknown = await (await app.fetchUsage()).json()
    expect(result).toEqual({ ok: true, payload: { scope: 'chat-model', status: 'unavailable', settledRequests: 0, totalRequests: 0, accountId: '7' } })
    expect(app.calls).toHaveLength(0)
  })

  it('fails safely when the Host projection registry is absent', async () => {
    const app = await boot({ projections: false })
    const session = app.context.sessions.create(SessionId('chat-one'))
    app.appendTurn(session, 1, 'unprojected-receipt')
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: true, payload: { status: 'unavailable' } })
    expect(app.calls).toHaveLength(0)
  })

  it('restores receipt projection state from committed history without retaining message content', async () => {
    const app = await boot()
    const original = app.context.sessions.create(SessionId('chat-one'))
    app.appendTurn(original, 1, 'restored-receipt')
    const restored = app.context.sessions.create(SessionId('restored-chat'), { seed: original.snapshotEvents() })
    expect(await (await app.fetchUsage('session_id=restored-chat&turn=1')).json()).toMatchObject({ ok: true, payload: { status: 'settled', points: 1.46 } })
    const state = app.context.sessionProjections.stateOf(restored, 'chatReceipts')
    expect(state?.turns['1']?.requests).toHaveLength(1)
    expect(JSON.stringify(state)).not.toContain('done')
    expect(app.ledgerCalls().map(call => call.requestId)).toEqual(['restored-receipt'])
  })

  it('shares flights and receipt cache without letting one cancelled browser stop another', async () => {
    const app = await boot()
    const session = app.context.sessions.create(SessionId('chat-one'))
    app.appendTurn(session, 1, 'shared-receipt')
    app.holdLedger()
    const cancel = new AbortController()
    const first = app.fetchUsage(undefined, { signal: cancel.signal }).catch((error: unknown) => error)
    const second = app.fetchUsage()
    await app.ledgerRequested()
    cancel.abort()
    app.releaseLedger()
    expect(await first).toBeInstanceOf(Error)
    expect(await (await second).json()).toMatchObject({ ok: true, payload: { points: 1.46, status: 'settled' } })
    expect(app.ledgerCalls()).toHaveLength(1)
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: true, payload: { points: 1.46 } })
    app.exchange(14.6)
    expect(await (await app.fetchUsage('session_id=chat-one&turn=1')).json()).toMatchObject({ ok: true, payload: { points: 1.46 } })
    expect(app.ledgerCalls()).toHaveLength(1)
    expect(app.calls.filter(call => call.path.endsWith('/api/status'))).toHaveLength(1)
    const now = performance.now()
    vi.spyOn(performance, 'now').mockReturnValue(now + 6000)
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: true, payload: { points: 2.92 } })
    expect(app.ledgerCalls()).toHaveLength(1)
    expect(app.calls.filter(call => call.path.endsWith('/api/status'))).toHaveLength(2)
  })

  it('briefly caches a missing receipt then observes later settlement', async () => {
    const app = await boot()
    const session = app.context.sessions.create(SessionId('chat-one'))
    app.appendTurn(session, 1, 'late-receipt')
    app.pending('late-receipt')
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: true, payload: { status: 'pending' } })
    app.settle('late-receipt')
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: true, payload: { status: 'pending' } })
    expect(app.ledgerCalls()).toHaveLength(1)
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 6000)
    expect(await (await app.fetchUsage()).json()).toMatchObject({ ok: true, payload: { status: 'settled', points: 1.46 } })
    expect(app.ledgerCalls()).toHaveLength(2)
  })

  it('aborts shared ledger work and removes the route on plugin disposal', async () => {
    const app = await boot()
    const session = app.context.sessions.create(SessionId('chat-one'))
    app.appendTurn(session, 1, 'stopping-receipt')
    app.holdLedger()
    const result = app.fetchUsage()
    await app.ledgerRequested()
    const fiber = [...app.context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-credits-index')?.fiber
    await fiber?.dispose()
    expect(await (await result).json()).toMatchObject({ ok: true, payload: { status: 'unavailable' } })
    expect((await app.fetchUsage()).status).toBe(404)
  })

  it('bounds the shared exact-receipt read concurrency', async () => {
    const app = await boot({ concurrency: 2 })
    const session = app.context.sessions.create(SessionId('chat-one'))
    for (let turn = 1; turn <= 6; turn++) app.appendTurn(session, turn, `receipt-${String(turn)}`)
    app.holdLedger()
    const result = app.fetchUsage()
    await app.ledgerRequested()
    app.releaseLedger()
    expect(await (await result).json()).toMatchObject({ ok: true, payload: { status: 'settled', settledRequests: 6, totalRequests: 6, points: expect.closeTo(8.76) as number } })
    expect(app.peakLedger()).toBeLessThanOrEqual(2)
    expect(app.ledgerCalls()).toHaveLength(6)
  })

  it('drops an old-account result and cache when another login completes', async () => {
    const app = await boot()
    const session = app.context.sessions.create(SessionId('chat-one'))
    app.appendTurn(session, 1, 'first-account-receipt')
    app.holdLedger()
    const oldRead = app.fetchUsage()
    await app.ledgerRequested()
    const login = await fetch(`${app.base}/credits/api/session/verify`, { method: 'POST', headers: { cookie: app.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: '+8613800000001', code: '123456', idempotencyKey: 'second-login' }) })
    expect(await login.json()).toMatchObject({ ok: true })
    app.releaseLedger()
    expect(await (await oldRead).json()).toEqual({ ok: false, code: 'ACCOUNT_CHANGED' })
    expect(await (await app.fetchUsage()).json()).toEqual({ ok: false, code: 'ACCOUNT_CHANGED' })
    expect(await (await app.fetchUsage('session_id=chat-one&account_id=8')).json()).toMatchObject({ ok: true, payload: { status: 'pending', accountId: '8' } })
    const logout = await fetch(`${app.base}/credits/api/session/logout`, { method: 'POST', headers: { cookie: app.cookie, 'content-type': 'application/json' }, body: '{}' })
    expect(await logout.json()).toMatchObject({ ok: true })
    expect(await (await app.fetchUsage('session_id=chat-one')).json()).toEqual({ ok: false, code: 'SESSION_REQUIRED' })
  })
})
