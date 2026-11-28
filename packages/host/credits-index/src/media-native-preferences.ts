/** Scalar preference views never turn a native schema into legacy execution permission. @module */
import type { ImageParams, MediaSpecification, ModelCapability, VideoParams } from './media.ts'
import { readMediaV2SpecificationPricing, type MediaV2Model, type MediaV2SpecificationPriceRow } from './media-v2-protocol.ts'
import type { MediaPreferencePricing } from './media-preference-pricing-types.ts'
import { mediaPreferencePoints, mediaPreferencePrices } from './media-preference-pricing.ts'

const maximumSpecifications = 8192
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128
  && !/[\u0000-\u001f\u007f]/u.test(value)
const unsupported = ['oneOf', 'allOf', 'anyOf', 'not', 'if', 'then', 'else', '$ref', 'dependentSchemas',
  'dependentRequired', 'patternProperties', 'unevaluatedProperties', 'pattern', 'format'] as const

function seconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value) || value.length > 16) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function finiteStrings(schema: Record<string, unknown>): readonly string[] | undefined {
  if (schema.type !== 'string' || unsupported.some(key => schema[key] !== undefined)) return undefined
  const declared = schema.enum
  const values = schema.const === undefined ? declared : [schema.const]
  if (!Array.isArray(values) || values.length === 0 || !values.every(text)
    || new Set(values).size !== values.length || declared !== undefined
      && (!Array.isArray(declared) || values.some(value => !declared.includes(value)))) return undefined
  return values
}

function countOne(schema: unknown): boolean {
  if (schema === undefined) return true
  const value = object(schema)
  return value !== undefined && value.type === 'integer' && !unsupported.some(key => value[key] !== undefined)
    && (value.const === undefined || value.const === 1)
    && (value.enum === undefined || Array.isArray(value.enum) && value.enum.includes(1))
    && (value.minimum === undefined || typeof value.minimum === 'number' && value.minimum <= 1)
    && (value.maximum === undefined || typeof value.maximum === 'number' && value.maximum >= 1)
    && value.exclusiveMinimum === undefined && value.exclusiveMaximum === undefined && value.multipleOf === undefined
}

type Scalar = string | number | boolean
interface Predicate {
  readonly allowed_values?: readonly Scalar[]
  readonly minimum?: number
  readonly maximum?: number
  readonly min_items?: number
  readonly max_items?: number
  readonly disabled?: true
}
interface Combination { readonly parameters: Readonly<Record<string, Predicate>>; readonly required: readonly string[] }
const own = (value: object, name: string): boolean => Object.hasOwn(value, name)
const only = (value: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(value).every(name => names.includes(name))
const fieldName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(value)
const scalar = (value: unknown): value is Scalar => typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value)
const hasType = (value: unknown, type: unknown): value is Scalar => scalar(value)
  && (type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : type === 'number' ? typeof value === 'number'
    : type === 'string' ? typeof value === 'string' : type === 'boolean' && typeof value === 'boolean')

function predicate(raw: unknown, schema: Record<string, unknown>, asset: boolean): Predicate | undefined {
  const row = object(raw)
  if (row === undefined || !only(row, ['allowed_values', 'minimum', 'maximum', 'min_items', 'max_items', 'disabled'])) return undefined
  if (own(row, 'disabled')) return row.disabled === true && Object.keys(row).length === 1 ? { disabled: true } : undefined
  const allowed = row.allowed_values
  if (own(row, 'allowed_values') && (!Array.isArray(allowed) || allowed.length === 0 || allowed.length > 128
    || allowed.some(value => !hasType(value, schema.type)) || new Set(allowed).size !== allowed.length)) return undefined
  for (const key of ['minimum', 'maximum', 'min_items', 'max_items'] as const) {
    if (!own(row, key)) continue
    const value = row[key], items = key === 'min_items' || key === 'max_items'
    if (typeof value !== 'number' || !Number.isFinite(value)
      || (items ? !asset || schema.type !== 'array' || !Number.isInteger(value) || value < 0
        : schema.type !== 'number' && schema.type !== 'integer')) return undefined
  }
  for (const [lower, upper] of [['minimum', 'maximum'], ['min_items', 'max_items']] as const) {
    if (typeof row[lower] === 'number' && typeof row[upper] === 'number' && row[lower] > row[upper]) return undefined
  }
  return { ...Array.isArray(allowed) ? { allowed_values: allowed as Scalar[] } : {},
    ...typeof row.minimum === 'number' ? { minimum: row.minimum } : {},
    ...typeof row.maximum === 'number' ? { maximum: row.maximum } : {},
    ...typeof row.min_items === 'number' ? { min_items: row.min_items } : {},
    ...typeof row.max_items === 'number' ? { max_items: row.max_items } : {} }
}

