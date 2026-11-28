/** Versioned finite OR predicates on native controls and actual generation bindings. */
import { mediaV2Object, type MediaV2Model, type MediaV2Value } from './media-v2-types.ts'
import type { MediaV2SelectedAsset } from './media-v2-form.ts'

type Scalar = string | number | boolean
interface Predicate {
  readonly allowed_values?: readonly Scalar[]
  readonly minimum?: number
  readonly maximum?: number
  readonly min_items?: number
  readonly max_items?: number
  readonly disabled?: true
}
interface Combination {
  readonly parameters: Readonly<Record<string, Predicate>>
  readonly required: readonly string[]
}
const own = (object: object, key: string): boolean => Object.hasOwn(object, key)
const only = (object: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(object).every(key => keys.includes(key))
const fieldName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(value)
const scalar = (value: unknown): value is Scalar => typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value)
function scalarType(value: unknown, type: unknown): value is Scalar {
  return scalar(value) && (type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
    : type === 'number' ? typeof value === 'number' : type === 'string' ? typeof value === 'string'
      : type === 'boolean' && typeof value === 'boolean')
}
function predicate(raw: unknown, schema: Record<string, unknown>, asset: boolean): Predicate | null {
  const row = mediaV2Object(raw)
  if (row === null || !only(row, ['allowed_values', 'minimum', 'maximum', 'min_items', 'max_items', 'disabled'])) return null
  if (own(row, 'disabled')) return row.disabled === true && Object.keys(row).length === 1 ? { disabled: true } : null
  const choices = row.allowed_values
  if (own(row, 'allowed_values') && (!Array.isArray(choices) || choices.length === 0 || choices.length > 128
    || choices.some(item => !scalarType(item, schema.type)) || new Set(choices).size !== choices.length)) return null
  for (const key of ['minimum', 'maximum', 'min_items', 'max_items'] as const) {
    if (!own(row, key)) continue
    const value = row[key], items = key === 'min_items' || key === 'max_items'
    if (typeof value !== 'number' || !Number.isFinite(value)
      || (items ? !asset || schema.type !== 'array' || !Number.isInteger(value) || value < 0
        : schema.type !== 'number' && schema.type !== 'integer')) return null
  }
  for (const [minimum, maximum] of [['minimum', 'maximum'], ['min_items', 'max_items']] as const) {
    if (typeof row[minimum] === 'number' && typeof row[maximum] === 'number' && row[minimum] > row[maximum]) return null
  }
  return { ...Array.isArray(choices) ? { allowed_values: choices as Scalar[] } : {},
    ...typeof row.minimum === 'number' ? { minimum: row.minimum } : {},
    ...typeof row.maximum === 'number' ? { maximum: row.maximum } : {},
    ...typeof row.min_items === 'number' ? { min_items: row.min_items } : {},
    ...typeof row.max_items === 'number' ? { max_items: row.max_items } : {} }
}
function combinations(model: MediaV2Model): readonly Combination[] | null | undefined {
  if (model.selection_constraints === undefined) return undefined
  const raw = model.selection_constraints, row = mediaV2Object(raw), declared = mediaV2Object(model.parameters_schema.properties)
  if (row === null) return null
  try { if (new TextEncoder().encode(JSON.stringify(row)).length > 262144) return null } catch { return null }
  if (!only(row, ['schema_version', 'combinations']) || row.schema_version !== 1 || declared === null
    || !Array.isArray(row.combinations) || row.combinations.length === 0 || row.combinations.length > 128) return null
  const result: Combination[] = []
  for (const rawCombination of row.combinations) {
    const item = mediaV2Object(rawCombination), parameters = mediaV2Object(item?.parameters)
    if (item === null || !only(item, ['parameters', 'required_parameters']) || parameters === null || Object.keys(parameters).length > 64) return null
    const compiled: Record<string, Predicate> = {}
    for (const [name, rawPredicate] of Object.entries(parameters)) {
      const schema = own(declared, name) ? mediaV2Object(declared[name]) : null
      if (!fieldName(name) || schema === null) return null
      const value = predicate(rawPredicate, schema, model.asset_fields.some(field => field.name === name))
      if (value === null) return null
      compiled[name] = value
    }
    const required = own(item, 'required_parameters') ? item.required_parameters : []
    if (!Array.isArray(required) || required.length > 64 || required.some(name => !fieldName(name)
      || !own(declared, name) || compiled[name]?.disabled === true) || new Set(required).size !== required.length) return null
    result.push({ parameters: compiled, required: required as string[] })
  }
  return result
}
function bindings(model: MediaV2Model, values: Readonly<Record<string, MediaV2Value>>,
  assets: readonly MediaV2SelectedAsset[], now: number): Record<string, MediaV2Value> {
  const selected: Record<string, MediaV2Value> = Object.fromEntries(Object.entries(values)
    .filter(([name]) => !model.asset_fields.some(field => field.name === name)))
  for (const field of model.asset_fields) {
    const ids = assets.flatMap((item) => {
      const asset = item.asset
      return item.field === field.name && item.role === 'generation' && item.state === 'ready' && item.model === model.id
        && asset !== undefined && asset.model === model.id && asset.expires_at > now ? [asset.asset_id] : []
    })
    if (ids.length > 0) selected[field.name] = ids
  }
  return selected
}
function matches(row: Combination, values: Readonly<Record<string, MediaV2Value>>, partial: boolean): boolean {
  if (!partial && row.required.some(name => !own(values, name))) return false
  return Object.entries(row.parameters).every(([name, rule]) => {
    if (!own(values, name)) return true
    const value = values[name]
    if (rule.disabled === true) return value === false || value === null || Array.isArray(value) && value.length === 0
    return (rule.allowed_values === undefined || scalar(value) && rule.allowed_values.includes(value))
      && (rule.minimum === undefined || typeof value === 'number' && value >= rule.minimum)
      && (rule.maximum === undefined || typeof value === 'number' && value <= rule.maximum)
      && (rule.min_items === undefined || Array.isArray(value) && value.length >= rule.min_items)
      && (rule.max_items === undefined || Array.isArray(value) && value.length <= rule.max_items)
  })
}
/**
 * Check the whole versioned finite selection policy before any new quote.
 * @param model - Selected catalog model; unknown policy data affects only this model's new work.
 * @param values - Unchanged native controls, with no coercion or fallback defaults.
 * @param assets - Retained materials; only ready, current generation bindings satisfy asset predicates.
 * @param now - Unix time in seconds used to reject expired bindings independently.
 * @returns A generic visible policy issue, without changing the draft or original operations.
 */
