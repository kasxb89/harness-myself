/** Strict, credential-free projections for the frozen demand-v1 product contract. */

/** A demand JSON object whose fields still require the operation-specific decoder. */
export type DemandObject = Record<string, unknown>
/** Customer-visible lifecycle states declared by the frozen demand-v1 API. */
export const DEMAND_STATUSES = ['pending', 'communicating', 'in_progress', 'awaiting_acceptance', 'completed', 'cancelled', 'closed'] as const

/** Reject incomplete or invalid protocol data without retaining a private remote diagnostic. */
export class DemandProtocolError extends Error {
  constructor() { super('Invalid demand protocol data') }
}

/**
 * Require a non-null JSON object before examining its declared fields.
 * @param value - Untrusted decoded JSON value.
 * @returns The object, without implying that any of its fields are valid.
 */
export function demandObject(value: unknown): DemandObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DemandProtocolError()
  return value as DemandObject
}
/**
 * Validate bounded display text without interpreting markup or normalizing user content.
 * @param value - Untrusted text field.
 * @param maximum - Maximum accepted UTF-16 string length.
 * @param empty - Whether empty or whitespace-only text is permitted.
 * @returns The original validated string.
 */
export function demandText(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || !empty && value.trim() === '' || /[\u0000\u000b\u000c]/u.test(value)) throw new DemandProtocolError()
  return value
}
/**
 * Validate an opaque resource identifier that can safely occupy one route segment.
 * @param value - Untrusted identifier.
 * @returns A bounded identifier containing only letters, digits, underscores or hyphens.
 */
export function demandId(value: unknown): string {
  const text = demandText(value, 128)
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) throw new DemandProtocolError()
  return text
}
/**
 * Require a nonnegative safe integer within the caller's transport or protocol ceiling.
 * @param value - Untrusted numeric field.
 * @param maximum - Inclusive upper bound, defaulting to the JSON safe-integer ceiling.
 * @returns The validated integer.
 */
export function demandInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new DemandProtocolError()
  return value
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DemandProtocolError()
  return value
}
function choice(value: unknown, values: readonly string[]): string {
  if (typeof value !== 'string' || !values.includes(value)) throw new DemandProtocolError()
  return value
}
function array<T>(value: unknown, maximum: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new DemandProtocolError()
  return value.map(parse)
}
function uuid(value: unknown): string {
  const text = demandText(value, 36)
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(text)) throw new DemandProtocolError()
  return text
}
function optionalText(target: DemandObject, source: DemandObject, key: string, maximum: number): void {
  if (source[key] !== undefined) target[key] = demandText(source[key], maximum, true)
}
function unicodeText(value: unknown, maximum: number, empty = false): string {
  const text = demandText(value, maximum * 2, empty)
  if (Array.from(text).length > maximum) throw new DemandProtocolError()
  return text
}
function profileId(value: unknown): string {
  const id = demandId(value)
  if (id.length > 40) throw new DemandProtocolError()
  return id
}
function directoryCursor(value: unknown): string {
  const cursor = demandText(value, 1024, true)
  if (Buffer.byteLength(cursor, 'utf8') > 1024) throw new DemandProtocolError()
  return cursor
}
function attachments(value: unknown): string[] { return array(value ?? [], 64, demandId) }

/**
 * Project only fields declared for the selected customer operation.
 * @param kind - Matched local operation from the Host's fixed route whitelist.
 * @param input - Untrusted JSON request body, including any fields that must be discarded.
 * @returns The validated upstream body, retaining the original client idempotency identifier.
 */
