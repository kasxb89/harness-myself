/** Decode unknown demand-v1 JSON into credential-free browser records. */
import type { DemandStatus } from './types.ts'

/**
 * An invalid or inconsistent demand-v1 response; callers retain their last verified state.
 */
export class DemandWireError extends Error {
  constructor() { super('DEMAND_PROTOCOL_INVALID') }
}
/**
 * Require a JSON object before inspecting its fields.
 * @param value - Untrusted JSON value.
 * @returns The object or a protocol error.
 */
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DemandWireError()
  return value as Record<string, unknown>
}
/**
 * Require bounded display text without forbidden control characters.
 * @param value - Untrusted field.
 * @param maximum - Maximum UTF-16 length.
 * @param empty - Whether blank text is permitted.
 * @returns Validated text or a protocol error.
 */
export function text(value: unknown, maximum = 10_000, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || !empty && value.trim() === '' || /[\u0000\u000b\u000c]/u.test(value)) throw new DemandWireError()
  return value
}
/**
 * Require an opaque identifier safe for one route segment.
 * @param value - Untrusted identifier.
 * @returns Validated identifier or a protocol error.
 */
export function id(value: unknown): string {
  const result = text(value, 128)
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) throw new DemandWireError()
  return result
}
/**
 * Require a nonnegative safe integer within its declared limit.
 * @param value - Untrusted numeric field.
 * @param maximum - Inclusive upper bound.
 * @returns Validated integer or a protocol error.
 */
export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new DemandWireError()
  return value
}
/**
 * Require an explicit boolean without truthiness coercion.
 * @param value - Untrusted flag.
 * @returns The boolean or a protocol error.
 */
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DemandWireError()
  return value
}
/**
 * Require one declared protocol discriminant.
 * @param value - Untrusted discriminant.
 * @param values - Allowed wire values.
 * @returns The matching value or a protocol error.
 */
export function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new DemandWireError()
  return value as T
}
/**
 * Validate a bounded JSON array and each member.
 * @param value - Untrusted array.
 * @param maximum - Maximum item count.
 * @param parse - Member validator, which may throw.
 * @returns Validated members or a protocol error.
 */
export function array<T>(value: unknown, maximum: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new DemandWireError()
  return value.map(parse)
}
/**
 * Require the UUID shape used by durable mutation identities.
 * @param value - Untrusted operation identity.
 * @returns Validated UUID or a protocol error.
 */
export function uuid(value: unknown): string {
  const result = text(value, 36)
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(result)) throw new DemandWireError()
  return result
}
const optional = (value: unknown, maximum: number): string => value === undefined || value === null ? '' : text(value, maximum, true)
/**
 * Server-owned customer request stages accepted by this client.
 */
export const statuses: readonly DemandStatus[] = ['pending', 'communicating', 'in_progress', 'awaiting_acceptance', 'completed', 'cancelled', 'closed']

/**
 * Public administrator-published profile, excluding credentials and arbitrary media URLs.
 */
export interface WireEngineer {
  readonly id: string
  readonly display_name: string
  readonly avatar_attachment_id: string
  readonly category_ids: readonly string[]
  readonly introduction: string
  readonly service_hours: string
  readonly presence: 'online' | 'busy' | 'offline'
  readonly accepting: boolean
  readonly can_start: boolean
  readonly capacity: number
}
/**
 * Decode a public profile and its server-owned presence and admission flags.
 * @param value - Unknown profile JSON.
 * @returns Validated profile or a protocol error.
 */
export function engineer(value: unknown): WireEngineer {
  const row = object(value)
  return { id: id(row.id), display_name: text(row.display_name, 200),
    avatar_attachment_id: row.avatar_attachment_id === undefined || row.avatar_attachment_id === '' ? '' : id(row.avatar_attachment_id),
    category_ids: array(row.category_ids, 64, id), introduction: text(row.introduction, 10_000, true),
    service_hours: text(row.service_hours, 1000, true), presence: choice(row.presence, ['online', 'busy', 'offline']),
    accepting: boolean(row.accepting), can_start: boolean(row.can_start), capacity: integer(row.capacity, 1000) }
}
/**
 * Verified attachment metadata; content URLs are supplied by the local Host separately.
 */
export interface WireAttachment {
  readonly id: string
  readonly name: string
  readonly kind: 'image' | 'video'
  readonly mime_type: string
  readonly size_bytes: number
  readonly uploaded_bytes: number
  readonly status: 'uploading' | 'ready' | 'failed'
  readonly sha256: string
  readonly demand_id: string
}
/**
 * Validate attachment bounds, media type, digest and committed byte count.
 * @param value - Unknown attachment JSON.
 * @returns Validated metadata or a protocol error.
 */
