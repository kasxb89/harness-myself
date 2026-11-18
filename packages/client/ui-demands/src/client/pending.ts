/** Durable, owner-isolated operation bodies. A failed receipt never mints a replacement key. */
import type { DemandOwner } from './api.ts'
import { array, choice, id, integer, object, text, uuid } from './wire.ts'

/**
 * Digest of one bounded slice recorded before its first upload attempt.
 */
export interface UploadPartDigest { readonly offset: number; readonly size: number; readonly sha256: string }
/**
 * Owner-scoped file metadata and attempted slice hashes needed for safe reselection after reload.
 */
export interface PendingUpload {
  readonly engineerId: string
  /** Present only for platform-intake uploads in the v2 namespace. */
  readonly serviceProfileId?: string
  readonly requestId: string | null
  readonly file: { readonly name: string; readonly size: number; readonly type: string; readonly lastModified: number }
  readonly parts: readonly UploadPartDigest[]
  readonly uploadId: string | null
  readonly ready: boolean
}
/**
 * A durable operation whose UUID, route and exact serialized body remain immutable across retries.
 */
export interface PendingOperation {
  readonly version: 1 | 2
  /** Platform routing metadata never enters an old reader's v1 namespace. */
  readonly serviceProfileId?: string
  /** Captured display name for an unpublished request recovered after reload. */
  readonly serviceProfileName?: string
  readonly operationId: string
  readonly scopeKey: string
  readonly kind: 'create' | 'message' | 'action' | 'upload'
  readonly path: string
  /** Exact serialized JSON submitted on every retry, including after reload. */
  readonly body: string
  readonly createdAt: number
  readonly upload?: PendingUpload
}
/**
 * Per-owner persistence; storage failures throw before a new mutation may be submitted.
 */
export interface DemandJournal {
  read(owner: Pick<DemandOwner, 'id' | 'owner'>): readonly PendingOperation[]
  put(owner: Pick<DemandOwner, 'id' | 'owner'>, operation: PendingOperation): void
  remove(owner: Pick<DemandOwner, 'id' | 'owner'>, operationId: string): void
}
/**
 * Minimal local-storage adapter, replaceable with isolated storage in tests.
 */
export interface DemandStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function digest(value: unknown): string {
  const answer = text(value, 64)
  if (!/^[a-f\d]{64}$/u.test(answer)) throw new Error('DEMAND_PENDING_INVALID')
  return answer
}
/**
 * Reject malformed durable records instead of dropping an unresolved operation.
 * @param value - Unknown stored record.
 * @returns A validated operation or a validation error.
 */
export function parsePending(value: unknown): PendingOperation {
  const row = object(value)
  if (row.version !== 1 && row.version !== 2) throw new Error('DEMAND_PENDING_INVALID')
  const version = row.version
  const serviceProfileId = version === 2 ? id(row.serviceProfileId) : ''
  if (serviceProfileId.length > 40) throw new Error('DEMAND_PENDING_INVALID')
  const serviceProfileName = version === 2 && row.serviceProfileName !== undefined ? text(row.serviceProfileName, 200, true) : undefined
  if (version === 1 && (row.serviceProfileId !== undefined || row.serviceProfileName !== undefined)) throw new Error('DEMAND_PENDING_INVALID')
  const kind = choice(row.kind, ['create', 'message', 'action', 'upload']), operationId = uuid(row.operationId)
  const path = text(row.path, 256, true), body = text(row.body, 65_536), payload = object(JSON.parse(body) as unknown)
  const key = kind === 'create' ? 'client_request_id' : kind === 'message' ? 'client_message_id' : kind === 'action' ? 'client_action_id' : 'client_upload_id'
  if (payload[key] !== operationId || kind === 'create' && path !== '' || kind === 'upload' && path !== '/uploads'
    || kind === 'message' && !/^\/[A-Za-z0-9_-]+\/messages$/u.test(path) || kind === 'action' && !/^\/[A-Za-z0-9_-]+\/actions$/u.test(path)) throw new Error('DEMAND_PENDING_INVALID')
  if (kind === 'create' || kind === 'message') {
    text(payload.text, 10_000, true)
    array(payload.attachment_ids, 64, id)
    if (kind === 'create') {
      if (version === 1) {
        id(payload.engineer_id)
        if (payload.service_profile_id !== undefined && payload.service_profile_id !== '') throw new Error('DEMAND_PENDING_INVALID')
      } else if (id(payload.service_profile_id) !== serviceProfileId || payload.engineer_id !== undefined && payload.engineer_id !== '') throw new Error('DEMAND_PENDING_INVALID')
      text(payload.title, 200, true); text(payload.budget, 100, true); text(payload.expected_date, 10, true)
    }
  } else if (kind === 'action') {
    if (payload.action !== 'accept_delivery') throw new Error('DEMAND_PENDING_INVALID')
    integer(payload.revision); id(payload.delivery_id)
  } else { text(payload.name, 255); text(payload.mime_type, 128); integer(payload.size_bytes, 2 ** 31) }
  let upload: PendingUpload | undefined
  if (kind === 'upload') {
    const data = object(row.upload), file = object(data.file), size = integer(file.size, 2 ** 31)
    if (typeof data.ready !== 'boolean') throw new Error('DEMAND_PENDING_INVALID')
    const engineerId = version === 1 ? id(data.engineerId) : text(data.engineerId, 128, true)
    if (version === 2 && (engineerId !== '' || id(data.serviceProfileId) !== serviceProfileId)) throw new Error('DEMAND_PENDING_INVALID')
    upload = { engineerId, ...version === 2 ? { serviceProfileId } : {}, requestId: data.requestId === null ? null : id(data.requestId),
      file: { name: text(file.name, 255), size, type: text(file.type, 128), lastModified: integer(file.lastModified) },
      parts: array(data.parts, 32_768, (value) => {
        const part = object(value), offset = integer(part.offset, size), bytes = integer(part.size, size - offset)
        if (bytes < 1) throw new Error('DEMAND_PENDING_INVALID')
        return { offset, size: bytes, sha256: digest(part.sha256) }
      }), uploadId: data.uploadId === null ? null : id(data.uploadId), ready: data.ready }
    if (payload.name !== upload.file.name || payload.mime_type !== upload.file.type || payload.size_bytes !== size) throw new Error('DEMAND_PENDING_INVALID')
  }
  return { version, ...version === 2 ? { serviceProfileId,
    ...serviceProfileName === undefined ? {} : { serviceProfileName } } : {},
  operationId, scopeKey: text(row.scopeKey, 256), kind, path, body,
  createdAt: integer(row.createdAt, 8_640_000_000_000_000),
  ...upload === undefined ? {} : { upload } }
}

