/** Frozen media-generation-v2 wire decoder; never contains a relay credential. @module */
export type MediaV2Kind = 'image' | 'video' | 'audio'
/** Input intent, independent from a provider quality or mode value. */
export type MediaV2Intent = 'text' | 'reference' | 'frames' | 'transform'
/** Bounded JSON parameter data; nested controls retain their exact values through quote and recovery. */
export type MediaV2Value = string | number | boolean | null | readonly MediaV2Value[] | { readonly [key: string]: MediaV2Value }
/** One named native material role with its declared shape and constraints. */
export interface MediaV2AssetField {
  name: string
  media_kind: 'image' | 'video' | 'audio'
  native_shape: 'single' | 'multiple'
  min_items: number
  max_items: number
  mime_types: readonly string[]
  constraints: Record<string, unknown>
}
/** An executable public model and its credential-free typed controls. */
export interface MediaV2Model {
  id: string
  display_name: string
  kind: MediaV2Kind
  model_version: string
  description?: string
  parameters_schema: Record<string, unknown>
  conditions?: MediaV2Value
  asset_fields: readonly MediaV2AssetField[]
  intents: readonly { id: MediaV2Intent; label: string; requires_assets: boolean; description?: string }[]
  pricing: { display: string; credits_per_yuan: number; quote_required: true }
  enabled: boolean
}
/** Executable models with the existing Host product-credit projection. */
export interface MediaV2Catalog {
  capabilities: {
    media_generation_v2: true
    quote_required: true
    durable_operation_receipt: true
    all_artifacts: true
    same_operation_configuration_requote?: boolean
    max_upload_bytes?: number
  }
  models: readonly MediaV2Model[]
  credits_per_yuan: number
  poll_after_ms?: number
}
/** Immutable server-probed original bytes; IDs do not substitute for metadata. */
export interface MediaV2Asset {
  asset_id: string
  client_asset_id: string
  model: string
  state: 'ready'
  media_kind: 'image' | 'video' | 'audio'
  mime_type: string
  bytes: number
  sha256: string
  expires_at: number
  width?: number
  height?: number
  duration_seconds?: number
  fps?: number
}
/** The complete original operation body, including ordered material bindings. */
export interface MediaV2Request {
  client_operation_id: string
  model: string
  model_version: string
  intent: MediaV2Intent
  parameters: Readonly<Record<string, MediaV2Value>>
  assets: Readonly<Record<string, readonly string[]>>
}
/** One original output identity; clients use only the fixed authorized content route. */
export interface MediaV2Artifact {
  key: string
  type: 'image' | 'video' | 'audio' | 'file'
  mime_type: string
  role?: 'main' | 'preview' | 'layer' | 'auxiliary'
  order: number
  content_url: string
  bytes?: number
  sha256?: string
  filename?: string
}
/** Original task state and every declared artifact, without inferring billable duration. */
export interface MediaV2Task {
  id: string
  model: string
  kind: MediaV2Kind
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown'
  is_final: boolean
  progress?: number
  failure?: { code: string; message: string }
  artifacts: readonly MediaV2Artifact[]
  created_at: number
  updated_at: number
}
/** One original request quotation, with server CNY and Host product points. */
export interface MediaV2Quote extends MediaV2Request {
  quote_id: string
  request_sha256: string
  retail_cny: string
  credits: number
  credits_per_yuan: number
  expires_at: number
  operation_state: 'quoted' | 'accepted'
  task?: MediaV2Task
}
/** Durable original-operation lookup; unknown or absent does not authorize a retry. */
export interface MediaV2Operation {
  client_operation_id: string
  state: 'quoted' | 'accepted'
  quote_id: string
  task?: MediaV2Task
  quote?: MediaV2Quote
}
/** Invalid media DTO data; original operation records must remain recoverable. */
export class MediaV2ProtocolError extends Error {
  constructor() { super('媒体参数或任务回执格式无效，原记录已保留。'); this.name = 'MediaV2ProtocolError' }
}
function invalid(): never { throw new MediaV2ProtocolError() }
/**
 * Admit a non-array JSON object at a transport or private-record boundary.
 * @param value - Untrusted JSON or private-record value.
 * @returns The fully decoded value; malformed data throws without changing original records.
 */
