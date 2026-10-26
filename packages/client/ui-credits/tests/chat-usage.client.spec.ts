/** Host receipt decoding never substitutes model counters or leaks upstream errors. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readChatUsage, type ChatUsageQuery } from '../src/client/chat-usage.ts'

const requestPath = (value: RequestInfo | URL): string => typeof value === 'string' ? value : value instanceof URL ? value.href : value.url
const query: ChatUsageQuery = { sessionId: 'chat / a' as ChatUsageQuery['sessionId'], accountId: 'account-a', turn: 1 }
const response = (extra: Record<string, unknown> = {}) => ({ ok: true, payload: {
  scope: 'chat-model', accountId: 'account-a', status: 'settled', points: 0.123456,
  settledRequests: 2, totalRequests: 2, ...extra,
} })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('chat model credit transport', () => {
  it('requests the exact session, turn and account without a token price calculation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()))
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    expect(await readChatUsage(query, controller.signal)).toEqual({
      ok: true,
      usage: { accountId: 'account-a', status: 'settled', points: 0.123456, settledRequests: 2, totalRequests: 2 },
    })
    const [path, init] = fetcher.mock.calls[0]!
    const url = new URL(requestPath(path), 'https://product.invalid')
    expect(url.pathname).toBe('/credits/api/chat-usage')
    expect(Object.fromEntries(url.searchParams)).toEqual({ session_id: 'chat / a', account_id: 'account-a', turn: '1' })
    expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
  })
  it('preserves consumption-log amount fields without claiming a known refund or final settlement', async () => {
    vi.stubGlobal('fetch', async () => Response.json(response({
      amountBasis: 'consumption-logs', settlementStatus: 'unknown', refundStatus: 'unknown',
    })))
    expect(await readChatUsage(query, new AbortController().signal)).toMatchObject({ ok: true, usage: {
      status: 'settled', points: 0.123456, amountBasis: 'consumption-logs', settlementStatus: 'unknown', refundStatus: 'unknown',
    } })
  })
  it('omits turn for the current conversation and accepts a genuine settled zero', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response({ points: 0 })))
    vi.stubGlobal('fetch', fetcher)
    expect(await readChatUsage({ sessionId: query.sessionId, accountId: query.accountId }, new AbortController().signal))
      .toMatchObject({ ok: true, usage: { status: 'settled', points: 0 } })
    expect(requestPath(fetcher.mock.calls[0]![0])).not.toContain('turn=')
  })
  it.each(['pending', 'unavailable'])('accepts %s without a synthetic zero', async (status) => {
    vi.stubGlobal('fetch', async () => Response.json(response({ status, points: undefined, settledRequests: 0 })))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({
      ok: true, usage: { accountId: 'account-a', status, settledRequests: 0, totalRequests: 2 },
    })
  })
  it.each([
    { scope: 'all' }, { accountId: undefined }, { accountId: 1 }, { points: -1 }, { points: '1' }, { points: null },
    { points: Infinity }, { settledRequests: 1 }, { totalRequests: 0, settledRequests: 0 },
    { settledRequests: -1 }, { totalRequests: 1.5 }, { status: 'pending', points: 0 },
    { status: 'unknown' }, { status: 'unavailable', points: 0 },
  ])('contains malformed receipt %j', async (extra) => {
    vi.stubGlobal('fetch', async () => Response.json(response(extra)))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({ ok: false, reason: 'unavailable' })
  })
  it.each([401, 403])('invalidates authorization for HTTP %s without exposing its body', async (status) => {
    vi.stubGlobal('fetch', async () => new Response('private upstream secret', { status }))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({ ok: false, reason: 'authorization' })
  })
  it('classifies rate limiting without decoding or exposing the response body', async () => {
    vi.stubGlobal('fetch', async () => new Response('private upstream secret', { status: 429 }))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({ ok: false, reason: 'rate-limited' })
  })
  it.each(['ACCOUNT_CHANGED', 'SESSION_REQUIRED', 'CHAT_USAGE_ACCESS_DENIED', 'CHAT_USAGE_IDENTITY_MISMATCH'])('invalidates authorization for safe body code %s', async (code) => {
    vi.stubGlobal('fetch', async () => Response.json({ ok: false, code, message: 'private upstream secret' }))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({ ok: false, reason: 'authorization' })
  })
  it('recognizes a safe identity rejection on a non-success HTTP response', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ ok: false, code: 'ACCOUNT_CHANGED' }, { status: 409 }))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({ ok: false, reason: 'authorization' })
  })
  it('invalidates authorization when the receipt belongs to a different account', async () => {
    vi.stubGlobal('fetch', async () => Response.json(response({ accountId: 'account-b' })))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({ ok: false, reason: 'authorization' })
  })
  it.each([400, 500, 503])('contains HTTP %s and never exposes its diagnostic', async (status) => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'private upstream' }, { status }))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({ ok: false, reason: 'unavailable' })
  })
  it.each([null, [], { ok: false, code: 'UPSTREAM_PRIVATE_FAILURE' }, { ok: true, payload: null }])('contains invalid envelope %j', async (value) => {
    vi.stubGlobal('fetch', async () => Response.json(value))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({ ok: false, reason: 'unavailable' })
  })
  it('contains a malformed JSON body', async () => {
    vi.stubGlobal('fetch', async () => new Response('private malformed body'))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({ ok: false, reason: 'unavailable' })
  })
  it('avoids starting an already cancelled read', async () => {
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    controller.abort()
    expect(await readChatUsage(query, controller.signal)).toEqual({ ok: false, reason: 'unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('contains cancellation while awaiting the response', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', async () => { controller.abort(); return Response.json(response()) })
    expect(await readChatUsage(query, controller.signal)).toEqual({ ok: false, reason: 'unavailable' })
  })
  it('contains cancellation while decoding and a rejected network read', async () => {
    const controller = new AbortController()
    const reply = Response.json(null)
    vi.spyOn(reply, 'json').mockImplementation(async () => { controller.abort(); return response() })
    vi.stubGlobal('fetch', async () => reply)
    expect(await readChatUsage(query, controller.signal)).toEqual({ ok: false, reason: 'unavailable' })
    vi.stubGlobal('fetch', async () => { throw new Error('private upstream') })
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({ ok: false, reason: 'unavailable' })
  })
})
