/** Account-scoped metadata reuse and bounded ordered transfers use only local fake responses. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaCatalogCache } from '../src/media-catalog-cache.ts'
import { transferMedia, readMediaBytes, MediaTransferLimitError } from '../src/media-transfer.ts'

const signal = (): AbortSignal => new AbortController().signal
const pricing = (headers: HeadersInit = { 'cache-control': 'private, max-age=30' }): Response => new Response(JSON.stringify({ data: [{ model: 'local-image' }] }), { headers })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { vi.restoreAllMocks() })

describe('media catalog freshness and login isolation', () => {
  it.each(['no-store', 'private, max-age=60, no-cache', 'no-cache="set-cookie"'])('never retains %s across calls', async (directive) => {
    const cache = new MediaCatalogCache(30_000)
    const request = vi.fn(async () => pricing({ 'cache-control': directive }))
    await cache.read('account-a/login-1', {}, request)
    await cache.read('account-a/login-1', {}, request)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('uses exact request headers, account and login epoch, and refuses Vary:* reuse', async () => {
    const cache = new MediaCatalogCache(30_000)
    const request = vi.fn(async () => pricing({ 'cache-control': 'private, max-age=30', vary: 'Accept-Language' }))
    await cache.read('account-a/login-1', { 'Accept-Language': 'zh' }, request)
    await cache.read('account-a/login-1', { 'accept-language': 'zh' }, request)
    expect(request).toHaveBeenCalledOnce()
    await cache.read('account-a/login-1', { 'Accept-Language': 'en' }, request)
    await cache.read('account-b/login-1', { 'Accept-Language': 'zh' }, request)
    await cache.read('account-a/login-2', { 'Accept-Language': 'zh' }, request)
    expect(request).toHaveBeenCalledTimes(4)
    const wildcard = vi.fn(async () => pricing({ 'cache-control': 'max-age=30', vary: '*' }))
    await cache.read('account-c', {}, wildcard)
    await cache.read('account-c', {}, wildcard)
    expect(wildcard).toHaveBeenCalledTimes(2)
  })

  it('includes network time and Age in the configured monotonic freshness budget', async () => {
    let elapsed = 100
    const cache = new MediaCatalogCache(30_000, () => elapsed)
    const request = vi.fn(async () => { elapsed += 500; return pricing({ 'cache-control': 'max-age=2', age: '1' }) })
    await cache.read('account', {}, request)
    vi.spyOn(Date, 'now').mockReturnValue(-1_000_000)
    elapsed = 1099
    await cache.read('account', {}, request)
    expect(request).toHaveBeenCalledOnce()
    elapsed = 1100
    await cache.read('account', {}, request)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('subtracts Age from Expires freshness even when max-age is absent', async () => {
    let elapsed = 0
    const cache = new MediaCatalogCache(30_000, () => elapsed)
    const request = vi.fn(async () => pricing({ date: 'Mon, 26 Oct 2026 12:00:00 GMT',
      expires: 'Mon, 26 Oct 2026 12:00:02 GMT', age: '1' }))
    await cache.read('account', {}, request)
    elapsed = 999
    await cache.read('account', {}, request)
    expect(request).toHaveBeenCalledOnce()
    elapsed = 1000
    await cache.read('account', {}, request)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('clearing a login prevents an in-flight old response from repopulating the next login cache', async () => {
    const cache = new MediaCatalogCache(30_000)
    const response = deferred<Response>()
    const pending = cache.read('old-login', {}, async () => await response.promise)
    cache.clear()
    response.resolve(pricing())
    await pending
    const request = vi.fn(async () => pricing())
    await cache.read('old-login', {}, request)
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not retain failed or malformed reads and honors cancellation for cached results', async () => {
    const cache = new MediaCatalogCache(30_000)
    await expect(cache.read('account', {}, async () => new Response('', { status: 429 }))).rejects.toMatchObject({ code: 'HTTP_429' })
    await expect(cache.read('account', {}, async () => new Response('{"data":null}'))).rejects.toMatchObject({ code: 'MODEL_CATALOG_INVALID' })
    const request = vi.fn(async () => pricing())
    await cache.read('account', {}, request)
    const cancelled = new AbortController(); cancelled.abort()
    await expect(cache.read('account', {}, request, cancelled.signal)).rejects.toThrow()
    expect(request).toHaveBeenCalledOnce()
  })
})

describe('bounded ordered media transfers', () => {
  it.each([2, 3])('bounds active transfers to %s and preserves input order despite reverse completion', async (concurrency) => {
    const gates = Array.from({ length: 6 }, () => deferred<undefined>())
    let active = 0
    let maximum = 0
    const started: number[] = []
    const complete = transferMedia([0, 1, 2, 3, 4, 5], concurrency, signal(), async (value, index) => {
      started.push(index); active += 1; maximum = Math.max(maximum, active)
      await gates[index]!.promise
      active -= 1
      return `file-${String(value)}`
    })
    expect(started).toHaveLength(concurrency)
    for (let index = gates.length - 1; index >= 0; index -= 1) gates[index]!.resolve(undefined)
    expect(await complete).toEqual(['file-0', 'file-1', 'file-2', 'file-3', 'file-4', 'file-5'])
    expect(maximum).toBe(concurrency)
  })

  it('aborts siblings and drains started work before rejecting so no dependent submission begins', async () => {
    const failed = deferred<undefined>()
    const drain = deferred<undefined>()
    const submit = vi.fn()
    const started: number[] = []
    let siblingAborted = false
    const transfers = transferMedia([0, 1, 2], 2, signal(), async (_value, index, shared) => {
      started.push(index)
      if (index === 0) { await failed.promise; throw new Error('upload failed') }
      shared.addEventListener('abort', () => { siblingAborted = true }, { once: true })
      await drain.promise
    })
    let settled = false
    const workflow = transfers.then(() => { submit() }, () => { settled = true })
    failed.resolve(undefined)
    await vi.waitFor(() => { expect(siblingAborted).toBe(true) })
    expect(settled).toBe(false)
    expect(started).toEqual([0, 1])
    drain.resolve(undefined)
    await workflow
    expect(settled).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects oversized declared or streamed media without returning partial bytes', async () => {
    await expect(readMediaBytes(new Response('12345', { headers: { 'content-length': '5' } }), 4, signal())).rejects.toBeInstanceOf(MediaTransferLimitError)
    await expect(readMediaBytes(new Response('12345'), 4, signal())).rejects.toBeInstanceOf(MediaTransferLimitError)
    expect(await readMediaBytes(new Response('1234'), 4, signal())).toEqual(Buffer.from('1234'))
  })

  it('cancels a blocked reader and drains its body on operation cancellation', async () => {
    const cancelled = vi.fn()
    const controller = new AbortController()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }))
    const reading = readMediaBytes(response, 32, controller.signal)
    controller.abort()
    await expect(reading).rejects.toThrow()
    expect(cancelled).toHaveBeenCalledOnce()
  })
})
