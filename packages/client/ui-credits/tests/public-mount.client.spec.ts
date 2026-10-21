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
