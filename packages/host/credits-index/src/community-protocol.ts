/** Credential-free projections for the separately versioned community-orders contract. */
import { DemandProtocolError, demandInteger, demandObject, demandText, type DemandObject } from './demand-protocol.ts'

/** Community identities are UUID resources, never an official-demand or directory route selector. */
export type CommunityId = string & { readonly __communityId: 'CommunityId' }
/** Lifecycle states belong only to community-orders-v1. */
export const COMMUNITY_STATUSES = ['open', 'accepted', 'awaiting_acceptance', 'completed', 'cancelled'] as const
/** Explicit public error codes retained without remote messages, contacts or diagnostics. */
export const COMMUNITY_ERRORS: ReadonlySet<string> = new Set([
  'COMMUNITY_AUTH_REQUIRED', 'COMMUNITY_FORBIDDEN', 'COMMUNITY_NOT_FOUND', 'COMMUNITY_DISABLED',
  'COMMUNITY_EXPLICIT_PUBLICATION_REQUIRED', 'COMMUNITY_INVALID_INPUT', 'COMMUNITY_CURSOR_INVALID',
  'COMMUNITY_IDEMPOTENCY_CONFLICT', 'COMMUNITY_SELF_ACCEPT_FORBIDDEN', 'COMMUNITY_ALREADY_ACCEPTED',
  'COMMUNITY_ORDER_NOT_OPEN', 'COMMUNITY_REVISION_CONFLICT', 'COMMUNITY_STATE_CONFLICT', 'COMMUNITY_READ_ONLY',
  'COMMUNITY_REOPEN_FORBIDDEN', 'COMMUNITY_ATTACHMENT_NOT_READY', 'COMMUNITY_ATTACHMENT_IN_USE',
  'COMMUNITY_UPLOAD_OFFSET_CONFLICT', 'COMMUNITY_UPLOAD_TOO_LARGE', 'COMMUNITY_UPLOAD_UNSUPPORTED',
  'COMMUNITY_STORAGE_UNAVAILABLE', 'COMMUNITY_RATE_LIMITED',
])
const mediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'] as const
const scopes = ['listing', 'conversation'] as const

/**
 * Validate a community resource identity before placing it in a fixed route segment.
 * @param value - Untrusted order, message or upload identity.
 * @returns The original UUID, branded for this protocol family.
 */
export function communityId(value: unknown): CommunityId {
  const result = demandText(value, 36)
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(result)) throw new DemandProtocolError()
  return result as CommunityId
}
function text(value: unknown, maximum: number, empty = false): string {
  const result = demandText(value, maximum * 2, empty)
  if (Array.from(result).length > maximum) throw new DemandProtocolError()
  return result
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DemandProtocolError()
  return value
}
function choice(value: unknown, values: readonly string[]): string {
  if (typeof value !== 'string' || !values.includes(value)) throw new DemandProtocolError()
  return value
}
function positive(value: unknown): number {
  const result = demandInteger(value)
  if (result === 0) throw new DemandProtocolError()
  return result
}
function array<T>(value: unknown, maximum: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new DemandProtocolError()
  return value.map(parse)
}
function resourceIds(value: unknown): CommunityId[] {
  const result = array(value ?? [], 8, communityId)
  if (new Set(result).size !== result.length) throw new DemandProtocolError()
  return result
}
function profileId(value: unknown): string {
  const result = demandText(value, 40)
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) throw new DemandProtocolError()
  return result
}
function optionalText(target: DemandObject, value: DemandObject, key: string, maximum: number): void {
  if (value[key] !== undefined) target[key] = text(value[key], maximum, true)
}
function digest(value: unknown): string {
  const result = demandText(value, 64)
  if (!/^[a-f\d]{64}$/iu.test(result)) throw new DemandProtocolError()
  return result
}
function version(value: unknown): 1 {
  if (value !== 1) throw new DemandProtocolError()
  return 1
}
function operationKey(value: unknown): string {
  const result = text(value, 80)
  if (/[\r\n]/u.test(result)) throw new DemandProtocolError()
  return result
}
function filename(value: unknown): string {
  const result = text(value, 255)
  if (/[\r\n/\\]/u.test(result)) throw new DemandProtocolError()
  return result
}

