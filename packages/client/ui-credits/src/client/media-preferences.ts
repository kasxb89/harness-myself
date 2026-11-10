/** Account-owned chat media settings read from the Host, without credentials or reference files. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'
import { publicPointsDecimal } from './price-comparisons.ts'

/** The two independently saved media selections. */
export type PreferenceKind = 'image' | 'video'
/** A supported static generation parameter. */
export type PreferenceScalar = string | number | boolean
/** A personal model choice; absence of parameters follows that model's ordinary specification resolution. */
export interface MediaSelection { readonly model: string; readonly parameters: Readonly<Record<string, PreferenceScalar>> }
/** Verified metadata and selections returned by the private Host store. */
export interface MediaPreferences {
  readonly schema_version: 1
  readonly scope: string
  readonly revision: string
  readonly image: MediaSelection | null
  readonly video: MediaSelection | null
}
/** A complete declared combination, never a product of independent menus. */
export interface PreferenceSpecification {
  readonly size?: string
  readonly resolution?: string
  readonly seconds?: number
  readonly ratio?: string
  readonly quality?: string
  readonly mode?: string
}
/** Public parameter declarations; fields with no declaration are not offered. */
export interface PreferenceParams {
  readonly specifications?: readonly PreferenceSpecification[]
  readonly sizes?: readonly string[]
  readonly resolutions?: readonly string[]
  readonly qualities?: readonly string[]
  readonly backgrounds?: readonly string[]
  readonly formats?: readonly string[]
  readonly moderations?: readonly string[]
  readonly ratios?: readonly string[]
  readonly modes?: readonly string[]
  readonly durations?: readonly number[]
  readonly durationByResolution?: Readonly<Record<string, readonly number[]>>
  readonly maxCount?: number
  readonly seed?: boolean
  readonly audioToggle?: boolean
  readonly watermark?: boolean
}
/** A model already intersected by Host with this login's authorized directory. */
export interface PreferenceModel {
  readonly id: string
  readonly kind: PreferenceKind
  readonly displayName: string
  readonly params: PreferenceParams
  readonly verified: boolean
  readonly source: string
  readonly notes: readonly string[]
  readonly pricing?: PreferencePricing
}
/** Public, legal specification unit prices after the current Host's point conversion. */
export interface PreferencePricingRow {
  readonly parameters: Readonly<Record<string, PreferenceScalar>>
  readonly points: string
  /** Per-row evidence for an exact zero retail price; it does not authorize generation. */
  readonly is_free?: true
  readonly input: 'text' | 'reference' | 'unspecified'
}
/** Optional prices do not alter model authorization, saved preferences or request admission. */
export interface PreferencePricing {
  readonly schema_version: 1
  readonly status: 'available' | 'unavailable'
  readonly basis: 'default'
  readonly source: 'public-retail'
  readonly unit: 'points/image' | 'points/second'
  readonly credits_per_yuan?: string
  readonly coverage: 'complete' | 'partial' | 'none'
  readonly rows: readonly PreferencePricingRow[]
}
/** Public platform default availability, independent of a personal choice. */
export interface PreferenceDefault { readonly model: string | null; readonly configured: boolean; readonly available: boolean }
/** Current authorized models and platform defaults. */
export interface PreferenceCatalog {
  readonly image: readonly PreferenceModel[]
  readonly video: readonly PreferenceModel[]
  readonly defaults: Readonly<Record<PreferenceKind, PreferenceDefault>>
}
/** Owner-confirmed reply used by both read and save. */
export interface PreferenceReply {
  readonly accountId: string
  readonly accountOwner: string
  readonly preferences: MediaPreferences
  readonly catalog?: PreferenceCatalog
}
/** Safe operation failure identifiers rendered by locale-owned guidance. */
export type PreferenceFailure = 'account' | 'conflict' | 'model' | 'parameters' | 'network' | 'timeout' | 'unavailable'
/** One decoded Host operation. */
export type PreferenceResult = { readonly ok: true; readonly reply: PreferenceReply }
  | { readonly ok: false; readonly failure: PreferenceFailure }

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = (value: unknown): value is PreferenceScalar => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
function selection(value: unknown): value is MediaSelection | null {
  return value === null || record(value) && typeof value.model === 'string' && value.model.length > 0 && record(value.parameters)
    && Object.values(value.parameters).every(scalar)
}
function preferences(value: unknown): value is MediaPreferences {
  return record(value) && value.schema_version === 1 && hash(value.scope) && hash(value.revision)
    && selection(value.image) && selection(value.video)
}
function model(value: unknown, kind: PreferenceKind): value is PreferenceModel {
  if (!record(value) || value.kind !== kind || typeof value.id !== 'string' || value.id === '' || typeof value.displayName !== 'string'
    || typeof value.verified !== 'boolean' || typeof value.source !== 'string' || !Array.isArray(value.notes) || !value.notes.every(item => typeof item === 'string') || !record(value.params)) return false
  const params = value.params
  for (const key of ['sizes', 'resolutions', 'qualities', 'backgrounds', 'formats', 'moderations', 'ratios', 'modes']) {
    if (params[key] !== undefined && (!Array.isArray(params[key]) || !params[key].every(item => typeof item === 'string'))) return false
  }
  if (params.durations !== undefined && (!Array.isArray(params.durations) || !params.durations.every(item => typeof item === 'number' && Number.isFinite(item) && item > 0))) return false
  if (params.specifications !== undefined && (!Array.isArray(params.specifications) || !params.specifications.every(item => record(item)
    && Object.entries(item).every(([key, field]) => ['size', 'resolution', 'ratio', 'quality', 'mode'].includes(key) ? typeof field === 'string' : key === 'seconds' && typeof field === 'number' && Number.isFinite(field) && field > 0)))) return false
  if (params.durationByResolution !== undefined && (!record(params.durationByResolution) || !Object.values(params.durationByResolution).every(items => Array.isArray(items) && items.every(item => typeof item === 'number' && Number.isFinite(item) && item > 0)))) return false
  if (params.maxCount !== undefined && (typeof params.maxCount !== 'number' || !Number.isSafeInteger(params.maxCount) || params.maxCount < 1)) return false
  return ['seed', 'audioToggle', 'watermark'].every(key => params[key] === undefined || typeof params[key] === 'boolean')
}
function defaults(value: unknown): value is PreferenceDefault {
  return record(value) && (value.model === null || typeof value.model === 'string') && typeof value.configured === 'boolean' && typeof value.available === 'boolean'
}

