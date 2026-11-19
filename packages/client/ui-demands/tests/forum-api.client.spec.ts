/** Same-origin forum JSON transport with no bearer exposure or mutation retries. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestForum } from '../src/client/forum-api.ts'
const owner = { id: '1', owner: 'a'.repeat(64), epoch: 1 }
const input = () => ({ method: 'POST' as const, path: '/posts', body: '{"title":"Example"}', signal: new AbortController().signal })
afterEach(() => { vi.unstubAllGlobals() })
describe('forum Host transport', () => {
  it('dispatches once with account guards and an exact frozen JSON body', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true, payload: { example: true }, account: { id: owner.id }, accountOwner: owner.owner,
    }))); vi.stubGlobal('fetch', fetch)
    expect(await requestForum(owner, input())).toEqual({ ok: true, payload: { example: true } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('/credits/api/forum/posts')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ body: input().body, headers: {
      'x-yunshu-account-id': owner.id, 'x-yunshu-account-owner': owner.owner } })
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization')
  })
  it('refuses cross-owner or unbound success and preserves network uncertainty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, payload: {}, account: { id: '2' }, accountOwner: owner.owner,
    }))))
    expect(await requestForum(owner, input())).toMatchObject({ code: 'FORUM_ACCOUNT_CHANGED', unknown: true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: {} }))))
    expect(await requestForum(owner, input())).toMatchObject({ code: 'FORUM_PROTOCOL_INVALID', unknown: true })
    const fetch = vi.fn(async () => { throw new TypeError('Offline') }); vi.stubGlobal('fetch', fetch)
    expect(await requestForum(owner, input())).toMatchObject({ code: 'FORUM_NETWORK', unknown: true }); expect(fetch).toHaveBeenCalledOnce()
  })
  it('preserves known closed errors, JSON PUT semantics and refuses path escapes', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: false, code: 'FORUM_CLOSED', httpStatus: 403,
    }), { status: 403 })); vi.stubGlobal('fetch', fetch)
    expect(await requestForum(owner, { ...input(), method: 'PUT', path: '/posts/post-id/like', body: '{"liked":true}' }))
      .toEqual({ ok: false, code: 'FORUM_CLOSED', httpStatus: 403, unknown: false })
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT', body: '{"liked":true}' })
    expect(await requestForum(owner, { ...input(), path: '/../community-demands/orders' })).toMatchObject({ code: 'FORUM_INVALID_INPUT' })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('bounds actual UTF8 response bytes and cancels oversized streams', async () => {
    const cancel = vi.fn(), bytes = new Uint8Array(524_288).fill(32); let reads = 0
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      reads += 1; if (reads > 50) controller.close(); else controller.enqueue(bytes)
    }, cancel })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)))
    expect(await requestForum(owner, input())).toMatchObject({ code: 'FORUM_PROTOCOL_INVALID', unknown: true })
    expect(cancel).toHaveBeenCalledOnce(); expect(reads).toBeLessThan(50)
  })
})
