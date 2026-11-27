/** JSON controls retained verbatim, including native nested objects and ordered arrays. */
export type MediaV2Value = null | string | number | boolean | readonly MediaV2Value[] | { readonly [key: string]: MediaV2Value }
/** Media workspace classification published by the media catalog. */
export type MediaV2Kind = 'image' | 'video' | 'audio'
/** Explicit input workflow retained independently from provider quality or mode controls. */
export type MediaV2Intent = 'text' | 'reference' | 'frames' | 'transform'
/** One named material input with its media type, native cardinality and published constraints. */
export interface MediaV2AssetField {
  readonly name: string
  readonly media_kind: 'image' | 'video' | 'audio'
  readonly native_shape: 'single' | 'multiple'
  readonly min_items: number
  readonly max_items: number
  readonly mime_types: readonly string[]
  readonly constraints: Readonly<Record<string, unknown>>
}
/** Account-visible model controls and presentation, without provider credentials or transport details. */
export interface MediaV2Model {
  readonly id: string
  readonly display_name: string
  readonly kind: MediaV2Kind
  readonly model_version: string
  readonly description?: string
  readonly parameters_schema: Readonly<Record<string, unknown>>
  /** Published native dependencies, preserved for local validation. */
  readonly conditions?: unknown
  readonly asset_fields: readonly MediaV2AssetField[]
  readonly intents: readonly { readonly id: MediaV2Intent; readonly label: string; readonly requires_assets: boolean }[]
  readonly pricing: { readonly display: string; readonly credits_per_yuan: number; readonly quote_required: true }
  readonly enabled: boolean
}
/** Immutable ready-material receipt containing the server-verified identity and actual media metadata. */
export interface MediaV2Asset {
  readonly asset_id: string
  readonly client_asset_id: string
  readonly model: string
  readonly state: 'ready'
  readonly media_kind: 'image' | 'video' | 'audio'
  readonly mime_type: string
  readonly bytes: number
  readonly sha256: string
  readonly expires_at: number
  readonly duration_seconds?: number
  readonly fps?: number
  readonly width?: number
  readonly height?: number
}
/** Frozen operation identity, explicit workflow, primitive controls and ordered material bindings. */
export interface MediaV2Request {
  readonly client_operation_id: string
  readonly model: string
  readonly model_version: string
  readonly intent: MediaV2Intent
  readonly parameters: Readonly<Record<string, MediaV2Value>>
  readonly assets: Readonly<Record<string, readonly string[]>>
}
/** One ordered task output whose original bytes are read through the fixed local artifact route. */
export interface MediaV2Artifact {
  readonly key: string
  readonly type: 'image' | 'video' | 'audio' | 'file'
  readonly mime_type: string
  readonly role?: string
  readonly order: number
  readonly filename?: string
}
/** Original task state and complete ordered outputs; an unknown state does not authorize resubmission. */
export interface MediaV2Task {
  readonly id: string
  readonly model: string
  readonly kind: MediaV2Kind
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown'
  readonly is_final: boolean
  readonly artifacts: readonly MediaV2Artifact[]
  readonly failure?: { readonly code: string; readonly message: string }
}
/** Host-enriched request quote with exact CNY, product credits and its expiry time. */
export interface MediaV2Quote {
  readonly quote_id: string
  readonly model_version?: string
  readonly client_operation_id: string
  readonly request_sha256: string
  readonly retail_cny: string
  readonly credits: number
  readonly credits_per_yuan: number
  readonly expires_at: number
}
/** Host-owned original-operation view retained through quoting, acceptance and uncertain responses. */
export interface MediaV2Record {
  readonly version: 1
  readonly owner: string
  readonly request: MediaV2Request
  readonly state: 'quoting' | 'quoted' | 'quote-rejected' | 'submitting' | 'accepted' | 'unknown'
  readonly quote?: MediaV2Quote
  readonly quote_failure?: { readonly code: string; readonly message: string }
  readonly task?: MediaV2Task
  readonly updated_at: number
}
/** Selectable model definitions, product credit scale and an optional Host-configured polling interval. */
export interface MediaV2Catalog {
  readonly capabilities: {
    readonly same_operation_configuration_requote: boolean
    readonly material_conditions_v1?: boolean
    readonly max_upload_bytes?: number
  }
  readonly models: readonly MediaV2Model[]
  readonly credits_per_yuan: number
  readonly poll_after_ms?: number
}
/**
 * Same-origin browser transport whose implementation retains credentials in the Host.
 * @param path - Fixed local media route, including its encoded query parameters.
 * @param init - Optional HTTP method, body, headers and cancellation signal.
 * @returns The untrusted JSON response for the route-specific decoder.
 */
