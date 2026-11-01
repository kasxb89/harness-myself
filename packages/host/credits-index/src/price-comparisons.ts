/** Public, same-unit price references for recharge education; no account or supplier pricing is retained. @module */
import { readPublicStatus } from './public-status.ts'

/** Official public evidence attached to one exact default retail specification. */
export interface OfficialPriceReference {
  readonly schema_version: 1
  readonly currency: 'CNY'
  readonly source_currency: 'USD' | 'CNY'
  readonly official_cny: string
  readonly model: string
  readonly unit: string
  readonly source_url: string
  readonly checked_at: string
  readonly conditions: string
  readonly usd_cny?: string
  readonly official_total_cny?: string
}

/** Exact published retail specification paired with its public reference. */
export interface PriceComparisonRow {
  readonly params: Readonly<Record<string, string | number | boolean | null>>
  readonly retail_cny: string
  readonly unit: string
  readonly direction?: 'input' | 'output'
  readonly retail_total_cny?: string
  readonly official_reference: OfficialPriceReference
}

/** Public model identity and only the rows having validated official reference metadata. */
export interface PriceComparisonModel {
  readonly id: string
  readonly name: string
  readonly kind: 'text' | 'image' | 'video' | 'audio'
  readonly rows: readonly PriceComparisonRow[]
}

/** Default list-price comparison; no account multiplier or final-charge claim is implied. */
export type PriceComparisonsResponse = {
  readonly ok: true
  readonly payload: { readonly basis: 'default'; readonly models: readonly PriceComparisonModel[] }
} | {
  readonly ok: false
  readonly code: 'PRICE_COMPARISONS_UNSUPPORTED' | 'PRICE_COMPARISONS_NETWORK'
    | 'PRICE_COMPARISONS_UNAVAILABLE' | 'PRICE_COMPARISONS_INVALID'
}

const parameterNames = new Set(['duration', 'seconds', 'resolution', 'size', 'quality', 'mode', 'ratio', 'aspect_ratio',
  'count', 'n', 'audio', 'voice', 'speed', 'response_format', 'thinking_level'])
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, maximum: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= maximum && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
/**
 * Validate the bounded positive decimal spelling shared by public reference prices.
 * @param value - Untrusted public retail or conversion value.
 * @returns Whether exact decimal arithmetic can consume it without exponent or zero-price inference.
 */
export const isPositiveRetailDecimal = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 64 && /^(?:0|[1-9]\d{0,17})(?:\.\d{1,24})?$/u.test(value) && /[1-9]/u.test(value)

/** Calendar validation rejects dates which Date.parse would silently normalize. */
function checkedDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const date = new Date(value + 'T00:00:00.000Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function sourceUrl(value: unknown): value is string {
  if (!text(value, 2048)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''
  } catch (_invalidUrl: unknown) { return false }
}

function parameters(value: unknown): PriceComparisonRow['params'] | undefined {
  const source = record(value)
  if (source === undefined || Object.keys(source).length > 16) return undefined
  const fields: Record<string, string | number | boolean | null> = {}
  for (const [key, item] of Object.entries(source)) {
    if (!parameterNames.has(key)) return undefined
    if (item !== null && typeof item !== 'boolean' && !(typeof item === 'string' && text(item, 128))
      && !(typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1_000_000_000)) return undefined
    fields[key] = item
  }
  return fields
}

