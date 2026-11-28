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
/** Backend-owned price hints; new metadata stays raw until its known reader accepts the complete shape. */
export interface MediaV2Pricing {
  readonly display: string
  readonly credits_per_yuan: number
  readonly quote_required: true
  readonly currency?: unknown
  readonly policy_revision?: unknown
  readonly specification_rows?: unknown
}
/** Indicative CNY amounts for one exact native scalar selection, never a generation permission. */
export interface MediaV2SpecificationPrice {
  readonly id: string
  readonly parameters: Readonly<Record<string, string | number | boolean>>
  readonly billing_unit: 'per_video' | 'per_second'
  readonly quantity: number
  readonly unit_price_cny: string
  readonly total_cny: string
  readonly quote_required: true
  readonly policy_revision: string
}
/** Known optional indicative-price metadata, independent of actual quote confirmation. */
export interface MediaV2SpecificationPricing {
  readonly currency: 'CNY'
  readonly policy_revision: string
  readonly specification_rows?: readonly MediaV2SpecificationPrice[]
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
  /** Reviewed parameter rules retained independently from material dependencies. */
  readonly parameter_conditions?: unknown
  /** Finite server-owned native selections, retained raw for per-model known-version validation. */
  readonly selection_constraints?: unknown
  /** Published quantity policy retained for this model's new-request checks. */
  readonly quantity?: unknown
  readonly asset_fields: readonly MediaV2AssetField[]
  readonly intents: readonly { readonly id: MediaV2Intent; readonly label: string; readonly requires_assets: boolean }[]
  readonly pricing: MediaV2Pricing
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
  readonly output_id?: unknown
  readonly output_index?: unknown
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
  /** Unknown future metadata remains visible to original-operation readers, never as implicit completion. */
  readonly batch?: unknown
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
  readonly batch?: unknown
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
    readonly parameter_conditions_v1?: boolean
    readonly native_video_batch_v1?: boolean
    readonly exact_specification_pricing_v1?: boolean
    readonly explicit_requote_v1?: boolean
    readonly selection_constraints_v1?: boolean
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
  const parameterConditions = capabilities?.parameter_conditions_v1
  const nativeBatch = capabilities?.native_video_batch_v1
  const exactPricing = capabilities?.exact_specification_pricing_v1
  const explicitRequote = capabilities?.explicit_requote_v1
  const selectionConstraints = capabilities?.selection_constraints_v1
  const maxUploadBytes = capabilities?.max_upload_bytes
  if (maxUploadBytes !== undefined && (!finite(maxUploadBytes) || !Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1)) throw new Error('MEDIA_V2_CATALOG_INVALID')
  if (configurationRequote !== undefined && typeof configurationRequote !== 'boolean') throw new Error('MEDIA_V2_CATALOG_INVALID')
  if (materialConditions !== undefined && typeof materialConditions !== 'boolean') throw new Error('MEDIA_V2_CATALOG_INVALID')
  if (parameterConditions !== undefined && typeof parameterConditions !== 'boolean') throw new Error('MEDIA_V2_CATALOG_INVALID')
  if (nativeBatch !== undefined && typeof nativeBatch !== 'boolean') throw new Error('MEDIA_V2_CATALOG_INVALID')
  if (exactPricing !== undefined && typeof exactPricing !== 'boolean') throw new Error('MEDIA_V2_CATALOG_INVALID')
  if (explicitRequote !== undefined && typeof explicitRequote !== 'boolean') throw new Error('MEDIA_V2_CATALOG_INVALID')
  if (selectionConstraints !== undefined && typeof selectionConstraints !== 'boolean') throw new Error('MEDIA_V2_CATALOG_INVALID')
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
      ...row.parameter_conditions === undefined ? {} : { parameter_conditions: row.parameter_conditions },
      ...row.selection_constraints === undefined ? {} : { selection_constraints: row.selection_constraints },
      ...row.quantity === undefined ? {} : { quantity: row.quantity },
      pricing: { display: pricing.display, credits_per_yuan: pricing.credits_per_yuan, quote_required: true,
        ...pricing.currency === undefined ? {} : { currency: pricing.currency },
        ...pricing.policy_revision === undefined ? {} : { policy_revision: pricing.policy_revision },
        ...pricing.specification_rows === undefined ? {} : { specification_rows: pricing.specification_rows } },
      ...typeof row.description === 'string' ? { description: row.description } : {} }
  })
  return { models, credits_per_yuan: data.credits_per_yuan,
    capabilities: { same_operation_configuration_requote: configurationRequote === true,
      ...materialConditions === undefined ? {} : { material_conditions_v1: materialConditions },
      ...parameterConditions === undefined ? {} : { parameter_conditions_v1: parameterConditions },
      ...nativeBatch === undefined ? {} : { native_video_batch_v1: nativeBatch },
      ...exactPricing === undefined ? {} : { exact_specification_pricing_v1: exactPricing },
      ...explicitRequote === undefined ? {} : { explicit_requote_v1: explicitRequote },
      ...selectionConstraints === undefined ? {} : { selection_constraints_v1: selectionConstraints },
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
      ...typeof quote.model_version === 'string' ? { model_version: quote.model_version } : {},
      ...quote.batch === undefined ? {} : { batch: quote.batch } }
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
        ...typeof artifact.role === 'string' ? { role: artifact.role } : {}, ...typeof artifact.filename === 'string' ? { filename: artifact.filename } : {},
        ...artifact.output_id === undefined ? {} : { output_id: artifact.output_id },
        ...artifact.output_index === undefined ? {} : { output_index: artifact.output_index } }
    })
    const failure = mediaV2Object(task.failure)
    admittedTask = { id: task.id, model: task.model, kind: task.kind, status: task.status as MediaV2Task['status'], is_final: task.is_final, artifacts,
      ...task.batch === undefined ? {} : { batch: task.batch },
      ...typeof failure?.code === 'string' && typeof failure.message === 'string' ? { failure: { code: failure.code, message: failure.message } } : {} }
  }
  return { version: 1, owner: row.owner, request: {
    client_operation_id: request.client_operation_id, model: request.model, model_version: request.model_version,
    intent: request.intent, parameters: admittedParameters, assets: admittedAssets }, state: row.state as MediaV2Record['state'], updated_at: row.updated_at,
  ...admittedQuote === undefined ? {} : { quote: admittedQuote },
  ...admittedQuoteFailure === undefined ? {} : { quote_failure: admittedQuoteFailure },
  ...admittedTask === undefined ? {} : { task: admittedTask } }
}

