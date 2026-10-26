// @vitest-environment jsdom
/** The actual wallet footer and page consume one account store, including its cooldown and final release. */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { act, cleanup, render, within } from '@testing-library/react'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { FooterAction } from '../src/client/FooterAction.tsx'
import { CreditsPage } from '../src/client/CreditsPage.tsx'
import { createCreditsSessionSource, refreshBalance, refreshCredits } from '../src/client/session-store.ts'
import { zh, type CreditsKey } from '../src/client/locales.ts'

const productIt = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-client-ui-credits']) }, { mount: true })
const pathOf = (input: RequestInfo | URL): string => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
const t = (key: string, values?: Record<string, string>): string => {
  let text: string = zh[key as CreditsKey] ?? key
  for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, value)
  return text
}
const footer = { wide: true, label: '共享余额', rechargeLabel: zh.goRecharge, customLabel: zh.customAmount,
  open: vi.fn(), openRecharge: vi.fn() } as Parameters<typeof FooterAction>[0]
const page = { t, openRecharge: vi.fn(), completeSignIn: vi.fn() } as Parameters<typeof CreditsPage>[0]
let identity = 0
let summary: () => Promise<Response>
let fetcher = vi.fn<typeof fetch>()
beforeEach(() => {
  identity++
  summary = async () => Response.json({ ok: true, account: { id: String(identity) }, payload: { balance_points: 1234 } })
  fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = pathOf(input)
    if (path === '/credits/api/session') return Response.json({ ok: true, payload: {
      signedIn: true, creditsPerYuan: 1000, account: { id: String(identity), phone: '+8613800138000' },
    } })
    if (path === '/credits/api/summary') return await summary()
    if (path.startsWith('/credits/api/usage?')) return Response.json({ ok: false, code: 'USAGE_UNAVAILABLE' })
    throw new Error(`Unexpected fixture route: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const accountReads = () => fetcher.mock.calls.filter(([input]) => ['/credits/api/session', '/credits/api/summary'].includes(pathOf(input)))

describe('shared wallet footer lifecycle', () => {
  productIt('shares one heartbeat and a server cooldown with the balance page, then stops after the final consumer leaves', async () => {
    vi.useFakeTimers()
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    await refreshCredits(undefined, true)
    fetcher.mockClear()
    const view = render(<><FooterAction {...footer} /><CreditsPage {...page} /></>)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(accountReads()).toHaveLength(2)
    expect(within(view.getByRole('button', { name: footer.label })).getByText('1,234')).toBeTruthy()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(accountReads()).toHaveLength(4)
    summary = async () => Response.json({ ok: false, code: 'BALANCE_RATE_LIMITED', httpStatus: 429,
      retryAfterSeconds: 120, payload: null })
    await act(async () => { await refreshBalance() })
    const limited = accountReads().length
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(accountReads()).toHaveLength(limited)
    expect(within(view.getByRole('button', { name: footer.label })).getByText('1,234')).toBeTruthy()
    expect(view.getByText(zh['read.error.rateLimited'])).toBeTruthy()
    view.unmount()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(240_000)
    })
    expect(accountReads()).toHaveLength(limited)
  })

  productIt('aborts its shared in-flight read on final unmount and ignores a late footer reply', async () => {
    await refreshCredits(undefined, true)
    const late = Promise.withResolvers<Response>()
    summary = async () => await late.promise
    const view = render(<FooterAction {...footer} />)
    await act(async () => {})
    const read = fetcher.mock.calls.findLast(([input]) => pathOf(input) === '/credits/api/summary')
    expect(read?.[1]?.signal).toBeInstanceOf(AbortSignal)
    view.unmount()
    expect(read?.[1]?.signal?.aborted).toBe(true)
    await act(async () => {
      late.resolve(Response.json({ ok: true, account: { id: String(identity) }, payload: { balance_points: 9999 } }))
    })
    expect(createCreditsSessionSource().getSnapshot().balance?.balance_points).toBe(1234)
    expect(view.container.textContent).toBe('')
  })
})