function pricing(value: unknown, kind: PreferenceKind): PreferencePricing | undefined {
  const unit = kind === 'image' ? 'points/image' : 'points/second'
  if (!record(value) || value.schema_version !== 1 || value.basis !== 'default' || value.source !== 'public-retail'
    || value.unit !== unit
    || value.status !== 'available' && value.status !== 'unavailable'
    || value.coverage !== 'complete' && value.coverage !== 'partial' && value.coverage !== 'none'
    || !Array.isArray(value.rows) || value.rows.length > 512
    || value.credits_per_yuan !== undefined
      && (!publicPointsDecimal(value.credits_per_yuan) || !/[1-9]/u.test(value.credits_per_yuan))) return undefined
  const rows: PreferencePricingRow[] = []
  for (const row of value.rows) {
    if (!record(row) || !record(row.parameters) || Object.keys(row.parameters).length > 32
      || !Object.values(row.parameters).every(scalar) || !publicPointsDecimal(row.points)
      || row.is_free !== undefined && typeof row.is_free !== 'boolean'
      || row.input !== 'text' && row.input !== 'reference' && row.input !== 'unspecified') return undefined
    const free = row.is_free === true
    if (free ? /[1-9]/u.test(row.points) : !/[1-9]/u.test(row.points)) return undefined
    rows.push({ parameters: row.parameters as Record<string, PreferenceScalar>, points: row.points, input: row.input,
      ...free ? { is_free: true as const } : {} })
  }
  if (value.status === 'available' && (rows.length === 0 || value.coverage === 'none' || value.credits_per_yuan === undefined)
    || value.status === 'unavailable' && (rows.length !== 0 || value.coverage !== 'none')) return undefined
  return { schema_version: 1, status: value.status, basis: 'default', source: 'public-retail', unit,
    ...typeof value.credits_per_yuan === 'string' ? { credits_per_yuan: value.credits_per_yuan } : {},
    coverage: value.coverage, rows }
}

function publicModel(value: PreferenceModel): PreferenceModel {
  const price = pricing(value.pricing, value.kind)
  return { id: value.id, kind: value.kind, displayName: value.displayName, params: value.params,
    verified: value.verified, source: value.source, notes: value.notes, ...price === undefined ? {} : { pricing: price } }
}

/**
 * Decode untrusted HTTP data and reject mismatched or incomplete account settings.
 * @param value - JSON response.
 * @param catalog - Whether the authorized catalog is required.
 * @returns Verified fields or a safe failure.
 */
export function decodePreferenceReply(value: unknown, catalog = false): PreferenceResult {
  if (!record(value) || value.ok !== true) {
    const code = record(value) ? value.code : undefined
    return { ok: false, failure: code === 'ACCOUNT_CHANGED' || code === 'UNAUTHORIZED' ? 'account'
      : code === 'MEDIA_PREFERENCES_CONFLICT' ? 'conflict' : code === 'MEDIA_MODEL_UNAVAILABLE' ? 'model'
        : code === 'MEDIA_PARAMETERS_INVALID' ? 'parameters' : 'unavailable' }
  }
  if (!record(value.account) || typeof value.account.id !== 'string' || value.account.id === '' || !hash(value.accountOwner) || !preferences(value.payload)) return { ok: false, failure: 'unavailable' }
  const payload = value.payload
  let directory: PreferenceCatalog | undefined
  if (catalog) {
    if (!record(payload) || !record(payload.catalog) || !Array.isArray(payload.catalog.image) || !payload.catalog.image.every(item => model(item, 'image'))
      || !Array.isArray(payload.catalog.video) || !payload.catalog.video.every(item => model(item, 'video'))
      || !record(payload.defaults) || !defaults(payload.defaults.image) || !defaults(payload.defaults.video)) return { ok: false, failure: 'unavailable' }
    directory = { image: payload.catalog.image.map(publicModel), video: payload.catalog.video.map(publicModel),
      defaults: { image: payload.defaults.image, video: payload.defaults.video } }
  }
  return { ok: true, reply: { accountId: value.account.id, accountOwner: value.accountOwner, preferences: payload,
    ...directory === undefined ? {} : { catalog: directory } } }
}

