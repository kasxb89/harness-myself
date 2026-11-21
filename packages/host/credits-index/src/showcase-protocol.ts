/** Closed public showcase projection; no customer attachment or administration routes are accepted. */
import { apiUrl, normalizeApiBaseUrl } from './api-url.ts'

/** Public API family containing only explicitly published case materials. */
export const SHOWCASE_UPSTREAM_BASE_PATH = '/api/product/demand-showcases'
/** Same-origin public case facade exposed by the current Host. */
export const SHOWCASE_LOCAL_BASE_PATH = '/credits/api/demand-showcases'
const categories = ['pc', 'web', 'miniapp', 'exe', 'game', 'image', 'video'] as const
type ObjectValue = Record<string, unknown>

/** Invalid or contradictory public showcase metadata. */
export class ShowcaseProtocolError extends Error { constructor() { super('SHOWCASE_PROTOCOL_INVALID') } }
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ShowcaseProtocolError()
  return value as ObjectValue
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || Array.from(value).length > maximum || !empty && value.trim() === ''
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(value)) throw new ShowcaseProtocolError()
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ShowcaseProtocolError()
  return value
}
/**
 * Validate an exact case or case-scoped attachment identity.
 * @param value - Untrusted public UUID.
 * @returns The unchanged validated UUID.
 */
