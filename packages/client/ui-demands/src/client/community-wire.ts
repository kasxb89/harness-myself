/** Strict community-v1 DTO decoding; legacy demand authors and statuses never enter this module. */
import type {
  CommunityAttachment, CommunityConfig, CommunityListing, CommunityMessage, CommunityOrder, CommunityStatus,
  CommunityUploadRules, CommunityUser,
} from './community-types.ts'

/** Malformed, contradictory or cross-domain community protocol data. */
export class CommunityWireError extends Error {
  constructor() { super('COMMUNITY_PROTOCOL_INVALID') }
}
/**
 * Require a non-array JSON object.
 * @param value - Untrusted JSON.
 * @returns Validated object.
 */
export function communityObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CommunityWireError()
  return value as Record<string, unknown>
}
/**
 * Decode JSON into an unknown value before validating its domain fields.
 * @param value - Raw JSON text.
 * @returns Untrusted parsed value for explicit DTO validation.
 */
export function communityJson(value: string): unknown { return JSON.parse(value) }
/**
 * Require bounded Unicode text without unsafe controls or lone surrogates.
 * @param value - Untrusted text.
 * @param maximum - Maximum Unicode scalar count.
 * @param empty - Whether blank text is permitted.
 * @returns Validated text.
 */
export function communityText(value: unknown, maximum = 12_000, empty = false): string {
  if (typeof value !== 'string' || Array.from(value).length > maximum || !empty && value.trim() === ''
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new CommunityWireError()
  for (const scalar of value) {
    const code = scalar.codePointAt(0) ?? 0
    if (code >= 0xD800 && code <= 0xDFFF) throw new CommunityWireError()
  }
  return value
}
/**
 * Require one opaque safe path segment.
 * @param value - Untrusted ID.
 * @returns Validated ID.
 */
export function communityId(value: unknown): string {
  const result = communityText(value, 128)
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) throw new CommunityWireError()
  return result
}
/**
 * Require a nonnegative safe number.
 * @param value - Unknown integer.
 * @param max - Inclusive bound.
 * @returns Integer.
 */
export function communityInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new CommunityWireError()
  return value
}
/**
 * Require an explicit boolean.
 * @param value - Unknown flag.
 * @returns Boolean.
 */
export function communityBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new CommunityWireError()
  return value
}
/**
 * Require one declared value.
 * @param value - Unknown value.
 * @param values - Valid discriminants.
 * @returns Matching value.
 */
export function communityChoice<T extends string>(value: unknown, values: readonly T[]): T {
  const result = values.find(candidate => candidate === value)
  if (result === undefined) throw new CommunityWireError()
  return result
}
/**
 * Parse bounded array members.
 * @param value - Unknown array.
 * @param max - Limit.
 * @param parse - Member decoder.
 * @returns Items.
 */
export function communityArray<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new CommunityWireError()
  return value.map(parse)
}
/**
 * Require a lowercase SHA256.
 * @param value - Unknown digest.
 * @returns Digest.
 */
export function communityDigest(value: unknown): string {
  const answer = communityText(value, 64)
  if (!/^[a-f0-9]{64}$/u.test(answer)) throw new CommunityWireError()
  return answer
}
/**
 * Require a durable operation UUID.
 * @param value - Unknown key.
 * @returns UUID.
 */
export function communityUuid(value: unknown): string {
  const answer = communityText(value, 36)
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(answer)) throw new CommunityWireError()
  return answer
}
const statuses: readonly CommunityStatus[] = ['open', 'accepted', 'awaiting_acceptance', 'completed', 'cancelled']
const positive = (value: unknown): number => {
  const result = communityInteger(value)
  if (result === 0) throw new CommunityWireError()
  return result
}
const timestamp = (value: unknown): number => communityInteger(value, 8_640_000_000_000)
const optionalId = (value: unknown): string => value === '' ? '' : communityId(value)
const mime = (value: unknown): string => communityChoice(value, [
  'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime',
])
/**
 * Validate an optional calendar date without local-time conversion or invented deadlines.
 * @param value - Explicit ISO calendar text or an empty field.
 * @returns Unchanged validated date text.
 */
