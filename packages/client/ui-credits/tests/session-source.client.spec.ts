// @vitest-environment jsdom
/** Shared account observation and stale-read containment for creation consumers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  get: vi.fn<(path: string, signal?: AbortSignal) => Promise<{
    ok: boolean
    payload?: unknown
    account?: { id: string } | null
    accountOwner?: string | null
    code?: string
    httpStatus?: number
    retryAfterSeconds?: number
    sessionInvalid?: boolean
  }>>(),
  post: vi.fn<() => Promise<{ ok: boolean }>>(),
}))
vi.mock('../src/client/api.ts', () => ({ ...api, newKey: () => 'logout-test' }))

const account = (id: string) => ({ signedIn: true, creditsPerYuan: 1000, account: { id, phone: 'test' } })
const balance = (points: number) => ({ balance_points: points, as_of: '2026-10-17T00:00:00Z' })

beforeEach(() => {
  vi.resetModules()
  api.get.mockReset()
  api.post.mockReset().mockResolvedValue({ ok: true })
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('injected credits session source', () => {
  it('advances the epoch for a new login of the same account but not a token refresh', async () => {
    let owner = 'a'.repeat(64)
    api.get.mockImplementation(async path => ({ ok: true,
      payload: path.endsWith('/session') ? { ...account('same'), accountOwner: owner } : balance(1234) }))
    const { createCreditsSessionSource, refreshCredits } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource()
    await refreshCredits()
    const epoch = source.getSnapshot().accountEpoch
    await refreshCredits()
    expect(source.getSnapshot().accountEpoch).toBe(epoch)
    owner = 'b'.repeat(64)
    await refreshCredits()
    expect(source.getSnapshot().accountEpoch).toBe(epoch + 1)
    expect(source.getSnapshot().session?.accountOwner).toBe(owner)
  })

  it('changes the account epoch only on identity transitions, including logout and return', async () => {
    let id = 'a'
    api.get.mockImplementation(async path => ({ ok: true, payload: path.endsWith('/session') ? account(id) : balance(1234) }))
    const { createCreditsSessionSource, refreshCredits, signOutCredits } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource()
    await refreshCredits()
    expect(source.getSnapshot().accountEpoch).toBe(1)
    await refreshCredits()
    expect(source.getSnapshot().accountEpoch).toBe(1)
    id = 'b'
    await refreshCredits()
    expect(source.getSnapshot().accountEpoch).toBe(2)
    api.get.mockResolvedValueOnce({ ok: true, payload: { signedIn: false, creditsPerYuan: 1000 } })
    await signOutCredits(20_000)
    expect(source.getSnapshot().accountEpoch).toBe(3)
    await refreshCredits()
    expect(source.getSnapshot().accountEpoch).toBe(4)
  })

  it('reports an unavailable background read while retaining the last verified account', async () => {
    api.get.mockImplementation(async path => ({ ok: true, payload: path.endsWith('/session') ? account('a') : balance(1234) }))
    const { createCreditsSessionSource } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource(), stop = source.subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      api.get.mockRejectedValueOnce(new Error('offline'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
      expect(source.getSnapshot().failure).toBe('ACCOUNT_UNAVAILABLE')
      expect(source.getSnapshot().session?.account?.id).toBe('a')
      expect(source.getSnapshot().balance?.balance_points).toBe(1234)
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
      expect(source.getSnapshot().failure).toBeNull()
    } finally { stop() }
  })

  it('aborts the final background read and contains a response arriving after release', async () => {
    const read = Promise.withResolvers<{ ok: boolean; payload?: unknown }>()
    api.get.mockReturnValueOnce(read.promise)
    const { createCreditsSessionSource } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource(), listener = vi.fn()
    const stop = source.subscribe(listener)
    const signal = api.get.mock.calls[0]?.[1]
    stop()
    read.resolve({ ok: true, payload: account('late') })
    await vi.advanceTimersByTimeAsync(0)
    expect(signal?.aborted).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    expect(source.getSnapshot().session).toBeNull()
  })

  it('shares the existing snapshot and stops its heartbeat after the final observer leaves', async () => {
    api.get.mockImplementation(async path => ({ ok: true, payload: path.endsWith('/session') ? account('a') : balance(1234) }))
    const { createCreditsSessionSource } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource()
    const first = vi.fn(), second = vi.fn()
    const stopFirst = source.subscribe(first), stopSecond = source.subscribe(second)
    stopFirst()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(api.get).toHaveBeenCalledTimes(2)
      expect(source.getSnapshot().session?.account?.id).toBe('a')
      expect(source.getSnapshot().balance?.balance_points).toBe(1234)
      expect(source.getSnapshot()).toBe(source.getSnapshot())
      await vi.advanceTimersByTimeAsync(60_000)
      expect(api.get).toHaveBeenCalledTimes(4)
      expect(second).toHaveBeenCalled()
    } finally { stopSecond() }
    const calls = api.get.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(api.get).toHaveBeenCalledTimes(calls)
  })

  it('invalidates older reads while awaiting confirmed local logout', async () => {
    const read = Promise.withResolvers<{ ok: boolean; payload?: unknown }>()
    const logout = Promise.withResolvers<{ ok: boolean }>()
    api.get.mockReturnValueOnce(read.promise)
    api.post.mockReturnValueOnce(logout.promise)
    const { createCreditsSessionSource, signOutCredits } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource(), listener = vi.fn()
    const stop = source.subscribe(listener)
    const operation = signOutCredits(20_000)
    try {
      expect(source.getSnapshot().session).toBeNull()
      expect(listener).toHaveBeenCalled()
      read.resolve({ ok: true, payload: account('old') })
      await vi.advanceTimersByTimeAsync(0)
      expect(source.getSnapshot().session).toBeNull()
      expect(api.get).toHaveBeenCalledTimes(1)
    } finally {
      read.resolve({ ok: true, payload: account('old') })
      api.get.mockResolvedValueOnce({ ok: true, payload: { signedIn: false, creditsPerYuan: 1000 } })
      logout.resolve({ ok: true })
      await operation
      stop()
    }
  })

  it('does not publish an old account balance after a different session is read', async () => {
    const oldBalance = Promise.withResolvers<{ ok: boolean; payload?: unknown }>()
    api.get.mockImplementation(async (path) => {
      if (!path.endsWith('/session')) return { ok: true, payload: balance(9000) }
      return { ok: true, payload: account('b') }
    })
    api.get.mockResolvedValueOnce({ ok: true, payload: account('a') }).mockReturnValueOnce(oldBalance.promise)
    const { createCreditsSessionSource, refreshCredits } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource(), stop = source.subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(source.getSnapshot().session?.account?.id).toBe('a')
      await refreshCredits()
      oldBalance.resolve({ ok: true, payload: balance(1) })
      await vi.advanceTimersByTimeAsync(0)
      expect(source.getSnapshot().session?.account?.id).toBe('b')
      expect(source.getSnapshot().balance?.balance_points).toBe(9000)
    } finally {
      oldBalance.resolve({ ok: true, payload: balance(1) })
      await vi.advanceTimersByTimeAsync(0)
      stop()
    }
  })

  it('retains a successful balance and login when a failed envelope contains payload null', async () => {
    api.get.mockImplementation(async path => ({ ok: true, payload: path.endsWith('/session') ? account('a') : balance(1234) }))
    const { createCreditsSessionSource, refreshCredits, refreshBalance } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource()
    await refreshCredits()
    const epoch = source.getSnapshot().accountEpoch
    api.get.mockResolvedValueOnce({ ok: false, code: 'BALANCE_UNAVAILABLE', payload: null })
    await refreshBalance()
    expect(source.getSnapshot()).toMatchObject({ accountEpoch: epoch, session: account('a'), balance: balance(1234),
      failure: 'BALANCE_UNAVAILABLE', readFailure: { kind: 'unavailable' }, refreshing: false })
    api.get.mockResolvedValueOnce({ ok: false, code: 'ACCOUNT_NETWORK_ERROR', payload: null })
    await refreshCredits()
    expect(source.getSnapshot()).toMatchObject({ accountEpoch: epoch, session: account('a'), balance: balance(1234),
      readFailure: { kind: 'network' } })
  })

  it.each([
    [{ ok: false, code: 'SESSION_REQUIRED', httpStatus: 401, sessionInvalid: true }, 'auth'],
    [{ ok: false, code: 'BALANCE_ACCESS_REQUIRED', httpStatus: 403 }, 'access'],
    [{ ok: true, payload: null }, 'invalid'],
  ])('never signs out or replaces the balance after an unsuccessful read: %j', async (failure, kind) => {
    api.get.mockImplementation(async path => ({ ok: true, payload: path.endsWith('/session') ? account('a') : balance(1234) }))
    const { createCreditsSessionSource, refreshCredits, refreshBalance } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource()
    await refreshCredits()
    api.get.mockResolvedValueOnce(failure)
    await refreshBalance()
    expect(source.getSnapshot()).toMatchObject({ session: account('a'), balance: balance(1234), readFailure: { kind } })
  })

  it('shares balance reads and honors a 429 cooldown before accepting another manual read', async () => {
    let monotonic = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    api.get.mockImplementation(async path => ({ ok: true, payload: path.endsWith('/session') ? account('a') : balance(1234) }))
    const { createCreditsSessionSource, refreshCredits, refreshBalance } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource()
    await refreshCredits()
    const read = Promise.withResolvers<{ ok: boolean; code: string; httpStatus: number; retryAfterSeconds: number; payload: null }>()
    api.get.mockReturnValueOnce(read.promise)
    const first = refreshBalance(), second = refreshBalance()
    expect(api.get).toHaveBeenCalledTimes(3)
    read.resolve({ ok: false, code: 'BALANCE_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 30, payload: null })
    await Promise.all([first, second])
    expect(source.getSnapshot()).toMatchObject({ balance: balance(1234), readFailure: { kind: 'rateLimited', retryAfterSeconds: 30 } })
    await refreshBalance()
    await refreshCredits()
    expect(api.get).toHaveBeenCalledTimes(3)
    vi.setSystemTime(new Date('2000-01-01'))
    monotonic += 30_000
    await refreshBalance()
    expect(api.get).toHaveBeenCalledTimes(4)
    expect(source.getSnapshot().readFailure).toBeNull()
  })

  it.each([{ id: 'b' }, null])('retains A when a successful summary identifies another current account: %j', async (owner) => {
    api.get.mockImplementation(async path => ({ ok: true, payload: path.endsWith('/session') ? account('a') : balance(1234) }))
    const { createCreditsSessionSource, refreshCredits, refreshBalance } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource()
    await refreshCredits()
    const epoch = source.getSnapshot().accountEpoch
    const before = api.get.mock.calls.length
    api.get.mockResolvedValueOnce({ ok: true, account: owner, payload: balance(9999) })
    await refreshBalance()
    expect(source.getSnapshot()).toMatchObject({ accountEpoch: epoch, session: account('a'), balance: balance(1234),
      failure: 'ACCOUNT_CHANGED', readFailure: { kind: 'accountChanged' }, refreshing: false })
    expect(api.get).toHaveBeenCalledTimes(before + 1)
    api.get.mockResolvedValueOnce({ ok: true, payload: account('b') })
      .mockResolvedValueOnce({ ok: true, account: { id: 'b' }, payload: balance(4567) })
    await refreshCredits()
    expect(source.getSnapshot()).toMatchObject({ session: account('b'), balance: balance(4567), failure: null, readFailure: null })
  })

  it('accepts the observed account and preserves compatibility with older summaries without an account field', async () => {
    api.get.mockImplementation(async path => ({ ok: true, payload: path.endsWith('/session') ? account('a') : balance(1234) }))
    const { createCreditsSessionSource, refreshCredits, refreshBalance } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource()
    await refreshCredits()
    api.get.mockResolvedValueOnce({ ok: true, account: { id: 'a' }, payload: balance(4567) })
    await refreshBalance()
    expect(source.getSnapshot().balance?.balance_points).toBe(4567)
    api.get.mockResolvedValueOnce({ ok: true, payload: balance(8910) })
    await refreshBalance()
    expect(source.getSnapshot()).toMatchObject({ session: account('a'), balance: balance(8910), failure: null })
  })

  it('clears the old account balance immediately on an identity change and ignores a late logged-out balance', async () => {
    api.get.mockImplementation(async path => ({ ok: true, payload: path.endsWith('/session') ? account('a') : balance(1234) }))
    const { createCreditsSessionSource, refreshCredits, signOutCredits, refreshBalance } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource()
    await refreshCredits()
    const next = Promise.withResolvers<{ ok: boolean; payload: unknown }>()
    api.get.mockResolvedValueOnce({ ok: true, payload: account('b') }).mockReturnValueOnce(next.promise)
    const changed = refreshCredits()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot().session?.account?.id).toBe('b')
    expect(source.getSnapshot().balance).toBeNull()
    api.get.mockResolvedValueOnce({ ok: true, payload: { signedIn: false, creditsPerYuan: 1000 } })
    await signOutCredits(20_000)
    next.resolve({ ok: true, payload: balance(1) })
    await changed
    expect(source.getSnapshot()).toMatchObject({ session: { signedIn: false }, balance: null, refreshing: false })
    api.get.mockResolvedValueOnce({ ok: false, code: 'BALANCE_RATE_LIMITED', httpStatus: 429 })
    await refreshBalance()
    expect(source.getSnapshot().session?.signedIn).toBe(false)
  })
})
