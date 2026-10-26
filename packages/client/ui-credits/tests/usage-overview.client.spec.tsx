// @vitest-environment jsdom
/** Account usage queries and filters with real chart presentation and fixture HTTP. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { UsageOverview } from '../src/client/UsageOverview.tsx'
import { zh, type CreditsKey } from '../src/client/locales.ts'
import type { UsageRow } from '../src/client/usage-analytics.ts'

const now = Date.parse('2026-10-15T10:00:00Z')
const rows: [UsageRow, UsageRow] = [
  { timestamp: Date.parse('2026-10-14T06:00:00Z') / 1000, model: 'model-a', billingRecords: 3, consumedPoints: 1200, totalTokens: 12000 },
  { timestamp: Date.parse('2026-10-15T06:00:00Z') / 1000, model: 'model-b', billingRecords: 2, consumedPoints: 600.5, totalTokens: 3000 },
]

const t = (key: string, values?: Record<string, string>): string => {
  let text: string = zh[key as CreditsKey] ?? key
  for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, value)
  return text
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
}

function reply(input: RequestInfo | URL, data: readonly UsageRow[] = rows, delayMinutes = 0, accountId?: string | null): Response {
  const query = new URL(requestUrl(input), 'http://localhost').searchParams
  const start = Number(query.get('start'))
  const end = Number(query.get('end'))
  return Response.json({ ok: true, ...accountId === undefined ? {} : { account: accountId === null ? null : { id: accountId } }, payload: {
    rows: data.filter(row => row.timestamp >= start && row.timestamp <= end),
    start, end, asOf: new Date(now).toISOString(), delayMinutes,
  } })
}

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('balance usage overview', () => {
  it('uses the Shanghai reporting window and filters every chart and total by model without a new request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async input => reply(input))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} />)
    const consumed = await view.findByRole('article', { name: '消费积分' })
    expect(within(consumed).getByText('1,800.5')).toBeTruthy()
    expect(within(view.getByRole('article', { name: '计费记录' })).getByText('5')).toBeTruthy()
    expect(within(view.getByRole('article', { name: 'Token 用量' })).getByText('15,000')).toBeTruthy()
    const url = new URL(requestUrl(fetchMock.mock.calls[0]?.[0]), 'http://localhost')
    expect(url.pathname).toBe('/credits/api/usage')
    expect(Number(url.searchParams.get('start'))).toBe(Date.parse('2026-10-09T00:00:00+08:00') / 1000)
    expect(Number(url.searchParams.get('end'))).toBe(now / 1000)
    fireEvent.change(view.getByRole('combobox', { name: '筛选统计模型' }), { target: { value: 'model:model-b' } })
    expect(within(consumed).getByText('600.5')).toBeTruthy()
    expect(within(view.getByRole('article', { name: '计费记录' })).getByText('2')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(view.getByText(zh['usage.billingFreshness'])).toBeTruthy()
    expect(view.queryByText(/延迟约 (?:0|5) 分钟/)).toBeNull()
    expect(view.container.textContent).toMatchSnapshot()
  })

  it('shows a reported positive delay without implying immediate billing availability', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => reply(input, rows, 2)))
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} />)
    expect(await view.findByText(t('usage.delay', { minutes: '2' }))).toBeTruthy()
    expect(view.queryByText(zh['usage.billingFreshness'])).toBeNull()
  })

  it('keeps unavailable statistics separate from zero and retries a read without touching account mutations', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'USAGE_UNAVAILABLE' }, { status: 503 }))
      .mockImplementation(async input => reply(input))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} />)
    expect(await view.findByRole('alert')).toBeTruthy()
    expect(view.queryByRole('article', { name: '消费积分' })).toBeNull()
    expect(view.queryByText('所选范围暂无计费记录')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '重试' }))
    expect(await view.findByRole('article', { name: '消费积分' })).toBeTruthy()
    for (const [input, init] of fetchMock.mock.calls) {
      expect(requestUrl(input)).toMatch(/^\/credits\/api\/usage\?/)
      expect(init?.method ?? 'GET').toBe('GET')
    }
  })

  it('discards an older period response that arrives after a newer selection', async () => {
    let resolveOld: ((response: Response) => void) | undefined
    let oldInput: RequestInfo | URL = ''
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce((input) => {
        oldInput = input
        return new Promise<Response>((resolve) => { resolveOld = resolve })
      })
      .mockImplementation(async input => reply(input))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} />)
    fireEvent.click(view.getByRole('button', { name: '今日' }))
    const consumed = await view.findByRole('article', { name: '消费积分' })
    expect(within(consumed).getByText('600.5')).toBeTruthy()
    await act(async () => { resolveOld?.(reply(oldInput)) })
    expect(within(consumed).getByText('600.5')).toBeTruthy()
    expect(view.getByRole('button', { name: '今日' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('explains a denied usage read without displaying fabricated zero values', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: false, code: 'USAGE_ACCESS_DENIED' }, { status: 403 }),
    ))
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} />)
    expect((await view.findByRole('alert')).textContent).toContain('使用量统计尚未获得读取授权')
    expect(view.queryByRole('article')).toBeNull()
    expect(view.queryByRole('img')).toBeNull()
  })

  it('shows reported empty usage without fabricating a trend', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => reply(input, [])))
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} />)
    expect(await view.findByText('所选范围暂无计费记录')).toBeTruthy()
    expect(within(view.getByRole('article', { name: '消费积分' })).getByText('0')).toBeTruthy()
    expect(view.queryByRole('img')).toBeNull()
    expect(view.getByText(zh['usage.emptyHint'])).toBeTruthy()
  })

  it.each([0.0000001, 1e300])('keeps extreme finite consumption readable without displaying zero: %s', async (consumedPoints) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => reply(input, [{ ...rows[1], consumedPoints }])))
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} />)
    const consumed = await view.findByRole('article', { name: '消费积分' })
    expect(within(consumed).getByText(new Intl.NumberFormat('zh-CN', {
      notation: 'scientific', maximumSignificantDigits: 15,
    }).format(consumedPoints))).toBeTruthy()
    expect(within(consumed).queryByText('0')).toBeNull()
    expect(view.getAllByText(/1E[-+]?\d+/).length).toBeGreaterThan(1)
  })

  it('contains malformed or overflowing data as a query error instead of drawing incorrect totals', async () => {
    const fetchMock = vi.fn<typeof fetch>(async input => reply(input, [
      { ...rows[0], consumedPoints: Number.MAX_VALUE },
      { ...rows[1], consumedPoints: Number.MAX_VALUE },
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} />)
    await waitFor(() => { expect(view.getByRole('alert').textContent).toContain('使用量读取失败') })
    expect(view.queryByRole('article')).toBeNull()
    expect(view.queryByRole('img')).toBeNull()
  })

  it('retains successful statistics on 429 and disables refresh and period changes until Retry-After expires', async () => {
    let monotonic = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async input => reply(input))
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'USAGE_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 2, payload: null }))
      .mockImplementation(async input => reply(input))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} />)
    await view.findByRole('article', { name: '消费积分' })
    fireEvent.click(view.getByRole('button', { name: '刷新统计' }))
    expect((await view.findByRole('alert')).textContent).toContain('统计读取过于频繁')
    expect(view.getByText('请等待 2 秒后再刷新')).toBeTruthy()
    expect(view.getByText(zh['usage.stale'])).toBeTruthy()
    expect(within(view.getByRole('article', { name: '消费积分' })).getByText('1,800.5')).toBeTruthy()
    for (const label of ['刷新统计', '重试', '今日']) {
      const button = view.getByRole('button', { name: label })
      expect(button.hasAttribute('disabled')).toBe(true)
      fireEvent.click(button)
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Changing the system clock cannot shorten the monotonic retry deadline.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2000-01-01'))
    monotonic += 2000
    await waitFor(() => { expect(view.getByRole('button', { name: '重试' }).hasAttribute('disabled')).toBe(false) }, { timeout: 1500 })
    fireEvent.click(view.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(view.queryByRole('alert')).toBeNull() })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each(['b', null])('rejects another response account without replacing A statistics: %s', async (owner) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async input => reply(input, rows, 0, 'a'))
      .mockImplementation(async input => reply(input, [rows[1]], 0, owner))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} accountId="a" />)
    await view.findByRole('article', { name: '消费积分' })
    fireEvent.click(view.getByRole('button', { name: '刷新统计' }))
    expect((await view.findByRole('alert')).textContent).toContain(zh['usage.error.accountChanged'])
    expect(within(view.getByRole('article', { name: '消费积分' })).getByText('1,800.5')).toBeTruthy()
    expect(view.getByText(zh['usage.stale'])).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['a', undefined])('accepts an owned response or a legacy Host without account metadata: %s', async (owner) => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => reply(input, rows, 0, owner))
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} accountId="a" />)
    expect(await view.findByRole('article', { name: '消费积分' })).toBeTruthy()
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('hides prior account statistics immediately when the caller observes a different identity', async () => {
    const pending = Promise.withResolvers<Response>()
    let inputB: RequestInfo | URL = ''
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockImplementationOnce(async input => reply(input, rows, 0, 'a'))
      .mockImplementation((input) => { inputB = input; return pending.promise }))
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} accountId="a" />)
    await view.findByRole('article', { name: '消费积分' })
    view.rerender(<UsageOverview t={t} creditsPerYuan={1000} accountId="b" />)
    expect(view.queryByRole('article', { name: '消费积分' })).toBeNull()
    await act(async () => { pending.resolve(reply(inputB, [rows[1]], 0, 'b')) })
    expect(within(await view.findByRole('article', { name: '消费积分' })).getByText('600.5')).toBeTruthy()
  })

  it.each([
    [new TypeError('private connection diagnostic'), zh['usage.error.network']],
    [new DOMException('private timeout diagnostic', 'TimeoutError'), zh['usage.error.timeout']],
  ])('classifies a local read failure without blaming the server or discarding statistics: %s', async (error, message) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async input => reply(input))
      .mockRejectedValueOnce(error)
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<UsageOverview t={t} creditsPerYuan={1000} />)
    await view.findByRole('article', { name: '消费积分' })
    fireEvent.click(view.getByRole('button', { name: '刷新统计' }))
    expect((await view.findByRole('alert')).textContent).toContain(message)
    expect(view.container.textContent).not.toContain('private')
    expect(view.getByText(zh['usage.stale'])).toBeTruthy()
    expect(within(view.getByRole('article', { name: '消费积分' })).getByText('1,800.5')).toBeTruthy()
  })
})