export function attachment(value: unknown): WireAttachment {
  const row = object(value), size = integer(row.size_bytes, 2 ** 31), uploaded = integer(row.uploaded_bytes, size)
  const digest = optional(row.sha256, 64), mime = text(row.mime_type, 128)
  if (digest !== '' && !/^[a-f\d]{64}$/u.test(digest) || !/^(?:image|video)\/[A-Za-z0-9.+-]+$/u.test(mime)) throw new DemandWireError()
  return { id: id(row.id), name: text(row.name, 255), kind: choice(row.kind, ['image', 'video']), mime_type: mime,
    size_bytes: size, uploaded_bytes: uploaded, status: choice(row.status, ['uploading', 'ready', 'failed']), sha256: digest,
    demand_id: row.demand_id === undefined || row.demand_id === null || row.demand_id === '' ? '' : id(row.demand_id) }
}
/**
 * Customer-visible request fields retained for revision and delivery reconciliation.
 */
export interface WireDemand {
  readonly id: string
  readonly number: string
  readonly engineer_id: string
  readonly engineer: WireEngineer
  readonly status: DemandStatus
  readonly revision: number
  readonly last_seq: number
  readonly last_read_seq: number
  readonly unread_count: number
  readonly title: string
  readonly preview: string
  readonly budget: string
  readonly expected_date: string
  readonly delivery_id: string
  readonly created_at: number
  readonly updated_at: number
}
/**
 * Decode a request whose assignment and read cursor are internally consistent.
 * @param value - Unknown request JSON.
 * @returns Validated request or a protocol error.
 */
export function demand(value: unknown): WireDemand {
  const row = object(value), assigned = engineer(row.engineer), engineerId = id(row.engineer_id)
  const lastSeq = integer(row.last_seq), lastRead = integer(row.last_read_seq, lastSeq)
  integer(row.user_id); choice(row.priority, ['normal', 'high', 'urgent'])
  if (assigned.id !== engineerId) throw new DemandWireError()
  return { id: id(row.id), number: text(row.number, 128), engineer_id: engineerId, engineer: assigned,
    status: choice(row.status, statuses), revision: integer(row.revision), last_seq: lastSeq, last_read_seq: lastRead,
    unread_count: integer(row.unread_count), title: optional(row.title, 200), preview: text(row.preview, 10_000, true),
    budget: optional(row.budget, 100), expected_date: optional(row.expected_date, 100),
    delivery_id: row.delivery_id === undefined || row.delivery_id === '' ? '' : id(row.delivery_id),
    created_at: integer(row.created_at, 8_640_000_000_000), updated_at: integer(row.updated_at, 8_640_000_000_000) }
}
/**
 * One server-persisted message with immutable sequence and server-derived read receipt.
 */
export interface WireMessage {
  readonly id: string
  readonly demand_id: string
  readonly seq: number
  readonly author: 'user' | 'engineer' | 'system'
  /** Backend attribution; an omitted legacy field decodes to an empty name. */
  readonly author_name: string
  readonly kind: 'message' | 'delivery' | 'system'
  readonly text: string
  readonly attachments: readonly WireAttachment[]
  readonly created_at: number
  readonly client_message_id: string
  readonly read: boolean
}
/**
 * Decode a persisted message without inventing send or read acknowledgements.
 * @param value - Unknown message JSON.
 * @returns Validated message or a protocol error.
 */
export function message(value: unknown): WireMessage {
  const row = object(value), seq = integer(row.seq)
  integer(row.sender_id)
  if (seq < 1) throw new DemandWireError()
  return { id: id(row.id), demand_id: id(row.demand_id), seq, author: choice(row.author, ['user', 'engineer', 'system']),
    author_name: row.author_name === undefined ? '' : text(row.author_name, 200, true),
    kind: choice(row.kind, ['message', 'delivery', 'system']), text: text(row.text, 10_000, true),
    attachments: array(row.attachments, 64, attachment), created_at: integer(row.created_at, 8_640_000_000_000),
    client_message_id: text(row.client_message_id, 128, true), read: boolean(row.read) }
}
/**
 * Dynamic backend availability, categories and per-kind upload limits.
 */
export interface WireConfig {
  readonly enabled: boolean
  readonly categories: readonly { readonly id: string; readonly name: string; readonly enabled: boolean }[]
  readonly upload_rules: {
    readonly max_image_bytes: number
    readonly max_video_bytes: number
    readonly max_attachments: number
    readonly chunk_bytes: number
    readonly allowed_mime_types: readonly string[]
    readonly upload_ttl_seconds: number
  }
}
/**
 * Decode dynamic service configuration and its declared transport capabilities.
 * @param value - Unknown config reply payload.
 * @returns Validated configuration or a protocol error.
 */
