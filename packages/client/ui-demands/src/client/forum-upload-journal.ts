/** A separate, account-owned journal preserves forum upload identities without storing file bytes. */
import type { ForumOwner } from './forum-api.ts'
import type { ForumAttachment, ForumUploadTarget } from './forum-types.ts'
import type { ForumStorage } from './forum-pending.ts'
import { forumAttachment, forumInteger, forumJson, forumObject, forumText, forumUuid, ForumWireError } from './forum-wire.ts'

/** Every attempted slice is frozen before dispatch. */
export interface ForumUploadPart { readonly offset: number; readonly size: number; readonly sha256: string }
/** Only confirmed upload progress can advance this immutable original selection. */
export interface ForumUploadRecord {
  readonly version: 1
  readonly operationId: string
  readonly target: ForumUploadTarget
  readonly body: string
  readonly file: { readonly name: string; readonly size: number; readonly type: string; readonly lastModified: number }
  readonly parts: readonly ForumUploadPart[]
  readonly sha256: string | null
  readonly uploadId: string | null
  readonly attachmentId: string | null
  readonly attachment: ForumAttachment | null
  readonly completeBody: string | null
}
/** Replaceable browser persistence, independent of old text-only forum operations. */
export interface ForumUploadJournal {
  read(owner: Pick<ForumOwner, 'id' | 'owner'>): readonly ForumUploadRecord[]
  put(owner: Pick<ForumOwner, 'id' | 'owner'>, value: ForumUploadRecord): void
  remove(owner: Pick<ForumOwner, 'id' | 'owner'>, id: string): void
}
function digest(value: unknown): string {
  const result = forumText(value, 64)
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new ForumWireError()
  return result
}
/** Validate a persisted forum upload without borrowing community resource identities.
 * @param value - Persisted original upload metadata and progress.
 * @returns A validated immutable original selection with bounded progress.
 */
export function parseForumUploadRecord(value: unknown): ForumUploadRecord {
  const row = forumObject(value), target = forumObject(row.target), file = forumObject(row.file)
  const operationId = forumUuid(row.operationId), body = forumText(row.body, 4096), input = forumObject(forumJson(body))
  const destination: ForumUploadTarget = target.kind === 'post' ? { kind: 'post', scopeKey: forumText(target.scopeKey, 200) }
    : target.kind === 'comment' ? { kind: 'comment', postId: forumUuid(target.postId) } : (() => { throw new ForumWireError() })()
  const name = forumText(file.name, 255), size = forumInteger(file.size), type = forumText(file.type, 128)
  if (row.version !== 1 || size < 1 || input.client_upload_id !== operationId || input.target_kind !== destination.kind
    || input.post_id !== (destination.kind === 'post' ? '' : destination.postId) || input.name !== name
    || input.size_bytes !== size || input.mime_type !== type
    || Object.keys(input).sort().join(',') !== 'client_upload_id,mime_type,name,post_id,size_bytes,target_kind') throw new ForumWireError()
  if (!Array.isArray(row.parts) || row.parts.length > 32768) throw new ForumWireError()
  let offset = 0
  const parts = row.parts.map((value) => {
    const part = forumObject(value), start = forumInteger(part.offset), bytes = forumInteger(part.size)
    if (start !== offset || bytes < 1 || start + bytes > size) throw new ForumWireError()
    offset += bytes
    return { offset: start, size: bytes, sha256: digest(part.sha256) }
  })
  const sha256 = row.sha256 === null ? null : digest(row.sha256)
  const uploadId = row.uploadId === null ? null : forumUuid(row.uploadId)
  const attachmentId = row.attachmentId === null ? null : forumUuid(row.attachmentId)
  const attachment = row.attachment === null ? null : forumAttachment(row.attachment)
  const completeBody = row.completeBody === null ? null : forumText(row.completeBody, 100)
  if (completeBody !== null && (sha256 === null || completeBody !== JSON.stringify({ sha256 }))
    || attachment !== null && (attachment.id !== attachmentId || attachment.sha256 !== sha256
      || attachment.size_bytes !== size || attachment.mime_type !== type || uploadId === null)) throw new ForumWireError()
  return { version: 1, operationId, target: destination, body, file: { name, size, type, lastModified: forumInteger(file.lastModified) },
    parts, sha256, uploadId, attachmentId, attachment, completeBody }
}
/** Create an account-isolated pre-send upload journal with immutable originals and monotonic progress.
 * @param storage - Optional browser-compatible persistence adapter.
 * @returns A separate account-owned upload journal.
 */
export function createForumUploadJournal(storage?: ForumStorage): ForumUploadJournal {
  const backing = (): ForumStorage => storage ?? globalThis.localStorage
  const key = (owner: Pick<ForumOwner, 'id' | 'owner'>): string => `yunshu.forum.uploads.v1:${JSON.stringify([owner.id, owner.owner])}`
  const read = (owner: Pick<ForumOwner, 'id' | 'owner'>): readonly ForumUploadRecord[] => {
    const raw = backing().getItem(key(owner)); if (raw === null) return []
    if (raw.length > 8_388_608) throw new Error('FORUM_PENDING_INVALID')
    const row = forumObject(forumJson(raw))
    if (row.version !== 1 || row.accountId !== owner.id || row.accountOwner !== owner.owner
      || !Array.isArray(row.uploads) || row.uploads.length > 256) throw new Error('FORUM_PENDING_INVALID')
    const values = row.uploads.map(parseForumUploadRecord)
    if (new Set(values.map(item => item.operationId)).size !== values.length) throw new Error('FORUM_PENDING_INVALID')
    return values
  }
  const write = (owner: Pick<ForumOwner, 'id' | 'owner'>, values: readonly ForumUploadRecord[]): void => {
    if (values.length === 0) { backing().removeItem(key(owner)); return }
    const raw = JSON.stringify({ version: 1, accountId: owner.id, accountOwner: owner.owner, uploads: values })
    if (raw.length > 8_388_608) throw new Error('FORUM_PENDING_FULL')
    backing().setItem(key(owner), raw)
  }
  return { read,
    put(owner, value) {
      const next = parseForumUploadRecord(value), values = read(owner), old = values.find(item => item.operationId === next.operationId)
      if (old !== undefined && (old.body !== next.body || JSON.stringify(old.file) !== JSON.stringify(next.file)
        || JSON.stringify(old.target) !== JSON.stringify(next.target) || old.sha256 !== null && old.sha256 !== next.sha256
        || old.uploadId !== null && old.uploadId !== next.uploadId || old.attachmentId !== null && old.attachmentId !== next.attachmentId
        || old.completeBody !== null && old.completeBody !== next.completeBody
        || JSON.stringify(next.parts.slice(0, old.parts.length)) !== JSON.stringify(old.parts)
        || old.attachment !== null && JSON.stringify(old.attachment) !== JSON.stringify(next.attachment))) throw new Error('FORUM_PENDING_BODY_CHANGED')
      if (old === undefined && values.length >= 256) throw new Error('FORUM_PENDING_FULL')
      write(owner, [...values.filter(item => item.operationId !== next.operationId), next])
    },
    remove(owner, id) { write(owner, read(owner).filter(item => item.operationId !== id)) },
  }
}