function combinations(model: MediaV2Model, properties: Record<string, unknown>): readonly Combination[] | null | undefined {
  if (model.selection_constraints === undefined) return undefined
  const row = object(model.selection_constraints)
  if (row === undefined) return null
  try { if (Buffer.byteLength(JSON.stringify(row)) > 262144) return null } catch { return null }
  if (!only(row, ['schema_version', 'combinations']) || row.schema_version !== 1 || !Array.isArray(row.combinations)
    || row.combinations.length === 0 || row.combinations.length > 128) return null
  const result: Combination[] = []
  for (const raw of row.combinations) {
    const item = object(raw), values = object(item?.parameters)
    if (item === undefined || !only(item, ['parameters', 'required_parameters']) || values === undefined
      || Object.keys(values).length > 64) return null
    const compiled: Record<string, Predicate> = {}
    for (const [name, value] of Object.entries(values)) {
      const schema = own(properties, name) ? object(properties[name]) : undefined
      if (!fieldName(name) || schema === undefined) return null
      const read = predicate(value, schema, model.asset_fields.some(field => field.name === name))
      if (read === undefined) return null
      compiled[name] = read
    }
    const required = own(item, 'required_parameters') ? item.required_parameters : []
    if (!Array.isArray(required) || required.length > 64 || new Set(required).size !== required.length
      || required.some(name => !fieldName(name) || !own(properties, name) || compiled[name]?.disabled === true)) return null
    result.push({ parameters: compiled, required: required as string[] })
  }
  return result
}

function matches(value: Scalar | undefined, rule: Predicate | undefined): boolean {
  if (value === undefined || rule === undefined) return true
  if (rule.disabled === true) return value === false
  return (rule.allowed_values === undefined || rule.allowed_values.includes(value))
    && (rule.minimum === undefined || typeof value === 'number' && value >= rule.minimum)
    && (rule.maximum === undefined || typeof value === 'number' && value <= rule.maximum)
}

type Dependencies = Readonly<Record<string, readonly Scalar[]>>
interface NativeField {
  readonly name: string
  readonly target: keyof MediaSpecification
  readonly values: readonly string[]
  readonly when?: Dependencies
  readonly byQuality?: Readonly<Record<string, readonly string[]>>
  readonly options: ReadonlyMap<string, { readonly available: boolean; readonly when?: Dependencies }>
}
function dependencies(raw: unknown, properties: Record<string, unknown>): Dependencies | undefined | null {
  if (raw === undefined) return undefined
  const row = object(raw)
  if (row === undefined || Object.keys(row).length > 64) return null
  for (const [name, values] of Object.entries(row)) {
    const schema = own(properties, name) ? object(properties[name]) : undefined
    if (!fieldName(name) || schema === undefined || !Array.isArray(values) || values.length > 128
      || values.some(value => !hasType(value, schema.type))) return null
  }
  return row as Dependencies
}
function nativeField(
  name: string, target: keyof MediaSpecification, schema: Record<string, unknown>, properties: Record<string, unknown>,
): NativeField | undefined {
  const values = finiteStrings(schema), native = object(schema['x-ycapi-contract']) ?? {}
  if (values === undefined || target === 'seconds' && values.some(value => seconds(value) === undefined)) return undefined
  const when = dependencies(native.available_when, properties)
  if (when === null) return undefined
  const byQuality = native.enum_values_by_quality === undefined ? undefined : object(native.enum_values_by_quality)
  if (native.enum_values_by_quality !== undefined && (byQuality === undefined || Object.keys(byQuality).length > 128
    || Object.values(byQuality).some(value => !Array.isArray(value) || value.length > 128 || !value.every(text)))) return undefined
  const options = new Map<string, { available: boolean; when?: Dependencies }>()
  if (native.options !== undefined && (!Array.isArray(native.options) || native.options.length > 1024)) return undefined
  for (const raw of Array.isArray(native.options) ? native.options : []) {
    const option = object(raw)
    if (option === undefined || typeof option.value !== 'string' || options.has(option.value)
      || option.available !== undefined && typeof option.available !== 'boolean') return undefined
    const dependency = dependencies(option.available_when, properties)
    if (dependency === null) return undefined
    options.set(option.value, { available: option.available !== false, ...dependency === undefined ? {} : { when: dependency } })
  }
  return { name, target, values, options, ...when === undefined ? {} : { when },
    ...byQuality === undefined ? {} : { byQuality: byQuality as Record<string, string[]> } }
}
function available(when: Dependencies | undefined, values: Readonly<Record<string, Scalar>>): boolean {
  return when === undefined || Object.entries(when).every(([name, choices]) => {
    const value = values[name]
    return own(values, name) && value !== undefined && choices.includes(value)
  })
}
function nativeFieldsMatch(
  fields: readonly NativeField[], values: Readonly<Record<string, Scalar>>, disabled: ReadonlySet<string>,
): boolean {
  return fields.every((field) => {
    const active = available(field.when, values), present = own(values, field.name)
    if (!active) return !present
    if (!present) return disabled.has(field.name)
    const value = values[field.name], option = typeof value === 'string' ? field.options.get(value) : undefined
    const quality = values.quality, allowed = typeof quality === 'string' ? field.byQuality?.[quality] : undefined
    return option?.available !== false && available(option?.when, values)
      && (allowed === undefined || typeof value === 'string' && allowed.includes(value))
  })
}

