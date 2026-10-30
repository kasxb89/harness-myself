/**
 * Media capabilities: which image, video, and speech models a deployment serves, and
 * what each one accepts.
 *
 * Two sources are merged, in this order:
 *
 *   1. `/api/pricing` on the configured API — published models, declared groups,
 *      and, for plugin-backed
 *      generators, the parameter menus the plugin itself
 *      declares. This is what makes a channel added on the new-api side appear
 *      here without an edit.
 *   2. `model-parameters.ts` — the market's parameter surface per model id,
 *      collected from the gateway's own plugin sources and the vendors' API
 *      references. It fills in what the pricing row does not say, and it is
 *      what shapes a model the moment it is added.
 *
 * A live declaration always beats the table: if the deployment says a model's
 * resolutions are `768P, 2K`, that is the menu, whatever the table believes.
 * Pricing does not establish account authorization or billing availability;
 * the server validates both when a generation is submitted.
 *
 * @module @deepseek-ai/dsh-credits-index/media
 */

import { imageSpec, videoSpec, type ImageSpec, type VideoSpec } from './model-parameters.ts'

/** Deliverable kinds separated from conversational models. */
export type MediaKind = 'image' | 'video' | 'audio'

/** One complete published combination; no price or upstream routing data is retained. */
export interface MediaSpecification {
  readonly size?: string
  readonly resolution?: string
  readonly seconds?: number
  readonly ratio?: string
  readonly quality?: string
  readonly mode?: string
}

/** The declared speech-generation parameters; absent execution keeps generation unavailable. */
export interface AudioParams {
  readonly voices: readonly string[]
  readonly formats: readonly string[]
  readonly maxCharacters: number
  readonly speedRange?: { readonly minimum: number; readonly maximum: number }
  readonly instructions: boolean
  readonly execution?: {
    readonly protocol: 'openai-speech-v1'
    readonly quoteRoute: '/v1/audio/quote'
    readonly taskRoute: '/v1/tasks'
  }
}

/** What an image model accepts. */
export interface ImageParams {
  /** Complete legal combinations, when the deployment publishes alternatives. Empty disables submission. */
  readonly specifications?: readonly MediaSpecification[]
  /** Output sizes or aspect ratios in the request's own spelling, e.g. `1024x1024` or `16:9`. */
  readonly sizes: readonly string[]
  /** Named resolution tiers; absent for image routes without this field. */
  readonly resolutions?: readonly string[]
  /** Largest `n` one request may ask for. */
  readonly maxCount: number
  /** Largest number of reference images an edit may carry; 0 disables edits. */
  readonly maxEdits: number
  /** True when a live reference-input limit was declared, including a zero limit. */
  readonly strictReferences?: boolean
  /** Optional quality values; empty means the model has no such knob. */
  readonly qualities: readonly string[]
  /** Background modes the model accepts; empty means the field is not offered. */
  readonly backgrounds: readonly string[]
  /** Output container formats, e.g. `png`, `jpeg`, `webp`. */
  readonly formats: readonly string[]
  /** Moderation levels, when the model exposes them. */
  readonly moderations: readonly string[]
  /** The route reads a seed. */
  readonly seed: boolean
}

/** What a video model accepts. */
export interface VideoParams {
  /** True when live frame or reference-input limits were declared, including zero limits. */
  readonly strictReferences?: boolean
  /** Complete legal combinations, when the deployment publishes alternatives. Empty disables submission. */
  readonly specifications?: readonly MediaSpecification[]
  /** Quality values are independent from the legacy vendor mode. */
  readonly qualities?: readonly string[]
  /** Duration values the model allows, in seconds. */
  readonly durations: readonly number[]
  /** Preferred initial value, present only while allowed by the live menu. */
  readonly defaultDuration?: number
  /** Resolution-specific duration menus; an absent key is unavailable. */
  readonly durationByResolution?: Readonly<Record<string, readonly number[]>>
  readonly minDuration: number
  readonly maxDuration: number
  /** Output resolutions, e.g. `768P`, `2K`. */
  readonly resolutions: readonly string[]
  /** Aspect ratios; `adaptive` means "inherit from the reference media". */
  readonly ratios: readonly string[]
  /** Allowed frame-input ratios intersected with the live menu; an empty list blocks frame input. */
  readonly frameRatios?: readonly string[]
  /** First/last frame images, which pin the shot's ends. */
  readonly maxFrameImages: number
  /** Multimodal reference images, a style/subject hint rather than a frame. */
  readonly maxReferenceImages: number
  readonly maxReferenceVideos: number
  readonly maxReferenceAudios: number
  /** Frame slots the model names, so first and last can be separate controls. */
  readonly frameSlots: number
  /** Legacy audio declaration, used when audioOutput is absent. */
  readonly audio: boolean
  /** Output audio support, independent from an optional generation switch. */
  readonly audioOutput?: 'unknown' | 'supported' | 'unsupported'
  /** The model reads a `generate_audio` switch. */
  readonly audioToggle: boolean
  /** The model accepts a burned-in watermark switch. */
  readonly watermark: boolean
  /** Quality tiers the vendor validates, e.g. `std` / `pro`. */
  readonly modes: readonly string[]
  /** The route reads a seed. */
  readonly seed: boolean
  /**
   * False when frame images and reference media may not travel together, which
   * is a submission the panel must prevent rather than discover upstream.
   */
  readonly mixFramesAndReferences: boolean
}

