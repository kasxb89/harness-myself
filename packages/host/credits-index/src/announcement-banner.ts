/** Deployment-controlled, credential-free top announcements with stable dismissal identities. */
import { createHash } from 'node:crypto'
import { readPublicStatus } from './public-status.ts'

/** Public plain-text fields retained for the top carousel and its details. */
export interface AnnouncementBannerItem {
  readonly id: number
  readonly title: string
  readonly content: string
  readonly publishDate: string
  readonly updatedAt: string | null
  readonly type: string
  readonly extra: string
}

/** Public banner state; scope never includes an exposed backend address or credential. */
export interface AnnouncementBannerPayload {
  readonly enabled: boolean
  readonly scope: string
  readonly revision: string
  readonly announcements: readonly AnnouncementBannerItem[]
}

/** Safe local response; transport errors cannot expose upstream response bodies. */
export type AnnouncementBannerResponse = { readonly ok: true; readonly payload: AnnouncementBannerPayload }
  | {
    readonly ok: false
    readonly code: 'ANNOUNCEMENT_BANNER_NETWORK' | 'ANNOUNCEMENT_BANNER_TIMEOUT'
    | 'ANNOUNCEMENT_BANNER_UNAVAILABLE' | 'ANNOUNCEMENT_BANNER_INVALID' }

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function time(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && value.trim() === value && Number.isFinite(Date.parse(value))
}
function payload(apiBaseUrl: string, enabled: boolean, announcements: readonly AnnouncementBannerItem[]): AnnouncementBannerPayload {
  const deployment = new URL(apiBaseUrl)
  deployment.hash = ''; deployment.search = ''; deployment.username = ''; deployment.password = ''
  return { enabled, scope: digest(deployment.href.replace(/\/+$/u, '')), revision: digest(JSON.stringify(announcements)), announcements }
}

/**
 * Select only published, inert announcements; absence of the new switch never enables a banner.
 * @param value - Decoded public feed JSON from the configured deployment.
 * @param apiBaseUrl - Bound backend URL, used only to derive an opaque preference scope.
 * @param now - Current milliseconds used to omit future publication dates.
 * @returns A stable public projection or a non-sensitive protocol failure.
 */
export function parseAnnouncementBanner(value: unknown, apiBaseUrl: string, now = Date.now()): AnnouncementBannerResponse {
  const invalid: AnnouncementBannerResponse = { ok: false, code: 'ANNOUNCEMENT_BANNER_INVALID' }
  const body = record(value), data = record(body?.data)
  if (body?.success !== true || data?.schema_version !== 1 || data.content_format !== 'plain_text' || !Number.isFinite(now)) return invalid
  if (data.top_banner_enabled !== true || data.announcements_enabled !== true) {
    return { ok: true, payload: payload(apiBaseUrl, false, []) }
  }
  if (!Array.isArray(data.announcements)) return invalid
  const announcements: AnnouncementBannerItem[] = [], ids = new Set<number>()
  for (const raw of data.announcements) {
    const item = record(raw)
    if (item === undefined || typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id)
      || typeof item.title !== 'string' || typeof item.content !== 'string' || !time(item.publishDate)
      || item.updatedAt !== null && !time(item.updatedAt) || typeof item.type !== 'string' || typeof item.extra !== 'string') return invalid
    ids.add(item.id)
    if (Date.parse(item.publishDate) > now || (item.title.trim() === '' && item.content.trim() === '')) continue
    announcements.push({ id: item.id, title: item.title, content: item.content, publishDate: item.publishDate,
      updatedAt: item.updatedAt, type: item.type, extra: item.extra })
  }
  return { ok: true, payload: payload(apiBaseUrl, true, announcements) }
}

/**
 * Read the independent public feed without credentials, redirects, or a retained server-side cache.
 * @param fetchFeed - Deployment-bound GET with no account authentication or redirect following.
 * @param signal - Host plugin, request, disconnect and deadline lifetime.
 * @param apiBaseUrl - Bound deployment used for the stable dismissal scope.
 * @returns Safe published content; an older API without the route is a disabled banner.
 */
export async function readAnnouncementBanner(
  fetchFeed: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal, apiBaseUrl: string,
): Promise<AnnouncementBannerResponse> {
  const result = await readPublicStatus(fetchFeed, signal)
  if (result.ok) return parseAnnouncementBanner(result.value, apiBaseUrl)
  if (result.reason === 'unsupported') return { ok: true, payload: payload(apiBaseUrl, false, []) }
  const codes = { network: 'ANNOUNCEMENT_BANNER_NETWORK', timeout: 'ANNOUNCEMENT_BANNER_TIMEOUT',
    unavailable: 'ANNOUNCEMENT_BANNER_UNAVAILABLE', invalid: 'ANNOUNCEMENT_BANNER_INVALID' } as const
  return { ok: false, code: codes[result.reason] }
}
