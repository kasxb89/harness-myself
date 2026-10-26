import { afterEach, expect, it, vi } from 'vitest'
import { get, post } from '../src/client/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('keeps account reads and mutations beneath the document public mount', async () => {
  vi.stubGlobal('document', { baseURI: 'https://host.invalid/mount/' })
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetcher)
  await get('/credits/api/session')
  await get('/credits/api/summary')
  await post('/credits/api/session/logout', { idempotencyKey: 'test-only' })
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/mount/credits/api/session', '/mount/credits/api/summary', '/mount/credits/api/session/logout',
  ])
})

it.each(['30', 'Mon, 26 Oct 2026 12:00:30 GMT'])('retains empty-body 429 metadata for account cooldowns: %s', async (retryAfter) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('', { status: 429,
    headers: { 'retry-after': retryAfter, date: 'Mon, 26 Oct 2026 12:00:00 GMT' } })))
  expect(await get('/credits/api/summary')).toMatchObject({ ok: false, httpStatus: 429, retryAfterSeconds: 30 })
})

it('does not treat a null response body as a successful account read', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(null)))
  expect(await get('/credits/api/session')).toMatchObject({ ok: false, code: 'INVALID_RESPONSE', httpStatus: 200 })
})