export function demandRequest(kind: string, input: unknown): DemandObject {
  const value = demandObject(input)
  if (kind === 'create' || kind === 'message') {
    const result: DemandObject = { [kind === 'create' ? 'client_request_id' : 'client_message_id']:
      uuid(value[kind === 'create' ? 'client_request_id' : 'client_message_id']),
    text: demandText(value.text ?? '', 10_000, true), attachment_ids: attachments(value.attachment_ids) }
    if ((result.text as string).trim() === '' && (result.attachment_ids as string[]).length === 0) throw new DemandProtocolError()
    if (kind === 'create') {
      const service = value.service_profile_id !== undefined && value.service_profile_id !== ''
      const direct = value.engineer_id !== undefined && value.engineer_id !== ''
      if (service === direct) throw new DemandProtocolError()
      if (service) result.service_profile_id = profileId(value.service_profile_id)
      else result.engineer_id = demandId(value.engineer_id)
      for (const [key, maximum] of [['title', 200], ['budget', 100], ['client_version', 100], ['client_platform', 100]] as const) optionalText(result, value, key, maximum)
      if (value.expected_date !== undefined && value.expected_date !== '') {
        const date = demandText(value.expected_date, 10)
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(date))
          || new Date(date).toISOString().slice(0, 10) !== date) throw new DemandProtocolError()
        result.expected_date = date
      }
    }
    return result
  }
  if (kind === 'read') return { last_read_seq: demandInteger(value.last_read_seq) }
  if (kind === 'action') {
    const action = choice(value.action, ['cancel', 'accept_delivery'])
    return { client_action_id: uuid(value.client_action_id), action, revision: demandInteger(value.revision),
      ...action === 'accept_delivery' ? { delivery_id: demandId(value.delivery_id) } : {} }
  }
  if (kind === 'upload-init') {
    const mime = demandText(value.mime_type, 128), size = demandInteger(value.size_bytes)
    if (!/^(?:image|video)\/[A-Za-z0-9.+-]+$/u.test(mime) || size === 0) throw new DemandProtocolError()
    return { client_upload_id: uuid(value.client_upload_id), name: demandText(value.name, 255), mime_type: mime, size_bytes: size }
  }
  if (kind === 'upload-complete') {
    if (value.sha256 === undefined) return {}
    if (typeof value.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(value.sha256)) throw new DemandProtocolError()
    return { sha256: value.sha256 }
  }
  if (kind === 'link') return { disposition: choice(value.disposition, ['inline', 'attachment']) }
  throw new DemandProtocolError()
}

/**
 * Validate declared filters and cursors without forwarding arbitrary caller query parameters.
 * @param kind - Matched read operation from the Host route whitelist.
 * @param source - Original query parameters; duplicate or undeclared keys are rejected.
 * @returns A new validated query containing only fields accepted by that operation.
 */
export function demandQuery(kind: string, source: URLSearchParams): URLSearchParams {
  const directory = kind === 'engineers' || kind === 'service-profiles'
  const fields: Record<string, readonly string[]> = { engineers: ['category_id', 'limit', 'after_id', 'q'],
    'service-profiles': ['category_id', 'limit', 'after_id', 'q'], list: ['status', 'before_id', 'limit'], messages: ['after_seq', 'limit'] }
  const allowed = fields[kind] ?? []
  const result = new URLSearchParams()
  for (const [key, value] of source) {
    if (!allowed.includes(key) || result.has(key)) throw new DemandProtocolError()
    if (key === 'limit' || key === 'after_seq') {
      if (!/^\d{1,16}$/u.test(value)) throw new DemandProtocolError()
      const numeric = demandInteger(Number(value), key === 'limit' ? 100 : Number.MAX_SAFE_INTEGER)
      if (key === 'limit' && numeric === 0) throw new DemandProtocolError()
    } else if (directory && key === 'after_id') directoryCursor(value)
    else if (directory && key === 'q') unicodeText(value, 100, true)
    else if (directory && key === 'category_id') profileId(value)
    else if (key === 'status') choice(value, DEMAND_STATUSES)
    else demandId(value)
    result.set(key, value)
  }
  return result
}

