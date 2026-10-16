/** Read-only account usage aggregated from the signed-in user's billing logs. */

import { apiUrl } from './api-url.ts'

/** Inclusive Unix-second window selected by the client in its display timezone. */
export interface UsageWindow {
  readonly start: number
  readonly end: number
}

/** One hourly model aggregate; billing records can include task adjustments. */
export interface UsageRow {
  readonly timestamp: number
  readonly model: string
  readonly billingRecords: number
  readonly consumedPoints: number
  readonly totalTokens: number
}

/** Usage response fields; consumed points do not subtract refunds. */
export interface UsagePayload extends UsageWindow {
  readonly rows: UsageRow[]
  readonly asOf: string
  readonly delayMinutes: 0
}

/** An unavailable read never supplies partial data or a fabricated zero. */
export interface UsageFailure {
  readonly ok: false
  readonly code: 'INVALID_REQUEST' | 'USAGE_UNAVAILABLE' | 'USAGE_ACCESS_DENIED' | 'USAGE_IDENTITY_MISMATCH' | 'USAGE_INVALID_DATA' | 'USAGE_CONVERSION_UNAVAILABLE'
  readonly message: string
}

/** Inputs owned by the host; the browser cannot choose an account or token. */
export interface UsageReadOptions extends UsageWindow {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly account: { readonly id: string; readonly phone: string }
  readonly upstreamToken: string | undefined
}

/**
 * Validate a single inclusive window of at most 31 days and reject account selectors.
 * @param params - Query parameters from the local HTTP request.
 * @returns Parsed seconds or an actionable request failure.
 */