/** One model and its published parameters, as the panels need them. */
export interface ModelCapability {
  readonly id: string
  readonly kind: MediaKind
  readonly displayName: string
  /** Groups allowed to call it; empty means the deployment did not say. */
  readonly groups: readonly string[]
  /**
   * The path a generation request goes to. The OpenAI shapes live at
   * `/v1/images/generations` and `/v1/videos`; MiniMax-H3 uses
   * `/v1/video/generations`. A model served by a task plugin
   * on the gateway answers on that plugin's own path instead (for example
   * `/toapis/v1/images/generations`), which is also the path used to read the
   * task back at `<route>/<task_id>`.
   */
  readonly route: string
  readonly params: ImageParams | VideoParams | AudioParams
  /** True when the parameter surface came from a plugin or a vendor reference. */
  readonly verified: boolean
  /** Where the surface came from, e.g. `plugin:hailuo`, `docs:openai`. */
  readonly source: string
  /** Which parts the live deployment supplied, for the panel's footnote. */
  readonly notes: readonly string[]
}

/** Read a string array field, or an empty list. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
}

/** Read a nested object field, or null. */
function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** The `enum` menu of one usage-schema field, when the plugin declares one. */
function schemaEnum(schema: unknown, field: string): string[] {
  return stringList(objectRecord(objectRecord(schema)?.[field])?.enum)
}

/** The parameter fields a deployment declares, or an empty list. */
function schemaFields(schema: unknown): string[] {
  return Object.keys(objectRecord(schema) ?? {})
}

/** Explicit parameters may be JSON Schema properties or the pricing field map. */
function parameterFields(schema: unknown): Record<string, unknown> | null {
  const record = objectRecord(schema)
  return objectRecord(record?.properties) ?? record
}

/** Only finite, whole-second menus bounded by the gateway's safety ceiling are capabilities. */
function durationMenu(value: unknown): number[] | null {
  const field = objectRecord(value)
  if (field === null) return null
  const constraints = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'] as const
  for (const key of constraints) {
    const constraint = field[key]
    if (constraint !== undefined && (typeof constraint !== 'number' || !Number.isFinite(constraint))) return null
  }
  const minimum = typeof field.minimum === 'number' ? field.minimum : -Infinity
  const maximum = typeof field.maximum === 'number' ? field.maximum : Infinity
  const exclusiveMinimum = typeof field.exclusiveMinimum === 'number' ? field.exclusiveMinimum : -Infinity
  const exclusiveMaximum = typeof field.exclusiveMaximum === 'number' ? field.exclusiveMaximum : Infinity
  const multiple = typeof field.multipleOf === 'number' ? field.multipleOf : 1
  if (multiple <= 0) return null
  if (field.enum !== undefined && !Array.isArray(field.enum)) return null
  let menu: number[]
  if (typeof field.const === 'number' && field.enum === undefined) return durationMenu({ ...field, const: undefined, enum: [field.const] })
  if (Array.isArray(field.enum)) {
    if (field.enum.length === 0 || field.enum.length > 3600
      || field.enum.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1 || item > 3600)) return null
    menu = [...new Set(field.enum as number[])].sort((left, right) => left - right)
  } else {
    const lower = Math.max(minimum, exclusiveMinimum)
    const upper = Math.min(maximum, exclusiveMaximum)
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 1 || upper > 3600) return null
    const first = Math.max(Math.ceil(minimum), Math.floor(exclusiveMinimum) + 1)
    const last = Math.min(Math.floor(maximum), Math.ceil(exclusiveMaximum) - 1)
    menu = range(first, last)
  }
  return menu.filter((seconds) => {
    if (field.const !== undefined && field.const !== seconds) return false
    const quotient = seconds / multiple
    return seconds >= minimum && seconds <= maximum && seconds > exclusiveMinimum && seconds < exclusiveMaximum
      && Number.isFinite(quotient) && Math.abs(quotient - Math.round(quotient)) <= Number.EPSILON * Math.abs(quotient) * 4
  })
}

/** Read the canonical seconds field or its duration alias without inferring examples. */
function declaredDurations(schema: unknown): number[] | null {
  const fields = parameterFields(schema)
  return durationMenu(fields?.seconds) ?? durationMenu(fields?.duration)
}

/** A partial parent constraint can restrict a known finite menu without granting new seconds. */
function restrictDurations(menu: readonly number[], schema: unknown): readonly number[] {
  const fields = parameterFields(schema)
  const constraint = objectRecord(fields?.seconds) ?? objectRecord(fields?.duration)
  if (constraint === null || menu.length === 0) return menu
  const allowed = durationMenu({ ...constraint, enum: constraint.enum ?? menu })
  return allowed === null ? menu : menu.filter(value => allowed.includes(value))
}

