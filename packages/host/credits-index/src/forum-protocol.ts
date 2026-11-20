/** Strict public forum projections, separate from private demands and community orders. */
import { DemandProtocolError, demandInteger, demandObject, demandText, type DemandObject } from './demand-protocol.ts'

/** Domain error codes may be shown without forwarding upstream diagnostic messages. */
export const FORUM_ERRORS: ReadonlySet<string> = new Set([
  'FORUM_AUTH_REQUIRED', 'FORUM_FORBIDDEN', 'FORUM_INVALID_INPUT', 'FORUM_CURSOR_INVALID', 'FORUM_CLOSED',
  'FORUM_NOT_FOUND', 'FORUM_REQUEST_CONFLICT', 'FORUM_REVISION_CONFLICT', 'FORUM_UNAVAILABLE',
  'FORUM_PROFILE_INVALID', 'FORUM_UPLOAD_OFFSET_CONFLICT', 'FORUM_ATTACHMENT_INVALID',
  'FORUM_UPLOAD_UNSUPPORTED', 'FORUM_UPLOAD_TOO_LARGE', 'FORUM_IDEMPOTENCY_CONFLICT', 'FORUM_STORAGE_UNAVAILABLE',
])
/** A forum post/comment identity can only select a UUID within the fixed forum route family. */
export type ForumId = string & { readonly __forumId: 'ForumId' }

/**
 * Validate an opaque forum resource before interpolation in a fixed path.
 * @param value - Untrusted post or comment identifier.
 * @returns The original UUID, without normalizing or inventing another resource.
 */
export function forumId(value: unknown): ForumId {
  const result = demandText(value, 36)
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(result)) throw new DemandProtocolError()
  return result as ForumId
}
function text(value: unknown, maximum: number, empty = false): string {
  const result = demandText(value, maximum * 2, empty)
  if (Array.from(result).length > maximum) throw new DemandProtocolError()
  return result
}
function content(value: unknown, maximum: number): string {
  const result = text(value, maximum)
  if (result.trim() === '') throw new DemandProtocolError()
  return result
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DemandProtocolError()
  return value
}
function positive(value: unknown): number {
  const result = demandInteger(value)
  if (result === 0) throw new DemandProtocolError()
  return result
}
function array<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 100) throw new DemandProtocolError()
  return value.map(parse)
}
function publicAuthorName(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\s\p{Cf}().\-\u2010-\u2015\u2212]/gu, '')
  const phone = /(?:^|\D)\+?\d{7,15}(?!\d)/u.test(normalized)
  const masked = normalized.match(/[\d*xX•●]{7,20}/gu)?.some(part => /[*xX•●]/u.test(part)
    && part.replace(/\D/gu, '').length >= 3) === true
  return phone || masked ? '' : value
}
function author(input: unknown): DemandObject {
  const value = demandObject(input), id = positive(value.id), name = text(value.display_name, 200, true)
  return { id, display_name: name === `论坛用户${String(id)}` ? name : publicAuthorName(name) }
}
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
function choice(value: unknown, values: readonly string[]): string {
  if (typeof value !== 'string' || !values.includes(value)) throw new DemandProtocolError()
  return value
}
function boundedArray<T>(value: unknown, maximum: number, parse: (value: unknown) => T): T[] {
  const result = array(value, parse)
  if (result.length > maximum) throw new DemandProtocolError()
  return result
}
function ids(value: unknown): ForumId[] {
  const result = boundedArray(value, 8, forumId)
  if (new Set(result).size !== result.length) throw new DemandProtocolError()
  return result
}
function notificationId(value: unknown): string {
  const result = text(value, 20)
  if (!/^[1-9]\d{0,19}$/u.test(result) || BigInt(result) > 18_446_744_073_709_551_615n) throw new DemandProtocolError()
  return result
}
function digest(value: unknown): string {
  const result = text(value, 64)
  if (!/^[a-f\d]{64}$/u.test(result)) throw new DemandProtocolError()
  return result
}
function filename(value: unknown): string {
  const result = text(value, 255)
  if (/[\r\n/\\]/u.test(result)) throw new DemandProtocolError()
  return result
}
function attachment(input: unknown): DemandObject {
  const value = demandObject(input), id = forumId(value.id)
  const linkPath = (input: unknown): string => {
    const result = text(input, 256)
    if (result !== `/attachments/${id}/link` && result !== `/api/product/forum/attachments/${id}/link`) throw new DemandProtocolError()
    return result
  }
  return { id, name: filename(value.name), kind: choice(value.kind, ['image']), mime_type: choice(value.mime_type, imageTypes),
    size_bytes: positive(value.size_bytes), sha256: digest(value.sha256), status: choice(value.status, ['ready']),
    preview_path: linkPath(value.preview_path), download_path: linkPath(value.download_path) }
}
function media(value: DemandObject): DemandObject {
  if (value.attachments === undefined) return {}
  const attachments = boundedArray(value.attachments, 8, attachment)
  if (new Set(attachments.map(item => item.id)).size !== attachments.length) throw new DemandProtocolError()
  return { attachments }
}
function body(value: DemandObject, maximum: number): string {
  const result = text(value.body, maximum, true)
  if (result.trim() === '' && (!Array.isArray(value.attachments) || value.attachments.length === 0)) throw new DemandProtocolError()
  return result
}

