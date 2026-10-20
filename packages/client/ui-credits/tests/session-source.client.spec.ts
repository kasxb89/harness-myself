// @vitest-environment jsdom
/** Shared account observation and stale-read containment for creation consumers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  get: vi.fn<(path: string, signal?: AbortSignal) => Promise<{ payload?: unknown }>>(),
  post: vi.fn<() => Promise<void>>(),
}))
vi.mock('../src/client/api.ts', () => ({ ...api, newKey: () => 'logout-test' }))

const account = (id: string) => ({ signedIn: true, creditsPerYuan: 1000, account: { id, phone: 'test' } })
const balance = (points: number) => ({ balance_points: points, as_of: '2026-10-17T00:00:00Z' })

beforeEach(() => {
  vi.resetModules()
  api.get.mockReset()
  api.post.mockReset().mockResolvedValue()
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers() })

describe('injected credits session source', () => {
  it('changes the account epoch only on identity transitions, including logout and return', async () => {
    let id = 'a'
    api.get.mockImplementation(async path => ({ payload: path.endsWith('/session') ? account(id) : balance(1234) }))
    const { createCreditsSessionSource, refreshCredits, signOutCredits } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource()
    await refreshCredits()
    expect(source.getSnapshot().accountEpoch).toBe(1)
    await refreshCredits()
    expect(source.getSnapshot().accountEpoch).toBe(1)
    id = 'b'
    await refreshCredits()
    expect(source.getSnapshot().accountEpoch).toBe(2)
    await signOutCredits()
    expect(source.getSnapshot().accountEpoch).toBe(3)
    await refreshCredits()
    expect(source.getSnapshot().accountEpoch).toBe(4)
  })

  it('reports an unavailable background read while retaining the last verified account', async () => {
    api.get.mockImplementation(async path => ({ payload: path.endsWith('/session') ? account('a') : balance(1234) }))
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
    const read = Promise.withResolvers<{ payload?: unknown }>()
    api.get.mockReturnValueOnce(read.promise)
    const { createCreditsSessionSource } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource(), listener = vi.fn()
    const stop = source.subscribe(listener)
    const signal = api.get.mock.calls[0]?.[1]
    stop()
    read.resolve({ payload: account('late') })
    await vi.advanceTimersByTimeAsync(0)
    expect(signal?.aborted).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    expect(source.getSnapshot().session).toBeNull()
  })

  it('shares the existing snapshot and stops its heartbeat after the final observer leaves', async () => {
    api.get.mockImplementation(async path => ({ payload: path.endsWith('/session') ? account('a') : balance(1234) }))
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

  it('clears observers before logout settles and rejects an older signed-in session read', async () => {
    const read = Promise.withResolvers<{ payload?: unknown }>()
    const logout = Promise.withResolvers<undefined>()
    api.get.mockReturnValueOnce(read.promise)
    api.post.mockReturnValueOnce(logout.promise)
    const { createCreditsSessionSource, signOutCredits } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource(), listener = vi.fn()
    const stop = source.subscribe(listener)
    const operation = signOutCredits()
    try {
      expect(source.getSnapshot().session?.signedIn).toBe(false)
      expect(listener).toHaveBeenCalled()
      read.resolve({ payload: account('old') })
      await vi.advanceTimersByTimeAsync(0)
      expect(source.getSnapshot().session?.signedIn).toBe(false)
      expect(api.get).toHaveBeenCalledTimes(1)
    } finally {
      read.resolve({ payload: account('old') })
      logout.resolve(undefined)
      await operation
      stop()
    }
  })

  it('does not publish an old account balance after a different session is read', async () => {
    const oldBalance = Promise.withResolvers<{ payload?: unknown }>()
    api.get.mockImplementation(async (path) => {
      if (!path.endsWith('/session')) return { payload: balance(9000) }
      return { payload: account('b') }
    })
    api.get.mockResolvedValueOnce({ payload: account('a') }).mockReturnValueOnce(oldBalance.promise)
    const { createCreditsSessionSource, refreshCredits } = await import('../src/client/session-store.ts')
    const source = createCreditsSessionSource(), stop = source.subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(source.getSnapshot().session?.account?.id).toBe('a')
      await refreshCredits()
      oldBalance.resolve({ payload: balance(1) })
      await vi.advanceTimersByTimeAsync(0)
      expect(source.getSnapshot().session?.account?.id).toBe('b')
      expect(source.getSnapshot().balance?.balance_points).toBe(9000)
    } finally {
      oldBalance.resolve({ payload: balance(1) })
      await vi.advanceTimersByTimeAsync(0)
      stop()
    }
  })
})
