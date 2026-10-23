/** Read-only announcements from the connected Host; upstream addresses and credentials stay there. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'

/** Public plain-text announcement selected by the Host from the deployment status. */
export interface Announcement {
  readonly content: string
  readonly publishDate: string
  readonly extra?: string
}

/** Safe read states displayed by the announcements dialog. */
export type AnnouncementRead = { readonly ok: true; readonly enabled: boolean; readonly items: readonly Announcement[] }
  | { readonly ok: false; readonly reason: 'unsupported' | 'network' | 'unavailable' | 'invalid' | 'authorization' | 'account-changed' }

/**
 * Read the current deployment's announcement without retaining content across opens.
 * @param signal - Dialog lifetime or explicit retry cancellation.
 * @returns Plain text or a safe failure category, never an upstream diagnostic.
 */
export async function readAnnouncements(signal: AbortSignal): Promise<AnnouncementRead> {
  let response: Response
  try {
    response = await fetch(appPath('/credits/api/announcements'), {
      headers: { accept: 'application/json' }, signal, cache: 'no-store',
    })
  } catch (_transportFailed: unknown) { return { ok: false, reason: 'network' } }
  if (response.status === 404) return { ok: false, reason: 'unsupported' }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'authorization' }
  if (!response.ok) return { ok: false, reason: 'unavailable' }
  let value: unknown
  try { value = await response.json() } catch (error: unknown) {
    return { ok: false, reason: error instanceof SyntaxError ? 'invalid' : 'network' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid' }
  const body = value as Record<string, unknown>
  if (body.ok === false) {
    const reasons = {
      ANNOUNCEMENTS_UNSUPPORTED: 'unsupported', ANNOUNCEMENTS_NETWORK: 'network',
      ANNOUNCEMENTS_UNAVAILABLE: 'unavailable', ANNOUNCEMENTS_INVALID: 'invalid', ACCOUNT_CHANGED: 'account-changed',
    } as const
    const key = typeof body.code === 'string' ? body.code : ''
    return { ok: false, reason: Object.hasOwn(reasons, key) ? reasons[key as keyof typeof reasons] : 'unavailable' }
  }
  const payload = body.payload
  if (body.ok !== true || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid' }
  }
  const fields = payload as Record<string, unknown>
  if (typeof fields.enabled !== 'boolean' || !Array.isArray(fields.items)) return { ok: false, reason: 'invalid' }
  const items: Announcement[] = []
  for (const entry of fields.items) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'invalid' }
    const item = entry as Record<string, unknown>
    if (typeof item.content !== 'string' || item.content.trim() === '' || typeof item.publishDate !== 'string'
      || !Number.isFinite(Date.parse(item.publishDate)) || (item.extra !== undefined && typeof item.extra !== 'string')) {
      return { ok: false, reason: 'invalid' }
    }
    items.push({ content: item.content, publishDate: item.publishDate, ...typeof item.extra === 'string' ? { extra: item.extra } : {} })
  }
  return { ok: true, enabled: fields.enabled, items: fields.enabled ? items : [] }
}