export function communityCalendarDate(value: unknown): string {
  const result = communityText(value, 10, true)
  if (result === '') return result
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(result)
  if (match === null) throw new CommunityWireError()
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)) throw new CommunityWireError()
  return result
}
/**
 * Require the explicit server approval contract before entering public discovery or creating a moderated publication.
 * @param config - Validated configuration from the current owner.
 * @returns Whether the server declares both approval support and its publication policy.
 */
export function communityApprovalAvailable(config: CommunityConfig | null): boolean {
  return config?.capabilities.community_approval_v1 === true && config.publication_policy === 'approval_required'
}
/**
 * Decode a public user projection.
 * @param value - Unknown user.
 * @returns Credential-free user.
 */
export function communityUser(value: unknown): CommunityUser {
  const row = communityObject(value)
  return { id: positive(row.id), display_name: communityText(row.display_name, 200, true) }
}
/**
 * Decode one ready community attachment.
 * @param value - Unknown attachment.
 * @returns Validated media metadata.
 */
export function communityAttachment(value: unknown): CommunityAttachment {
  const row = communityObject(value), kind = communityChoice(row.kind, ['image', 'video']), type = mime(row.mime_type)
  if (!type.startsWith(kind + '/') || row.status !== 'ready') throw new CommunityWireError()
  return { id: communityId(row.id), name: communityText(row.name, 255), kind, mime_type: type,
    size_bytes: positive(row.size_bytes), status: 'ready', sha256: communityDigest(row.sha256),
    scope: communityChoice(row.scope, ['listing', 'conversation']) }
}
/**
 * Decode a strictly public listing.
 * @param value - Unknown DTO.
 * @returns Public fields and listing assets only.
 */
export function communityListing(value: unknown): CommunityListing {
  return parseListing(value, false)
}

function parseListing(value: unknown, includeApprovalReason: boolean): CommunityListing {
  const row = communityObject(value)
  if (row.schema_version !== 1) throw new CommunityWireError()
  const attachments = communityArray(row.public_attachments, 8, communityAttachment)
  if (attachments.some(item => item.scope !== 'listing')) throw new CommunityWireError()
  return { schema_version: 1, id: communityId(row.id), number: communityText(row.number, 128),
    title: communityText(row.title, 200), public_summary: communityText(row.public_summary, 4000),
    public_budget: communityText(row.public_budget, 100, true),
    ...row.expected_delivery_date === undefined ? {} : { expected_delivery_date: communityCalendarDate(row.expected_delivery_date) },
    ...row.approval_status === undefined ? {} : { approval_status: communityChoice(row.approval_status, ['pending', 'approved', 'rejected']) },
    ...!includeApprovalReason || row.approval_status !== 'rejected' || row.approval_reason === undefined ? {}
      : { approval_reason: communityText(row.approval_reason, 1000, true) },
    service_profile_id: optionalId(row.service_profile_id),
    service_profile_name: communityText(row.service_profile_name, 200, true), publisher: communityUser(row.publisher),
    status: communityChoice(row.status, statuses), public_attachments: attachments,
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at), can_accept: communityBoolean(row.can_accept) }
}
/**
 * Decode one private order, checking participants and the captured viewer role.
 * @param value - Unknown DTO.
 * @param accountId - Captured authenticated account ID.
 * @returns Validated order without private account/contact extras.
 */
