import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemandProxy, demandContentPath, type DemandAccount, type DemandProxyOptions } from '../src/demand-proxy.ts'

const owner = 'a'.repeat(64), id = '42', key = '11111111-2222-4333-8444-555555555555'
const headers = { 'x-yunshu-account-id': id, 'x-yunshu-account-owner': owner }
const disposal: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposal.splice(0).map(close => close())) })

async function fixture(overrides: Partial<DemandProxyOptions> = {}, accountOverrides: Partial<DemandAccount> = {}) {
  const send = vi.fn<DemandAccount['fetch']>(async () => Response.json({ success: true, data: { unread_count: 0, unread_demands: 0, server_time: 1 } }))
  const current = vi.fn(async () => true)
  const account: DemandAccount = { id, owner, fetch: send, isCurrent: current, ...accountOverrides }
  const publicFetch = vi.fn<DemandProxyOptions['fetchPublic']>(async () => new Response('video', { headers: { 'content-type': 'video/mp4' } }))
  const proxy = createDemandProxy({ baseUrl: 'https://service.invalid/prefix', requestRejection: () => undefined,
    captureAccount: async () => account, fetchPublic: publicFetch, limits: () => ({}), ...overrides })
  const server: Server = createServer((request, response) => {
    void proxy.handle(request, response, new URL(request.url ?? '/', 'http://local.invalid').pathname, request.method ?? 'GET')
      .then((handled) => { if (!handled) { response.writeHead(404); response.end() } })
      .catch(() => { response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No fixture address')
  const base = `http://127.0.0.1:${address.port}`
  const close = async (): Promise<void> => {
    await proxy.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  disposal.push(close)
  return { proxy, server, send, current, publicFetch, account, base,
    get: (path: string, init: RequestInit = {}) => fetch(base + path,
      { ...init, headers: { ...headers, ...Object.fromEntries(new Headers(init.headers)) } }) }
}

describe('Host-only demand route ownership', () => {
  it('checks Host authentication and the current product owner before contacting the API', async () => {
    const rejected = await fixture({ requestRejection: () => 403 })
    const answer = await rejected.get('/credits/api/demands/unread')
    expect(answer.status).toBe(403)
    expect(rejected.send).not.toHaveBeenCalled()
    const signed = await fixture()
    expect(await (await signed.get('/credits/api/demands/unread', { headers: { 'x-yunshu-account-owner': 'b'.repeat(64) } })).json())
      .toMatchObject({ ok: false, code: 'ACCOUNT_CHANGED' })
    expect(signed.send).not.toHaveBeenCalled()
    const valid: unknown = await (await signed.get('/credits/api/demands/unread')).json()
    expect(valid).toEqual({ ok: true, payload: { unread_count: 0, unread_demands: 0, server_time: 1 },
      httpStatus: 200, account: { id }, accountOwner: owner })
    expect(signed.send).toHaveBeenCalledExactlyOnceWith('/api/product/demands/unread', expect.objectContaining({ method: 'GET' }))
  })
  it('refuses unknown routes, methods, query keys and foreign-owner responses', async () => {
    const host = await fixture()
    expect((await host.get('/credits/api/demands/admin/anything')).status).toBe(404)
    expect((await host.get('/credits/api/demands/unread', { method: 'DELETE' })).status).toBe(404)
    expect(await (await host.get('/credits/api/demands/unread?user_id=other')).json()).toMatchObject({ ok: false, code: 'DEMAND_INVALID_INPUT' })
    expect(host.send).not.toHaveBeenCalled()
    host.send.mockImplementationOnce(async () => { host.current.mockResolvedValue(false); return Response.json({ success: true, data: { private: 'other-owner' } }) })
    expect(await (await host.get('/credits/api/demands/unread')).json()).toEqual({ ok: false, code: 'ACCOUNT_CHANGED' })
  })
  it('submits once with the original key and reports an unknown network result without an automatic retry', async () => {
    const host = await fixture()
    host.send.mockRejectedValueOnce(new Error('private transport detail'))
    const value: unknown = await (await host.get('/credits/api/demands', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_request_id: key, engineer_id: 'engineer', text: 'A request', owner: 'spoofed', internal_note: 'hidden' }) })).json()
    expect(value).toEqual({ ok: false, code: 'DEMAND_NETWORK', outcome: 'unknown', operationKey: key })
    expect(host.send).toHaveBeenCalledTimes(1)
    const init = host.send.mock.calls[0]?.[1]
    if (typeof init?.body !== 'string') throw new Error('Demand JSON was not serialized')
    expect(JSON.parse(init.body)).toEqual({ client_request_id: key, engineer_id: 'engineer', text: 'A request', attachment_ids: [] })
    expect(JSON.stringify(value)).not.toContain('private transport')
  })
  it('streams one bounded chunk preserving the exact offset without buffering a complete video', async () => {
    const host = await fixture()
    const bytes = new Uint8Array([1, 2, 3, 4])
    host.send.mockImplementationOnce(async (_route, init) => {
      expect(init.body).toBeInstanceOf(ReadableStream)
      expect(new Headers(init.headers).get('upload-offset')).toBe('4194304')
      expect(new Headers(init.headers).get('authorization')).toBeNull()
      expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(bytes)
      return Response.json({ success: true, data: { offset: 4194308, attachment: {
        id: 'upload', name: 'test.mp4', kind: 'video', mime_type: 'video/mp4', size_bytes: 8_000_000, status: 'uploading', uploaded_bytes: 4194308,
      } } })
    })
    const answer = await host.get('/credits/api/demands/uploads/upload/chunks', { method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'upload-offset': '4194304' }, body: bytes })
    expect(await answer.json()).toMatchObject({ ok: true, payload: { offset: 4194308 }, accountOwner: owner })
    expect(host.send).toHaveBeenCalledTimes(1)
  })
  it('rejects oversized chunks before any upload and does not forward privileged request headers', async () => {
    const host = await fixture({ limits: () => ({ maxChunkBytes: 3 }) })
    expect(await (await host.get('/credits/api/demands/uploads/upload/chunks', { method: 'PUT', headers: {
      'content-type': 'application/octet-stream', 'upload-offset': '0', authorization: 'Bearer attacker', cookie: 'secret',
    }, body: new Uint8Array(4) })).json()).toMatchObject({ ok: false, code: 'DEMAND_UPLOAD_INVALID' })
    expect(host.send).not.toHaveBeenCalled()
  })
  it('re-authorizes one attachment and forwards video Range without exposing the upstream capability', async () => {
    const host = await fixture()
    host.send.mockResolvedValueOnce(Response.json({ success: true, data: {
      url: 'https://service.invalid/prefix/api/product/demands/attachments/asset/content?token=private-cap', expires_at: 999,
    } }))
    host.publicFetch.mockResolvedValueOnce(new Response(new Uint8Array([8, 9]), { status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 2-3/4', 'accept-ranges': 'bytes' } }))
    const response = await host.get(demandContentPath('asset', host.account, 'inline'), { headers: { range: 'bytes=2-3' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-3/4')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([8, 9]))
    expect(host.publicFetch).toHaveBeenCalledExactlyOnceWith('/api/product/demands/attachments/asset/content?token=private-cap',
      expect.objectContaining({ headers: { range: 'bytes=2-3' }, method: 'GET' }))
  })
  it('refuses a signed link to another origin or attachment even after successful metadata authorization', async () => {
    const host = await fixture()
    host.send.mockResolvedValueOnce(Response.json({ success: true, data: { url: 'https://attacker.invalid/asset?token=bad', expires_at: 999 } }))
    expect(await (await host.get(demandContentPath('asset', host.account, 'inline'))).json()).toMatchObject({ ok: false, code: 'DEMAND_PROTOCOL_INVALID' })
    expect(host.publicFetch).not.toHaveBeenCalled()
  })
  it('joins cancelled pending reads on disposal and distinguishes timeout from service rejection', async () => {
    const host = await fixture({ limits: () => ({ requestTimeoutMs: 20 }) })
    host.send.mockImplementationOnce(async (_route, init) => await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('Cancelled'))
      }, { once: true })
    }))
    expect(await (await host.get('/credits/api/demands/unread')).json()).toMatchObject({ ok: false, code: 'DEMAND_TIMEOUT' })
    host.send.mockResolvedValueOnce(Response.json({ success: false, code: 'DEMAND_DISABLED', message: 'private diagnostic' }, { status: 503 }))
    expect(await (await host.get('/credits/api/demands/unread')).json()).toMatchObject({ ok: false, code: 'DEMAND_DISABLED', httpStatus: 503 })
    await host.proxy.close()
    expect(await (await host.get('/credits/api/demands/unread')).json()).toMatchObject({ ok: false, code: 'DEMAND_UNAVAILABLE' })
  })
  it('cancels an unfinished response body and joins its request before close resolves', async () => {
    const host = await fixture()
    let started: (() => void) | undefined
    const reading = new Promise<void>((resolve) => { started = resolve })
    const cancelled = vi.fn()
    host.send.mockImplementationOnce(async () => {
      started?.()
      return new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'application/json' } })
    })
    const answer = host.get('/credits/api/demands/unread').then(response => response.json() as Promise<unknown>)
    await reading
    await host.proxy.close()
    expect(await answer).toMatchObject({ ok: false, code: 'DEMAND_CANCELLED' })
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
  it('preserves a rate-limit wait without passing remote diagnostics into the client', async () => {
    const host = await fixture()
    host.send.mockResolvedValueOnce(Response.json({ success: false, code: 'DEMAND_RATE_LIMITED', message: 'secret server details' },
      { status: 429, headers: { 'retry-after': '60' } }))
    const answer: unknown = await (await host.get('/credits/api/demands/unread')).json()
    expect(answer).toMatchObject({ ok: false, code: 'DEMAND_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 60 })
    expect(JSON.stringify(answer)).not.toContain('secret server')
  })
})