export type MediaV2Transport = (path: string, init?: RequestInit) => Promise<unknown>

/**
 * Admit a JSON object at the browser transport boundary.
 * @param value - Untrusted decoded JSON value.
 * @returns The non-array object, or null for any other value.
 */
export function mediaV2Object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
/**
 * Admit finite JSON controls before retaining draft or original operation values.
 * @param value - Unknown JSON value from storage or a Host response.
 * @returns Whether the value can be retained without coercion or field loss.
 */
export function isMediaV2Value(value: unknown): value is MediaV2Value {
  let nodes = 0
  const read = (entry: unknown, depth: number): boolean => {
    if (++nodes > 10000 || depth > 12) return false
    if (entry === null || typeof entry === 'boolean') return true
    if (typeof entry === 'string') return entry.length <= 100000
    if (typeof entry === 'number') return Number.isFinite(entry)
    if (Array.isArray(entry)) return entry.length <= 1000 && entry.every(item => read(item, depth + 1))
    const object = mediaV2Object(entry)
    return object !== null && Object.keys(object).length <= 100
      && Object.entries(object).every(([key, item]) => /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(key) && read(item, depth + 1))
  }
  return read(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1024 * 1024
}
const text = (value: unknown): value is string => typeof value === 'string' && value !== ''
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const intent = (value: unknown): value is MediaV2Intent => value === 'text' || value === 'reference' || value === 'frames' || value === 'transform'
const mediaKind = (value: unknown): value is 'image' | 'video' | 'audio' => value === 'image' || value === 'video' || value === 'audio'
/**
 * Unwrap the public success envelope or throw its safe failure message.
 * @param value - Untrusted response envelope from the local Host route.
 * @returns The success payload without changing its route-specific shape.
 */
export function mediaV2Data(value: unknown): unknown {
  const row = mediaV2Object(value)
  if (row?.success === true && row.data !== undefined) return row.data
  const error = mediaV2Object(row?.error)
  throw new Error(typeof error?.message === 'string' ? error.message : 'MEDIA_V2_UNAVAILABLE')
}
/**
 * Decode selectable controls, the product credit scale and a bounded optional polling interval.
 * @param value - Unwrapped, untrusted catalog payload; schema annotations remain data.
 * @returns The validated catalog; malformed required metadata causes an error.
 */
export function parseMediaV2Catalog(value: unknown): MediaV2Catalog {
  const data = mediaV2Object(value)
  if (!Array.isArray(data?.models) || !finite(data.credits_per_yuan) || data.credits_per_yuan <= 0) throw new Error('MEDIA_V2_CATALOG_INVALID')
  if (data.poll_after_ms !== undefined && (!finite(data.poll_after_ms) || !Number.isInteger(data.poll_after_ms)
    || data.poll_after_ms < 1 || data.poll_after_ms > 60_000)) throw new Error('MEDIA_V2_CATALOG_INVALID')
  const capabilities = mediaV2Object(data.capabilities)
  const configurationRequote = capabilities?.same_operation_configuration_requote
  const materialConditions = capabilities?.material_conditions_v1
  const maxUploadBytes = capabilities?.max_upload_bytes
  if (maxUploadBytes !== undefined && (!finite(maxUploadBytes) || !Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1)) throw new Error('MEDIA_V2_CATALOG_INVALID')
  if (configurationRequote !== undefined && typeof configurationRequote !== 'boolean') throw new Error('MEDIA_V2_CATALOG_INVALID')
  if (materialConditions !== undefined && typeof materialConditions !== 'boolean') throw new Error('MEDIA_V2_CATALOG_INVALID')
  const models = data.models.map((value): MediaV2Model => {
    const row = mediaV2Object(value), pricing = mediaV2Object(row?.pricing), schema = mediaV2Object(row?.parameters_schema)
    if (!text(row?.id) || !text(row.display_name) || !text(row.model_version) || !mediaKind(row.kind)
      || schema === null || !Array.isArray(row.asset_fields) || !Array.isArray(row.intents) || typeof row.enabled !== 'boolean'
      || pricing === null || typeof pricing.display !== 'string' || !finite(pricing.credits_per_yuan) || pricing.credits_per_yuan <= 0 || pricing.quote_required !== true) throw new Error('MEDIA_V2_CATALOG_INVALID')
    const fields = row.asset_fields.map((value): MediaV2AssetField => {
      const field = mediaV2Object(value)
      if (!text(field?.name) || !mediaKind(field.media_kind) || field.native_shape !== 'single' && field.native_shape !== 'multiple'
        || !finite(field.min_items) || !Number.isInteger(field.min_items) || field.min_items < 0 || !finite(field.max_items)
        || !Number.isInteger(field.max_items) || field.max_items < 1 || !Array.isArray(field.mime_types) || !field.mime_types.every(text)) throw new Error('MEDIA_V2_CATALOG_INVALID')
      return { name: field.name, media_kind: field.media_kind, native_shape: field.native_shape,
        min_items: field.min_items, max_items: field.max_items,
        mime_types: field.mime_types, constraints: mediaV2Object(field.constraints) ?? {} }
    })
    const intents = row.intents.map((value) => {
      const choice = mediaV2Object(value)
      if (!intent(choice?.id) || !text(choice.label) || typeof choice.requires_assets !== 'boolean') throw new Error('MEDIA_V2_CATALOG_INVALID')
      return { id: choice.id, label: choice.label, requires_assets: choice.requires_assets }
    })
    return { id: row.id, display_name: row.display_name, model_version: row.model_version, kind: row.kind, enabled: row.enabled,
      parameters_schema: schema, asset_fields: fields, intents,
      ...row.conditions === undefined ? {} : { conditions: row.conditions },
      pricing: { display: pricing.display, credits_per_yuan: pricing.credits_per_yuan, quote_required: true },
      ...typeof row.description === 'string' ? { description: row.description } : {} }
  })
  return { models, credits_per_yuan: data.credits_per_yuan,
    capabilities: { same_operation_configuration_requote: configurationRequote === true,
      ...materialConditions === undefined ? {} : { material_conditions_v1: materialConditions },
      ...maxUploadBytes === undefined ? {} : { max_upload_bytes: maxUploadBytes } },
    ...data.poll_after_ms === undefined ? {} : { poll_after_ms: data.poll_after_ms } }
}
/**
 * Decode an immutable ready-material receipt containing server-observed media facts.
 * @param value - Unwrapped, untrusted upload or original-upload recovery payload.
 * @returns The ready receipt, or throws when its identity or required metadata is invalid.
 */
export function parseMediaV2Asset(value: unknown): MediaV2Asset {
  const row = mediaV2Object(value)
  if (!text(row?.asset_id) || !text(row.client_asset_id) || !text(row.model) || row.state !== 'ready' || !mediaKind(row.media_kind)
    || !text(row.mime_type) || !finite(row.bytes) || row.bytes <= 0 || !text(row.sha256) || !/^[a-f0-9]{64}$/u.test(row.sha256)
    || !finite(row.expires_at)) throw new Error('MEDIA_V2_ASSET_INVALID')
  for (const key of ['duration_seconds', 'width', 'height', 'fps'] as const) {
    if (row[key] !== undefined && (!finite(row[key]) || row[key] <= 0)) throw new Error('MEDIA_V2_ASSET_INVALID')
  }
  return { asset_id: row.asset_id, client_asset_id: row.client_asset_id, model: row.model, state: 'ready', media_kind: row.media_kind,
    mime_type: row.mime_type, bytes: row.bytes, sha256: row.sha256, expires_at: row.expires_at,
    ...finite(row.duration_seconds) ? { duration_seconds: row.duration_seconds } : {},
    ...finite(row.fps) ? { fps: row.fps } : {},
    ...finite(row.width) ? { width: row.width } : {}, ...finite(row.height) ? { height: row.height } : {} }
}
/**
 * Decode the original operation, its quote and every declared task artifact.
 * @param value - Unwrapped, untrusted Host operation record.
 * @returns The validated record without issuing a request or changing its operation identity.
 */
export function parseMediaV2Record(value: unknown): MediaV2Record {
  const row = mediaV2Object(value), request = mediaV2Object(row?.request)
  const parameters = mediaV2Object(request?.parameters), assets = mediaV2Object(request?.assets)
  if (row?.version !== 1 || !text(row.owner) || !['quoting', 'quoted', 'quote-rejected', 'submitting', 'accepted', 'unknown'].includes(String(row.state)) || !finite(row.updated_at)
    || !text(request?.client_operation_id) || !text(request.model) || !text(request.model_version) || !intent(request.intent) || parameters === null || assets === null) throw new Error('MEDIA_V2_RECORD_INVALID')
  const admittedParameters: Record<string, MediaV2Value> = {}, admittedAssets: Record<string, readonly string[]> = {}
  for (const [name, value] of Object.entries(parameters)) {
    if (!isMediaV2Value(value)) throw new Error('MEDIA_V2_RECORD_INVALID')
    admittedParameters[name] = value
  }
  for (const [name, value] of Object.entries(assets)) {
    if (!Array.isArray(value) || !value.every(text)) throw new Error('MEDIA_V2_RECORD_INVALID')
    admittedAssets[name] = value
  }
  const quote = mediaV2Object(row.quote)
  let admittedQuote: MediaV2Quote | undefined
  if (row.quote !== undefined) {
    if (!text(quote?.quote_id) || quote.client_operation_id !== request.client_operation_id || !text(quote.request_sha256)
      || typeof quote.retail_cny !== 'string' || !/^\d+(?:\.\d+)?$/u.test(quote.retail_cny) || !finite(quote.credits) || quote.credits < 0
      || !finite(quote.credits_per_yuan) || quote.credits_per_yuan <= 0 || !finite(quote.expires_at)
      || quote.model_version !== undefined && !text(quote.model_version)) throw new Error('MEDIA_V2_RECORD_INVALID')
    admittedQuote = { quote_id: quote.quote_id, client_operation_id: quote.client_operation_id, request_sha256: quote.request_sha256,
      retail_cny: quote.retail_cny, credits: quote.credits, credits_per_yuan: quote.credits_per_yuan, expires_at: quote.expires_at,
      ...typeof quote.model_version === 'string' ? { model_version: quote.model_version } : {} }
  }
  const quoteFailure = mediaV2Object(row.quote_failure)
  let admittedQuoteFailure: { readonly code: string; readonly message: string } | undefined
  if (row.quote_failure !== undefined) {
    if (!text(quoteFailure?.code) || !text(quoteFailure.message)) throw new Error('MEDIA_V2_RECORD_INVALID')
    admittedQuoteFailure = { code: quoteFailure.code, message: quoteFailure.message }
  }
  let admittedTask: MediaV2Task | undefined
  if (row.task !== undefined) {
    const task = mediaV2Object(row.task)
    if (!text(task?.id) || !text(task.model) || !mediaKind(task.kind) || typeof task.is_final !== 'boolean'
      || !['pending', 'running', 'succeeded', 'failed', 'unknown'].includes(String(task.status)) || !Array.isArray(task.artifacts)) throw new Error('MEDIA_V2_RECORD_INVALID')
    const artifacts = task.artifacts.map((value): MediaV2Artifact => {
      const artifact = mediaV2Object(value)
      if (!text(artifact?.key) || !['image', 'video', 'audio', 'file'].includes(String(artifact.type)) || !text(artifact.mime_type) || !finite(artifact.order)) throw new Error('MEDIA_V2_RECORD_INVALID')
      return { key: artifact.key, type: artifact.type as MediaV2Artifact['type'], mime_type: artifact.mime_type, order: artifact.order,
        ...typeof artifact.role === 'string' ? { role: artifact.role } : {}, ...typeof artifact.filename === 'string' ? { filename: artifact.filename } : {} }
    })
    const failure = mediaV2Object(task.failure)
    admittedTask = { id: task.id, model: task.model, kind: task.kind, status: task.status as MediaV2Task['status'], is_final: task.is_final, artifacts,
      ...typeof failure?.code === 'string' && typeof failure.message === 'string' ? { failure: { code: failure.code, message: failure.message } } : {} }
  }
  return { version: 1, owner: row.owner, request: {
    client_operation_id: request.client_operation_id, model: request.model, model_version: request.model_version,
    intent: request.intent, parameters: admittedParameters, assets: admittedAssets }, state: row.state as MediaV2Record['state'], updated_at: row.updated_at,
  ...admittedQuote === undefined ? {} : { quote: admittedQuote },
  ...admittedQuoteFailure === undefined ? {} : { quote_failure: admittedQuoteFailure },
  ...admittedTask === undefined ? {} : { task: admittedTask } }
}