export function mediaV2Object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
}
function text(value: unknown, limit = 256, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !controls.test(value) ? value : invalid()
}
function number(value: unknown, minimum = 0, integer = false): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && (!integer || Number.isSafeInteger(value)) ? value : invalid()
}
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid() }
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  return values.find(candidate => candidate === value) ?? invalid()
}
function array<T>(value: unknown, read: (item: unknown) => T, maximum = 512): T[] {
  return Array.isArray(value) && value.length <= maximum ? value.map(read) : invalid()
}
/**
 * Admit a protocol identifier without accepting a path, URL or access grant.
 * @param value - Untrusted JSON or private-record value.
 * @returns The fully decoded value; malformed data throws without changing original records.
 */
export function mediaV2Id(value: unknown): string {
  const result = text(value, 256)
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(result) ? result : invalid()
}
/**
 * Validate an original operation or upload UUID without replacing its identity.
 * @param value - Untrusted JSON or private-record value.
 * @returns The fully decoded value; malformed data throws without changing original records.
 */
export function mediaV2UUID(value: unknown): string {
  const result = text(value, 36)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(result) ? result : invalid()
}
function sha(value: unknown): string { const result = text(value, 64); return /^[a-f0-9]{64}$/u.test(result) ? result : invalid() }
function intent(value: unknown): MediaV2Intent { return oneOf(value, ['text', 'reference', 'frames', 'transform']) }
function fieldName(value: string): string { return /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(value) ? value : invalid() }
function params(value: unknown): Record<string, MediaV2Value> {
  const entries = Object.entries(mediaV2Object(value))
  if (entries.length > 100) invalid()
  let nodes = 0
  const read = (entry: unknown, depth = 0): MediaV2Value => {
    if (++nodes > 10_000 || depth > 12) return invalid()
    if (entry === null) return null
    if (typeof entry === 'string' && entry.length <= 100_000) return entry
    if (typeof entry === 'number' && Number.isFinite(entry) || typeof entry === 'boolean') return entry
    if (Array.isArray(entry)) return array(entry, item => read(item, depth + 1), 1000)
    if (typeof entry === 'object' && Object.getPrototypeOf(entry) === Object.prototype) {
      const fields = Object.entries(entry)
      if (fields.length > 100) return invalid()
      return Object.fromEntries(fields.map(([name, item]) => [fieldName(name), read(item, depth + 1)]))
    }
    return invalid()
  }
  const result = Object.fromEntries(entries.map(([key, entry]) => [fieldName(key), read(entry)]))
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) invalid()
  return result
}
function assets(value: unknown): Record<string, readonly string[]> {
  const entries = Object.entries(mediaV2Object(value))
  if (entries.length > 100) invalid()
  return Object.fromEntries(entries.map(([key, entry]) => [fieldName(key), array(entry, mediaV2Id, 100)]))
}
/**
 * Decode one complete request without dropping references or changing intent.
 * @param value - Untrusted JSON or private-record value.
 * @returns The fully decoded value; malformed data throws without changing original records.
 */
export function parseMediaV2Request(value: unknown): MediaV2Request {
  const row = mediaV2Object(value)
  const result = { client_operation_id: mediaV2UUID(row.client_operation_id), model: mediaV2Id(row.model),
    model_version: text(row.model_version), intent: intent(row.intent), parameters: params(row.parameters), assets: assets(row.assets) }
  const count = Object.values(result.assets).reduce((sum, values) => sum + values.length, 0)
  if (result.intent === 'text' ? count !== 0 : count === 0) invalid()
  return result
}
/**
 * Decode an immutable server-probed original asset receipt.
 * @param value - Untrusted JSON or private-record value.
 * @returns The fully decoded value; malformed data throws without changing original records.
 */