/**
 * Read or save private preferences through the Host.
 * @param operation - Read settings, read catalog, or save all selections.
 * @param signal - Owner cancellation and deadline.
 * @param body - CAS fields for a save.
 * @returns A safe decoded outcome; cancellation never establishes new state.
 */
export async function requestPreferences(operation: 'read' | 'catalog' | 'save', signal: AbortSignal, body?: Record<string, unknown>): Promise<PreferenceResult> {
  try {
    const response = await fetch(appPath(`/credits/api/media/preferences${operation === 'catalog' ? '/catalog' : ''}`), {
      method: operation === 'save' ? 'PUT' : 'GET', headers: { accept: 'application/json', ...operation === 'save' ? { 'content-type': 'application/json' } : {} }, signal,
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    })
    const answer: unknown = await response.json()
    if (!response.ok && record(answer) && answer.ok === true) return { ok: false, failure: 'unavailable' }
    return decodePreferenceReply(answer, operation === 'catalog')
  } catch (error) {
    return { ok: false, failure: signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout'
      : error instanceof TypeError ? 'network' : 'unavailable' }
  }
}

const specFields = ['size', 'resolution', 'seconds', 'ratio', 'quality', 'mode'] as const
const menuFields = { size: 'sizes', resolution: 'resolutions', quality: 'qualities', background: 'backgrounds', format: 'formats', moderation: 'moderations', ratio: 'ratios', mode: 'modes', seconds: 'durations' } as const
/** Enumerated parameter control, with values already filtered by the current complete specification. */
export type PreferenceFieldKey = keyof typeof menuFields | 'count' | 'audio' | 'watermark' | 'seed'
/** One declared static parameter control. */
export interface PreferenceField {
  readonly key: PreferenceFieldKey
  readonly values: readonly PreferenceScalar[]
  readonly maximum?: number
}
/**
 * Derive legal choices without combining incompatible specifications.
 * @param currentModel - Selected authorized model.
 * @param selected - Current explicit draft parameters.
 * @returns Declared controls and their currently compatible values.
 */
export function preferenceFields(currentModel: PreferenceModel, selected: MediaSelection['parameters']): PreferenceField[] {
  const params = currentModel.params
  const fields: PreferenceField[] = []
  for (const [key, menu] of Object.entries(menuFields)) {
    let values: readonly PreferenceScalar[] = params[menu] ?? []
    if (params.specifications !== undefined && specFields.some(field => field === key)) {
      values = [...new Set(params.specifications.filter(spec => specFields.every(field =>
        field === key || selected[field] === undefined || spec[field] === selected[field]))
        .flatMap((spec) => {
          const value = spec[key as keyof PreferenceSpecification]
          return value === undefined ? [] : [value]
        }))]
    } else if (key === 'seconds' && params.durationByResolution !== undefined && typeof selected.resolution === 'string') values = params.durationByResolution[selected.resolution] ?? []
    if (values.length > 0 || selected[key] !== undefined) fields.push({ key: key as PreferenceFieldKey, values })
  }
  if (currentModel.kind === 'image' && params.maxCount !== undefined) fields.push({ key: 'count', values: [], maximum: params.maxCount })
  if (currentModel.kind === 'video' && params.audioToggle === true) fields.push({ key: 'audio', values: [false, true] })
  if (currentModel.kind === 'video' && params.watermark === true) fields.push({ key: 'watermark', values: [false, true] })
  if (params.seed === true) fields.push({ key: 'seed', values: [] })
  return fields
}
/**
 * Check a saved or draft selection against the currently published model.
 * @param currentModel - Current authorized model or absence.
 * @param selected - Saved or draft selection.
 * @returns Whether every selected static field remains declared and compatible.
 */
export function validPreferenceSelection(currentModel: PreferenceModel | undefined, selected: MediaSelection | null): boolean {
  if (selected === null) return true
  if (currentModel === undefined) return false
  const fields = preferenceFields(currentModel, selected.parameters)
  return Object.entries(selected.parameters).every(([key, value]) => key === 'seed' ? currentModel.params.seed === true && typeof value === 'number' && Number.isSafeInteger(value)
    : key === 'count' ? currentModel.kind === 'image' && typeof value === 'number' && Number.isSafeInteger(value)
      && value >= 1 && value <= (currentModel.params.maxCount ?? 0)
      : fields.some(field => field.key === key && field.values.includes(value)))
    && (currentModel.params.specifications === undefined || currentModel.params.specifications.some(spec =>
      specFields.every(key => selected.parameters[key] === undefined || selected.parameters[key] === spec[key])))
}