function post(input: unknown): DemandObject {
  const value = demandObject(input)
  return { id: forumId(value.id), title: content(value.title, 200), body: body(value, 20_000), ...media(value),
    author: author(value.author), created_at: demandInteger(value.created_at), like_count: demandInteger(value.like_count),
    comment_count: demandInteger(value.comment_count), liked: bool(value.liked) }
}
function comment(input: unknown): DemandObject {
  const value = demandObject(input)
  const reply = value.reply_to_comment_id === undefined ? undefined : value.reply_to_comment_id === '' ? '' : forumId(value.reply_to_comment_id)
  if (value.reply_to_author !== undefined && (reply === undefined || reply === '')) throw new DemandProtocolError()
  return { id: forumId(value.id), post_id: forumId(value.post_id), body: body(value, 4000), ...media(value),
    author: author(value.author), created_at: demandInteger(value.created_at),
    ...reply === undefined ? {} : { reply_to_comment_id: reply },
    ...value.reply_to_author === undefined ? {} : { reply_to_author: author(value.reply_to_author) },
    ...value.post_title === undefined ? {} : { post_title: content(value.post_title, 200) } }
}
function page(value: DemandObject): DemandObject {
  return { next_cursor: text(value.next_cursor, 256, true), has_more: bool(value.has_more) }
}

/**
 * Retain only the exact ordinary-user mutation fields, preserving original idempotency content.
 * @param kind - A closed forum operation selected by the Host route table.
 * @param input - Untrusted renderer JSON.
 * @returns The unchanged original key/content and declared optional forum bindings, without admin fields.
 */
export function forumRequest(kind: string, input: unknown): DemandObject {
  const value = demandObject(input)
  if (kind === 'create-post' || kind === 'create-comment') {
    const attachments = value.attachment_ids === undefined ? undefined : ids(value.attachment_ids)
    const message = text(value.body, kind === 'create-post' ? 20_000 : 4000, true)
    if (message.trim() === '' && (attachments === undefined || attachments.length === 0)) throw new DemandProtocolError()
    return { client_request_id: text(value.client_request_id, 80),
      ...kind === 'create-post' ? { title: content(value.title, 200) } : {}, body: message,
      ...attachments === undefined ? {} : { attachment_ids: attachments },
      ...kind !== 'create-comment' || value.reply_to_comment_id === undefined ? {}
        : { reply_to_comment_id: value.reply_to_comment_id === '' ? '' : forumId(value.reply_to_comment_id) } }
  }
  if (kind === 'like') return { liked: bool(value.liked) }
  if (kind === 'upload-init') {
    const target = choice(value.target_kind, ['post', 'comment'])
    const postId = target === 'post' ? text(value.post_id, 0, true) : forumId(value.post_id)
    return { client_upload_id: text(value.client_upload_id, 80), target_kind: target, post_id: postId,
      name: filename(value.name), mime_type: choice(value.mime_type, imageTypes), size_bytes: positive(value.size_bytes) }
  }
  if (kind === 'upload-complete') return { sha256: digest(value.sha256) }
  if (kind === 'link') return { disposition: choice(value.disposition, ['inline', 'attachment']) }
  if (kind === 'profile-update') {
    if (typeof value.display_name !== 'string') throw new DemandProtocolError()
    const name = content(value.display_name.trim(), 40)
    if (/\p{Cc}/u.test(name) || publicAuthorName(name) === '') throw new DemandProtocolError()
    return { display_name: name, revision: demandInteger(value.revision) }
  }
  if (kind === 'notifications-read') {
    const selected = boundedArray(value.notification_ids, 100, notificationId)
    if (selected.length === 0) throw new DemandProtocolError()
    return { notification_ids: selected }
  }
  throw new DemandProtocolError()
}