/** String const and enum constrain one another when both are declared. */
function declaredStringMenu(schema: unknown, name: string): string[] | null {
  const field = objectRecord(parameterFields(schema)?.[name])
  if (field === null) return null
  if (field.const !== undefined && (typeof field.const !== 'string' || field.const === ''
    || field.const.length > 64 || field.const.trim() !== field.const)) return null
  const constant = typeof field.const === 'string' && field.const !== '' ? field.const : null
  if (field.enum !== undefined) {
    if (!Array.isArray(field.enum) || field.enum.length > 64
      || field.enum.some(value => typeof value !== 'string' || value === '' || value.length > 64 || value.trim() !== value)) return null
    const menu = [...new Set(stringList(field.enum))]
    return constant === null ? menu : menu.filter(value => value === constant)
  }
  return constant === null ? null : [constant]
}

/** A declared upper bound can remove an inherited capability, including with zero. */
function declaredLimit(schema: unknown, names: readonly string[], collection: boolean): number | null {
  const fields = parameterFields(schema)
  for (const name of names) {
    if (fields === null || !Object.hasOwn(fields, name)) continue
    const value = fields[name]
    if (value === false) return 0
    const field = objectRecord(value)
    if (field === null) return 0
    const upper = field[collection ? 'maxItems' : 'maximum']
    const menu = field.enum
    if (menu !== undefined && !Array.isArray(menu)) return 0
    if (field.const !== undefined && (typeof field.const !== 'number' || !Number.isSafeInteger(field.const) || field.const < 0 || field.const > 128)) return 0
    if (Array.isArray(menu)) {
      const values: unknown[] = menu
      if (!values.every((item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= 128)) return 0
      const largest = Math.max(0, ...values)
      return typeof upper === 'number' && Number.isSafeInteger(upper) && upper >= 0 && upper <= 128 ? Math.min(largest, upper) : largest
    }
    if (typeof field.const === 'number' && Number.isSafeInteger(field.const) && field.const >= 0 && field.const <= 128) {
      return typeof upper === 'number' && Number.isSafeInteger(upper) && upper >= 0 && upper <= 128 ? Math.min(field.const, upper) : field.const
    }
    if (typeof upper === 'number' && Number.isSafeInteger(upper) && upper >= 0 && upper <= 128) return upper
    if (upper !== undefined || field.const !== undefined) return 0
  }
  return null
}

/** A present false schema, false const, or empty enum removes the corresponding control. */
function declaredSwitch(schema: unknown, names: readonly string[]): boolean | null {
  const fields = parameterFields(schema)
  for (const name of names) {
    if (fields === null || !Object.hasOwn(fields, name)) continue
    const value = fields[name]
    if (typeof value === 'boolean') return value
    const field = objectRecord(value)
    if (field === null) return false
    if (field.const === false || Array.isArray(field.enum) && (field.enum.length === 0 || !field.enum.includes(true) && (field.type === 'boolean' || field.enum.every(value => typeof value === 'boolean')))) return false
    return true
  }
  return null
}

/** Explicit, unusable menus must not restore a family-specific default. */
function liveStringMenu(schema: unknown, names: readonly string[]): string[] | null {
  const fields = parameterFields(schema)
  for (const name of names) {
    if (fields !== null && Object.hasOwn(fields, name)) return declaredStringMenu(schema, name) ?? []
  }
  return null
}

const SPECIFICATION_FIELDS = ['size', 'resolution', 'seconds', 'ratio', 'quality', 'mode'] as const

type SpecificationField = typeof SPECIFICATION_FIELDS[number]

/** Read one branch value and its parent restrictions without broadening either. */
function specificationMenu(schema: unknown, parent: unknown, name: SpecificationField): readonly (string | number)[] | null | false {
  const aliases = name === 'seconds' ? ['seconds', 'duration'] : name === 'ratio' ? ['ratio', 'aspect_ratio'] : [name]
  const branchFields = parameterFields(schema)
  const parentFields = parameterFields(parent)
  const branchName = aliases.find(alias => branchFields !== null && Object.hasOwn(branchFields, alias))
  const parentName = aliases.find(alias => parentFields !== null && Object.hasOwn(parentFields, alias))
  if (branchName === undefined && parentName === undefined) return null
  if (name === 'seconds') {
    const declared = branchName === undefined ? durationMenu(parentFields?.[parentName ?? '']) : durationMenu(branchFields?.[branchName])
    if (declared === null) return false
    if (parentName === undefined || branchName === undefined) return declared
    const allowed = durationMenu({ ...objectRecord(parentFields?.[parentName]), enum: declared })
    return allowed ?? false
  }
  const branch = branchName === undefined ? null : declaredStringMenu(schema, branchName)
  const parentField = parentName === undefined ? null : objectRecord(parentFields?.[parentName])
  const parentConstrained = parentName !== undefined && (parentField === null || Object.hasOwn(parentField, 'enum') || Object.hasOwn(parentField, 'const'))
  const global = parentConstrained ? declaredStringMenu(parent, parentName) : null
  if (branchName !== undefined && branch === null || parentConstrained && global === null) return false
  if (branch === null && global === null) return false
  return branch === null ? global : global === null ? branch : branch.filter(value => global.includes(value))
}

/** Bounded alternatives preserve quality/resolution/duration relationships instead of flattening them. */
function declaredSpecifications(schema: unknown, kind: 'image' | 'video'): readonly MediaSpecification[] | undefined {
  const record = objectRecord(schema)
  if (record === null || !Object.hasOwn(record, 'oneOf')) return undefined
  const branches = record.oneOf
  const complete = kind === 'image' || Array.isArray(branches) && branches.some((branch) => {
    const fields = parameterFields(branch)
    return ['size', 'quality', 'mode', 'ratio', 'aspect_ratio'].some(name => fields !== null && Object.hasOwn(fields, name))
  }) || ['size', 'quality', 'mode', 'ratio', 'aspect_ratio'].some(name => Object.hasOwn(parameterFields(schema) ?? {}, name))
  // Legacy resolution/duration alternatives retain their existing parser and partial-declaration behavior.
  if (!complete) return undefined
  if (!Array.isArray(branches) || branches.length === 0 || branches.length > 128) return []
  const dimensions = SPECIFICATION_FIELDS.filter((name) => {
    const aliases = name === 'seconds' ? ['seconds', 'duration'] : name === 'ratio' ? ['ratio', 'aspect_ratio'] : [name]
    if (branches.some(branch => aliases.some(alias => Object.hasOwn(parameterFields(branch) ?? {}, alias)))) return true
    const parent = parameterFields(schema)
    const declared = aliases.find(alias => parent !== null && Object.hasOwn(parent, alias))
    if (declared === undefined) return false
    const field = parent?.[declared]
    const values = objectRecord(field)?.enum
    const disabled = field === false || Array.isArray(values) && values.length === 0
    return !disabled || stringList(record.required).includes(declared)
  })
  if (dimensions.length === 0) return []
  const matches = new Map<string, { specification: MediaSpecification; count: number }>()
  for (const branch of branches) {
    let combinations: Record<string, string | number>[] = [{}]
    for (const name of dimensions) {
      const menu = specificationMenu(branch, schema, name)
      if (menu === null || menu === false || combinations.length * menu.length > 128) return []
      combinations = combinations.flatMap(previous => menu.map(value => ({ ...previous, [name]: value })))
    }
    if (matches.size + combinations.length > 128) return []
    for (const combination of combinations) {
      let specification: MediaSpecification = {
        ...typeof combination.size === 'string' ? { size: combination.size } : {},
        ...typeof combination.resolution === 'string' ? { resolution: combination.resolution } : {},
        ...typeof combination.seconds === 'number' ? { seconds: combination.seconds } : {},
        ...typeof combination.ratio === 'string' ? { ratio: combination.ratio } : {},
        ...typeof combination.quality === 'string' ? { quality: combination.quality } : {},
        ...typeof combination.mode === 'string' ? { mode: combination.mode } : {},
      }
      if (kind === 'video' && specification.seconds === undefined) return []
      if (kind === 'image') {
        if (specification.mode !== undefined || specification.seconds !== undefined
          || specification.size !== undefined && specification.ratio !== undefined && specification.size !== specification.ratio) return []
        const { ratio, ...image } = specification
        specification = ratio === undefined ? image : { ...image, size: image.size ?? ratio }
      }
      const key = JSON.stringify(specification)
      const prior = matches.get(key)
      matches.set(key, { specification, count: (prior?.count ?? 0) + 1 })
    }
  }
  return [...matches.values()].filter(value => value.count === 1).map(value => value.specification)
}

/** Distinct string values in a complete published specification menu. */
function specificationStrings(specifications: readonly MediaSpecification[], field: Exclude<SpecificationField, 'seconds'>): string[] {
  return [...new Set(specifications.flatMap((specification) => {
    const value = specification[field]
    return value === undefined ? [] : [value]
  }))]
}

/** Sorted, distinct native duration values in a complete specification menu. */
function specificationSeconds(specifications: readonly MediaSpecification[]): number[] {
  return [...new Set(specifications.flatMap(value => value.seconds === undefined ? [] : [value.seconds]))]
    .sort((left, right) => left - right)
}

/** Standard oneOf branches pair explicit resolutions with bounded duration menus. */
function resolutionDurations(schema: unknown): Record<string, readonly number[]> | null {
  const branches = objectRecord(schema)?.oneOf
  if (!Array.isArray(branches) || branches.length === 0 || branches.length > 64) return null
  const menus = new Map<string, Map<number, number>>()
  for (const branch of branches) {
    const resolutions = declaredStringMenu(branch, 'resolution')
    const durations = declaredDurations(branch)
    if (resolutions === null || durations === null) return null
    for (const value of resolutions) {
      const menu = menus.get(value) ?? new Map<number, number>()
      for (const duration of durations) menu.set(duration, (menu.get(duration) ?? 0) + 1)
      menus.set(value, menu)
      if (menus.size > 64) return null
    }
  }
  return Object.fromEntries([...menus].map(([resolution, values]) => [resolution, [...values]
    .filter(([, matches]) => matches === 1).map(([duration]) => duration).sort((left, right) => left - right)]))
}

/**
 * Select the allowed seconds for an explicit output resolution.
 * @param params - Parsed model capability.
 * @param resolution - Requested resolution, or null when not selected.
 * @returns The resolution menu, or no values when a declared combination is unavailable.
 */
export function videoDurations(params: VideoParams, resolution: string | null): readonly number[] {
  if (params.durationByResolution === undefined) return params.durations
  return resolution === null || !Object.hasOwn(params.durationByResolution, resolution) ? [] : params.durationByResolution[resolution] ?? []
}

/** The largest number seen for one key across the deployment's examples. */
function maxExampleValue(examples: readonly unknown[], key: string): number | null {
  let largest: number | null = null
  for (const example of examples) {
    const facts = objectRecord(objectRecord(example)?.facts)
    const value = facts?.[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (largest === null || value > largest) largest = value
  }
  return largest
}

/** Every integer in a closed range. */
function range(from: number, to: number): number[] {
  const values: number[] = []
  for (let value = from; value <= to; value += 1) values.push(value)
  return values
}

/** A plugin or a vendor reference is a description; a family rule is a guess. */
function isVerified(source: string): boolean {
  return source.startsWith('plugin:') || source.startsWith('docs:')
}

/** The image menu: the table's surface, with the deployment's own enum on top. */
function imageParams(spec: ImageSpec, schema: unknown, parameters: unknown, examples: readonly unknown[]): {
  params: ImageParams
  verified: boolean
  source: string
  notes: string[]
} {
  const specifications = declaredSpecifications(parameters, 'image')
  const explicitSizes = liveStringMenu(parameters, ['size'])
  const declared = explicitSizes ?? schemaEnum(schema, 'size').concat(schemaEnum(schema, 'sizes'))
  const notes: string[] = []
  let source = spec.source
  let sizes = spec.sizes
  if (explicitSizes !== null || declared.length > 0) {
    sizes = declared
    notes.push('sizes')
    source = spec.source === 'fallback' ? 'newapi' : spec.source
  }
  // Input-image billing tells us an edit route exists even before the table does.
  const billedEdits = maxExampleValue(examples, 'input_images')
  const maxEdits = declaredLimit(parameters, ['reference_images', 'images', 'input_images'], true)
    ?? (spec.maxEdits > 0 || billedEdits === null ? spec.maxEdits : billedEdits)
  const explicitResolutions = liveStringMenu(parameters, ['resolution'])
  const resolutions = explicitResolutions ?? schemaEnum(schema, 'resolution')
  const outputResolutions = explicitResolutions !== null || resolutions.length > 0 ? resolutions : spec.resolutions
  const qualities = liveStringMenu(parameters, ['quality'])
  const backgrounds = liveStringMenu(parameters, ['background'])
  const formats = liveStringMenu(parameters, ['output_format', 'format'])
  const moderations = liveStringMenu(parameters, ['moderation'])
  const seed = declaredSwitch(parameters, ['seed'])
  for (const [field, menu] of Object.entries({ qualities, backgrounds, formats, moderations })) {
    if (menu !== null) notes.push(field)
  }
  if (seed !== null) notes.push('seed')
  if (specifications !== undefined) {
    notes.push('specifications')
    if (qualities === null && specifications.some(value => value.quality !== undefined)) notes.push('qualities')
  }
  return {
    params: {
      sizes: specifications === undefined ? sizes : specificationStrings(specifications, 'size'),
      ...specifications === undefined ? {} : { specifications },
      ...outputResolutions === undefined && specifications === undefined ? {} : {
        resolutions: specifications === undefined ? outputResolutions : specificationStrings(specifications, 'resolution'),
      },
      maxCount: declaredLimit(parameters, ['n', 'count'], false) ?? spec.maxCount,
      maxEdits,
      ...['reference_images', 'images', 'input_images'].some(name => Object.hasOwn(parameterFields(parameters) ?? {}, name)) ? { strictReferences: true } : {},
      qualities: qualities ?? (specifications === undefined ? spec.qualities : specificationStrings(specifications, 'quality')),
      backgrounds: backgrounds ?? spec.backgrounds,
      formats: formats ?? spec.formats,
      moderations: moderations ?? spec.moderations,
      seed: seed ?? spec.seed,
    },
    verified: isVerified(spec.source),
    source,
    notes,
  }
}

/** Explicit live parameter declarations take precedence over the model table. */
function videoParams(spec: VideoSpec, schema: unknown, parameters: unknown): {
  params: VideoParams
  verified: boolean
  source: string
  notes: string[]
} {
  const notes: string[] = []
  const specifications = declaredSpecifications(parameters, 'video')
  if (specifications !== undefined) notes.push('specifications')
  const parameterResolutions = liveStringMenu(parameters, ['resolution'])
  const parameterDurations = declaredDurations(parameters)
  const parameterCombinations = resolutionDurations(parameters)
  const hasParameterDurations = parameterDurations !== null || parameterCombinations !== null
  const declaredResolutions = parameterResolutions
    ?? (parameterCombinations === null ? declaredStringMenu(schema, 'resolution') : Object.keys(parameterCombinations))
  const declaredRatios = liveStringMenu(parameters, ['ratio', 'aspect_ratio'])
    ?? declaredStringMenu(schema, 'ratio') ?? declaredStringMenu(schema, 'aspect_ratio')
  let ratios = declaredRatios ?? spec.ratios
  let resolutions = declaredResolutions ?? spec.resolutions
  if (declaredResolutions !== null) notes.push('resolutions')
  const declared = hasParameterDurations ? parameterDurations : declaredDurations(schema)
  const combinations = hasParameterDurations ? parameterCombinations : resolutionDurations(schema)
  const parameterDurationFields = parameterFields(parameters)
  const constraints = hasParameterDurations || objectRecord(parameterDurationFields?.seconds) !== null
    || objectRecord(parameterDurationFields?.duration) !== null ? parameters : schema
  let durationByResolution: Record<string, readonly number[]> | undefined
  let durations: readonly number[] = restrictDurations(declared ?? spec.durations, constraints)
  if (declared !== null) notes.push('durations')
  if (combinations !== null) {
    const menus = Object.fromEntries(Object.entries(combinations)
      .filter(([resolution]) => declaredResolutions === null || declaredResolutions.includes(resolution))
      .map(([resolution, menu]) => {
        const bounded = declared === null ? menu : menu.filter(value => declared.includes(value))
        return [resolution, restrictDurations(bounded, constraints)]
      }))
    durationByResolution = menus
    resolutions = Object.keys(menus).filter(resolution => (menus[resolution]?.length ?? 0) > 0)
    durations = [...new Set(Object.values(menus).flat())].sort((left, right) => left - right)
    notes.push('durationByResolution')
  }
  if (declaredResolutions?.length === 0) durations = []
  if (specifications !== undefined) {
    resolutions = specificationStrings(specifications, 'resolution')
    durations = specificationSeconds(specifications)
    const explicitRatios = specificationStrings(specifications, 'ratio')
    if (explicitRatios.length > 0 || specifications.length === 0) ratios = explicitRatios
    durationByResolution = resolutions.length === 0 ? undefined : Object.fromEntries(resolutions.map(resolution => [
      resolution, specificationSeconds(specifications.filter(value => value.resolution === resolution)),
    ]))
  }
  const frames = declaredLimit(parameters, ['frame_images'], true) ?? spec.frames
  const referenceImages = declaredLimit(parameters, ['reference_images', 'images', 'input_images'], true) ?? spec.referenceImages
  const referenceVideos = declaredLimit(parameters, ['reference_videos'], true) ?? spec.referenceVideos
  const referenceAudios = declaredLimit(parameters, ['reference_audios'], true) ?? spec.referenceAudios
  const audio = declaredSwitch(parameters, ['audio', 'audio_output']) ?? spec.audio
  const params: VideoParams = {
    ...specifications === undefined ? {} : { specifications },
    ...['frame_images', 'reference_images', 'images', 'input_images', 'reference_videos', 'reference_audios'].some(name => Object.hasOwn(parameterFields(parameters) ?? {}, name)) ? { strictReferences: true } : {},
    ...liveStringMenu(parameters, ['quality']) === null && specifications === undefined ? {} : {
      qualities: liveStringMenu(parameters, ['quality']) ?? [...new Set(specifications?.flatMap(value => value.quality === undefined ? [] : [value.quality]) ?? [])],
    },
    durations,
    ...spec.defaultDuration !== undefined && durations.includes(spec.defaultDuration) ? { defaultDuration: spec.defaultDuration } : {},
    ...durationByResolution === undefined ? {} : { durationByResolution },
    minDuration: durations[0] ?? 0,
    maxDuration: durations[durations.length - 1] ?? 0,
    resolutions,
    ratios,
    ...spec.frameRatios === undefined ? {} : { frameRatios: spec.frameRatios.filter(value => ratios.includes(value)) },
    maxFrameImages: frames,
    maxReferenceImages: referenceImages,
    maxReferenceVideos: referenceVideos,
    maxReferenceAudios: referenceAudios,
    frameSlots: frames,
    audio,
    ...declaredSwitch(parameters, ['audio', 'audio_output']) === null
      ? spec.audioOutput === undefined ? {} : { audioOutput: spec.audioOutput }
      : { audioOutput: audio ? 'supported' : 'unsupported' },
    audioToggle: declaredSwitch(parameters, ['generate_audio']) ?? spec.audioToggle,
    watermark: declaredSwitch(parameters, ['watermark']) ?? false,
    modes: liveStringMenu(parameters, ['mode']) ?? (specifications === undefined ? spec.modes : specificationStrings(specifications, 'mode')),
    seed: declaredSwitch(parameters, ['seed']) ?? spec.seed,
    mixFramesAndReferences: declaredSwitch(parameters, ['mix_frames_and_references']) ?? (frames === 0 || referenceImages + referenceVideos + referenceAudios === 0
      ? true
      : spec.source !== 'plugin:hailuo' && spec.source !== 'plugin:doubao'),
  }
  return { params, verified: isVerified(spec.source), source: spec.source, notes }
}

/**
 * Read explicit public model classification before applying legacy name heuristics.
 * @param value - Untrusted public model or pricing record.
 * @returns Declared kind, undefined when absent, or null for an invalid/conflicting declaration.
 */
export function declaredModelKind(value: unknown): 'chat' | MediaKind | null | undefined {
  const record = objectRecord(value)
  if (record === null) return undefined
  let result: 'chat' | MediaKind | undefined
  for (const field of ['kind', 'modality']) {
    if (!Object.hasOwn(record, field)) continue
    const candidate = record[field] === 'text' ? 'chat' : record[field]
    if (candidate !== 'chat' && candidate !== 'image' && candidate !== 'video' && candidate !== 'audio') return null
    if (result !== undefined && candidate !== result) return null
    result = candidate
  }
  if (result !== undefined) return result
  const endpoints = stringList(record.supported_endpoint_types)
  const kinds = new Set<'chat' | MediaKind>()
  for (const endpoint of endpoints) {
    if (/video/i.test(endpoint)) kinds.add('video')
    else if (/image/i.test(endpoint)) kinds.add('image')
    else if (/audio|speech|tts/i.test(endpoint)) kinds.add('audio')
    else if (['chat', 'text', 'openai-chat', 'chat-completions'].includes(endpoint)) kinds.add('chat')
  }
  return kinds.size > 1 ? null : [...kinds][0]
}

/** Speech has no family-derived voices, output formats, or execution permission. */
function audioParams(parameters: unknown): { params: AudioParams; verified: boolean; source: string; notes: string[] } {
  const fields = parameterFields(parameters)
  const input = objectRecord(fields?.input) ?? objectRecord(fields?.text)
  const maximum = input?.maxLength
  const maxCharacters = typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 100_000 ? maximum : 0
  const speed = objectRecord(fields?.speed)
  const minimum = speed?.minimum
  const upper = speed?.maximum
  const speedRange = typeof minimum === 'number' && typeof upper === 'number' && Number.isFinite(minimum) && Number.isFinite(upper)
    && minimum > 0 && upper >= minimum && upper <= 10 ? { minimum, maximum: upper } : undefined
  const execution = objectRecord(objectRecord(parameters)?.x_client_audio_execution)
  const permitted = execution?.protocol === 'openai-speech-v1' && execution.quoteRoute === '/v1/audio/quote' && execution.taskRoute === '/v1/tasks'
    && Object.keys(execution).length === 3
  return {
    params: {
      voices: liveStringMenu(parameters, ['voice']) ?? [],
      formats: liveStringMenu(parameters, ['response_format', 'format']) ?? [],
      maxCharacters,
      ...speedRange === undefined ? {} : { speedRange },
      instructions: declaredSwitch(parameters, ['instructions']) ?? false,
      ...permitted ? { execution: { protocol: 'openai-speech-v1', quoteRoute: '/v1/audio/quote', taskRoute: '/v1/tasks' } } : {},
    },
    verified: permitted,
    source: 'newapi',
    notes: ['audio'],
  }
}

/**
 * Which kind a model serves, or null when it is not a media generator.
 *
 * `/api/pricing` cannot be read on one field: a plugin-backed video model
 * reports `openai` (the protocol it speaks), not `openai-video`, so trusting
 * the endpoint list alone silently drops it from the panel. The signals are
 * weighted instead — what the deployment says, what it bills on, what the table
 * knows, and what the model is called — and a chat model, which matches none of
 * them, stays out.
 */
function mediaKind(id: string, endpoints: readonly string[], fields: readonly string[], record: unknown): MediaKind | null {
  const declared = declaredModelKind(record)
  if (declared !== undefined) return declared === 'chat' ? null : declared
  if (/(?:^|[-_])tts(?:$|[-_])|(?:^|[-_])speech(?:$|[-_])/i.test(id)) return 'audio'
  let video = 0
  let image = 0
  if (endpoints.some(endpoint => endpoint.includes('video'))) video += 4
  if (endpoints.some(endpoint => endpoint === 'image' || endpoint === 'image-generation')) image += 4
  if (fields.some(field => field === 'seconds' || field === 'resolution' || field === 'input_video_seconds')) video += 3
  if (fields.includes('image_count')) image += 1
  if (videoSpec(id).source !== 'fallback') video += 4
  if (imageSpec(id).source !== 'fallback') image += 4
  if (/video|hailuo|kling|jimeng|sora|veo|vidu|wan[0-9.]*[-_]|minimax[-_]?h[0-9]|minimax.*(?:t2v|i2v|video)/i.test(id)
    || /runway|luma|pika|seedance|pixverse|ltx|mochi|cogvideo/i.test(id)) {
    video += 2
  }
  if (/image|dall-?e|flux|seedream|banana|imagen|kolors|cogview|ideogram|recraft|^sd|sdxl/i.test(id)) image += 2
  if (video === 0 && image === 0) return null
  if (video === image) return endpoints.some(endpoint => endpoint.includes('video')) ? 'video' : 'image'
  return video > image ? 'video' : 'image'
}

/**
 * Build the media catalog from `/api/pricing`.
 *
 * `userGroup` filters declared groups; authorization and billing availability
 * are still validated on submission. A null group is
 * "not signed in", and then nothing is filtered out — the panel shows what the
 * deployment serves and lets the login form explain the rest.
 * @param rows - Untrusted pricing rows returned by the gateway.
 * @param userGroup - Signed-in billing group, or null before login.
 * @returns Recognized media models and their supported generation parameters.
 */
export function catalogFromPricing(rows: readonly unknown[], userGroup: string | null): ModelCapability[] {
  const catalog: ModelCapability[] = []
  for (const row of rows) {
    const record = objectRecord(row)
    const id = typeof record?.model_name === 'string' ? record.model_name : null
    if (record === null || id === null) continue
    const endpoints = stringList(record.supported_endpoint_types)
    const fields = schemaFields(record.billing_usage_schema)
    const kind = mediaKind(id, endpoints, fields, record)
    if (kind === null) continue
    const groups = stringList(record.enable_groups)
    if (userGroup !== null && groups.length > 0 && !groups.includes(userGroup)) continue
    const examples = Array.isArray(record.billing_usage_examples) ? record.billing_usage_examples : []
    const built = kind === 'audio' ? audioParams(record.parameters) : kind === 'video'
      ? videoParams(videoSpec(id), record.billing_usage_schema, record.parameters)
      : imageParams(imageSpec(id), record.billing_usage_schema, record.parameters, examples)
    // A row that names its own route wins; otherwise the built-in table for
    // plugin-served models, and the host protocol path for everything else.
    const declaredRoute = typeof record.route === 'string' && record.route.startsWith('/') ? record.route : null
    const route = declaredRoute
      ?? (kind === 'image' ? IMAGE_ROUTES[id] : undefined)
      ?? (kind === 'video' && id === 'MiniMax-H3' ? '/v1/video/generations' : undefined)
      ?? (kind === 'image' ? '/v1/images/generations' : kind === 'video' ? '/v1/videos' : '/v1/audio/speech')
    catalog.push({
      id,
      kind,
      displayName: typeof record.display_name === 'string' && record.display_name.trim() !== ''
        ? record.display_name : id,
      groups,
      route,
      params: built.params,
      verified: built.verified,
      source: built.source,
      notes: built.notes,
    })
  }
  return catalog
}

/**
 * Plugin-native generation paths, taken from the plugins the gateway runs.
 * new-api does not publish a model's route on `/api/pricing` yet; when a row
 * carries its own `route`, that value wins over this table.
 */
const IMAGE_ROUTES: Record<string, string> = {
  // toapis-image 1.1.0: submit and read-back both live under this prefix.
  'yunshu-internal-gpt-image-2': '/toapis/v1/images/generations',
}

/**
 * Every model of one kind in a catalog.
 * @param catalog - Parsed media capabilities.
 * @param kind - Requested media generation kind.
 * @returns Matching models in their original order.
 */
export function modelsOfKind(catalog: readonly ModelCapability[], kind: MediaKind): ModelCapability[] {
  return catalog.filter(model => model.kind === kind)
}

/**
 * The ids that are media generators rather than chat models.
 *
 * The chat picker lists what the deployment serves, and new-api answers
 * `/v1/models` with everything — an image model carries `openai` in its
 * endpoint types too, so the endpoint list alone cannot tell them apart. This
 * is the same classifier the media panels use, exposed so a caller can subtract
 * the generators from a model list.
 * @param rows - Untrusted pricing rows returned by the gateway.
 * @returns Recognized media generator ids in pricing order.
 */
export function mediaModelIds(rows: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const row of rows) {
    const record = objectRecord(row)
    const id = typeof record?.model_name === 'string' ? record.model_name : null
    if (record === null || id === null) continue
    const endpoints = stringList(record.supported_endpoint_types)
    if (mediaKind(id, endpoints, schemaFields(record.billing_usage_schema), record) !== null) ids.push(id)
  }
  return ids
}

/**
 * The model a request names, or the first of its kind when it names none.
 * @param catalog - Parsed media capabilities.
 * @param kind - Required generation kind.
 * @param id - Explicit model id, or null to select the first matching model.
 * @returns The matching model, or null when no candidate exists.
 */
export function pickModel(catalog: readonly ModelCapability[], kind: MediaKind, id: string | null): ModelCapability | null {
  const candidates = modelsOfKind(catalog, kind)
  if (id === null) return candidates[0] ?? null
  return candidates.find(model => model.id === id) ?? null
}