/**
 * Whitelist a community mutation while retaining its original durable submission key.
 * @param kind - Closed operation kind selected by the community proxy.
 * @param input - Untrusted browser JSON; undeclared fields never reach the upstream.
 * @returns Only the request fields in revision one of the frozen contract.
 */
export function communityRequest(kind: string, input: unknown): DemandObject {
  const value = demandObject(input)
  if (kind === 'create') {
    if (value.publish_to_community !== true) throw new DemandProtocolError()
    const result: DemandObject = { client_request_id: operationKey(value.client_request_id), publish_to_community: true,
      title: text(value.title, 200), public_summary: text(value.public_summary, 4000),
      public_attachment_ids: resourceIds(value.public_attachment_ids), private_attachment_ids: resourceIds(value.private_attachment_ids) }
    optionalText(result, value, 'public_budget', 100)
    optionalText(result, value, 'private_text', 12_000)
    if (value.service_profile_id !== undefined) result.service_profile_id = value.service_profile_id === '' ? '' : profileId(value.service_profile_id)
    return result
  }
  if (kind === 'accept') return { client_action_id: operationKey(value.client_action_id) }
  if (kind === 'message') {
    const content = text(value.text ?? '', 12_000, true), ids = resourceIds(value.attachment_ids)
    if (content.trim() === '' && ids.length === 0) throw new DemandProtocolError()
    return { client_message_id: operationKey(value.client_message_id), text: content, attachment_ids: ids }
  }
  if (kind === 'read') return { last_read_seq: demandInteger(value.last_read_seq) }
  if (kind === 'action') {
    const action = choice(value.action, ['cancel', 'reopen', 'deliver', 'accept_delivery', 'request_changes'])
    const result: DemandObject = { client_action_id: operationKey(value.client_action_id), revision: positive(value.revision), action,
      attachment_ids: resourceIds(value.attachment_ids) }
    optionalText(result, value, 'text', 12_000)
    if (action === 'request_changes' && (typeof result.text !== 'string' || result.text.trim() === '')) throw new DemandProtocolError()
    return result
  }
  if (kind === 'upload-init') {
    const name = filename(value.name)
    const result: DemandObject = { client_upload_id: operationKey(value.client_upload_id), scope: choice(value.scope, scopes), name,
      mime_type: choice(value.mime_type, mediaTypes), size_bytes: positive(value.size_bytes) }
    if (value.order_id !== undefined) result.order_id = communityId(value.order_id)
    return result
  }
  if (kind === 'upload-complete') return { sha256: digest(value.sha256) }
  if (kind === 'link') return { disposition: choice(value.disposition, ['inline', 'attachment']) }
  throw new DemandProtocolError()
}

/**
 * Validate only the filters accepted by the selected community read route.
 * @param kind - Closed operation kind selected by the proxy.
 * @param source - Caller query; duplicates and privileged filters are rejected.
 * @returns A new bounded query without arbitrary URL or account selectors.
 */
export function communityQuery(kind: string, source: URLSearchParams): URLSearchParams {
  const fields: Record<string, readonly string[]> = { listings: ['cursor', 'limit', 'q', 'service_profile_id'],
    orders: ['cursor', 'limit', 'view'], messages: ['after_seq', 'limit'] }
  const allowed = fields[kind] ?? [], result = new URLSearchParams()
  for (const [key, value] of source) {
    if (!allowed.includes(key) || result.has(key)) throw new DemandProtocolError()
    if (key === 'limit' || key === 'after_seq') {
      if (!/^\d{1,16}$/u.test(value)) throw new DemandProtocolError()
      const number = demandInteger(Number(value), key === 'limit' ? 100 : Number.MAX_SAFE_INTEGER)
      if (key === 'limit' && number === 0) throw new DemandProtocolError()
    } else if (key === 'cursor') text(value, 256, true)
    else if (key === 'q') text(value, 100, true)
    else if (key === 'view') choice(value, ['published', 'accepted', 'all'])
    else profileId(value)
    result.set(key, value)
  }
  return result
}

function user(input: unknown): DemandObject {
  const value = demandObject(input)
  return { id: positive(value.id), display_name: text(value.display_name, 200, true) }
}
function attachment(input: unknown, scope?: string): DemandObject {
  const value = demandObject(input), kind = choice(value.kind, ['image', 'video']), mime = choice(value.mime_type, mediaTypes)
  const actualScope = choice(value.scope, scopes)
  if (scope !== undefined && actualScope !== scope || !mime.startsWith(kind + '/')) throw new DemandProtocolError()
  return { id: communityId(value.id), name: filename(value.name), kind, mime_type: mime,
    size_bytes: positive(value.size_bytes), status: choice(value.status, ['ready']), sha256: digest(value.sha256), scope: actualScope }
}

