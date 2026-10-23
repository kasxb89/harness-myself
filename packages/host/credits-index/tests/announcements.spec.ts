/** Existing API status handler fixtures remain the source of announcement compatibility. */
import { expect, it } from 'vitest'
import fixtures from './fixtures/announcements-api-contract.json' with { type: 'json' }
import { parseAnnouncements, readAnnouncements } from '../src/announcements.ts'

it.each(fixtures)('reads the actual status projection: $case', async (fixture) => {
  const result = await readAnnouncements(async () => Response.json(fixture.response, { status: fixture.http_status }),
    new AbortController().signal)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  const source = fixture.response.data.announcements
  expect(result.payload.enabled).toBe(fixture.response.data.announcements_enabled)
  expect(result.payload.items).toEqual(Array.isArray(source) ? source.map(item => ({ content: item.content,
    publishDate: item.publishDate, ...typeof item.extra === 'string' ? { extra: item.extra } : {} })) : [])
  expect(JSON.stringify(result)).not.toMatch(/"(?:id|type)":/u)
})

it('ignores unrelated status data and unsupported optional fields without interpreting HTML or future dates', () => {
  expect(parseAnnouncements({ success: true, data: { secret_setting: 'must not leave Host', announcements_enabled: true,
    announcements: [{ id: 5, type: 'future-type', content: '<script>future()</script>', publishDate: '2099-01-01T00:00:00Z', extra: { unknown: true } }] } }))
    .toEqual({ ok: true, payload: { enabled: true, items: [{ content: '<script>future()</script>', publishDate: '2099-01-01T00:00:00Z' }] } })
})

it.each([
  [null, 'ANNOUNCEMENTS_INVALID'], [{ success: false, data: {} }, 'ANNOUNCEMENTS_INVALID'],
  [{ success: true, data: {} }, 'ANNOUNCEMENTS_UNSUPPORTED'],
  [{ success: true, data: { announcements_enabled: 'true' } }, 'ANNOUNCEMENTS_INVALID'],
  [{ success: true, data: { announcements_enabled: true } }, 'ANNOUNCEMENTS_INVALID'],
  [{ success: true, data: { announcements_enabled: true, announcements: [{ content: '', publishDate: 'bad' }] } }, 'ANNOUNCEMENTS_INVALID'],
] as const)('rejects an unavailable or invalid announcement declaration %#', (value, code) => {
  expect(parseAnnouncements(value)).toEqual({ ok: false, code })
})

it.each([[404, 'ANNOUNCEMENTS_UNSUPPORTED'], [503, 'ANNOUNCEMENTS_UNAVAILABLE'], [403, 'ANNOUNCEMENTS_UNAVAILABLE']] as const)(
  'keeps observed HTTP %s separate from an empty announcement', async (status, code) => {
    expect(await readAnnouncements(async () => new Response('private upstream diagnostic', { status }), new AbortController().signal))
      .toEqual({ ok: false, code })
  },
)

it('contains transport, malformed JSON, oversized and interrupted response bodies', async () => {
  const signal = new AbortController().signal
  expect(await readAnnouncements(async () => { throw new TypeError('private network detail') }, signal))
    .toEqual({ ok: false, code: 'ANNOUNCEMENTS_NETWORK' })
  expect(await readAnnouncements(async () => new Response('{invalid'), signal)).toEqual({ ok: false, code: 'ANNOUNCEMENTS_INVALID' })
  expect(await readAnnouncements(async () => new Response('x'.repeat(1_048_577)), signal)).toEqual({ ok: false, code: 'ANNOUNCEMENTS_INVALID' })
  expect(await readAnnouncements(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('interrupted network')) },
  })), signal)).toEqual({ ok: false, code: 'ANNOUNCEMENTS_NETWORK' })
})
