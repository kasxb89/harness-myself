/** Local Host transport refuses foreign owners, protocol failures and route escapes without retrying. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { communityContentUrl, requestCommunity } from '../src/client/community-api.ts'
const owner = { id: '1', owner: 'a'.repeat(64), epoch: 1 }
const request = () => ({ method: 'POST' as const, path: '/orders', body: '{"example":true}', signal: new AbortController().signal })
afterEach(() => { vi.unstubAllGlobals() })
describe('community Host transport', () => {
  it('sends exactly once with owner guards and no browser bearer', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true, payload: { example: true }, account: { id: owner.id }, accountOwner: owner.owner,
    })))
    vi.stubGlobal('fetch', fetch)
    expect(await requestCommunity(owner, request())).toEqual({ ok: true, payload: { example: true } })
    expect(fetch).toHaveBeenCalledTimes(1)
    const args = fetch.mock.calls[0]
    expect(args?.[0]).toBe('/credits/api/community-demands/orders')
    expect(args?.[1]?.headers).toMatchObject({ 'x-yunshu-account-id': owner.id, 'x-yunshu-account-owner': owner.owner })
    expect(args?.[1]?.headers).not.toHaveProperty('authorization')
    expect(communityContentUrl(owner, 'example-image')).toContain('/credits/api/community-demands/attachments/example-image/content?account_id=1')
    expect(communityContentUrl(owner, 'example-image')).not.toContain('token=')
  })
  it('rejects wrong-owner success and keeps malformed JSON distinct from network loss', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: {}, account: { id: '2' }, accountOwner: owner.owner }))))
    expect(await requestCommunity(owner, request())).toMatchObject({ ok: false, code: 'COMMUNITY_ACCOUNT_CHANGED', unknown: true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid json', { status: 502 })))
    expect(await requestCommunity(owner, request())).toMatchObject({ ok: false, code: 'COMMUNITY_PROTOCOL_INVALID', unknown: true })
    const fetch = vi.fn(async () => { throw new TypeError('offline') }); vi.stubGlobal('fetch', fetch)
    expect(await requestCommunity(owner, request())).toMatchObject({ ok: false, code: 'COMMUNITY_NETWORK', unknown: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves known business failures and never allows an escaped local path', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, code: 'COMMUNITY_SELF_ACCEPT_FORBIDDEN', httpStatus: 403 }), { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    expect(await requestCommunity(owner, request())).toEqual({ ok: false, code: 'COMMUNITY_SELF_ACCEPT_FORBIDDEN', httpStatus: 403, unknown: false })
    expect(await requestCommunity(owner, { ...request(), path: '/../demands/orders' })).toMatchObject({ code: 'COMMUNITY_INVALID_INPUT' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('accepts legal large Unicode pages within eight MiB of actual UTF8 bytes', async () => {
    const large = '😀'.repeat(1_200_000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, payload: { large }, account: { id: owner.id }, accountOwner: owner.owner,
    }))))
    const result = await requestCommunity(owner, { ...request(), method: 'GET', path: '/orders/community-order/messages' })
    expect(result).toEqual({ ok: true, payload: { large } })
  })
  it('cancels an oversized UTF8 stream before reading the whole response', async () => {
    let reads = 0
    const cancel = vi.fn(), part = new Uint8Array(524_288).fill(32)
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      reads += 1
      if (reads > 50) controller.close()
      else controller.enqueue(part)
    }, cancel })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)))
    expect(await requestCommunity(owner, request())).toMatchObject({ ok: false, code: 'COMMUNITY_PROTOCOL_INVALID', unknown: true })
    expect(cancel).toHaveBeenCalledOnce(); expect(reads).toBeLessThan(50)
  })

})