/**
 * Project an explicitly published listing without private conversation or account contact fields.
 * @param input - Unknown server listing.
 * @returns Only the revision-one public listing fields.
 */
export function communityListing(input: unknown): DemandObject {
  const value = demandObject(input)
  return { schema_version: version(value.schema_version), id: communityId(value.id), number: text(value.number, 128),
    title: text(value.title, 200), public_summary: text(value.public_summary, 4000), public_budget: text(value.public_budget, 100, true),
    service_profile_id: value.service_profile_id === '' ? '' : profileId(value.service_profile_id),
    service_profile_name: text(value.service_profile_name, 200, true), publisher: user(value.publisher),
    status: choice(value.status, COMMUNITY_STATUSES), public_attachments: array(value.public_attachments, 8, item => attachment(item, 'listing')),
    created_at: demandInteger(value.created_at), updated_at: demandInteger(value.updated_at), can_accept: bool(value.can_accept) }
}
function order(input: unknown, accountId: string): DemandObject {
  const value = demandObject(input), publisher = user(value.publisher), acceptor = value.acceptor === null ? null : user(value.acceptor)
  const role = choice(value.my_role, ['publisher', 'acceptor', 'admin']), listing = communityListing(value.listing)
  const id = communityId(value.id), last = demandInteger(value.last_seq)
  if (listing.id !== id || demandObject(listing.publisher).id !== publisher.id || acceptor?.id === publisher.id
    || role === 'publisher' && String(publisher.id) !== accountId
    || role === 'acceptor' && (acceptor === null || String(acceptor.id) !== accountId)) throw new DemandProtocolError()
  return { schema_version: version(value.schema_version), id, number: text(value.number, 128), title: text(value.title, 200),
    status: choice(value.status, COMMUNITY_STATUSES), revision: positive(value.revision), publisher, acceptor, my_role: role, listing,
    private_text: text(value.private_text, 12_000, true), last_seq: last, last_read_seq: demandInteger(value.last_read_seq, last),
    unread_count: demandInteger(value.unread_count, last), delivery_message_id: value.delivery_message_id === '' ? '' : communityId(value.delivery_message_id),
    created_at: demandInteger(value.created_at), updated_at: demandInteger(value.updated_at), accepted_at: demandInteger(value.accepted_at),
    closed_at: demandInteger(value.closed_at), can_send: bool(value.can_send), can_deliver: bool(value.can_deliver),
    can_accept_delivery: bool(value.can_accept_delivery), can_cancel: bool(value.can_cancel), can_reopen: bool(value.can_reopen) }
}
function message(input: unknown, order: DemandObject): DemandObject {
  const value = demandObject(input), sender = demandInteger(value.sender_id), author = choice(value.author_kind, ['publisher', 'acceptor', 'admin', 'system'])
  const id = communityId(value.order_id)
  const acceptor = order.acceptor === null ? null : demandObject(order.acceptor)
  if (id !== order.id || author === 'system' && sender !== 0 || author !== 'system' && sender === 0
    || author === 'publisher' && sender !== demandObject(order.publisher).id
    || author === 'acceptor' && (acceptor === null || sender !== acceptor.id)) throw new DemandProtocolError()
  return { id: communityId(value.id), order_id: id, seq: positive(value.seq), sender_id: sender, author_kind: author,
    author_name: text(value.author_name, 200, true), kind: choice(value.kind, ['message', 'delivery', 'system']),
    text: text(value.text, 12_000, true), attachments: array(value.attachments, 8, item => attachment(item, 'conversation')),
    created_at: demandInteger(value.created_at), client_message_id: text(value.client_message_id, 80, true), read: bool(value.read) }
}
function upload(input: unknown): DemandObject {
  const value = demandObject(input), asset = value.attachment === null ? null : attachment(value.attachment)
  const attachmentId = communityId(value.attachment_id), status = choice(value.status, ['uploading', 'ready'])
  if (asset !== null && asset.id !== attachmentId || status === 'ready' && asset === null) throw new DemandProtocolError()
  return { id: communityId(value.id), attachment_id: attachmentId, offset: demandInteger(value.offset),
    chunk_bytes: positive(value.chunk_bytes), status, expires_at: demandInteger(value.expires_at), attachment: asset }
}
function page(value: DemandObject): DemandObject {
  const hasMore = bool(value.has_more), cursor = value.next_cursor === null ? null : text(value.next_cursor, 256, true)
  if (hasMore && (cursor === '' || cursor === null) || !hasMore && cursor !== '' && cursor !== null) throw new DemandProtocolError()
  return { next_cursor: cursor, has_more: hasMore }
}
function configuration(value: DemandObject): DemandObject {
  const capabilities = demandObject(value.capabilities), rules = demandObject(value.upload_rules)
  const chunk = demandInteger(rules.chunk_bytes, 67_108_864)
  if (chunk === 0) throw new DemandProtocolError()
  return { schema_version: version(value.schema_version), enabled: bool(value.enabled), capabilities: {
    community_orders_v1: bool(capabilities.community_orders_v1), explicit_publication: bool(capabilities.explicit_publication),
    single_acceptor: bool(capabilities.single_acceptor), resumable_upload: bool(capabilities.resumable_upload),
    private_participant_messages: bool(capabilities.private_participant_messages),
  }, upload_rules: { max_image_bytes: positive(rules.max_image_bytes), max_video_bytes: positive(rules.max_video_bytes),
    max_attachments: demandInteger(rules.max_attachments, 64), chunk_bytes: chunk,
    allowed_mime_types: array(rules.allowed_mime_types, 32, item => choice(item, mediaTypes)),
    upload_ttl_seconds: positive(rules.upload_ttl_seconds) } }
}

