import { createServer } from 'node:http'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createShowcaseProxy, type ShowcaseProxyOptions } from '../src/showcase-proxy.ts'

const caseId = '11111111-1111-4111-8111-111111111111', assetId = '22222222-2222-4222-8222-222222222222'
const local = '/credits/api/demand-showcases', upstream = '/api/product/demand-showcases'
async function host(options: Partial<ShowcaseProxyOptions> = {}, stripCreditsPrefix = false) {
  const send = vi.fn<ShowcaseProxyOptions['fetchPublic']>(async () => Response.json({ success: true, data: {
    capabilities: { showcases_v1: true, pagination: true, public_ready_media: true }, categories: ['web'] } }))
  const proxy = createShowcaseProxy({ baseUrl: 'https://cases.invalid/harness', fetchPublic: send,
    requestRejection: () => undefined, limits: () => ({}), ...options })
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://local.invalid').pathname
    void proxy.handle(request, response, stripCreditsPrefix ? path.slice('/credits'.length) : path, request.method ?? 'GET').then((handled) => {
      if (!handled) { response.writeHead(404); response.end() }
    }).catch((_error: unknown) => { response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected an isolated test address')
  onTestFinished(async () => {
    await proxy.close(); server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  const call = async (suffix: string, init?: RequestInit) => await fetch(`http://127.0.0.1:${address.port}${local}${suffix}`, init)
  return { send, call, proxy }
}
describe('closed public showcase facade', () => {
  it('accepts the prefix-stripped route actually supplied by credits-index', async () => {
    const value = await host({}, true)
    expect(await (await value.call('/config')).json()).toMatchObject({ ok: true, payload: { capabilities: { showcases_v1: true } } })
    expect(value.send).toHaveBeenCalledExactlyOnceWith(`${upstream}/config`, expect.objectContaining({ method: 'GET' }))
  })
  it('checks the existing local Connection but sends no browser credentials or account authority upstream', async () => {
    const rejected = await host({ requestRejection: () => 403 })
    expect((await rejected.call('/config')).status).toBe(403); expect(rejected.send).not.toHaveBeenCalled()
    const value = await host()
    expect(await (await value.call('/config', { headers: { authorization: 'Bearer browser-only', cookie: 'private-cookie' } })).json())
      .toMatchObject({ ok: true, payload: { capabilities: { showcases_v1: true } } })
    expect(value.send).toHaveBeenCalledExactlyOnceWith(`${upstream}/config`, expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error' }))
    const headers = new Headers(value.send.mock.calls[0]?.[1].headers)
    expect(headers.has('authorization')).toBe(false); expect(headers.has('cookie')).toBe(false)
  })
  it('has no write, admin, private attachment or arbitrary route capability', async () => {
    const value = await host()
    for (const path of ['/management', '/uploads', `/assets/${caseId}/${assetId}/link`, '/not-a-uuid']) {
      expect((await value.call(path)).status).toBe(404)
    }
    expect((await value.call('', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await value.call('/config', { method: 'PATCH', body: '{}' })).status).toBe(404)
    expect(value.send).not.toHaveBeenCalled()
    expect(await (await value.call('?admin=true')).json()).toMatchObject({ ok: false, code: 'SHOWCASE_INVALID_INPUT', httpStatus: 400 })
    expect(value.send).not.toHaveBeenCalled()
  })
  it('preserves explicit failure status without leaking returned HTML or private diagnostics', async () => {
    const value = await host()
    for (const status of [401, 403, 404, 429, 503]) {
      value.send.mockResolvedValueOnce(new Response('private upstream diagnostics', { status }))
      const response = await value.call('/config'), text = await response.text()
      expect(response.status).toBe(status); expect(text).not.toContain('private upstream')
    }
    expect(value.send).toHaveBeenCalledTimes(5)
  })
  it('proxies original image/video Range and HEAD only within exact public case assets', async () => {
    const value = await host(), path = `/assets/${caseId}/${assetId}/content`
    const bytes = new Uint8Array([1, 2, 3, 4])
    value.send.mockResolvedValueOnce(new Response(bytes, { status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '4',
      'content-range': 'bytes 0-3/100', 'accept-ranges': 'bytes', 'set-cookie': 'never-forward' } }))
    const response = await value.call(path, { headers: { range: 'bytes=0-3' } })
    expect(response.status).toBe(206); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.get('content-range')).toBe('bytes 0-3/100'); expect(response.headers.get('set-cookie')).toBeNull()
    expect(value.send.mock.calls.at(-1)?.[0]).toBe(upstream + path)
    expect(new Headers(value.send.mock.calls.at(-1)?.[1].headers).get('range')).toBe('bytes=0-3')
    value.send.mockResolvedValueOnce(new Response(null, { headers: { 'content-type': 'image/png', 'content-length': '100' } }))
    const head = await value.call(path, { method: 'HEAD' })
    expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe('100'); expect(await head.text()).toBe('')
    expect(value.send).toHaveBeenLastCalledWith(upstream + path, expect.objectContaining({ method: 'HEAD' }))
    value.send.mockResolvedValueOnce(new Response('<script>secret</script>', { headers: { 'content-type': 'text/html' } }))
    expect(await (await value.call(path)).json()).toMatchObject({ ok: false, code: 'SHOWCASE_PROTOCOL_INVALID' })
    value.send.mockResolvedValueOnce(new Response('<script>secret</script>', { status: 416,
      headers: { 'content-type': 'text/html', 'content-range': 'bytes */100' } }))
    const unsatisfied = await value.call(path, { headers: { range: 'bytes=999-1000' } })
    expect(unsatisfied.status).toBe(416); expect(unsatisfied.headers.get('content-range')).toBe('bytes */100')
    expect(unsatisfied.headers.get('content-type')).toBeNull(); expect(await unsatisfied.text()).toBe('')
  })
  it('bounds metadata reads and preserves no-retry deadlines', async () => {
    const bounded = await host({ limits: () => ({ maxJsonResponseBytes: 10 }) })
    expect(await (await bounded.call('/config')).json()).toMatchObject({ code: 'SHOWCASE_PROTOCOL_INVALID' })
    expect(bounded.send).toHaveBeenCalledTimes(1)
    const value = await host({ limits: () => ({ requestTimeoutMs: 10 }) })
    value.send.mockImplementationOnce(async (_route, init) => await new Promise<Response>((_resolve, reject) => {
      const fail = (): void => { reject(new Error('Synthetic timeout')) }
      init.signal?.addEventListener('abort', fail, { once: true }); if (init.signal?.aborted) fail()
    }))
    expect(await (await value.call('/config')).json()).toMatchObject({ code: 'SHOWCASE_TIMEOUT' })
    expect(value.send).toHaveBeenCalledTimes(1)
  })
})
