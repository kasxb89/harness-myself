/** Validated public reference prices and exact display arithmetic; no payment amounts enter this comparison. */
export type ComparisonKind = 'text' | 'image' | 'video' | 'audio'

/** One dated, same-specification reference published by the configured Host. */
export interface ComparisonRow {
  readonly params: Readonly<Record<string, string | number | boolean | null>>
  readonly retail_cny: string
  readonly unit: string
  readonly direction?: 'input' | 'output'
  readonly retail_total_cny?: string
  readonly official_reference: {
    readonly official_cny: string
    readonly model: string
    readonly unit: string
    readonly source_url: string
    readonly checked_at: string
    readonly conditions: string
    readonly source_currency: 'USD' | 'CNY'
    readonly usd_cny?: string
    readonly official_total_cny?: string
  }
}

/** Public model identity and independently comparable rows, without supplier data. */
export interface ComparisonModel {
  readonly id: string
  readonly name: string
  readonly kind: ComparisonKind
  readonly rows: readonly ComparisonRow[]
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value)
}
function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,17})(?:\.\d{1,24})?$/u.test(value) && /[1-9]/u.test(value)
}
function sourceUrl(value: unknown): value is string {
  if (!text(value, 2048)) return false
  try { const url = new URL(value); return url.protocol === 'https:' && url.username === '' && url.password === '' }
  catch (_invalidUrl: unknown) { return false }
}
function checkedDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
function rowOf(value: unknown, kind: ComparisonKind): ComparisonRow | undefined {
  const row = object(value), reference = object(row?.official_reference), params = object(row?.params)
  if (row === undefined || reference === undefined || params === undefined || !decimal(row.retail_cny)
    || !text(row.unit, 100) || reference.schema_version !== 1 || reference.currency !== 'CNY'
    || !decimal(reference.official_cny) || reference.unit !== row.unit || !text(reference.model, 256)
    || !sourceUrl(reference.source_url) || !checkedDate(reference.checked_at)
    || typeof reference.conditions !== 'string' || reference.conditions.length > 4096 || /[\u0000-\u001f]/u.test(reference.conditions)
    || reference.source_currency !== 'CNY' && reference.source_currency !== 'USD'
    || reference.source_currency === 'USD' && !decimal(reference.usd_cny)
    || row.direction !== undefined && row.direction !== 'input' && row.direction !== 'output'
    || kind === 'text' && row.direction === undefined
    || row.retail_total_cny !== undefined && !decimal(row.retail_total_cny)
    || reference.official_total_cny !== undefined && !decimal(reference.official_total_cny)
    || Object.keys(params).length > 32 || Object.entries(params).some(([key, child]) =>
    !text(key, 100) || child !== null && typeof child !== 'boolean'
        && !(typeof child === 'number' && Number.isFinite(child)) && !text(child, 512))) return undefined
  // Only the public whitelist is retained; unknown metadata cannot become page copy.
  return { params: params as Record<string, string | number | boolean | null>, retail_cny: row.retail_cny, unit: row.unit,
    ...row.direction === undefined ? {} : { direction: row.direction },
    ...row.retail_total_cny === undefined ? {} : { retail_total_cny: row.retail_total_cny },
    official_reference: { official_cny: reference.official_cny, model: reference.model, unit: row.unit,
      source_url: reference.source_url, checked_at: reference.checked_at, conditions: reference.conditions,
      source_currency: reference.source_currency,
      ...typeof reference.usd_cny === 'string' ? { usd_cny: reference.usd_cny } : {},
      ...typeof reference.official_total_cny === 'string' ? { official_total_cny: reference.official_total_cny } : {} } }
}

/**
 * Select validated reference comparisons from a default-price Host payload.
 * @param value - Unknown local Host payload.
 * @returns Models with complete, same-unit comparison rows; unsupported payloads yield an empty list.
 */