/**
 * Create a durable owner-isolated journal; unavailable or corrupt storage blocks new mutations.
 * @param storage - Optional backing store; defaults to this browser's localStorage.
 * @returns A journal whose immutable-body and storage failures throw synchronously.
 */
export function createDemandJournal(storage?: DemandStorage): DemandJournal {
  const backing = (): DemandStorage => storage ?? globalThis.localStorage
  const key = (owner: Pick<DemandOwner, 'id' | 'owner'>, version: 1 | 2): string => `yunshu.demands.pending.v${version}:${JSON.stringify([owner.id, owner.owner])}`
  const readVersion = (owner: Pick<DemandOwner, 'id' | 'owner'>, version: 1 | 2): readonly PendingOperation[] => {
    const raw = backing().getItem(key(owner, version))
    if (raw === null) return []
    if (raw.length > 4_194_304) throw new Error('DEMAND_PENDING_INVALID')
    const value = object(JSON.parse(raw) as unknown)
    if (value.version !== version || value.accountId !== owner.id || value.accountOwner !== owner.owner) throw new Error('DEMAND_PENDING_INVALID')
    const result = array(value.operations, 256, parsePending)
    if (result.some(item => item.version !== version)) throw new Error('DEMAND_PENDING_INVALID')
    return result
  }
  const read = (owner: Pick<DemandOwner, 'id' | 'owner'>): readonly PendingOperation[] => {
    const result = [...readVersion(owner, 1), ...readVersion(owner, 2)]
    if (new Set(result.map(item => item.operationId)).size !== result.length) throw new Error('DEMAND_PENDING_INVALID')
    return result
  }
  const write = (owner: Pick<DemandOwner, 'id' | 'owner'>, version: 1 | 2, operations: readonly PendingOperation[]): void => {
    const target = backing(), name = key(owner, version)
    if (operations.length === 0) { target.removeItem(name); return }
    const raw = JSON.stringify({ version, accountId: owner.id, accountOwner: owner.owner, operations })
    if (raw.length > 4_194_304) throw new Error('DEMAND_PENDING_FULL')
    target.setItem(name, raw)
  }
  return {
    read,
    put(owner, operation) {
      const checked = parsePending(operation), previous = read(owner)
      const existing = previous.find(item => item.operationId === checked.operationId)
      if (existing !== undefined && (existing.body !== checked.body || existing.path !== checked.path || existing.kind !== checked.kind
        || existing.scopeKey !== checked.scopeKey || existing.version !== checked.version
        || existing.serviceProfileId !== checked.serviceProfileId
        || existing.serviceProfileName !== checked.serviceProfileName)) throw new Error('DEMAND_PENDING_BODY_CHANGED')
      if (existing === undefined && previous.length >= 256) throw new Error('DEMAND_PENDING_FULL')
      write(owner, checked.version, [
        ...previous.filter(item => item.version === checked.version && item.operationId !== checked.operationId), checked])
    },
    remove(owner, operationId) {
      const previous = read(owner), existing = previous.find(item => item.operationId === operationId)
      if (existing !== undefined) write(owner, existing.version,
        previous.filter(item => item.version === existing.version && item.operationId !== operationId))
    },
  }
}

/**
 * Hash one bounded file slice without invoking the whole-file reader.
 * @param file - In-memory file or blob.
 * @param offset - First byte of the slice.
 * @param size - Number of bytes in the slice.
 * @returns The lowercase SHA-256 digest.
 */
export async function sliceDigest(file: Blob, offset: number, size: number): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', await file.slice(offset, offset + size).arrayBuffer())
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Verify metadata and every attempted slice before a reselected file can resume an upload.
 * @param file - New browser file selection.
 * @param upload - Durable original metadata and attempted slice digests.
 * @param signal - Optional cancellation checked between bounded slice reads.
 * @returns Whether metadata and all recorded slices match; false on cancellation.
 */
export async function matchesUpload(file: File, upload: PendingUpload, signal?: AbortSignal): Promise<boolean> {
  if (file.name !== upload.file.name || file.size !== upload.file.size || file.type !== upload.file.type
    || file.lastModified !== upload.file.lastModified) return false
  for (const part of upload.parts) {
    if (signal?.aborted === true || await sliceDigest(file, part.offset, part.size) !== part.sha256) return false
  }
  return signal?.aborted !== true
}