function scalarSpecifications(model: MediaV2Model): readonly MediaSpecification[] | undefined {
  const schema = model.parameters_schema, properties = object(schema.properties)
  if (schema.type !== 'object' || properties === undefined || Object.keys(properties).length > 100
    || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties', 'description', 'title',
      'x-media-assets', 'x-model-kind'].includes(key))
    || schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean'
    || !countOne(properties.count)) return undefined
  const alternatives = combinations(model, properties)
  if (alternatives === null) return undefined
  if (schema['x-model-kind'] !== undefined && schema['x-model-kind'] !== model.kind) return undefined
  const annotation = schema['x-media-assets']
  const annotatedNames = new Set<string>()
  if (annotation !== undefined && (!Array.isArray(annotation) || annotation.length > 30 || annotation.some((value) => {
    const entry = object(value), name = entry?.name
    if (!fieldName(name) || !own(properties, name) || annotatedNames.has(name)) return true
    const field = model.asset_fields.find(item => item.name === name)
    if (field === undefined || entry?.shape !== undefined && entry.shape !== field.native_shape) return true
    annotatedNames.add(name)
    return false
  }))) return undefined
  const required = schema.required ?? []
  if (!Array.isArray(required) || !required.every(value => typeof value === 'string' && own(properties, value))
    || new Set(required).size !== required.length) return undefined
  const aliases: Readonly<Record<string, keyof MediaSpecification>> = {
    mode: 'mode', resolution: 'resolution', quality: 'quality', size: 'size',
    aspect_ratio: model.kind === 'image' ? 'size' : 'ratio', duration: 'seconds',
  }
  const assets = new Set(model.asset_fields.map(field => field.name))
  if (model.asset_fields.some(field => field.min_items > 0)) return undefined
  const fields: NativeField[] = [], seen = new Set<keyof MediaSpecification>()
  for (const [name, raw] of Object.entries(properties)) {
    if (assets.has(name)) { if (required.includes(name)) return undefined; continue }
    if (name === 'prompt' || name === 'negative_prompt' || name === 'count') continue
    if (!own(aliases, name)) { if (required.includes(name)) return undefined; continue }
    const field = object(raw), target = aliases[name]
    if (field === undefined || target === undefined || seen.has(target)) return undefined
    seen.add(target)
    const read = nativeField(name, target, field, properties)
    if (read === undefined) return undefined
    fields.push(read)
  }
  const unique = new Map<string, MediaSpecification>()
  let visits = 0, overflow = false
  for (const combination of alternatives ?? [{ parameters: {}, required: [] }]) {
    const scalarNames = new Set([...fields.map(field => field.name), ...own(properties, 'count') ? ['count'] : []])
    if (combination.required.some(name => !scalarNames.has(name)) || !matches(1, combination.parameters.count)) continue
    const disabled = new Set(fields.filter(field => combination.parameters[field.name]?.disabled === true).map(field => field.name))
    const choices = fields.map(field => disabled.has(field.name) ? required.includes(field.name) ? [] : [undefined]
      : [...field.values.filter(value => matches(value, combination.parameters[field.name])),
        ...field.when === undefined ? [] : [undefined]])
    const visit = (index: number, values: Readonly<Record<string, Scalar>>): void => {
      if (overflow) return
      visits += 1
      if (visits > maximumSpecifications * 128) { overflow = true; return }
      const field = fields[index]
      if (field !== undefined) {
        for (const value of choices[index] ?? []) visit(index + 1, value === undefined ? values : { ...values, [field.name]: value })
        return
      }
      if (!nativeFieldsMatch(fields, values, disabled) || combination.required.some(name => !own(values, name))
        || Object.entries(combination.parameters).some(([name, rule]) => !matches(values[name], rule))) return
      let specification: MediaSpecification = {}
      for (const current of fields) {
        const value = values[current.name]
        if (typeof value === 'string') specification = { ...specification,
          [current.target]: current.target === 'seconds' ? Number(value) : value }
      }
      unique.set(JSON.stringify(specification), specification)
      if (unique.size > maximumSpecifications) overflow = true
    }
    visit(0, own(properties, 'count') ? { count: 1 } : {})
    if (unique.size > maximumSpecifications || visits > maximumSpecifications * 128) return undefined
  }
  return unique.size === 0 ? undefined : [...unique.values()]
}

