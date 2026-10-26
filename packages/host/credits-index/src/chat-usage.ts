/** Exact-request chat-model charges read from the signed-in account's gateway ledger. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { normalizeApiBaseUrl } from './api-url.ts'
import { AccountReadError, accountGetRequest, readAccountResponse, type AccountGetRequest, type AccountReadScheduler } from './account-read.ts'
import { chatUsageBatches, parseChatUsageBatch, parseChatUsageBatchCapability,
  type ChatUsageBatchCapability } from './chat-usage-batch.ts'

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
  readonly amountBasis?: 'consumption-logs'
  readonly settlementStatus?: 'unknown'
  readonly refundStatus?: 'unknown'
}

/** Unavailable reads do not expose gateway diagnostics or fabricate an amount. */
export interface ChatUsageFailure {
  readonly ok: false
  readonly code: 'CHAT_USAGE_UNAVAILABLE' | 'CHAT_USAGE_ACCESS_DENIED' | 'CHAT_USAGE_IDENTITY_MISMATCH' | 'CHAT_USAGE_INVALID_DATA' | 'CHAT_USAGE_CONVERSION_UNAVAILABLE' | 'CHAT_USAGE_AUTH_REQUIRED' | 'CHAT_USAGE_RATE_LIMITED' | 'CHAT_USAGE_NETWORK_ERROR' | 'CHAT_USAGE_TIMEOUT'
  readonly httpStatus?: number
  readonly retryAfterSeconds?: number
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
  /** Stable local login epoch; never an access token. */
  readonly identity?: string
  /** Caller-authorized GET, including one 401 refresh when supported. */
  readonly request?: AccountGetRequest
  /** Shared pacing and 429 cooldown across all current-login account GETs. */
  readonly scheduler?: AccountReadScheduler
}

/** Exact receipt lookup; an absent ledger row remains pending. */
export type ChatReceiptResult = { readonly ok: true; readonly quota: number | undefined; readonly absence?: 'unknown' } | ChatUsageFailure

/** Verified account and server-owned conversion settings for a bounded read interval. */
export type ChatUsageContext = {
  readonly ok: true
  readonly quotaPerUnit: number
  readonly exchangeRate: number
  readonly batch?: ChatUsageBatchCapability
} | ChatUsageFailure

/** Shared exact-receipt outcomes; settled records survive short view-cache expiration. */
export class ChatUsageLedger {
  private readonly settled = new Map<string, { expires: number; value: ChatReceiptResult }>()
  private readonly flights = new Map<string, Promise<ChatReceiptResult>>()
  private active = 0
  private readonly waiting: Array<{ enter: () => void; cancel: () => void }> = []
  private contextValue: { key: string; expires: number; value: ChatUsageContext } | undefined
  private contextFlight: { key: string; promise: Promise<ChatUsageContext> } | undefined
  private epoch = 0
  private readonly now: () => number

  /** @param options - Configurable context, settled/pending/failure lifetimes and shared concurrency. */
  constructor(private readonly options: {
    readonly ttlMs: number
    readonly concurrency: number
    readonly settledTtlMs?: number
    readonly pendingTtlMs?: number
    readonly failureCooldownMs?: number
    readonly now?: () => number
  }) {
    for (const value of [options.ttlMs, options.settledTtlMs ?? 3_600_000,
      options.pendingTtlMs ?? 5000, options.failureCooldownMs ?? 10_000]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid chat ledger cache lifetime')
    }
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error('Invalid chat ledger concurrency')
    this.now = options.now ?? (() => performance.now())
  }

  /** Maximum rolling workers for one history read; queued histories never fan out every receipt. */
  get concurrency(): number { return this.options.concurrency }

  /** Discard old-login outcomes and cancel queued work; active work retains its original owner signal. */
  clear(): void {
    this.epoch++; this.settled.clear(); this.flights.clear()
    this.contextValue = undefined; this.contextFlight = undefined
    for (const item of this.waiting.splice(0)) item.cancel()
  }

