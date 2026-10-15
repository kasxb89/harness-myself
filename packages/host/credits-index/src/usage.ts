/** Read-only account usage from new-api's hourly billing aggregates. */

import { readFile } from 'node:fs/promises'

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
  readonly delayMinutes: 5
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
  readonly creditsPerYuan: number
  readonly adminTokenFile: string
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

interface UsageSourceResponse {
  readonly status: number
  readonly body: Record<string, unknown> | null
}

interface ResolvedUsageAccount {
  readonly ok: true
  readonly id: number
  readonly username: string
  readonly token: string
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

async function readJson(options: UsageReadOptions, path: string, token?: string): Promise<UsageSourceResponse> {
  const response = await fetch(`${options.baseUrl}${path}`, {
    headers: { accept: 'application/json', ...token === undefined ? {} : { authorization: `Bearer ${token}` } },
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  return { status: response.status, body: response.ok ? record(await response.json()) : null }
}

function unavailable(): UsageFailure {
  return { ok: false, code: 'USAGE_UNAVAILABLE', message: '暂时无法读取此账号的使用量，请稍后重试。' }
}

/**
 * Read only the current product account, with an exact-account admin fallback.
 * @param options - Trusted session identity, service configuration, and validated window.
 * @returns All validated rows with one live conversion rate, or a visible failure; no state is written.
 */
export async function readAccountUsage(options: UsageReadOptions): Promise<{ ok: true; payload: UsagePayload } | UsageFailure> {
  const parsedId = /^\d+$/.test(options.account.id) ? Number(options.account.id) : Number.NaN
  const storedId = positiveId(parsedId) ? parsedId : null
  let id = storedId
  let accessDenied = false
  let resolvedAdmin: ResolvedUsageAccount | null = null
  const query = `start_timestamp=${String(options.start)}&end_timestamp=${String(options.end)}`
  let data: unknown = undefined
  let username: string | undefined

  const unreadable = (): UsageFailure => accessDenied
    ? { ok: false, code: 'USAGE_ACCESS_DENIED', message: '统计读取暂未开通，请联系管理员，或重新登录后重试。' }
    : unavailable()

  const read = async (path: string, token?: string): Promise<Record<string, unknown> | null> => {
    const response = await readJson(options, path, token)
    if (response.status === 403) accessDenied = true
    return response.body
  }

  const resolveAdminAccount = async (): Promise<ResolvedUsageAccount | UsageFailure> => {
    if (resolvedAdmin !== null) return resolvedAdmin
    try {
      const token = (await readFile(options.adminTokenFile, 'utf8')).trim()
      if (token === '') return unreadable()
      const keyword = encodeURIComponent(options.account.phone.replace(/[^0-9]/g, ''))
      if (keyword === '') return unreadable()
      const search = await read(`/api/user/search?keyword=${keyword}&p=1&page_size=100`, token)
      const searchData = record(search?.data)
      if (search?.success !== true || !Array.isArray(searchData?.items)) return unreadable()
      const matches = searchData.items.map(record).filter(item => item !== null && (storedId === null
        ? item.phone_e164 === options.account.phone
        : item.id === storedId))
      const match = matches.length === 1 ? matches[0] : null
      if (!positiveId(match?.id) || typeof match.username !== 'string' || match.username === '') return unreadable()
      resolvedAdmin = { ok: true, id: match.id, username: match.username, token }
      return resolvedAdmin
    } catch (error) {
      // Identity resolution is read-only; an unresolved account cannot be queried safely.
      void error
      return unreadable()
    }
  }

  if (id === null) {
    const canonical = await resolveAdminAccount()
    if (!canonical.ok) return canonical
    id = canonical.id
  }

  if (options.upstreamToken !== undefined && options.upstreamToken !== '') {
    try {
      const self = await read('/api/user/self', options.upstreamToken)
      const account = record(self?.data)
      if (self?.success === true && account !== null) {
        if (account.id !== id || (storedId === null && typeof account.phone_e164 === 'string'
          && account.phone_e164 !== options.account.phone)) {
          return { ok: false, code: 'USAGE_IDENTITY_MISMATCH', message: '使用量账号校验失败，请退出后重新登录。' }
        }
        const body = await read(`/api/data/self?${query}`, options.upstreamToken)
        if (body?.success === true && Array.isArray(body.data)) data = body.data
      }
    } catch (error) {
      // A lapsed user credential or unavailable self endpoint permits only the exact-account read below.
      void error
    }
  }

  if (data === undefined) {
    try {
      const canonical = await resolveAdminAccount()
      if (!canonical.ok) return canonical
      username = canonical.username
      const body = await read(`/api/data/?${query}&username=${encodeURIComponent(username)}`, canonical.token)
      if (body?.success !== true || !Array.isArray(body.data)) return unreadable()
      data = body.data
    } catch (error) {
      // This read has no side effects; failure leaves the account and its balance untouched.
      void error
      return unreadable()
    }
  }

  let pointsPerQuota: number
  try {
    const status = await read('/api/status')
    const settings = record(status?.data)
    if (status?.success !== true || settings === null) throw new Error('status unavailable')
    if (settings.enable_data_export !== true) {
      return { ok: false, code: 'USAGE_UNAVAILABLE', message: '当前服务未启用使用量统计，暂无可用分析数据。' }
    }
    const quotaPerUnit = settings.quota_per_unit
    const exchangeRate = settings.usd_exchange_rate
    if (typeof quotaPerUnit !== 'number' || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0
      || typeof exchangeRate !== 'number' || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      throw new Error('conversion unavailable')
    }
    pointsPerQuota = exchangeRate * options.creditsPerYuan / quotaPerUnit
    if (!Number.isFinite(pointsPerQuota) || pointsPerQuota <= 0) throw new Error('conversion unavailable')
  } catch (error) {
    // Without the live conversion settings no reported point amount is trustworthy.
    void error
    const failure = unreadable()
    if (failure.code === 'USAGE_ACCESS_DENIED') return failure
    return { ok: false, code: 'USAGE_CONVERSION_UNAVAILABLE', message: '积分换算配置暂不可用，请稍后重试。' }
  }

  const invalid: UsageFailure = { ok: false, code: 'USAGE_INVALID_DATA', message: '使用量数据不完整或格式异常，请稍后重试。' }
  if (!Array.isArray(data) || data.length > 100_000) return invalid
  const rows: UsageRow[] = []
  for (const value of data) {
    const row = record(value)
    if (row === null || !nonnegativeInteger(row.created_at)
      || row.created_at < options.start || row.created_at > options.end
      || typeof row.model_name !== 'string'
      || !nonnegativeInteger(row.count) || !nonnegativeInteger(row.quota) || !nonnegativeInteger(row.token_used)
      || (row.user_id !== undefined && row.user_id !== id)
      || (username !== undefined && row.username !== undefined && row.username !== username)) return invalid
    const consumedPoints = row.quota * pointsPerQuota
    if (!Number.isFinite(consumedPoints)) return invalid
    rows.push({
      timestamp: row.created_at,
      model: row.model_name,
      billingRecords: row.count,
      consumedPoints,
      totalTokens: row.token_used,
    })
  }
  rows.sort((left, right) => left.timestamp - right.timestamp || left.model.localeCompare(right.model))
  return {
    ok: true,
    payload: { rows, start: options.start, end: options.end, asOf: new Date().toISOString(), delayMinutes: 5 },
  }
}
