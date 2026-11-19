import { createServer } from 'node:http'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createForumProxy, type ForumProxyOptions } from '../src/forum-proxy.ts'
import { demandObject } from '../src/demand-protocol.ts'
import type { DemandAccount } from '../src/demand-proxy.ts'

const owner = 'a'.repeat(64), accountId = '42'
const postId = '11111111-1111-4111-8111-111111111111', commentId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const body = { client_request_id: operationId, title: '论坛帖子', body: '原始正文' }
function post(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: postId, title: body.title, body: body.body, author: { id: 42, display_name: '本地论坛用户' },
    created_at: 1, like_count: 0, comment_count: 0, liked: false, ...overrides }
}
async function host(overrides: Partial<ForumProxyOptions> = {}) {
  const send = vi.fn<DemandAccount['fetch']>(async () => Response.json({ success: true,
    data: { items: [], next_cursor: '', has_more: false } }))
  const current = vi.fn(async () => true)
  const account: DemandAccount = { id: accountId, owner, fetch: send, isCurrent: current }
  const media = vi.fn<ForumProxyOptions['fetchPublic']>(async () => { throw new Error('Forum media must be unreachable') })
  const proxy = createForumProxy({ baseUrl: 'https://forum-api.invalid/prefix', requestRejection: () => undefined,
    captureAccount: async () => account, fetchPublic: media, limits: () => ({}), ...overrides })
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://forum.invalid').pathname
    void proxy.handle(request, response, path, request.method ?? 'GET').then((handled) => {
      if (!handled) { response.writeHead(404); response.end() }
    }).catch(() => { response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No isolated forum address')
  onTestFinished(async () => {
    await proxy.close(); server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  const call = async (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) =>
    await fetch(`http://127.0.0.1:${address.port}/credits/api/forum${path}`, { method,
      headers: { 'x-yunshu-account-id': accountId, 'x-yunshu-account-owner': owner,
        ...data === undefined ? {} : { 'content-type': 'application/json' }, ...headers },
      ...data === undefined ? {} : { body: JSON.stringify(data) } })
  return { call, send, current, media, proxy }
}

describe('fixed login-owned forum HTTP transport', () => {
  it('requires the existing Connection and exact current product owner before any upstream dispatch', async () => {
    const denied = await host({ requestRejection: () => 403 })
    expect((await denied.call('/posts')).status).toBe(403); expect(denied.send).not.toHaveBeenCalled()
    const forum = await host()
    expect(await (await forum.call('/posts', 'GET', undefined, { 'x-yunshu-account-owner': 'b'.repeat(64) })).json())
      .toEqual({ ok: false, code: 'ACCOUNT_CHANGED' })
    expect(forum.send).not.toHaveBeenCalled()
    expect(await (await forum.call('/posts')).json()).toEqual({ ok: true,
      payload: { items: [], next_cursor: '', has_more: false }, httpStatus: 200, account: { id: accountId }, accountOwner: owner })
    expect(forum.send).toHaveBeenCalledExactlyOnceWith('/api/product/forum/posts', expect.objectContaining({ method: 'GET' }))
  })
  it('has no admin, media, arbitrary-path or unsupported-method capability', async () => {
    const forum = await host()
    for (const path of ['/admin/posts', '/uploads', '/attachments/' + postId + '/link', '/posts/not-a-uuid', '/comments']) {
      expect((await forum.call(path)).status).toBe(404)
    }
    expect((await forum.call('/posts/' + postId + '/like', 'POST', { liked: true })).status).toBe(404)
    expect((await forum.call('/posts/' + postId, 'DELETE')).status).toBe(404)
    expect(await (await forum.call('/posts?review=all')).json()).toMatchObject({ code: 'FORUM_INVALID_INPUT' })
    expect(await (await forum.call('/posts?q=not-supported')).json()).toMatchObject({ code: 'FORUM_INVALID_INPUT' })
    expect(forum.send).not.toHaveBeenCalled(); expect(forum.media).not.toHaveBeenCalled()
  })
  it('forwards actual desired-state JSON PUT while stripping browser credentials and unknown fields', async () => {
    const forum = await host()
    forum.send.mockResolvedValueOnce(Response.json({ success: true, data: { post: post({ liked: true, like_count: 1,
      phone: 'hidden', internal_path: '/private' }) } }))
    const response = await forum.call('/posts/' + postId + '/like', 'PUT', { liked: true, user_id: 99,
      upstream_url: 'https://attacker.invalid' }, { authorization: 'Bearer browser-secret', cookie: 'browser-cookie' })
    const result: unknown = await response.json()
    expect(result).toMatchObject({ ok: true, payload: { post: { id: postId, liked: true } }, accountOwner: owner })
    expect(JSON.stringify(result)).not.toContain('hidden'); expect(JSON.stringify(result)).not.toContain('/private')
    expect(forum.send).toHaveBeenCalledExactlyOnceWith('/api/product/forum/posts/' + postId + '/like', expect.objectContaining({
      method: 'PUT', body: '{"liked":true}',
    }))
    const init = forum.send.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(init?.headers).get('authorization')).toBeNull(); expect(new Headers(init?.headers).get('cookie')).toBeNull()
    expect(forum.media).not.toHaveBeenCalled()
  })
  it('accepts legal 20000-scalar Unicode publication and rejects invalid or oversized packets before dispatch', async () => {
    const forum = await host(), original = { ...body, title: '😀'.repeat(200), body: '😀'.repeat(20_000) }
    expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(65_536)
    forum.send.mockResolvedValueOnce(Response.json({ success: true,
      data: { post: post({ title: original.title, body: original.body }), replayed: false } }, { status: 201 }))
    expect(await (await forum.call('/posts', 'POST', original)).json()).toMatchObject({ ok: true, httpStatus: 201 })
    expect(forum.send).toHaveBeenCalledTimes(1)
    expect(forum.send.mock.calls[0]?.[1].body).toBe(JSON.stringify(original))
    expect(await (await forum.call('/posts', 'POST', { ...body, body: '😀'.repeat(20_001) })).json())
      .toMatchObject({ code: 'FORUM_INVALID_INPUT' })
    expect(forum.send).toHaveBeenCalledTimes(1)
    const bounded = await host({ limits: () => ({ maxJsonRequestBytes: 32 }) })
    expect(await (await bounded.call('/posts', 'POST', body)).json()).toMatchObject({ code: 'FORUM_INVALID_INPUT' })
    expect(bounded.send).not.toHaveBeenCalled()
  })
  it('keeps unknown creation and comment outcomes one-shot, private and tied to the original request key', async () => {
    const forum = await host()
    forum.send.mockRejectedValueOnce(new Error('private upstream credential or database path'))
    const unknown: unknown = await (await forum.call('/posts', 'POST', body)).json()
    expect(unknown).toEqual({ ok: false, code: 'FORUM_NETWORK', outcome: 'unknown', operationKey: operationId })
    expect(JSON.stringify(unknown)).not.toContain('private upstream')
    forum.send.mockResolvedValueOnce(Response.json({ success: true, data: { comment: {
      id: commentId, post_id: postId, body: '评论', author: { id: 43, display_name: 'wrong owner' }, created_at: 2,
    }, replayed: false } }, { status: 201 }))
    expect(await (await forum.call('/posts/' + postId + '/comments', 'POST', { client_request_id: operationId, body: '评论' })).json())
      .toMatchObject({ code: 'FORUM_PROTOCOL_INVALID', outcome: 'unknown', operationKey: operationId })
    expect(forum.send).toHaveBeenCalledTimes(2)
  })
  it('keeps HTTP conflict, auth, unavailable config and non-JSON upstream failure distinct', async () => {
    const forum = await host()
    for (const [status, code] of [[403, 'FORUM_CLOSED'], [409, 'FORUM_REQUEST_CONFLICT'], [429, 'FORUM_RATE_LIMITED']] as const) {
      forum.send.mockResolvedValueOnce(Response.json({ success: false, code, message: 'private diagnostic' }, { status }))
      const result: unknown = await (await forum.call('/posts', 'POST', body)).json()
      expect(result).toMatchObject({ ok: false, code, httpStatus: status })
      expect(JSON.stringify(result)).not.toContain('private diagnostic')
      expect(result).not.toHaveProperty('outcome')
    }
    forum.send.mockResolvedValueOnce(new Response('missing', { status: 404 }))
    expect(await (await forum.call('/config')).json()).toMatchObject({ code: 'FORUM_NOT_FOUND', httpStatus: 404 })
    forum.send.mockResolvedValueOnce(new Response('<html>secret</html>', { status: 502 }))
    expect(await (await forum.call('/posts/' + postId + '/like', 'PUT', { liked: true })).json())
      .toMatchObject({ code: 'FORUM_SERVICE_UNAVAILABLE', httpStatus: 502, outcome: 'unknown' })
    expect(forum.send).toHaveBeenCalledTimes(5)
  })
  it('rejects a replacement account response and distinguishes timeout without replaying the mutation', async () => {
    const forum = await host()
    forum.send.mockImplementationOnce(async () => {
      forum.current.mockResolvedValue(false)
      return Response.json({ success: true, data: { post: post(), replayed: false } }, { status: 201 })
    })
    expect(await (await forum.call('/posts', 'POST', body)).json()).toEqual({ ok: false, code: 'ACCOUNT_CHANGED' })
    expect(forum.send).toHaveBeenCalledTimes(1)
    const timeout = await host({ limits: () => ({ requestTimeoutMs: 10 }) })
    timeout.send.mockImplementationOnce(async (_path, init) => new Promise<Response>((_resolve, reject) => {
      const abort = () => { reject(new Error('synthetic timeout')) }
      init.signal?.addEventListener('abort', abort, { once: true })
      if (init.signal?.aborted) abort()
    }))
    expect(await (await timeout.call('/posts', 'POST', body)).json()).toMatchObject({
      code: 'FORUM_TIMEOUT', outcome: 'unknown', operationKey: operationId,
    })
    expect(timeout.send).toHaveBeenCalledTimes(1)
  })
  it('accepts the source maximum page of100 full Unicode posts while bounding the full response', async () => {
    const forum = await host()
    const response = { success: true, data: { items: Array.from({ length: 100 }, (_, index) => post({
      id: `${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`, body: '😀'.repeat(20_000),
    })), next_cursor: '', has_more: false } }
    expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(2_097_152)
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(8_388_608)
    forum.send.mockResolvedValueOnce(Response.json(response))
    const payload = demandObject((await (await forum.call('/posts?limit=100')).json() as { payload: unknown }).payload)
    expect(payload.items).toHaveLength(100); expect(forum.send).toHaveBeenCalledTimes(1)
    const small = await host({ limits: () => ({ maxJsonResponseBytes: 32 }) })
    small.send.mockResolvedValueOnce(Response.json({ success: true, data: { post: post(), replayed: false } }))
    expect(await (await small.call('/posts', 'POST', body)).json())
      .toMatchObject({ code: 'FORUM_PROTOCOL_INVALID', outcome: 'unknown', operationKey: operationId })
    expect(small.send).toHaveBeenCalledTimes(1)
  })
})
