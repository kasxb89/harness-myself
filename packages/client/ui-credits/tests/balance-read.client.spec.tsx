// @vitest-environment jsdom
/** Failed balance reads through the product composition and real shared account store. */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { CreditsPage } from '../src/client/CreditsPage.tsx'
import { createCreditsSessionSource, refreshBalance, refreshCredits, signOutCredits } from '../src/client/session-store.ts'
import { zh, type CreditsKey } from '../src/client/locales.ts'

const productIt = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-client-ui-credits']) }, { mount: true })
let accountId = 0
let signedIn = true
let sessionUnavailable = false
let logoutRefused = false
let revokeUnknown = false
let summary: () => Promise<Response>
let fetcher = vi.fn<typeof fetch>()
const t = (key: string, values?: Record<string, string>): string => {
  let text: string = zh[key as CreditsKey] ?? key
  for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, value)
  return text
}
const pathOf = (input: RequestInfo | URL): string => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
const wallet = (view: ReturnType<typeof render>) => within(view.getByRole('region', { name: zh.balance }))

async function mountPage() {
  await refreshCredits(undefined, true)
  const props = { t, openRecharge: vi.fn(), signOutTimeoutMs: 20_000, completeSignIn: vi.fn() } as Parameters<typeof CreditsPage>[0]
  const view = render(<CreditsPage {...props} />)
  await act(async () => {})
  return view
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-26T12:00:00Z'))
  accountId++; signedIn = true; sessionUnavailable = false; logoutRefused = false; revokeUnknown = false
  summary = async () => Response.json({ ok: true, payload: { balance_points: 1234 } })
  fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = pathOf(input)
    if (path === '/credits/api/session' && signedIn && sessionUnavailable) return Response.json({ ok: false,
      code: 'ACCOUNT_NETWORK_ERROR', signedIn: true, liveness: 'unknown', failure: { reason: 'network', stage: 'account-read' },
      payload: { signedIn: true, creditsPerYuan: 1000, account: { id: String(accountId), phone: 'fixture' } } })
    if (path === '/credits/api/session') return Response.json({ ok: true, payload: {
      signedIn, creditsPerYuan: 1000, ...signedIn ? { account: { id: String(accountId), phone: '+8613800138000' } } : {},
    } })
    if (path === '/credits/api/summary') return await summary()
    if (path === '/credits/api/session/logout') {
      if (logoutRefused) return Response.json({ ok: false })
      signedIn = false; return Response.json({ ok: !revokeUnknown })
    }
    if (path.startsWith('/credits/api/usage?')) return Response.json({ ok: false, code: 'USAGE_UNAVAILABLE', payload: null })
    throw new Error(`Unexpected fixture route: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('balance read recovery', () => {
  productIt('keeps logout available for an unverified stored login and confirms local logout before showing the phone form', async () => {
    sessionUnavailable = true
    const view = await mountPage()
    expect(createCreditsSessionSource().getSnapshot().session).toBeNull()
    expect(view.getByText(zh['read.error.network'])).toBeTruthy()
    expect(view.queryByRole('region', { name: zh.balance })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: zh.signOut }))
    await waitFor(() => { expect(createCreditsSessionSource().getSnapshot().session?.signedIn).toBe(false) })
    expect(view.getByRole('region', { name: zh.loginTitle })).toBeTruthy()
    expect(fetcher.mock.calls.some(([input]) => /challenge|verify|recharge|generat/u.test(pathOf(input)))).toBe(false)
  })

  productIt('preserves retryable logout and shows failure instead of success when the Host still retains the login', async () => {
    sessionUnavailable = true; logoutRefused = true
    const view = await mountPage()
    fireEvent.click(view.getByRole('button', { name: zh.signOut }))
    await waitFor(() => { expect(view.getByText(zh.signOutFailed)).toBeTruthy() })
    expect(view.getByRole('button', { name: zh.signOut }).hasAttribute('disabled')).toBe(false)
    expect(view.queryByText(zh.signedOut)).toBeNull()
    expect(createCreditsSessionSource().getSnapshot().session).toBeNull()
    logoutRefused = false
    fireEvent.click(view.getByRole('button', { name: zh.signOut }))
    await waitFor(() => { expect(createCreditsSessionSource().getSnapshot().session?.signedIn).toBe(false) })
  })

  productIt('reports local logout separately when server revocation is unconfirmed', async () => {
    sessionUnavailable = true; revokeUnknown = true
    const view = await mountPage()
    fireEvent.click(view.getByRole('button', { name: zh.signOut }))
    await waitFor(() => { expect(view.getByText(zh.signedOutLocal)).toBeTruthy() })
    expect(view.queryByRole('button', { name: zh.signOut })).toBeNull()
  })

  for (const transition of ['account id', 'login owner'] as const) {
    productIt(`revalidates the shared session on usage retry after a cross-window ${transition} change`, async () => {
      let hostId = String(accountId), owner = 'a'.repeat(64), consumed = 100
      const fallback = fetcher.getMockImplementation()!
      fetcher.mockImplementation(async (input, init) => {
        const path = pathOf(input)
        if (path === '/credits/api/session') return Response.json({ ok: true, payload: {
          signedIn: true, creditsPerYuan: 1000, account: { id: hostId, phone: 'fixture account' }, accountOwner: owner,
        } })
        if (path === '/credits/api/summary') return Response.json({ ok: true, account: { id: hostId }, accountOwner: owner,
          payload: { balance_points: consumed === 100 ? 1234 : 9999 } })
        if (path.startsWith('/credits/api/usage?')) {
          const query = new URL(path, 'http://localhost').searchParams
          const start = Number(query.get('start')), end = Number(query.get('end'))
          return Response.json({ ok: true, account: { id: hostId }, accountOwner: owner, payload: {
            start, end, asOf: new Date(Date.now()).toISOString(), delayMinutes: 0,
            rows: [{ timestamp: end, model: 'fixture-model', billingRecords: 1, consumedPoints: consumed, totalTokens: 1 }],
          } })
        }
        return await fallback(input, init)
      })
      const view = await mountPage()
      const usage = () => within(view.getByRole('region', { name: zh['usage.title'] }))
      await waitFor(() => { expect(within(usage().getByRole('article', { name: zh['usage.consumed'] })).getByText('100')).toBeTruthy() })
      if (transition === 'account id') hostId = String(accountId + 1)
      owner = 'b'.repeat(64); consumed = 200
      fireEvent.click(usage().getByRole('button', { name: zh['usage.refresh'] }))
      await waitFor(() => { expect(usage().getByRole('alert').textContent).toContain(zh['usage.error.accountChanged']) })
      expect(within(usage().getByRole('article', { name: zh['usage.consumed'] })).queryByText('200')).toBeNull()
      const sessions = fetcher.mock.calls.filter(([input]) => pathOf(input) === '/credits/api/session').length
      const previousEpoch = createCreditsSessionSource().getSnapshot().accountEpoch
      fireEvent.click(usage().getByRole('button', { name: zh['usage.retry'] }))
      await waitFor(() => { expect(within(usage().getByRole('article', { name: zh['usage.consumed'] })).getByText('200')).toBeTruthy() })
      expect(fetcher.mock.calls.filter(([input]) => pathOf(input) === '/credits/api/session')).toHaveLength(sessions + 1)
      expect(createCreditsSessionSource().getSnapshot().accountEpoch).toBe(previousEpoch + 1)
      expect(createCreditsSessionSource().getSnapshot().session?.account?.id).toBe(hostId)
      expect(createCreditsSessionSource().getSnapshot().session?.accountOwner).toBe(owner)
      expect(wallet(view).getByText('9,999')).toBeTruthy()
      expect(usage().queryByRole('alert')).toBeNull()
      expect(fetcher.mock.calls.every(([input]) => !pathOf(input).includes('/recharge/'))).toBe(true)
    })
  }

  productIt('shows an explicit initial balance failure instead of treating payload null as loaded money', async () => {
    summary = async () => Response.json({ ok: false, code: 'BALANCE_UNAVAILABLE', payload: null })
    const view = await mountPage()
    expect(wallet(view).getByText('—')).toBeTruthy()
    expect(view.getByText(zh['read.error.unavailable'])).toBeTruthy()
    expect(createCreditsSessionSource().getSnapshot().failure).toBe('BALANCE_UNAVAILABLE')
    expect(view.queryByText('0')).toBeNull()
    expect(view.container.textContent).toMatchSnapshot()
  })

  productIt('keeps the last account balance visible when the real failed summary contains payload null', async () => {
    const view = await mountPage()
    expect(wallet(view).getByText('1,234')).toBeTruthy()
    summary = async () => Response.json({ ok: false, code: 'BALANCE_UNAVAILABLE', payload: null })
    fireEvent.click(wallet(view).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(view.getByText(zh.balanceStale)).toBeTruthy() })
    expect(wallet(view).getByText('1,234')).toBeTruthy()
    expect(view.getByText(zh['read.error.unavailable'])).toBeTruthy()
    expect(createCreditsSessionSource().getSnapshot().session?.signedIn).toBe(true)
    expect(view.container.textContent).toMatchSnapshot()
  })

  productIt('discloses a 429 cooldown and blocks repeated manual balance reads', async () => {
    const view = await mountPage()
    summary = async () => Response.json({ ok: false, code: 'BALANCE_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 30, payload: null })
    fireEvent.click(wallet(view).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(view.getByText(zh['read.error.rateLimited'])).toBeTruthy() })
    expect(view.getByText(t('read.retryAfter', { seconds: '30' }))).toBeTruthy()
    const reads = fetcher.mock.calls.filter(([input]) => pathOf(input) === '/credits/api/summary').length
    const button = wallet(view).getByRole('button', { name: zh.refresh })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button); fireEvent.click(button)
    await act(async () => { await refreshBalance() })
    expect(fetcher.mock.calls.filter(([input]) => pathOf(input) === '/credits/api/summary')).toHaveLength(reads)
    expect(wallet(view).getByText('1,234')).toBeTruthy()
  })

  productIt('keeps A money on a cross-window B reply and refreshes the current identity only after the user retries', async () => {
    const view = await mountPage()
    const previous = String(accountId)
    const changed = String(accountId + 1)
    summary = async () => Response.json({ ok: true, account: { id: changed }, payload: { balance_points: 9999 } })
    fireEvent.click(wallet(view).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(view.getByText(zh['read.error.accountChanged'])).toBeTruthy() })
    expect(wallet(view).getByText('1,234')).toBeTruthy()
    expect(view.queryByText('9,999')).toBeNull()
    expect(createCreditsSessionSource().getSnapshot().session?.account?.id).toBe(previous)
    const sessions = fetcher.mock.calls.filter(([input]) => pathOf(input) === '/credits/api/session').length
    accountId++
    fireEvent.click(wallet(view).getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(wallet(view).getByText('9,999')).toBeTruthy() })
    expect(createCreditsSessionSource().getSnapshot().session?.account?.id).toBe(changed)
    expect(fetcher.mock.calls.filter(([input]) => pathOf(input) === '/credits/api/session')).toHaveLength(sessions + 1)
    expect(view.queryByText(zh['read.error.accountChanged'])).toBeNull()
  })

  productIt('does not restore a signed-out account or its balance when an earlier read finally completes', async () => {
    const view = await mountPage()
    const late = Promise.withResolvers<Response>()
    summary = async () => late.promise
    let reading: Promise<void> | undefined
    act(() => { reading = refreshBalance() })
    await act(async () => { await signOutCredits(20_000) })
    await act(async () => {
      late.resolve(Response.json({ ok: true, payload: { balance_points: 9999 } }))
      await reading
    })
    expect(view.queryByRole('region', { name: zh.balance })).toBeNull()
    expect(view.queryByText('9,999')).toBeNull()
    expect(createCreditsSessionSource().getSnapshot().balance).toBeNull()
  })
})
