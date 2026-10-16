// @vitest-environment jsdom
/** Payment amounts and order lifetimes through real controls, stores, and fixture HTTP. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { RechargePage } from '../src/client/RechargePage.tsx'
import { en, zh, type CreditsKey } from '../src/client/locales.ts'
import { refreshCredits } from '../src/client/session-store.ts'

const SELF = '@deepseek-ai/dsh-client-ui-credits'
const productIt = createClientTest({ roster: webApp.closure([SELF]) }, { mount: true })
const qr = 'data:image/png;base64,aGVsbG8='
let accountId = 'account-a'
let summaryReads = 0
let orderNumber = 0
let balanceUnavailable = false
let create: (init: RequestInit | undefined) => Promise<Response>
let status: (path: string, init: RequestInit | undefined) => Promise<Response>
let fetcher = vi.fn<typeof fetch>()

const t = (key: string, values?: Record<string, string>): string => {
  let text: string = zh[key as CreditsKey] ?? key
  for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, value)
  return text
}
const created = (id = 'order-1', amount = 1, points = 1000): Response => Response.json({ ok: true, payload: {
  outTradeNo: id, amount, points, quota: 68493, expiresAt: null, qrCodeDataUrl: qr,
} })
const orderStatus = (state = 'pending', points = 1000): Response => Response.json({ ok: true, payload: {
  status: state, points, quota: 68493,
} })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function mountPage() {
  await refreshCredits()
  // The page does not consume renderer-owned standard seats.
  const props = { t, openBalance: vi.fn() } as Parameters<typeof RechargePage>[0]
  const view = render(<RechargePage {...props} />)
  await act(async () => {})
  return view
}
async function pay(amount = '1'): Promise<void> {
  const input = screen.getByRole('textbox', { name: zh.customAmount })
  if (amount === '') fireEvent.change(input, { target: { value: '2' } })
  fireEvent.change(input, { target: { value: amount } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.confirmPay })) })
}
const requestPath = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
const paymentRequests = () => fetcher.mock.calls.filter(([input]) => requestPath(input).startsWith('/credits/api/recharge/'))

beforeEach(() => {
  accountId = 'account-a'
  summaryReads = 0
  orderNumber = 0
  balanceUnavailable = false
  create = async () => created(`order-${++orderNumber}`)
  status = async () => orderStatus()
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (path === '/credits/api/session') return Response.json({ ok: true, payload: {
      signedIn: true, creditsPerYuan: 1000, account: { id: accountId, phone: '+8613800138000' },
    } })
    if (path === '/credits/api/summary') {
      summaryReads += 1
      if (balanceUnavailable) return Response.json({ ok: false, code: 'BALANCE_UNAVAILABLE' })
      return Response.json({ ok: true, payload: { balance_points: 2345, as_of: '2026-10-16T04:00:00Z' } })
    }
    if (path === '/credits/api/recharge/wechat') return await create(init)
    if (path.startsWith('/credits/api/recharge/wechat/order?')) return await status(path, init)
    throw new Error(`Unexpected HTTP request: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WeChat top-up page', () => {
  it('sends whole yuan unchanged and displays converted points instead of raw quota', async () => {
    const view = await mountPage()
    create = async (init) => {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe('{"amount":1}')
      return created()
    }
    await pay()
    expect(screen.getByRole('img', { name: zh.qrAlt }).getAttribute('src')).toBe(qr)
    expect(screen.getByText('¥1 · 1,000 积分')).toBeTruthy()
    expect(screen.queryByText(/68,493/)).toBeNull()
    expect(paymentRequests()).toHaveLength(2)
    expect(screen.getByText(zh.polling)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: zh.customAmount }).getAttribute('inputmode')).toBe('numeric')
    expect(view.container.textContent).toMatchSnapshot()
  })

  it.each(['1.5', '0.9', '0', '-1', 'NaN', '', '100001'])(
    'refuses invalid or fractional yuan %s without silently changing the charge', async (amount) => {
      await mountPage()
      await pay(amount)
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(paymentRequests()).toEqual([])
    },
  )

  it('retains its QR and balance when a status read rejects, then checks the same order again', async () => {
    vi.useFakeTimers()
    await mountPage()
    status = async () => { throw new Error('fixture transport failure') }
    await pay()
    expect(screen.getByRole('alert').textContent).toBe(zh.rechargePollFailed)
    expect(screen.getByRole('img', { name: zh.qrAlt })).toBeTruthy()
    expect(screen.getByText('2,345')).toBeTruthy()
    expect(screen.queryByText(zh.polling)).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(paymentRequests()).toHaveLength(2)
    status = async () => orderStatus('success')
    const beforeRefresh = summaryReads
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.checkPayment })) })
    expect(screen.getByRole('status').textContent).toBe(t('rechargeSucceeded', { points: '1,000' }))
    expect(summaryReads).toBe(beforeRefresh + 1)
    expect(paymentRequests().map(([path]) => requestPath(path))).toEqual([
      '/credits/api/recharge/wechat',
      '/credits/api/recharge/wechat/order?outTradeNo=order-1',
      '/credits/api/recharge/wechat/order?outTradeNo=order-1',
    ])
  })

  it.each(['success', 'failed', 'expired'] as const)('stops polling after the confirmed %s state', async (state) => {
    vi.useFakeTimers()
    await mountPage()
    status = async () => orderStatus(state)
    const beforeRefresh = summaryReads
    await pay()
    expect(screen.getByText(zh[`status.${state === 'success' ? 'succeeded' : state}`])).toBeTruthy()
    expect(screen.queryByText(zh.polling)).toBeNull()
    expect(screen.queryByRole('button', { name: zh.checkPayment })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(paymentRequests()).toHaveLength(2)
    expect(summaryReads).toBe(beforeRefresh + (state === 'success' ? 1 : 0))
  })

  it.each(['succeeded', 'closed', 'processing', 'future_state'])(
    'makes the unrecognized %s state visible and retains a manual status check', async (state) => {
      vi.useFakeTimers()
      await mountPage()
      status = async () => orderStatus(state)
      const beforeRefresh = summaryReads
      await pay()
      expect(screen.getByRole('alert').textContent).toBe(t('rechargeStatusUnknown', { status: state }))
      expect(screen.getByText(zh['status.unknown'])).toBeTruthy()
      expect(screen.queryByText(zh.polling)).toBeNull()
      expect(screen.getByRole('img', { name: zh.qrAlt })).toBeTruthy()
      expect(screen.getByRole('button', { name: zh.checkPayment })).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(paymentRequests()).toHaveLength(2)
      expect(summaryReads).toBe(beforeRefresh)
    },
  )

  it('keeps confirmed payment visible when the following balance refresh fails', async () => {
    await mountPage()
    balanceUnavailable = true
    status = async () => orderStatus('success')
    await pay()
    expect(screen.getByText(zh['status.succeeded'])).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(t('rechargeSucceeded', { points: '1,000' }))
    expect(screen.getByRole('alert').textContent).toBe(zh.rechargeBalanceFailed)
    expect(screen.getByText('2,345')).toBeTruthy()
  })

  it('aborts the active HTTP status request when checks are stopped', async () => {
    await mountPage()
    status = async (_path, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Fixture request aborted', 'AbortError'))
      }, { once: true })
    })
    await pay()
    const signal = paymentRequests()[1]?.[1]?.signal
    expect(signal?.aborted).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.stopPolling })) })
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(zh.rechargePollingStopped)
  })

  it('does not trust a successful-looking payload inside a rejected order envelope', async () => {
    await mountPage()
    status = async () => Response.json({ ok: false, payload: { status: 'success', points: 1000 } })
    await pay()
    expect(screen.getByRole('alert').textContent).toBe(zh.rechargePollFailed)
    expect(screen.queryByText(zh['status.succeeded'])).toBeNull()
  })

  it('stops scheduled status reads until the user asks to check again', async () => {
    vi.useFakeTimers()
    await mountPage()
    await pay()
    fireEvent.click(screen.getByRole('button', { name: zh.stopPolling }))
    expect(screen.getByRole('status').textContent).toBe(zh.rechargePollingStopped)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(paymentRequests()).toHaveLength(2)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.checkPayment })) })
    expect(paymentRequests()).toHaveLength(3)
    expect(screen.getByText(zh.polling)).toBeTruthy()
  })

  it('discards a stopped read that completes after its replacement read', async () => {
    await mountPage()
    const pending = deferred<Response>()
    status = () => pending.promise
    await pay()
    const cancelledSignal = paymentRequests()[1]?.[1]?.signal
    expect(cancelledSignal?.aborted).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh.stopPolling }))
    expect(cancelledSignal?.aborted).toBe(true)
    status = async () => orderStatus('failed')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.checkPayment })) })
    const beforeRefresh = summaryReads
    await act(async () => { pending.resolve(orderStatus('success', 9000)) })
    expect(screen.getByRole('alert').textContent).toContain(zh['status.failed'])
    expect(screen.queryByText(/9,000/)).toBeNull()
    expect(summaryReads).toBe(beforeRefresh)
  })

  it('prevents the previous order response from replacing a newer QR or declaring it paid', async () => {
    await mountPage()
    const pending = deferred<Response>()
    status = () => pending.promise
    await pay()
    status = async () => orderStatus()
    create = async () => created('order-2', 30, 30_000)
    await pay('30')
    expect(screen.getByText('order-2')).toBeTruthy()
    const beforeRefresh = summaryReads
    await act(async () => { pending.resolve(orderStatus('success', 9000)) })
    expect(screen.getByText('order-2')).toBeTruthy()
    expect(screen.queryByText('order-1')).toBeNull()
    expect(screen.getByText('¥30 · 30,000 积分')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(summaryReads).toBe(beforeRefresh)
  })

  it('keeps an existing order when a replacement create has an unknown outcome and never recreates automatically', async () => {
    vi.useFakeTimers()
    await mountPage()
    await pay()
    create = async () => { throw new Error('fixture create connection lost') }
    await pay('30')
    expect(screen.getByRole('alert').textContent).toBe(zh.rechargeCreateFailed)
    expect(screen.getByText('order-1')).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.checkPayment })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(paymentRequests()).toHaveLength(3)
  })

  it('does not start status reads after unmounting during order creation', async () => {
    const view = await mountPage()
    const pending = deferred<Response>()
    create = () => pending.promise
    await pay()
    const signal = paymentRequests()[0]?.[1]?.signal
    expect(signal?.aborted).toBe(false)
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { pending.resolve(created()) })
    expect(paymentRequests()).toHaveLength(1)
  })

  it.each(['unmount', 'account change'] as const)('ignores a payment completion after %s', async (transition) => {
    vi.useFakeTimers()
    const view = await mountPage()
    const pending = deferred<Response>()
    status = () => pending.promise
    await pay()
    if (transition === 'unmount') view.unmount()
    else {
      accountId = 'account-b'
      await act(async () => { await refreshCredits() })
      expect(screen.queryByRole('img', { name: zh.qrAlt })).toBeNull()
    }
    const beforeRefresh = summaryReads
    await act(async () => { pending.resolve(orderStatus('success')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(summaryReads).toBe(beforeRefresh)
    expect(paymentRequests()).toHaveLength(2)
  })
})

productIt('exposes top-up through the shipped Credits composition and removes it on unload', async ({ start }) => {
  const client = await start()
  await act(async () => { client.ctx.layout.selectPanel('recharge' as MainPanelId) })
  expect(await screen.findByRole('heading', { name: en.rechargePageTitle })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: en.customAmount }), { target: { value: '1' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.confirmPay })) })
  expect(screen.getByRole('img', { name: en.qrAlt })).toBeTruthy()
  await act(async () => { await client.unload(SELF) })
  expect(screen.queryByRole('heading', { name: en.rechargePageTitle })).toBeNull()
  expect(client.ctx.slots.entries('main').some(row => row.options.key === 'recharge')).toBe(false)
}, 60_000)