export function communityOrder(value: unknown, accountId: string): CommunityOrder {
  const row = communityObject(value)
  if (row.schema_version !== 1) throw new CommunityWireError()
  const publisher = communityUser(row.publisher), acceptor = row.acceptor === null ? null : communityUser(row.acceptor)
  const role = communityChoice(row.my_role, ['publisher', 'acceptor', 'admin'])
  const listing = parseListing(row.listing, role === 'publisher' || role === 'admin')
  const id = communityId(row.id), status = communityChoice(row.status, statuses), lastSeq = communityInteger(row.last_seq)
  if (listing.id !== id || listing.publisher.id !== publisher.id || publisher.id === acceptor?.id
    || role === 'publisher' && String(publisher.id) !== accountId || role === 'acceptor' && String(acceptor?.id) !== accountId
    || status === 'open' && acceptor !== null || ['accepted', 'awaiting_acceptance', 'completed'].includes(status) && acceptor === null) {
    throw new CommunityWireError()
  }
  return { schema_version: 1, id, number: communityText(row.number, 128), title: communityText(row.title, 200), status,
    revision: communityInteger(row.revision), publisher, acceptor, my_role: role, listing,
    private_text: communityText(row.private_text, 12_000, true), last_seq: lastSeq,
    last_read_seq: communityInteger(row.last_read_seq, lastSeq), unread_count: communityInteger(row.unread_count, lastSeq),
    delivery_message_id: optionalId(row.delivery_message_id), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    accepted_at: timestamp(row.accepted_at), closed_at: timestamp(row.closed_at), can_send: communityBoolean(row.can_send),
    can_deliver: communityBoolean(row.can_deliver), can_accept_delivery: communityBoolean(row.can_accept_delivery),
    can_cancel: communityBoolean(row.can_cancel), can_reopen: communityBoolean(row.can_reopen) }
}
/**
 * Decode actual message identity, kind and scoped assets.
 * @param value - Unknown DTO.
 * @returns Server message.
 */
export function communityMessage(value: unknown): CommunityMessage {
  const row = communityObject(value), author = communityChoice(row.author_kind, ['publisher', 'acceptor', 'admin', 'system'])
  const sender = communityInteger(row.sender_id), kind = communityChoice(row.kind, ['message', 'delivery', 'system'])
  if ((author === 'system') !== (sender === 0) || (author === 'system') !== (kind === 'system')) throw new CommunityWireError()
  const attachments = communityArray(row.attachments, 8, communityAttachment)
  if (attachments.some(item => item.scope !== 'conversation')) throw new CommunityWireError()
  return { id: communityId(row.id), order_id: communityId(row.order_id), seq: positive(row.seq), sender_id: sender,
    author_kind: author, author_name: communityText(row.author_name, 200, true), kind, text: communityText(row.text, 12_000, true),
    attachments, created_at: timestamp(row.created_at),
    client_message_id: communityText(row.client_message_id, 80, author === 'system'), read: communityBoolean(row.read) }
}
/**
 * Decode backend-owned upload limits.
 * @param value - Unknown rules.
 * @returns Validated limits.
 */
export function communityUploadRules(value: unknown): CommunityUploadRules {
  const row = communityObject(value), maxFiles = communityInteger(row.max_attachments, 8), chunk = positive(row.chunk_bytes)
  if (chunk > 67_108_864) throw new CommunityWireError()
  return { max_attachments: maxFiles, max_image_bytes: positive(row.max_image_bytes), max_video_bytes: positive(row.max_video_bytes),
    chunk_bytes: chunk, allowed_mime_types: communityArray(row.allowed_mime_types, 16, mime),
    upload_ttl_seconds: positive(row.upload_ttl_seconds) }
}
/**
 * Decode the config DTO itself; transport wrappers are owned separately.
 * @param value - DTO.
 * @returns Config.
 */
export function communityConfig(value: unknown): CommunityConfig {
  const row = communityObject(value), caps = communityObject(row.capabilities)
  if (row.schema_version !== 1) throw new CommunityWireError()
  return { schema_version: 1, enabled: communityBoolean(row.enabled), capabilities: {
    community_orders_v1: communityBoolean(caps.community_orders_v1), explicit_publication: communityBoolean(caps.explicit_publication),
    single_acceptor: communityBoolean(caps.single_acceptor), resumable_upload: communityBoolean(caps.resumable_upload),
    private_participant_messages: communityBoolean(caps.private_participant_messages),
    ...caps.community_approval_v1 === undefined ? {} : { community_approval_v1: communityBoolean(caps.community_approval_v1) },
  }, ...row.publication_policy === undefined ? {} : { publication_policy: communityChoice(row.publication_policy, ['approval_required']) },
  upload_rules: communityUploadRules(row.upload_rules) }
}
/** One cursor page of validated records. */
export interface CommunityWirePage<T> { readonly items: readonly T[]; readonly next_cursor: string; readonly has_more: boolean }
/**
 * Decode an opaque cursor page.
 * @param value - Unknown page.
 * @param parse - Record decoder.
 * @returns Page.
 */
