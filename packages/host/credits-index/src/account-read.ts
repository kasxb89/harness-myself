/** Login-scoped bounded account reads; callers own authenticated refresh and replay. */
import { apiUrl } from './api-url.ts'

/** Caller-authorized GET or fixed read-only receipt POST, with one rejected-access refresh. */
export type AccountReadRequest = (path: string, authenticated: boolean, signal: AbortSignal, body?: string) => Promise<Response>
/** Existing account GET callers share the same compatible read transport. */
export type AccountGetRequest = AccountReadRequest

/** Safe observable account-read failure without remote bodies or credentials. */
export class AccountReadError extends Error {
  constructor(readonly reason: 'auth' | 'access' | 'rate_limited' | 'network' | 'timeout' | 'protocol' | 'upstream' | 'cancelled',
    readonly httpStatus?: number, readonly retryAfterSeconds?: number) {
    super(`Account GET ${reason}`)
    this.name = 'AccountReadError'
  }
}

/** Decoded successful GET, including its actual HTTP status. */
export interface AccountReadResult {
  readonly status: number
  readonly body: Record<string, unknown> | undefined
}

/**
 * Resolve Retry-After against the server's Date when available.
 * @param headers - Response headers from the exact rejected GET.
 * @param now - Local wall-clock fallback only when no server Date is available.
 * @returns Required delay in seconds, or undefined for an absent/invalid declaration.
 */
export function accountRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after')?.trim()
  if (raw === undefined) return undefined
  if (/^\d+(?:\.\d+)?$/u.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) ? seconds : undefined
  }
  const until = Date.parse(raw)
  const server = Date.parse(headers.get('date') ?? '')
  return Number.isFinite(until) ? Math.max(0, (until - (Number.isFinite(server) ? server : now)) / 1000) : undefined
}

/**
 * Decode a bounded account response, retaining structured transport and HTTP facts.
 * @param request - Caller-authorized GET transport.
 * @param path - Relative GET route under the configured backend.
 * @param authenticated - Whether the caller should attach its current access credential.
 * @param signal - Owning operation's cancellation.
 * @param body - Encoded JSON for the fixed read-only receipt batch; absent for GET.
 * @returns Successful status and decoded object, or a typed safe failure.
 */
export async function readAccountResponse(request: AccountGetRequest, path: string, authenticated: boolean,
  signal: AbortSignal, body?: string): Promise<AccountReadResult> {
  let status: number | undefined
  try {
    signal.throwIfAborted()
    if (body !== undefined && (path !== '/api/log/self/batch' || !authenticated)) throw new AccountReadError('protocol')
    const response = await request(path, authenticated, signal, body)
    status = response.status
    if (!response.ok) {
      const retry = accountRetryAfter(response.headers)
      // Cancellation of an unread error body must not wait for an SDK tee consumer.
      void response.body?.cancel().catch(() => undefined)
      throw new AccountReadError(status === 401 ? 'auth' : status === 403 ? 'access'
        : status === 429 ? 'rate_limited' : status === 408 || status === 504 ? 'timeout' : 'upstream', status, retry)
    }
    if (response.body === null) throw new AccountReadError('protocol', status)
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 1024 * 1024) throw new AccountReadError('protocol', status)
        chunks.push(next.value)
      }
    } finally {
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AccountReadError('protocol', status)
    return { status, body: value as Record<string, unknown> }
  } catch (error: unknown) {
    if (error instanceof AccountReadError) throw error
    const cause = error !== null && typeof error === 'object' && 'cause' in error ? error.cause : undefined
    const timeout = (value: unknown): boolean => value !== null && typeof value === 'object'
      && ('name' in value && value.name === 'TimeoutError' || 'code' in value
        && ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(value.code)))
    throw new AccountReadError(timeout(error) || timeout(cause) || timeout(signal.reason) ? 'timeout'
      : signal.aborted ? 'cancelled' : error instanceof SyntaxError ? 'protocol' : 'network', status)
  }
}

/**
 * Legacy standalone GET transport; product consumers inject their authorized account reader.
 * @param baseUrl - Validated deployment root.
 * @param token - Captured standalone access credential.
 * @returns GET and fixed read-only batch transport which never follows redirects.
 */
export function accountGetRequest(baseUrl: string, token: string | undefined): AccountGetRequest {
  return async (path, authenticated, signal, body) => await fetch(apiUrl(baseUrl, path), {
    headers: { accept: 'application/json', ...authenticated ? { authorization: `Bearer ${token ?? ''}` } : {},
      ...body === undefined ? {} : { 'content-type': 'application/json' } },
    ...body === undefined ? {} : { method: 'POST', body },
    redirect: 'error', signal,
  })
}

function signalTimeout(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason
  return reason !== null && typeof reason === 'object' && 'name' in reason && reason.name === 'TimeoutError'
}

interface Flight {
  readonly key: string
  readonly scope: string
  readonly controller: AbortController
  readonly run: () => Promise<AccountReadResult>
  readonly promise: Promise<AccountReadResult>
  readonly resolve: (value: AccountReadResult) => void
  readonly reject: (error: unknown) => void
  waiters: number
}

