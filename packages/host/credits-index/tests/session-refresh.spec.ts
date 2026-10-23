/** Renewal failures retain ownership, share cooldowns and bound uncertain-cookie recovery. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionRefresh, refreshRetryDelay, type StoredSession } from '../src/session-refresh.ts'
import { writePrivateState } from '../src/private-state-file.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function latch() {
  const { promise, resolve } = deferred<undefined>()
  return { promise, resolve: () => { resolve(undefined) } }
}

function success(now: number, id = 7, cookie = 'sid.secret-two'): Response {
  return new Response(JSON.stringify({ success: true, data: {
    access_token: 'access-new', access_expires_at: Math.floor(now / 1000) + 900, user: { id },
  } }), { headers: { 'set-cookie': `new_api_refresh=${cookie}; HttpOnly` } })
}

async function fixture(onFinished: (cleanup: () => Promise<void>) => void,
  fetch: (cookie: string, signal: AbortSignal) => Promise<Response>, options: { retries?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-refresh-'))
  const renewals: SessionRefresh[] = []
  onFinished(async () => {
    await Promise.all(renewals.map(renewal => renewal.dispose()))
    await rm(directory, { recursive: true, force: true })
  })
  const path = join(directory, 'session.json')
  let now = Date.UTC(2026, 9, 22)
  let version = 0
  const previous: StoredSession & { token: string } = {
    token: 'local-owner-one', backendBaseUrl: 'http://127.0.0.1:1/harness', expiresAt: '2099-01-01T00:00:00Z',
    account: { id: '7', phone: '***0000' }, upstream: { token: 'access-old', refresh: 'sid.secret-one',
      expiresAt: '2000-01-01T00:00:00Z' }, relay: { key: 'sk-fixture-owned' },
  }
  await writePrivateState(path, JSON.stringify(previous))
  const store = {
    path,
    async read(): Promise<StoredSession | null> {
      const raw = JSON.parse(await readFile(path, 'utf8')) as StoredSession
      return raw.token === undefined ? null : raw
    },
    async write(value: StoredSession & { token: string }): Promise<void> {
      await writePrivateState(path, JSON.stringify(value))
    },
  }
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => await withFileLock(path, operation)
  const reasons: string[] = []
  const settings = { baseUrl: previous.backendBaseUrl!, timeoutMs: 15_000, retryBaseDelayMs: 1000,
    retryMaxDelayMs: 60_000, recoveryRetryLimit: options.retries ?? 2, store, now: () => now, version: () => version,
    mutate, fetch, unavailable: (reason: string) => { reasons.push(reason) },
    unauthorized: async (captured: StoredSession, capturedVersion: number) => await mutate(async () => {
      const current = await store.read()
      if (version !== capturedVersion || current === null || current.token !== captured.token
        || current.upstream?.refresh !== captured.upstream?.refresh) return false
      await writePrivateState(path, '{}')
      version += 1
      return true
    }),
  }
  const renewal = new SessionRefresh(settings)
  renewals.push(renewal)
  return { previous, store, renewal, settings, reasons, now: () => now,
    advance: (milliseconds: number) => { now += milliseconds },
    replace: async (session: StoredSession & { token: string }) => { version += 1; await mutate(() => store.write(session)) },
    fork: () => { const next = new SessionRefresh(settings); renewals.push(next); return next },
  }
}

it.each(['17', ' 17 ', 'Thu, 22 Oct 2026 00:00:17 GMT'])(
  'honors Retry-After %s without a response body', (header) => {
    expect(refreshRetryDelay(header, 1, Date.UTC(2026, 9, 22), 1000, 5000)).toBe(17_000)
  },
)

it.each([null, '', 'invalid', '-1', '1.5', '1e3', 'Infinity', '999999999999999999999999999'])(
  'uses bounded conservative delay for Retry-After %s', (header) => {
    expect(refreshRetryDelay(header, 1, Date.UTC(2026, 9, 22), 1000, 5000)).toBe(1000)
    expect(refreshRetryDelay(header, 99, Date.UTC(2026, 9, 22), 1000, 5000)).toBe(5000)
  },
)

it('does not make zero or past Retry-After trigger an immediate loop', () => {
  for (const header of ['0', 'Wed, 21 Oct 2026 00:00:00 GMT']) {
    expect(refreshRetryDelay(header, 1, Date.UTC(2026, 9, 22), 1000, 5000)).toBe(1000)
  }
})

it('coalesces overlapping consumers and returns only the committed credential', async ({ onTestFinished }) => {
  const gate = deferred<Response>(), started = latch()
  const request = vi.fn(async () => { started.resolve(); return await gate.promise })
  const app = await fixture(onTestFinished, request)
  const reads = Array.from({ length: 30 }, () => app.renewal.refresh(app.previous))
  await started.promise
  expect(request).toHaveBeenCalledTimes(1)
  gate.resolve(success(app.now()))
  const results = await Promise.all(reads)
  expect(results.every(result => result?.upstream?.token === 'access-new')).toBe(true)
  expect(await app.store.read()).toEqual(results[0])
  expect(request).toHaveBeenCalledTimes(1)
  expect(await app.renewal.refresh(app.previous)).toEqual(results[0])
  expect(request).toHaveBeenCalledTimes(1)
})

it.each(['', '<html>legacy limit</html>', '{"code":"AUTH_REFRESH_RATE_LIMITED"}'])(
  'shares empty or old 429 cooldown across independent coordinators: %s', async (body) => {
    const request = vi.fn(async (): Promise<Response> => request.mock.calls.length === 1
      ? new Response(body, { status: 429, headers: { 'retry-after': '60' } }) : success(app.now()))
    const app: Awaited<ReturnType<typeof fixture>> = await fixture(onTestFinished, request)
    const second = app.fork()
    expect(await app.renewal.refresh(app.previous)).toBeNull()
    await Promise.all(Array.from({ length: 10 }, () => second.refresh(app.previous)))
    expect(request).toHaveBeenCalledTimes(1)
    expect(await app.store.read()).toEqual(app.previous)
    app.advance(59_999)
    expect(await second.refresh(app.previous)).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
    app.advance(1)
    expect(await second.refresh(app.previous)).toMatchObject({ upstream: { token: 'access-new' } })
    expect(request).toHaveBeenCalledTimes(2)
  },
)

it.each([500, 503])('keeps login and recovers HTTP %i without an immediate repeat', async (status) => {
  const request = vi.fn(async (): Promise<Response> => request.mock.calls.length === 1
    ? new Response('{"code":"AUTH_INTERNAL_ERROR"}', { status }) : success(app.now()))
  const app: Awaited<ReturnType<typeof fixture>> = await fixture(onTestFinished, request)
  expect(await app.renewal.refresh(app.previous)).toBeNull()
  expect(await app.store.read()).toEqual(app.previous)
  await app.renewal.refresh(app.previous)
  expect(request).toHaveBeenCalledTimes(1)
  app.advance(1000)
  expect(await app.renewal.refresh(app.previous)).toMatchObject({ upstream: { refresh: 'sid.secret-two' } })
  expect(request).toHaveBeenCalledTimes(2)
})

it.each(['network', 'timeout', 'protocol', 'identity_mismatch', 'upstream_rejected', '408', '429', '503'] as const)
('observes safe renewal failure %s only for its credential epoch and clears it after recovery', async (mode) => {
  const request = vi.fn(async (): Promise<Response> => {
    if (request.mock.calls.length > 1) return success(app.now())
    if (mode === 'network') throw new TypeError('private endpoint must not leak')
    if (mode === 'timeout') throw new DOMException('private timeout must not leak', 'TimeoutError')
    if (mode === 'protocol') return new Response('{private-invalid-json')
    if (mode === 'identity_mismatch') return success(app.now(), 8)
    if (mode === 'upstream_rejected') return Response.json({ success: false, message: 'private rejection' })
    return new Response('', { status: Number(mode) })
  })
  const app: Awaited<ReturnType<typeof fixture>> = await fixture(onTestFinished, request)
  expect(await app.renewal.refresh(app.previous)).toBeNull()
  const reason = mode === '408' ? 'timeout' : mode === '429' ? 'rate_limited' : mode === '503' ? 'upstream_unavailable' : mode
  const status = /^\d/u.test(mode) ? Number(mode)
    : mode === 'protocol' || mode === 'identity_mismatch' || mode === 'upstream_rejected' ? 200 : undefined
  expect(app.renewal.lastFailure(app.previous)).toEqual({ reason, stage: 'renewal', ...status === undefined ? {} : { status } })
  expect(app.renewal.lastFailure({ ...app.previous, token: 'different-local-login' })).toBeUndefined()
  expect(await app.store.read()).toEqual(app.previous)
  await app.renewal.refresh(app.previous)
  expect(request).toHaveBeenCalledTimes(1)
  app.advance(1000)
  const recovered = await app.renewal.refresh(app.previous)
  expect(recovered?.upstream?.token).toBe('access-new')
  expect(app.renewal.lastFailure(app.previous)).toBeUndefined()
  expect(recovered === null ? undefined : app.renewal.lastFailure(recovered)).toBeUndefined()
})

it('reports unreadable renewal metadata as storage without clearing the account', async ({ onTestFinished }) => {
  const app = await fixture(onTestFinished, async () => success(Date.UTC(2026, 9, 22)))
  await writePrivateState(app.store.path + '.renewal', '{invalid-private-state')
  expect(await app.renewal.canUseAccess(app.previous)).toBe(false)
  expect(app.renewal.lastFailure(app.previous)).toEqual({ reason: 'storage', stage: 'renewal' })
  expect(await app.store.read()).toEqual(app.previous)
})

it('reports a failed renewal credential commit as storage while retaining the old login', async ({ onTestFinished }) => {
  const app = await fixture(onTestFinished, async () => success(Date.UTC(2026, 9, 22)))
  app.settings.store.write = async () => { throw new Error('private storage path must not leak') }
  expect(await app.renewal.refresh(app.previous)).toBeNull()
  expect(app.renewal.lastFailure(app.previous)).toEqual({ reason: 'storage', stage: 'renewal' })
  expect(await app.store.read()).toEqual(app.previous)
})

it('does not replay an uncertain cookie after the server recovery window', async ({ onTestFinished }) => {
  const request = vi.fn(async (_cookie: string, _signal: AbortSignal): Promise<Response> => { throw new Error('fixture transport lost after dispatch') })
  const app = await fixture(onTestFinished, request)
  expect(await app.renewal.refresh(app.previous)).toBeNull()
  app.advance(30_001)
  expect(await app.renewal.refresh(app.previous)).toBeNull()
  expect(await app.store.read()).toEqual(app.previous)
  expect(request).toHaveBeenCalledTimes(1)
  const fresh = { ...app.previous, upstream: { ...app.previous.upstream, refresh: 'sid.current-from-other-host' } }
  await app.replace(fresh)
  await app.renewal.refresh(fresh)
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1]?.[0]).toBe('sid.current-from-other-host')
})

it('shares rejected access state and permits only a confirmed new credential', async ({ onTestFinished }) => {
  const request = vi.fn(async (): Promise<Response> => request.mock.calls.length === 1
    ? new Response('', { status: 429, headers: { 'retry-after': '60' } }) : success(app.now()))
  const app: Awaited<ReturnType<typeof fixture>> = await fixture(onTestFinished, request)
  const peer = app.fork()
  await app.renewal.rejectAccess(app.previous)
  expect(await peer.canUseAccess(app.previous)).toBe(false)
  expect(await app.renewal.refresh(app.previous)).toBeNull()
  expect(await peer.canUseAccess(app.previous)).toBe(false)
  expect(await app.store.read()).toEqual(app.previous)
  app.advance(60_000)
  const renewed = await peer.refresh(app.previous)
  if (renewed === null) throw new Error('Expected confirmed recovery')
  expect(await app.renewal.canUseAccess(renewed)).toBe(true)
  expect(request).toHaveBeenCalledTimes(2)
})

it('does not let an old access rejection poison a newer epoch', async ({ onTestFinished }) => {
  const app = await fixture(onTestFinished, async () => success(Date.UTC(2026, 9, 22)))
  const replacement = { ...app.previous, upstream: { ...app.previous.upstream, token: 'current-access', refresh: 'sid.current-secret' } }
  await app.replace(replacement)
  await app.renewal.rejectAccess(app.previous)
  expect(await app.renewal.canUseAccess(replacement)).toBe(true)
  expect(await app.store.read()).toEqual(replacement)
})

it('recovers in the background once the owned retry delay elapses and stops on dispose', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
  const second = latch()
  const request = vi.fn(async (): Promise<Response> => {
    if (request.mock.calls.length === 1) return new Response('', { status: 503 })
    second.resolve()
    return success(app.now())
  })
  const app: Awaited<ReturnType<typeof fixture>> = await fixture(onTestFinished, request)
  try {
    expect(await app.renewal.refresh(app.previous)).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
    app.advance(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await second.promise
    await app.renewal.pending(app.previous.token)
    expect(await app.store.read()).toMatchObject({ upstream: { token: 'access-new' } })
    await app.renewal.dispose()
    await vi.advanceTimersByTimeAsync(3600_000)
    expect(request).toHaveBeenCalledTimes(2)
  } finally { await app.renewal.dispose(); vi.useRealTimers() }
})

it.each(['', '<html>invalid credential</html>'])(
  'invalidates only the terminal 401 owner, even with body %s', async (body) => {
    const request = vi.fn(async () => new Response(body, { status: 401 }))
    const app = await fixture(onTestFinished, request)
    expect(await app.renewal.refresh(app.previous)).toBeNull()
    expect(await app.store.read()).toBeNull()
    await app.renewal.refresh(app.previous)
    expect(request).toHaveBeenCalledTimes(1)
  },
)

it.each([7, 8])('does not clear concurrent new login for account %s after an old 401', async (id) => {
  const gate = deferred<Response>(), started = latch()
  const request = vi.fn(async () => { started.resolve(); return await gate.promise })
  const app = await fixture(onTestFinished, request)
  const old = app.renewal.refresh(app.previous)
  await started.promise
  const replacement = { ...app.previous, token: 'new-local-login', account: { id: String(id), phone: '***2222' },
    upstream: { token: 'new-login-access', refresh: 'new-session.cookie', expiresAt: '2099-01-01T00:00:00Z' } }
  await app.replace(replacement)
  gate.resolve(new Response('', { status: 401 }))
  expect(await old).toBeNull()
  expect(await app.store.read()).toEqual(replacement)
})

it('does not publish an old successful response over a concurrent login', async ({ onTestFinished }) => {
  const gate = deferred<Response>(), started = latch()
  const app = await fixture(onTestFinished, async () => { started.resolve(); return await gate.promise })
  const old = app.renewal.refresh(app.previous)
  await started.promise
  const replacement = { ...app.previous, token: 'new-local-login' }
  await app.replace(replacement)
  gate.resolve(success(app.now()))
  expect(await old).toBeNull()
  expect(await app.store.read()).toEqual(replacement)
})

it('stops recovery timers and awaits the owned aborted exchange on dispose', async ({ onTestFinished }) => {
  const started = latch(), stopped = latch()
  const request = vi.fn(async (_cookie: string, signal: AbortSignal) => await new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => { stopped.resolve(); reject(new Error('fixture renewal disposed', { cause: signal.reason })) }, { once: true })
    started.resolve()
  }))
  const app = await fixture(onTestFinished, request)
  const pending = app.renewal.refresh(app.previous)
  await started.promise
  await app.renewal.dispose()
  await stopped.promise
  expect(await pending).toBeNull()
  await expect(readFile(`${app.store.path}.renewal.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await app.renewal.refresh(app.previous)).toBeNull()
  expect(request).toHaveBeenCalledTimes(1)
})

it('awaits a contended rejection write on dispose and prevents its late commit', async ({ onTestFinished }) => {
  const request = vi.fn(async () => success(Date.UTC(2026, 9, 22)))
  const app = await fixture(onTestFinished, request)
  const held = latch(), release = latch()
  const owner = withFileLock(`${app.store.path}.renewal`, async () => {
    held.resolve()
    await release.promise
  })
  onTestFinished(async () => { release.resolve(); await owner })
  await held.promise
  const settled: string[] = []
  const rejection = app.renewal.rejectAccess(app.previous).then(() => { settled.push('rejection') })
  const disposed = app.renewal.dispose().then(() => { settled.push('disposed') })
  release.resolve()
  await Promise.all([rejection, disposed, owner])
  expect(settled).toEqual(['rejection', 'disposed'])
  await expect(readFile(`${app.store.path}.renewal`)).rejects.toMatchObject({ code: 'ENOENT' })
  await app.renewal.rejectAccess(app.previous)
  await expect(readFile(`${app.store.path}.renewal.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(request).not.toHaveBeenCalled()
})

it('stops before dispatch when disposal overtakes the initial session read', async ({ onTestFinished }) => {
  const request = vi.fn(async () => success(Date.UTC(2026, 9, 22)))
  const app = await fixture(onTestFinished, request)
  const started = latch(), release = latch()
  app.settings.store.read = async () => { started.resolve(); await release.promise; return app.previous }
  const operation = app.renewal.refresh(app.previous)
  await started.promise
  const disposed = app.renewal.dispose()
  release.resolve()
  expect(await operation).toBeNull()
  await disposed
  expect(request).not.toHaveBeenCalled()
  expect(app.reasons).toEqual([])
  await expect(readFile(`${app.store.path}.renewal`)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retains read-only credential checks after disposal so owned local work can settle', async ({ onTestFinished }) => {
  const request = vi.fn(async () => success(Date.UTC(2026, 9, 22)))
  const app = await fixture(onTestFinished, request)
  await app.renewal.dispose()
  expect(await app.renewal.canUseAccess(app.previous)).toBe(true)
  expect(await app.renewal.refresh(app.previous)).toBeNull()
  expect(request).not.toHaveBeenCalled()
})

it('keeps a late storage failure silent while awaiting disposal', async ({ onTestFinished }) => {
  const request = vi.fn(async () => success(Date.UTC(2026, 9, 22)))
  const app = await fixture(onTestFinished, request)
  const started = latch(), release = latch()
  app.settings.store.read = async () => {
    started.resolve()
    await release.promise
    throw new Error('fixture session read unavailable')
  }
  const operation = app.renewal.refresh(app.previous)
  await started.promise
  const disposed = app.renewal.dispose()
  release.resolve()
  expect(await operation).toBeNull()
  await disposed
  expect(request).not.toHaveBeenCalled()
  expect(app.reasons).toEqual([])
})

it.each([200, 401, 429])('discards a late HTTP %i response after disposal without changing the login', async (status) => {
  const gate = deferred<Response>(), started = latch()
  const request = vi.fn(async () => { started.resolve(); return await gate.promise })
  const app = await fixture(onTestFinished, request)
  const operation = app.renewal.refresh(app.previous)
  await started.promise
  const disposed = app.renewal.dispose()
  const response = status === 200 ? success(app.now()) : new Response('', { status })
  gate.resolve(response)
  expect(await operation).toBeNull()
  await disposed
  expect(await app.store.read()).toEqual(app.previous)
  expect(JSON.parse(await readFile(`${app.store.path}.renewal`, 'utf8'))).toMatchObject({ terminal: false })
  expect(response.bodyUsed).toBe(true)
  expect(app.reasons).toEqual([])
})

it('contains an unexpected background reporting failure without an unhandled rejection', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
  const reported = latch()
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => { reported.resolve() })
  onTestFinished(() => { warning.mockRestore() })
  const request = vi.fn(async () => new Response('', { status: 503 }))
  const app = await fixture(onTestFinished, request)
  expect(await app.renewal.refresh(app.previous)).toBeNull()
  app.settings.unavailable = () => { throw new Error('fixture warning sink unavailable') }
  app.advance(1000)
  await vi.advanceTimersByTimeAsync(1000)
  await reported.promise
  expect(warning).toHaveBeenCalledTimes(1)
  expect(warning).toHaveBeenCalledWith('Account renewal background recovery stopped after a reporting failure.', {
    code: 'ACCOUNT_RENEWAL_BACKGROUND_FAILURE',
  })
  expect(await app.store.read()).toEqual(app.previous)
  await app.renewal.dispose()
})
