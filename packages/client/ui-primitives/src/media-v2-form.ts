/** Typed form projection and validation for the public, server-owned media schema. */
import { mediaV2Object, type MediaV2Asset, type MediaV2Model, type MediaV2Value, type MediaV2Intent } from './media-v2-types.ts'

/** Window-owned material selection retaining its upload identity, explicit use and any ready receipt. */
export interface MediaV2SelectedAsset {
  readonly clientId: string
  readonly model: string
  readonly field: string
  readonly name: string
  readonly state: 'uploading' | 'ready' | 'unknown'
  readonly role: 'generation' | 'writing'
  readonly asset?: MediaV2Asset
}
/** One field-specific reason that prevents the current draft from requesting a quote. */
export interface MediaV2FormIssue { readonly field: string; readonly reason: 'required' | 'unavailable' | 'limit' | 'invalid' | 'intent' | 'unknown' | 'binding' }
/** A declared parameter property with its JSON Schema and retained native constraint annotations. */
export interface MediaV2Field {
  readonly name: string
  readonly schema: Readonly<Record<string, unknown>>
  readonly native: Readonly<Record<string, unknown>>
}
/**
 * Project declared properties without manufacturing model fields.
 * @param model - Validated catalog model whose controls the form displays.
 * @returns The declared fields in catalog order, retaining native constraint annotations.
 */
export function mediaV2Fields(model: MediaV2Model): readonly MediaV2Field[] {
  return Object.entries(mediaV2Object(model.parameters_schema.properties) ?? {}).map(([name, value]) => {
    const schema = mediaV2Object(value) ?? {}
    return { name, schema, native: mediaV2Object(schema['x-ycapi-contract']) ?? {} }
  })
}
/**
 * Evaluate native dependencies without removing any selected value.
 * @param when - Optional untrusted dependency map from the native constraint annotations.
 * @param values - Current primitive parameter selections, independent from material bindings.
 * @returns True when no condition map exists or every declared dependency matches.
 */
export function mediaV2Available(when: unknown, values: Readonly<Record<string, MediaV2Value>>): boolean {
  const conditions = mediaV2Object(when)
  return conditions === null
    || Object.entries(conditions).every(([key, allowed]) => Array.isArray(allowed) && allowed.includes(values[key]))
}
/**
 * Collect available primitive defaults without including material inputs or replacing user selections.
 * @param model - Validated model selected for the new draft.
 * @returns A fresh parameter map whose defaults satisfy the remaining default dependencies and choices.
 */
export function mediaV2Defaults(model: MediaV2Model): Record<string, MediaV2Value> {
  let result: Record<string, MediaV2Value> = {}
  const fields = mediaV2Fields(model)
  for (const field of fields) {
    if (model.asset_fields.some(asset => asset.name === field.name)) continue
    const value = field.schema.default
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
      || Array.isArray(value) && value.every(item => typeof item === 'string')) result[field.name] = value
  }
  let removed = true
  while (removed) {
    removed = false
    for (const field of fields) {
      const value = result[field.name]
      if (value === undefined) continue
      const choices = mediaV2Choices(field, result)
      const selected = Array.isArray(value) ? value : [value]
      const validChoice = choices.length === 0
        || selected.every(item => choices.some(choice => choice.value === item && choice.available))
      if (!mediaV2Available(field.native.available_when, result) || !validChoice) {
        result = Object.fromEntries(Object.entries(result).filter(([name]) => name !== field.name))
        removed = true
      }
    }
  }
  return result
}
/**
 * Resolve string choices and their current availability without changing the draft.
 * @param field - Declared parameter and its native option annotations.
 * @param values - Current selections used by option and quality dependencies.
 * @returns Every declared string choice with its label and availability flag.
 */
