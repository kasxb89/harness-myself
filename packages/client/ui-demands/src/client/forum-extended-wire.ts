/** Decoders for capability-qualified forum account tools and resumable image uploads. */
import type { ForumAttachment, ForumNotification, ForumProfile } from './forum-types.ts'
import { forumAttachment, forumAuthor, forumId, forumInteger, forumObject, forumText, forumUuid, ForumWireError } from './forum-wire.ts'

/** A notification key is a decimal database identity, never a post UUID.
 * @param value - Untrusted notification key.
 * @returns The original nonzero decimal identity without numeric conversion.
 */
export function forumNotificationId(value: unknown): string {
  const result = forumText(value, 20)
  if (!/^[1-9]\d{0,19}$/u.test(result)) throw new ForumWireError()
  return result
}
/** Decode the current user's separate public forum profile.
 * @param value - Untrusted profile DTO.
 * @returns Validated public profile and its concurrency revision.
 */
export function forumProfile(value: unknown): ForumProfile {
  const row = forumObject(value), author = forumAuthor(row)
  return { ...author, revision: forumInteger(row.revision) }
}
/** Decode a recipient-scoped notification with public identities only.
 * @param value - Untrusted notification DTO.
 * @returns A public actor and exact forum target.
 */
export function forumNotification(value: unknown): ForumNotification {
  const row = forumObject(value), type = row.type
  if (type !== 'reply' && type !== 'like') throw new ForumWireError()
  const comment = forumText(row.comment_id, 40, true)
  if (type === 'reply' && comment === '' || type === 'like' && comment !== '') throw new ForumWireError()
  return { id: forumNotificationId(row.id), type, post_id: forumId(row.post_id),
    comment_id: comment === '' ? '' : forumId(comment), actor: forumAuthor(row.actor),
    post_title: forumText(row.post_title, 200), created_at: forumInteger(row.created_at), read_at: forumInteger(row.read_at) }
}
/** Validated upload progress; public attachment metadata is absent until image verification succeeds. */
export interface ForumWireUpload {
  readonly id: string
  readonly attachment_id: string
  readonly offset: number
  readonly chunk_bytes: number
  readonly status: 'uploading' | 'assembling' | 'ready'
  readonly expires_at: number
  readonly attachment: ForumAttachment | null
}
/** Decode one original resumable upload, without treating an unready asset as previewable.
 * @param value - Untrusted upload progress DTO.
 * @returns Validated byte progress and only a ready attachment.
 */
export function forumUpload(value: unknown): ForumWireUpload {
  const row = forumObject(value), status = row.status
  if (status !== 'uploading' && status !== 'assembling' && status !== 'ready') throw new ForumWireError()
  const chunk = forumInteger(row.chunk_bytes), attachment = row.attachment === null ? null : forumAttachment(row.attachment)
  const id = forumUuid(row.id), attachmentId = forumUuid(row.attachment_id)
  if (chunk < 1 || status === 'ready' && (attachment === null || attachment.id !== attachmentId)
    || status !== 'ready' && attachment !== null) throw new ForumWireError()
  return { id, attachment_id: attachmentId, offset: forumInteger(row.offset), chunk_bytes: chunk,
    status, expires_at: forumInteger(row.expires_at), attachment }
}
