import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestJson } from '../src/client/transport.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('media request failures', () => {
  it('recognizes cancellation only when the owning request signal was aborted', async () => {
    const abort = new AbortController()
    abort.abort()
    const fetcher = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError') })
    vi.stubGlobal('fetch', fetcher)
    expect(await requestJson('/credits/api/video/tasks', { method: 'POST', signal: abort.signal }))
      .toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([
    ['http', async () => new Response('unavailable', { status: 503 }), 'HTTP_503'],
    ['invalid JSON', async () => new Response('<html>not json</html>'), 'RESPONSE_INVALID'],
    ['missing envelope', async () => new Response('{}'), 'RESPONSE_INVALID'],
    ['unknown exception', async () => { throw new Error('unconfirmed') }, 'UNKNOWN'],
    ['unowned abort', async () => { throw new DOMException('internal abort', 'AbortError') }, 'UNKNOWN'],
    ['timeout', async () => { throw new DOMException('deadline', 'TimeoutError') }, 'TIMEOUT'],
    ['network', async () => { throw new TypeError('connection lost') }, 'TRANSPORT'],
  ] as const)('contains %s failures without retrying', async (_name, response, code) => {
    const fetcher = vi.fn(response)
    vi.stubGlobal('fetch', fetcher)
    expect(await requestJson('/credits/api/video/tasks', { method: 'POST' })).toMatchObject({ ok: false, code })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
