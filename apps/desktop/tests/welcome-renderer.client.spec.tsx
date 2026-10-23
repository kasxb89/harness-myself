// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { WelcomeSaveResult, WelcomeNotice } from '../src/welcome-api.ts'
import type { WelcomeRecoveryState } from '../src/welcome-session.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(() => { cleanup(); vi.useRealTimers() })

function mount(language = 'zh-CN', takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined)) {
  const api = {
    takeNotice,
    recoveryState: vi.fn<() => Promise<WelcomeRecoveryState>>().mockResolvedValue({ kind: 'ready' }),
    retrySession: vi.fn<() => Promise<WelcomeRecoveryState>>().mockResolvedValue({ kind: 'ready' }),
    analytics: vi.fn(async (_event: string, _attributes: object) => {}),
    analyticsEnabled: async () => true,
    onAccountState: vi.fn((_listener: (state: AccountView) => void) => () => {}),
    startSignIn: vi.fn(async (): Promise<AccountView> => ({ links: { usageUrl: '', topUpUrl: '' }, status: 'signed-out', attempt: null })),
    cancelSignIn: vi.fn(async (): Promise<AccountView> => ({ links: { usageUrl: '', topUpUrl: '' }, status: 'signed-out', attempt: null })),
    copySignInLink: vi.fn(async () => undefined),
    ...resolveDesktopLocale(language),
    saveApiKey: vi.fn<(value: string) => Promise<WelcomeSaveResult>>().mockResolvedValue({ ok: true }),
    skip: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
  const mounted = render(<Welcome api={api} />)
  const button = () => screen.getByRole<HTMLButtonElement>('button', { name: api.messages.welcomeSignIn })
  const copy = () => [document.title, document.querySelector('.brand')!.textContent,
    document.querySelector('h1')!.textContent, document.querySelector('#welcome-description')!.textContent,
    button().textContent, document.querySelector('#login-feedback')!.textContent, ''].join('\n')
  return { api, button, copy, unmount: mounted.unmount }
}

describe('desktop product welcome', () => {
  it.each(['zh-CN', 'en'])('offers only product phone sign-in: %s', async (language) => {
    const view = mount(language)
    expect(document.documentElement.lang).toBe(language)
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('input')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/DeepSeek|HARNESS|API Key/i)
    expect(html).toContain("default-src 'none'")
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
    fireEvent.click(view.button())
    await act(async () => {})
    expect(view.api.skip).toHaveBeenCalledOnce()
    expect(view.api.startSignIn).not.toHaveBeenCalled()
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
    expect(view.api.analytics).toHaveBeenCalledExactlyOnceWith('auth_page_click', { button_name: 'sign_in' })
  })

  it('navigates when analytics rejects without an unhandled rejection', async () => {
    const view = mount()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    window.addEventListener('unhandledrejection', unhandled)
    try {
      view.api.analytics.mockRejectedValueOnce(new Error('analytics IPC closed'))
      fireEvent.click(view.button())
      await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })
      expect(view.api.skip).toHaveBeenCalledOnce()
      expect(view.button().disabled).toBe(false)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
      window.removeEventListener('unhandledrejection', unhandled)
    }
  })

  it('blocks repeated navigation and retains the button and localized retry feedback after failure', async () => {
    const view = mount()
    const pending = Promise.withResolvers<undefined>()
    view.api.skip.mockReturnValueOnce(pending.promise)
    fireEvent.click(view.button())
    fireEvent.click(view.button())
    expect(view.button().disabled).toBe(true)
    expect(view.api.skip).toHaveBeenCalledOnce()
    expect(view.button().textContent).toBe(view.api.messages.welcomeSignIn)
    await act(async () => { pending.reject(new Error('private navigation diagnostic')) })
    expect(view.button().disabled).toBe(false)
    expect(screen.getByRole('alert').textContent).toBe(view.api.messages.welcomeContinueFailed)
    fireEvent.click(view.button())
    await act(async () => {})
    expect(view.api.skip).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['zh-CN', 'en'])('consumes a one-time session expiry notice: %s', async (language) => {
    vi.useFakeTimers()
    const takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined).mockResolvedValueOnce('session-expired')
    const view = mount(language, takeNotice)
    await act(async () => {})
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toBe(view.api.messages.welcomeSessionExpired)
    await expect(`${notice.textContent}\n`).toMatchFileSnapshot(`./expected/welcome/${language}-expired.expected.txt`)
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
    mount(language, takeNotice)
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('consumes a later notice without exposing official account actions', async () => {
    const takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined)
    const view = mount('zh-CN', takeNotice)
    await act(async () => {})
    takeNotice.mockResolvedValueOnce('session-expired')
    await act(async () => { view.api.onAccountState.mock.calls[0]![0]({ status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' } }) })
    expect(screen.getByRole('alert').textContent).toBe(view.api.messages.welcomeSessionExpired)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(view.api.startSignIn).not.toHaveBeenCalled()
  })

  it('keeps phone navigation usable when notice IPC is unavailable', async () => {
    const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockRejectedValue(new Error('closed')))
    await act(async () => {})
    fireEvent.click(view.button())
    await act(async () => {})
    expect(view.api.skip).toHaveBeenCalledOnce()
  })

  it('ignores a notice or failed navigation received after unmount', async () => {
    const notice = Promise.withResolvers<WelcomeNotice | undefined>()
    const navigation = Promise.withResolvers<undefined>()
    const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockReturnValue(notice.promise))
    view.api.skip.mockReturnValueOnce(navigation.promise)
    fireEvent.click(view.button())
    view.unmount()
    mount('en')
    await act(async () => { notice.resolve('session-expired'); navigation.reject(new Error('closed')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['zh-CN', 'en'])('keeps an unavailable login visible with one retry and a separate sign-in action: %s', async (language) => {
    const view = mount(language)
    view.api.recoveryState.mockResolvedValue({ kind: 'unavailable', reason: 'network' })
    await act(async () => { view.api.onAccountState.mock.calls[0]![0]({ status: 'credential-stored', attempt: null, links: { usageUrl: '', topUpUrl: '' } }) })
    expect(screen.getByRole('status').textContent).toContain(view.api.messages.welcomeSessionNetwork)
    await expect(`${screen.getByRole('status').textContent}\n${screen.getAllByRole('button').map(button => button.textContent).join('\n')}\n`)
      .toMatchFileSnapshot(`./expected/welcome/${language}-unavailable.expected.txt`)
    const pending = Promise.withResolvers<WelcomeRecoveryState>()
    view.api.retrySession.mockReturnValueOnce(pending.promise)
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: view.api.messages.welcomeSessionRetry })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(view.api.retrySession).toHaveBeenCalledOnce()
    expect(view.api.skip).not.toHaveBeenCalled()
    expect(screen.getAllByRole<HTMLButtonElement>('button').every(button => button.disabled)).toBe(true)
    await act(async () => { pending.resolve({ kind: 'unavailable', reason: 'timeout' }) })
    expect(screen.getByRole('status').textContent).toContain(view.api.messages.welcomeSessionTimeout)
    fireEvent.click(screen.getByRole('button', { name: view.api.messages.welcomeSessionSignIn }))
    await act(async () => {})
    expect(view.api.skip).toHaveBeenCalledOnce()
    expect(view.api.startSignIn).not.toHaveBeenCalled()
  })
})