/** Explicitly published native quantity policy; it does not establish supplier qualification. */
export interface MediaV2Quantity {
  readonly maximum: number
  readonly modes: readonly string[]
}
/** Frozen batch facts and optional task counters, independent from the current catalog. */
export interface MediaV2Batch {
  readonly schema_version: 1
  readonly requested_output_count: number
  readonly expected_main_output_count: number
  readonly output_duration_seconds: number
  readonly total_output_seconds: number
  readonly meter: 'output_count' | 'total_output_seconds'
  readonly admission_unit: 'native_operation'
  readonly admission_weight: 1
  readonly partial_policy: 'retain_reservation_until_complete'
  readonly policy_revision: string
  readonly received_main_output_count?: number
  readonly completeness?: 'pending' | 'complete' | 'partial' | 'mismatch'
  readonly failure_reason?: string
}
const batchFields = ['schema_version', 'requested_output_count', 'expected_main_output_count', 'output_duration_seconds',
  'total_output_seconds', 'meter', 'admission_unit', 'admission_weight', 'partial_policy', 'policy_revision'] as const
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  finite(value) && Number.isSafeInteger(value) && value >= minimum && value <= maximum
const policyHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const indicativeDecimal = (value: unknown): value is string => typeof value === 'string' && value.length <= 64
  && /^\d+(?:\.\d+)?$/u.test(value) && Number.isFinite(Number(value))
const indicativeScalar = (value: unknown): value is string | number | boolean => typeof value === 'boolean' || finite(value)
  || typeof value === 'string' && value.length <= 4000 && !/[\u0000-\u001f\u007f]/u.test(value)
/**
 * Decode known indicative prices without treating a row or its amount as request authorization.
 * @param pricing - Original per-model metadata, including unrecognized values retained by the catalog reader.
 * @returns Undefined for legacy absence, null for malformed metadata, or known CNY amounts with optional exact rows.
 */
