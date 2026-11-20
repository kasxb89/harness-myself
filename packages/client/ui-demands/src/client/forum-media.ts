/** Forum-only resumable images retain their original selection, UUID and verified byte progress. */
import { communityFileDigest, communitySliceDigest } from './community-pending.ts'
import { forumContentUrl, type ForumOwner } from './forum-api.ts'
import type { ForumModelContext } from './forum-model-context.ts'
import type { ForumIssue, ForumUploadTarget, ForumUploadView } from './forum-types.ts'
import { createForumUploadJournal, type ForumUploadJournal, type ForumUploadRecord } from './forum-upload-journal.ts'
import { forumUpload, type ForumWireUpload } from './forum-extended-wire.ts'

const sameTarget = (a: ForumUploadTarget, b: ForumUploadTarget): boolean => a.kind === 'post'
  ? b.kind === 'post' && a.scopeKey === b.scopeKey : b.kind === 'comment' && a.postId === b.postId
const issue = (code: string, unknown = false, id: string | null = null): ForumIssue => ({ code, unknown, operationId: id })

/** Original-upload state and explicit commands, owned by the forum controller lifecycle. */
export interface ForumMediaModel {
  readonly snapshot: () => readonly ForumUploadView[]
  readonly restore: (owner: ForumOwner) => readonly ForumUploadTarget[]
  readonly reset: () => void
  readonly ids: (target: ForumUploadTarget) => readonly string[]
  readonly committed: (owner: ForumOwner, ids: readonly string[]) => void
  readonly add: (target: ForumUploadTarget, files: readonly File[]) => void
  readonly retry: (id: string, file?: File) => void
  readonly remove: (id: string) => void
  readonly contentUrl: (id: string, disposition?: 'inline' | 'attachment') => string | null
}

/** Compose uploads without sharing community targets, journals, assets or authorization.
 * @param ctx - Existing forum account, transport and joined-task lifecycle.
 * @param options - Durable journal, original-ID source and parent-owned scope guards.
 * @returns Original-upload commands, staged images and account-guarded content URLs.
 */