function engineer(input: unknown): DemandObject {
  const value = demandObject(input)
  return { id: demandId(value.id), display_name: demandText(value.display_name, 200),
    category_ids: array(value.category_ids, 64, demandId), introduction: demandText(value.introduction, 10_000, true),
    presence: choice(value.presence, ['online', 'busy', 'offline']), accepting: bool(value.accepting), can_start: bool(value.can_start),
    capacity: demandInteger(value.capacity), service_hours: demandText(value.service_hours, 1000, true),
    ...value.avatar_attachment_id === undefined || value.avatar_attachment_id === '' ? {} : { avatar_attachment_id: demandId(value.avatar_attachment_id) } }
}
function serviceProfile(input: unknown): DemandObject {
  const value = demandObject(input), code = demandText(value.code, 80), sort = value.sort, revision = demandInteger(value.revision)
  if (!/^[A-Za-z0-9_-]+$/u.test(code) || typeof sort !== 'number' || !Number.isSafeInteger(sort)
    || sort < -100_000 || sort > 100_000 || revision === 0) throw new DemandProtocolError()
  return { id: profileId(value.id), code, display_name: unicodeText(value.display_name, 100),
    service_direction: unicodeText(value.service_direction, 200), introduction: unicodeText(value.introduction, 2000, true),
    category_ids: array(value.category_ids, 30, profileId),
    avatar_attachment_id: value.avatar_attachment_id === '' ? '' : profileId(value.avatar_attachment_id),
    published: bool(value.published), enabled: bool(value.enabled), sort, revision,
    intake_mode: choice(value.intake_mode, ['platform']), can_start: bool(value.can_start) }
}
function directoryPage(value: DemandObject): DemandObject {
  const more = bool(value.has_more), cursor = directoryCursor(value.next_after_id), total = demandInteger(value.total)
  if (more && cursor === '' || !more && cursor !== '' || !Array.isArray(value.items)
    || total < value.items.length || more && value.items.length === 0) throw new DemandProtocolError()
  return { next_after_id: cursor, has_more: more, total }
}
function attachment(input: unknown): DemandObject {
  const value = demandObject(input)
  return { id: demandId(value.id), name: demandText(value.name, 255), kind: choice(value.kind, ['image', 'video']),
    mime_type: demandText(value.mime_type, 128), size_bytes: demandInteger(value.size_bytes),
    status: choice(value.status, ['uploading', 'ready', 'failed']), uploaded_bytes: demandInteger(value.uploaded_bytes),
    ...value.sha256 === undefined || value.sha256 === '' ? {} : { sha256: demandText(value.sha256, 64) },
    ...value.demand_id === undefined || value.demand_id === null || value.demand_id === '' ? {} : { demand_id: demandId(value.demand_id) } }
}
function demand(input: unknown): DemandObject {
  const value = demandObject(input)
  const result: DemandObject = { id: demandId(value.id), number: demandText(value.number, 128), engineer_id: demandId(value.engineer_id),
    user_id: demandInteger(value.user_id),
    status: choice(value.status, DEMAND_STATUSES), priority: choice(value.priority, ['normal', 'high', 'urgent']),
    revision: demandInteger(value.revision), last_seq: demandInteger(value.last_seq), last_read_seq: demandInteger(value.last_read_seq),
    unread_count: demandInteger(value.unread_count), preview: demandText(value.preview, 10_000, true),
    created_at: demandInteger(value.created_at), updated_at: demandInteger(value.updated_at), engineer: engineer(value.engineer) }
  for (const key of ['title', 'budget', 'expected_date'] as const) optionalText(result, value, key, key === 'title' ? 200 : 100)
  if (value.service_profile_id !== undefined) result.service_profile_id = value.service_profile_id === '' ? '' : profileId(value.service_profile_id)
  if (value.service_profile_name !== undefined) result.service_profile_name = unicodeText(value.service_profile_name, 100, true)
  if (value.intake_mode !== undefined) result.intake_mode = choice(value.intake_mode, ['platform', 'direct'])
  if (value.assigned !== undefined) result.assigned = bool(value.assigned)
  if (result.assigned === false && (result.intake_mode !== 'platform' || !result.service_profile_id
    || result.engineer_id !== 'platform-intake' || demandObject(result.engineer).id !== 'platform-intake')) throw new DemandProtocolError()
  if (value.delivery_id !== undefined && value.delivery_id !== '') result.delivery_id = demandId(value.delivery_id)
  return result
}
function message(input: unknown): DemandObject {
  const value = demandObject(input)
  return { id: demandId(value.id), demand_id: demandId(value.demand_id), seq: demandInteger(value.seq),
    author: choice(value.author, ['user', 'engineer', 'system']),
    ...value.author_name === undefined ? {} : { author_name: demandText(value.author_name, 200, true) },
    text: demandText(value.text, 10_000, true),
    sender_id: demandInteger(value.sender_id), kind: choice(value.kind, ['message', 'delivery', 'system']), attachments: array(value.attachments, 64, attachment),
    created_at: demandInteger(value.created_at), client_message_id: demandText(value.client_message_id, 128, true), read: bool(value.read) }
}

