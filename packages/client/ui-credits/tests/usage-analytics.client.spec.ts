/** Account usage parsing, calendar bounds, and complete-query aggregation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aggregateUsage,
  getUsageWindow,
  parseUsagePayload,
  type UsagePayload,
  type UsageRow,
} from '../src/client/usage-analytics.ts'

const seconds = (date: string): number => Date.parse(date) / 1_000
const start = seconds('2026-10-12T16:00:00Z')
const end = seconds('2026-10-15T04:00:00Z')

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    timestamp: start,
    model: 'alpha',
    billingRecords: 1,
    consumedPoints: 2.5,
    totalTokens: 100,
    ...overrides,
  }
}

function payload(rows: readonly UsageRow[] = []): UsagePayload {
  return { rows, start, end, asOf: '2026-10-15T04:00:00.000Z', delayMinutes: 5 }
}

afterEach(() => vi.useRealTimers())

describe('getUsageWindow', () => {
  it.each([
    ['today', '2026-01-02', '2026-01-01T16:00:00Z'],
    ['7d', '2025-12-27', '2025-12-26T16:00:00Z'],
    ['30d', '2025-12-04', '2025-12-03T16:00:00Z'],
  ] as const)('includes today in %s across the Shanghai year boundary', (range, startDay, date) => {
    expect(getUsageWindow(range, Date.parse('2026-01-01T16:00:00.999Z'))).toEqual({
      start: seconds(date),
      end: seconds('2026-01-01T16:00:00Z'),
      startDay,
      endDay: '2026-01-02',
    })
  })

  it('uses the current clock and includes leap day as a calendar date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-03-01T02:00:00Z'))
    expect(getUsageWindow('7d')).toEqual({
      start: seconds('2024-02-23T16:00:00Z'),
      end: seconds('2024-03-01T02:00:00Z'),
      startDay: '2024-02-24',
      endDay: '2024-03-01',
    })
  })
})

describe('parseUsagePayload', () => {
  it('retains real fractions, zero counts, blank model names, and both inclusive endpoints', () => {
    const wire = payload([
      row({ timestamp: start, model: '', billingRecords: 0, consumedPoints: 0, totalTokens: 0 }),
      row({ timestamp: end, consumedPoints: 0.125 }),
    ])
    const parsed = parseUsagePayload(wire)
    expect(parsed).toEqual(wire)
    expect(parsed).not.toBe(wire)
    expect(parsed.rows).not.toBe(wire.rows)
    expect(parsed.rows[0]).not.toBe(wire.rows[0])
  })

  it('accepts valid ISO dates with explicit offsets', () => {
    expect(parseUsagePayload({ ...payload(), asOf: '2024-02-29T12:00:00+08:00' }).asOf)
      .toBe('2024-02-29T12:00:00+08:00')
  })

  it.each([
    null,
    [],
    { ...payload(), start: 0 },
    { ...payload(), start: -1 },
    { ...payload(), start: 1.5 },
    { ...payload(), end: start - 1 },
    { ...payload(), end: Infinity },
    { ...payload(), end: 253_402_300_800 },
    { ...payload(), end: start + 31 * 86_400 },
    { ...payload(), rows: null },
    { ...payload(), asOf: null },
    { ...payload(), asOf: '' },
    { ...payload(), asOf: '2026-10-15' },
    { ...payload(), asOf: '2026-02-30T12:00:00Z' },
    { ...payload(), asOf: '2026-13-01T12:00:00Z' },
    { ...payload(), delayMinutes: 0 },
  ])('rejects invalid query metadata %#', (value) => {
    expect(() => parseUsagePayload(value)).toThrow('Invalid usage response metadata')
  })

  it.each([
    null,
    row({ timestamp: start - 1 }),
    row({ timestamp: end + 1 }),
    row({ timestamp: start + 0.5 }),
    { ...row(), model: null },
    row({ consumedPoints: -0.1 }),
    row({ consumedPoints: NaN }),
    row({ consumedPoints: Infinity }),
    row({ billingRecords: -1 }),
    row({ billingRecords: 1.5 }),
    row({ billingRecords: Number.MAX_SAFE_INTEGER + 1 }),
    row({ totalTokens: -1 }),
    row({ totalTokens: 0.5 }),
    row({ totalTokens: Number.MAX_SAFE_INTEGER + 1 }),
  ])('rejects the whole payload when any record is invalid %#', (invalid) => {
    expect(() => parseUsagePayload({ ...payload(), rows: [row(), invalid] }))
      .toThrow('Invalid usage response record')
  })

  it('accepts the largest inclusive endpoint span supported by the endpoint', () => {
    expect(parseUsagePayload({ ...payload(), end: start + 31 * 86_400 - 1 }).end)
      .toBe(start + 31 * 86_400 - 1)
  })
})

describe('aggregateUsage', () => {
  const rows = [
    row({ model: 'beta', timestamp: seconds('2026-10-13T15:59:59Z'), consumedPoints: 4, totalTokens: 200 }),
    row({ model: 'alpha', timestamp: seconds('2026-10-14T16:00:00Z'), consumedPoints: 1.25, billingRecords: 2 }),
    row({ model: '', timestamp: end, consumedPoints: 4, billingRecords: 3, totalTokens: 300 }),
    row({ model: 'alpha', timestamp: end, consumedPoints: 1.25, billingRecords: 2 }),
  ]

  it('bins Shanghai dates, fills days absent from a complete query, and preserves stable spending ties', () => {
    expect(aggregateUsage(payload(rows), null)).toEqual({
      daily: [
        { day: '2026-10-13', consumedPoints: 4, billingRecords: 1, totalTokens: 200 },
        { day: '2026-10-14', consumedPoints: 0, billingRecords: 0, totalTokens: 0 },
        { day: '2026-10-15', consumedPoints: 6.5, billingRecords: 7, totalTokens: 500 },
      ],
      models: [
        { model: 'beta', consumedPoints: 4, billingRecords: 1, totalTokens: 200 },
        { model: '', consumedPoints: 4, billingRecords: 3, totalTokens: 300 },
        { model: 'alpha', consumedPoints: 2.5, billingRecords: 4, totalTokens: 200 },
      ],
      totals: { consumedPoints: 10.5, billingRecords: 8, totalTokens: 700 },
      availableModels: ['beta', 'alpha', ''],
    })
  })

  it('filters every summary while retaining all available filter choices', () => {
    const result = aggregateUsage(payload(rows), 'alpha')
    expect(result.totals).toEqual({ consumedPoints: 2.5, billingRecords: 4, totalTokens: 200 })
    expect(result.models).toEqual([{ model: 'alpha', ...result.totals }])
    expect(result.daily.map(day => day.consumedPoints)).toEqual([0, 0, 2.5])
    expect(result.availableModels).toEqual(['beta', 'alpha', ''])
  })

  it('distinguishes selecting the blank model from selecting every model', () => {
    expect(aggregateUsage(payload(rows), '').totals)
      .toEqual({ consumedPoints: 4, billingRecords: 3, totalTokens: 300 })
  })

  it('retains a complete empty query for the caller to present as an empty state', () => {
    const result = aggregateUsage(payload(), null)
    expect(result.daily).toHaveLength(3)
    expect(result.daily.every(day => day.consumedPoints === 0 && day.billingRecords === 0 && day.totalTokens === 0))
      .toBe(true)
    expect(result.models).toEqual([])
    expect(result.availableModels).toEqual([])
    expect(result.totals).toEqual({ consumedPoints: 0, billingRecords: 0, totalTokens: 0 })
  })

  it('does not mutate the validated source rows', () => {
    const source = payload(rows.map(value => Object.freeze({ ...value })))
    const before = structuredClone(source)
    aggregateUsage(source, null)
    expect(source).toEqual(before)
  })

  it.each([
    { consumedPoints: Number.MAX_VALUE },
    { billingRecords: Number.MAX_SAFE_INTEGER },
    { totalTokens: Number.MAX_SAFE_INTEGER },
  ])('rejects overflow while summing records %#', (values) => {
    expect(() => aggregateUsage(payload([row(values), row(values)]), null))
      .toThrow('Usage totals exceed numeric limits')
  })
})
