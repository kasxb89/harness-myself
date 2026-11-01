/** Public banner data read from the same-origin Host, never from an upstream address. @module */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'

export interface BannerAnnouncement {
  readonly id: number
  readonly title: string
  readonly content: string
  readonly publishDate: string
  readonly updatedAt: string | null
  readonly type: string
  readonly extra: string
}
export interface AnnouncementBannerData {
  readonly enabled: boolean
  readonly scope: string
  readonly revision: string
  readonly announcements: readonly BannerAnnouncement[]
}
export type AnnouncementBannerRead = { readonly ok: true; readonly payload: AnnouncementBannerData }
  | { readonly ok: false }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined

/** @param value - Untrusted Host payload. @returns Detached public fields or no data when malformed. */
export function parseAnnouncementBanner(value: unknown): AnnouncementBannerData | undefined {
  const body = object(value)
  if (typeof body?.enabled !== 'boolean' || !hash(body.scope) || !hash(body.revision)
    || !Array.isArray(body.announcements) || body.announcements.length > 100) return undefined
  const announcements: BannerAnnouncement[] = []
  for (const raw of body.announcements) {
    const entry = object(raw)
    if (!Number.isSafeInteger(entry?.id) || Number(entry?.id) < 1 || !text(entry?.title, 512)
      || !text(entry.content, 32_768) || entry.content.trim() === '' && entry.title.trim() === '' || !text(entry.publishDate, 128)
      || !Number.isFinite(Date.parse(entry.publishDate)) || entry.updatedAt !== null
      && (!text(entry.updatedAt, 128) || !Number.isFinite(Date.parse(entry.updatedAt)))
      || !text(entry.type, 64) || !text(entry.extra, 8192) || announcements.some(item => item.id === entry.id)) return undefined
    announcements.push({ id: Number(entry.id), title: entry.title, content: entry.content, publishDate: entry.publishDate,
      updatedAt: entry.updatedAt, type: entry.type, extra: entry.extra })
  }
  return { enabled: body.enabled, scope: body.scope, revision: body.revision,
    announcements: body.enabled ? announcements : [] }
}

/** @param signal - Current account and plugin lifetime. @returns Safe public data; errors never block the application. */
export async function readAnnouncementBanner(signal: AbortSignal): Promise<AnnouncementBannerRead> {
  try {
    const response = await fetch(appPath('/credits/api/announcement-banner'), {
      signal, headers: { accept: 'application/json' }, cache: 'no-store',
    })
    if (!response.ok) return { ok: false }
    const body = object(await response.json())
    const payload = body?.ok === true ? parseAnnouncementBanner(body.payload) : undefined
    return payload === undefined ? { ok: false } : { ok: true, payload }
  } catch (_readFailed: unknown) { return { ok: false } }
}
