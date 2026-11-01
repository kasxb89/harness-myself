/** Public banner visibility, published versions and transport failures stay independent of legacy dialogs. */
import { expect, it } from 'vitest'
import { parseAnnouncementBanner, readAnnouncementBanner } from '../src/announcement-banner.ts'
import enabled from './fixtures/announcement-banner-api/feed-banner-enabled.json' with { type: 'json' }
import updated from './fixtures/announcement-banner-api/feed-banner-updated.json' with { type: 'json' }
import disabled from './fixtures/announcement-banner-api/feed-banner-disabled.json' with { type: 'json' }
import masterDisabled from './fixtures/announcement-banner-api/feed-master-disabled.json' with { type: 'json' }
import empty from './fixtures/announcement-banner-api/top-enabled-empty.json' with { type: 'json' }

const backend = 'https://service.example/harness'
const now = Date.parse('2026-11-01T13:10:00Z')
const announcement = { id: 1, title: '公告', content: '正文', publishDate: '2026-11-01T13:00:00Z',
  updatedAt: null, type: 'default', extra: '' }
const feed = (data = {}) => ({ success: true, message: '', data: { schema_version: 1, content_format: 'plain_text',
  announcements_enabled: true, top_banner_enabled: true, announcements: [announcement], ...data } })

it('keeps the published feed order and strips all unrelated public fields', () => {
  const second = { ...announcement, id: 2, title: '较新', publishDate: '2026-11-01T13:01:00Z', private: 'must not leave Host' }
  const result = parseAnnouncementBanner(feed({ announcements: [second, { ...announcement, private: 'hidden' }] }), backend, now)
  expect(result).toMatchObject({ ok: true, payload: { enabled: true, announcements: [
    { id: 2, title: '较新' }, { id: 1, title: '公告' },
  ] } })
  expect(JSON.stringify(result)).not.toContain('private')
  expect(JSON.stringify(result)).not.toContain('service.example')
  if (!result.ok) throw new Error(result.code)
  expect(result.payload.scope).toMatch(/^[a-f0-9]{64}$/u)
  expect(result.payload.revision).toMatch(/^[a-f0-9]{64}$/u)
})

it.each([undefined, null, false, 'true', 1])('does not enable an absent, disabled or invalid top switch: %s', (top_banner_enabled) => {
  expect(parseAnnouncementBanner(feed({ top_banner_enabled }), backend, now)).toMatchObject({ ok: true,
    payload: { enabled: false, announcements: [] } })
})

it('honors the total switch and suppresses future or empty entries without hiding published content', () => {
  expect(parseAnnouncementBanner(feed({ announcements_enabled: false }), backend, now)).toMatchObject({ ok: true,
    payload: { enabled: false, announcements: [] } })
  expect(parseAnnouncementBanner(feed({ announcements: [announcement,
    { ...announcement, id: 2, publishDate: '2099-01-01T00:00:00Z' }, { ...announcement, id: 3, title: '', content: ' ' }] }), backend, now))
    .toMatchObject({ ok: true, payload: { announcements: [announcement] } })
})

it('keeps a dismissal revision stable until published display content changes', () => {
  const first = parseAnnouncementBanner(feed(), backend, now)
  const repeat = parseAnnouncementBanner(feed({ updated_at: '2026-11-01T13:09:00Z', secret: 'new unrelated value' }), `${backend}/`, now)
  expect(repeat).toEqual(first)
  const edited = parseAnnouncementBanner(feed({ announcements: [{ ...announcement, content: '新版正文' }] }), backend, now)
  const timestamp = parseAnnouncementBanner(feed({ announcements: [{ ...announcement, updatedAt: '2026-11-01T13:09:00Z' }] }), backend, now)
  if (!first.ok || !edited.ok || !timestamp.ok) throw new Error('Expected valid public feeds')
  expect(edited.payload.revision).not.toBe(first.payload.revision)
  expect(timestamp.payload.revision).not.toBe(first.payload.revision)
  const other = parseAnnouncementBanner(feed(), 'https://other.example/harness', now)
  if (!other.ok) throw new Error(other.code)
  expect(other.payload.scope).not.toBe(first.payload.scope)
})

it.each([null, {}, feed({ schema_version: 2 }), feed({ content_format: 'html' }), feed({ announcements: null }),
  feed({ announcements: [{ ...announcement, id: 0 }] }), feed({ announcements: [announcement, announcement] }),
  feed({ announcements: [{ ...announcement, updatedAt: 'bad' }] }),
  feed({ announcements: [{ ...announcement, publishDate: 'bad' }] }),
])('rejects malformed enabled feed %# without forwarding the response', (value) => {
  expect(parseAnnouncementBanner(value, backend, now)).toEqual({ ok: false, code: 'ANNOUNCEMENT_BANNER_INVALID' })
})

it('leaves HTML-like text inert for React text rendering', () => {
  expect(parseAnnouncementBanner(feed({ announcements: [{ ...announcement, content: '<script>alert(1)</script>' }] }), backend, now))
    .toMatchObject({ ok: true, payload: { announcements: [{ content: '<script>alert(1)</script>' }] } })
})

it('treats an older API as disabled while keeping network, timeout, status and malformed-body failures distinct', async () => {
  const signal = new AbortController().signal
  expect(await readAnnouncementBanner(async () => new Response('not found', { status: 404 }), signal, backend))
    .toMatchObject({ ok: true, payload: { enabled: false, announcements: [] } })
  expect(await readAnnouncementBanner(async () => { throw new TypeError('private diagnostic') }, signal, backend))
    .toEqual({ ok: false, code: 'ANNOUNCEMENT_BANNER_NETWORK' })
  expect(await readAnnouncementBanner(async () => new Response('private body', { status: 503 }), signal, backend))
    .toEqual({ ok: false, code: 'ANNOUNCEMENT_BANNER_UNAVAILABLE' })
  expect(await readAnnouncementBanner(async () => new Response('{invalid'), signal, backend))
    .toEqual({ ok: false, code: 'ANNOUNCEMENT_BANNER_INVALID' })
  expect(await readAnnouncementBanner(async () => new Response('x'.repeat(1_048_577)), signal, backend))
    .toEqual({ ok: false, code: 'ANNOUNCEMENT_BANNER_INVALID' })
  const timeout = new AbortController(); timeout.abort(new DOMException('deadline', 'TimeoutError'))
  expect(await readAnnouncementBanner(async () => Response.json(feed()), timeout.signal, backend))
    .toEqual({ ok: false, code: 'ANNOUNCEMENT_BANNER_TIMEOUT' })
})


it('consumes actual public API feed fixtures without mixing the two announcement switches', () => {
  const initial = parseAnnouncementBanner(enabled, backend)
  const edited = parseAnnouncementBanner(updated, backend)
  expect(initial).toMatchObject({ ok: true, payload: { enabled: true } })
  expect(edited).toMatchObject({ ok: true, payload: { enabled: true } })
  if (!initial.ok || !edited.ok) throw new Error('Expected actual API fixtures')
  expect(initial.payload.announcements).toHaveLength(2)
  expect(edited.payload.revision).not.toBe(initial.payload.revision)
  for (const value of [disabled, masterDisabled]) {
    expect(parseAnnouncementBanner(value, backend)).toMatchObject({ ok: true, payload: { enabled: false, announcements: [] } })
  }
  expect(parseAnnouncementBanner(empty, backend)).toMatchObject({ ok: true, payload: { enabled: true, announcements: [] } })
})