export function parseUsageWindow(params: URLSearchParams): { ok: true; window: UsageWindow } | UsageFailure {
  if ([...params.keys()].some(key => key !== 'start' && key !== 'end')
    || params.getAll('start').length !== 1 || params.getAll('end').length !== 1) {
    return { ok: false, code: 'INVALID_REQUEST', message: '使用量查询仅接受 start 和 end 时间参数。' }
  }
  const startText = params.get('start') ?? ''
  const endText = params.get('end') ?? ''
  const start = Number(startText)
  const end = Number(endText)
  if (!/^\d+$/.test(startText) || !/^\d+$/.test(endText)
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start <= 0 || end > 253_402_300_799 || end < start || end - start >= 31 * 86_400) {
    return { ok: false, code: 'INVALID_REQUEST', message: '请选择不超过 31 天的有效时间范围，时间参数须为 Unix 秒整数。' }
  }
  return { ok: true, window: { start, end } }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validOther(value: string): boolean {
  if (value === '') return true
  try { return record(JSON.parse(value)) !== null } catch (_invalidOther: unknown) {
    // Metadata is serialized JSON, never executable or an alternate billing amount.
    return false
  }
}

interface UsageSourceResponse {
  readonly status: number
  readonly body: Record<string, unknown> | null
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

async function readJson(options: UsageReadOptions, path: string, token?: string): Promise<UsageSourceResponse> {
  const response = await fetch(apiUrl(options.baseUrl, path), {
    headers: { accept: 'application/json', ...token === undefined ? {} : { authorization: `Bearer ${token}` } },
    signal: AbortSignal.timeout(options.timeoutMs), redirect: 'error',
  })
  return { status: response.status, body: response.ok ? record(await response.json()) : null }
}

function unavailable(): UsageFailure {
  return { ok: false, code: 'USAGE_UNAVAILABLE', message: '暂时无法读取此账号的使用量，请稍后重试。' }
}

/**
 * Read the current account's paginated consumption logs and aggregate by hour and model.
 * @param options - Trusted session identity, user access token, API root, and selected window.
 * @returns Complete validated rows with live quota conversion, or a visible failure without partial data.
 */
export async function readAccountUsage(options: UsageReadOptions): Promise<{ ok: true; payload: UsagePayload } | UsageFailure> {
  const id = /^\d+$/.test(options.account.id) ? Number(options.account.id) : Number.NaN
  if (!positiveId(id) || options.upstreamToken === undefined || options.upstreamToken === '') return unavailable()
  let accessDenied = false
  const unreadable = (): UsageFailure => accessDenied
    ? { ok: false, code: 'USAGE_ACCESS_DENIED', message: '统计读取暂未开通，请联系管理员，或重新登录后重试。' }
    : unavailable()
  const invalid: UsageFailure = { ok: false, code: 'USAGE_INVALID_DATA', message: '使用量数据不完整或格式异常，请稍后重试。' }
  const read = async (path: string, token?: string): Promise<Record<string, unknown> | null> => {
    const response = await readJson(options, path, token)
    if (response.status === 403) accessDenied = true
    return response.body
  }

  let pointsPerQuota: number
  try {
    const self = await read('/api/user/self', options.upstreamToken)
    const account = record(self?.data)
    if (self?.success !== true || account === null) return unreadable()
    if (account.id !== id) {
      return { ok: false, code: 'USAGE_IDENTITY_MISMATCH', message: '使用量账号校验失败，请退出后重新登录。' }
    }
  } catch (_unavailableIdentity: unknown) {
    return unreadable()
  }
  try {
    const status = await read('/api/status')
    const settings = record(status?.data)
    if (status?.success !== true || settings === null) throw new Error('status unavailable')
    const quotaPerUnit = settings.quota_per_unit
    const exchangeRate = settings.usd_exchange_rate
    if (typeof quotaPerUnit !== 'number' || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0
      || typeof exchangeRate !== 'number' || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      throw new Error('conversion unavailable')
    }
    pointsPerQuota = exchangeRate * 1000 / quotaPerUnit
    if (!Number.isFinite(pointsPerQuota) || pointsPerQuota <= 0) throw new Error('conversion unavailable')
  } catch (_unavailableConversion: unknown) {
    const failure = unreadable()
    if (failure.code === 'USAGE_ACCESS_DENIED') return failure
    return { ok: false, code: 'USAGE_CONVERSION_UNAVAILABLE', message: '积分换算配置暂不可用，请稍后重试。' }
  }

  const groups = new Map<string, { timestamp: number; model: string; billingRecords: number; quota: number; totalTokens: number }>()
  const requestIds = new Set<string>()
  let total: number | undefined
  let consumed = 0
  try {
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({
        type: '2', p: String(page), page_size: '100',
        start_timestamp: String(options.start), end_timestamp: String(options.end),
      })
      const body = await read(`/api/log/self?${query.toString()}`, options.upstreamToken)
      const data = record(body?.data)
      if (body?.success !== true || data === null) return unreadable()
      if (data.page !== page || data.page_size !== 100 || !nonnegativeInteger(data.total) || data.total > 100_000
        || (total !== undefined && data.total !== total) || !Array.isArray(data.items)) return invalid
      total = data.total
      const expected = Math.min(100, total - consumed)
      if (expected < 0 || data.items.length !== expected) return invalid
      for (const [index, value] of data.items.entries()) {
        const row = record(value)
        if (row === null || row.id !== consumed + index + 1 || row.user_id !== id || row.type !== 2
          || !nonnegativeInteger(row.created_at) || row.created_at < options.start || row.created_at > options.end
          || typeof row.model_name !== 'string' || !nonnegativeInteger(row.quota)
          || !nonnegativeInteger(row.prompt_tokens) || !nonnegativeInteger(row.completion_tokens)
          || typeof row.other !== 'string' || row.other.length > 262_144) return invalid
        if (!validOther(row.other)) return invalid
        if (row.request_id !== undefined) {
          if (typeof row.request_id !== 'string') return invalid
          if (row.request_id !== '') {
            if (requestIds.has(row.request_id)) return invalid
            requestIds.add(row.request_id)
          }
        }
        const timestamp = Math.floor(row.created_at / 3600) * 3600
        const groupKey = JSON.stringify([timestamp, row.model_name])
        const group = groups.get(groupKey) ?? { timestamp, model: row.model_name, billingRecords: 0, quota: 0, totalTokens: 0 }
        group.billingRecords++
        group.quota += row.quota
        group.totalTokens += row.prompt_tokens + row.completion_tokens
        if (!Number.isSafeInteger(group.quota) || !Number.isSafeInteger(group.totalTokens)) return invalid
        groups.set(groupKey, group)
      }
      consumed += data.items.length
      if (consumed === total) break
    }
  } catch (_unreadableLogs: unknown) {
    return unreadable()
  }
  const rows: UsageRow[] = []
  for (const { quota, ...group } of groups.values()) {
    const consumedPoints = quota * pointsPerQuota
    if (!Number.isFinite(consumedPoints)) return invalid
    rows.push({ ...group, consumedPoints })
  }
  rows.sort((left, right) => left.timestamp - right.timestamp || left.model.localeCompare(right.model))
  return { ok: true, payload: { rows, start: options.start, end: options.end, asOf: new Date().toISOString(), delayMinutes: 0 } }
}
