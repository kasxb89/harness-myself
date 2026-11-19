/** Account-isolated durable community operations and bounded file verification. */
import { sha256 } from '@noble/hashes/sha2.js'
import type { CommunityOwner } from './community-api.ts'
import type { CommunityAttachment, CommunityScope, CommunityUploadTarget } from './community-types.ts'
import {
  communityArray, communityAttachment, communityBoolean, communityChoice, communityDigest, communityId, communityInteger,
  communityCalendarDate, communityJson, communityObject, communityText, communityUuid,
} from './community-wire.ts'

/** A file slice recorded before its first network attempt. */
export interface CommunityPart { readonly offset: number; readonly size: number; readonly sha256: string }
/** Immutable original metadata plus verified upload recovery progress. */
export interface CommunityPendingUpload {
  readonly target: CommunityUploadTarget
  readonly scope: CommunityScope
  readonly file: { readonly name: string; readonly size: number; readonly type: string; readonly lastModified: number }
  readonly parts: readonly CommunityPart[]
  readonly uploadId: string | null
  readonly attachmentId: string | null
  readonly sha256: string | null
  readonly attachment: CommunityAttachment | null
  readonly completeBody: string | null
  readonly ready: boolean
}
/** Frozen original mutation identity and body; only validated upload progress may advance. */
export interface CommunityOperation {
  readonly version: 1
  readonly operationId: string
  readonly scopeKey: string
  readonly orderId: string | null
  readonly kind: 'publication' | 'accept' | 'message' | 'action' | 'upload'
  readonly path: string
  readonly body: string
  readonly createdAt: number
  readonly upload?: CommunityPendingUpload
}
/** Browser storage abstraction, replaceable by isolated memory in tests. */
export interface CommunityStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
/** Synchronous pre-send persistence; any storage failure is visible before submission. */
export interface CommunityJournal {
  read(owner: Pick<CommunityOwner, 'id' | 'owner'>): readonly CommunityOperation[]
  put(owner: Pick<CommunityOwner, 'id' | 'owner'>, operation: CommunityOperation): void
  remove(owner: Pick<CommunityOwner, 'id' | 'owner'>, operationId: string): void
}
function target(value: unknown): CommunityUploadTarget {
  const row = communityObject(value), kind = communityChoice(row.kind, ['publication', 'order'])
  return kind === 'publication' ? { kind, scopeKey: communityText(row.scopeKey, 200) } : { kind, orderId: communityId(row.orderId) }
}
/**
 * Decode a persisted original operation, refusing old demand records and changed scopes.
 * @param value - Untrusted local-storage record.
 * @returns Validated community operation.
 */