/**
 * Accept only source-supported ordinary pagination; admin search/review filters are never forwarded.
 * @param kind - Closed forum read operation.
 * @param source - Untrusted query parameters.
 * @returns Bounded pagination without an account, authority or privileged selector.
 */
export function forumQuery(kind: string, source: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams()
  for (const [key, value] of source) {
    if (kind === 'receipt') {
      if (!['kind', 'client_request_id'].includes(key) || result.has(key)) throw new DemandProtocolError()
      if (key === 'kind') choice(value, ['post', 'comment'])
      else text(value, 80)
      result.set(key, value)
      continue
    }
    if (!['posts', 'comments', 'my-posts', 'my-comments', 'notifications'].includes(kind)
      || !['cursor', 'limit'].includes(key) || result.has(key)) throw new DemandProtocolError()
    if (key === 'cursor') text(value, 256, true)
    else {
      if (!/^\d{1,16}$/u.test(value) || demandInteger(Number(value), 100) === 0) throw new DemandProtocolError()
    }
    result.set(key, value)
  }
  if (kind === 'receipt' && (!result.has('kind') || !result.has('client_request_id'))) throw new DemandProtocolError()
  return result
}

function upload(input: unknown): DemandObject {
  const value = demandObject(input), asset = value.attachment === null ? null : attachment(value.attachment)
  const id = forumId(value.id), attachmentId = forumId(value.attachment_id), status = choice(value.status, ['uploading', 'assembling', 'ready'])
  if (asset !== null && asset.id !== attachmentId || status === 'ready' && asset === null || status !== 'ready' && asset !== null) throw new DemandProtocolError()
  return { id, attachment_id: attachmentId, offset: demandInteger(value.offset), chunk_bytes: positive(value.chunk_bytes),
    status, expires_at: demandInteger(value.expires_at), attachment: asset }
}
function notification(input: unknown): DemandObject {
  const value = demandObject(input), kind = choice(value.type, ['reply', 'like'])
  const commentId = value.comment_id === '' ? '' : forumId(value.comment_id)
  if (kind === 'like' && commentId !== '' || kind === 'reply' && commentId === '') throw new DemandProtocolError()
  return { id: notificationId(value.id), type: kind, post_id: forumId(value.post_id), comment_id: commentId,
    actor: author(value.actor), post_title: content(value.post_title, 200), created_at: demandInteger(value.created_at),
    read_at: demandInteger(value.read_at) }
}

/**
 * Decode one exact source wrapper and project public text fields under the captured account.
 * @param kind - Closed forum operation.
 * @param input - Untrusted upstream envelope.
 * @param account - Captured current account, used to verify creation authors.
 * @param route - Fixed route identity for detail and parent-bound comments.
 * @returns A public DTO without moderation/private fields, diagnostics or signed URLs.
 */
