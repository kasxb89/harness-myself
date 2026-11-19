import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createForumProxy } from '../src/forum-proxy.ts'
import type { DemandAccount } from '../src/demand-proxy.ts'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()))
})
const owner = 'b'.repeat(64),
  headers = { 'x-yunshu-account-id': '42', 'x-yunshu-account-owner': owner }
const post = {
  id: 'post-1',
  title: 'A discussion',
  body: 'Public text',
  author: { id: 42, display_name: 'Member', phone: 'private' },
  created_at: 100,
  liked: false,
  like_count: 0,
  comment_count: 0,
  delete_reason: 'private moderation',
  token: 'private key',
}
async function fixture() {
  const fetcher = vi.fn<DemandAccount['fetch']>(async () =>
    Response.json({ success: true, data: { post, replayed: false } }),
  )
  const current = vi.fn(async () => true)
  const proxy = createForumProxy({
    captureAccount: async () => ({ id: '42', owner, fetch: fetcher, isCurrent: current }),
    requestRejection: () => undefined,
    limits: () => ({ requestTimeoutMs: 1000 }),
  })
  const server = createServer((req, res) => {
    void proxy
      .handle(req, res, new URL(req.url ?? '/', 'http://local').pathname, req.method ?? 'GET')
      .then((handled) => {
        if (!handled) {
          res.writeHead(404)
          res.end()
        }
      })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  cleanup.push(async () => {
    await proxy.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })
  return {
    fetcher,
    current,
    get: (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${address.port}/credits/api/forum${path}`, {
        ...init,
        headers: { ...headers, ...Object.fromEntries(new Headers(init.headers)) },
      }),
  }
}
it('keeps the publication key, strips private input and projects only public content', async () => {
  const f = await fixture()
  const response = await f.get('/posts', {
    method: 'POST',
    body: JSON.stringify({
      client_request_id: 'same-key',
      title: 'A discussion',
      body: 'Public text',
      author_id: 999,
      reviewed: true,
    }),
  })
  expect(response.status).toBe(200)
  const result = await response.text()
  expect(result).not.toContain('private')
  expect(result).not.toContain('token')
  expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(
    '/api/product/forum/posts',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ client_request_id: 'same-key', body: 'Public text', title: 'A discussion' }),
    }),
  )
})
it('refuses management, arbitrary filters and old-account writes before an upstream call', async () => {
  const f = await fixture()
  expect((await f.get('/forum-management/posts')).status).toBe(404)
  expect((await f.get('/posts/post-1', { method: 'DELETE' })).status).toBe(404)
  expect((await f.get('/posts?review=deleted')).status).toBe(400)
  expect(
    (
      await f.get('/posts', {
        method: 'POST',
        body: '{}',
        headers: { 'x-yunshu-account-owner': 'c'.repeat(64) },
      })
    ).status,
  ).toBe(409)
  expect(f.fetcher).not.toHaveBeenCalled()
})
it('does not replay a lost publication and discards a response after the account changes', async () => {
  const f = await fixture()
  f.fetcher.mockRejectedValueOnce(new Error('hidden network detail'))
  expect(
    await (
      await f.get('/posts', {
        method: 'POST',
        body: JSON.stringify({ client_request_id: 'same-key', title: 't', body: 'b' }),
      })
    ).json(),
  ).toEqual({ ok: false, code: 'FORUM_UNAVAILABLE', outcome: 'unknown' })
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  f.fetcher.mockImplementationOnce(async () => {
    f.current.mockResolvedValue(false)
    return Response.json({ success: true, data: { post } })
  })
  const result = await (await f.get('/posts/post-1')).text()
  expect(result).toContain('ACCOUNT_CHANGED')
  expect(result).not.toContain('Public text')
})

it('accepts an empty feed and an absent public display name without exposing login metadata', async () => {
  const f = await fixture()
  f.fetcher.mockResolvedValueOnce(Response.json({ success: true, data: { items: [], has_more: false, next_cursor: '' } }))
  expect(await (await f.get('/posts')).json()).toMatchObject({ ok: true, payload: { items: [], has_more: false, next_cursor: '' } })
  f.fetcher.mockResolvedValueOnce(Response.json({ success: true, data: { post: { ...post, author: { id:42, display_name:'' } } } }))
  expect(await (await f.get('/posts/post-1')).json()).toMatchObject({ ok:true, payload:{ post:{ author:{ id:42,display_name:'' } } } })
})
