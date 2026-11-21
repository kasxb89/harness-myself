import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestShowcase } from '../src/client/showcase-api.ts'

afterEach(() => { vi.unstubAllGlobals() })
describe('one-shot public showcase reads', () => {
  it('reads only the current Host namespace with no mutation or retry', async () => {
    const send = vi.fn(async () => Response.json({ ok: true, payload: { items: [] } }))
    vi.stubGlobal('fetch', send)
    expect(await requestShowcase('?limit=100', new AbortController().signal)).toEqual({ ok: true, payload: { items: [] } })
    expect(send).toHaveBeenCalledExactlyOnceWith('/credits/api/demand-showcases?limit=100', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    }))
    expect(await requestShowcase('/admin', new AbortController().signal)).toMatchObject({ ok: false, httpStatus: 400 })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('preserves old missing-route status, authorization errors and invalid JSON as distinct outcomes', async () => {
    const send = vi.fn(async () => new Response('not an API page', { status: 404 })); vi.stubGlobal('fetch', send)
    expect(await requestShowcase('/config', new AbortController().signal)).toMatchObject({ code: 'SHOWCASE_NOT_FOUND', httpStatus: 404 })
    send.mockResolvedValueOnce(new Response('private auth diagnostics', { status: 401 }))
    expect(await requestShowcase('/config', new AbortController().signal)).toMatchObject({ code: 'SHOWCASE_UNAUTHORIZED', httpStatus: 401 })
    send.mockResolvedValueOnce(new Response('not JSON', { status: 200 }))
    expect(await requestShowcase('/config', new AbortController().signal)).toMatchObject({ code: 'SHOWCASE_PROTOCOL_INVALID', httpStatus: 0 })
    expect(send).toHaveBeenCalledTimes(3)
  })
  it('classifies a network failure once and does not send any replacement request', async () => {
    const send = vi.fn(async () => { throw new Error('Private hostname or credential') }); vi.stubGlobal('fetch', send)
    const result = await requestShowcase('/config', new AbortController().signal)
    expect(result).toMatchObject({ code: 'SHOWCASE_NETWORK' }); expect(JSON.stringify(result)).not.toContain('Private')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