export function forumResponse(kind: string, input: unknown, account: { readonly id: string },
  route: { readonly resourceId?: string; readonly secondaryId?: string } = {}): DemandObject {
  const envelope = demandObject(input)
  if (envelope.success !== true) throw new DemandProtocolError()
  const value = demandObject(envelope.data)
  const boundPost = (input: unknown): DemandObject => {
    const result = post(input)
    if (route.resourceId !== undefined && result.id !== route.resourceId) throw new DemandProtocolError()
    return result
  }
  const boundComment = (input: unknown): DemandObject => {
    const result = comment(input)
    if (route.resourceId !== undefined && result.post_id !== route.resourceId
      || route.secondaryId !== undefined && result.id !== route.secondaryId) throw new DemandProtocolError()
    return result
  }
  if (kind === 'config') {
    const capabilities = demandObject(value.capabilities), additions: DemandObject = {}
    for (const key of ['image_uploads', 'my_activity', 'comment_replies', 'notifications', 'forum_profile', 'receipt_lookup']) {
      if (capabilities[key] !== undefined) additions[key] = bool(capabilities[key])
    }
    if (additions.image_uploads === true && value.upload_rules === undefined) throw new DemandProtocolError()
    let rules: DemandObject | undefined
    if (value.upload_rules !== undefined) {
      const valueRules = demandObject(value.upload_rules), chunk = demandInteger(valueRules.chunk_bytes, 67_108_864)
      const maximum = demandInteger(valueRules.max_attachments, 8)
      const types = boundedArray(valueRules.allowed_mime_types, 4, item => choice(item, imageTypes))
      if (chunk === 0 || additions.image_uploads === true && (maximum === 0 || types.length === 0)
        || new Set(types).size !== types.length) throw new DemandProtocolError()
      rules = { max_attachments: maximum, max_image_bytes: positive(valueRules.max_image_bytes), chunk_bytes: chunk,
        upload_ttl_seconds: positive(valueRules.upload_ttl_seconds), allowed_mime_types: types }
    }
    return { revision: demandInteger(value.revision), enabled: bool(value.enabled), capabilities: {
      immediate_publish: bool(capabilities.immediate_publish), likes: bool(capabilities.likes), comments: bool(capabilities.comments),
      ...additions,
    }, ...rules === undefined ? {} : { upload_rules: rules } }
  }
  if (['posts', 'comments', 'my-posts', 'my-comments', 'notifications'].includes(kind)) {
    const parse = kind === 'posts' || kind === 'my-posts' ? post : kind === 'notifications' ? notification : boundComment
    const values = array(value.items, parse)
    if ((kind === 'my-posts' || kind === 'my-comments') && values.some(item => String(demandObject(item.author).id) !== account.id)) throw new DemandProtocolError()
    if (new Set(values.map(item => item.id)).size !== values.length) throw new DemandProtocolError()
    return { items: values, ...page(value), ...kind === 'notifications' ? { unread_count: demandInteger(value.unread_count) } : {} }
  }
  if (kind === 'post' || kind === 'like') return { post: boundPost(value.post) }
  if (kind === 'comment') return { comment: boundComment(value.comment) }
  if (kind === 'profile' || kind === 'profile-update') {
    const profile = demandObject(value.profile), current = author(profile)
    if (String(current.id) !== account.id) throw new DemandProtocolError()
    return { profile: { ...current, revision: demandInteger(profile.revision) } }
  }
  if (kind === 'notifications-unread' || kind === 'notifications-read') return { unread_count: demandInteger(value.unread_count) }
  if (['upload-init', 'upload-status', 'upload-chunk', 'upload-complete'].includes(kind)) {
    const result = upload(value)
    if (route.resourceId !== undefined && result.id !== route.resourceId) throw new DemandProtocolError()
    return result
  }
  if (kind === 'receipt') {
    const field = value.post === undefined ? 'comment' : 'post'
    if (value.post !== undefined && value.comment !== undefined || value.replayed !== true) throw new DemandProtocolError()
    const result = field === 'post' ? post(value.post) : comment(value.comment)
    if (String(demandObject(result.author).id) !== account.id) throw new DemandProtocolError()
    return { [field]: result, replayed: true }
  }
  if (kind === 'create-post' || kind === 'create-comment') {
    const field = kind === 'create-post' ? 'post' : 'comment'
    const result = kind === 'create-post' ? post(value.post) : boundComment(value.comment)
    if (String(demandObject(result.author).id) !== account.id) throw new DemandProtocolError()
    return { [field]: result, replayed: bool(value.replayed) }
  }
  throw new DemandProtocolError()
}
