/** Account GET admission, error facts and clock-independent shared cooldowns. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountReadError, AccountReadScheduler, accountRetryAfter, readAccountResponse } from '../src/account-read.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const signal = () => new AbortController().signal
const body = () => Response.json({ success: true, data: { id: 7 } })

describe('account GET reads', () => {
  it.each([401, 403, 429, 503])('retains HTTP %s without leaking its response body', async (status) => {
    await expect(readAccountResponse(async () => new Response('private upstream diagnostic', {
      status, headers: { 'retry-after': '12' },
    }), '/api/user/self', true, signal())).rejects.toMatchObject({
      name: 'AccountReadError', httpStatus: status, retryAfterSeconds: 12,
    })
  })
  it('keeps network, timeout and malformed JSON distinct', async () => {
    await expect(readAccountResponse(async () => { throw new TypeError('offline') }, '/api/user/self', true, signal()))
      .rejects.toMatchObject({ reason: 'network' })
    await expect(readAccountResponse(async () => { throw new DOMException('deadline', 'TimeoutError') }, '/api/user/self', true, signal()))
      .rejects.toMatchObject({ reason: 'timeout' })
    await expect(readAccountResponse(async () => new Response('{invalid'), '/api/user/self', true, signal()))
      .rejects.toMatchObject({ reason: 'protocol', httpStatus: 200 })
  })
  it('anchors HTTP-date Retry-After to the server clock despite a local rollback', () => {
    const headers = new Headers({ date: 'Mon, 26 Oct 2026 10:00:00 GMT', 'retry-after': 'Mon, 26 Oct 2026 10:00:45 GMT' })
    expect(accountRetryAfter(headers, 1)).toBe(45)
    expect(accountRetryAfter(new Headers({ 'retry-after': '17' }), 1)).toBe(17)
  })
})

describe('shared account GET scheduler', () => {
  it('isolates read-only batch bodies and refuses POSTs outside the authenticated fixed receipt route', async () => {
    const scheduler = new AccountReadScheduler({ concurrency: 2, minIntervalMs: 0, failureCooldownMs: 1000 })
    const held = Promise.withResolvers<Response>()
    const request = vi.fn(async (_path: string, _authenticated: boolean, _signal: AbortSignal, encoded?: string) => {
      expect(encoded).toBeDefined()
      return encoded === 'one' ? await held.promise : body()
    })
    const input = { scope: 'owner', path: '/api/log/self/batch', authenticated: true, signal: signal(), request }
    const first = scheduler.read({ ...input, body: 'one' })
    const second = scheduler.read({ ...input, body: 'two' })
    const sameSecond = scheduler.read({ ...input, body: 'two' })
    await Promise.all([second, sameSecond])
    held.resolve(body())
    await first
    expect(request).toHaveBeenCalledTimes(2)
    await expect(readAccountResponse(request, '/api/other', true, signal(), '{}')).rejects.toMatchObject({ reason: 'protocol' })
    await expect(readAccountResponse(request, input.path, false, signal(), '{}')).rejects.toMatchObject({ reason: 'protocol' })
    expect(request).toHaveBeenCalledTimes(2)
    await scheduler.dispose()
  })

  it('coalesces one receipt while cancellation only detaches that observer', async () => {
    const scheduler = new AccountReadScheduler({ concurrency: 2, minIntervalMs: 0, failureCooldownMs: 1000 })
    const held = Promise.withResolvers<Response>()
    const request = vi.fn(async () => await held.promise)
    const first = new AbortController()
    const input = { scope: 'login-a', path: '/api/log/self?request_id=one', authenticated: true, request }
    const a = scheduler.read({ ...input, signal: first.signal }).catch((error: unknown) => error)
    const b = scheduler.read({ ...input, signal: signal() })
    first.abort()
    expect(await a).toBeInstanceOf(AccountReadError)
    held.resolve(body())
    expect((await b).status).toBe(200)
    expect(request).toHaveBeenCalledTimes(1)
    await scheduler.dispose()
  })
  it('cancels a queued read without starting it and lets another login proceed', async () => {
    const scheduler = new AccountReadScheduler({ concurrency: 1, minIntervalMs: 0, failureCooldownMs: 1000 })
    const held = Promise.withResolvers<Response>()
    const request = vi.fn(async () => await held.promise)
    const first = scheduler.read({ scope: 'old', path: '/self', authenticated: true, signal: signal(), request })
    const cancel = new AbortController()
    const queued = scheduler.read({ scope: 'old', path: '/logs', authenticated: true, signal: cancel.signal, request }).catch((error: unknown) => error)
    cancel.abort()
    expect(await queued).toMatchObject({ reason: 'cancelled' })
    held.resolve(body())
    await first
    expect(request).toHaveBeenCalledTimes(1)
    expect((await scheduler.read({ scope: 'new', path: '/self', authenticated: true, signal: signal(), request: async () => body() })).status).toBe(200)
    await scheduler.dispose()
  })
  it('paces distinct reads and shares a server 429 cooldown across routes', async () => {
    vi.useFakeTimers()
    let mono = 0
    const scheduler = new AccountReadScheduler({ concurrency: 2, minIntervalMs: 750, failureCooldownMs: 1000, now: () => mono })
    const calls: number[] = []
    const request = vi.fn(async () => {
      calls.push(mono)
      return calls.length === 2 ? new Response(null, { status: 429, headers: { 'retry-after': '30' } }) : body()
    })
    await scheduler.read({ scope: 'owner', path: '/one', authenticated: true, signal: signal(), request })
    const second = scheduler.read({ scope: 'owner', path: '/two', authenticated: true, signal: signal(), request }).catch((error: unknown) => error)
    expect(calls).toEqual([0])
    mono = 750
    await vi.advanceTimersByTimeAsync(750)
    expect(await second).toMatchObject({ reason: 'rate_limited', retryAfterSeconds: 30 })
    vi.spyOn(Date, 'now').mockReturnValue(1)
    await expect(scheduler.read({ scope: 'owner', path: '/other-route', authenticated: true, signal: signal(), request }))
      .rejects.toMatchObject({ reason: 'rate_limited', httpStatus: 429, retryAfterSeconds: 30 })
    expect(calls).toEqual([0, 750])
    expect((await scheduler.read({ scope: 'different-login', path: '/one', authenticated: true, signal: signal(), request })).status).toBe(200)
    mono = 30_750
    expect((await scheduler.read({ scope: 'owner', path: '/three', authenticated: true, signal: signal(), request })).status).toBe(200)
    await scheduler.dispose()
  })
  it('reset rejects queued old-login work without repopulating its cooldown', async () => {
    const scheduler = new AccountReadScheduler({ concurrency: 1, minIntervalMs: 0, failureCooldownMs: 1000 })
    const held = Promise.withResolvers<Response>()
    const old = scheduler.read({ scope: 'old', path: '/self', authenticated: true, signal: signal(), request: async () => await held.promise }).catch((error: unknown) => error)
    const queuedRequest = vi.fn(async () => body())
    const queued = scheduler.read({ scope: 'old', path: '/logs', authenticated: true, signal: signal(), request: queuedRequest }).catch((error: unknown) => error)
    scheduler.reset()
    expect(await queued).toMatchObject({ reason: 'cancelled' })
    held.resolve(new Response(null, { status: 429, headers: { 'retry-after': '60' } }))
    await old
    expect(queuedRequest).not.toHaveBeenCalled()
    expect((await scheduler.read({ scope: 'old', path: '/self', authenticated: true, signal: signal(), request: async () => body() })).status).toBe(200)
    await scheduler.dispose()
  })
})
