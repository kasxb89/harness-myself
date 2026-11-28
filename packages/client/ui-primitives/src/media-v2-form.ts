/** Typed form projection and validation for the public, server-owned media schema. */
import { isMediaV2Value, mediaV2Object, readMediaV2Quantity, type MediaV2Asset, type MediaV2Model, type MediaV2Value, type MediaV2Intent } from './media-v2-types.ts'
import { mediaV2ParameterIssues } from './media-v2-parameter-conditions.ts'
import { mediaV2MaterialIssues } from './media-v2-material-conditions.ts'

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
export interface MediaV2FormIssue { readonly field: string; readonly reason: 'required' | 'unavailable' | 'limit' | 'invalid' | 'intent' | 'unknown' | 'binding' | 'unsupported' | 'condition' | 'parameterCondition' }
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
    if (isMediaV2Value(value)) result[field.name] = value
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
 * Resolve scalar choices and their current availability without changing the draft.
 * @param field - Declared parameter and its native option annotations.
 * @param values - Current selections used by option and quality dependencies.
 * @param model - Optional selected model whose reviewed scalar predicates can disable an option.
 * @returns Declared scalar choices and retained selections removed from a nonempty menu, marked unavailable.
 */
export function mediaV2Choices(
  field: MediaV2Field, values: Readonly<Record<string, MediaV2Value>>, model?: MediaV2Model,
): readonly { value: string | number | boolean; label: string; available: boolean }[] {
  const items = mediaV2Object(field.schema.items)
  const choices = Array.isArray(field.schema.enum) ? field.schema.enum
    : Array.isArray(items?.enum) ? items.enum : Array.isArray(field.native.enum) ? field.native.enum : []
  const options = Array.isArray(field.native.options) ? field.native.options.map(mediaV2Object) : []
  const byQuality = mediaV2Object(field.native.enum_values_by_quality)
  const qualityValues = typeof values.quality === 'string' ? byQuality?.[values.quality] : undefined
  const menu = choices.filter((value): value is string | number | boolean => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)).map((value) => {
    const option = options.find(item => item?.value === value)
    return { value, label: typeof option?.label === 'string' ? option.label : String(value),
      available: option?.available !== false && mediaV2Available(option?.available_when, values)
        && (!Array.isArray(qualityValues) || qualityValues.includes(value))
        && (model === undefined || !mediaV2ParameterIssues(model, { ...values, [field.name]: value })
          .some(issue => issue.field === field.name && issue.reason === 'parameterCondition')) }
  })
  const selected = values[field.name]
  if (menu.length > 0) for (const value of Array.isArray(selected) ? selected : [selected]) {
    if ((typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))
      && !menu.some(choice => choice.value === value)) menu.push({ value, label: String(value), available: false })
  }
  return menu
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
 * Check the supported basic JSON controls without treating unimplemented schema rules as valid.
 * @param schema - Published field schema with native annotations kept separately.
 * @param value - Retained JSON value, never coerced to another input type.
 * @returns A visible issue for unsupported schema rules or invalid data.
 */
