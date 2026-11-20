// @vitest-environment jsdom
/** The real portaled reminder uses the root policy and existing account navigation. */
import { useSyncExternalStore } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SidebarLoginReminder } from '../src/client/SidebarLoginReminder.tsx'
import { createSidebarLogin } from '../src/client/sidebar-login-store.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import type { CreditsSnapshot } from '../src/client/session-store.ts'

afterEach(() => { cleanup() })
const signedOut: CreditsSnapshot = { loaded: true, accountEpoch: 0, failure: null, balance: null,
  session: { signedIn: false, creditsPerYuan: 1000 } }

function unusedStandard(): never { throw new Error('Unexpected global hook in sidebar login leaf fixture') }
const standard: GlobalStandardProps = { usePanelInfo: unusedStandard, useSessions: unusedStandard,
  useSessionStatus: unusedStandard, useSessionRetainInfo: unusedStandard, useWorkspaces: unusedStandard, useResource: unusedStandard }

function fixture(locale: 'zh' | 'en' = 'zh', initial = signedOut) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const dictionary = new LocaleRuntime(ctx)
  ctx.effect(() => dictionary.register(NS, { zh, en }))
  dictionary.setLocale(locale)
  const source = createSnapshotStore<CreditsSnapshot>(initial)
  const openLogin = vi.fn(), refresh = vi.fn<(signal: AbortSignal) => Promise<boolean>>(async () => false)
  const controller = createSidebarLogin(source, refresh, openLogin)
  onTestFinished(controller.start())
  const { hooks, request, start: _start, ...commands } = controller
  const view = hooks.sidebarLogin
  const useSidebarLogin: Parameters<typeof SidebarLoginReminder>[0]['useSidebarLogin'] = selector =>
    selector(useSyncExternalStore(listener => view.subscribe(listener), () => view.getSnapshot()))
  function Reminder() {
    return <SidebarLoginReminder {...standard} {...commands} t={dictionary.bind(NS)} useSidebarLogin={useSidebarLogin} />
  }
  const rendered = render(<Reminder />)
  return { source, openLogin, refresh, controller, request, rendered, Reminder }
}

describe('sidebar sign-in reminder', () => {
  it.each(['zh', 'en'] as const)('opens one localized dialog on demand and only navigates on Sign in (%s)', (locale) => {
    const f = fixture(locale), copy = locale === 'zh' ? zh : en
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { expect(f.request()).toBe(false); expect(f.request()).toBe(false) })
    const dialog = screen.getByRole('dialog', { name: copy['sidebarLogin.title'] })
    expect(dialog.textContent).toContain(copy['sidebarLogin.description'])
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(f.rendered.container.contains(dialog)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: copy['sidebarLogin.signIn'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.openLogin).toHaveBeenCalledOnce()
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'close', 'escape', 'mask'] as const)('keeps %s dismissal closed across renders and account reads', (method) => {
    const f = fixture()
    act(() => { f.request() })
    if (method === 'cancel') fireEvent.click(screen.getByRole('button', { name: zh['sidebarLogin.later'] }))
    else if (method === 'close') fireEvent.click(screen.getByRole('button', { name: zh['sidebarLogin.close'] }))
    else if (method === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
    else {
      const mask = screen.getByRole('dialog').previousElementSibling
      if (mask === null) throw new Error('Expected standard Modal mask')
      fireEvent.click(mask)
    }
    f.rendered.rerender(<f.Reminder />)
    act(() => { f.source.set({ ...signedOut }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.openLogin).not.toHaveBeenCalled()
    expect(f.refresh).not.toHaveBeenCalled()
    act(() => { f.request() })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('shows checking and uncertain reads separately, retries without sign-in, and closes on a confirmed login', async () => {
    const f = fixture('zh', { ...signedOut, session: null, loaded: false })
    act(() => { f.request() })
    expect(screen.getByRole('dialog', { name: zh['sidebarLogin.checking'] })).toBeDefined()
    act(() => { f.source.set({ ...signedOut, session: null, failure: 'ACCOUNT_UNAVAILABLE' }) })
    expect(screen.getByRole('dialog', { name: zh['sidebarLogin.unconfirmed'] })).toBeDefined()
    const pending = Promise.withResolvers<boolean>()
    f.refresh.mockReturnValue(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: zh['sidebarLogin.retry'] }))
    expect(f.refresh).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
    expect(screen.getByRole('button', { name: zh['sidebarLogin.checking'] }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      f.source.set({ ...signedOut, accountEpoch: 1, session: { signedIn: true, creditsPerYuan: 1000,
        account: { id: '7', phone: 'fixture' } } })
      pending.resolve(true)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.openLogin).not.toHaveBeenCalled()
  })

  it('keeps authoritative account-read failures neutral and offers existing account recovery', () => {
    const f = fixture('zh', { ...signedOut, failure: 'AUTH_TOKEN_EXPIRED', session: { signedIn: true, creditsPerYuan: 1000,
      account: { id: '7', phone: 'fixture' } } })
    act(() => { f.request() })
    const dialog = screen.getByRole('dialog', { name: zh['sidebarLogin.unconfirmed'] })
    expect(dialog.textContent).not.toContain('AUTH_TOKEN_EXPIRED')
    expect(dialog.textContent).not.toContain(zh['sidebarLogin.description'])
    fireEvent.click(screen.getByRole('button', { name: zh['sidebarLogin.account'] }))
    expect(f.openLogin).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cancels a pending read on overlay unmount and remains closed after remount and late completion', async () => {
    const f = fixture('zh', { ...signedOut, session: null, failure: 'ACCOUNT_UNAVAILABLE' })
    const pending = Promise.withResolvers<boolean>()
    f.refresh.mockReturnValue(pending.promise)
    act(() => { f.request() })
    fireEvent.click(screen.getByRole('button', { name: zh['sidebarLogin.retry'] }))
    const signal = f.refresh.mock.calls[0]?.[0]
    f.rendered.unmount()
    expect(signal?.aborted).toBe(true)
    render(<f.Reminder />)
    await act(async () => { pending.resolve(false); f.source.set({ ...signedOut }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.openLogin).not.toHaveBeenCalled()
    act(() => { f.request() })
    expect(screen.getByRole('dialog', { name: zh['sidebarLogin.title'] })).toBeDefined()
  })
})
