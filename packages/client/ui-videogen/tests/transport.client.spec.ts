import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestJson } from '../src/client/transport.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('media request failures', () => {
  it.each([
    ['http', async () => new Response('unavailable', { status: 503 }), 'HTTP'],
    ['invalid JSON', async () => new Response('<html>not json</html>'), 'TRANSPORT'],
    ['missing envelope', async () => new Response('{}'), 'RESPONSE_INVALID'],
    ['network', async () => { throw new Error('connection lost') }, 'TRANSPORT'],
  ] as const)('contains %s failures without retrying', async (_name, response, code) => {
    const fetcher = vi.fn(response)
    vi.stubGlobal('fetch', fetcher)
    expect(await requestJson('/credits/api/video/tasks', { method: 'POST' })).toMatchObject({ ok: false, code })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