export function mediaV2SchemaIssue(schema: Readonly<Record<string, unknown>>, value: MediaV2Value): 'invalid' | 'limit' | 'unsupported' | undefined {
  if (['$ref', 'oneOf', 'allOf', 'anyOf', 'not', 'if', 'then', 'else', 'dependentSchemas', 'patternProperties', 'contains', 'prefixItems', 'unevaluatedProperties']
    .some(key => schema[key] !== undefined)) return 'unsupported'
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) return 'invalid'
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return 'invalid'
  const type = schema.type
  if (type !== undefined && (typeof type !== 'string'
    || !['object', 'array', 'string', 'boolean', 'integer', 'number', 'null'].includes(type))) return 'unsupported'
  if (type === 'null') return value === null ? undefined : 'invalid'
  if (type === 'boolean') return typeof value === 'boolean' ? undefined : 'invalid'
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || type === 'integer' && !Number.isInteger(value)) return 'invalid'
    if (typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum) return 'limit'
  }
  if (type === 'string') {
    if (typeof value !== 'string') return 'invalid'
    if (typeof schema.minLength === 'number' && value.length < schema.minLength || typeof schema.maxLength === 'number' && value.length > schema.maxLength) return 'limit'
    if (schema.pattern !== undefined || schema.format !== undefined) return 'unsupported'
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return 'invalid'
    if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems) return 'limit'
    if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return 'invalid'
    const items = mediaV2Object(schema.items)
    if (schema.items !== undefined && items === null) return 'unsupported'
    if (items !== null) for (const item of value) {
      if (!isMediaV2Value(item)) return 'invalid'
      const issue = mediaV2SchemaIssue(items, item)
      if (issue !== undefined) return issue
    }
  }
  if (type === 'object' || schema.properties !== undefined) {
    const object = mediaV2Object(value)
    if (object === null) return 'invalid'
    const properties = mediaV2Object(schema.properties) ?? {}
    const required = Array.isArray(schema.required) ? schema.required : []
    if (required.some(key => typeof key !== 'string' || object[key] === undefined)) return 'invalid'
    for (const [key, item] of Object.entries(object)) {
      const field = mediaV2Object(properties[key])
      if (!isMediaV2Value(item)) return 'invalid'
      if (field !== null) { const issue = mediaV2SchemaIssue(field, item); if (issue !== undefined) return issue }
      else if (schema.additionalProperties === false) return 'invalid'
      else if (mediaV2Object(schema.additionalProperties) !== null) return 'unsupported'
    }
  }
  return undefined
}
/** Native presence semantics apply to control dependencies, including non-boolean values. */
function present(value: MediaV2Value | undefined): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim() !== ''
  return !Array.isArray(value) || value.length > 0
}
/** Check only server-observed metadata; absent values remain the free-quote validator's responsibility. */
function assetMetadataIssue(asset: MediaV2Asset, native: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, MediaV2Value>>): boolean {
  const mode = typeof values.mode === 'string' ? values.mode : ''
  const duration = asset.duration_seconds
  const modeMinimum = mediaV2Object(native.min_duration_sec_by_mode)?.[mode]
  const minimum = Math.max(typeof native.min_duration_sec === 'number' ? native.min_duration_sec : 0,
    typeof modeMinimum === 'number' ? modeMinimum : 0)
  const maximum = mediaV2Object(native.max_clip_duration_sec_by_mode)?.[mode]
  if (duration !== undefined && (duration < minimum || typeof maximum === 'number' && duration > maximum)) return true
  const dimensions = asset.width !== undefined && asset.height !== undefined && asset.width > 0 && asset.height > 0
    ? { min_edge_px: Math.min(asset.width, asset.height), max_edge_px: Math.max(asset.width, asset.height),
      min_pixels: asset.width * asset.height, max_pixels: asset.width * asset.height,
      aspect_min: asset.width / asset.height, aspect_max: asset.width / asset.height } : undefined
  for (const key of ['min_edge_px', 'max_edge_px', 'min_pixels', 'max_pixels', 'aspect_min', 'aspect_max'] as const) {
    const limit = native[key], actual = dimensions?.[key]
    if (typeof limit === 'number' && actual !== undefined && (key.startsWith('min') || key === 'aspect_min' ? actual < limit : actual > limit)) return true
  }
  for (const key of ['min_fps', 'max_fps'] as const) {
    const limit = native[key]
    if (typeof limit === 'number' && asset.fps !== undefined && (key === 'min_fps' ? asset.fps < limit : asset.fps > limit)) return true
  }
  return false
}
/**
 * Report incompatible controls or material selections before requesting a quote.
 * @param model - Validated model that owns the current parameter and material definitions.
 * @param intent - Explicit input workflow, independent from provider quality controls.
 * @param values - Current primitive controls, including explicit values that need correction.
 * @param assets - Every retained material with its explicit generation or writing-only use.
 * @param now - Current Unix time in seconds for checking receipt expiry.
 * @param nativeVideoBatch - Explicit catalog capability; omission retains the single-output video limit.
 * @returns Field issues for the implemented local checks; no material is removed or rewritten.
 */
