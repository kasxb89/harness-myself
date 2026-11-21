import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceGalleryProxy } from '../src/service-gallery-proxy.ts'
import { serviceGalleryContentPath } from '../src/service-gallery-path.ts'
import type { DemandAccount, DemandProxyOptions } from '../src/demand-proxy.ts'

const account = { id: '42', owner: 'a'.repeat(64) }
const mediaPath = '/api/product/demand-service-media/service-1/asset-1/content'
const closes: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())) })

async function fixture(options: { denied?: boolean; signedPath?: string; current?: () => Promise<boolean> } = {}) {
  const signing = vi.fn<DemandAccount['fetch']>(async () => Response.json({ success: true, data: {
    url: `https://backend.invalid/prefix${options.signedPath ?? mediaPath}?token=private-signed-value`, expires_at: 100,
  } }))
  const current = vi.fn(options.current ?? (async () => true))
  const publicRead = vi.fn<DemandProxyOptions['fetchPublic']>(async (_path, init) => new Response(init.method === 'HEAD' ? null : new Uint8Array([1, 2, 3]), {
    status: new Headers(init.headers).has('range') ? 206 : 200,
    headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': '3',
      ...new Headers(init.headers).has('range') ? { 'content-range': 'bytes 0-2/8' } : {} },
  }))
  const proxy = createServiceGalleryProxy({ baseUrl: 'https://backend.invalid/prefix', requestRejection: () => options.denied ? 403 : undefined,
    captureAccount: async () => ({ ...account, fetch: signing, isCurrent: current }), fetchPublic: publicRead, limits: () => ({}) })
  const server = createServer((request, response) => {
    void proxy.handle(request, response, new URL(request.url ?? '/', 'http://local.invalid').pathname.slice('/credits'.length), request.method ?? 'GET')
      .then((handled) => { if (!handled) { response.writeHead(404); response.end() } })
      .catch(() => { response.writeHead(500); response.end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No gallery proxy port')
  closes.push(async () => {
    await proxy.close(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })
  const read = (path = serviceGalleryContentPath('service-1', 'asset-1', account), init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, init)
  return { read, signing, publicRead, current }
}

describe('Service gallery exact-profile content relay', () => {
  it('signs the exact profile and asset, relays Range and HEAD, and keeps the signed capability off the local URL', async () => {
    const host = await fixture()
    const path = serviceGalleryContentPath('service-1', 'asset-1', account)
    expect(path).not.toContain('private-signed-value')
    const response = await host.read(path, { headers: { range: 'bytes=0-2' } })
    expect(response.status).toBe(206)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(host.signing).toHaveBeenCalledExactlyOnceWith('/api/product/demands/service-profiles/service-1/media/asset-1/link', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ disposition: 'inline' }),
    }))
    expect(host.publicRead).toHaveBeenCalledExactlyOnceWith(`${mediaPath}?token=private-signed-value`, expect.objectContaining({ method: 'GET', headers: { range: 'bytes=0-2' } }))
    expect((await host.read(path, { method: 'HEAD' })).status).toBe(200)
    expect(host.signing).toHaveBeenCalledTimes(2)
  })
  it.each(['/api/product/demand-service-media/other/asset-1/content', '/api/product/demand-service-media/service-1/other/content',
    '/api/product/demands/attachments/asset-1/content'])('rejects a signed response for a different binding: %s', async (signedPath) => {
    const host = await fixture({ signedPath })
    expect(await (await host.read()).json()).toMatchObject({ ok: false, code: 'DEMAND_PROTOCOL_INVALID' })
    expect(host.publicRead).not.toHaveBeenCalled()
  })
  it('rejects Host and account mismatches before signing or sending bytes', async () => {
    const denied = await fixture({ denied: true })
    expect((await denied.read()).status).toBe(403)
    expect(denied.signing).not.toHaveBeenCalled()
    const host = await fixture()
    expect(await (await host.read(serviceGalleryContentPath('service-1', 'asset-1', { ...account, id: 'other' }))).json())
      .toMatchObject({ ok: false, code: 'ACCOUNT_CHANGED' })
    expect(host.signing).not.toHaveBeenCalled()
  })
  it('exposes no create, upload, gallery edit, arbitrary link or alternate method route', async () => {
    const host = await fixture()
    for (const [path, method] of [['/uploads', 'POST'], ['/service-1/asset-1/link', 'POST'], ['/service-1/asset-1/content', 'POST'], ['/service-1/media', 'PUT']] as const) {
      expect((await host.read('/credits/api/demand-service-media' + path, { method })).status).toBe(404)
    }
    expect(host.signing).not.toHaveBeenCalled()
    expect(host.publicRead).not.toHaveBeenCalled()
  })
})