export function parseCommunityOperation(value: unknown): CommunityOperation {
  const row = communityObject(value)
  if (row.version !== 1) throw new Error('COMMUNITY_PENDING_INVALID')
  const kind = communityChoice(row.kind, ['publication', 'accept', 'message', 'action', 'upload'])
  const operationId = communityUuid(row.operationId), path = communityText(row.path, 300), body = communityText(row.body, 65_536)
  const orderId = row.orderId === null ? null : communityId(row.orderId), payload = communityObject(communityJson(body))
  const key = kind === 'publication' ? 'client_request_id' : kind === 'message' ? 'client_message_id'
    : kind === 'upload' ? 'client_upload_id' : 'client_action_id'
  if (payload[key] !== operationId || kind === 'publication' && path !== '/orders'
    || kind === 'upload' && path !== '/uploads' || kind === 'accept' && path !== `/orders/${orderId}/accept`
    || kind === 'message' && path !== `/orders/${orderId}/messages` || kind === 'action' && path !== `/orders/${orderId}/actions`
    || ['accept', 'message', 'action'].includes(kind) && orderId === null) throw new Error('COMMUNITY_PENDING_INVALID')
  const identifiers = (value: unknown): readonly string[] => communityArray(value, 8, communityId)
  if (kind === 'publication') {
    if (payload.publish_to_community !== true || orderId !== null) throw new Error('COMMUNITY_PENDING_INVALID')
    communityText(payload.title, 200); communityText(payload.public_summary, 4000)
    communityText(payload.public_budget, 100, true); communityText(payload.private_text, 12_000, true)
    if (payload.expected_delivery_date !== undefined) communityCalendarDate(payload.expected_delivery_date)
    if (payload.service_profile_id !== undefined && payload.service_profile_id !== '') communityId(payload.service_profile_id)
    const publicIds = identifiers(payload.public_attachment_ids), privateIds = identifiers(payload.private_attachment_ids)
    if (publicIds.some(id => privateIds.includes(id))) throw new Error('COMMUNITY_PENDING_INVALID')
  } else if (kind === 'message') {
    const text = communityText(payload.text, 12_000, true), assets = identifiers(payload.attachment_ids)
    if (text.trim() === '' && assets.length === 0) throw new Error('COMMUNITY_PENDING_INVALID')
  } else if (kind === 'action') {
    const action = communityChoice(payload.action, ['cancel', 'reopen', 'deliver', 'accept_delivery', 'request_changes'])
    communityInteger(payload.revision); identifiers(payload.attachment_ids)
    const text = communityText(payload.text, 12_000, true)
    if (action === 'request_changes' && text.trim() === '') throw new Error('COMMUNITY_PENDING_INVALID')
  }
  let upload: CommunityPendingUpload | undefined
  if (kind === 'upload') {
    const data = communityObject(row.upload), file = communityObject(data.file)
    const scope = communityChoice(data.scope, ['listing', 'conversation'])
    const destination = target(data.target), size = communityInteger(file.size), name = communityText(file.name, 255)
    const type = communityText(file.type, 128), routeOrder = payload.order_id === undefined ? null : communityId(payload.order_id)
    if (size < 1 || payload.name !== name || payload.size_bytes !== size || payload.mime_type !== type || payload.scope !== scope
      || orderId !== routeOrder || destination.kind === 'order' && (orderId !== destination.orderId || scope !== 'conversation')
      || destination.kind === 'publication' && (orderId !== null || destination.scopeKey !== row.scopeKey)) {
      throw new Error('COMMUNITY_PENDING_INVALID')
    }
    let previous = 0
    const parts = communityArray(data.parts, 32_768, (value) => {
      const part = communityObject(value), offset = communityInteger(part.offset, size), bytes = communityInteger(part.size, size - offset)
      if (bytes === 0 || offset !== previous) throw new Error('COMMUNITY_PENDING_INVALID')
      previous += bytes
      return { offset, size: bytes, sha256: communityDigest(part.sha256) }
    })
    upload = { target: destination, scope, file: { name, size, type, lastModified: communityInteger(file.lastModified) }, parts,
      uploadId: data.uploadId === null ? null : communityId(data.uploadId),
      attachmentId: data.attachmentId === null ? null : communityId(data.attachmentId),
      sha256: data.sha256 === null ? null : communityDigest(data.sha256),
      attachment: data.attachment === null ? null : communityAttachment(data.attachment),
      completeBody: data.completeBody === null ? null : communityText(data.completeBody, 100), ready: communityBoolean(data.ready) }
    if (upload.completeBody !== null && communityObject(communityJson(upload.completeBody)).sha256 !== upload.sha256) {
      throw new Error('COMMUNITY_PENDING_INVALID')
    }
    if (upload.attachment !== null && (upload.attachment.id !== upload.attachmentId || upload.attachment.scope !== scope
      || upload.attachment.name !== name || upload.attachment.mime_type !== type || upload.attachment.size_bytes !== size)
      || upload.ready && (upload.uploadId === null || upload.attachmentId === null
        || upload.sha256 === null || upload.attachment === null)) {
      throw new Error('COMMUNITY_PENDING_INVALID')
    }
  } else if (row.upload !== undefined) throw new Error('COMMUNITY_PENDING_INVALID')
  return { version: 1, operationId, scopeKey: communityText(row.scopeKey, 200), orderId, kind, path, body,
    createdAt: communityInteger(row.createdAt, 8_640_000_000_000_000), ...upload === undefined ? {} : { upload } }
}
/**
 * Create the separate community journal; corruption never silently drops unknown submissions.
 * @param storage - Optional browser-compatible persistence adapter.
 * @returns Owner-isolated journal with immutable identities and bodies.
 */