export function showcaseId(value: unknown): string {
  const result = text(value, 36)
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(result)) throw new ShowcaseProtocolError()
  return result
}
function category(value: unknown): string {
  const result = text(value, 20)
  if (!categories.some(item => item === result)) throw new ShowcaseProtocolError()
  return result
}
function sourceUrl(value: unknown): string {
  if (value === undefined || value === '') return ''
  const result = text(value, 2048), url = new URL(result)
  if (url.username !== '' || url.password !== '' || /[\u0000-\u0020\\]/u.test(result)
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new ShowcaseProtocolError()
  return url.href
}
/**
 * Validate a case's public asset path and replace the authority with the current Host facade.
 * @param value - API-generated absolute or family-relative public URL.
 * @param caseId - Case owning this public asset.
 * @param baseUrl - Current validated API origin and deployment prefix.
 * @param assetId - Exact media attachment, if the field identifies one.
 * @returns Same-origin media path without arbitrary upstream authority or credentials.
 */
export function showcaseAssetPath(value: unknown, caseId: string, baseUrl: string, assetId?: string): string {
  const raw = text(value, 4096)
  if (/[\u0000-\u0020\\]/u.test(raw)) throw new ShowcaseProtocolError()
  const prefix = `${SHOWCASE_UPSTREAM_BASE_PATH}/assets/${showcaseId(caseId)}/`
  const relative = raw.startsWith(prefix) ? raw : undefined
  let path: string
  if (relative !== undefined) path = relative
  else {
    const url = new URL(raw), base = new URL(apiUrl(normalizeApiBaseUrl(baseUrl), SHOWCASE_UPSTREAM_BASE_PATH))
    if (url.origin !== base.origin || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new ShowcaseProtocolError()
    const expectedPrefix = `${base.pathname}/assets/${caseId}/`
    if (!url.pathname.startsWith(expectedPrefix)) throw new ShowcaseProtocolError()
    path = `${prefix}${url.pathname.slice(expectedPrefix.length)}`
  }
  const id = showcaseId(path.slice(prefix.length).replace(/\/content$/u, ''))
  if (path !== `${prefix}${id}/content` || assetId !== undefined && id !== showcaseId(assetId)) throw new ShowcaseProtocolError()
  return `${SHOWCASE_LOCAL_BASE_PATH}/assets/${caseId}/${id}/content`
}
function showcase(input: unknown, baseUrl: string): ObjectValue {
  const value = object(input), id = showcaseId(value.id)
  if (!Array.isArray(value.media) || value.media.length < 1 || value.media.length > 30) throw new ShowcaseProtocolError()
  const media = value.media.map((input: unknown) => {
    const row = object(input), mediaId = showcaseId(row.id), mime = text(row.mime_type, 128), size = integer(row.size_bytes)
    if (!['image', 'video'].includes(String(row.kind)) || !/^[a-f0-9]{64}$/u.test(String(row.sha256)) || size === 0
      || !(row.kind === 'image' ? ['image/png', 'image/jpeg', 'image/webp'].includes(mime)
        : ['video/mp4', 'video/webm', 'video/quicktime'].includes(mime))) throw new ShowcaseProtocolError()
    return { id: mediaId, kind: row.kind, mime_type: mime, size_bytes: size, sha256: row.sha256,
      url: showcaseAssetPath(row.url, id, baseUrl, mediaId),
      ...row.poster_url === undefined || row.poster_url === '' ? {} : { poster_url: showcaseAssetPath(row.poster_url, id, baseUrl) } }
  })
  if (new Set(media.map(item => item.id)).size !== media.length
    || value.synthetic !== undefined && typeof value.synthetic !== 'boolean') throw new ShowcaseProtocolError()
  return { id, title: text(value.title, 200), description: text(value.description, 4000), category: category(value.category),
    cover_url: showcaseAssetPath(value.cover_url, id, baseUrl), media,
    source_name: text(value.source_name ?? '', 100, true), source_url: sourceUrl(value.source_url),
    attribution: text(value.attribution ?? '', 1000, true),
    created_at: integer(value.created_at), updated_at: integer(value.updated_at) }
}
/**
 * Validate filters without passing arbitrary query fields to the public API.
 * @param kind - Fixed read operation.
 * @param input - Original query parameters.
 * @returns A detached validated query.
 */
export function showcaseQuery(kind: 'config' | 'list' | 'detail' | 'content', input: URLSearchParams): URLSearchParams {
  const output = new URLSearchParams()
  for (const [key, value] of input) {
    if (kind !== 'list' || !['limit', 'cursor', 'category', 'query'].includes(key) || output.has(key)) throw new ShowcaseProtocolError()
    if (key === 'limit') {
      if (!/^\d{1,3}$/u.test(value) || Number(value) < 1 || Number(value) > 100) throw new ShowcaseProtocolError()
    } else if (key === 'category') category(value)
    else text(value, key === 'query' ? 200 : 2048, true)
    output.set(key, value)
  }
  return output
}
/**
 * Project only public fields and bind every media URL to the configured case API.
 * @param kind - Fixed metadata read operation.
 * @param input - API envelope's untrusted data.
 * @param baseUrl - Current API origin and optional deployment prefix.
 * @returns A detached public payload without admin or storage metadata.
 */
export function showcaseResponse(kind: 'config' | 'list' | 'detail', input: unknown, baseUrl: string): ObjectValue {
  const value = object(input)
  if (kind === 'config') {
    const caps = value.capabilities === undefined ? {} : object(value.capabilities)
    if (caps.showcases_v1 === undefined || caps.showcases_v1 === false) return { capabilities: { showcases_v1: false }, categories: [] }
    if (caps.showcases_v1 !== true || caps.pagination !== true || caps.public_ready_media !== true || !Array.isArray(value.categories)
      || value.categories.length > categories.length) throw new ShowcaseProtocolError()
    const available = value.categories.map(category)
    if (new Set(available).size !== available.length || available.length === 0) throw new ShowcaseProtocolError()
    return { capabilities: { showcases_v1: true, pagination: true, public_ready_media: true }, categories: available }
  }
  if (kind === 'detail') return { item: showcase(value.item, baseUrl) }
  if (!Array.isArray(value.items) || value.items.length > 100 || typeof value.has_more !== 'boolean') throw new ShowcaseProtocolError()
  const items = value.items.map(item => showcase(item, baseUrl))
  const cursor = text(value.next_cursor, 2048, true), total = integer(value.total_count)
  if (new Set(items.map(item => item.id)).size !== items.length || total < items.length
    || value.has_more && (cursor === '' || items.length === 0 || total <= items.length) || !value.has_more && cursor !== '') throw new ShowcaseProtocolError()
  return { items, next_cursor: cursor, has_more: value.has_more, total_count: total }
}