export function parseMediaV2Asset(value: unknown): MediaV2Asset {
  const row = mediaV2Object(value)
  const result: MediaV2Asset = { asset_id: mediaV2Id(row.asset_id), client_asset_id: mediaV2UUID(row.client_asset_id),
    model: mediaV2Id(row.model), state: oneOf(row.state, ['ready']), media_kind: oneOf(row.media_kind, ['image', 'video', 'audio']),
    mime_type: text(row.mime_type), bytes: number(row.bytes, 1, true), sha256: sha(row.sha256), expires_at: number(row.expires_at, 1) }
  for (const key of ['width', 'height', 'duration_seconds', 'fps'] as const) {
    if (row[key] !== undefined) result[key] = number(row[key], Number.MIN_VALUE, key === 'width' || key === 'height')
  }
  return result
}
/**
 * Decode original task status and the complete ordered artifact set.
 * @param value - Untrusted JSON or private-record value.
 * @returns The fully decoded value; malformed data throws without changing original records.
 */
export function parseMediaV2Task(value: unknown): MediaV2Task {
  const row = mediaV2Object(value)
  const result: MediaV2Task = { id: mediaV2Id(row.id), model: mediaV2Id(row.model), kind: oneOf(row.kind, ['image', 'video', 'audio']),
    status: oneOf(row.status, ['pending', 'running', 'succeeded', 'failed', 'unknown']), is_final: bool(row.is_final),
    artifacts: array(row.artifacts, (item) => {
      const art = mediaV2Object(item)
      return { key: mediaV2Id(art.key), type: oneOf(art.type, ['image', 'video', 'audio', 'file']), mime_type: text(art.mime_type),
        order: number(art.order, 0, true), content_url: text(art.content_url, 16384),
        ...art.role === undefined ? {} : { role: oneOf(art.role, ['main', 'preview', 'layer', 'auxiliary']) },
        ...art.bytes === undefined ? {} : { bytes: number(art.bytes, 1, true) },
        ...art.sha256 === undefined ? {} : { sha256: sha(art.sha256) },
        ...art.filename === undefined ? {} : { filename: text(art.filename) } }
    }, 256), created_at: number(row.created_at, 1), updated_at: number(row.updated_at, 1),
    ...row.progress === undefined ? {} : { progress: number(row.progress) } }
  if (result.progress !== undefined && result.progress > 100 || result.status === 'unknown' && result.is_final
    || result.is_final !== ['succeeded', 'failed'].includes(result.status)
    || new Set(result.artifacts.map(item => item.key)).size !== result.artifacts.length) invalid()
  if (row.failure !== undefined) {
    const failure = mediaV2Object(row.failure)
    result.failure = { code: text(failure.code), message: text(failure.message, 2000, true) }
  }
  return result
}
/**
 * Decode an exact server quotation with the existing Host point projection.
 * @param value - Untrusted JSON or private-record value.
 * @returns The fully decoded value; malformed data throws without changing original records.
 */
export function parseMediaV2Quote(value: unknown): MediaV2Quote {
  const row = mediaV2Object(value), request = parseMediaV2Request(row)
  const cny = text(row.retail_cny, 64)
  if (!/^\d+(?:\.\d+)?$/u.test(cny) || !Number.isFinite(Number(cny))) invalid()
  const result: MediaV2Quote = { ...request, quote_id: mediaV2Id(row.quote_id), request_sha256: sha(row.request_sha256),
    retail_cny: cny, credits: number(row.credits), credits_per_yuan: number(row.credits_per_yuan, Number.MIN_VALUE),
    expires_at: number(row.expires_at, 1), operation_state: oneOf(row.operation_state, ['quoted', 'accepted']),
    ...row.task === undefined ? {} : { task: parseMediaV2Task(row.task) } }
  if (result.operation_state === 'accepted' && result.task === undefined) invalid()
  return result
}
/**
 * Decode only an explicitly advertised executable V2 catalog.
 * @param value - Untrusted JSON or private-record value.
 * @returns The fully decoded value; malformed data throws without changing original records.
 */