export function mediaV2Choices(
  field: MediaV2Field, values: Readonly<Record<string, MediaV2Value>>,
): readonly { value: string; label: string; available: boolean }[] {
  const choices = Array.isArray(field.schema.enum) ? field.schema.enum : Array.isArray(field.native.enum) ? field.native.enum : []
  const options = Array.isArray(field.native.options) ? field.native.options.map(mediaV2Object) : []
  const byQuality = mediaV2Object(field.native.enum_values_by_quality)
  const qualityValues = typeof values.quality === 'string' ? byQuality?.[values.quality] : undefined
  return choices.filter((value): value is string => typeof value === 'string').map((value) => {
    const option = options.find(item => item?.value === value)
    return { value, label: typeof option?.label === 'string' ? option.label : value,
      available: option?.available !== false && mediaV2Available(option?.available_when, values)
        && (!Array.isArray(qualityValues) || qualityValues.includes(value)) }
  })
}
/**
 * Resolve the strictest published material count for the current mode and quality.
 * @param maximum - Unconditional upper bound for the material field.
 * @param constraints - Native count overrides keyed by mode or quality.
 * @param values - Current primitive controls used to select conditional bounds.
 * @returns The smallest applicable nonnegative count limit.
 */
export function mediaV2AssetLimit(
  maximum: number, constraints: Readonly<Record<string, unknown>>, values: Readonly<Record<string, MediaV2Value>>,
): number {
  let limit = maximum
  for (const [name, parameter] of [['max_items_by_mode', 'mode'], ['max_items_by_quality', 'quality']] as const) {
    const map = mediaV2Object(constraints[name]), key = values[parameter]
    const selected = typeof key === 'string' ? map?.[key] : undefined
    if (typeof selected === 'number' && Number.isInteger(selected) && selected >= 0) limit = Math.min(limit, selected)
  }
  return limit
}
/**
 * Report incompatible controls or material selections before requesting a quote.
 * @param model - Validated model that owns the current parameter and material definitions.
 * @param intent - Explicit input workflow, independent from provider quality controls.
 * @param values - Current primitive controls, including explicit values that need correction.
 * @param assets - Every retained material with its explicit generation or writing-only use.
 * @param now - Current Unix time in seconds for checking receipt expiry.
 * @returns Field issues for the implemented local checks; no material is removed or rewritten.
 */
