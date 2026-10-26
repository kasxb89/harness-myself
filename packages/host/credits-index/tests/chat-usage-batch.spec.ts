/** Read-only receipt batches retain observed-log semantics and bounded legacy compatibility. */
import { describe, expect, it, vi } from 'vitest'
import { ProviderRequestId } from '@deepseek-ai/dsh-llm'
import { AccountReadScheduler, type AccountReadRequest } from '../src/account-read.ts'
import { ChatUsageLedger, readChatUsage } from '../src/chat-usage.ts'
import { chatUsageBatches, parseChatUsageBatch, parseChatUsageBatchCapability } from '../src/chat-usage-batch.ts'

const endpoint = 'https://fixture.test/harness'
const declaration = { schema_version: 1, batch_path: '/api/log/self/batch', method: 'POST', max_request_ids: 100,
  max_body_bytes: 16_384, max_consume_logs: 1000, refund_state: false, final_settlement_state: false }
const capability = { maxRequestIds: 100, maxBodyBytes: 16_384, maxConsumeLogs: 1000 }
const log = (requestId: string, quota = 100) => ({ request_id: requestId, model_name: 'model', quota,
  prompt_tokens: 12, completion_tokens: 34, created_at: 1793000000, use_time: 2 })
const response = (ids: readonly string[], missing = false) => ({ success: true, data: {
  schema_version: 1, lookup_window_start_unix: 0, items: ids.map(id => ({ request_id: id,
    status: missing ? 'not_found' : 'found', consume_logs: missing ? [] : [log(id), log(id, 50)],
    refund_status: 'unknown', settlement_status: 'unknown' })),
} })
const options = (ids: readonly string[], request: AccountReadRequest) => ({ baseUrl: endpoint, timeoutMs: 500,
  identity: 'owner-7-epoch-1', account: { id: '7' }, upstreamToken: 'fixture-access', request,
  selection: { complete: true, requests: ids.map(id => ({ requestId: ProviderRequestId(id), apiBaseUrl: `${endpoint}/v1` })) } })

describe('receipt capability and complete response validation', () => {
  it('enables only the fixed supported v1 route and packs by encoded JSON bytes', () => {
    expect(parseChatUsageBatchCapability(declaration)).toEqual(capability)
    for (const invalid of [undefined, { ...declaration, schema_version: 2 }, { ...declaration, method: 'GET' },
      { ...declaration, batch_path: 'https://other.test/batch' }, { ...declaration, max_request_ids: 101 }]) {
      expect(parseChatUsageBatchCapability(invalid)).toBeUndefined()
    }
    const limits = { ...capability, maxBodyBytes: Buffer.byteLength(JSON.stringify({ request_ids: ['参考一'] })) }
    const batches = chatUsageBatches(['参考一', '参考二'], limits)
    expect(batches).toEqual([['参考一'], ['参考二']])
    expect(batches.every(ids => Buffer.byteLength(JSON.stringify({ request_ids: ids })) <= limits.maxBodyBytes)).toBe(true)
    expect(() => chatUsageBatches([' padded '], capability)).toThrow()
    expect(() => chatUsageBatches(['x'.repeat(65)], capability)).toThrow()
  })
  it('sums multiple consumption records while rejecting duplicate, unrelated and incomplete results', () => {
    expect(parseChatUsageBatch(response(['one']), ['one'], capability).get('one')).toBe(150)
    expect(parseChatUsageBatch(response(['one'], true), ['one'], capability).has('one')).toBe(true)
    expect(parseChatUsageBatch(response(['one'], true), ['one'], capability).get('one')).toBeUndefined()
    for (const malformed of [response(['other']), response([]), response(['one', 'one']),
      { success: true, data: { ...response(['one']).data, schema_version: 2 } }]) {
      expect(() => parseChatUsageBatch(malformed, ['one'], capability)).toThrow()
    }
    expect(() => parseChatUsageBatch(response(['one']), ['one'], { ...capability, maxConsumeLogs: 1 })).toThrow()
  })
})