export function communityPage<T>(value: unknown, parse: (item: unknown) => T): CommunityWirePage<T> {
  const row = communityObject(value), cursor = communityText(row.next_cursor, 256, true), more = communityBoolean(row.has_more)
  if (more && cursor === '') throw new CommunityWireError()
  return { items: communityArray(row.items, 100, parse), next_cursor: cursor, has_more: more }
}
/** Validated messages and their current order projection. */
export interface CommunityWireMessages {
  readonly items: readonly CommunityMessage[]
  readonly order: CommunityOrder
  readonly last_seq: number
  readonly next_after_seq: number
  readonly has_more: boolean
}
/**
 * Decode one strictly increasing message page belonging to one order.
 * @param value - Unknown page.
 * @param orderId - Requested order.
 * @param accountId - Captured viewer.
 * @param afterSeq - Requested lower bound.
 * @returns Validated message page.
 */
export function communityMessages(value: unknown, orderId: string, accountId: string, afterSeq: number): CommunityWireMessages {
  const row = communityObject(value), order = communityOrder(row.order, accountId)
  const messages = communityArray(row.items, 100, communityMessage)
  let previous = afterSeq
  const ids = new Set<string>()
  for (const item of messages) {
    if (item.order_id !== orderId || item.seq <= previous || item.seq > order.last_seq || ids.has(item.id)) throw new CommunityWireError()
    if (item.author_kind === 'publisher' && item.sender_id !== order.publisher.id
      || item.author_kind === 'acceptor' && item.sender_id !== order.acceptor?.id) throw new CommunityWireError()
    previous = item.seq; ids.add(item.id)
  }
  const next = communityInteger(row.next_after_seq), last = communityInteger(row.last_seq), more = communityBoolean(row.has_more)
  if (order.id !== orderId || next < previous || next > last || last !== order.last_seq || more && next <= afterSeq) {
    throw new CommunityWireError()
  }
  return { items: messages, order, last_seq: last, next_after_seq: next, has_more: more }
}
/** One successful mutation receipt, preserving the original message when present. */
export interface CommunityReceipt { readonly order: CommunityOrder; readonly message: CommunityMessage | null; readonly replayed: boolean }
/**
 * Decode create/message/action/accept receipts.
 * @param value - Unknown receipt.
 * @param accountId - Viewer.
 * @returns Receipt.
 */
export function communityReceipt(value: unknown, accountId: string): CommunityReceipt {
  const row = communityObject(value), order = communityOrder(row.order, accountId)
  const message = row.message === undefined || row.message === null ? null : communityMessage(row.message)
  if (message !== null && (message.order_id !== order.id || message.seq > order.last_seq)) throw new CommunityWireError()
  return { order, message, replayed: communityBoolean(row.replayed) }
}
/** Committed resumable upload position; no local storage path is exposed. */
export interface CommunityWireUpload {
  readonly id: string
  readonly attachment_id: string
  readonly offset: number
  readonly chunk_bytes: number
  readonly status: 'uploading' | 'ready'
  readonly expires_at: number
  readonly attachment: CommunityAttachment | null
}
/**
 * Decode the single upload DTO.
 * @param value - Unknown DTO.
 * @returns Upload metadata.
 */
export function communityUpload(value: unknown): CommunityWireUpload {
  const row = communityObject(value), status = communityChoice(row.status, ['uploading', 'ready'])
  const attachment = row.attachment === null ? null : communityAttachment(row.attachment)
  const id = communityId(row.id), attachmentId = communityId(row.attachment_id), chunk = positive(row.chunk_bytes)
  if (chunk > 67_108_864 || status === 'ready' && attachment === null || attachment !== null && attachment.id !== attachmentId) {
    throw new CommunityWireError()
  }
  return { id, attachment_id: attachmentId, offset: communityInteger(row.offset), chunk_bytes: chunk, status,
    expires_at: timestamp(row.expires_at), attachment }
}