/** Per-login pacing, shared 429 cooldown and cancellable coalesced GET admission. */
export class AccountReadScheduler {
  private readonly flights = new Map<string, Flight>()
  private readonly queue: Flight[] = []
  private readonly scopes = new Map<string, { next: number; cooldown: number }>()
  private readonly running = new Set<Flight>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly now: () => number

  /** @param options - Validated concurrency, pacing, fallback cooldown and optional deterministic clock. */
  constructor(private readonly options: { concurrency: number; minIntervalMs: number; failureCooldownMs: number; now?: () => number }) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1
      || !Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0
      || !Number.isFinite(options.failureCooldownMs) || options.failureCooldownMs <= 0) throw new Error('Invalid account GET scheduling configuration')
    this.now = options.now ?? (() => performance.now())
  }

  /** Abort old login reads and remove cached pacing; active slots drain before new admission. */
  reset(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const flight of this.flights.values()) flight.controller.abort()
    for (const flight of this.queue.splice(0)) this.finish(flight, new AccountReadError('cancelled'))
    this.flights.clear()
    this.scopes.clear()
  }

  /** Stop admission, cancel reads and wait for the caller-owned HTTP operations to settle. */
  async dispose(): Promise<void> {
    this.closed = true
    this.reset()
    await Promise.allSettled([...this.running].map(flight => flight.promise))
  }

  /**
   * Read one exact GET, sharing work without one cancelled observer aborting another.
   * @param input - Login scope, exact route, owner signal and authorized GET transport.
   * @returns Shared decoded response or a safe typed failure with any retry delay.
   */
  read(input: {
    scope: string
    path: string
    authenticated: boolean
    signal: AbortSignal
    request: AccountGetRequest
    body?: string
  }): Promise<AccountReadResult> {
    if (this.closed || input.signal.aborted) {
      return Promise.reject(new AccountReadError(signalTimeout(input.signal) ? 'timeout' : 'cancelled'))
    }
    const state = this.scopes.get(input.scope)
    if (state !== undefined && state.cooldown > this.now()) {
      return Promise.reject(new AccountReadError('rate_limited', 429, Math.ceil((state.cooldown - this.now()) / 1000)))
    }
    const key = JSON.stringify([input.scope, input.path, input.authenticated, input.body])
    let flight = this.flights.get(key)
    if (flight?.controller.signal.aborted) { this.flights.delete(key); flight = undefined }
    if (flight === undefined) {
      const controller = new AbortController()
      const pending = Promise.withResolvers<AccountReadResult>()
      flight = { key, scope: input.scope, controller, ...pending, waiters: 0,
        run: () => readAccountResponse(input.request, input.path, input.authenticated, controller.signal, input.body) }
      // A detached observer can leave before rejection; the owning flight still settles.
      void flight.promise.catch(() => undefined)
      this.flights.set(key, flight)
      this.queue.push(flight)
    }
    const owned = flight
    owned.waiters++
    const observed = new Promise<AccountReadResult>((resolve, reject) => {
      let settled = false
      const release = (): void => {
        if (settled) return
        settled = true
        input.signal.removeEventListener('abort', abort)
        if (--owned.waiters === 0) { owned.controller.abort(); this.pump() }
      }
      const abort = (): void => { release(); reject(new AccountReadError(signalTimeout(input.signal) ? 'timeout' : 'cancelled')) }
      input.signal.addEventListener('abort', abort, { once: true })
      void owned.promise.then((value) => { release(); resolve(value) }, (error: unknown) => {
        release(); reject(error instanceof Error ? error : new AccountReadError('network'))
      })
      if (input.signal.aborted) abort()
    })
    this.pump()
    return observed
  }

  private finish(flight: Flight, error?: unknown, result?: AccountReadResult): void {
    if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key)
    if (error !== undefined) flight.reject(error)
    else if (result !== undefined) flight.resolve(result)
  }

  private pump(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.closed) return
    let wait = Infinity
    for (let index = 0; index < this.queue.length && this.running.size < this.options.concurrency;) {
      const flight = this.queue[index]
      if (flight === undefined) break
      const now = this.now()
      const state = this.scopes.get(flight.scope) ?? { next: now, cooldown: 0 }
      if (flight.controller.signal.aborted || state.cooldown > now) {
        this.queue.splice(index, 1)
        this.finish(flight, state.cooldown > now ? new AccountReadError('rate_limited', 429, Math.ceil((state.cooldown - now) / 1000)) : new AccountReadError('cancelled'))
        continue
      }
      if (state.next > now) { wait = Math.min(wait, state.next - now); index++; continue }
      this.queue.splice(index, 1)
      state.next = now + this.options.minIntervalMs
      this.scopes.set(flight.scope, state)
      this.running.add(flight)
      void flight.run().then((value) => { this.finish(flight, undefined, value) }, (error: unknown) => {
        if (error instanceof AccountReadError && error.reason === 'rate_limited') {
          const current = this.scopes.get(flight.scope)
          if (current === state) {
            current.cooldown = this.now() + Math.max(this.options.failureCooldownMs, (error.retryAfterSeconds ?? 0) * 1000)
          }
        }
        this.finish(flight, error)
      }).finally(() => { this.running.delete(flight); this.pump() })
    }
    if (Number.isFinite(wait) && this.running.size < this.options.concurrency) {
      this.timer = setTimeout(() => { this.timer = undefined; this.pump() }, Math.min(2_147_483_647, Math.max(1, wait)))
    }
  }
}
