// @vitest-environment jsdom
/** Signed-out balance form behavior using real controls and intercepted HTTP. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { CreditsPage } from '../src/client/CreditsPage.tsx'
import { zh, type CreditsKey } from '../src/client/locales.ts'
import { refreshCredits } from '../src/client/session-store.ts'

vi.mock('../src/client/session-store.ts', () => ({
  useCreditsSnapshot: () => ({
    loaded: true, failure: null, balance: null,
    session: { signedIn: false, creditsPerYuan: 1000 },
  }),
  refreshCredits: vi.fn(),
  refreshBalance: vi.fn(),
  signOutCredits: vi.fn(),
}))
vi.mock('../src/client/UsageOverview.tsx', () => ({ UsageOverview: () => null }))

const t = (key: string, values?: Record<string, string>): string => {
  let text: string = zh[key as CreditsKey] ?? key
  for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, value)
  return text
}

const challenge = {
  ok: true,
  payload: { challenge_id: 'challenge-for-138', expires_at: '2026-10-15T12:05:00Z', resend_after_seconds: 60 },
}

function renderSignIn() {
  // The form does not read any of the renderer's global standard seats.
  const props = { t, openRecharge: vi.fn() } as Parameters<typeof CreditsPage>[0]
  return render(<CreditsPage {...props} />)
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
  const body: unknown = JSON.parse(init.body)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object')
  return body as Record<string, unknown>
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('balance phone sign-in', () => {
  it.each(['13800138000', '+86 138 0013 8000'])(
    'sends a normalized E.164 challenge for %s',
    async (phone) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(challenge))
      vi.stubGlobal('fetch', fetchMock)
      const view = renderSignIn()
      fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: phone } })
      fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
      expect(await view.findByRole('status')).toBeTruthy()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [path, init] = fetchMock.mock.calls[0] ?? []
      expect(path).toBe('/credits/api/session/challenge')
      expect(init?.method).toBe('POST')
      const body = requestBody(init)
      expect(body.phone).toBe('+8613800138000')
      expect(body.idempotencyKey).toMatch(/^sms-challenge-/)
      expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'phone'])
      expect(view.getByRole('textbox', { name: '手机号' }).getAttribute('value')).toBe('13800138000')
    },
  )

  it('rejects another country prefix without sending an SMS', () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '+1 380 013 8000' } })
    const send = view.getByRole('button', { name: '发送验证码' })
    expect(send.hasAttribute('disabled')).toBe(true)
    fireEvent.click(send)
    expect(view.getByRole('alert').textContent).toBe(t('errPhone'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('disables the pending request and starts the returned resend countdown after success', async () => {
    vi.useFakeTimers()
    let finish: ((response: Response) => void) | undefined
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    const pending = view.getByRole('button', { name: '正在发送…' })
    expect(pending.hasAttribute('disabled')).toBe(true)
    expect(view.getByRole('textbox', { name: '手机号' }).hasAttribute('disabled')).toBe(true)
    expect(view.getByRole('textbox', { name: '验证码' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(pending)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { finish?.(Response.json(challenge)) })
    expect(view.getByRole('status').textContent).toBe(t('codeSent'))
    expect(view.getByRole('button', { name: '60s 后可重发' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(view.getByRole('button', { name: '59s 后可重发' }).hasAttribute('disabled')).toBe(true)
    expect(view.getByRole('textbox', { name: '验证码' }).hasAttribute('disabled')).toBe(false)
  })

  it.each([
    { label: 'without a registration reward', bonus: undefined },
    { label: 'with no credited reward', bonus: { status: 'none', points: 0 } },
    { label: 'with a credited reward', bonus: { status: 'credited', points: 1000 } },
  ])('completes a successful sign-in $label', async ({ bonus }) => {
    let finish: ((response: Response) => void) | undefined
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(challenge))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '+86 138 0013 8000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await view.findByRole('status')
    const code = view.getByRole('textbox', { name: '验证码' })
    fireEvent.change(code, { target: { value: '123456' } })
    const form = code.closest('form')
    if (form === null) throw new Error('Expected the code control in a login form')
    fireEvent.submit(form)
    const pending = view.getByRole('button', { name: '正在登录…' })
    expect(pending.hasAttribute('disabled')).toBe(true)
    fireEvent.submit(form)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [path, init] = fetchMock.mock.calls[1] ?? []
    expect(path).toBe('/credits/api/session/verify')
    const body = requestBody(init)
    expect(body.challengeId).toBe('challenge-for-138')
    expect(body.code).toBe('123456')
    expect(body.idempotencyKey).toMatch(/^sms-session-/)
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'code', 'idempotencyKey'])
    await act(async () => {
      finish?.(Response.json({ ok: true, payload: {
        status: 'authorized', expiresAt: '2026-10-15T13:00:00Z',
        account: { id: 'fixture-account', phone: '+8613800138000' },
        ...bonus === undefined ? {} : { registration_bonus: bonus },
      } }))
    })
    expect(refreshCredits).toHaveBeenCalledTimes(1)
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByRole('status').textContent).toBe(bonus?.status === 'credited'
      ? t('signedInBonus', { points: '1,000' }) : t('signedIn'))
    expect(view.getByRole('textbox', { name: '验证码' }).getAttribute('value')).toBe('')
    expect(view.getByRole('button', { name: '登录' }).hasAttribute('disabled')).toBe(true)
  })

  it('clears the previous challenge and code when the phone changes before form submission', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(challenge))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    const phone = view.getByRole('textbox', { name: '手机号' })
    const code = view.getByRole('textbox', { name: '验证码' })
    fireEvent.change(phone, { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await view.findByRole('status')
    fireEvent.change(code, { target: { value: '123456' } })
    fireEvent.change(phone, { target: { value: '13900139000' } })
    expect(code.getAttribute('value')).toBe('')
    expect(view.queryByRole('status')).toBeNull()
    expect(view.getByRole('button', { name: '登录' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(code, { target: { value: '123456' } })
    const form = code.closest('form')
    if (form === null) throw new Error('Expected the code control in a login form')
    fireEvent.submit(form)
    expect(within(form).getByRole('alert').textContent).toBe(t('errNeedCode'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps entered values and shows a verification failure inside the form', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(challenge))
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'SMS_CODE_MISMATCH', message: '验证码不匹配，请重试' }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await view.findByRole('status')
    const code = view.getByRole('textbox', { name: '验证码' })
    fireEvent.change(code, { target: { value: '123456' } })
    const form = code.closest('form')
    if (form === null) throw new Error('Expected the code control in a login form')
    fireEvent.submit(form)
    expect((await within(form).findByRole('alert')).textContent).toBe('验证码不匹配，请重试')
    expect(code.getAttribute('value')).toBe('123456')
    expect(view.getByRole('textbox', { name: '手机号' }).getAttribute('value')).toBe('13800138000')
    expect(view.getByRole('button', { name: '登录' }).hasAttribute('disabled')).toBe(false)
    expect(refreshCredits).not.toHaveBeenCalled()
  })
})
