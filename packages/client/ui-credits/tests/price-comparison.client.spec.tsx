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
const response = () => Response.json({ ok: true, account: { id: 'a' }, accountOwner: owner, payload: payload() })
let fetcher = vi.fn<typeof fetch>()
beforeEach(() => {
  fetcher = vi.fn<typeof fetch>(async () => response())
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

async function card() {
  return await screen.findByRole('region', { name: zh['comparison.title'] })
}
function deferred<T>() { return Promise.withResolvers<T>() }

describe('recharge model reference card', () => {
  it('shows an explicit example, then independent input/output and same-spec video details', async () => {
    render(<PriceComparison {...props} />)
    const region = await card()
    expect(region.textContent).toContain(zh['comparison.basis'])
    expect(region.textContent).toContain(zh['comparison.textBasis'])
    expect(region.textContent).toContain('GPT Fixture')
    expect(region.textContent).toContain('约 5 折')
    expect(region.textContent).toContain('元 / 百万 Token')
    fireEvent.click(within(region).getByRole('button', { name: zh['comparison.expand'] }))
    expect(region.textContent).toContain('输入')
    expect(region.textContent).toContain('输出')
    expect(region.textContent).toContain('约 3 折')
    const source = within(region).getAllByRole('link', { name: zh['comparison.source'] })[0]
    expect(source?.getAttribute('href')).toBe('https://openai.com/api/pricing/')
    expect(source?.getAttribute('rel')).toBe('noopener noreferrer')
    fireEvent.click(within(region).getByRole('button', { name: zh['comparison.kind.video'] }))
    expect(region.textContent).not.toContain('GPT Fixture')
    expect(region.textContent).toContain('时长 5 秒')
    expect(region.textContent).toContain('模式 文生视频')
    expect(region.textContent).not.toContain('ycapi-video-fixture')
    expect(region.textContent).toContain('无参考素材；官方参考价按相同分辨率和时长折算。')
    expect(region.textContent).not.toContain('Token公式')
    expect(region.textContent).toContain('元 / 秒')
    expect(region.textContent).toContain('平台 ¥1 · 官方参考 ¥2')
    fireEvent.change(within(region).getByRole('textbox', { name: zh['comparison.search'] }),
      { target: { value: 'ycapi-video-fixture' } })
    expect(region.textContent).toContain('Video Fixture')
    fireEvent.change(within(region).getByRole('textbox', { name: zh['comparison.search'] }), { target: { value: 'no-match' } })
    expect(region.textContent).toContain(zh['comparison.empty'])
    fireEvent.click(within(region).getByRole('button', { name: zh['comparison.collapse'] }))
    expect(region.textContent).toContain('GPT Fixture')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined()
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
    fireEvent.click(within(region).getByRole('button', { name: zh['comparison.expand'] }))
    fireEvent.click(within(region).getByRole('button', { name: zh['comparison.kind.video'] }))
    expect(region.textContent).toContain(`模式 ${label}`)
    expect(region.textContent).toContain('仅支持无参考素材；其它时长按供应商说明。')
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