export function mediaV2SelectionIssues(model: MediaV2Model, values: Readonly<Record<string, MediaV2Value>>,
  assets: readonly MediaV2SelectedAsset[], now: number): readonly { field: 'parameters'; reason: 'unsupported' | 'parameterCondition' }[] {
  const rules = combinations(model)
  if (rules === undefined) return []
  if (rules === null) return [{ field: 'parameters', reason: 'unsupported' }]
  const selected = bindings(model, values, assets, now)
  return rules.some(row => matches(row, selected, false)) ? [] : [{ field: 'parameters', reason: 'parameterCondition' }]
}
/**
 * Resolve an option against all validated OR branches and current generation materials.
 * @param model - Catalog model with optional finite selection predicates.
 * @param values - Candidate selections; missing required controls may still be completed explicitly.
 * @param assets - Current materials, preserved regardless of option availability.
 * @param now - Unix time in seconds for ready binding validity.
 * @returns True when a branch remains possible, without altering values or granting extra capabilities.
 */
export function mediaV2SelectionAvailable(model: MediaV2Model, values: Readonly<Record<string, MediaV2Value>>,
  assets: readonly MediaV2SelectedAsset[], now: number): boolean {
  const rules = combinations(model)
  return rules === undefined || rules !== null && rules.some(row => matches(row, bindings(model, values, assets, now), true))
}
