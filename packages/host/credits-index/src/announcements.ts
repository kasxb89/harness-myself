/** Public deployment announcements selected from status without account credentials or HTML rendering. */

/** Fields retained for the announcement dialog; unrelated public status settings are excluded. */
export interface Announcement {
  readonly content: string
  readonly publishDate: string
  readonly extra?: string
}

/** Safe announcement response returned by the authenticated Host route. */
export type AnnouncementResponse = {
  readonly ok: true
  readonly payload: {
    readonly enabled: boolean
    readonly items: readonly Announcement[]
  }
} | {
  readonly ok: false
  readonly code: 'ANNOUNCEMENTS_UNSUPPORTED' | 'ANNOUNCEMENTS_NETWORK' | 'ANNOUNCEMENTS_UNAVAILABLE' | 'ANNOUNCEMENTS_INVALID'
}

/**
 * Select the existing public status announcement fields; a missing switch identifies an older service.
 * @param value - Decoded API status JSON.
 * @returns The enabled list or a safe unsupported/invalid response.
 */
export function parseAnnouncements(value: unknown): AnnouncementResponse {
  const record = (input: unknown): Record<string, unknown> | null =>
    input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
  const body = record(value)
  const data = record(body?.data)
  if (body?.success !== true || data === null) return { ok: false, code: 'ANNOUNCEMENTS_INVALID' }
  if (!Object.hasOwn(data, 'announcements_enabled')) return { ok: false, code: 'ANNOUNCEMENTS_UNSUPPORTED' }
  if (typeof data.announcements_enabled !== 'boolean') return { ok: false, code: 'ANNOUNCEMENTS_INVALID' }
  if (!data.announcements_enabled) return { ok: true, payload: { enabled: false, items: [] } }
  if (data.announcements === null) return { ok: true, payload: { enabled: true, items: [] } }
  if (!Array.isArray(data.announcements)) return { ok: false, code: 'ANNOUNCEMENTS_INVALID' }
  const items: Announcement[] = []
  for (const raw of data.announcements) {
    const item = record(raw)
    if (typeof item?.content !== 'string' || item.content.trim() === '' || typeof item.publishDate !== 'string'
      || !Number.isFinite(Date.parse(item.publishDate))) return { ok: false, code: 'ANNOUNCEMENTS_INVALID' }
    items.push({ content: item.content, publishDate: item.publishDate,
      ...typeof item.extra === 'string' ? { extra: item.extra } : {} })
  }
  return { ok: true, payload: { enabled: true, items } }
}

/**
 * Read one public status response with bounded memory and no retained announcement cache.
 * @param fetchStatus - Deployment-bound, credential-free status request.
 * @param signal - Request, plugin and configured deadline lifetime.
 * @returns Only safe announcement data or an observed read-failure category.
 */
export async function readAnnouncements(
  fetchStatus: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal,
): Promise<AnnouncementResponse> {
  let response: Response
  try { response = await fetchStatus(signal) } catch (_transportFailed: unknown) { return { ok: false, code: 'ANNOUNCEMENTS_NETWORK' } }
  if (response.status === 404) {
    await response.body?.cancel().catch((_cancelledBody: unknown) => {})
    return { ok: false, code: 'ANNOUNCEMENTS_UNSUPPORTED' }
  }
  if (!response.ok) {
    await response.body?.cancel().catch((_cancelledBody: unknown) => {})
    return { ok: false, code: 'ANNOUNCEMENTS_UNAVAILABLE' }
  }
  if (response.body === null) return { ok: false, code: 'ANNOUNCEMENTS_INVALID' }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > 1_048_576) return { ok: false, code: 'ANNOUNCEMENTS_INVALID' }
      chunks.push(chunk.value)
    }
  } catch (_interruptedBody: unknown) { return { ok: false, code: 'ANNOUNCEMENTS_NETWORK' } }
  finally { await reader.cancel().catch((_cancelledBody: unknown) => {}) }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch (_invalidJson: unknown) { return { ok: false, code: 'ANNOUNCEMENTS_INVALID' } }
  return parseAnnouncements(value)
}
