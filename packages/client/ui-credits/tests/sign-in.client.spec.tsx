// @vitest-environment jsdom
/** Signed-out balance form behavior using real controls and intercepted HTTP. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { CreditsPage } from '../src/client/CreditsPage.tsx'
import { zh, type CreditsKey } from '../src/client/locales.ts'
import { refreshCredits, useCreditsSnapshot } from '../src/client/session-store.ts'

vi.mock('../src/client/session-store.ts', () => ({
  useCreditsSnapshot: vi.fn(() => ({
    accountEpoch: 0, loaded: true, failure: null, balance: null,
    session: { signedIn: false, creditsPerYuan: 1000 },
  })),
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

function renderSignIn(completeSignIn = vi.fn()) {
  // The form does not read any of the renderer's global standard seats.
  const props = { t, openRecharge: vi.fn(), signOutTimeoutMs: 20_000, completeSignIn } as Parameters<typeof CreditsPage>[0]
  const view = render(<CreditsPage {...props} />)
  return { ...view, rerenderPage: () => { view.rerender(<CreditsPage {...props} />) } }
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
  const body: unknown = JSON.parse(init.body)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object')
  return body as Record<string, unknown>
}

beforeEach(() => {
  vi.mocked(useCreditsSnapshot).mockReturnValue({
    accountEpoch: 0, loaded: true, failure: null, balance: null,
    session: { signedIn: false, creditsPerYuan: 1000 },
  })
  vi.mocked(refreshCredits).mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('balance phone sign-in', () => {
  it('discloses the limited Desktop activity statistics before sign-in', () => {
    const view = renderSignIn()
    const notice = view.getByText(zh.activityNotice).textContent
    expect(notice).toContain('软件上线')
    expect(notice).toContain('聊天正文')
  })

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
    let finishRefresh: (() => void) | undefined
    vi.mocked(refreshCredits).mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishRefresh = () => { resolve(true) } }))
    const completeSignIn = vi.fn()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(challenge))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn(completeSignIn)
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
    expect(completeSignIn).not.toHaveBeenCalled()
    await act(async () => { finishRefresh?.() })
    expect(completeSignIn).toHaveBeenCalledTimes(1)
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByRole('status').textContent).toBe(bonus?.status === 'credited'
      ? t('signedInBonus', { points: '1,000' }) : t('signedIn'))
    expect(view.getByRole('textbox', { name: '验证码' }).getAttribute('value')).toBe('')
    expect(view.getByRole('button', { name: '登录' }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps the balance page open when an existing session or its balance refreshes', () => {
    const completeSignIn = vi.fn()
    const signedInSnapshot = {
      accountEpoch: 0, loaded: true, failure: null, balance: null,
      session: { signedIn: true, creditsPerYuan: 1000, account: { id: 'fixture-account', phone: '+8613800138000' } },
    }
    vi.mocked(useCreditsSnapshot).mockReturnValue(signedInSnapshot)
    const view = renderSignIn(completeSignIn)
    expect(view.queryByRole('textbox', { name: '验证码' })).toBeNull()
    vi.mocked(useCreditsSnapshot).mockReturnValue({
      ...signedInSnapshot,
      balance: { balance_points: 1000, as_of: '2026-10-16T12:00:00Z' },
    })

    view.rerenderPage()

    expect(completeSignIn).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: t('signOut') })).toBeTruthy()
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
    const completeSignIn = vi.fn()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(challenge))
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'SMS_CODE_MISMATCH', message: '验证码不匹配，请重试' }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn(completeSignIn)
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await view.findByRole('status')
    const code = view.getByRole('textbox', { name: '验证码' })
    fireEvent.change(code, { target: { value: '123456' } })
    const form = code.closest('form')
    if (form === null) throw new Error('Expected the code control in a login form')
    fireEvent.submit(form)
    expect((await within(form).findByRole('alert')).textContent).toBe(t('loginCodeInvalid'))
    expect(code.getAttribute('value')).toBe('123456')
    expect(view.getByRole('textbox', { name: '手机号' }).getAttribute('value')).toBe('13800138000')
    expect(view.getByRole('button', { name: '登录' }).hasAttribute('disabled')).toBe(false)
    expect(refreshCredits).not.toHaveBeenCalled()
    expect(completeSignIn).not.toHaveBeenCalled()
  })

  it.each([
    ['SMS_CODE_MISMATCH', 'loginCodeInvalid'],
    ['SMS_CHALLENGE_EXPIRED', 'loginCodeExpired'],
    ['SMS_CHALLENGE_CONSUMED', 'loginCodeConsumed'],
    ['PHONE_LOGIN_UNAVAILABLE', 'loginVerifyFailed'],
    ['PHONE_CODE_INVALID_OR_EXPIRED', 'loginCodeInvalidOrExpired'],
    ['PHONE_CHALLENGE_CONSUMED', 'loginCodeConsumed'],
    ['PHONE_LOGIN_VERIFICATION_REQUIRED', 'loginVerificationRequired'],
    ['PHONE_LOGIN_FAILED', 'loginVerifyFailed'],
  ])('localizes %s without displaying provider diagnostics', async (failureCode, messageKey) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(challenge))
      .mockResolvedValueOnce(Response.json({ ok: false, code: failureCode, message: 'private upstream token diagnostic' }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await view.findByRole('status')
    fireEvent.change(view.getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
    fireEvent.click(view.getByRole('button', { name: '登录' }))
    expect((await view.findByRole('alert')).textContent).toBe(t(messageKey))
    expect(view.container.textContent).not.toContain('private upstream')
  })

  it('retries an unconfirmed challenge with the same key and uses a fresh key for the next SMS', async () => {
    const immediateChallenge = { ...challenge, payload: { ...challenge.payload, resend_after_seconds: 0 } }
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('private transport diagnostic'))
      .mockResolvedValue(Response.json(immediateChallenge))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    expect((await view.findByRole('alert')).textContent).toBe(t('loginSendFailed'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: '查询发码结果' }))
    await view.findByRole('status')
    expect(requestBody(fetchMock.mock.calls[0]?.[1]).idempotencyKey)
      .toBe(requestBody(fetchMock.mock.calls[1]?.[1]).idempotencyKey)
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await act(async () => {})
    expect(requestBody(fetchMock.mock.calls[2]?.[1]).idempotencyKey)
      .not.toBe(requestBody(fetchMock.mock.calls[1]?.[1]).idempotencyKey)
  })

  it('keeps a failed login key for recovery and changes it when the entered code changes', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(challenge))
      .mockResolvedValue(Response.json({ ok: false, code: 'PHONE_LOGIN_UNAVAILABLE', message: 'private diagnostic' }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await view.findByRole('status')
    const input = view.getByRole('textbox', { name: '验证码' })
    fireEvent.change(input, { target: { value: '123456' } })
    fireEvent.click(view.getByRole('button', { name: '登录' }))
    await view.findByRole('alert')
    fireEvent.click(view.getByRole('button', { name: '登录' }))
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(requestBody(fetchMock.mock.calls[1]?.[1]).idempotencyKey)
      .toBe(requestBody(fetchMock.mock.calls[2]?.[1]).idempotencyKey)
    fireEvent.change(input, { target: { value: '654321' } })
    fireEvent.click(view.getByRole('button', { name: '登录' }))
    await act(async () => {})
    expect(requestBody(fetchMock.mock.calls[3]?.[1]).idempotencyKey)
      .not.toBe(requestBody(fetchMock.mock.calls[2]?.[1]).idempotencyKey)
    expect(refreshCredits).not.toHaveBeenCalled()
  })

  it('uses absolute deadlines for send and verify rate limits without automatic resubmission', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'PHONE_RATE_LIMITED', retryAfterSeconds: 3 }))
      .mockResolvedValueOnce(Response.json(challenge))
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'PHONE_RATE_LIMITED', retryAfterSeconds: 5 }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '发送验证码' })) })
    expect(view.getByRole('button', { name: '3s 后可重发' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { vi.setSystemTime(Date.now() + 60_000); vi.advanceTimersByTime(250) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '发送验证码' })) })
    fireEvent.change(view.getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '登录' })) })
    expect(view.getByRole('button', { name: '5s 后可重试' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { vi.setSystemTime(Date.now() + 60_000); vi.advanceTimersByTime(250) })
    expect(view.getByRole('button', { name: '登录' }).hasAttribute('disabled')).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })


  it('permits entering a received code after unknown delivery and only queries the original SMS request', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'PHONE_DELIVERY_UNKNOWN', payload: {
        ...challenge.payload, delivery_status: 'unknown', resend_after_seconds: 0,
      } }))
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'PHONE_LOGIN_UNAVAILABLE' }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    expect((await view.findByRole('alert')).textContent).toBe(t('loginDeliveryUnknown'))
    expect(view.getByRole('button', { name: '查询发码结果' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.change(view.getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
    fireEvent.click(view.getByRole('button', { name: '登录' }))
    await act(async () => {})
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/credits/api/session/verify')
    expect(requestBody(fetchMock.mock.calls[1]?.[1]).challengeId).toBe('challenge-for-138')
  })

  it('requires an explicit new request with a new key after definite non-delivery', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'PHONE_CHALLENGE_UNAVAILABLE', payload: {
        ...challenge.payload, delivery_status: 'not_sent', resend_after_seconds: 0,
      } }))
      .mockResolvedValueOnce(Response.json(challenge))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    expect((await view.findByRole('alert')).textContent).toBe(t('loginNotSent'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await view.findByRole('status')
    expect(requestBody(fetchMock.mock.calls[0]?.[1]).idempotencyKey)
      .not.toBe(requestBody(fetchMock.mock.calls[1]?.[1]).idempotencyKey)
  })

  it('keeps the original SMS key and received code when an unavailable query has no delivery receipt', async () => {
    const unknown = { ok: false, code: 'PHONE_DELIVERY_UNKNOWN', payload: {
      ...challenge.payload, delivery_status: 'unknown', resend_after_seconds: 0,
    } }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(unknown))
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'PHONE_CHALLENGE_UNAVAILABLE' }))
      .mockResolvedValueOnce(Response.json(unknown))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await view.findByRole('alert')
    const code = view.getByRole('textbox', { name: '验证码' })
    fireEvent.change(code, { target: { value: '123456' } })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '查询发码结果' })) })
    expect((await view.findByRole('alert')).textContent).toBe(t('loginDeliveryUnknown'))
    expect(view.container.textContent).not.toContain('未发送')
    expect(code.getAttribute('value')).toBe('123456')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '查询发码结果' })) })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(new Set(fetchMock.mock.calls.map(call => requestBody(call[1]).idempotencyKey)).size).toBe(1)
  })

  it('restores durable request identities on remount without automatic sends or code persistence', async () => {
    vi.mocked(useCreditsSnapshot).mockReturnValue({
      accountEpoch: 0, loaded: true, failure: null, balance: null,
      session: { signedIn: false, creditsPerYuan: 1000, phoneRecoveryAvailable: true, phoneRecovery: {
        phone: '+8613800138000', challengeKey: 'restored-challenge-key', challengeId: 'restored-challenge',
        deliveryStatus: 'unknown', expiresAt: '9999-01-01T00:00:00Z', resendAt: 0,
        exchangeKey: 'restored-exchange-key', verifyRetryAt: 0, securityUnconfirmed: false,
      } },
    })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, code: 'PHONE_LOGIN_UNAVAILABLE' }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    expect(view.getByRole('textbox', { name: '手机号' }).getAttribute('value')).toBe('13800138000')
    expect(view.getByRole('textbox', { name: '验证码' }).getAttribute('value')).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(view.getByRole('textbox', { name: '验证码' }), { target: { value: '123' } })
    fireEvent.change(view.getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
    fireEvent.click(view.getByRole('button', { name: '登录' }))
    await act(async () => {})
    expect(requestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      challengeId: 'restored-challenge', idempotencyKey: 'restored-exchange-key', code: '123456',
    })
  })


  it('submits only the declared 2fa code to the Host before completing sign-in', async () => {
    const completeSignIn = vi.fn()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(challenge))
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'PHONE_LOGIN_VERIFICATION_REQUIRED', payload: {
        verification: { methods: ['2fa'] },
      } }))
      .mockResolvedValueOnce(Response.json({ ok: true, payload: { status: 'authorized' } }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn(completeSignIn)
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await view.findByRole('status')
    fireEvent.change(view.getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
    fireEvent.click(view.getByRole('button', { name: '登录' }))
    const security = await view.findByRole('textbox', { name: '安全验证码或备用码' })
    expect(completeSignIn).not.toHaveBeenCalled()
    expect(refreshCredits).not.toHaveBeenCalled()
    fireEvent.change(security, { target: { value: 'backup-code' } })
    fireEvent.click(view.getByRole('button', { name: '完成安全验证' }))
    await act(async () => {})
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/credits/api/session/verify-security')
    expect(requestBody(fetchMock.mock.calls[2]?.[1])).toEqual({
      exchangeKey: requestBody(fetchMock.mock.calls[1]?.[1]).idempotencyKey, code: 'backup-code',
    })
    expect(completeSignIn).toHaveBeenCalledTimes(1)
  })

  it('stops after an unknown security result and restarts only after an explicit action', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(challenge))
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'PHONE_LOGIN_VERIFICATION_REQUIRED', payload: {
        verification: { methods: ['2fa'] },
      } }))
      .mockRejectedValueOnce(new Error('private network diagnostic'))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    fireEvent.change(view.getByRole('textbox', { name: '手机号' }), { target: { value: '13800138000' } })
    fireEvent.click(view.getByRole('button', { name: '发送验证码' }))
    await view.findByRole('status')
    fireEvent.change(view.getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
    fireEvent.click(view.getByRole('button', { name: '登录' }))
    const security = await view.findByRole('textbox', { name: '安全验证码或备用码' })
    fireEvent.change(security, { target: { value: '123456' } })
    fireEvent.click(view.getByRole('button', { name: '完成安全验证' }))
    await act(async () => {})
    expect(view.getByRole('alert').textContent).toBe(t('loginSecurityUnconfirmed'))
    expect(view.getByRole('button', { name: '完成安全验证' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(view.getByRole('button', { name: '重新短信登录' }))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(view.getByRole('button', { name: '登录' }).hasAttribute('disabled')).toBe(true)
  })


  it('reports OTP expiry while preserving manual recovery of the original exchange without another SMS', async () => {
    vi.mocked(useCreditsSnapshot).mockReturnValue({
      accountEpoch: 0, loaded: true, failure: null, balance: null,
      session: { signedIn: false, creditsPerYuan: 1000, phoneRecoveryAvailable: true, phoneRecovery: {
        phone: '+8613800138000', challengeKey: null, challengeId: 'expired-otp-original-exchange',
        deliveryStatus: 'unknown', expiresAt: '2000-01-01T00:00:00Z', resendAt: 0,
        exchangeKey: 'original-exchange-key', verifyRetryAt: 0, securityUnconfirmed: false,
      } },
    })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, code: 'PHONE_LOGIN_UNAVAILABLE' }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderSignIn()
    expect(view.getByRole('alert').textContent).toBe(t('loginExpiredExchangeRecovery'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(view.getByRole('textbox', { name: '验证码' }).getAttribute('value')).toBe('')
    fireEvent.change(view.getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
    fireEvent.click(view.getByRole('button', { name: '登录' }))
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/credits/api/session/verify')
    expect(requestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      challengeId: 'expired-otp-original-exchange', idempotencyKey: 'original-exchange-key', code: '123456',
    })
  })

})