function priceRow(value: unknown, kind: PriceComparisonModel['kind']): PriceComparisonRow | undefined {
  const row = record(value)
  const official = record(row?.official_reference)
  if (row === undefined || official === undefined) return undefined
  const unit = kind === 'video' ? 'CNY / second' : kind === 'image' ? 'CNY / image' : 'CNY / million tokens'
  const params = parameters(row.params)
  if (params === undefined || row.unit !== unit || !isPositiveRetailDecimal(row.retail_cny)
    || official.schema_version !== 1 || official.currency !== 'CNY'
    || official.source_currency !== 'USD' && official.source_currency !== 'CNY'
    || official.unit !== row.unit || !isPositiveRetailDecimal(official.official_cny) || !text(official.model, 191)
    || !sourceUrl(official.source_url) || !checkedDate(official.checked_at)
    || official.conditions !== '' && !text(official.conditions, 4096)
    || official.source_currency === 'USD' && !isPositiveRetailDecimal(official.usd_cny)
    || row.retail_total_cny !== undefined && !isPositiveRetailDecimal(row.retail_total_cny)
    || official.official_total_cny !== undefined && !isPositiveRetailDecimal(official.official_total_cny)
    || (kind === 'text' || kind === 'audio') && row.direction !== 'input' && row.direction !== 'output'
    || (kind === 'image' || kind === 'video') && row.direction !== undefined) return undefined
  return { params, retail_cny: row.retail_cny, unit,
    ...row.direction === 'input' || row.direction === 'output' ? { direction: row.direction } : {},
    ...typeof row.retail_total_cny === 'string' ? { retail_total_cny: row.retail_total_cny } : {},
    official_reference: {
      schema_version: 1, currency: 'CNY', source_currency: official.source_currency,
      official_cny: official.official_cny, model: official.model, unit,
      source_url: official.source_url, checked_at: official.checked_at, conditions: official.conditions,
      ...official.source_currency === 'USD' && typeof official.usd_cny === 'string' ? { usd_cny: official.usd_cny } : {},
      ...typeof official.official_total_cny === 'string' ? { official_total_cny: official.official_total_cny } : {},
    } }
}

/**
 * Retain only published default prices with complete, same-unit official evidence.
 * @param value - Public pricing response from the configured gateway.
 * @returns A bounded whitelist projection; older APIs without evidence return an empty supported result.
 */
export function parsePriceComparisons(value: unknown): PriceComparisonsResponse {
  const body = record(value)
  if (body?.success !== true || !Array.isArray(body.data) || body.data.length > 2048) {
    return { ok: false, code: 'PRICE_COMPARISONS_INVALID' }
  }
  const models: PriceComparisonModel[] = []
  const identifiers = new Set<string>()
  let rowCount = 0
  for (const raw of body.data) {
    const model = record(raw)
    if (model === undefined || !Array.isArray(model.retail_price_rows)) continue
    if (!text(model.model_name, 191) || !text(model.display_name, 256)
      || model.kind !== 'text' && model.kind !== 'image' && model.kind !== 'video' && model.kind !== 'audio') continue
    if (model.retail_price_rows.length > 512) return { ok: false, code: 'PRICE_COMPARISONS_INVALID' }
    const kind = model.kind
    const rows = model.retail_price_rows.flatMap((item) => {
      const parsed = priceRow(item, kind)
      return parsed === undefined ? [] : [parsed]
    })
    if (rows.length === 0) continue
    if (identifiers.has(model.model_name)) return { ok: false, code: 'PRICE_COMPARISONS_INVALID' }
    identifiers.add(model.model_name)
    rowCount += rows.length
    if (models.length >= 512 || rowCount > 4096) return { ok: false, code: 'PRICE_COMPARISONS_INVALID' }
    models.push({ id: model.model_name, name: model.display_name, kind: model.kind, rows })
  }
  const result: PriceComparisonsResponse = { ok: true, payload: { basis: 'default', models } }
  return Buffer.byteLength(JSON.stringify(result), 'utf8') > 1_048_576
    ? { ok: false, code: 'PRICE_COMPARISONS_INVALID' } : result
}

/**
 * Read an anonymous pricing document under the Host request lifetime without retaining raw API data.
 * @param fetchPricing - Fixed-origin, credential-free request with redirects disabled.
 * @param signal - Host request, plugin disposal and deadline lifetime.
 * @returns Safe default-price data or a localized UI-owned failure category.
 */
export async function readPriceComparisons(
  fetchPricing: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal,
): Promise<PriceComparisonsResponse> {
  const result = await readPublicStatus(fetchPricing, signal)
  if (result.ok) return parsePriceComparisons(result.value)
  const codes = { unsupported: 'PRICE_COMPARISONS_UNSUPPORTED', unavailable: 'PRICE_COMPARISONS_UNAVAILABLE',
    invalid: 'PRICE_COMPARISONS_INVALID', network: 'PRICE_COMPARISONS_NETWORK', timeout: 'PRICE_COMPARISONS_NETWORK' } as const
  return { ok: false, code: codes[result.reason] }
}
