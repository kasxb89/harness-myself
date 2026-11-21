/** Strict user-facing forum DTOs; moderation/contact metadata is never copied into snapshots. */
import type {
  ForumAttachment, ForumAuthor, ForumAvatar, ForumComment, ForumConfig, ForumPost, ForumMediaRules, ForumUploadRules,
} from './forum-types.ts'

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
  const name = forumText(row.display_name, 200, true), normalized = name.normalize('NFKC').replace(/[\s\p{Cf}().\-\u2010-\u2015\u2212]/gu, '')
  const phone = /(?:^|\D)\+?\d{7,15}(?!\d)/u.test(normalized)
    || normalized.match(/[\d*xX•●]{7,20}/gu)?.some(part => /[*xX•●]/u.test(part) && part.replace(/\D/gu, '').length >= 3) === true
  return { id, display_name: name === `论坛用户${id}` || !phone ? name : '',
    ...row.avatar === undefined ? {} : { avatar: profileAvatar(row.avatar) } }
}
function profileAvatar(value: unknown): ForumAvatar {
  const row = forumObject(value), size = forumInteger(row.size_bytes), expiry = forumInteger(row.expires_at)
  const digest = forumText(row.sha256, 64)
  const mime = forumText(row.mime_type, 128)
  if (row.kind !== 'image' || size < 1 || size > 20 * 1024 * 1024 || expiry < 1 || !/^[a-f\d]{64}$/u.test(digest)
    || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) throw new ForumWireError()
  return { id: forumUuid(row.id), kind: 'image', mime_type: mime, size_bytes: size, sha256: digest, expires_at: expiry }
}
/** Decode one ready forum-owned image or negotiated video; link endpoints are metadata, never sources.
 * @param value - Unknown attachment.
 * @returns Validated public media metadata.
 */
export function forumAttachment(value: unknown): ForumAttachment {
  const row = forumObject(value), id = forumUuid(row.id), mime = forumText(row.mime_type, 128)
  const size = forumInteger(row.size_bytes), sha256 = forumText(row.sha256, 64)
  const path = `/attachments/${id}/link`
  const kind = row.kind
  if (kind !== 'image' && kind !== 'video' || row.status !== 'ready'
    || (kind === 'video' ? mime !== 'video/mp4' : !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime))
    || size < 1 || !/^[a-f0-9]{64}$/u.test(sha256) || row.preview_path !== path || row.download_path !== path) throw new ForumWireError()
  return { id, name: forumText(row.name, 255), kind, mime_type: mime, size_bytes: size, sha256,
    status: 'ready', preview_path: path, download_path: path }
}
function attachments(value: unknown, video = false): readonly ForumAttachment[] {
  if (!Array.isArray(value) || value.length > 100) throw new ForumWireError()
  const items = value.map(forumAttachment)
  if (!video && items.some(item => item.kind !== 'image') || new Set(items.map(item => item.id)).size !== items.length) throw new ForumWireError()
  return items
}
/** Decode a post without moderator-only fields.
 * @param value - Unknown post.
 * @returns Public post.
 */
export function forumPost(value: unknown): ForumPost {
  const row = forumObject(value), images = row.attachments === undefined ? undefined : attachments(row.attachments)
  const media = row.media === undefined ? undefined : attachments(row.media, true)
  return { id: forumId(row.id), title: forumText(row.title, 200), body: forumText(row.body, 20_000, ((media ?? images)?.length ?? 0) > 0),
    author: forumAuthor(row.author), created_at: forumInteger(row.created_at), like_count: forumInteger(row.like_count),
    comment_count: forumInteger(row.comment_count), liked: forumBoolean(row.liked),
    ...images === undefined ? {} : { attachments: images }, ...media === undefined ? {} : { media } }
}
/** Decode one exact post's comment.
 * @param value - Unknown comment.
 * @param withPostTitle - Include the public title only on the authenticated personal-activity endpoint.
 * @returns Public comment.
 */