export function createCommunityJournal(storage?: CommunityStorage): CommunityJournal {
  const backing = (): CommunityStorage => storage ?? globalThis.localStorage
  const key = (owner: Pick<CommunityOwner, 'id' | 'owner'>): string =>
    `yunshu.community-demands.pending.v1:${JSON.stringify([owner.id, owner.owner])}`
  const read = (owner: Pick<CommunityOwner, 'id' | 'owner'>): readonly CommunityOperation[] => {
    const raw = backing().getItem(key(owner))
    if (raw === null) return []
    if (raw.length > 8_388_608) throw new Error('COMMUNITY_PENDING_INVALID')
    const data = communityObject(communityJson(raw))
    if (data.version !== 1 || data.accountId !== owner.id || data.accountOwner !== owner.owner) throw new Error('COMMUNITY_PENDING_INVALID')
    const operations = communityArray(data.operations, 256, parseCommunityOperation)
    if (new Set(operations.map(item => item.operationId)).size !== operations.length) throw new Error('COMMUNITY_PENDING_INVALID')
    return operations
  }
  const write = (owner: Pick<CommunityOwner, 'id' | 'owner'>, operations: readonly CommunityOperation[]): void => {
    if (operations.length === 0) { backing().removeItem(key(owner)); return }
    const raw = JSON.stringify({ version: 1, accountId: owner.id, accountOwner: owner.owner, operations })
    if (raw.length > 8_388_608) throw new Error('COMMUNITY_PENDING_FULL')
    backing().setItem(key(owner), raw)
  }
  return { read,
    put(owner, operation) {
      const checked = parseCommunityOperation(operation), previous = read(owner)
      const original = previous.find(item => item.operationId === checked.operationId)
      if (original !== undefined && (original.body !== checked.body || original.path !== checked.path
        || original.kind !== checked.kind || original.scopeKey !== checked.scopeKey || original.orderId !== checked.orderId)) {
        throw new Error('COMMUNITY_PENDING_BODY_CHANGED')
      }
      if (original?.upload !== undefined) {
        const before = original.upload, after = checked.upload
        if (after === undefined || JSON.stringify(before.file) !== JSON.stringify(after.file)
          || JSON.stringify(before.target) !== JSON.stringify(after.target) || before.scope !== after.scope
          || before.uploadId !== null && before.uploadId !== after.uploadId
          || before.attachmentId !== null && before.attachmentId !== after.attachmentId
          || before.sha256 !== null && before.sha256 !== after.sha256
          || before.completeBody !== null && before.completeBody !== after.completeBody
          || before.attachment !== null && JSON.stringify(before.attachment) !== JSON.stringify(after.attachment)
          || before.parts.some((part, index) => JSON.stringify(part) !== JSON.stringify(after.parts[index]))
          || before.ready && !after.ready) throw new Error('COMMUNITY_PENDING_BODY_CHANGED')
      }
      if (original === undefined && previous.length >= 256) throw new Error('COMMUNITY_PENDING_FULL')
      write(owner, [...previous.filter(item => item.operationId !== checked.operationId), checked])
    },
    remove(owner, operationId) { write(owner, read(owner).filter(item => item.operationId !== operationId)) },
  }
}
const hex = (value: Uint8Array): string => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
/**
 * Compute a bounded slice digest without using the whole file reader.
 * @param file - Selected browser file or blob.
 * @param offset - Slice start.
 * @param bytes - Slice length.
 * @returns Lowercase SHA256.
 */
export async function communitySliceDigest(file: Blob, offset: number, bytes: number): Promise<string> {
  return hex(sha256(new Uint8Array(await file.slice(offset, offset + bytes).arrayBuffer())))
}
/**
 * Hash a video incrementally with at most a four-MiB file slice in memory.
 * @param file - Selected browser file.
 * @param signal - Owner/upload cancellation.
 * @returns Full-file SHA256.
 */
export async function communityFileDigest(file: Blob, signal?: AbortSignal): Promise<string> {
  const digest = sha256.create()
  try {
    for (let offset = 0; offset < file.size; offset += 4_194_304) {
      if (signal?.aborted === true) throw new Error('COMMUNITY_CANCELLED')
      digest.update(new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 4_194_304)).arrayBuffer()))
    }
    if (signal?.aborted === true) throw new Error('COMMUNITY_CANCELLED')
    return hex(digest.digest())
  } finally { digest.destroy() }
}
/**
 * Verify the original file before an explicit upload recovery can send further bytes.
 * @param file - Reselected browser file.
 * @param upload - Original metadata and attempted slice identities.
 * @param signal - Captured owner cancellation.
 * @returns Whether metadata and original content match.
 */
export async function matchesCommunityUpload(file: File, upload: CommunityPendingUpload, signal?: AbortSignal): Promise<boolean> {
  if (file.name !== upload.file.name || file.size !== upload.file.size || file.type !== upload.file.type
    || file.lastModified !== upload.file.lastModified) return false
  if (upload.sha256 !== null && await communityFileDigest(file, signal) !== upload.sha256) return false
  for (const part of upload.parts) {
    if (signal?.aborted === true || await communitySliceDigest(file, part.offset, part.size) !== part.sha256) return false
  }
  return signal?.aborted !== true
}