export function parseMediaV2Catalog(value: unknown): MediaV2Catalog {
  const row = mediaV2Object(value), caps = mediaV2Object(row.capabilities)
  for (const key of ['media_generation_v2', 'quote_required', 'durable_operation_receipt', 'all_artifacts']) if (caps[key] !== true) invalid()
  const models = array(row.models, (item): MediaV2Model => {
    const model = mediaV2Object(item), pricing = mediaV2Object(model.pricing)
    const result: MediaV2Model = { id: mediaV2Id(model.id), display_name: text(model.display_name, 500), kind: oneOf(model.kind, ['image', 'video', 'audio']),
      model_version: text(model.model_version), parameters_schema: mediaV2Object(model.parameters_schema), enabled: bool(model.enabled),
      asset_fields: array(model.asset_fields, (raw) => {
        const field = mediaV2Object(raw)
        const parsed: MediaV2AssetField = { name: fieldName(text(field.name, 96)), media_kind: oneOf(field.media_kind, ['image', 'video', 'audio']),
          native_shape: oneOf(field.native_shape, ['single', 'multiple']), min_items: number(field.min_items, 0, true), max_items: number(field.max_items, 1, true),
          mime_types: array(field.mime_types, item => text(item), 30), constraints: mediaV2Object(field.constraints) }
        if (parsed.min_items > parsed.max_items || parsed.native_shape === 'single' && parsed.max_items !== 1) invalid()
        return parsed
      }, 30),
      intents: array(model.intents, (raw) => { const item = mediaV2Object(raw); return { id: intent(item.id), label: text(item.label),
        requires_assets: bool(item.requires_assets),
        ...item.description === undefined ? {} : { description: text(item.description, 2000, true) } } }, 4),
      pricing: { display: text(pricing.display, 1000),
        credits_per_yuan: number(pricing.credits_per_yuan, Number.MIN_VALUE), quote_required: true },
      ...model.description === undefined ? {} : { description: text(model.description, 4000, true) },
      ...model.conditions === undefined ? {} : { conditions: params({ conditions: model.conditions }).conditions } }
    if (pricing.quote_required !== true || new Set(result.asset_fields.map(field => field.name)).size !== result.asset_fields.length
      || new Set(result.intents.map(item => item.id)).size !== result.intents.length || result.intents.length === 0) invalid()
    return result
  })
  if (new Set(models.map(model => model.id)).size !== models.length) invalid()
  return { capabilities: {
    media_generation_v2: true, quote_required: true, durable_operation_receipt: true, all_artifacts: true,
    ...caps.same_operation_configuration_requote === undefined ? {}
      : { same_operation_configuration_requote: bool(caps.same_operation_configuration_requote) },
    ...caps.max_upload_bytes === undefined ? {} : { max_upload_bytes: number(caps.max_upload_bytes, 1, true) },
  }, models, credits_per_yuan: number(row.credits_per_yuan, Number.MIN_VALUE),
  ...row.poll_after_ms === undefined ? {} : { poll_after_ms: number(row.poll_after_ms, 1, true) } }
}
/**
 * Decode original-operation recovery without authorizing another submission.
 * @param value - Untrusted JSON or private-record value.
 * @returns The fully decoded value; malformed data throws without changing original records.
 */
export function parseMediaV2Operation(value: unknown): MediaV2Operation {
  const row = mediaV2Object(value), state = oneOf(row.state, ['quoted', 'accepted'])
  const result = { client_operation_id: mediaV2UUID(row.client_operation_id), state, quote_id: mediaV2Id(row.quote_id),
    ...row.task === undefined ? {} : { task: parseMediaV2Task(row.task) },
    ...row.quote === undefined ? {} : { quote: parseMediaV2Quote(row.quote) } }
  if (state === 'accepted' && result.task === undefined) invalid()
  if (state === 'quoted' && result.quote === undefined) invalid()
  return result
}
