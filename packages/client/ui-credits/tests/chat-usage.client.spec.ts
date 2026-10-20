/** Host receipt decoding never substitutes model counters or leaks upstream errors. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readChatUsage, type ChatUsageQuery } from '../src/client/chat-usage.ts'

const requestPath = (value: RequestInfo | URL): string => typeof value === 'string' ? value : value instanceof URL ? value.href : value.url
const query: ChatUsageQuery = { sessionId: 'chat / a' as ChatUsageQuery['sessionId'], accountId: 'account-a', turn: 1 }
const response = (extra: Record<string, unknown> = {}) => ({ ok: true, payload: {
  scope: 'chat-model', accountId: 'account-a', status: 'settled', points: 0.123456,
  settledRequests: 2, totalRequests: 2, ...extra,
} })
afterEach(() => { vi.unstubAllGlobals() })

describe('chat model credit transport', () => {
  it('requests the exact session, turn and account without a token price calculation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()))
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    expect(await readChatUsage(query, controller.signal)).toEqual({
      accountId: 'account-a', status: 'settled', points: 0.123456, settledRequests: 2, totalRequests: 2,
    })
    const [path, init] = fetcher.mock.calls[0]!
    const url = new URL(requestPath(path), 'https://product.invalid')
    expect(url.pathname).toBe('/credits/api/chat-usage')
    expect(Object.fromEntries(url.searchParams)).toEqual({ session_id: 'chat / a', account_id: 'account-a', turn: '1' })
    expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
  })
  it('omits turn for the current conversation and accepts a genuine settled zero', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response({ points: 0 })))
    vi.stubGlobal('fetch', fetcher)
    expect(await readChatUsage({ sessionId: query.sessionId, accountId: query.accountId }, new AbortController().signal))
      .toMatchObject({ status: 'settled', points: 0 })
    expect(requestPath(fetcher.mock.calls[0]![0])).not.toContain('turn=')
  })
  it.each(['pending', 'unavailable'])('accepts %s without a synthetic zero', async (status) => {
    vi.stubGlobal('fetch', async () => Response.json(response({ status, points: undefined, settledRequests: 0 })))
    expect(await readChatUsage(query, new AbortController().signal)).toEqual({
      accountId: 'account-a', status, settledRequests: 0, totalRequests: 2,
    })
  })
  it.each([
    { scope: 'all' }, { accountId: 'account-b' }, { points: -1 }, { points: '1' }, { points: null },
    { points: Infinity }, { settledRequests: 1 }, { totalRequests: 0, settledRequests: 0 },
    { settledRequests: -1 }, { totalRequests: 1.5 }, { status: 'pending', points: 0 },
    { status: 'unknown' },
  ])('contains malformed receipt %j', async (extra) => {
    vi.stubGlobal('fetch', async () => Response.json(response(extra)))
    expect(await readChatUsage(query, new AbortController().signal)).toBeNull()
  })
  it.each([401, 403, 500])('contains HTTP %s and never exposes its diagnostic', async (status) => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'private upstream' }, { status }))
    expect(await readChatUsage(query, new AbortController().signal)).toBeNull()
  })
  it.each([null, [], { ok: false, code: 'ACCOUNT_CHANGED' }, { ok: true, payload: null }])('contains invalid envelope %j', async (value) => {
    vi.stubGlobal('fetch', async () => Response.json(value))
    expect(await readChatUsage(query, new AbortController().signal)).toBeNull()
  })
  it('contains a failed body and cancellation while decoding', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => { controller.abort(); return response() } }))
    expect(await readChatUsage(query, controller.signal)).toBeNull()
    vi.stubGlobal('fetch', async () => { throw new Error('private upstream') })
    expect(await readChatUsage(query, new AbortController().signal)).toBeNull()
  })
})
