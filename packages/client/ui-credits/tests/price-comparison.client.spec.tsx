// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PriceComparison } from '../src/client/PriceComparison.tsx'
import { zh, type CreditsKey } from '../src/client/locales.ts'

const t = (key: string, values?: Record<string, string>): string => {
  let result: string = zh[key as CreditsKey] ?? key
  for (const [key, value] of Object.entries(values ?? {})) result = result.replaceAll(`{${key}}`, value)
  return result
}
const owner = 'a'.repeat(64)
const props = { accountId: 'a', accountOwner: owner, accountEpoch: 1, t }
function payload() {
  const reference = { schema_version: 1, currency: 'CNY', source_currency: 'USD', official_cny: '2',
    model: 'gpt-fixture-official', unit: 'CNY / million tokens', source_url: 'https://openai.com/api/pricing/',
    checked_at: '2026-10-31', conditions: 'Standard, non-cached input', usd_cny: '6.7138' }
  const input = { params: {}, retail_cny: '1', unit: reference.unit, direction: 'input', official_reference: reference }
  return { basis: 'default', models: [
    { id: 'gpt-fixture', name: 'GPT Fixture', kind: 'text', rows: [input, { ...input, direction: 'output', retail_cny: '3',
      official_reference: { ...reference, official_cny: '10', conditions: 'Standard output' } }] },
    { id: 'ycapi-video-fixture', name: 'Video Fixture', kind: 'video', rows: [
      { params: { duration: 5, resolution: '720p', mode: 'text-to-video' }, retail_cny: '0.2', unit: 'CNY / second', retail_total_cny: '1',
        official_reference: { ...reference, model: 'video-official', unit: 'CNY / second', official_cny: '0.4',
          official_total_cny: '2', conditions: '无参考素材；非5秒值按厂商同规格5秒例与Token公式折算。' } },
    ] },
  ] }
}
const response = (data = payload()) => Response.json({ ok: true, account: { id: 'a' }, accountOwner: owner, payload: data })
let fetcher = vi.fn<typeof fetch>()
beforeEach(() => {
  fetcher = vi.fn<typeof fetch>(async () => response())
  vi.stubGlobal('fetch', fetcher)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function card() {
  return await screen.findByRole('region', { name: zh['comparison.title'] })
}
function deferred<T>() { return Promise.withResolvers<T>() }

describe('recharge model reference card', () => {
  it('keeps model summaries compact and opens independent input/output details in a modal', async () => {
    render(<PriceComparison {...props} />)
    const region = await card()
    expect(region.textContent).toContain(zh['comparison.basis'])
    expect(region.textContent).toContain(zh['comparison.textBasis'])
    expect(region.textContent).toContain('GPT Fixture')
    expect(region.textContent).toContain('约 5 折')
    expect(region.textContent).toContain('元 / 百万 Token')
    expect(region.textContent).not.toContain('约 3 折')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(region.textContent).toMatchSnapshot()
    const open = within(region).getByRole('button', { name: t('comparison.openModel', { model: 'GPT Fixture' }) })
    open.focus()
    fireEvent.click(open)
    const dialog = screen.getByRole('dialog', { name: t('comparison.detailsTitle', { model: 'GPT Fixture' }) })
    expect(dialog.textContent).toContain('输入')
    expect(dialog.textContent).toContain('输出')
    expect(dialog.textContent).toContain('约 3 折')
    const source = within(dialog).getAllByRole('link', { name: zh['comparison.source'] })[0]
    expect(source?.getAttribute('href')).toBe('https://openai.com/api/pricing/')
    expect(source?.getAttribute('rel')).toBe('noopener noreferrer')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(open)
    fireEvent.click(within(region).getByRole('button', { name: zh['comparison.kind.video'] }))
    expect(region.textContent).not.toContain('GPT Fixture')
    expect(region.textContent).toContain('时长 5 秒')
    fireEvent.click(within(region).getByRole('button', { name: t('comparison.openModel', { model: 'Video Fixture' }) }))
    const video = screen.getByRole('dialog')
    expect(video.textContent).toContain('模式 文生视频')
    expect(video.textContent).toContain('无参考素材；官方参考价按相同分辨率和时长折算。')
    expect(video.textContent).not.toContain('Token公式')
    expect(video.textContent).toContain('元 / 秒')
    expect(video.textContent).toContain('平台 ¥1 · 官方参考 ¥2')
    fireEvent.click(within(video).getByRole('button', { name: zh['comparison.done'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined()
  })

  it('lists every model as one card and filters/searches without expanding specifications or reading again', async () => {
    const data = payload()
    data.models.push({ ...data.models[0]!, id: 'gpt-fixture-two', name: 'GPT Fixture Two' })
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, account: { id: 'a' }, accountOwner: owner, payload: data }))
    render(<PriceComparison {...props} />)
    const region = await card()
    const list = within(region).getByRole('region', { name: zh['comparison.modelList'] })
    expect(list.tabIndex).toBe(0)
    expect(within(list).getAllByRole('button')).toHaveLength(3)
    expect(list.textContent).toContain('GPT Fixture Two')
    expect(list.textContent).not.toContain('Standard output')
    fireEvent.click(within(region).getByRole('button', { name: zh['comparison.kind.video'] }))
    expect(within(list).getAllByRole('button')).toHaveLength(1)
    expect(within(region).getByRole('button', { name: '视频' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(within(region).getByRole('textbox', { name: zh['comparison.search'] }), { target: { value: 'ycapi-video-fixture' } })
    expect(list.textContent).toContain('Video Fixture')
    fireEvent.change(within(region).getByRole('textbox', { name: zh['comparison.search'] }), { target: { value: 'no-match' } })
    expect(list.textContent).toContain(zh['comparison.empty'])
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('refreshes the reference price, source and checked date together on return while keeping existing details visible', async () => {
    const next = payload(), fresh = deferred<Response>()
    for (const row of next.models[0]!.rows) Object.assign(row.official_reference, {
      official_cny: '4', source_url: 'https://openai.com/api/pricing/?revision=2', checked_at: '2026-11-11',
    })
    fetcher.mockResolvedValueOnce(response()).mockReturnValueOnce(fresh.promise)
    render(<PriceComparison {...props} />)
    const region = await card()
    fireEvent.click(within(region).getByRole('button', { name: t('comparison.openModel', { model: 'GPT Fixture' }) }))
    const dialog = screen.getByRole('dialog')
    await act(async () => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(dialog.textContent).toContain('¥2')
    expect(dialog.textContent).toContain('2026-10-31')
    expect(within(dialog).getAllByRole('link')[0]?.getAttribute('href')).toBe('https://openai.com/api/pricing/')
    await act(async () => { fresh.resolve(response(next)); await fresh.promise })
    expect(dialog.textContent).toContain('¥4')
    expect(dialog.textContent).toContain('2026-11-11')
    expect(dialog.textContent).not.toContain('2026-10-31')
    expect(within(dialog).getAllByRole('link')[0]?.getAttribute('href')).toBe('https://openai.com/api/pricing/?revision=2')
    expect(fetcher.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true)
  })

  it.each(['focus', 'visibilitychange'] as const)('merges a foreground activation starting with %s even after its read settles', async (first) => {
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    render(<PriceComparison {...props} />)
    await card()
    await act(async () => {
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    expect(fetcher).toHaveBeenCalledOnce()
    visibility = 'visible'
    const dispatch = (event: 'focus' | 'visibilitychange'): void => {
      (event === 'focus' ? window : document).dispatchEvent(new Event(event))
    }
    await act(async () => { dispatch(first) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { dispatch(first === 'focus' ? 'visibilitychange' : 'focus') })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('does not abort or queue another read when foreground signals arrive during an in-flight read', async () => {
    const pending = deferred<Response>()
    fetcher.mockReturnValueOnce(pending.promise)
    render(<PriceComparison {...props} />)
    const signal = fetcher.mock.calls[0]?.[1]?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    await act(async () => {
      window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'))
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(false)
    await act(async () => { pending.resolve(response()); await pending.promise })
    expect((await card()).textContent).toContain('GPT Fixture')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([
    ['HTTP 429 seconds', () => new Response(null, { status: 429, headers: { 'Retry-After': '2' } })],
    ['HTTP 429 date', () => new Response(null, { status: 429,
      headers: { 'Retry-After': 'Mon, 26 Oct 2026 12:00:02 GMT', Date: 'Mon, 26 Oct 2026 12:00:00 GMT' } })],
    ['Host HTTP 200 with 429 metadata', () => Response.json({ ok: false,
      code: 'PRICE_COMPARISONS_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 2 })],
    ['Host HTTP 200 with 503 metadata', () => Response.json({ ok: false,
      code: 'PRICE_COMPARISONS_UNAVAILABLE', httpStatus: 503, retryAfterSeconds: 2 })],
  ] as const)(
    'blocks foreground reads during %s and waits for another activation after its cooldown expires', async (_label, limitedResponse) => {
      vi.useFakeTimers()
      let now = 1000
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      fetcher.mockResolvedValueOnce(limitedResponse())
      render(<PriceComparison {...props} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const retry = screen.getByRole('button', { name: zh['comparison.retry'] })
      expect(retry.hasAttribute('disabled')).toBe(true)
      await act(async () => {
        window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'))
        document.dispatchEvent(new Event('visibilitychange')); fireEvent.click(retry)
      })
      expect(fetcher).toHaveBeenCalledOnce()
      await act(async () => { now += 2000; await vi.advanceTimersByTimeAsync(2000) })
      expect(retry.hasAttribute('disabled')).toBe(false)
      expect(fetcher).toHaveBeenCalledOnce()
      await act(async () => { window.dispatchEvent(new Event('focus')) })
      expect(fetcher).toHaveBeenCalledOnce()
      await act(async () => {
        window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('region', { name: zh['comparison.title'] }).textContent).toContain('GPT Fixture')
    },
  )

  it('retains the same login’s successful references when a foreground refresh fails', async () => {
    fetcher.mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('Private transport diagnostic'))
    render(<PriceComparison {...props} />)
    const region = await card()
    await act(async () => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
    expect(region.textContent).toContain('GPT Fixture')
    expect(region.textContent).toContain('¥2')
    expect(region.textContent).toContain(zh['comparison.network'])
    expect(region.textContent).not.toContain('Private transport diagnostic')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('aborts on unmount, ignores a late response and removes foreground listeners', async () => {
    const pending = deferred<Response>()
    fetcher.mockReturnValueOnce(pending.promise)
    const view = render(<PriceComparison {...props} />)
    const signal = fetcher.mock.calls[0]?.[1]?.signal
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      pending.resolve(response()); await pending.promise
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(view.container.textContent).toBe('')
  })

  it('isolates foreground reads from a previous login of the same account', async () => {
    const old = deferred<Response>(), next = payload(), nextOwner = 'b'.repeat(64)
    next.models[0]!.name = 'New Login Reference'
    const nextResponse = () => Response.json({ ok: true, account: { id: 'a' }, accountOwner: nextOwner, payload: next })
    fetcher.mockReturnValueOnce(old.promise).mockImplementation(async () => nextResponse())
    const view = render(<PriceComparison {...props} />)
    const oldSignal = fetcher.mock.calls[0]?.[1]?.signal
    view.rerender(<PriceComparison {...props} accountOwner={nextOwner} accountEpoch={2} />)
    expect((await card()).textContent).toContain('New Login Reference')
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => {
      old.resolve(response()); await old.promise
      window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'))
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect((await card()).textContent).toContain('New Login Reference')
    expect((await card()).textContent).not.toContain('GPT Fixture')
  })

  it.each([404, 200])('discovers newly configured references after an initially unsupported or empty HTTP %i response', async (status) => {
    fetcher.mockResolvedValueOnce(Response.json(status === 404 ? { ok: false } : { ok: true,
      payload: { basis: 'default', models: [] } }, { status }))
    render(<PriceComparison {...props} />)
    await act(async () => {})
    expect(screen.queryByRole('region')).toBeNull()
    await act(async () => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
    expect((await card()).textContent).toContain('GPT Fixture')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('reads again when returning to a newly mounted recharge comparison', async () => {
    const view = render(<PriceComparison {...props} />)
    await card()
    view.unmount()
    const next = payload()
    next.models[0]!.name = 'Changed While Away'
    fetcher.mockResolvedValueOnce(response(next))
    render(<PriceComparison {...props} />)
    expect((await card()).textContent).toContain('Changed While Away')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('removes references and their open details when the refreshed configuration withdraws them', async () => {
    fetcher.mockResolvedValueOnce(response()).mockResolvedValueOnce(Response.json({ ok: true,
      account: { id: 'a' }, accountOwner: owner, payload: { basis: 'default', models: [] } }))
    render(<PriceComparison {...props} />)
    const region = await card()
    fireEvent.click(within(region).getByRole('button', { name: t('comparison.openModel', { model: 'GPT Fixture' }) }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('closes its selected details when the account changes', async () => {
    const view = render(<PriceComparison {...props} />)
    const region = await card()
    const open = within(region).getByRole('button', { name: t('comparison.openModel', { model: 'GPT Fixture' }) })
    open.focus()
    fireEvent.click(open)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    view.rerender(<PriceComparison {...props} accountId="b" accountOwner={'b'.repeat(64)} accountEpoch={2} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([
    ['text-to-image', '文生图'], ['image-to-video', '图生视频'], ['image-to-image', '图生图'], ['commercial-mode', 'commercial-mode'],
  ])('localizes native mode %s while retaining unrelated reference limitations', async (mode, label) => {
    const data = payload()
    const model = data.models[1]
    const row = model?.rows[0]
    if (row === undefined) throw new Error('Expected video fixture')
    Object.assign(row.params, { mode })
    row.official_reference.conditions = '仅支持无参考素材；其它时长按供应商说明。'
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, account: { id: 'a' }, accountOwner: owner, payload: data }))
    render(<PriceComparison {...props} />)
    const region = await card()
    fireEvent.click(within(region).getByRole('button', { name: t('comparison.openModel', { model: 'Video Fixture' }) }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain(`模式 ${label}`)
    expect(dialog.textContent).toContain('仅支持无参考素材；其它时长按供应商说明。')
    expect(row.official_reference.conditions).toBe('仅支持无参考素材；其它时长按供应商说明。')
  })

  it.each([404, 200])('keeps old API or unverified data absent for HTTP %i', async (status) => {
    fetcher.mockResolvedValueOnce(Response.json(status === 404 ? { ok: false } : { ok: true, payload: { basis: 'default', models: [] } }, { status }))
    render(<PriceComparison {...props} />)
    await waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('keeps a local network failure separate from balance and retries only after a click', async () => {
    fetcher.mockRejectedValueOnce(new TypeError('Network disconnected'))
    render(<PriceComparison {...props} />)
    const region = await card()
    expect(region.textContent).toContain(zh['comparison.network'])
    expect(fetcher).toHaveBeenCalledOnce()
    fireEvent.click(within(region).getByRole('button', { name: zh['comparison.retry'] }))
    await waitFor(() => { expect(region.textContent).toContain('GPT Fixture') })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(region.textContent).not.toContain(zh['comparison.network'])
  })

  it('recognizes a Host transport failure without calling it a server failure', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ ok: false, code: 'PRICE_COMPARISONS_NETWORK' }))
    render(<PriceComparison {...props} />)
    expect((await card()).textContent).toContain(zh['comparison.network'])
  })

  it('ignores a previous account response even when it arrives after the new one', async () => {
    const old = deferred<Response>()
    fetcher.mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json({ ok: true,
      account: { id: 'b' }, accountOwner: 'b'.repeat(64), payload: { basis: 'default', models: [] } }))
    const view = render(<PriceComparison {...props} />)
    view.rerender(<PriceComparison {...props} accountId="b" accountOwner={'b'.repeat(64)} accountEpoch={2} />)
    await act(async () => { old.resolve(response()); await old.promise })
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('drops a successful response that names a different owner', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, account: { id: 'other' }, accountOwner: owner, payload: payload() }))
    render(<PriceComparison {...props} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('region')).toBeNull()
  })

  it.each(['reject', 'envelope'] as const)('makes a timeout retryable when the transport settles as %s', async (settlement) => {
    vi.useFakeTimers()
    fetcher.mockImplementationOnce(async (_input, init) => await new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        if (settlement === 'reject') reject(new DOMException('Aborted read', 'AbortError'))
        else resolve(Response.json({ ok: false, code: 'PRICE_COMPARISONS_UNAVAILABLE' }))
      }, { once: true })
    }))
    render(<PriceComparison {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    const region = screen.getByRole('region', { name: zh['comparison.title'] })
    expect(region.textContent).toContain(zh['comparison.timeout'])
    const retry = within(region).getByRole('button', { name: zh['comparison.retry'] })
    expect(retry.hasAttribute('disabled')).toBe(false)
    expect(fetcher).toHaveBeenCalledOnce()
    await act(async () => { fireEvent.click(retry); await vi.advanceTimersByTimeAsync(0) })
    expect(region.textContent).toContain('GPT Fixture')
  })

  it('respects a server cooldown without an automatic read', async () => {
    vi.useFakeTimers()
    fetcher.mockResolvedValueOnce(Response.json({ ok: false, retryAfterSeconds: 2 }, { status: 429 }))
    render(<PriceComparison {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const retry = screen.getByRole('button', { name: zh['comparison.retry'] })
    expect(retry.hasAttribute('disabled')).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(retry.hasAttribute('disabled')).toBe(false)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
