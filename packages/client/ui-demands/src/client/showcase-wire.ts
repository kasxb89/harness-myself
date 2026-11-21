/** Strict public showcase metadata emitted by the local Host facade. */
import type { CaseShowcaseCategory, CaseShowcaseItem, CaseShowcaseMedia } from './case-showcase-types.ts'
const categories = ['pc', 'web', 'miniapp', 'exe', 'game', 'image', 'video'] as const
/** Invalid or contradictory public case response. */
export class ShowcaseWireError extends Error { constructor() { super('SHOWCASE_PROTOCOL_INVALID') } }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ShowcaseWireError()
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || Array.from(value).length > maximum || !empty && value.trim() === ''
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(value)) throw new ShowcaseWireError()
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ShowcaseWireError()
  return value
}
function id(value: unknown): string {
  const result = text(value, 36)
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(result)) throw new ShowcaseWireError()
  return result
}
function category(value: unknown): CaseShowcaseCategory {
  if (!categories.some(item => item === value)) throw new ShowcaseWireError()
  return value as CaseShowcaseCategory
}
function assetUrl(value: unknown, owner: string, assetId?: string): string {
  const result = text(value, 256), prefix = `/credits/api/demand-showcases/assets/${owner}/`
  if (!result.startsWith(prefix) || !result.endsWith('/content')) throw new ShowcaseWireError()
  const target = id(result.slice(prefix.length, -'/content'.length))
  if (result !== `${prefix}${target}/content` || assetId !== undefined && assetId !== target) throw new ShowcaseWireError()
  return result
}
function item(input: unknown): CaseShowcaseItem {
  const value = object(input), owner = id(value.id)
  if (!Array.isArray(value.media) || value.media.length === 0 || value.media.length > 30) throw new ShowcaseWireError()
  const seen = new Set<string>()
  const media = value.media.map((input: unknown): CaseShowcaseMedia => {
    const row = object(input), asset = id(row.id), mime = text(row.mime_type, 128)
    if (seen.has(asset) || row.kind !== 'image' && row.kind !== 'video' || integer(row.size_bytes) === 0
      || !/^[a-f0-9]{64}$/u.test(String(row.sha256)) || !(row.kind === 'image' ? ['image/png', 'image/jpeg', 'image/webp'].includes(mime)
      : ['video/mp4', 'video/webm', 'video/quicktime'].includes(mime))) throw new ShowcaseWireError()
    seen.add(asset)
    return { kind: row.kind, url: assetUrl(row.url, owner, asset),
      ...row.poster_url === undefined || row.poster_url === '' ? {} : { posterUrl: assetUrl(row.poster_url, owner) } }
  })
  const source = text(value.source_url ?? '', 2048, true)
  if (source !== '') {
    const url = new URL(source)
    if (url.username !== '' || url.password !== '' || /[\u0000-\u0020\\]/u.test(source)
      || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new ShowcaseWireError()
  }
  if (value.synthetic !== undefined && typeof value.synthetic !== 'boolean') throw new ShowcaseWireError()
  integer(value.created_at); integer(value.updated_at)
  return { id: owner, title: text(value.title, 200), description: text(value.description, 4000), category: category(value.category),
    coverUrl: assetUrl(value.cover_url, owner), media, sourceName: text(value.source_name ?? '', 100, true),
    sourceUrl: source, attribution: text(value.attribution ?? '', 1000, true) }
}
/**
 * Decode explicit public capability without guessing support from existing local cases.
 * @param input - Validated Host payload.
 * @returns Negotiated capability and allowed filter categories.
 */
export function showcaseConfig(input: unknown): { supported: boolean; categories: readonly CaseShowcaseCategory[] } {
  const value = object(input), caps = value.capabilities === undefined ? {} : object(value.capabilities)
  if (caps.showcases_v1 === undefined || caps.showcases_v1 === false) return { supported: false, categories: [] }
  if (caps.showcases_v1 !== true || caps.pagination !== true || caps.public_ready_media !== true || !Array.isArray(value.categories)
    || value.categories.length < 1 || value.categories.length > categories.length) throw new ShowcaseWireError()
  const rows = value.categories.map(category)
  if (new Set(rows).size !== rows.length) throw new ShowcaseWireError()
  return { supported: true, categories: rows }
}
/**
 * Decode one live server-filtered page without losing its original cursor or media binding.
 * @param input - Untrusted local Host payload.
 * @returns Detached case cards and validated continuation metadata.
 */
export function showcasePage(input: unknown): { items: readonly CaseShowcaseItem[]; cursor: string; more: boolean; total: number } {
  const value = object(input)
  if (!Array.isArray(value.items) || value.items.length > 100 || typeof value.has_more !== 'boolean') throw new ShowcaseWireError()
  const items = value.items.map(item), cursor = text(value.next_cursor, 2048, true), total = integer(value.total_count)
  if (new Set(items.map(row => row.id)).size !== items.length || total < items.length
    || value.has_more && (cursor === '' || items.length === 0 || total <= items.length) || !value.has_more && cursor !== '') throw new ShowcaseWireError()
  return { items, cursor, more: value.has_more, total }
}
