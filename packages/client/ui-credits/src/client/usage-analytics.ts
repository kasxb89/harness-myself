/** Validated usage records and Shanghai calendar-day summaries for the Credits page. */

/** The account page's supported calendar-day query presets. */
export type UsageRange = 'today' | '7d' | '30d'

/** One model's billed usage at a Unix-second timestamp, including adjustment records. */
export interface UsageRow {
  readonly timestamp: number
  readonly model: string
  readonly billingRecords: number
  readonly consumedPoints: number
  readonly totalTokens: number
}

/** A complete successful query; missing dates have no recorded consumption. */
export interface UsagePayload {
  readonly rows: readonly UsageRow[]
  readonly asOf: string
  readonly start: number
  readonly end: number
  readonly delayMinutes: number
}

/** Recorded consumption for one Shanghai calendar date, keyed as YYYY-MM-DD. */
export interface UsageDailyPoint {
  readonly day: string
  consumedPoints: number
  billingRecords: number
  totalTokens: number
}

/** Recorded consumption for a model; an empty model name remains untranslated. */
export interface UsageModelPoint {
  readonly model: string
  consumedPoints: number
  billingRecords: number
  totalTokens: number
}

interface UsageTotals {
  consumedPoints: number
  billingRecords: number
  totalTokens: number
}

const secondsPerDay = 86_400
const shanghaiOffsetSeconds = 8 * 3_600
const latestUnixSecond = 253_402_300_799
const rangeDays = { today: 1, '7d': 7, '30d': 30 } as const

function shanghaiDay(timestamp: number): string {
  const iso = new Date((timestamp + shanghaiOffsetSeconds) * 1_000).toISOString()
  return iso.slice(0, iso.indexOf('T'))
}

/**
 * Include today and the preceding preset days in Asia/Shanghai, through the current second.
 * @param range - The number of calendar dates to include.
 * @param nowMs - The current Unix time in milliseconds.
 * @returns Inclusive Unix-second bounds and their Shanghai calendar-date keys.
 */
export function getUsageWindow(range: UsageRange, nowMs = Date.now()): {
  start: number
  end: number
  startDay: string
  endDay: string
} {
  const end = Math.floor(nowMs / 1_000)
  const endDay = shanghaiDay(end)
  const midnight = Date.parse(`${endDay}T00:00:00+08:00`) / 1_000
  const start = midnight - (rangeDays[range] - 1) * secondsPerDay
  return { start, end, startDay: shanghaiDay(start), endDay }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPoints(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const pattern =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
  const match = pattern.exec(value)
  if (match === null || !Number.isFinite(Date.parse(value))) return false
  const calendar = new Date(`${match[1]}-${match[2]}-01T00:00:00Z`)
  calendar.setUTCMonth(calendar.getUTCMonth() + 1, 0)
  return Number(match[3]) <= calendar.getUTCDate()
}

/**
 * Validate an untrusted successful usage response without dropping malformed rows.
 * @param value - JSON returned by the account usage endpoint.
 * @returns A detached payload with finite nonnegative usage and inclusive valid dates.
 * @throws Error when metadata or any usage record violates the wire fields.
 */
export function parseUsagePayload(value: unknown): UsagePayload {
  if (!isRecord(value)
    || !isCount(value.start) || value.start === 0
    || !isCount(value.end) || value.end > latestUnixSecond
    || value.end < value.start || value.end - value.start >= 31 * secondsPerDay
    || !isIsoDate(value.asOf) || value.delayMinutes !== 5
    || !Array.isArray(value.rows)) {
    throw new Error('Invalid usage response metadata')
  }
  const start = value.start
  const end = value.end
  const rows = value.rows.map((row: unknown): UsageRow => {
    if (!isRecord(row)
      || !isCount(row.timestamp) || row.timestamp < start || row.timestamp > end
      || typeof row.model !== 'string'
      || !isCount(row.billingRecords) || !isCount(row.totalTokens)
      || !isPoints(row.consumedPoints)) {
      throw new Error('Invalid usage response record')
    }
    return {
      timestamp: row.timestamp,
      model: row.model,
      billingRecords: row.billingRecords,
      consumedPoints: row.consumedPoints,
      totalTokens: row.totalTokens,
    }
  })
  return { rows, asOf: value.asOf, start, end, delayMinutes: value.delayMinutes }
}

function zeroTotals(): UsageTotals {
  return { consumedPoints: 0, billingRecords: 0, totalTokens: 0 }
}

function addUsage(target: UsageTotals, row: UsageRow): void {
  const consumedPoints = target.consumedPoints + row.consumedPoints
  const billingRecords = target.billingRecords + row.billingRecords
  const totalTokens = target.totalTokens + row.totalTokens
  if (!Number.isFinite(consumedPoints)
    || !Number.isSafeInteger(billingRecords) || !Number.isSafeInteger(totalTokens)) {
    throw new Error('Usage totals exceed numeric limits')
  }
  target.consumedPoints = consumedPoints
  target.billingRecords = billingRecords
  target.totalTokens = totalTokens
}

/**
 * Summarize a validated complete query for one model or the full account.
 * @param payload - A payload accepted by parseUsagePayload.
 * @param selectedModel - The exact model to include, or null to include every model.
 * @returns Complete daily buckets, stable descending model totals, and the full model filter list.
 * @throws Error when adding valid individual values would overflow a finite total or safe count.
 */
export function aggregateUsage(payload: UsagePayload, selectedModel: string | null): {
  daily: UsageDailyPoint[]
  models: UsageModelPoint[]
  totals: UsageTotals
  availableModels: readonly string[]
} {
  const daily = new Map<string, UsageDailyPoint>()
  const startDay = shanghaiDay(payload.start)
  const firstMidnight = Date.parse(`${startDay}T00:00:00+08:00`) / 1_000
  for (let timestamp = firstMidnight; timestamp <= payload.end; timestamp += secondsPerDay) {
    const day = shanghaiDay(timestamp)
    daily.set(day, { day, ...zeroTotals() })
  }
  const models = new Map<string, UsageModelPoint>()
  const availableModels = new Set<string>()
  const totals = zeroTotals()
  for (const row of payload.rows) {
    availableModels.add(row.model)
    if (selectedModel !== null && row.model !== selectedModel) continue
    const day = daily.get(shanghaiDay(row.timestamp))
    if (day === undefined) throw new Error('Usage record lies outside daily buckets')
    let model = models.get(row.model)
    if (model === undefined) {
      model = { model: row.model, ...zeroTotals() }
      models.set(row.model, model)
    }
    addUsage(day, row)
    addUsage(model, row)
    addUsage(totals, row)
  }
  return {
    daily: [...daily.values()],
    models: [...models.values()].sort((left, right) => right.consumedPoints - left.consumedPoints),
    totals,
    availableModels: [...availableModels],
  }
}