  /**
   * Coalesce verified context and briefly cool failed reads without caching balances.
   * @param key - API, account and local login epoch.
   * @param read - Authorized context read owned by the login.
   * @returns Verified conversion or a safe briefly cached failure.
   */
  async context(key: string, read: () => Promise<ChatUsageContext>): Promise<ChatUsageContext> {
    if (this.contextValue?.key === key && this.contextValue.expires > this.now()) return this.contextValue.value
    if (this.contextFlight?.key === key) return this.contextFlight.promise
    const now = this.now()
    for (const [id, cached] of this.settled) if (cached.expires <= now) this.settled.delete(id)
    const epoch = this.epoch
    const promise = read().then((value) => {
      if (epoch === this.epoch) {
        const ttl = value.ok ? this.options.ttlMs : this.options.failureCooldownMs ?? 10_000
        this.contextValue = { key, expires: this.now() + ttl, value }
      }
      return value
    })
    const flight = { key, promise }
    this.contextFlight = flight
    try { return await promise } finally { if (this.contextFlight === flight) this.contextFlight = undefined }
  }

  private acquire(signal: AbortSignal | undefined, epoch: number): Promise<void> {
    if (signal?.aborted || epoch !== this.epoch) return Promise.reject(new AccountReadError('cancelled'))
    if (this.active < this.options.concurrency) { this.active++; return Promise.resolve() }
    return new Promise((resolve, reject) => {
      const item = {
        enter: () => { signal?.removeEventListener('abort', cancel); this.active++; resolve() },
        cancel: () => { signal?.removeEventListener('abort', cancel); reject(new AccountReadError('cancelled')) },
      }
      const cancel = (): void => { const index = this.waiting.indexOf(item); if (index >= 0) this.waiting.splice(index, 1); item.cancel() }
      this.waiting.push(item)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  /**
   * Reuse a settled receipt, pending absence or failed read, sharing a bounded cancellable admission.
   * @param key - API, login epoch and exact receipt identity.
   * @param read - Authorized read-only receipt operation.
   * @param signal - Login owner's cancellation, including queued admission.
   * @returns Authoritative quota, pending absence, or a safe failure.
   */
  async read(key: string, read: () => Promise<ChatReceiptResult>, signal?: AbortSignal): Promise<ChatReceiptResult> {
    signal?.throwIfAborted()
    const now = this.now()
    const cached = this.settled.get(key)
    if (cached !== undefined && cached.expires > now) return cached.value
    if (cached !== undefined) this.settled.delete(key)
    const pending = this.flights.get(key)
    if (pending !== undefined) return pending
    const epoch = this.epoch
    const operation = (async (): Promise<ChatReceiptResult> => {
      await this.acquire(signal, epoch)
      try {
        signal?.throwIfAborted()
        if (epoch !== this.epoch) throw new AccountReadError('cancelled')
        const result = await read()
        if (epoch === this.epoch) {
          const lifetime = result.ok ? result.quota === undefined ? this.options.pendingTtlMs ?? 5000
            : this.options.settledTtlMs ?? 3_600_000
            : Math.max(this.options.failureCooldownMs ?? 10_000, (result.retryAfterSeconds ?? 0) * 1000)
          this.settled.set(key, { expires: this.now() + lifetime, value: result })
        }
        return result
      } finally { this.active--; this.waiting.shift()?.enter() }
    })()
    this.flights.set(key, operation)
    try { return await operation } finally { if (this.flights.get(key) === operation) this.flights.delete(key) }
  }

  /**
   * Reserve only uncached receipts for one bounded read-only batch, coalescing overlapping histories per id.
   * @param keys - Exact login-scoped receipt identities in one advertised-size batch.
   * @param read - Read only newly reserved keys in their original order.
   * @param signal - Login owner's cancellation, including queued admission.
   * @returns Cached, shared or freshly observed outcomes in the requested order.
   */
  async readBatch(keys: readonly string[], read: (missing: readonly string[]) => Promise<readonly ChatReceiptResult[]>,
    signal: AbortSignal): Promise<ChatReceiptResult[]> {
    signal.throwIfAborted()
    const epoch = this.epoch
    const missing: { key: string; pending: ReturnType<typeof Promise.withResolvers<ChatReceiptResult>> }[] = []
    const outcomes = keys.map((key) => {
      const cached = this.settled.get(key)
      if (cached !== undefined && cached.expires > this.now()) return Promise.resolve(cached.value)
      if (cached !== undefined) this.settled.delete(key)
      const flight = this.flights.get(key)
      if (flight !== undefined) return flight
      const pending = Promise.withResolvers<ChatReceiptResult>()
      this.flights.set(key, pending.promise)
      missing.push({ key, pending })
      return pending.promise
    })
    if (missing.length > 0) {
      void (async () => {
        let admitted = false
        try {
          await this.acquire(signal, epoch)
          admitted = true
          signal.throwIfAborted()
          if (epoch !== this.epoch) throw new AccountReadError('cancelled')
          const results = await read(missing.map(item => item.key))
          if (results.length !== missing.length) throw new AccountReadError('protocol')
          for (const [index, item] of missing.entries()) {
            const result = results[index]
            if (result === undefined) throw new AccountReadError('protocol')
            if (epoch === this.epoch) {
              const ttl = result.ok ? result.quota === undefined ? this.options.pendingTtlMs ?? 5000
                : this.options.settledTtlMs ?? 3_600_000
                : Math.max(this.options.failureCooldownMs ?? 10_000, (result.retryAfterSeconds ?? 0) * 1000)
              this.settled.set(item.key, { expires: this.now() + ttl, value: result })
            }
            item.pending.resolve(result)
          }
        } catch (error: unknown) {
          for (const item of missing) item.pending.reject(error)
        } finally {
          for (const item of missing) if (this.flights.get(item.key) === item.pending.promise) this.flights.delete(item.key)
          if (admitted) { this.active--; this.waiting.shift()?.enter() }
        }
      })()
    }
    return await Promise.all(outcomes)
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

/**
 * Map safe account transport facts into the chat ledger's public result vocabulary.
 * @param error - Typed GET failure without a remote body.
 * @returns User-readable classification and observed HTTP/retry metadata.
 */
export function chatUsageFailure(error: AccountReadError): ChatUsageFailure {
  return { ok: false, code: error.reason === 'auth' ? 'CHAT_USAGE_AUTH_REQUIRED' : error.reason === 'access' ? 'CHAT_USAGE_ACCESS_DENIED'
    : error.reason === 'rate_limited' ? 'CHAT_USAGE_RATE_LIMITED' : error.reason === 'network' ? 'CHAT_USAGE_NETWORK_ERROR'
      : error.reason === 'timeout' ? 'CHAT_USAGE_TIMEOUT' : error.reason === 'protocol' ? 'CHAT_USAGE_INVALID_DATA' : 'CHAT_USAGE_UNAVAILABLE',
  ...error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus },
  ...error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds } }
}

function payload(status: ChatUsagePayload['status'], settledRequests: number, totalRequests: number,
  points?: number, observed = false): { ok: true; payload: ChatUsagePayload } {
  return { ok: true, payload: { scope: 'chat-model', status, settledRequests, totalRequests, ...points === undefined ? {} : { points },
    ...observed ? { amountBasis: 'consumption-logs', settlementStatus: 'unknown', refundStatus: 'unknown' } : {} } }
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
  const signal = options.signal ?? new AbortController().signal
  const scope = options.identity ?? JSON.stringify([expectedBase, String(userId), createHash('sha256').update(options.upstreamToken).digest('hex')])
  const transport = options.request ?? accountGetRequest(expectedBase, options.upstreamToken)
  const request: AccountGetRequest = async (path, authenticated, activeSignal, body) => await transport(path, authenticated,
    AbortSignal.any([activeSignal, AbortSignal.timeout(options.timeoutMs)]), body)
  const read = async (path: string, authenticated: boolean, body?: string): Promise<Record<string, unknown> | undefined> => {
    const response = options.scheduler === undefined ? await readAccountResponse(request, path, authenticated, signal, body)
      : await options.scheduler.read({ scope, path, authenticated, signal, request, ...body === undefined ? {} : { body } })
    return response.body
  }
  const unavailable = (): ChatUsageFailure => ({ ok: false, code: 'CHAT_USAGE_UNAVAILABLE' })
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
      const batch = parseChatUsageBatchCapability(settings?.usage_receipts)
      return { ok: true, quotaPerUnit, exchangeRate, ...batch === undefined ? {} : { batch } }
    }
    const context = options.ledger === undefined ? await readContext()
      : await options.ledger.context(scope, async () => {
        try { return await readContext() } catch (error: unknown) {
          if (error instanceof AccountReadError && error.reason !== 'cancelled') return chatUsageFailure(error)
          throw error
        }
      })
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
    if (context.batch !== undefined) {
      const capability = context.batch
      for (const ids of chatUsageBatches(unique.map(item => item.requestId), capability)) {
        const lookup = new Map(ids.map(id => [JSON.stringify([scope, id]), id]))
        const readBatch = async (keys: readonly string[]): Promise<ChatReceiptResult[]> => {
          try {
            const missing = keys.map((key) => {
              const id = lookup.get(key)
              if (id === undefined) throw new AccountReadError('protocol')
              return id
            })
            const body = await read('/api/log/self/batch', true, JSON.stringify({ request_ids: missing }))
            const quotas = parseChatUsageBatch(body, missing, capability)
            return missing.map(id => ({ ok: true, quota: quotas.get(id),
              ...quotas.get(id) === undefined ? { absence: 'unknown' as const } : {} }))
          } catch (error: unknown) {
            if (error instanceof AccountReadError && error.reason !== 'cancelled') return keys.map(() => chatUsageFailure(error))
            throw error
          }
        }
        const keys = [...lookup.keys()]
        const observed = ledger === undefined ? await readBatch(keys) : await ledger.readBatch(keys, readBatch, signal)
        results.push(...observed)
        if (observed.some(result => !result.ok)) break
      }
    } else if (ledger === undefined) {
      for (const request of unique) results.push(await readReceipt(request))
    } else {
      let next = 0
      let stopped = false
      await Promise.all(Array.from({ length: Math.min(ledger.concurrency, unique.length) }, async () => {
        for (;;) {
          signal.throwIfAborted()
          if (stopped) return
          const index = next++
          const request = unique[index]
          if (request === undefined) return
          results[index] = await ledger.read(JSON.stringify([scope, request.requestId]), async () => {
            try { return await readReceipt(request) } catch (error: unknown) {
              if (error instanceof AccountReadError && error.reason !== 'cancelled') return chatUsageFailure(error)
              throw error
            }
          }, signal)
          if (!results[index].ok) { stopped = true; return }
        }
      }))

    }
    let quota = 0
    let settledRequests = 0
    const failed = results.find(result => !result.ok)
    if (failed !== undefined) return failed
    for (const result of results) {
      if (!result.ok) return result
      if (result.quota === undefined) continue
      quota += result.quota
      if (!Number.isSafeInteger(quota)) return { ok: false, code: 'CHAT_USAGE_INVALID_DATA' }
      settledRequests++
    }
    if (settledRequests !== unique.length) return context.batch === undefined
      ? payload('pending', settledRequests, unique.length) : payload('unavailable', settledRequests, unique.length, undefined, true)
    const points = quota / context.quotaPerUnit * context.exchangeRate * 1000
    if (!Number.isFinite(points) || points < 0) return { ok: false, code: 'CHAT_USAGE_INVALID_DATA' }
    return payload('settled', settledRequests, unique.length, points, context.batch !== undefined)
  } catch (error: unknown) {
    if (signal.aborted || error instanceof AccountReadError && error.reason === 'cancelled') throw error
    return error instanceof AccountReadError ? chatUsageFailure(error) : unavailable()
  }
}