export function configuration(value: unknown): WireConfig {
  const reply = object(value), row = object(reply.config), rules = object(row.upload_rules), capabilities = object(reply.capabilities)
  integer(reply.server_time); boolean(capabilities.resumable_upload); boolean(capabilities.polling)
  const chunk = integer(rules.chunk_bytes, 16_777_216)
  if (chunk < 1) throw new DemandWireError()
  return { enabled: boolean(row.enabled), categories: array(row.categories, 64, (value) => {
    const item = object(value)
    return { id: id(item.id), name: text(item.name, 200), enabled: boolean(item.enabled) }
  }), upload_rules: { max_image_bytes: integer(rules.max_image_bytes, 2 ** 31), max_video_bytes: integer(rules.max_video_bytes, 2 ** 31),
    max_attachments: integer(rules.max_attachments, 64), chunk_bytes: chunk,
    allowed_mime_types: array(rules.allowed_mime_types, 32, (value) => {
      const mime = text(value, 128)
      if (!/^(?:image|video)\/[A-Za-z0-9.+-]+$/u.test(mime)) throw new DemandWireError()
      return mime
    }), upload_ttl_seconds: integer(rules.upload_ttl_seconds) } }
}
/**
 * Decode the actual published engineer directory.
 * @param value - Unknown directory reply payload.
 * @returns Validated profiles or a protocol error.
 */
export function directory(value: unknown): readonly WireEngineer[] {
  const reply = object(value); integer(reply.server_time)
  return array(reply.items, 200, engineer)
}
/**
 * Decode a request page with a usable continuation cursor when more rows exist.
 * @param value - Unknown list reply payload.
 * @returns Validated page and cursor or a protocol error.
 */
export function list(value: unknown): { items: readonly WireDemand[]; has_more: boolean; next_before_id: string | null } {
  const reply = object(value), hasMore = boolean(reply.has_more)
  const cursor = reply.next_before_id === '' || reply.next_before_id === null ? null : id(reply.next_before_id)
  if (hasMore && cursor === null) throw new DemandWireError()
  return { items: array(reply.items, 100, demand), has_more: hasMore, next_before_id: cursor }
}
/**
 * Require an ascending, same-demand message page with bounded sequence cursors.
 * @param value - Unknown message-page payload.
 * @param requestId - Demand selected by the requesting operation.
 * @returns Validated page or a protocol error.
 */
export function messages(value: unknown, requestId: string): {
  items: readonly WireMessage[]
  demand: WireDemand
  next_after_seq: number
  last_seq: number
  has_more: boolean
} {
  const reply = object(value), row = demand(reply.demand), last = integer(reply.last_seq), next = integer(reply.next_after_seq, last)
  const items = array(reply.items, 100, message)
  if (row.id !== requestId || row.last_seq !== last || items.some((item, index) => item.demand_id !== requestId || item.seq > next
    || index > 0 && item.seq <= (items[index - 1]?.seq ?? 0))) throw new DemandWireError()
  return { items, demand: row, next_after_seq: next, last_seq: last, has_more: boolean(reply.has_more) }
}
/**
 * Require a persisted message receipt belonging to the returned request.
 * @param value - Unknown create or send receipt payload.
 * @returns Validated receipt or a protocol error.
 */
export function sendReceipt(value: unknown): { demand: WireDemand; message: WireMessage; replayed: boolean } {
  const reply = object(value), row = demand(reply.demand), item = message(reply.message)
  if (row.id !== item.demand_id || item.seq > row.last_seq) throw new DemandWireError()
  return { demand: row, message: item, replayed: boolean(reply.replayed) }
}
/**
 * Decode the request inside a detail or action reply.
 * @param value - Unknown reply payload.
 * @returns Validated request or a protocol error.
 */
export function detail(value: unknown): WireDemand { return demand(object(value).demand) }
/**
 * Validate upload status and its exact committed offset.
 * @param value - Unknown initialization or status reply payload.
 * @returns Validated upload status or a protocol error.
 */
export function upload(value: unknown): { attachment: WireAttachment; offset: number; chunk_bytes: number; expires_at: number } {
  const row = object(value), item = attachment(row.attachment), offset = integer(row.offset, item.size_bytes)
  const chunk = integer(row.chunk_bytes, 16_777_216)
  if (offset !== item.uploaded_bytes || chunk < 1) throw new DemandWireError()
  return { attachment: item, offset, chunk_bytes: chunk, expires_at: integer(row.expires_at) }
}
/**
 * Require the acknowledged chunk offset to match committed attachment bytes.
 * @param value - Unknown chunk receipt payload.
 * @returns Validated offset and metadata or a protocol error.
 */
export function chunkReceipt(value: unknown): { attachment: WireAttachment; offset: number } {
  const row = object(value), item = attachment(row.attachment), offset = integer(row.offset, item.size_bytes)
  if (offset !== item.uploaded_bytes) throw new DemandWireError()
  return { attachment: item, offset }
}
/**
 * Require a ready attachment whose full declared length is committed.
 * @param value - Unknown completion reply payload.
 * @returns Ready metadata or a protocol error.
 */
export function completedUpload(value: unknown): WireAttachment {
  const item = attachment(object(value).attachment)
  if (item.status !== 'ready' || item.uploaded_bytes !== item.size_bytes) throw new DemandWireError()
  return item
}