function strings(specifications: readonly MediaSpecification[], field: Exclude<keyof MediaSpecification, 'seconds'>): string[] {
  return [...new Set(specifications.flatMap(value => value[field] === undefined ? [] : [value[field]]))]
}

function preferenceParams(
  model: MediaV2Model, specifications: readonly MediaSpecification[],
): ImageParams | VideoParams | undefined {
  if (model.kind === 'image') return { specifications, sizes: strings(specifications, 'size'),
    resolutions: strings(specifications, 'resolution'), qualities: strings(specifications, 'quality'),
    maxCount: 1, maxEdits: 0, strictReferences: true, backgrounds: [], formats: [], moderations: [], seed: false }
  const durations = [...new Set(specifications.flatMap(value => value.seconds === undefined ? [] : [value.seconds]))]
    .toSorted((a, b) => a - b)
  const minimum = durations.at(0), maximum = durations.at(-1)
  if (minimum === undefined || maximum === undefined) return undefined
  const properties = object(model.parameters_schema.properties), duration = object(properties?.duration)
  const preferred = seconds(duration?.default), resolutions = strings(specifications, 'resolution')
  return { specifications, durations,
    ...preferred === undefined || !durations.includes(preferred) ? {} : { defaultDuration: preferred },
    minDuration: minimum, maxDuration: maximum, resolutions,
    durationByResolution: Object.fromEntries(resolutions.map(resolution => [resolution,
      [...new Set(specifications.filter(value => value.resolution === resolution)
        .flatMap(value => value.seconds === undefined ? [] : [value.seconds]))].toSorted((a, b) => a - b)])),
    ratios: strings(specifications, 'ratio'), qualities: strings(specifications, 'quality'), modes: strings(specifications, 'mode'),
    strictReferences: true, maxFrameImages: 0, maxReferenceImages: 0, maxReferenceVideos: 0,
    maxReferenceAudios: 0, frameSlots: 0, mixFramesAndReferences: false,
    audio: false, audioOutput: 'unknown', audioToggle: false, watermark: false, seed: false }
}

function defaultScalar(schema: Record<string, unknown>, value: Scalar, parameters: Readonly<Record<string, Scalar>>,
  properties: Record<string, unknown>): boolean {
  if (value !== schema.default || !hasType(value, schema.type) || unsupported.some(key => schema[key] !== undefined)
    || schema.const !== undefined && schema.const !== value
    || schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.includes(value))
    || schema.minimum !== undefined && (typeof schema.minimum !== 'number' || typeof value !== 'number' || value < schema.minimum)
    || schema.maximum !== undefined && (typeof schema.maximum !== 'number' || typeof value !== 'number' || value > schema.maximum)
    || schema.minLength !== undefined && (typeof schema.minLength !== 'number' || typeof value !== 'string' || value.length < schema.minLength)
    || schema.maxLength !== undefined && (typeof schema.maxLength !== 'number' || typeof value !== 'string' || value.length > schema.maxLength)
    || schema.exclusiveMinimum !== undefined || schema.exclusiveMaximum !== undefined || schema.multipleOf !== undefined) return false
  const native = object(schema['x-ycapi-contract'])
  if (schema['x-ycapi-contract'] !== undefined && native === undefined) return false
  const when = dependencies(native?.available_when, properties)
  if (when === null || !available(when, parameters)) return false
  if (native?.options !== undefined) {
    if (!Array.isArray(native.options)) return false
    const options = native.options.filter(raw => object(raw)?.value === value)
    if (options.length > 1) return false
    const option = object(options[0]), optionWhen = dependencies(option?.available_when, properties)
    if (optionWhen === null || option?.available === false || !available(optionWhen, parameters)) return false
  }
  return true
}

