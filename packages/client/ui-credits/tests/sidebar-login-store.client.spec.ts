/** Sidebar admission preserves account-read semantics without replaying a blocked feature. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSidebarLogin } from '../src/client/sidebar-login-store.ts'
import type { CreditsSnapshot } from '../src/client/session-store.ts'

const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })
const signedOut: CreditsSnapshot = { accountEpoch: 0, loaded: true, failure: null, readFailure: null, balance: null,
  session: { signedIn: false, creditsPerYuan: 1000 } }
const signedIn: CreditsSnapshot = { ...signedOut, accountEpoch: 1,
  session: { signedIn: true, creditsPerYuan: 1000, account: { id: '7', phone: 'fixture' }, accountOwner: 'a'.repeat(64) } }

function fixture(snapshot: CreditsSnapshot = signedOut, refresh = vi.fn<(signal: AbortSignal) => Promise<boolean>>(async () => false)) {
  const source = createSnapshotStore(snapshot)
  const openLogin = vi.fn()
  const controller = createSidebarLogin(source, refresh, openLogin)
  const stop = controller.start()
  stops.push(stop)
  return { source, refresh, openLogin, controller, stop, view: controller.hooks.sidebarLogin }
}

describe('sidebar sign-in policy', () => {
  it('opens one reminder only after a blocked request and never navigates or refreshes on its own', () => {
    const f = fixture()
    expect(f.view.getSnapshot().open).toBe(false)
    expect(f.controller.request()).toBe(false)
    expect(f.controller.request()).toBe(false)
    expect(f.view.getSnapshot()).toMatchObject({ open: true, mode: 'signed-out' })
    expect(f.openLogin).not.toHaveBeenCalled()
    expect(f.refresh).not.toHaveBeenCalled()
    expect(f.source.getSnapshot()).toBe(signedOut)
  })

  it.each([null, { kind: 'network' as const, code: 'ACCOUNT_NETWORK_ERROR' }, { kind: 'timeout' as const, code: 'ACCOUNT_TIMEOUT' }])(
    'allows an already observed login without clearing it on a temporary read failure: %j', (readFailure) => {
      const snapshot = { ...signedIn, readFailure }
      const f = fixture(snapshot)
      expect(f.controller.request()).toBe(true)
      expect(f.view.getSnapshot().open).toBe(false)
      expect(f.source.getSnapshot()).toBe(snapshot)
    },
  )

  it.each(['auth', 'accountChanged', 'sessionRefresh'] as const)('requires confirmation for %s while retaining account data', (kind) => {
    const snapshot = { ...signedIn, readFailure: { kind, code: 'SAFE_READ_FAILURE' } }
    const f = fixture(snapshot)
    expect(f.controller.request()).toBe(false)
    expect(f.view.getSnapshot()).toMatchObject({ open: true, mode: 'unconfirmed' })
    expect(f.source.getSnapshot()).toBe(snapshot)
    expect(f.openLogin).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...signedOut, session: null, loaded: false }, 'checking'],
    [{ ...signedOut, session: null, failure: 'ACCOUNT_UNAVAILABLE' }, 'unconfirmed'],
    [{ ...signedOut, failure: 'ACCOUNT_AUTH_REQUIRED' }, 'unconfirmed'],
  ] as const)('keeps unfinished and failed reads separate from confirmed logout: %j', (snapshot, mode) => {
    const f = fixture(snapshot)
    expect(f.controller.request()).toBe(false)
    expect(f.view.getSnapshot().mode).toBe(mode)
  })

  it('closes when sign-in is observed without executing the blocked feature and requires a fresh user action', () => {
    const f = fixture(), feature = vi.fn()
    if (f.controller.request()) feature()
    f.source.set(signedIn)
    expect(f.view.getSnapshot().open).toBe(false)
    expect(feature).not.toHaveBeenCalled()
    if (f.controller.request()) feature()
    expect(feature).toHaveBeenCalledOnce()
    f.source.set(signedOut)
    expect(f.view.getSnapshot().open).toBe(false)
  })

  it('deduplicates manual confirmation and uses only the injected read refresh', async () => {
    const pending = Promise.withResolvers<boolean>()
    const refresh = vi.fn<(signal: AbortSignal) => Promise<boolean>>(() => pending.promise)
    const f = fixture({ ...signedOut, session: null, failure: 'ACCOUNT_UNAVAILABLE' }, refresh)
    f.controller.request()
    f.controller.retrySidebarLogin()
    f.controller.retrySidebarLogin()
    expect(refresh).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
    expect(f.view.getSnapshot()).toMatchObject({ mode: 'checking', refreshing: true })
    pending.resolve(false)
    await vi.waitFor(() => { expect(f.view.getSnapshot()).toMatchObject({ mode: 'unconfirmed', refreshing: false }) })
    expect(f.openLogin).not.toHaveBeenCalled()
  })

  it.each(['dismiss', 'dispose'] as const)('aborts confirmation on %s and ignores late completion without reopening', async (close) => {
    const pending = Promise.withResolvers<boolean>()
    let signal: AbortSignal | undefined
    const f = fixture({ ...signedOut, session: null, failure: 'ACCOUNT_UNAVAILABLE' }, vi.fn((current: AbortSignal) => {
      signal = current
      return pending.promise
    }))
    f.controller.request()
    f.controller.retrySidebarLogin()
    if (close === 'dismiss') f.controller.dismissSidebarLogin()
    else f.stop()
    expect(signal?.aborted).toBe(true)
    pending.resolve(false)
    await Promise.resolve()
    f.source.set(signedOut)
    expect(f.view.getSnapshot()).toMatchObject({ open: false, refreshing: false })
    expect(f.openLogin).not.toHaveBeenCalled()
    if (close === 'dispose') expect(f.controller.request()).toBe(false)
  })

  it('respects shared cooldowns and contains refresh failures without exposing their text', async () => {
    const f = fixture({ ...signedOut, session: null,
      readFailure: { kind: 'rateLimited', code: 'ACCOUNT_RATE_LIMITED', retryAt: performance.now() + 60_000 } },
    vi.fn<(signal: AbortSignal) => Promise<boolean>>(async () => { throw new Error('private diagnostic') }))
    f.controller.request()
    f.controller.retrySidebarLogin()
    expect(f.refresh).not.toHaveBeenCalled()
    f.source.set({ ...signedOut, session: null, failure: 'ACCOUNT_UNAVAILABLE' })
    f.controller.retrySidebarLogin()
    await vi.waitFor(() => { expect(f.view.getSnapshot()).toMatchObject({ mode: 'unconfirmed', refreshing: false }) })
    expect(JSON.stringify(f.view.getSnapshot())).not.toContain('private diagnostic')
  })

  it('navigates to the existing login page only after its explicit button and starts a new root closed', () => {
    const f = fixture()
    f.controller.request()
    f.controller.goToSidebarLogin()
    f.controller.goToSidebarLogin()
    expect(f.view.getSnapshot().open).toBe(false)
    expect(f.openLogin).toHaveBeenCalledOnce()
    f.stop()
    const next = createSidebarLogin(f.source, f.refresh, f.openLogin)
    stops.push(next.start())
    expect(next.hooks.sidebarLogin.getSnapshot().open).toBe(false)
    f.source.set(signedIn)
    expect(f.view.getSnapshot().open).toBe(false)
    expect(next.request()).toBe(true)
  })
})