export function mediaV2FormIssues(model: MediaV2Model, intent: MediaV2Intent, values: Readonly<Record<string, MediaV2Value>>,
  assets: readonly MediaV2SelectedAsset[], now: number, nativeVideoBatch = false): readonly MediaV2FormIssue[] {
  const issues: MediaV2FormIssue[] = [...mediaV2MaterialIssues(model, values, assets, now), ...mediaV2ParameterIssues(model, values),
    ...mediaV2QuantityIssues(model, values, nativeVideoBatch)]
  if (['$ref', 'oneOf', 'allOf', 'anyOf', 'if', 'then', 'else'].some(key => model.parameters_schema[key] !== undefined)) issues.push({ field: 'parameters', reason: 'unsupported' })
  const generation = assets.filter(asset => asset.role === 'generation')
  const selectedIntent = model.intents.find(item => item.id === intent)
  if (selectedIntent === undefined || (selectedIntent.requires_assets && generation.length === 0) || intent === 'text' && generation.length > 0) issues.push({ field: 'intent', reason: 'intent' })
  const required = Array.isArray(model.parameters_schema.required) ? model.parameters_schema.required : []
  const fields = mediaV2Fields(model)
  for (const name of Object.keys(values)) if (!fields.some(field => field.name === name) || model.asset_fields.some(field => field.name === name)) issues.push({ field: name, reason: 'unavailable' })
  const nativeMode = typeof values.mode === 'string' ? values.mode.toLowerCase().replaceAll('_', '-') : ''
  const textModes = ['text-to-image', 'text-to-video', 'text2image', 'text2video', 't2i', 't2v']
  const materialModes = ['image-edit', 'reference', 'multi-reference', 'layer-decompose', 'image-to-video', 'image-to-image', 'reference-to-video', 'video-to-video', 'i2v', 'i2i', 'r2v', 'v2v']
  if (intent === 'text' && materialModes.includes(nativeMode) || intent !== 'text' && textModes.includes(nativeMode)) issues.push({ field: 'mode', reason: 'intent' })
  for (const field of fields.filter(item => !model.asset_fields.some(asset => asset.name === item.name))) {
    const value = values[field.name]
    const empty = value === undefined || value === '' || Array.isArray(value) && value.length === 0
    if (mediaV2SchemaIssue(field.schema, value ?? null) === 'unsupported') { issues.push({ field: field.name, reason: 'unsupported' }); continue }
    const available = mediaV2Available(field.native.available_when, values)
    if (!available) { if (!empty) issues.push({ field: field.name, reason: 'unavailable' }); continue }
    if (empty) { if (required.includes(field.name) || field.native.required === true) issues.push({ field: field.name, reason: 'required' }); continue }
    const choices = mediaV2Choices(field, values)
    if (choices.length > 0 && (Array.isArray(value) ? value.some(item => !choices.some(choice => choice.value === item && choice.available))
      : !choices.some(choice => choice.value === value && choice.available))) issues.push({ field: field.name, reason: 'unavailable' })
    const schemaIssue = mediaV2SchemaIssue(field.schema, value)
    if (schemaIssue !== undefined) issues.push({ field: field.name, reason: schemaIssue })
    if (present(value) && Array.isArray(field.native.requires_media)
      && field.native.requires_media.some(name => !generation.some(asset => asset.field === name))) issues.push({ field: field.name, reason: 'required' })
    const exclusive = Array.isArray(field.native.exclusive_options) ? field.native.exclusive_options : []
    if (Array.isArray(value) && value.length > 1 && value.some(item => exclusive.includes(item))) issues.push({ field: field.name, reason: 'invalid' })
  }
  for (const selected of generation) {
    if (selected.state !== 'ready' || selected.asset === undefined) issues.push({ field: selected.field, reason: 'unknown' })
    else if (selected.model !== model.id || selected.asset.model !== model.id || selected.asset.expires_at <= now) issues.push({ field: selected.field, reason: 'binding' })
    if (!model.asset_fields.some(field => field.name === selected.field)) issues.push({ field: selected.field, reason: 'unavailable' })
  }
  let combinedDuration = 0, combinedLimit = Number.POSITIVE_INFINITY
  const combinedFields: string[] = []
  for (const field of model.asset_fields) {
    const picked = generation.filter(item => item.field === field.name)
    const native = { ...fields.find(item => item.name === field.name)?.native, ...field.constraints }
    const duration = picked.reduce((sum, item) => sum + (item.asset?.duration_seconds ?? 0), 0)
    if (typeof native.max_combined_items === 'number' && generation.length > native.max_combined_items) issues.push({ field: field.name, reason: 'limit' })
    if (native.combined_duration_budget === true) {
      combinedFields.push(field.name); combinedDuration += duration
      if (typeof native.max_total_duration_sec === 'number') combinedLimit = Math.min(combinedLimit, native.max_total_duration_sec)
    }
    const available = mediaV2Available(native.available_when, values)
    if (!available) { if (picked.length > 0) issues.push({ field: field.name, reason: 'unavailable' }); continue }
    if (picked.length < field.min_items || (native.required === true || required.includes(field.name)) && picked.length === 0) issues.push({ field: field.name, reason: 'required' })
    if (picked.length > mediaV2AssetLimit(field.max_items, { ...native, ...field.constraints }, values)) issues.push({ field: field.name, reason: 'limit' })
    for (const item of picked) {
      const asset = item.asset
      if (asset !== undefined && (asset.media_kind !== field.media_kind || !field.mime_types.includes(asset.mime_type))) issues.push({ field: field.name, reason: 'invalid' })
      if (asset !== undefined && (typeof native.max_bytes === 'number' && asset.bytes > native.max_bytes
        || assetMetadataIssue(asset, native, values))) issues.push({ field: field.name, reason: 'limit' })
    }
    if (typeof native.max_total_duration_sec === 'number' && duration > native.max_total_duration_sec) issues.push({ field: field.name, reason: 'limit' })
    if (picked.length > 0 && native.requires_visual_reference === true
      && !generation.some(item => item.field === 'images' || item.field === 'videos')) issues.push({ field: field.name, reason: 'required' })
    if (picked.length > 0 && typeof native.max_ref_plus_output_sec === 'number') {
      const output = typeof values.duration === 'number' ? values.duration : typeof values.duration === 'string' && values.duration.trim() !== '' ? Number(values.duration) : Number.NaN
      if (!Number.isFinite(output) || duration + output > native.max_ref_plus_output_sec) issues.push({ field: field.name, reason: 'limit' })
    }
    const exclusives = mediaV2Object(native.exclusive_with_by_mode)
    const otherFields = typeof values.mode === 'string' ? exclusives?.[values.mode] : undefined
    if (picked.length > 0 && Array.isArray(otherFields) && generation.some(item => otherFields.includes(item.field))) issues.push({ field: field.name, reason: 'invalid' })
  }
  if (combinedDuration > combinedLimit) for (const field of combinedFields) issues.push({ field, reason: 'limit' })
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

/**
 * Guard native video quantity independently from legacy image counts and without broadening published schema limits.
 * @param model - Selected model, its current controls and optional reviewed quantity metadata.
 * @param values - Exact draft parameters; missing count retains the published single-output default.
 * @param nativeVideoBatch - Explicit catalog capability required for count above one.
 * @returns A local issue for incompatible quantity or unsupported policy, preserving the draft.
 */
export function mediaV2QuantityIssues(model: MediaV2Model, values: Readonly<Record<string, MediaV2Value>>,
  nativeVideoBatch: boolean): readonly MediaV2FormIssue[] {
  if (model.quantity === undefined) return model.kind === 'video' && typeof values.count === 'number' && values.count > 1
    ? [{ field: 'count', reason: 'limit' }] : []
  const quantity = readMediaV2Quantity(model.quantity)
  if (quantity === null) return [{ field: 'parameters', reason: 'unsupported' }]
  if (model.kind !== 'video') return []
  const properties = mediaV2Object(model.parameters_schema.properties), count = mediaV2Object(properties?.count)
  if (count?.type !== 'integer' || count.minimum !== 1 || count.default !== 1
    || typeof count.maximum !== 'number' || !Number.isSafeInteger(count.maximum) || count.maximum < quantity.maximum) {
    return [{ field: 'parameters', reason: 'unsupported' }]
  }
  const result: MediaV2FormIssue[] = []
  const selected = values.count ?? 1
  if (typeof selected === 'number' && (selected > quantity.maximum || !nativeVideoBatch && selected > 1)) {
    result.push({ field: 'count', reason: 'limit' })
  }
  const mode = values.mode ?? mediaV2Object(properties?.mode)?.default
  if (typeof selected === 'number' && selected > 1 && (typeof mode !== 'string' || !quantity.modes.includes(mode))) {
    result.push(properties?.mode === undefined
      ? { field: 'parameters', reason: 'unsupported' } : { field: 'mode', reason: 'unavailable' })
  }
  return result
}