/**
 * Project a successful community envelope after transport verifies the captured login owner.
 * @param kind - Closed operation whose success body must match the frozen DTO.
 * @param input - Untrusted upstream envelope using the existing success/data convention.
 * @param account - Non-secret captured identity used to verify participant-role projections.
 * @param route - Selected resource identity, when the route addresses an existing object.
 * @returns Only declared community fields; no admin contacts, storage paths or credentials.
 */
export function communityResponse(kind: string, input: unknown, account: { readonly id: string },
  route: { readonly resourceId?: string } = {}): DemandObject {
  const envelope = demandObject(input)
  if (envelope.success !== true) throw new DemandProtocolError()
  const value = demandObject(envelope.data)
  const bound = (value: DemandObject): DemandObject => {
    if (route.resourceId !== undefined && value.id !== route.resourceId) throw new DemandProtocolError()
    return value
  }
  if (kind === 'config') return configuration(value)
  if (kind === 'listing') return { listing: bound(communityListing(value.listing)) }
  if (kind === 'order') return { order: bound(order(value.order, account.id)) }
  if (kind === 'listings' || kind === 'orders') {
    const items = array(value.items, 100, item => kind === 'listings' ? communityListing(item) : order(item, account.id))
    if (new Set(items.map(item => item.id)).size !== items.length) throw new DemandProtocolError()
    return { items, ...page(value) }
  }
  if (kind === 'create' || kind === 'message' || kind === 'action' || kind === 'accept') {
    const current = bound(order(value.order, account.id))
    return { order: current, replayed: bool(value.replayed), ...kind === 'accept' ? {}
      : { message: value.message === null ? null : message(value.message, current) } }
  }
  if (kind === 'messages') {
    const current = bound(order(value.order, account.id)), last = demandInteger(value.last_seq)
    const next = demandInteger(value.next_after_seq, last)
    const items = array(value.items, 100, item => message(item, current))
    let previous = 0
    for (const item of items) {
      const seq = demandInteger(item.seq, last)
      if (seq <= previous) throw new DemandProtocolError()
      previous = seq
    }
    if (current.last_seq !== last || new Set(items.map(item => item.id)).size !== items.length || previous > next) {
      throw new DemandProtocolError()
    }
    return { items, last_seq: last, next_after_seq: next, has_more: bool(value.has_more), order: current }
  }
  if (kind === 'read') return { last_read_seq: demandInteger(value.last_read_seq), unread_count: demandInteger(value.unread_count) }
  if (kind === 'upload-init' || kind === 'upload-status' || kind === 'upload-chunk' || kind === 'upload-complete') return bound(upload(value))
  throw new DemandProtocolError()
}
