/** Versioned material relationships from the public media catalog. */
import { mediaV2Object, type MediaV2Model, type MediaV2Value } from './media-v2-types.ts'
import type { MediaV2SelectedAsset } from './media-v2-form.ts'

type Scalar = string | number | boolean | null
interface Rule {
  readonly when: Readonly<Record<string, readonly Scalar[]>>
  readonly field: string
  readonly constraint: { readonly kind: 'count'; readonly counts: readonly number[] }
    | { readonly kind: 'dependency'; readonly fields: readonly string[] }
}
const scalar = (value: unknown): value is Scalar => value === null || typeof value === 'string'
  || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const only = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key))
const fieldName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(value)

function readRule(value: unknown, parameters: Readonly<Record<string, unknown>>, fields: readonly string[]): Rule | null {
  const row = mediaV2Object(value)
  if (row === null || !only(row, ['id', 'when', 'asset_field', 'disallowed_counts', 'requires_any_assets', 'message'])
    || !nonempty(row.id) || !nonempty(row.message) || !fieldName(row.asset_field)) return null
  const when = row.when === undefined ? {} : mediaV2Object(row.when)
  if (when === null) return null
  const allowed: Record<string, readonly Scalar[]> = {}
  for (const [key, choices] of Object.entries(when)) {
    if (!fieldName(key) || !Object.hasOwn(parameters, key) || fields.includes(key) || !Array.isArray(choices)
      || choices.length === 0 || !choices.every(scalar)) return null
    allowed[key] = choices
  }
  if ((row.disallowed_counts !== undefined) === (row.requires_any_assets !== undefined)) return null
  if (row.disallowed_counts !== undefined) {
    const counts = row.disallowed_counts
    if (!Array.isArray(counts) || counts.length === 0
      || !counts.every((count): count is number => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) return null
    return { when: allowed, field: row.asset_field, constraint: { kind: 'count', counts } }
  }
  const dependencies = row.requires_any_assets
  if (!Array.isArray(dependencies) || dependencies.length === 0
    || !dependencies.every(fieldName)) return null
  return { when: allowed, field: row.asset_field, constraint: { kind: 'dependency', fields: dependencies } }
}

/**
 * Check supported material rules against exact scalar selections and ready generation bindings.
 * @param model - Current catalog model; unsupported rule data blocks this model's new quote.
 * @param values - Parameter values after normal default selection, without coercion.
 * @param assets - Retained materials, including writing-only and unconfirmed selections.
 * @param now - Unix time in seconds for binding expiry.
 * @returns Field-specific violations without changing parameters, materials or original operations.
 */
export function mediaV2MaterialIssues(model: MediaV2Model, values: Readonly<Record<string, MediaV2Value>>,
  assets: readonly MediaV2SelectedAsset[], now: number): readonly { field: string; reason: 'condition' | 'unsupported' }[] {
  if (model.conditions === undefined || Array.isArray(model.conditions) && model.conditions.length === 0) return []
  const unsupported = [{ field: 'parameters', reason: 'unsupported' as const }]
  const conditions = mediaV2Object(model.conditions)
  if (conditions === null || !only(conditions, ['schema_version', 'rules']) || conditions.schema_version !== 1
    || !Array.isArray(conditions.rules)) return unsupported
  const fields = model.asset_fields.map(field => field.name)
  const parameters = mediaV2Object(model.parameters_schema.properties) ?? {}
  const rules: Rule[] = []
  for (const value of conditions.rules) {
    const rule = readRule(value, parameters, fields)
    if (rule === null) return unsupported
    rules.push(rule)
  }
  const generation = assets.filter(item => fields.includes(item.field) && item.role === 'generation' && item.state === 'ready' && item.asset !== undefined
    && item.model === model.id && item.asset.model === model.id && item.asset.expires_at > now)
  const count = (field: string): number => generation.filter(item => item.field === field).length
  return rules.filter((rule) => {
    if (!Object.entries(rule.when).every(([key, choices]) => choices.some(choice => choice === values[key]))) return false
    return rule.constraint.kind === 'count' ? rule.constraint.counts.includes(count(rule.field))
      : count(rule.field) > 0 && rule.constraint.fields.every(field => count(field) === 0)
  }).map(rule => ({ field: fields.includes(rule.field) ? rule.field : 'parameters', reason: 'condition' }))
}
