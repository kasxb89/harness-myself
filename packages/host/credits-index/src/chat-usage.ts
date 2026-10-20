/** Exact-request chat-model charges read from the signed-in account's gateway ledger. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { apiUrl, normalizeApiBaseUrl } from './api-url.ts'

/** One gateway identity persisted with an assistant attempt, never a credential. */
export interface ChatUsageRequest {
  readonly requestId: ProviderRequestId
  readonly apiBaseUrl: string
}

/** Missing receipts prevent a partial subset from being presented as a total. */
export interface ChatUsageSelection {
  readonly requests: readonly ChatUsageRequest[]
  readonly complete: boolean
}

/** Chat model charges exclude separately billed image/video tools. */
export interface ChatUsagePayload {
  readonly scope: 'chat-model'
  readonly status: 'settled' | 'pending' | 'unavailable'
  readonly points?: number
  readonly settledRequests: number
  readonly totalRequests: number
}

/** Unavailable reads do not expose gateway diagnostics or fabricate an amount. */
export interface ChatUsageFailure {
  readonly ok: false
  readonly code: 'CHAT_USAGE_UNAVAILABLE' | 'CHAT_USAGE_ACCESS_DENIED' | 'CHAT_USAGE_IDENTITY_MISMATCH' | 'CHAT_USAGE_INVALID_DATA' | 'CHAT_USAGE_CONVERSION_UNAVAILABLE'
}

/** Account and request selection are owned by the Host, not browser parameters. */
export interface ChatUsageReadOptions {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly account: { readonly id: string }
  readonly upstreamToken: string | undefined
  readonly selection: ChatUsageSelection
  readonly signal?: AbortSignal
  /** Host-owned receipt cache and global ledger concurrency owner. */
  readonly ledger?: ChatUsageLedger
}

/** Exact receipt lookup; an absent ledger row remains pending. */
export type ChatReceiptResult = { readonly ok: true; readonly quota: number | undefined } | ChatUsageFailure

/** Verified account and server-owned conversion settings for a bounded read interval. */
export type ChatUsageContext = { readonly ok: true; readonly quotaPerUnit: number; readonly exchangeRate: number } | ChatUsageFailure

/** Shared, login-scoped settled-quota cache with bounded receipt-read concurrency. */
export class ChatUsageLedger {
  private readonly settled = new Map<string, { expires: number; quota: number }>()
  private readonly flights = new Map<string, Promise<ChatReceiptResult>>()
  private readonly active = new Set<Promise<ChatReceiptResult>>()
  private contextValue: { key: string; expires: number; value: ChatUsageContext } | undefined
  private contextFlight: { key: string; promise: Promise<ChatUsageContext> } | undefined
  private epoch = 0

  /** @param options - Current deployment's cache lifetime and shared concurrency bound. */
  constructor(private readonly options: { readonly ttlMs: number; readonly concurrency: number }) {}

  /** Clear current-login billing results; old requests cannot repopulate them. */
  clear(): void {
    this.epoch++; this.settled.clear(); this.flights.clear()
    this.contextValue = undefined; this.contextFlight = undefined
  }

  /**
   * Coalesce current-account verification and status reads across chat views.
   * @param key - Exact configured endpoint and current account identity.
   * @param read - Reads and verifies the account and server conversion parameters.
   * @returns Verified context for this bounded cache interval, or a safe uncached failure.
   */
  async context(key: string, read: () => Promise<ChatUsageContext>): Promise<ChatUsageContext> {
    if (this.contextValue?.key === key && this.contextValue.expires > Date.now()) return this.contextValue.value
    if (this.contextFlight?.key === key) return this.contextFlight.promise
    const epoch = this.epoch
    const promise = read().then((value) => {
      if (value.ok && epoch === this.epoch) this.contextValue = { key, expires: Date.now() + this.options.ttlMs, value }
      return value
    })
    const flight = { key, promise }
    this.contextFlight = flight
    try { return await promise } finally { if (this.contextFlight === flight) this.contextFlight = undefined }
  }