export function forumComment(value: unknown, withPostTitle = false): ForumComment {
  const row = forumObject(value), images = row.attachments === undefined ? undefined : attachments(row.attachments)
  const media = row.media === undefined ? undefined : attachments(row.media, true)
  const reply = row.reply_to_comment_id === undefined ? undefined
    : row.reply_to_comment_id === '' ? '' : forumId(row.reply_to_comment_id)
  return { id: forumId(row.id), post_id: forumId(row.post_id), body: forumText(row.body, 4000, ((media ?? images)?.length ?? 0) > 0),
    author: forumAuthor(row.author), created_at: forumInteger(row.created_at),
    ...images === undefined ? {} : { attachments: images }, ...media === undefined ? {} : { media },
    ...reply === undefined ? {} : { reply_to_comment_id: reply },
    ...row.reply_to_author === undefined ? {} : { reply_to_author: row.reply_to_author === null ? null : forumAuthor(row.reply_to_author) },
    ...!withPostTitle || row.post_title === undefined ? {} : { post_title: forumText(row.post_title, 200, true) } }
}
/** Decode the direct config data object.
 * @param value - Unknown config.
 * @returns Backend capabilities.
 */
export function forumConfig(value: unknown): ForumConfig {
  const row = forumObject(value), caps = forumObject(row.capabilities)
  const optional: Record<string, boolean> = {}
  for (const key of ['image_uploads', 'forum_media_v2', 'video_uploads', 'my_activity', 'comment_replies', 'notifications',
    'forum_profile', 'forum_profile_avatar_v1', 'receipt_lookup']) {
    if (caps[key] !== undefined) optional[key] = forumBoolean(caps[key])
  }
  const parseRules = (value: unknown, video: boolean): ForumUploadRules & { readonly max_video_bytes?: number } => {
    const input = forumObject(value)
    if (!Array.isArray(input.allowed_mime_types) || input.allowed_mime_types.length > 5) throw new ForumWireError()
    const types = input.allowed_mime_types.map(value => forumText(value, 128))
    const max = forumInteger(input.max_attachments), bytes = forumInteger(input.max_image_bytes)
    const chunk = forumInteger(input.chunk_bytes), ttl = forumInteger(input.upload_ttl_seconds)
    const videoBytes = video ? forumInteger(input.max_video_bytes) : undefined
    if ([max, bytes, chunk, ttl].some(value => value < 1) || types.length === 0 || videoBytes === 0
      || types.some(value => !['image/png', 'image/jpeg', 'image/gif', 'image/webp', ...video ? ['video/mp4'] : []].includes(value))
      || new Set(types).size !== types.length) throw new ForumWireError()
    return { max_attachments: max, max_image_bytes: bytes, chunk_bytes: chunk, upload_ttl_seconds: ttl, allowed_mime_types: types,
      ...videoBytes === undefined ? {} : { max_video_bytes: videoBytes } }
  }
  const combinedV2 = optional.forum_media_v2 === true && row.upload_rules_v2 === undefined
  const rules = combinedV2 || row.upload_rules === undefined ? undefined : parseRules(row.upload_rules, false)
  const rawV2 = combinedV2 ? row.upload_rules : row.upload_rules_v2
  const parsedV2 = rawV2 === undefined ? undefined : parseRules(rawV2, true)
  const rulesV2: ForumMediaRules | undefined = parsedV2?.max_video_bytes === undefined
    ? undefined : { ...parsedV2, max_video_bytes: parsedV2.max_video_bytes }
  if (optional.forum_media_v2 === true && rulesV2 === undefined
    || optional.video_uploads === true && (optional.forum_media_v2 !== true || rulesV2 === undefined)
    || optional.image_uploads === true && rules === undefined && (optional.forum_media_v2 !== true || rulesV2 === undefined)) {
    throw new ForumWireError()
  }
  return { revision: forumInteger(row.revision), enabled: forumBoolean(row.enabled), capabilities: {
    immediate_publish: forumBoolean(caps.immediate_publish), likes: forumBoolean(caps.likes), comments: forumBoolean(caps.comments),
    ...optional,
  }, ...rules === undefined ? {} : { upload_rules: rules }, ...rulesV2 === undefined ? {} : { upload_rules_v2: rulesV2 } }
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
