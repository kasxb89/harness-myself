/** Exact public unit prices for the composer; no quotes, credentials or supplier data. @module */
import { isPositiveRetailDecimal } from './price-comparisons.ts'
import { resolveMediaSpecification } from './media-request-specification.ts'
import { validateMediaPreference } from './media-preferences.ts'
import type { ImageParams, MediaSpecification, ModelCapability, VideoParams } from './media.ts'
import type { MediaPreferencePriceRow, MediaPreferencePricing } from './media-preferences-types.ts'

const fields = ['size', 'resolution', 'seconds', 'ratio', 'quality', 'mode'] as const
const allowed = new Set([...fields, 'duration', 'aspect_ratio', 'count', 'n', 'audio', 'generate_audio', 'seed', 'watermark',
  'background', 'format', 'output_format', 'moderation'])
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function decimalProduct(left: string, right: string): string {
  const places = (value: string): number => value.includes('.') ? value.length - value.indexOf('.') - 1 : 0
  const scale = places(left) + places(right)
  const product = BigInt(left.replace('.', '')) * BigInt(right.replace('.', ''))
  const digits = product.toString().padStart(scale + 1, '0')
  return scale === 0 ? digits : (digits.slice(0, -scale) + '.' + digits.slice(-scale)).replace(/\.?0+$/u, '')
}

function whole(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9]\d{0,15}$/u.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 128 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function menu(value: unknown, options: readonly string[] | undefined): string | undefined {
  if (!text(value)) return undefined
  const matched = options?.filter(option => option.toLowerCase() === value.toLowerCase())
  return matched?.length === 1 ? matched[0] : undefined
}

function inputMode(value: unknown): MediaPreferencePriceRow['input'] | undefined {
  if (value === undefined) return 'unspecified'
  if (typeof value !== 'string') return undefined
  const normalized = value.toLowerCase().replaceAll('_', '-')
  if (['text-to-image', 'text-to-video', 't2i', 't2v', 'txt2img', 'text2video'].includes(normalized)) return 'text'
  if (['image-to-image', 'image-to-video', 'reference-to-image', 'reference-to-video', 'i2i', 'i2v', 'img2img'].includes(normalized)) {
    return 'reference'
  }
  return undefined
}

function normalizedRows(
  raw: Record<string, unknown>, model: ModelCapability, fixedMinimalThinking: boolean,
): readonly MediaPreferencePriceRow['parameters'][] {
  const params = model.params as ImageParams | VideoParams
  const normalized: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (name === 'thinking_level' && fixedMinimalThinking && value === 'minimal') continue
    if (!allowed.has(name)) return []
    if (['duration', 'seconds', 'aspect_ratio', 'ratio', 'size', 'resolution', 'n', 'count', 'mode', 'generate_audio', 'output_format'].includes(name)) continue
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isSafeInteger(value))) return []
    normalized[name] = value
  }
  const seconds = raw.seconds === undefined ? raw.duration === undefined ? undefined : whole(raw.duration) : whole(raw.seconds)
  if ((raw.seconds !== undefined || raw.duration !== undefined) && seconds === undefined
    || raw.seconds !== undefined && raw.duration !== undefined && whole(raw.seconds) !== whole(raw.duration)) return []
  if (seconds !== undefined) normalized.seconds = seconds
  const count = raw.count === undefined ? raw.n === undefined ? undefined : whole(raw.n) : whole(raw.count)
  if ((raw.count !== undefined || raw.n !== undefined) && count === undefined
    || raw.count !== undefined && raw.n !== undefined && whole(raw.count) !== whole(raw.n)
    || model.kind === 'video' && count !== undefined && count !== 1) return []
  if (count !== undefined && model.kind === 'image') normalized.count = count
  const aspect = raw.ratio ?? raw.aspect_ratio
  if (raw.ratio !== undefined && raw.aspect_ratio !== undefined && raw.ratio !== raw.aspect_ratio) return []
  if (aspect !== undefined && !text(aspect) || raw.size !== undefined && !text(raw.size)) return []
  if (raw.resolution !== undefined) {
    const resolution = menu(raw.resolution, params.resolutions)
    if (resolution === undefined) return []
    normalized.resolution = resolution
  }
  if (raw.mode !== undefined) {
    const selected = 'modes' in params ? menu(raw.mode, params.modes) : undefined
    if (selected !== undefined) normalized.mode = selected
    else if (inputMode(raw.mode) === undefined) return []
  }
  if (raw.generate_audio !== undefined) {
    if (typeof raw.generate_audio !== 'boolean' || raw.audio !== undefined && raw.audio !== raw.generate_audio) return []
    normalized.audio = raw.generate_audio
  }
  if (raw.output_format !== undefined) {
    if (!text(raw.output_format) || raw.format !== undefined && raw.format !== raw.output_format) return []
    normalized.format = raw.output_format
  }
  const candidates: Record<string, string | number | boolean>[] = []
  if (model.kind === 'image') {
    if (aspect === undefined || raw.size === undefined || aspect === raw.size) {
      const candidate = { ...normalized }
      const size = aspect ?? raw.size
      if (size !== undefined) candidate.size = size
      candidates.push(candidate)
    } else if (raw.resolution === undefined) {
      const resolution = menu(raw.size, params.resolutions)
      if (resolution !== undefined) candidates.push({ ...normalized, size: aspect, resolution })
    }
  } else candidates.push({ ...normalized, ...raw.size === undefined ? {} : { size: raw.size },
    ...aspect === undefined ? {} : { ratio: aspect } })
  const prepared: MediaPreferencePriceRow['parameters'][] = []
  for (const candidate of candidates) {
    const dimensions = Object.fromEntries(fields.flatMap(field => candidate[field] === undefined ? [] : [[field, candidate[field]]]))
    const complete = resolveMediaSpecification(params.specifications, dimensions)
    if (!complete.ok) continue
    const selected = { ...candidate, ...complete.specification }
    try { validateMediaPreference(model.kind === 'image' ? 'image' : 'video', { model: model.id, parameters: selected }, [model]) }
    catch (_unsupportedPublicPriceParameters: unknown) { continue }
    prepared.push({ ...selected, ...count === undefined || model.kind === 'image' ? {} : { count } })
  }
  return prepared
}