  /**
   * Reuse an exact settled receipt or one shared bounded read.
   * @param key - Account, endpoint and exact receipt identity.
   * @param read - Read-only operation, owned by the Host login lifetime.
   * @returns Authoritative quota, pending absence, or a safe failure.
   */
  async read(key: string, read: () => Promise<ChatReceiptResult>): Promise<ChatReceiptResult> {
    const now = Date.now()
    for (const [id, cached] of this.settled) if (cached.expires <= now) this.settled.delete(id)
    const cached = this.settled.get(key)
    if (cached !== undefined) return { ok: true, quota: cached.quota }
    const pending = this.flights.get(key)
    if (pending !== undefined) return pending
    const epoch = this.epoch
    const operation = (async (): Promise<ChatReceiptResult> => {
      while (this.active.size >= this.options.concurrency) await Promise.race(this.active)
      if (epoch !== this.epoch) return { ok: false, code: 'CHAT_USAGE_UNAVAILABLE' }
      // Distinct reads occupy distinct slots even if their source shares a promise.
      const running = (async () => await read())()
      this.active.add(running)
      let result: ChatReceiptResult
      try { result = await running } finally { this.active.delete(running) }
      if (epoch === this.epoch && result.ok && result.quota !== undefined) {
        this.settled.set(key, { expires: Date.now() + this.options.ttlMs, quota: result.quota })
      }
      return result
    })()
    this.flights.set(key, operation)
    try { return await operation } finally { if (this.flights.get(key) === operation) this.flights.delete(key) }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function receipt(value: unknown): ChatUsageRequest | undefined {
  const response = record(record(value)?.response)
  const candidate = record(response?.gatewayReceipt)
  if (candidate?.kind !== 'oneapi' || candidate.version !== 1 || typeof candidate.apiBaseUrl !== 'string'
    || candidate.apiBaseUrl.length > 2048
    || typeof candidate.requestId !== 'string' || !/^[A-Za-z\d_.-]{1,64}$/u.test(candidate.requestId)) return undefined
  try { normalizeApiBaseUrl(candidate.apiBaseUrl.replace(/\/v1\/?$/u, '')) } catch (_unsafeReceiptEndpoint: unknown) { return undefined }
  return { requestId: brandString<ProviderRequestId>(candidate.requestId), apiBaseUrl: candidate.apiBaseUrl }
}

/**
 * Collect exact gateway receipts from committed assistant messages and attempts.
 * @param events - One turn or session's committed events, including failed attempts.
 * @returns Deduplicated requests and whether every recorded attempt has correlation evidence.
 */
export function deriveChatUsageRequests(events: readonly SessionEvent[]): ChatUsageSelection {
  const requests = new Map<string, ChatUsageRequest>()
  let attempts = 0
  let complete = true
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    attempts++
    const chunks = event.data.stream.flatMap(frame => frame.type === 'chunk' && frame.chunk.type === 'finish' ? [frame.chunk] : [])
    const found = chunks.length === 1 ? receipt(chunks[0]?.replayState) : undefined
    if (found === undefined) complete = false
    else requests.set(JSON.stringify([found.apiBaseUrl, found.requestId]), found)
  }
  return { requests: [...requests.values()], complete: complete && attempts > 0 }
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

async function ledgerJson(response: Response): Promise<Record<string, unknown> | undefined> {
  if (response.body === null) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 1024 * 1024) return undefined
      chunks.push(next.value)
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } finally {
    await reader.cancel()
  }
}

function payload(status: ChatUsagePayload['status'], settledRequests: number, totalRequests: number, points?: number): { ok: true; payload: ChatUsagePayload } {
  return { ok: true, payload: { scope: 'chat-model', status, settledRequests, totalRequests, ...points === undefined ? {} : { points } } }
}

/**
 * Read settled quota by exact request ids and convert using current instance settings.
 * @param options - Trusted account token and durable requests; no balance-delta attribution.
 * @returns A complete settled amount, pending settlement, or an unavailable read without partial totals.
 */
