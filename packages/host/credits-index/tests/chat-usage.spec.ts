/** Chat charges use exact own-account ledger rows, never token estimates or balance deltas. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq, snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import { ChatUsageLedger, deriveChatUsageRequests, readChatUsage, type ChatUsageReadOptions } from '../src/chat-usage.ts'

afterEach(() => { vi.unstubAllGlobals() })
const endpoint = 'https://8.133.202.230/harness'
const request = { apiBaseUrl: `${endpoint}/v1`, requestId: ProviderRequestId('gateway-request') }
const options = (): ChatUsageReadOptions => ({
  baseUrl: endpoint, timeoutMs: 500, account: { id: '7' }, upstreamToken: 'user-token',
  selection: { requests: [request], complete: true },
})

function attempt(requestId: string | undefined, seq = 1, apiBaseUrl = `${endpoint}/v1`): SessionEvent<'assistant/attempt'> {
  return { seq: SessionSeq(seq), time: seq, type: 'assistant/attempt', data: { turn: 1, step: seq, stream: [
    { type: 'chunk', time: seq, chunk: {
      type: 'finish', reason: { kind: 'error', failure: { message: 'transport ended', code: 'TRANSPORT' } },
      ...requestId === undefined ? {} : { replayState: { response: {
        gatewayReceipt: { kind: 'oneapi', version: 1, apiBaseUrl, requestId },
      } } },
    } },
  ] } }
}

function source(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    calls.push(url.href)
    expect(url.pathname.startsWith('/harness/')).toBe(true)
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const path = url.pathname.slice('/harness'.length)
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(path === '/api/status' ? null : 'Bearer user-token')
    let body: unknown = path === '/api/user/self' ? { success: true, data: { id: 7 } }
      : path === '/api/status' ? { success: true, data: { quota_per_unit: 500000, usd_exchange_rate: 7.3 } }
        : { success: true, data: { page: 1, page_size: 100, total: 1, items: [
          { user_id: 7, type: 2, request_id: url.searchParams.get('request_id'), quota: 100 },
        ] } }
    if (path in overrides) body = overrides[path]
    if (body instanceof Error) throw body
    return body instanceof Response ? body : new Response(JSON.stringify(body))
  })
  vi.stubGlobal('fetch', fetcher)
  return { calls, fetcher }
}

describe('durable gateway billing correlation', () => {
  it('retains failed/charged attempts and deduplicates copied receipts', () => {
    expect(deriveChatUsageRequests([attempt('one'), attempt('one', 2), attempt('two', 3)]))
      .toEqual({ complete: true, requests: [{ ...request, requestId: 'one' }, { ...request, requestId: 'two' }] })
  })
  it('preserves optional opaque receipt metadata through the current Session reader', () => {
    const original = attempt('retained-request')
    const persisted = snapshotSessionEvent(original)
    expect(JSON.parse(JSON.stringify(persisted))).toEqual(original)
    expect(deriveChatUsageRequests([persisted])).toMatchInlineSnapshot(`
      {
        "complete": true,
        "requests": [
          {
            "apiBaseUrl": "https://8.133.202.230/harness/v1",
            "requestId": "retained-request",
          },
        ],
      }
    `)
  })
  it('does not declare a partial subset complete when history has missing receipts', () => {
    expect(deriveChatUsageRequests([attempt('one'), attempt(undefined, 2)]).complete).toBe(false)
    expect(deriveChatUsageRequests([])).toEqual({ complete: false, requests: [] })
  })
  it.each(['https://user:secret@other.test/v1', 'https://other.test/v1?api_key=secret', 'https://other.test/v1#secret'])(
    'does not copy unsafe endpoint metadata into the billing projection: %s', (endpoint) => {
      expect(deriveChatUsageRequests([attempt('one', 1, endpoint)])).toEqual({ complete: false, requests: [] })
    },
  )
})

describe('exact-request settled chat points', () => {
  it('starts only the configured receipt reads and deduplicates an overlapping caller', async () => {
    const ledger = new ChatUsageLedger({ ttlMs: 5000, concurrency: 2 })
    const held = Promise.withResolvers<{ ok: true; quota: number }>()
    const started: string[] = []
    const run = (id: string) => ledger.read(id, () => {
      started.push(id)
      return id === 'one' || id === 'two' ? held.promise : Promise.resolve({ ok: true, quota: 100 })
    })
    const results = ['one', 'two', 'three', 'four', 'five', 'six'].map(run)
    const duplicate = run('one')
    expect(started).toEqual(['one', 'two'])
    held.resolve({ ok: true, quota: 100 })
    expect(await Promise.all([...results, duplicate])).toEqual(Array.from({ length: 7 }, () => ({ ok: true, quota: 100 })))
    expect(started).toEqual(['one', 'two', 'three', 'four', 'five', 'six'])
  })

  it('reads the current account and exact gateway id with live conversion', async () => {
    const { calls } = source()
    expect(await readChatUsage(options())).toEqual({ ok: true, payload: {
      scope: 'chat-model', status: 'settled', points: 1.46, settledRequests: 1, totalRequests: 1,
    } })
    const log = new URL(calls[2] ?? '')
    expect(Object.fromEntries(log.searchParams)).toEqual({ request_id: 'gateway-request', type: '2', p: '1', page_size: '100' })
    expect(calls).toHaveLength(3)
  })
  it('uses a changed live rate without a model price or token count', async () => {
    source({ '/api/status': { success: true, data: { quota_per_unit: 2000, usd_exchange_rate: 8 } } })
    expect(await readChatUsage(options())).toMatchObject({ ok: true, payload: { points: 400, status: 'settled' } })
  })
  it('preserves a settled zero only when an actual zero-quota billing record exists', async () => {
    source({ '/api/log/self': { success: true, data: { page: 1, page_size: 100, total: 1, items: [
      { user_id: 7, type: 2, request_id: request.requestId, quota: 0 },
    ] } } })
    expect(await readChatUsage(options())).toMatchObject({ ok: true, payload: { points: 0, status: 'settled' } })
  })
  it('keeps delayed settlement pending without presenting a fabricated zero', async () => {
    source({ '/api/log/self': { success: true, data: { page: 1, page_size: 100, total: 0, items: [] } } })
    expect(await readChatUsage(options())).toEqual({ ok: true, payload: {
      scope: 'chat-model', status: 'pending', settledRequests: 0, totalRequests: 1,
    } })
  })
  it.each([
    { user_id: 8, type: 2, request_id: request.requestId, quota: 100 },
    { user_id: 7, type: 2, request_id: 'unrelated', quota: 100 },
    { user_id: 7, type: 5, request_id: request.requestId, quota: 100 },
    { user_id: 7, type: 2, request_id: request.requestId, quota: -1 },
  ])('refuses untrusted rows rather than counting another account or request: %j', async (row) => {
    source({ '/api/log/self': { success: true, data: { page: 1, page_size: 100, total: 1, items: [row] } } })
    expect(await readChatUsage(options())).toEqual({ ok: false, code: 'CHAT_USAGE_INVALID_DATA' })
  })
  it('rejects a switched account before reading any billing rows', async () => {
    const { calls } = source({ '/api/user/self': { success: true, data: { id: 8 } } })
    expect(await readChatUsage(options())).toEqual({ ok: false, code: 'CHAT_USAGE_IDENTITY_MISMATCH' })
    expect(calls).toHaveLength(1)
  })
  it('never follows an endpoint from a persisted receipt or calls a paid model', async () => {
    const { calls } = source()
    expect(await readChatUsage({ ...options(), selection: { complete: true, requests: [{ ...request, apiBaseUrl: 'https://other.test/v1' }] } }))
      .toMatchObject({ ok: true, payload: { status: 'unavailable' } })
    expect(calls).toEqual([])
  })
  it('does not invent historical billing evidence', async () => {
    const { calls } = source()
    expect(await readChatUsage({ ...options(), selection: { complete: false, requests: [request] } }))
      .toMatchObject({ ok: true, payload: { status: 'unavailable' } })
    expect(calls).toEqual([])
  })
  it('fails closed when live conversion is missing', async () => {
    source({ '/api/status': { success: true, data: {} } })
    expect(await readChatUsage(options())).toEqual({ ok: false, code: 'CHAT_USAGE_CONVERSION_UNAVAILABLE' })
  })
  it('contains denied access and diagnostic text', async () => {
    source({ '/api/log/self': new Response('upstream secret error', { status: 403 }) })
    expect(await readChatUsage(options())).toEqual({ ok: false, code: 'CHAT_USAGE_ACCESS_DENIED' })
  })
})