function nativePriceSelection(model: MediaV2Model, row: MediaV2SpecificationPriceRow):
{ readonly parameters: Readonly<Record<string, Scalar>>; readonly partial: boolean } | undefined {
  const properties = object(model.parameters_schema.properties)
  if (properties === undefined) return undefined
  const policy = combinations(model, properties)
  if (policy === null || policy !== undefined && !policy.some(combination =>
    combination.required.every(name => own(row.parameters, name))
    && Object.entries(combination.parameters).every(([name, rule]) => matches(row.parameters[name], rule)))) return undefined
  const parameters: Record<string, Scalar> = {}
  let partial = false
  for (const [name, value] of Object.entries(row.parameters)) {
    if (name === 'count') { if (value !== 1 || !countOne(properties.count)) return undefined; parameters[name] = value; continue }
    const field = own(properties, name) ? object(properties[name]) : undefined
    if (field === undefined) return undefined
    if (!['mode', 'resolution', 'quality', 'size', 'aspect_ratio', 'duration'].includes(name)) {
      const required = model.parameters_schema.required
      if (Array.isArray(required) && required.includes(name) || !defaultScalar(field, value, row.parameters, properties)) return undefined
      partial = true
      continue
    }
    if (!finiteStrings(field)?.includes(String(value)) || typeof value !== 'string') return undefined
    parameters[name] = value
  }
  const unitValid = row.billing_unit === 'per_video'
    ? mediaPreferencePoints(row.unit_price_cny, 1) === mediaPreferencePoints(row.total_cny, 1)
    : seconds(row.parameters.duration) === row.quantity
  return unitValid ? { parameters, partial } : undefined
}

/**
 * Project only native controls that personal scalar preferences can represent.
 * @param model - Account-admitted native model; its full schema remains authoritative.
 * @returns A preference-only capability, or absence for an unsupported schema.
 */
export function projectNativeMediaPreferences(model: MediaV2Model): ModelCapability | undefined {
  if (!model.enabled || model.kind !== 'image' && model.kind !== 'video'
    || !model.intents.some(value => value.id === 'text' && !value.requires_assets)) return undefined
  if (model.parameter_conditions !== undefined) {
    const policy = object(model.parameter_conditions)
    if (policy?.schema_version !== 1 || Object.keys(policy).some(key => !['schema_version', 'rules'].includes(key))
      || !Array.isArray(policy.rules) || policy.rules.length > 0) return undefined
  }
  const specifications = scalarSpecifications(model)
  if (specifications === undefined) return undefined
  const params = preferenceParams(model, specifications)
  return params === undefined ? undefined : { id: model.id, displayName: model.display_name, kind: model.kind,
    nativeModelVersion: model.model_version, execution: 'media-v2', route: '', params, groups: [],
    verified: true, source: 'native:media-generation-v2', notes: ['scalar-preferences-only', 'native-schema-required'] }
}

/**
 * Project optional native price references without changing the preference directory.
 * @param models - Account-admitted full native models and their own conversion rates.
 * @param projected - Independently derived scalar preference capabilities.
 * @returns Only this directory's optional indicative prices; quotes remain authoritative.
 */
export function nativeMediaPreferencePrices(
  models: readonly MediaV2Model[], projected: readonly ModelCapability[],
): Map<string, MediaPreferencePricing> {
  const result = new Map<string, MediaPreferencePricing>()
  for (const model of models) {
    const capability = projected.find(value => value.id === model.id && value.kind === model.kind
      && value.execution === 'media-v2' && value.nativeModelVersion === model.model_version)
    if (capability === undefined || model.kind !== 'video') continue
    const pricing = readMediaV2SpecificationPricing(model.pricing)
    if (pricing === undefined || pricing === null || pricing.specification_rows === undefined) continue
    const selections = pricing.specification_rows.map(row => nativePriceSelection(model, row))
    if (selections.some(value => value === undefined)) continue
    const rows = pricing.specification_rows.map((row, index) => ({ params: selections[index]?.parameters, currency: 'CNY',
      retail_cny: row.billing_unit === 'per_video' ? row.total_cny : row.unit_price_cny,
      unit: row.billing_unit === 'per_video' ? 'CNY / video' : 'CNY / second',
      .../^0+(?:\.0+)?$/u.test(row.total_cny) ? { is_free: true } : {} }))
    const price = mediaPreferencePrices([{ model_name: model.id, kind: model.kind, retail_price_rows: rows }],
      [capability], model.pricing.credits_per_yuan).get(model.id)
    if (price !== undefined) result.set(model.id, price.status === 'available' && selections.some(value => value?.partial === true)
      ? { ...price, coverage: 'partial' } : price)
  }
  return result
}
