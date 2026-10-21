/**
 * Media capabilities: which image and video models a deployment serves, and
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

/** The two deliverable kinds the panels generate. */
export type MediaKind = 'image' | 'video'

/** What an image model accepts. */
export interface ImageParams {
  /** Output sizes in the request's own spelling, e.g. `1024x1024`. */
  readonly sizes: readonly string[]
  /** Named resolution tiers; absent for image routes without this field. */
  readonly resolutions?: readonly string[]
  /** Largest `n` one request may ask for. */
  readonly maxCount: number
  /** Largest number of reference images an edit may carry; 0 disables edits. */
  readonly maxEdits: number
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
  /** First/last frame images, which pin the shot's ends. */
  readonly maxFrameImages: number
  /** Multimodal reference images, a style/subject hint rather than a frame. */
  readonly maxReferenceImages: number
  readonly maxReferenceVideos: number
  readonly maxReferenceAudios: number
  /** Frame slots the model names, so first and last can be separate controls. */
  readonly frameSlots: number
  /** The model renders an audio track on its own. */
  readonly audio: boolean
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
  readonly params: ImageParams | VideoParams
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

/** Resolution const and enum constrain one another when both are declared. */
function declaredResolutionMenu(schema: unknown): string[] | null {
  const field = objectRecord(parameterFields(schema)?.resolution)
  if (field === null) return null
  if (field.const !== undefined && (typeof field.const !== 'string' || field.const === ''
    || field.const.length > 64 || field.const.trim() !== field.const)) return null
  const constant = typeof field.const === 'string' && field.const !== '' ? field.const : null
  if (field.enum !== undefined) {
    if (!Array.isArray(field.enum) || field.enum.length > 64
      || field.enum.some(value => typeof value !== 'string' || value === '' || value.length > 64 || value.trim() !== value)) return null
    const menu = stringList(field.enum)
    return constant === null ? menu : menu.filter(value => value === constant)
  }
  return constant === null ? null : [constant]
}

/** Standard oneOf branches pair explicit resolutions with bounded duration menus. */
function resolutionDurations(schema: unknown): Record<string, readonly number[]> | null {
  const branches = objectRecord(schema)?.oneOf
  if (!Array.isArray(branches) || branches.length === 0 || branches.length > 64) return null
  const menus = new Map<string, Map<number, number>>()
  for (const branch of branches) {
    const resolutions = declaredResolutionMenu(branch)
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
function imageParams(spec: ImageSpec, schema: unknown, examples: readonly unknown[]): {
  params: ImageParams
  verified: boolean
  source: string
  notes: string[]
} {
  const declared = schemaEnum(schema, 'size').concat(schemaEnum(schema, 'sizes'))
  const notes: string[] = []
  let source = spec.source
  let sizes = spec.sizes
  if (declared.length > 0) {
    sizes = declared
    notes.push('sizes')
    source = spec.source === 'fallback' ? 'newapi' : spec.source
  }
  // Input-image billing tells us an edit route exists even before the table does.
  const billedEdits = maxExampleValue(examples, 'input_images')
  const maxEdits = spec.maxEdits > 0 || billedEdits === null ? spec.maxEdits : billedEdits
  const resolutions = schemaEnum(schema, 'resolution')
  const outputResolutions = resolutions.length > 0 ? resolutions : spec.resolutions
  return {
    params: {
      sizes,
      ...outputResolutions === undefined ? {} : { resolutions: outputResolutions },
      maxCount: spec.maxCount,
      maxEdits,
      qualities: spec.qualities,
      backgrounds: spec.backgrounds,
      formats: spec.formats,
      moderations: spec.moderations,
      seed: spec.seed,
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
  const parameterResolutions = declaredResolutionMenu(parameters)
  const parameterDurations = declaredDurations(parameters)
  const parameterCombinations = resolutionDurations(parameters)
  const hasParameterDurations = parameterDurations !== null || parameterCombinations !== null
  const declaredResolutions = parameterResolutions
    ?? (parameterCombinations === null ? declaredResolutionMenu(schema) : Object.keys(parameterCombinations))
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
  const params: VideoParams = {
    durations,
    ...spec.defaultDuration !== undefined && durations.includes(spec.defaultDuration) ? { defaultDuration: spec.defaultDuration } : {},
    ...durationByResolution === undefined ? {} : { durationByResolution },
    minDuration: durations[0] ?? 0,
    maxDuration: durations[durations.length - 1] ?? 0,
    resolutions,
    ratios: spec.ratios,
    maxFrameImages: spec.frames,
    maxReferenceImages: spec.referenceImages,
    maxReferenceVideos: spec.referenceVideos,
    maxReferenceAudios: spec.referenceAudios,
    frameSlots: spec.frames,
    audio: spec.audio,
    audioToggle: spec.audioToggle,
    watermark: false,
    modes: spec.modes,
    seed: spec.seed,
    mixFramesAndReferences: spec.frames === 0 || spec.referenceImages + spec.referenceVideos + spec.referenceAudios === 0
      ? true
      : spec.source !== 'plugin:hailuo',
  }
  return { params, verified: isVerified(spec.source), source: spec.source, notes }
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
function mediaKind(id: string, endpoints: readonly string[], fields: readonly string[]): MediaKind | null {
  let video = 0
  let image = 0
  if (endpoints.some(endpoint => endpoint.includes('video'))) video += 4
  if (endpoints.some(endpoint => endpoint === 'image' || endpoint === 'image-generation')) image += 4
  if (fields.some(field => field === 'seconds' || field === 'resolution' || field === 'input_video_seconds')) video += 3
  if (fields.includes('image_count')) image += 1
  if (videoSpec(id).source !== 'fallback') video += 4
  if (imageSpec(id).source !== 'fallback') image += 4
  if (/video|hailuo|kling|jimeng|sora|veo|vidu|wan[0-9.]*[-_]|minimax|runway|luma|pika|seedance|pixverse|ltx|mochi|cogvideo/i.test(id)) {
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
    const kind = mediaKind(id, endpoints, fields)
    if (kind === null) continue
    const groups = stringList(record.enable_groups)
    if (userGroup !== null && groups.length > 0 && !groups.includes(userGroup)) continue
    const examples = Array.isArray(record.billing_usage_examples) ? record.billing_usage_examples : []
    const built = kind === 'video'
      ? videoParams(videoSpec(id), record.billing_usage_schema, record.parameters)
      : imageParams(imageSpec(id), record.billing_usage_schema, examples)
    // A row that names its own route wins; otherwise the built-in table for
    // plugin-served models, and the host protocol path for everything else.
    const declaredRoute = typeof record.route === 'string' && record.route.startsWith('/') ? record.route : null
    const route = declaredRoute
      ?? (kind === 'image' ? IMAGE_ROUTES[id] : undefined)
      ?? (kind === 'video' && id === 'MiniMax-H3' ? '/v1/video/generations' : undefined)
      ?? (kind === 'image' ? '/v1/images/generations' : '/v1/videos')
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
 * @param kind - Image or video generation.
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
    if (mediaKind(id, endpoints, schemaFields(record.billing_usage_schema)) !== null) ids.push(id)
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