/**
 * Retain typed customer-visible fields and exclude private notes, credentials and permanent media URLs.
 * @param kind - Matched operation whose successful response shape is expected.
 * @param input - Complete untrusted upstream success envelope.
 * @returns The validated public data projection, without the upstream authentication envelope.
 */
export function demandResponse(kind: string, input: unknown): DemandObject {
  const envelope = demandObject(input)
  if (envelope.success !== true) throw new DemandProtocolError()
  const value = demandObject(envelope.data)
  if (kind === 'config') {
    const config = demandObject(value.config), rules = demandObject(config.upload_rules), capabilities = demandObject(value.capabilities)
    return { config: { enabled: bool(config.enabled), categories: array(config.categories, 64, (input) => {
      const item = demandObject(input)
      return { id: demandId(item.id), name: demandText(item.name, 200), enabled: bool(item.enabled) }
    }), upload_rules: { max_image_bytes: demandInteger(rules.max_image_bytes), max_video_bytes: demandInteger(rules.max_video_bytes),
      max_attachments: demandInteger(rules.max_attachments, 64), chunk_bytes: demandInteger(rules.chunk_bytes, 67_108_864),
      allowed_mime_types: array(rules.allowed_mime_types, 32, value => demandText(value, 128)),
      upload_ttl_seconds: demandInteger(rules.upload_ttl_seconds) } }, server_time: demandInteger(value.server_time),
    capabilities: { resumable_upload: bool(capabilities.resumable_upload), polling: bool(capabilities.polling),
      ...capabilities.service_profiles === undefined ? {} : { service_profiles: bool(capabilities.service_profiles) },
      ...capabilities.engineer_pagination === undefined ? {} : { engineer_pagination: bool(capabilities.engineer_pagination) } } }
  }
  if (kind === 'service-profiles') return { items: array(value.items, 100, serviceProfile), ...directoryPage(value), server_time: demandInteger(value.server_time) }
  if (kind === 'engineers') return { items: array(value.items, 200, engineer), server_time: demandInteger(value.server_time),
    ...value.has_more === undefined && value.next_after_id === undefined && value.total === undefined ? {} : directoryPage(value) }
  if (kind === 'list') return { items: array(value.items, 100, demand), has_more: bool(value.has_more), next_before_id: value.next_before_id === '' || value.next_before_id === null ? value.next_before_id : demandId(value.next_before_id) }
  if (kind === 'detail' || kind === 'action') return { demand: demand(value.demand), ...kind === 'action' ? { replayed: bool(value.replayed) } : {} }
  if (kind === 'messages') return { items: array(value.items, 100, message), next_after_seq: demandInteger(value.next_after_seq),
    last_seq: demandInteger(value.last_seq), has_more: bool(value.has_more), demand: demand(value.demand) }
  if (kind === 'create' || kind === 'message') return { demand: demand(value.demand), message: message(value.message), replayed: bool(value.replayed) }
  if (kind === 'read') return { last_read_seq: demandInteger(value.last_read_seq), unread_count: demandInteger(value.unread_count) }
  if (kind === 'unread') return { unread_count: demandInteger(value.unread_count), unread_demands: demandInteger(value.unread_demands), server_time: demandInteger(value.server_time) }
  if (kind === 'upload-init' || kind === 'upload-status') return { attachment: attachment(value.attachment), offset: demandInteger(value.offset),
    chunk_bytes: demandInteger(value.chunk_bytes, 67_108_864), expires_at: demandInteger(value.expires_at) }
  if (kind === 'upload-chunk') return { offset: demandInteger(value.offset), attachment: attachment(value.attachment) }
  if (kind === 'upload-complete') return { attachment: attachment(value.attachment) }
  throw new DemandProtocolError()
}