export async function readChatUsage(options: ChatUsageReadOptions): Promise<{ ok: true; payload: ChatUsagePayload } | ChatUsageFailure> {
  const totalRequests = options.selection.requests.length
  if (!options.selection.complete || totalRequests === 0) return payload('unavailable', 0, totalRequests)
  const userId = /^\d+$/u.test(options.account.id) ? Number(options.account.id) : Number.NaN
  if (!Number.isSafeInteger(userId) || userId <= 0 || options.upstreamToken === undefined || options.upstreamToken === '') {
    return { ok: false, code: 'CHAT_USAGE_UNAVAILABLE' }
  }
  let expectedBase: string
  try {
    expectedBase = normalizeApiBaseUrl(options.baseUrl)
    if (options.selection.requests.some(request => normalizeApiBaseUrl(request.apiBaseUrl.replace(/\/v1\/?$/u, '')) !== expectedBase)) {
      return payload('unavailable', 0, totalRequests)
    }
  } catch (_invalidReceiptEndpoint: unknown) {
    return payload('unavailable', 0, totalRequests)
  }
  const signal = options.signal === undefined ? AbortSignal.timeout(options.timeoutMs)
    : AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  let accessDenied = false
  const read = async (path: string, authenticated: boolean): Promise<Record<string, unknown> | undefined> => {
    const response = await fetch(apiUrl(expectedBase, path), {
      headers: { accept: 'application/json', ...authenticated ? { authorization: `Bearer ${options.upstreamToken}` } : {} },
      redirect: 'error', signal,
    })
    if (response.status === 401 || response.status === 403) accessDenied = true
    if (!response.ok) { await response.body?.cancel(); return undefined }
    return ledgerJson(response)
  }
  const unavailable = (): ChatUsageFailure => ({ ok: false, code: accessDenied ? 'CHAT_USAGE_ACCESS_DENIED' : 'CHAT_USAGE_UNAVAILABLE' })
  try {
    const readContext = async (): Promise<ChatUsageContext> => {
      const self = await read('/api/user/self', true)
      if (self?.success !== true || record(self.data) === undefined) return unavailable()
      if (record(self.data)?.id !== userId) return { ok: false, code: 'CHAT_USAGE_IDENTITY_MISMATCH' }
      const status = await read('/api/status', false)
      const settings = record(status?.data)
      const quotaPerUnit = settings?.quota_per_unit
      const exchangeRate = settings?.usd_exchange_rate
      if (status?.success !== true || typeof quotaPerUnit !== 'number' || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0
        || typeof exchangeRate !== 'number' || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
        return { ok: false, code: 'CHAT_USAGE_CONVERSION_UNAVAILABLE' }
      }
      return { ok: true, quotaPerUnit, exchangeRate }
    }
    const context = options.ledger === undefined ? await readContext()
      : await options.ledger.context(JSON.stringify([expectedBase, userId]), readContext)
    if (!context.ok) return context
    const unique = [...new Map(options.selection.requests.map(request => [request.requestId, request])).values()]
    const readReceipt = async (request: ChatUsageRequest): Promise<ChatReceiptResult> => {
      let consumed = 0
      let total: number | undefined
      let quota = 0
      for (let page = 1; ; page++) {
        const query = new URLSearchParams({ request_id: request.requestId, type: '2', p: String(page), page_size: '100' })
        const body = await read(`/api/log/self?${query.toString()}`, true)
        const data = record(body?.data)
        if (body?.success !== true || data === undefined) return unavailable()
        if (data.page !== page || data.page_size !== 100 || !integer(data.total) || data.total > 10_000
          || total !== undefined && data.total !== total || !Array.isArray(data.items)
          || data.items.length !== Math.min(100, data.total - consumed)) return { ok: false, code: 'CHAT_USAGE_INVALID_DATA' }
        total = data.total
        for (const value of data.items) {
          const row = record(value)
          if (row?.user_id !== userId || row.type !== 2 || row.request_id !== request.requestId || !integer(row.quota)) {
            return { ok: false, code: 'CHAT_USAGE_INVALID_DATA' }
          }
          quota += row.quota
          if (!Number.isSafeInteger(quota)) return { ok: false, code: 'CHAT_USAGE_INVALID_DATA' }
        }
        consumed += data.items.length
        if (consumed === total) break
      }
      return { ok: true, quota: consumed > 0 ? quota : undefined }
    }
    const results: ChatReceiptResult[] = []
    const ledger = options.ledger
    if (ledger === undefined) {
      for (const request of unique) results.push(await readReceipt(request))
    } else {
      results.push(...await Promise.all(unique.map(request => ledger.read(
        JSON.stringify([expectedBase, userId, request.requestId]), () => readReceipt(request),
      ))))
    }
    let quota = 0
    let settledRequests = 0
    for (const result of results) {
      if (!result.ok) return result
      if (result.quota === undefined) continue
      quota += result.quota
      if (!Number.isSafeInteger(quota)) return { ok: false, code: 'CHAT_USAGE_INVALID_DATA' }
      settledRequests++
    }
    if (settledRequests !== unique.length) return payload('pending', settledRequests, unique.length)
    const points = quota / context.quotaPerUnit * context.exchangeRate * 1000
    if (!Number.isFinite(points) || points < 0) return { ok: false, code: 'CHAT_USAGE_INVALID_DATA' }
    return payload('settled', settledRequests, unique.length, points)
  } catch (_unavailableLedgerRead: unknown) {
    return unavailable()
  }
}
