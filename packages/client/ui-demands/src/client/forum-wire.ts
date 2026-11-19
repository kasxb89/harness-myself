/** Strict user-facing forum DTOs; moderation/contact metadata is never copied into snapshots. */
import type { ForumAuthor, ForumComment, ForumConfig, ForumPost } from './forum-types.ts'

/** Invalid or contradictory forum protocol data. */
export class ForumWireError extends Error { constructor() { super('FORUM_PROTOCOL_INVALID') } }
/** Require a JSON record.
 * @param value - Unknown JSON.
 * @returns Validated record.
 */
export function forumObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ForumWireError()
  return value as Record<string, unknown>
}
/** Parse JSON without trusting its shape.
 * @param value - Raw JSON.
 * @returns Unknown JSON value.
 */
export function forumJson(value: string): unknown { return JSON.parse(value) }
/**
 * Validate bounded Unicode text without control characters or lone surrogates.
 * @param value - Unknown text.
 * @param maximum - Unicode scalar limit.
 * @param empty - Whether whitespace-only text is permitted.
 * @returns Original valid text.
 */
export function forumText(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || Array.from(value).length > maximum || !empty && value.trim() === ''
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new ForumWireError()
  for (const scalar of value) {
    const code = scalar.codePointAt(0) ?? 0
    if (code >= 0xD800 && code <= 0xDFFF) throw new ForumWireError()
  }
  return value
}
/** Require a safe content ID.
 * @param value - Unknown ID.
 * @returns Valid path segment.
 */
export function forumId(value: unknown): string {
  const text = forumText(value, 40)
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) throw new ForumWireError()
  return text
}
/** Require a durable local UUID.
 * @param value - Unknown key.
 * @returns UUID.
 */
export function forumUuid(value: unknown): string {
  const text = forumText(value, 36)
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(text)) throw new ForumWireError()
  return text
}
/** Require a nonnegative integer.
 * @param value - Unknown number.
 * @returns Safe integer.
 */
export function forumInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ForumWireError()
  return value
}
/** Require a boolean.
 * @param value - Unknown flag.
 * @returns Boolean.
 */
export function forumBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ForumWireError()
  return value
}
/** Decode a public author.
 * @param value - Unknown author.
 * @returns Public identity.
 */
export function forumAuthor(value: unknown): ForumAuthor {
  const row = forumObject(value), id = forumInteger(row.id)
  if (id === 0) throw new ForumWireError()
  return { id, display_name: forumText(row.display_name, 200, true) }
}
/** Decode a post without moderator-only fields.
 * @param value - Unknown post.
 * @returns Public post.
 */
export function forumPost(value: unknown): ForumPost {
  const row = forumObject(value)
  return { id: forumId(row.id), title: forumText(row.title, 200), body: forumText(row.body, 20_000),
    author: forumAuthor(row.author), created_at: forumInteger(row.created_at), like_count: forumInteger(row.like_count),
    comment_count: forumInteger(row.comment_count), liked: forumBoolean(row.liked) }
}
/** Decode one exact post's comment.
 * @param value - Unknown comment.
 * @returns Public comment.
 */
export function forumComment(value: unknown): ForumComment {
  const row = forumObject(value)
  return { id: forumId(row.id), post_id: forumId(row.post_id), body: forumText(row.body, 4000),
    author: forumAuthor(row.author), created_at: forumInteger(row.created_at) }
}
/** Decode the direct config data object.
 * @param value - Unknown config.
 * @returns Backend capabilities.
 */
export function forumConfig(value: unknown): ForumConfig {
  const row = forumObject(value), caps = forumObject(row.capabilities)
  return { revision: forumInteger(row.revision), enabled: forumBoolean(row.enabled), capabilities: {
    immediate_publish: forumBoolean(caps.immediate_publish), likes: forumBoolean(caps.likes), comments: forumBoolean(caps.comments),
  } }
}
/** Exact cursor page returned by the forum API. */
export interface ForumWirePage<T> { readonly items: readonly T[]; readonly next_cursor: string; readonly has_more: boolean }
/**
 * Decode a bounded cursor page and reject duplicate IDs.
 * @param value - Unknown page.
 * @param parse - Record decoder.
 * @returns Validated page.
 */
export function forumPage<T extends { readonly id: string }>(value: unknown, parse: (value: unknown) => T): ForumWirePage<T> {
  const row = forumObject(value), cursor = forumText(row.next_cursor, 256, true), more = forumBoolean(row.has_more)
  if (!Array.isArray(row.items) || row.items.length > 100 || more && cursor === '') throw new ForumWireError()
  const items = row.items.map(parse)
  if (new Set(items.map(item => item.id)).size !== items.length) throw new ForumWireError()
  return { items, next_cursor: cursor, has_more: more }
}
