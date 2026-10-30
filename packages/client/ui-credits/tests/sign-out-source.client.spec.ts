// @vitest-environment jsdom
/** Logout confirmation retains unknown or live credentials until the Host confirms their absence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({
  get: vi.fn<(path: string, signal?: AbortSignal) => Promise<{ ok: boolean; payload?: unknown }>>(),
  post: vi.fn<(path: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<{ ok: boolean }>>(),
}))
vi.mock('../src/client/api.ts', () => ({ ...api, newKey: () => 'fixture-logout' }))
const account = { signedIn: true, creditsPerYuan: 1000, account: { id: 'a', phone: 'fixture' } }
const unsigned = { ok: true, payload: { signedIn: false, creditsPerYuan: 1000 } }
beforeEach(() => {
  vi.resetModules(); api.get.mockReset(); api.post.mockReset().mockResolvedValue({ ok: true }); vi.useFakeTimers()
  api.get.mockImplementation(async path => ({ ok: true, payload: path.endsWith('/session') ? account : { balance_points: 1234 } }))
})
afterEach(() => { vi.useRealTimers() })
describe('confirmed local logout', () => {
  it('retains the account until local absence is confirmed and suppresses concurrent heartbeat reads', async () => {
    const store = await import('../src/client/session-store.ts')
    await store.refreshCredits()
    let startingLogout = false
    const source = store.createCreditsSessionSource(), stop = source.subscribe(() => {
      if (startingLogout) { void store.refreshCredits(); void store.refreshBalance() }
    })
    await vi.advanceTimersByTimeAsync(0)
    const pending = Promise.withResolvers<{ ok: boolean }>()
    api.post.mockReturnValueOnce(pending.promise)
    const initialReads = api.get.mock.calls.length
    startingLogout = true
    const operation = store.signOutCredits(20_000)
    startingLogout = false
    try {
      expect(api.get).toHaveBeenCalledTimes(initialReads)
      expect(source.getSnapshot().session).toEqual(account)
      const reads = api.get.mock.calls.length
      window.dispatchEvent(new Event('focus'))
      await store.refreshCredits(); await store.refreshBalance()
      expect(api.get).toHaveBeenCalledTimes(reads)
      api.get.mockResolvedValueOnce(unsigned)
      pending.resolve({ ok: true })
      expect(await operation).toBe('signed-out')
      expect(source.getSnapshot()).toMatchObject({ session: { signedIn: false }, balance: null, failure: null })
    } finally { pending.resolve({ ok: true }); stop() }
  })
  it.each(['transport', 'refused'] as const)('keeps recovery available when logout is %s and the Host still has the login', async mode => {
    const store = await import('../src/client/session-store.ts')
    await store.refreshCredits()
    const before = store.readCreditsSnapshot()
    if (mode === 'transport') api.post.mockRejectedValueOnce(new TypeError('fixture disconnect'))
    else api.post.mockResolvedValueOnce({ ok: false })
    await expect(store.signOutCredits(20_000)).rejects.toThrow('LOGOUT_UNCONFIRMED')
    expect(store.readCreditsSnapshot()).toMatchObject({ session: before.session, balance: before.balance, accountEpoch: before.accountEpoch })
    api.get.mockResolvedValueOnce(unsigned)
    expect(await store.signOutCredits(20_000)).toBe('signed-out')
  })
  it.each(['transport', 'refused'] as const)('accepts confirmed local logout after %s while reporting server revocation as unknown', async mode => {
    const store = await import('../src/client/session-store.ts')
    await store.refreshCredits()
    if (mode === 'transport') api.post.mockRejectedValueOnce(new TypeError('fixture reply lost'))
    else api.post.mockResolvedValueOnce({ ok: false })
    api.get.mockResolvedValueOnce(unsigned)
    expect(await store.signOutCredits(20_000)).toBe('local-only')
    expect(store.readCreditsSnapshot().session?.signedIn).toBe(false)
  })
  it('shares one logout request and refuses to clear a replacement login', async () => {
    const store = await import('../src/client/session-store.ts')
    await store.refreshCredits()
    const pending = Promise.withResolvers<{ ok: boolean }>()
    api.post.mockReturnValueOnce(pending.promise)
    const first = store.signOutCredits(20_000), second = store.signOutCredits(20_000)
    const results = Promise.allSettled([first, second])
    api.get.mockResolvedValueOnce({ ok: true, payload: { ...account, account: { id: 'replacement', phone: 'fixture' } } })
    pending.resolve({ ok: true })
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(store.readCreditsSnapshot().session?.signedIn).toBe(true)
  })
  it('rejects an unconfirmed read after the shared operation deadline', async () => {
    const store = await import('../src/client/session-store.ts')
    await store.refreshCredits()
    api.post.mockImplementationOnce(async (_path, _body, signal) => await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }))
    api.get.mockImplementationOnce(async (_path, signal) => { signal?.throwIfAborted(); return unsigned })
    const operation = store.signOutCredits(1000)
    const result = operation.then(() => 'confirmed', () => 'unconfirmed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe('unconfirmed')
    expect(store.readCreditsSnapshot().session?.signedIn).toBe(true)
  })
})