describe('capability-gated receipt reads', () => {
  it('reads 500 receipts in five bounded batches then reuses all successful receipts after context expiration', async () => {
    let now = 0
    const ledger = new ChatUsageLedger({ ttlMs: 5000, concurrency: 2, now: () => now })
    const batches: string[][] = []
    let contexts = 0
    const request: AccountReadRequest = async (path, authenticated, _signal, body) => {
      if (path === '/api/user/self') { contexts++; return Response.json({ success: true, data: { id: 7 } }) }
      if (path === '/api/status') return Response.json({ success: true,
        data: { quota_per_unit: 500000, usd_exchange_rate: 7.3, usage_receipts: declaration } })
      expect(path).toBe('/api/log/self/batch')
      expect(authenticated).toBe(true)
      const parsed = JSON.parse(body ?? '{}') as { request_ids: string[] }
      expect(Object.keys(parsed)).toEqual(['request_ids'])
      expect(parsed.request_ids.length).toBeLessThanOrEqual(100)
      expect(Buffer.byteLength(body ?? '')).toBeLessThanOrEqual(16_384)
      batches.push(parsed.request_ids)
      return Response.json(response(parsed.request_ids))
    }
    const input = { ...options(Array.from({ length: 500 }, (_, index) => `receipt-${String(index)}`), request), ledger }
    expect(await readChatUsage(input)).toMatchObject({ ok: true, payload: { status: 'settled', settledRequests: 500,
      points: expect.closeTo(1095) as number, amountBasis: 'consumption-logs', settlementStatus: 'unknown', refundStatus: 'unknown' } })
    expect(batches).toHaveLength(5)
    now = 6000
    expect(await readChatUsage(input)).toMatchObject({ ok: true, payload: { settledRequests: 500 } })
    expect(contexts).toBe(2)
    expect(batches).toHaveLength(5)
    ledger.clear()
    expect(await readChatUsage({ ...input, identity: 'owner-7-epoch-2' })).toMatchObject({ ok: true })
    expect(batches).toHaveLength(10)
  })
  it('keeps not-found unknown without presenting zero, pending settlement or a final charge', async () => {
    const request: AccountReadRequest = async path => Response.json(path === '/api/user/self'
      ? { success: true, data: { id: 7 } } : path === '/api/status'
        ? { success: true, data: { quota_per_unit: 500000, usd_exchange_rate: 7.3, usage_receipts: declaration } }
        : response(['one'], true))
    expect(await readChatUsage(options(['one'], request))).toEqual({ ok: true, payload: {
      scope: 'chat-model', status: 'unavailable', settledRequests: 0, totalRequests: 1,
      amountBasis: 'consumption-logs', refundStatus: 'unknown', settlementStatus: 'unknown',
    } })
  })
  it('does not fan out legacy GETs after a rejected batch and shares its 429 with other account reads', async () => {
    const paths: string[] = []
    const scheduler = new AccountReadScheduler({ concurrency: 2, minIntervalMs: 0, failureCooldownMs: 1000 })
    const request: AccountReadRequest = async (path) => {
      paths.push(path)
      return path === '/api/user/self' ? Response.json({ success: true, data: { id: 7 } }) : path === '/api/status'
        ? Response.json({ success: true, data: { quota_per_unit: 500000, usd_exchange_rate: 7.3, usage_receipts: declaration } })
        : new Response(null, { status: 429, headers: { 'retry-after': '45' } })
    }
    const input = { ...options(['one', 'two'], request), scheduler }
    expect(await readChatUsage(input)).toMatchObject({ ok: false, code: 'CHAT_USAGE_RATE_LIMITED',
      httpStatus: 429, retryAfterSeconds: 45 })
    await expect(scheduler.read({ scope: input.identity, path: '/api/user/self', authenticated: true,
      signal: new AbortController().signal, request })).rejects.toMatchObject({ reason: 'rate_limited', httpStatus: 429 })
    expect(paths).toEqual(['/api/user/self', '/api/status', '/api/log/self/batch'])
    await scheduler.dispose()
  })
  it('coalesces overlapping batch ids, cancels queued admission and discards reset outcomes', async () => {
    const ledger = new ChatUsageLedger({ ttlMs: 5000, concurrency: 1 })
    const held = Promise.withResolvers<readonly { ok: true; quota: number }[]>()
    const read = vi.fn(async () => await held.promise)
    const signal = new AbortController().signal
    const first = ledger.readBatch(['one', 'two'], read, signal)
    const overlap = ledger.readBatch(['one', 'two'], read, signal)
    const cancelled = new AbortController()
    const queued = ledger.readBatch(['three'], read, cancelled.signal).catch((error: unknown) => error)
    cancelled.abort()
    expect(await queued).toMatchObject({ reason: 'cancelled' })
    held.resolve([{ ok: true, quota: 1 }, { ok: true, quota: 2 }])
    expect(await first).toEqual(await overlap)
    expect(read).toHaveBeenCalledTimes(1)
    ledger.clear()
    expect(await ledger.readBatch(['one'], async () => [{ ok: true, quota: 9 }], signal)).toEqual([{ ok: true, quota: 9 }])
  })
})