function publicRow(
  value: unknown, model: ModelCapability, rate: string, fixedMinimalThinking: boolean,
): MediaPreferencePriceRow | undefined {
  const row = record(value)
  const raw = record(row?.params)
  const unit = model.kind === 'image' ? 'CNY / image' : 'CNY / second'
  if (row === undefined || raw === undefined || Object.keys(raw).length > 24 || row.unit !== unit || row.direction !== undefined
    || row.currency !== undefined && row.currency !== 'CNY' || !isPositiveRetailDecimal(row.retail_cny)) return undefined
  const input = inputMode(raw.mode) ?? (raw.mode === undefined || 'modes' in model.params && menu(raw.mode, model.params.modes) !== undefined
    ? 'unspecified' : undefined)
  if (input === undefined) return undefined
  if (input === 'reference' && (model.kind === 'image' ? (model.params as ImageParams).maxEdits === 0
    : (model.params as VideoParams).maxFrameImages + (model.params as VideoParams).maxReferenceImages
      + (model.params as VideoParams).maxReferenceVideos + (model.params as VideoParams).maxReferenceAudios === 0)) return undefined
  const prepared = normalizedRows(raw, model, fixedMinimalThinking)
  if (prepared.length !== 1 || prepared[0] === undefined) return undefined
  return { parameters: prepared[0], points: decimalProduct(row.retail_cny, rate), input }
}

/** The audited YCAPI adapter injects this fixed offer field; it is not a client-selectable parameter. */
function fixedYcapiMinimalThinking(source: unknown, model: ModelCapability, table: readonly unknown[]): boolean {
  const adapter = record(record(record(source)?.parameters)?.['x-task-plugin'])
  const specifications = (model.params as ImageParams | VideoParams).specifications
  return adapter?.api_version === 1 && adapter.key === 'ycapi' && adapter.version === '1.0.0'
    && specifications !== undefined && specifications.length > 0 && table.length > 0
    && table.every(value => record(record(value)?.params)?.thinking_level === 'minimal')
}

function covers(specification: MediaSpecification, row: MediaPreferencePriceRow): boolean {
  return fields.every(field => specification[field] === undefined || row.parameters[field] === specification[field])
}

/**
 * Project default-retail CNY unit rows using this deployment's actual points conversion.
 * @param raw - Already-read public pricing records; this function performs no request or quote.
 * @param models - Authorized same-modality models; no other model is returned.
 * @param creditsPerYuan - Configured product points for one yuan, never a model price or supplier cost.
 * @returns Bounded public points references; missing, zero, invalid or ambiguous data stays unavailable.
 */
export function mediaPreferencePrices(
  raw: readonly unknown[], models: readonly ModelCapability[], creditsPerYuan: number,
): ReadonlyMap<string, MediaPreferencePricing> {
  const rate = isPositiveRetailDecimal(String(creditsPerYuan)) ? String(creditsPerYuan) : undefined
  const records = new Map<string, Record<string, unknown> | null>()
  for (const value of raw) {
    const model = record(value)
    if (typeof model?.model_name !== 'string') continue
    records.set(model.model_name, records.has(model.model_name) ? null : model)
  }
  const result = new Map<string, MediaPreferencePricing>()
  let totalRows = 0
  for (const model of models) {
    if (model.kind !== 'image' && model.kind !== 'video') continue
    const base = { schema_version: 1 as const, basis: 'default' as const, source: 'public-retail' as const,
      unit: model.kind === 'image' ? 'points/image' as const : 'points/second' as const,
      ...rate === undefined ? {} : { credits_per_yuan: rate } }
    const source = records.get(model.id)
    const table = source?.retail_price_rows
    const valid = rate !== undefined && Array.isArray(table) && table.length <= 512
      && totalRows + table.length <= 4096 && (source?.kind === undefined || source.kind === model.kind)
    if (!valid) {
      result.set(model.id, { ...base, status: 'unavailable', coverage: 'none', rows: [] })
      continue
    }
    totalRows += table.length
    const fixedMinimalThinking = fixedYcapiMinimalThinking(source, model, table)
    if (!fixedMinimalThinking && table.some(value => Object.hasOwn(record(record(value)?.params) ?? {}, 'thinking_level'))) {
      result.set(model.id, { ...base, status: 'unavailable', coverage: 'none', rows: [] })
      continue
    }
    const rows = table.flatMap((value) => {
      const parsed = publicRow(value, model, rate, fixedMinimalThinking)
      return parsed === undefined ? [] : [parsed]
    })
    const specs = (model.params as ImageParams | VideoParams).specifications
    const complete = rows.length === table.length && specs !== undefined && specs.length > 0
      && specs.every(specification => rows.some(row => covers(specification, row)))
    result.set(model.id, { ...base, status: rows.length === 0 ? 'unavailable' : 'available',
      coverage: rows.length === 0 ? 'none' : complete ? 'complete' : 'partial', rows })
  }
  return result
}
