import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { communityContentPath, createCommunityProxy, type CommunityProxyOptions } from '../src/community-proxy.ts'
import { createDemandProxy, type DemandAccount } from '../src/demand-proxy.ts'
import { demandObject } from '../src/demand-protocol.ts'
import {
  communityAsset, communityConfiguration, communityIds, communityListingFixture, communityMessage, communityOrder, communityUpload,
} from './community-fixtures.ts'

const owner = 'a'.repeat(64), accountId = '42'
const guards = { 'x-yunshu-account-id': accountId, 'x-yunshu-account-owner': owner }
const disposal: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposal.splice(0).map(close => close())) })

async function fixture(overrides: Partial<CommunityProxyOptions> = {}, family: 'community' | 'private' = 'community') {
  const send = vi.fn<DemandAccount['fetch']>(async () => Response.json({ success: true,
    data: { items: [], next_cursor: '', has_more: false } }))
  const current = vi.fn(async () => true)
  const account: DemandAccount = { id: accountId, owner, fetch: send, isCurrent: current }
  const publicFetch = vi.fn<CommunityProxyOptions['fetchPublic']>(async () => new Response('media', { headers: { 'content-type': 'video/mp4' } }))
  const options: CommunityProxyOptions = { baseUrl: 'https://service.invalid/prefix', requestRejection: () => undefined,
    captureAccount: async () => account, fetchPublic: publicFetch, limits: () => ({}), ...overrides }
  const proxy = family === 'community' ? createCommunityProxy(options) : createDemandProxy(options)
  const server = createServer((request, response) => {
    void proxy.handle(request, response, new URL(request.url ?? '/', 'http://local.invalid').pathname, request.method ?? 'GET')
      .then((handled) => { if (!handled) { response.writeHead(404); response.end() } })
      .catch(() => { response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No synthetic community address')
  disposal.push(async () => {
    await proxy.close(); server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  const get = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    ...init, headers: { ...guards, ...Object.fromEntries(new Headers(init.headers)) },
  })
  const post = (path: string, data: unknown) => get('/credits/api/community-demands' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  })
  return { proxy, send, current, publicFetch, account, get, post }
}
const createBody = { client_request_id: communityIds.key, publish_to_community: true, title: '示例公开需求', public_summary: '明确公开的示例说明' }

describe('community Host account and fixed route ownership', () => {
  it('accepts the full legitimate Unicode publication without shrinking its text or asset limits', async () => {
    const host = await fixture()
    const assets = Array.from({ length: 16 }, (_, index) => communityAsset({
      id: `${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
      scope: index < 8 ? 'listing' : 'conversation',
    }))
    const publicAssets = assets.slice(0, 8), privateAssets = assets.slice(8)
    const body = { ...createBody, title: '😀'.repeat(200), public_summary: '😀'.repeat(4000), public_budget: '😀'.repeat(100),
      private_text: '😀'.repeat(12_000), public_attachment_ids: publicAssets.map(item => item.id),
      private_attachment_ids: privateAssets.map(item => item.id) }
    const bytes = Buffer.byteLength(JSON.stringify(body))
    expect(bytes).toBeGreaterThan(65_536)
    expect(bytes).toBeLessThan(131_072)
    host.send.mockResolvedValueOnce(Response.json({ success: true, data: {
      order: communityOrder({ title: body.title, private_text: body.private_text, status: 'open', acceptor: null, revision: 1,
        listing: communityListingFixture({ title: body.title, public_summary: body.public_summary,
          public_budget: body.public_budget, public_attachments: publicAssets }) }),
      message: communityMessage({ sender_id: 42, author_kind: 'publisher', text: body.private_text,
        client_message_id: 'create:' + communityIds.key, attachments: privateAssets }), replayed: false,
    } }, { status: 201 }))
    expect(await (await host.post('/orders', body)).json()).toMatchObject({ ok: true, httpStatus: 201 })
    expect(host.send).toHaveBeenCalledTimes(1)
    const sent = host.send.mock.calls[0]?.[1].body
    if (typeof sent !== 'string') throw new Error('Missing publication body')
    expect(Buffer.byteLength(sent)).toBe(bytes)
    expect(demandObject(JSON.parse(sent) as unknown)).toMatchObject(body)
  })
  it('enforces the whole Unicode JSON byte ceiling at equality and rejects excess before dispatch', async () => {
    const base = { ...createBody, public_summary: '😀', padding: '' }
    const exact = { ...base, padding: 'x'.repeat(131_072 - Buffer.byteLength(JSON.stringify(base))) }
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(131_072)
    const host = await fixture()
    host.send.mockResolvedValueOnce(Response.json({ success: true, data: { order: communityOrder(), message: null, replayed: false } }))
    expect(await (await host.post('/orders', exact)).json()).toMatchObject({ ok: true })
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(host.send.mock.calls[0]?.[1].body).not.toContain('padding')
    const excess = await fixture()
    expect(await (await excess.post('/orders', { ...exact, padding: exact.padding + 'x' })).json())
      .toMatchObject({ ok: false, code: 'COMMUNITY_INVALID_INPUT' })
    expect(excess.send).not.toHaveBeenCalled()
    const small = await fixture({ limits: () => ({ maxJsonRequestBytes: 32 }) })
    expect(await (await small.post('/orders', createBody)).json()).toMatchObject({ code: 'COMMUNITY_INVALID_INPUT' })
    expect(small.send).not.toHaveBeenCalled()
  })
  it('keeps the private demand default at 65536 bytes independently of the community default', async () => {
    const host = await fixture({}, 'private')
    expect(await (await host.get('/credits/api/demands', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_request_id: communityIds.key, engineer_id: 'engineer', text: 'private request', padding: 'x'.repeat(65_536) }),
    })).json()).toMatchObject({ ok: false, code: 'DEMAND_INVALID_INPUT' })
    expect(host.send).not.toHaveBeenCalled()
  })
  it('accepts a bounded page of 100 full-length Unicode peer messages through HTTP and projection', async () => {
    const host = await fixture()
    const messages = Array.from({ length: 100 }, (_, index) => communityMessage({
      id: `${(index + 1).toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`, seq: index + 1,
      client_message_id: `${(index + 1).toString(16).padStart(8, '0')}-3333-4333-8333-333333333333`, text: '😀'.repeat(12_000),
    }))
    const response = { success: true, data: { items: messages, order: communityOrder({ last_seq: 100, unread_count: 100 }),
      last_seq: 100, next_after_seq: 100, has_more: false } }
    expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(2_097_152)
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(8_388_608)
    host.send.mockResolvedValueOnce(Response.json(response))
    const result = demandObject(await (await host.get('/credits/api/community-demands/orders/' + communityIds.order + '/messages')).json() as unknown)
    expect(result.ok).toBe(true)
    const payload = demandObject(result.payload)
    expect(payload.last_seq).toBe(100)
    expect(payload.items).toHaveLength(100)
    if (!Array.isArray(payload.items)) throw new Error('Missing projected messages')
    expect(demandObject(payload.items.at(-1)).text).toBe('😀'.repeat(12_000))
    expect(host.send).toHaveBeenCalledTimes(1)
  })
  it('bounds the whole response at eight MiB and retains an unknown mutation without replay above it', async () => {
    const base = { success: true, data: { items: [], next_cursor: '', has_more: false }, padding: '😀' }
    const exact = { ...base, padding: base.padding + 'x'.repeat(8_388_608 - Buffer.byteLength(JSON.stringify(base))) }
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(8_388_608)
    const host = await fixture()
    host.send.mockResolvedValueOnce(Response.json(exact))
    expect(await (await host.get('/credits/api/community-demands/listings')).json()).toMatchObject({ ok: true })
    const excess = await fixture()
    excess.send.mockResolvedValueOnce(Response.json({ ...exact, padding: exact.padding + 'x' }))
    expect(await (await excess.post('/orders', createBody)).json()).toMatchObject({
      ok: false, code: 'COMMUNITY_PROTOCOL_INVALID', outcome: 'unknown', operationKey: communityIds.key,
    })
    expect(excess.send).toHaveBeenCalledTimes(1)
    const small = await fixture({ limits: () => ({ maxJsonResponseBytes: 32 }) })
    expect(await (await small.get('/credits/api/community-demands/listings')).json()).toMatchObject({ code: 'COMMUNITY_PROTOCOL_INVALID' })
    expect(small.send).toHaveBeenCalledTimes(1)
  })
  it('keeps the private demand response default at two MiB', async () => {
    const host = await fixture({}, 'private')
    const response = { success: true, data: { unread_count: 0, unread_demands: 0, server_time: 1 }, padding: '' }
    response.padding = 'x'.repeat(2_097_153 - Buffer.byteLength(JSON.stringify(response)))
    host.send.mockResolvedValueOnce(Response.json(response))
    expect(await (await host.get('/credits/api/demands/unread')).json()).toMatchObject({ ok: false, code: 'DEMAND_PROTOCOL_INVALID' })
    expect(host.send).toHaveBeenCalledTimes(1)
  })
  it('requires local Connection and current product-owner guards before contacting the API', async () => {
    const denied = await fixture({ requestRejection: () => 403 })
    expect((await denied.get('/credits/api/community-demands/listings')).status).toBe(403)
    expect(denied.send).not.toHaveBeenCalled()
    const host = await fixture()
    expect(await (await host.get('/credits/api/community-demands/listings', { headers: { 'x-yunshu-account-owner': 'b'.repeat(64) } })).json())
      .toEqual({ ok: false, code: 'ACCOUNT_CHANGED' })
    expect(host.send).not.toHaveBeenCalled()
    expect(await (await host.get('/credits/api/community-demands/listings')).json()).toEqual({ ok: true,
      payload: { items: [], next_cursor: '', has_more: false }, httpStatus: 200, account: { id: accountId }, accountOwner: owner })
    expect(host.send).toHaveBeenCalledExactlyOnceWith('/api/product/community-demands/listings', expect.objectContaining({ method: 'GET' }))
  })
  it('does not expose official, admin, path-injection or undeclared query routes', async () => {
    const host = await fixture()
    for (const path of ['/orders/not-a-uuid', '/customer-profiles', '/profile-import', '/admin/orders', '/orders/' + communityIds.order + '/assign']) {
      expect((await host.get('/credits/api/community-demands' + path)).status).toBe(404)
    }
    expect((await host.get('/credits/api/demands/listings')).status).toBe(404)
    expect(await (await host.get('/credits/api/community-demands/orders?publisher_id=other')).json()).toMatchObject({ code: 'COMMUNITY_INVALID_INPUT' })
    expect(host.send).not.toHaveBeenCalled()
  })
  it('does not submit implicitly or forward browser credentials and undeclared private fields', async () => {
    const host = await fixture()
    expect(await (await host.post('/orders', { ...createBody, publish_to_community: false })).json()).toMatchObject({ code: 'COMMUNITY_INVALID_INPUT' })
    expect(host.send).not.toHaveBeenCalled()
    host.send.mockResolvedValueOnce(Response.json({ success: true,
      data: { order: communityOrder(), message: null, replayed: false } }, { status: 201 }))
    const result: unknown = await (await host.get('/credits/api/community-demands/orders', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer browser-secret', cookie: 'browser-cookie' },
      body: JSON.stringify({ ...createBody, phone: 'private', internal_note: 'private', upstream_url: 'https://attacker.invalid' }) })).json()
    expect(result).toMatchObject({ ok: true, httpStatus: 201, payload: { replayed: false }, accountOwner: owner })
    const init = host.send.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get('authorization')).toBeNull()
    expect(new Headers(init?.headers).get('cookie')).toBeNull()
    if (typeof init?.body !== 'string') throw new Error('Missing serialized community request')
    expect(demandObject(JSON.parse(init.body) as unknown)).toEqual({ ...createBody, public_attachment_ids: [], private_attachment_ids: [] })
  })
  it('reports an unknown one-shot mutation result without leaking diagnostics or changing the durable UUID', async () => {
    const host = await fixture()
    host.send.mockRejectedValueOnce(new Error('private upstream credential and database path'))
    const result: unknown = await (await host.post('/orders', createBody)).json()
    expect(result).toEqual({ ok: false, code: 'COMMUNITY_NETWORK', outcome: 'unknown', operationKey: communityIds.key })
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('private upstream')
    host.send.mockResolvedValueOnce(Response.json({ success: true, data: { internal_path: 'private' } }, { status: 201 }))
    expect(await (await host.post('/orders', createBody)).json()).toMatchObject({
      code: 'COMMUNITY_PROTOCOL_INVALID', outcome: 'unknown', operationKey: communityIds.key,
    })
    expect(host.send).toHaveBeenCalledTimes(2)
  })
  it('keeps HTTP conflict, permission, rate-limit and non-JSON service failures distinct', async () => {
    const host = await fixture(), route = '/orders/' + communityIds.order + '/accept'
    for (const [status, code] of [[403, 'COMMUNITY_SELF_ACCEPT_FORBIDDEN'], [409, 'COMMUNITY_ALREADY_ACCEPTED'], [429, 'COMMUNITY_RATE_LIMITED']] as const) {
      host.send.mockResolvedValueOnce(Response.json({ success: false, code, message: 'private diagnosis', phone: 'hidden' },
        { status, headers: { 'retry-after': '30' } }))
      const result: unknown = await (await host.post(route, { client_action_id: communityIds.key })).json()
      expect(result).toMatchObject({ ok: false, code, httpStatus: status })
      expect(JSON.stringify(result)).not.toContain('private diagnosis')
    }
    host.send.mockResolvedValueOnce(new Response('<html>private reverse-proxy detail</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    expect(await (await host.post(route, { client_action_id: communityIds.key })).json()).toMatchObject({
      code: 'COMMUNITY_SERVICE_UNAVAILABLE', httpStatus: 502, outcome: 'unknown', operationKey: communityIds.key,
    })
    expect(host.send).toHaveBeenCalledTimes(4)
  })
  it('does not gate participant message recovery on a missing or disabled discovery probe', async () => {
    const host = await fixture()
    host.send.mockResolvedValueOnce(new Response('Not found', { status: 404 }))
    expect(await (await host.get('/credits/api/community-demands/config')).json()).toMatchObject({ code: 'COMMUNITY_NOT_FOUND', httpStatus: 404 })
    host.send.mockResolvedValueOnce(Response.json({ success: true, data: communityConfiguration(false) }))
    expect(await (await host.get('/credits/api/community-demands/config')).json()).toMatchObject({ ok: true, payload: { enabled: false } })
    host.send.mockResolvedValueOnce(Response.json({ success: true, data: { items: [communityMessage()], last_seq: 1,
      next_after_seq: 1, has_more: false, order: communityOrder() } }))
    expect(await (await host.get('/credits/api/community-demands/orders/' + communityIds.order + '/messages')).json())
      .toMatchObject({ ok: true, payload: { order: { can_send: true }, items: [{ author_kind: 'acceptor' }] } })
  })
  it('rejects stale-account success and distinguishes deadline from connection failure', async () => {
    const host = await fixture({ limits: () => ({ requestTimeoutMs: 30 }) })
    host.send.mockImplementationOnce(async () => {
      host.current.mockResolvedValue(false); return Response.json({ success: true, data: {} })
    })
    expect(await (await host.get('/credits/api/community-demands/listings')).json()).toEqual({ ok: false, code: 'ACCOUNT_CHANGED' })
    host.current.mockResolvedValue(true)
    host.send.mockImplementationOnce(async (_route, init) => await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('private timeout')) }, { once: true })
    }))
    expect(await (await host.post('/orders', createBody)).json()).toMatchObject({ code: 'COMMUNITY_TIMEOUT', outcome: 'unknown', operationKey: communityIds.key })
  })
  it('streams one bounded chunk using the community content route and exact Upload-Offset', async () => {
    const host = await fixture(), bytes = new Uint8Array([1, 2, 3, 4])
    host.send.mockImplementationOnce(async (_path, init) => {
      expect(init.body).toBeInstanceOf(ReadableStream)
      expect(new Headers(init.headers).get('upload-offset')).toBe('4')
      expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(bytes)
      return Response.json({ success: true, data: communityUpload({ offset: 8 }) })
    })
    const result: unknown = await (await host.get('/credits/api/community-demands/uploads/' + communityIds.asset + '/content', {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'upload-offset': '4' }, body: bytes,
    })).json()
    expect(result).toMatchObject({ ok: true, payload: { offset: 8, attachment: null } })
    expect(host.send.mock.calls[0]?.[0]).toBe('/api/product/community-demands/uploads/' + communityIds.asset + '/content')
    const small = await fixture({ limits: () => ({ maxChunkBytes: 3 }) })
    expect(await (await small.get('/credits/api/community-demands/uploads/' + communityIds.asset + '/content', {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'upload-offset': '0' }, body: bytes,
    })).json()).toMatchObject({ code: 'COMMUNITY_INVALID_INPUT' })
    expect(small.send).not.toHaveBeenCalled()
  })
  it('freshly authorizes signed community media, Range/HEAD and original-filename download', async () => {
    const host = await fixture()
    const path = '/api/product/community-demands/attachments/' + communityIds.asset + '/content?token=private-capability'
    host.send.mockImplementation(async () => Response.json({ success: true, data: { url: 'https://service.invalid/prefix' + path, expires_at: 100 } }))
    host.publicFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 206, headers: {
      'content-type': 'video/mp4', 'content-range': 'bytes 2-3/4', 'content-disposition': 'attachment; filename="example.mp4"',
    } }))
    const media = await host.get(communityContentPath(communityIds.asset, host.account, 'attachment'), { headers: { range: 'bytes=2-3' } })
    expect(media.status).toBe(206)
    expect(media.headers.get('content-range')).toBe('bytes 2-3/4')
    expect(media.headers.get('content-disposition')).toContain('example.mp4')
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(new Uint8Array([1, 2]))
    expect(host.publicFetch).toHaveBeenCalledWith(path, expect.objectContaining({ method: 'GET', headers: { range: 'bytes=2-3' } }))
    const head = await host.get(communityContentPath(communityIds.asset, host.account, 'inline'), { method: 'HEAD' })
    expect(await head.text()).toBe('')
    expect(host.send).toHaveBeenCalledTimes(2)
    expect(host.publicFetch).toHaveBeenCalledTimes(2)
  })
  it('does not accept signed links from another origin, attachment or protocol domain', async () => {
    const host = await fixture()
    for (const url of ['https://attacker.invalid/content?token=x',
      'https://service.invalid/prefix/api/product/demands/attachments/' + communityIds.asset + '/content?token=x',
      'https://service.invalid/prefix/api/product/community-demands/attachments/' + communityIds.other + '/content?token=x']) {
      host.send.mockResolvedValueOnce(Response.json({ success: true, data: { url, expires_at: 100 } }))
      expect(await (await host.get(communityContentPath(communityIds.asset, host.account, 'inline'))).json()).toMatchObject({ code: 'COMMUNITY_PROTOCOL_INVALID' })
    }
    expect(host.publicFetch).not.toHaveBeenCalled()
  })
  it('returns only an owner-bound local URL when the browser requests an attachment link', async () => {
    const host = await fixture()
    host.send.mockResolvedValueOnce(Response.json({ success: true, data: {
      url: 'https://service.invalid/prefix/api/product/community-demands/attachments/' + communityIds.asset + '/content?token=secret',
      expires_at: 100, internal_path: '/private/storage',
    } }))
    const result: unknown = await (await host.post('/attachments/' + communityIds.asset + '/link', { disposition: 'attachment' })).json()
    expect(result).toMatchObject({ ok: true, payload: {
      url: communityContentPath(communityIds.asset, host.account, 'attachment'), expires_at: 100,
    } })
    expect(JSON.stringify(result)).not.toMatch(/secret|internal_path|service.invalid/u)
    expect(host.publicFetch).not.toHaveBeenCalled()
  })
  it('stops a one-shot upload when its captured account changes during the stream', async () => {
    const host = await fixture()
    host.send.mockImplementationOnce(async (_path, init) => {
      host.current.mockResolvedValue(false)
      await new Response(init.body).arrayBuffer()
      return Response.json({ success: true, data: communityUpload() })
    })
    const result: unknown = await (await host.get('/credits/api/community-demands/uploads/' + communityIds.asset + '/content', {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'upload-offset': '0' }, body: new Uint8Array([1]),
    })).json()
    expect(result).toMatchObject({ code: 'ACCOUNT_CHANGED', outcome: 'unknown', operationKey: communityIds.asset + ':0' })
    expect(host.send).toHaveBeenCalledTimes(1)
  })
  it('joins and cancels a streamed media download when its Host owner closes', async () => {
    const host = await fixture(), cancel = vi.fn()
    host.send.mockResolvedValueOnce(Response.json({ success: true, data: {
      url: 'https://service.invalid/prefix/api/product/community-demands/attachments/' + communityIds.asset + '/content?token=private',
      expires_at: 100,
    } }))
    host.publicFetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])) }, cancel,
    }), { headers: { 'content-type': 'video/mp4' } }))
    const answer = await host.get(communityContentPath(communityIds.asset, host.account, 'inline'))
    const consumed = answer.arrayBuffer()
    await host.proxy.close()
    await expect(consumed).rejects.toThrow()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('joins interrupted response streams before disposal settles', async () => {
    const host = await fixture(), cancel = vi.fn()
    let ready: (() => void) | undefined
    const started = new Promise<void>((resolve) => { ready = resolve })
    host.send.mockImplementationOnce(async () => {
      ready?.()
      return new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } })
    })
    const reading = host.get('/credits/api/community-demands/listings').then(response => response.json() as Promise<unknown>)
    await started; await host.proxy.close()
    expect(await reading).toMatchObject({ code: 'COMMUNITY_CANCELLED' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