export function readMediaV2SpecificationPricing(pricing: MediaV2Pricing): MediaV2SpecificationPricing | null | undefined {
  if (pricing.currency === undefined && pricing.policy_revision === undefined && pricing.specification_rows === undefined) return undefined
  if (pricing.currency !== 'CNY' || !policyHash(pricing.policy_revision)) return null
  if (pricing.specification_rows === undefined) return { currency: 'CNY', policy_revision: pricing.policy_revision }
  if (!Array.isArray(pricing.specification_rows) || pricing.specification_rows.length > 128) return null
  const rows: MediaV2SpecificationPrice[] = [], ids = new Set<string>()
  for (const value of pricing.specification_rows) {
    const row = mediaV2Object(value), parameters = mediaV2Object(row?.parameters)
    if (row === null || !Object.keys(row).every(key => ['id', 'parameters', 'billing_unit', 'quantity', 'unit_price_cny',
      'total_cny', 'quote_required', 'policy_revision'].includes(key)) || !policyHash(row.id) || ids.has(row.id)
      || row.policy_revision !== pricing.policy_revision || row.quote_required !== true
      || row.billing_unit !== 'per_video' && row.billing_unit !== 'per_second'
      || !finite(row.quantity) || row.quantity <= 0 || row.billing_unit === 'per_video' && row.quantity !== 1
      || !indicativeDecimal(row.unit_price_cny) || !indicativeDecimal(row.total_cny)
      || parameters === null || Object.keys(parameters).length > 100) return null
    const selected: Record<string, string | number | boolean> = {}
    for (const [key, item] of Object.entries(parameters)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(key) || key === 'prompt' || key === 'negative_prompt' || !indicativeScalar(item)) return null
      selected[key] = item
    }
    ids.add(row.id)
    rows.push({ id: row.id, parameters: selected, billing_unit: row.billing_unit, quantity: row.quantity,
      unit_price_cny: row.unit_price_cny, total_cny: row.total_cny, quote_required: true, policy_revision: pricing.policy_revision })
  }
  return { currency: 'CNY', policy_revision: pricing.policy_revision, specification_rows: rows }
}
const batchMeter = (value: unknown): value is MediaV2Batch['meter'] => value === 'output_count' || value === 'total_output_seconds'
/**
 * Read an explicit known quantity policy without interpreting unknown data as permission for a larger count.
 * @param value - Raw per-model quantity metadata.
 * @returns The bounded quantity facts, or null for unsupported or malformed metadata.
 */
export function readMediaV2Quantity(value: unknown): MediaV2Quantity | null {
  const row = mediaV2Object(value)
  if (row === null || !Object.keys(row).every(key => ['schema_version', 'parameter', 'minimum', 'maximum', 'default', 'semantics',
    'meter', 'admission_unit', 'admission_weight', 'partial_policy', 'policy_revision', 'modes'].includes(key))
    || row.schema_version !== 1 || row.parameter !== 'count' || row.minimum !== 1 || !integer(row.maximum, 1, 50)
    || row.default !== 1 || row.semantics !== 'native_operation_main_outputs' || !batchMeter(row.meter)
    || row.admission_unit !== 'native_operation' || row.admission_weight !== 1
    || row.partial_policy !== 'retain_reservation_until_complete' || !policyHash(row.policy_revision)
    || !Array.isArray(row.modes) || row.modes.length === 0 || row.modes.length > 32 || !row.modes.every(text)
    || new Set(row.modes).size !== row.modes.length) return null
  return { maximum: row.maximum, modes: row.modes }
}
/**
 * Decode known frozen batch fields while leaving unsupported metadata available for original-operation recovery.
 * @param value - Quote or task batch metadata, independent from current model settings.
 * @param kind - Whether task counters are required in addition to the frozen quote fields.
 * @returns Known batch facts, or null; rejection never removes a retained request or artifact.
 */