export function mediaV2FormIssues(model: MediaV2Model, intent: MediaV2Intent, values: Readonly<Record<string, MediaV2Value>>,
  assets: readonly MediaV2SelectedAsset[], now: number): readonly MediaV2FormIssue[] {
  const issues: MediaV2FormIssue[] = []
  const generation = assets.filter(asset => asset.role === 'generation')
  const selectedIntent = model.intents.find(item => item.id === intent)
  if (selectedIntent === undefined || (selectedIntent.requires_assets && generation.length === 0) || intent === 'text' && generation.length > 0) issues.push({ field: 'intent', reason: 'intent' })
  const required = Array.isArray(model.parameters_schema.required) ? model.parameters_schema.required : []
  const fields = mediaV2Fields(model)
  for (const name of Object.keys(values)) if (!fields.some(field => field.name === name) || model.asset_fields.some(field => field.name === name)) issues.push({ field: name, reason: 'unavailable' })
  const nativeMode = typeof values.mode === 'string' ? values.mode.toLowerCase().replaceAll('_', '-') : ''
  const textModes = ['text-to-image', 'text-to-video', 'text2image', 'text2video', 't2i', 't2v']
  const materialModes = ['image-edit', 'multi-reference', 'layer-decompose', 'image-to-video', 'image-to-image', 'reference-to-video', 'video-to-video', 'i2v', 'i2i', 'r2v', 'v2v']
  if (intent === 'text' && materialModes.includes(nativeMode) || intent !== 'text' && textModes.includes(nativeMode)) issues.push({ field: 'mode', reason: 'intent' })
  for (const field of fields.filter(item => !model.asset_fields.some(asset => asset.name === item.name))) {
    const value = values[field.name]
    const empty = value === undefined || value === '' || Array.isArray(value) && value.length === 0
    const available = mediaV2Available(field.native.available_when, values)
    if (!available) { if (!empty) issues.push({ field: field.name, reason: 'unavailable' }); continue }
    if (empty) { if (required.includes(field.name) || field.native.required === true) issues.push({ field: field.name, reason: 'required' }); continue }
    const choices = mediaV2Choices(field, values)
    if (choices.length > 0 && (Array.isArray(value) ? value.some(item => !choices.some(choice => choice.value === item && choice.available))
      : !choices.some(choice => choice.value === value && choice.available))) issues.push({ field: field.name, reason: 'unavailable' })
    if (field.schema.type === 'integer' || field.schema.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || field.schema.type === 'integer' && !Number.isInteger(value)) issues.push({ field: field.name, reason: 'invalid' })
      else if (typeof field.schema.minimum === 'number' && value < field.schema.minimum || typeof field.schema.maximum === 'number' && value > field.schema.maximum) issues.push({ field: field.name, reason: 'limit' })
    }
    const exclusive = Array.isArray(field.native.exclusive_options) ? field.native.exclusive_options : []
    if (Array.isArray(value) && value.length > 1 && value.some(item => exclusive.includes(item))) issues.push({ field: field.name, reason: 'invalid' })
  }
  for (const selected of generation) {
    if (selected.state !== 'ready' || selected.asset === undefined) issues.push({ field: selected.field, reason: 'unknown' })
    else if (selected.model !== model.id || selected.asset.model !== model.id || selected.asset.expires_at <= now) issues.push({ field: selected.field, reason: 'binding' })
    if (!model.asset_fields.some(field => field.name === selected.field)) issues.push({ field: selected.field, reason: 'unavailable' })
  }
  for (const field of model.asset_fields) {
    const picked = generation.filter(item => item.field === field.name)
    const native = { ...fields.find(item => item.name === field.name)?.native, ...field.constraints }
    const available = mediaV2Available(native.available_when, values)
    if (!available) { if (picked.length > 0) issues.push({ field: field.name, reason: 'unavailable' }); continue }
    if (picked.length < field.min_items || (native.required === true || required.includes(field.name)) && picked.length === 0) issues.push({ field: field.name, reason: 'required' })
    if (picked.length > mediaV2AssetLimit(field.max_items, { ...native, ...field.constraints }, values)) issues.push({ field: field.name, reason: 'limit' })
    for (const item of picked) {
      const asset = item.asset
      if (asset !== undefined && (asset.media_kind !== field.media_kind || !field.mime_types.includes(asset.mime_type))) issues.push({ field: field.name, reason: 'invalid' })
      if (asset !== undefined && typeof native.max_bytes === 'number' && asset.bytes > native.max_bytes) issues.push({ field: field.name, reason: 'limit' })
    }
    const exclusives = mediaV2Object(native.exclusive_with_by_mode)
    const otherFields = typeof values.mode === 'string' ? exclusives?.[values.mode] : undefined
    if (picked.length > 0 && Array.isArray(otherFields) && generation.some(item => otherFields.includes(item.field))) issues.push({ field: field.name, reason: 'invalid' })
  }
  const imageCount = generation.filter(item => item.asset?.media_kind === 'image').length
  const videoCount = generation.filter(item => item.asset?.media_kind === 'video').length
  for (const field of fields) {
    const options = Array.isArray(field.native.options) ? field.native.options.map(mediaV2Object) : []
    const option = options.find(item => item?.value === values[field.name])
    if (option === undefined || option === null) continue
    if (typeof option.ref_min === 'number' && imageCount < option.ref_min || typeof option.ref_max === 'number' && imageCount > option.ref_max
      || typeof option.ref_min_videos === 'number' && videoCount < option.ref_min_videos) issues.push({ field: field.name, reason: 'limit' })
  }
  return issues
}