export function createForumMedia(ctx: ForumModelContext, options: {
  readonly journal?: ForumUploadJournal
  readonly uuid: () => string
  readonly canEdit: (target: ForumUploadTarget) => boolean
  readonly reserved: (attachmentId: string) => boolean
  readonly error: (value: ForumIssue) => void
}): ForumMediaModel {
  const journal = options.journal ?? createForumUploadJournal()
  const records = new Map<string, ForumUploadRecord>(), files = new Map<string, File>()
  const failures = new Map<string, ForumIssue>(), flights = new Map<string, AbortController>(), progress = new Map<string, number>()
  const save = (captured: ForumOwner, record: ForumUploadRecord): boolean => {
    if (!ctx.valid(captured)) return false
    try { journal.put(captured, record); records.set(record.operationId, record); return true }
    catch (_storage: unknown) { options.error(issue('FORUM_PENDING_STORAGE_FAILED')); return false }
  }
  const run = async (operationId: string): Promise<void> => {
    const captured = ctx.owner(), original = records.get(operationId)
    if (captured === null || original === undefined || original.attachment !== null
      || flights.has(operationId) || !ctx.valid(captured)) return
    const abort = new AbortController(); flights.set(operationId, abort); failures.delete(operationId); ctx.publish()
    let record = original
    const valid = (): boolean => ctx.valid(captured) && !abort.signal.aborted && records.has(operationId)
    const update = (patch: Partial<ForumUploadRecord>): boolean => {
      if (!valid()) return false
      const next = { ...record, ...patch }
      if (!save(captured, next)) return false
      record = next; return true
    }
    const checked = (status: ForumWireUpload): void => {
      const image = status.attachment
      if (status.offset > record.file.size || record.uploadId !== null && status.id !== record.uploadId
        || record.attachmentId !== null && status.attachment_id !== record.attachmentId
        || image !== null && (image.id !== status.attachment_id || image.mime_type !== record.file.type
          || image.size_bytes !== record.file.size || image.sha256 !== record.sha256)) throw new Error('FORUM_PROTOCOL_INVALID')
    }
    const accepted = (status: ForumWireUpload): boolean => {
      checked(status)
      if (!update({ uploadId: status.id, attachmentId: status.attachment_id })) return true
      progress.set(operationId, status.offset / record.file.size * 100)
      if (status.status === 'ready') {
        if (status.offset !== record.file.size || status.attachment === null) throw new Error('FORUM_PROTOCOL_INVALID')
        if (update({ attachment: status.attachment })) files.delete(operationId)
        return true
      }
      if (status.status === 'assembling') {
        failures.set(operationId, issue('FORUM_RESULT_UNKNOWN', true, operationId)); return true
      }
      return false
    }
    try {
      let status: ForumWireUpload | undefined
      if (record.uploadId !== null) {
        const answer = await ctx.perform(captured, { method: 'GET', path: `/uploads/${record.uploadId}` }, abort.signal)
        if (!valid()) return
        if (!answer.ok) { failures.set(operationId, issue(answer.code, answer.unknown, operationId)); return }
        status = forumUpload(answer.payload)
        if (accepted(status)) return
      }
      const file = files.get(operationId)
      if (file === undefined) { failures.set(operationId, issue('FORUM_UPLOAD_RESELECT', false, operationId)); return }
      if (file.name !== record.file.name || file.size !== record.file.size || file.type !== record.file.type
        || file.lastModified !== record.file.lastModified) throw new Error('FORUM_UPLOAD_FILE_MISMATCH')
      const sha256 = await communityFileDigest(file, abort.signal)
      if (!valid()) return
      if (record.sha256 !== null && record.sha256 !== sha256) throw new Error('FORUM_UPLOAD_FILE_MISMATCH')
      for (const part of record.parts) if (await communitySliceDigest(file, part.offset, part.size) !== part.sha256) throw new Error('FORUM_UPLOAD_FILE_MISMATCH')
      if (record.sha256 === null && !update({ sha256 })) return
      if (status === undefined) {
        const answer = await ctx.perform(captured, { method: 'POST', path: '/uploads', body: record.body }, abort.signal)
        if (!valid()) return
        if (!answer.ok) { failures.set(operationId, issue(answer.code, answer.unknown, operationId)); return }
        status = forumUpload(answer.payload)
        if (accepted(status)) return
      }
      if (!new Set([0, ...record.parts.map(part => part.offset + part.size)]).has(status.offset)) throw new Error('FORUM_PROTOCOL_INVALID')
      let offset = status.offset
      progress.set(operationId, offset / file.size * 100); ctx.publish()
      while (offset < file.size) {
        const previous = record.parts.find(part => part.offset === offset)
        const bytes = previous?.size ?? Math.min(status.chunk_bytes, file.size - offset)
        const rules = ctx.config()?.upload_rules
        if (bytes < 1 || bytes > status.chunk_bytes || rules === undefined || bytes > rules.chunk_bytes) throw new Error('FORUM_PROTOCOL_INVALID')
        const sha = await communitySliceDigest(file, offset, bytes)
        if (!valid()) return
        if (previous !== undefined && previous.sha256 !== sha) throw new Error('FORUM_UPLOAD_FILE_MISMATCH')
        if (previous === undefined && !update({ parts: [...record.parts, { offset, size: bytes, sha256: sha }] })) return
        const start = offset
        const part = await ctx.perform(captured, { method: 'PUT', path: `/uploads/${status.id}/chunks`,
          blob: file.slice(offset, offset + bytes), offset, onProgress: (sent) => {
            if (valid()) { progress.set(operationId, Math.min(100, (start + sent) / file.size * 100)); ctx.publish() }
          } }, abort.signal)
        if (!valid()) return
        if (!part.ok) { failures.set(operationId, issue(part.code, part.unknown, operationId)); return }
        status = forumUpload(part.payload); checked(status)
        if (status.offset !== offset + bytes || status.status !== 'uploading') throw new Error('FORUM_PROTOCOL_INVALID')
        offset = status.offset; progress.set(operationId, offset / file.size * 100); ctx.publish()
      }
      if (record.completeBody === null && !update({ completeBody: JSON.stringify({ sha256: record.sha256 }) })) return
      if (record.completeBody === null) throw new Error('FORUM_PROTOCOL_INVALID')
      const complete = await ctx.perform(captured, { method: 'POST', path: `/uploads/${status.id}/complete`, body: record.completeBody }, abort.signal)
      if (!valid()) return
      if (!complete.ok) { failures.set(operationId, issue(complete.code, complete.unknown, operationId)); return }
      const ready = forumUpload(complete.payload); checked(ready)
      if (ready.status !== 'ready' || ready.attachment === null || ready.offset !== file.size) throw new Error('FORUM_PROTOCOL_INVALID')
      if (update({ attachment: ready.attachment })) files.delete(operationId)
    } catch (failure: unknown) {
      if (valid()) failures.set(operationId, issue(failure instanceof Error && failure.message === 'FORUM_UPLOAD_FILE_MISMATCH'
        ? 'FORUM_UPLOAD_FILE_MISMATCH' : 'FORUM_UPLOAD_FAILED', true, operationId))
    } finally { if (ctx.valid(captured)) { flights.delete(operationId); ctx.publish() } }
  }
  return {
    snapshot: (): readonly ForumUploadView[] => [...records.values()].map((record) => {
      const error = failures.get(record.operationId) ?? null
      return { operationId: record.operationId, target: record.target, name: record.file.name, mimeType: record.file.type,
        sizeBytes: record.file.size, attachment: record.attachment,
        progress: record.attachment !== null ? 100 : progress.get(record.operationId) ?? 0,
        status: record.attachment !== null ? 'ready' : flights.has(record.operationId) ? 'uploading'
          : error?.code === 'FORUM_UPLOAD_RESELECT' ? 'select-file' : error?.unknown ? 'unknown' : 'error', error }
    }),
    restore: (captured: ForumOwner): readonly ForumUploadTarget[] => {
      const targets: ForumUploadTarget[] = []
      for (const record of journal.read(captured)) {
        records.set(record.operationId, record); targets.push(record.target)
        if (record.attachment === null) failures.set(record.operationId, record.uploadId === null
          ? issue('FORUM_UPLOAD_RESELECT', false, record.operationId) : issue('FORUM_RESULT_UNKNOWN', true, record.operationId))
      }
      return targets
    },
    reset: (): void => { for (const flight of flights.values()) flight.abort()
      records.clear(); files.clear(); failures.clear(); flights.clear(); progress.clear() },
    ids: (target: ForumUploadTarget): readonly string[] => {
      const selected = [...records.values()].filter(record => sameTarget(record.target, target))
      if (selected.some(record => record.attachment === null || options.reserved(record.attachment.id))) throw new Error('FORUM_UPLOAD_PENDING')
      return selected.map(record => record.attachment?.id ?? '')
    },
    committed: (captured: ForumOwner, ids: readonly string[]): void => {
      for (const record of records.values()) if (record.attachment !== null && ids.includes(record.attachment.id)) {
        try {
          journal.remove(captured, record.operationId); records.delete(record.operationId)
          files.delete(record.operationId); failures.delete(record.operationId)
        }
        catch (_storage: unknown) { options.error(issue('FORUM_PENDING_STORAGE_FAILED')) }
      }
    },
    add: (target: ForumUploadTarget, selected: readonly File[]): void => {
      const captured = ctx.owner(), config = ctx.config(), rules = config?.upload_rules
      if (captured === null || !ctx.valid(captured) || config?.enabled !== true || config.capabilities.image_uploads !== true
        || rules === undefined || !options.canEdit(target)) return
      for (const file of selected) {
        if ([...records.values()].filter(record => sameTarget(record.target, target)).length >= rules.max_attachments) {
          options.error(issue('FORUM_UPLOAD_TOO_MANY')); break
        }
        if (!rules.allowed_mime_types.includes(file.type) || file.size < 1 || file.size > rules.max_image_bytes) {
          options.error(issue('FORUM_UPLOAD_INVALID')); continue
        }
        const operationId = options.uuid(), record: ForumUploadRecord = { version: 1, operationId, target,
          body: JSON.stringify({ client_upload_id: operationId, target_kind: target.kind, post_id: target.kind === 'post' ? '' : target.postId,
            name: file.name, mime_type: file.type, size_bytes: file.size }),
          file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }, parts: [], sha256: null,
          uploadId: null, attachmentId: null, attachment: null, completeBody: null }
        if (save(captured, record)) { files.set(operationId, file); ctx.track(() => run(operationId)) }
      }
      ctx.publish()
    },
    retry: (id: string, file?: File): void => {
      const record = records.get(id)
      if (record === undefined || flights.has(id)) return
      if (file !== undefined) files.set(id, file)
      ctx.track(() => run(id))
    },
    remove: (id: string): void => {
      const captured = ctx.owner(), record = records.get(id)
      if (captured === null || record === undefined || flights.has(id) || !options.canEdit(record.target)
        || record.attachmentId !== null && options.reserved(record.attachmentId)) return
      try { journal.remove(captured, id); records.delete(id); files.delete(id); failures.delete(id); progress.delete(id); ctx.publish() }
      catch (_storage: unknown) { options.error(issue('FORUM_PENDING_STORAGE_FAILED')) }
    },
    contentUrl: (id: string, disposition: 'inline' | 'attachment' = 'inline'): string | null => {
      const captured = ctx.owner(); if (captured === null || !ctx.valid(captured)) return null
      try { return forumContentUrl(captured, id, disposition) } catch (_input: unknown) { return null }
    },
  }
}