export function readMediaV2Batch(value: unknown, kind: 'quote' | 'task'): MediaV2Batch | null {
  const row = mediaV2Object(value)
  const keys: readonly string[] = kind === 'quote' ? batchFields : [...batchFields, 'received_main_output_count', 'completeness', 'failure_reason']
  if (row === null || !Object.keys(row).every(key => keys.includes(key)) || row.schema_version !== 1
    || !integer(row.requested_output_count, 1, 50) || row.expected_main_output_count !== row.requested_output_count
    || !finite(row.output_duration_seconds) || row.output_duration_seconds < 0 || !finite(row.total_output_seconds)
    || row.total_output_seconds !== row.output_duration_seconds * row.requested_output_count || row.total_output_seconds > 3600
    || !batchMeter(row.meter) || row.meter === 'total_output_seconds' && row.total_output_seconds <= 0
    || row.admission_unit !== 'native_operation' || row.admission_weight !== 1
    || row.partial_policy !== 'retain_reservation_until_complete' || !policyHash(row.policy_revision)) return null
  let task: Pick<MediaV2Batch, 'received_main_output_count' | 'completeness' | 'failure_reason'> = {}
  if (kind === 'task') {
    const completeness = row.completeness
    if (!integer(row.received_main_output_count, 0, 64)
      || completeness !== 'pending' && completeness !== 'complete' && completeness !== 'partial' && completeness !== 'mismatch'
      || completeness === 'complete' && row.received_main_output_count !== row.expected_main_output_count
      || row.failure_reason !== undefined && (typeof row.failure_reason !== 'string'
        || !/^[a-z][a-z0-9_]{0,63}$/u.test(row.failure_reason))) return null
    task = { received_main_output_count: row.received_main_output_count, completeness,
      ...typeof row.failure_reason === 'string' ? { failure_reason: row.failure_reason } : {} }
  }
  return { schema_version: 1, requested_output_count: row.requested_output_count,
    expected_main_output_count: row.expected_main_output_count,
    output_duration_seconds: row.output_duration_seconds, total_output_seconds: row.total_output_seconds, meter: row.meter,
    admission_unit: 'native_operation', admission_weight: 1, partial_policy: 'retain_reservation_until_complete',
    policy_revision: row.policy_revision, ...task }
}
/**
 * Check a retained quote against its original request without multiplying the server's aggregate price.
 * @param record - Original operation and raw frozen quote metadata.
 * @param kind - Current media workspace; image quantity retains its existing schema behavior.
 * @returns Whether this quote has supported, matching batch facts or remains a compatible single-output quote.
 */
export function mediaV2QuoteBatchValid(record: MediaV2Record, kind: MediaV2Kind): boolean {
  const count = record.request.parameters.count ?? 1
  if (record.quote?.batch === undefined) return kind !== 'video' || count === 1
  const batch = readMediaV2Batch(record.quote.batch, 'quote')
  return batch !== null && batch.requested_output_count === count
}
/**
 * Verify complete batch delivery from the original frozen quote and unique main video identities.
 * @param record - Retained original operation, quote, task and every artifact.
 * @returns True only for a terminal complete result; no new task or current catalog lookup is performed.
 */
export function mediaV2TaskComplete(record: MediaV2Record): boolean {
  const task = record.task
  if (task?.status !== 'succeeded' || !task.is_final) return false
  if (task.batch === undefined && record.quote?.batch === undefined) return true
  if (task.kind !== 'video' || task.model !== record.request.model) return false
  const batch = readMediaV2Batch(task.batch, 'task'), quote = readMediaV2Batch(record.quote?.batch, 'quote')
  if (batch === null || quote === null || !batchFields.every(field => batch[field] === quote[field])
    || batch.completeness !== 'complete' || batch.failure_reason !== undefined || !mediaV2QuoteBatchValid(record, task.kind)) return false
  const expected = batch.expected_main_output_count, ids = new Set<string>(), keys = new Set<string>()
  for (const artifact of task.artifacts) {
    if (keys.has(artifact.key) || !['main', 'preview', 'auxiliary', 'duplicate', 'layer'].includes(artifact.role ?? '')) return false
    keys.add(artifact.key)
    if (artifact.output_id !== undefined || artifact.output_index !== undefined) {
      if (!integer(artifact.output_index, 0, expected - 1) || artifact.output_id !== `main-${String(artifact.output_index + 1)}`) return false
    }
    if (artifact.role !== 'main') continue
    if (artifact.type !== 'video' || typeof artifact.output_id !== 'string' || artifact.output_index === undefined || ids.has(artifact.output_id)) return false
    ids.add(artifact.output_id)
  }
  return ids.size === expected
}