export function comparisonModels(value: unknown): readonly ComparisonModel[] {
  const payload = object(value)
  if (payload?.basis !== 'default' || !Array.isArray(payload.models) || payload.models.length > 256) return []
  return payload.models.flatMap((value: unknown) => {
    const model = object(value)
    if (model === undefined || !text(model.id, 256) || !text(model.name, 256)
      || !['text', 'image', 'video', 'audio'].includes(String(model.kind))
      || !Array.isArray(model.rows) || model.rows.length > 256) return []
    const kind = model.kind as ComparisonKind
    const rows = model.rows.flatMap((value: unknown) => { const row = rowOf(value, kind); return row === undefined ? [] : [row] })
    return rows.length === 0 ? [] : [{ id: model.id, name: model.name, kind, rows }]
  })
}

function coefficient(value: string): { integer: bigint; scale: number } {
  const [whole, fraction = ''] = value.split('.')
  return { integer: BigInt((whole ?? '0') + fraction), scale: fraction.length }
}
function fixed(value: bigint, places: number): string {
  const raw = value.toString().padStart(places + 1, '0')
  return (raw.slice(0, -places) + '.' + raw.slice(-places)).replace(/\.?0+$/u, '')
}

/** Exact extrema in account points, before display rounding. */
export interface CreditUnitRange { readonly minimum: string; readonly maximum: string }

/**
 * Validate exact decimal point prices after the Host's currency conversion.
 * @param value - Untrusted point price.
 * @returns Whether the value is a bounded nonnegative decimal string; numeric zero alone does not establish free generation.
 */
export function publicPointsDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,35})(?:\.\d{1,48})?$/u.test(value)
}

/**
 * Compare exact per-unit point prices already converted by the Host.
 * @param prices - Verified positive points per image or points per second; free-generation evidence is not supplied here.
 * @returns Exact minimum and maximum, or absence when no reliable prices are available.
 */
export function creditUnitRange(prices: readonly string[]): CreditUnitRange | undefined {
  if (prices.length === 0 || !prices.every(value => publicPointsDecimal(value) && /[1-9]/u.test(value))) return undefined
  const values = prices.map(coefficient)
  const scale = Math.max(...values.map(value => value.scale))
  const normalized = values.map(value => value.integer * 10n ** BigInt(scale - value.scale))
  const minimum = normalized.reduce((left, right) => left < right ? left : right)
  const maximum = normalized.reduce((left, right) => left > right ? left : right)
  const format = (value: bigint): string => scale === 0 ? value.toString() : fixed(value, scale)
  return { minimum: format(minimum), maximum: format(maximum) }
}

/**
 * Format a decimal point amount without converting it to a floating-point number.
 * @param value - Exact nonnegative point amount.
 * @param locale - Product locale used for digit grouping.
 * @returns A compact amount with at most six decimal places, rounded upward so a positive price never appears free.
 */
export function formatCreditUnitPrice(value: string, locale: string): string {
  const amount = coefficient(value)
  const places = Math.min(6, amount.scale)
  const divisor = 10n ** BigInt(amount.scale - places)
  const rounded = (amount.integer + divisor - 1n) / divisor
  const text = places === 0 ? rounded.toString() : fixed(rounded, places)
  const [whole = '0', fraction] = text.split('.')
  const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(BigInt(whole))
  const separator = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? '.'
  return fraction === undefined ? grouped : `${grouped}${separator}${fraction}`
}

/**
 * Compare exact decimal prices without rounding positive prices to free or savings to 100%.
 * @param row - Validated prices for one direction and complete specification.
 * @returns Conservative display rounding; equal or higher prices never claim a discount.
 */
export function comparisonDiscount(row: ComparisonRow): { kind: 'lower'; zhe: string; percent: string; saving: string }
  | { kind: 'equal' | 'higher' } {
  const retail = coefficient(row.retail_cny), official = coefficient(row.official_reference.official_cny)
  const numerator = retail.integer * 10n ** BigInt(official.scale)
  const denominator = official.integer * 10n ** BigInt(retail.scale)
  if (numerator >= denominator) return { kind: numerator === denominator ? 'equal' : 'higher' }
  const roundedUp = (numerator * 1000n + denominator - 1n) / denominator
  return { kind: 'lower', zhe: fixed(roundedUp, 2), percent: fixed(roundedUp, 1),
    saving: fixed((denominator - numerator) * 1000n / denominator, 1) }
}
