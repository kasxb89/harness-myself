/** Account usage reads only signed-in logs and converts with the live instance settings. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseUsageWindow, readAccountUsage, type UsageReadOptions } from '../src/usage.ts'

afterEach(() => { vi.unstubAllGlobals() })

const start = 1_792_000_800
const end = start + 86_399
const usage = {
  id: 1, user_id: 7, type: 2, created_at: start, model_name: 'image-model', quota: 1,
  prompt_tokens: 5, completion_tokens: 10, other: '{"billing_mode":"token"}', request_id: 'request-one',
}
const options = (upstreamToken: string | undefined = 'user-token'): UsageReadOptions => ({
  start, end, baseUrl: 'https://8.133.202.230/harness', timeoutMs: 500,
  account: { id: '7', phone: '+8613800000000' }, upstreamToken,
})

function mockSource(overrides: Record<string, unknown> = {}, logs = [usage], logPage?: (page: number) => unknown) {
  const calls: { path: string; token: string | null; redirect: RequestRedirect | undefined }[] = []
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    expect(url.origin).toBe('https://8.133.202.230')
    expect(url.pathname.startsWith('/harness/')).toBe(true)
    calls.push({ path: `${url.pathname}${url.search}`, token: new Headers(init?.headers).get('authorization'), redirect: init?.redirect })
    const path = url.pathname.slice('/harness'.length)
    let body: unknown
    if (path === '/api/user/self') body = { success: true, data: { id: 7 } }
    else if (path === '/api/log/self') {
      const page = Number(url.searchParams.get('p'))
      body = logPage?.(page) ?? {
        success: true, data: { page, page_size: 100, total: logs.length, items: logs.slice((page - 1) * 100, page * 100) },
      }
    } else if (path === '/api/status') body = { success: true, data: { quota_per_unit: 500_000, usd_exchange_rate: 7.3 } }
    else throw new Error('unexpected path')
    if (path in overrides) body = overrides[path]
    if (body instanceof Error) throw body
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return { calls, fetcher }
}

describe('usage window validation', () => {
  it('accepts exactly 31 inclusive days without choosing a timezone', () => {
    expect(parseUsageWindow(new URLSearchParams({ start: String(start), end: String(start + 31 * 86_400 - 1) })))
      .toEqual({ ok: true, window: { start, end: start + 31 * 86_400 - 1 } })
  })

  it.each([
    '', 'start=1', 'start=1&end=2&userId=7', 'start=1&end=2&username=alice',
    'start=1&start=2&end=3', 'start=0&end=1', 'start=-1&end=2', 'start=1.5&end=2',
    'start=1e3&end=2000', 'start=2&end=1', 'start=1&end=2678401',
    'start=1&end=9007199254740992', 'start=1&end=253402300800',
  ])('rejects invalid or account-selecting parameters: %s', (query) => {
    expect(parseUsageWindow(new URLSearchParams(query))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  })
})

describe('readAccountUsage', () => {
  it('reads the verified user logs and converts quota without rounding or admin fallback', async () => {
    const { calls } = mockSource()
    expect(await readAccountUsage(options())).toMatchObject({
      ok: true,
      payload: { start, end, delayMinutes: 0, rows: [{ timestamp: start, model: 'image-model', billingRecords: 1, consumedPoints: 0.0146, totalTokens: 15 }] },
    })
    expect(calls.map(call => call.path.split('?')[0])).toEqual(['/harness/api/user/self', '/harness/api/status', '/harness/api/log/self'])
    const query = new URLSearchParams(calls[2]?.path.split('?')[1])
    expect(Object.fromEntries(query)).toEqual({ type: '2', p: '1', page_size: '100', start_timestamp: String(start), end_timestamp: String(end) })
    expect(calls[2]?.token).toBe('Bearer user-token')
    expect(calls[1]?.token).toBeNull()
    expect(calls.every(call => call.redirect === 'error')).toBe(true)
  })

  it('loads every complete page and aggregates the same hour and model', async () => {
    const logs = Array.from({ length: 101 }, (_, index) => ({ ...usage, id: index + 1, request_id: `request-${String(index)}` }))
    const { calls } = mockSource({}, logs)
    expect(await readAccountUsage(options())).toMatchObject({
      ok: true, payload: { rows: [{ billingRecords: 101, consumedPoints: 101 * 0.0146, totalTokens: 1515 }] },
    })
    expect(calls.filter(call => call.path.includes('/api/log/self?')).map(call => new URLSearchParams(call.path.split('?')[1]).get('p'))).toEqual(['1', '2'])
  })

  it('returns an actual empty dataset when the authenticated log source succeeds', async () => {
    mockSource({}, [])
    expect(await readAccountUsage(options())).toMatchObject({ ok: true, payload: { rows: [] } })
  })

  it('keeps empty model names and parses empty metadata without inventing a model', async () => {
    mockSource({}, [{ ...usage, model_name: '', other: '' }])
    expect(await readAccountUsage(options())).toMatchObject({ ok: true, payload: { rows: [{ model: '', billingRecords: 1 }] } })
  })

  it.each([undefined, ''])('does not send any request without a user access token: %s', async (token) => {
    const { calls } = mockSource()
    expect(await readAccountUsage({ ...options(), upstreamToken: token })).toMatchObject({ ok: false, code: 'USAGE_UNAVAILABLE' })
    expect(calls).toEqual([])
  })

  it.each(['legacy-phone-session', '0'])('does not resolve legacy or invalid account %s through an admin token', async (id) => {
    const { calls } = mockSource()
    expect(await readAccountUsage({ ...options(), account: { ...options().account, id } })).toMatchObject({ ok: false, code: 'USAGE_UNAVAILABLE' })
    expect(calls).toEqual([])
  })

  it('rejects a self token belonging to another account', async () => {
    const { calls } = mockSource({ '/api/user/self': { success: true, data: { id: 8 } } })
    expect(await readAccountUsage(options())).toMatchObject({ ok: false, code: 'USAGE_IDENTITY_MISMATCH' })
    expect(calls).toHaveLength(1)
  })

  it.each(['/api/user/self', '/api/log/self', '/api/status'])('preserves denied reads at %s without disclosing upstream messages', async (path) => {
    mockSource({ [path]: new Response('{"message":"log:read secret"}', { status: 403 }) })
    const result = await readAccountUsage(options())
    expect(result).toMatchObject({ ok: false, code: 'USAGE_ACCESS_REQUIRED' })
    expect(JSON.stringify(result)).not.toMatch(/log:read|secret/u)
    expect(result).not.toHaveProperty('payload')
  })

  it.each([
    { success: true, data: { quota_per_unit: 0, usd_exchange_rate: 7.3 } },
    { success: true, data: { quota_per_unit: 500_000 } },
  ])('does not guess conversion settings when status is unavailable: %j', async (status) => {
    mockSource({ '/api/status': status })
    expect(await readAccountUsage(options())).toMatchObject({ ok: false, code: 'USAGE_CONVERSION_UNAVAILABLE' })
  })

  it('uses changed status parameters immediately and does not require aggregate data export', async () => {
    mockSource({ '/api/status': { success: true, data: { enable_data_export: false, quota_per_unit: 2000, usd_exchange_rate: 8 } } })
    expect(await readAccountUsage(options())).toMatchObject({ ok: true, payload: { rows: [{ consumedPoints: 4 }] } })
  })

  it.each([
    { ...usage, created_at: end + 1 }, { ...usage, type: 6 }, { ...usage, prompt_tokens: -1 },
    { ...usage, completion_tokens: 0.5 }, { ...usage, quota: null }, { ...usage, model_name: null },
    { ...usage, user_id: 8 }, { ...usage, other: '{broken' }, { ...usage, other: '[]' },
    { ...usage, other: {} }, { ...usage, id: 2 },
  ])('rejects incomplete, foreign, or malformed log rows: %j', async (row) => {
    mockSource({ '/api/log/self': { success: true, data: { page: 1, page_size: 100, total: 1, items: [row] } } })
    const result = await readAccountUsage(options())
    expect(result).toMatchObject({ ok: false, code: 'USAGE_INVALID_DATA' })
    expect(result).not.toHaveProperty('payload')
  })

  it.each(['repeated-page', 'missing-row', 'changing-total', 'failed-second-page'])('refuses partial or unstable pagination: %s', async (mode) => {
    const first = Array.from({ length: 100 }, (_, index) => ({ ...usage, id: index + 1, request_id: `request-${String(index)}` }))
    mockSource({}, [], (page) => {
      if (page === 1) return { success: true, data: { page, page_size: 100, total: 101, items: first } }
      if (mode === 'failed-second-page') return { success: false }
      return { success: true, data: {
        page: mode === 'repeated-page' ? 1 : page, page_size: 100,
        total: mode === 'changing-total' ? 102 : 101,
        items: mode === 'missing-row' ? [] : [{ ...usage, id: 101, request_id: 'last-request' }],
      } }
    })
    const result = await readAccountUsage(options())
    expect(result).toMatchObject({ ok: false, code: mode === 'failed-second-page' ? 'USAGE_UNAVAILABLE' : 'USAGE_INVALID_DATA' })
    expect(result).not.toHaveProperty('payload')
  })
})


describe('usage failures and repeated request adjustments', () => {
  it('counts separate billing rows sharing the same request id, including across pages', async () => {
    const logs = Array.from({ length: 101 }, (_, index) => ({ ...usage, id: index + 1 }))
    mockSource({}, logs)
    expect(await readAccountUsage(options())).toMatchObject({ ok: true, payload: {
      rows: [{ billingRecords: 101, consumedPoints: 101 * 0.0146 }],
    } })
  })
  it.each([
    [401, 'SESSION_REQUIRED'], [403, 'USAGE_ACCESS_REQUIRED'], [429, 'USAGE_RATE_LIMITED'], [504, 'USAGE_TIMEOUT'],
  ])('preserves status and Retry-After for HTTP %s', async (status, code) => {
    mockSource({ '/api/user/self': new Response(null, { status, headers: { 'retry-after': '12' } }) })
    expect(await readAccountUsage(options())).toMatchObject({ ok: false, code, httpStatus: status, retryAfterSeconds: 12 })
  })
  it('reports a conversion transport failure as network rather than a missing rate', async () => {
    mockSource({ '/api/status': new Error('offline') })
    expect(await readAccountUsage(options())).toMatchObject({ ok: false, code: 'USAGE_NETWORK_ERROR' })
  })
})
