/** Login-owned chat receipt reads, shared flights and short-lived settled results. */
import type { AccountGetRequest, AccountReadScheduler } from './account-read.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ChatUsageLedger, readChatUsage, type ChatUsageFailure, type ChatUsagePayload, type ChatUsageSelection } from './chat-usage.ts'

/** Only local session and optional turn selectors cross the browser boundary. */
export interface ChatUsageQuery {
  readonly sessionId: SessionId
  readonly turn?: number
  readonly accountId?: string
}

/**
 * Reject duplicate, unknown and authority-bearing query parameters.
 * @param params - Browser query parameters.
 * @returns Validated selectors or undefined when any input is invalid.
 */
export function parseChatUsageQuery(params: URLSearchParams): ChatUsageQuery | undefined {
  if ([...params.keys()].some(key => !['session_id', 'turn', 'account_id'].includes(key))
    || params.getAll('session_id').length !== 1 || params.getAll('turn').length > 1 || params.getAll('account_id').length > 1) return undefined
  const sessionId = params.get('session_id') ?? ''
  const turn = params.get('turn')
  const accountId = params.get('account_id')
  if (!/^[A-Za-z\d_-]{1,128}$/u.test(sessionId)
    || turn !== null && (!/^[1-9]\d*$/u.test(turn) || !Number.isSafeInteger(Number(turn)))
    || accountId !== null && (!/^[1-9]\d*$/u.test(accountId) || !Number.isSafeInteger(Number(accountId)))) return undefined
  return { sessionId: SessionId(sessionId), ...turn === null ? {} : { turn: Number(turn) }, ...accountId === null ? {} : { accountId } }
}

/** Input captured from the current Host login and a live Session snapshot. */
export interface ChatUsageRead {
  readonly identity: string
  readonly account: { readonly id: string }
  readonly upstreamToken: string | undefined
  readonly sessionId: SessionId
  readonly selection: ChatUsageSelection
  readonly ongoing: boolean
  readonly request?: AccountGetRequest
  readonly turn?: number
}

type Outcome = { readonly ok: true; readonly payload: ChatUsagePayload } | ChatUsageFailure
const unavailable = (): Outcome => ({ ok: true, payload: { scope: 'chat-model', status: 'unavailable', settledRequests: 0, totalRequests: 0 } })

/** Shared work belongs to the login; a disconnected browser never cancels another reader. */
export class ChatUsageReader {
  private owner: { identity: string; controller: AbortController } | undefined
  private readonly settled = new Map<string, { expires: number; outcome: Outcome }>()
  private readonly flights = new Map<string, Promise<Outcome>>()
  private readonly operations = new Set<Promise<Outcome>>()
  private readonly ledger: ChatUsageLedger
  private closed = false

  /** @param options - Validated gateway, operation deadline, cache lifetime and concurrency. */
  constructor(private readonly options: {
    readonly baseUrl: string
    readonly timeoutMs: number
    readonly cacheTtlMs: number
    readonly concurrency: number
    readonly settledTtlMs?: number
    readonly pendingTtlMs?: number
    readonly failureCooldownMs?: number
    readonly scheduler?: AccountReadScheduler
  }) {
    this.ledger = new ChatUsageLedger({ ttlMs: options.cacheTtlMs, concurrency: options.concurrency,
      ...options.settledTtlMs === undefined ? {} : { settledTtlMs: options.settledTtlMs },
      ...options.pendingTtlMs === undefined ? {} : { pendingTtlMs: options.pendingTtlMs },
      ...options.failureCooldownMs === undefined ? {} : { failureCooldownMs: options.failureCooldownMs } })
  }

  /** Invalidate a changed or signed-out login and prevent old results repopulating caches. */
  reset(): void {
    this.owner?.controller.abort()
    this.owner = undefined
    this.settled.clear()
    this.flights.clear()
    this.ledger.clear()
  }

  /** Abort login-owned reads and await bounded network settlement during plugin disposal. */
  async dispose(): Promise<void> {
    this.closed = true
    this.reset()
    await Promise.allSettled([...this.operations])
  }

  /**
   * Resolve one selected session or completed turn through the account ledger.
   * @param input - Current login identity and durable session events owned by the Host.
   * @returns Settled model points, pending generation/settlement, or unavailable data.
   */
  async read(input: ChatUsageRead): Promise<Outcome> {
    if (this.closed) return unavailable()
    if (this.owner?.identity !== input.identity) {
      this.reset()
      this.owner = { identity: input.identity, controller: new AbortController() }
    }
    const owner = this.owner
    const { selection } = input
    if (input.ongoing) {
      return { ok: true, payload: { scope: 'chat-model', status: 'pending', settledRequests: 0, totalRequests: selection.requests.length } }
    }
    const key = JSON.stringify([input.sessionId, input.turn, selection])
    const now = performance.now()
    for (const [id, cached] of this.settled) if (cached.expires <= now) this.settled.delete(id)
    const cached = this.settled.get(key)
    if (cached !== undefined) return cached.outcome
    const pending = this.flights.get(key)
    if (pending !== undefined) return pending
    const operation = readChatUsage({
      baseUrl: this.options.baseUrl, timeoutMs: this.options.timeoutMs,
      account: input.account, upstreamToken: input.upstreamToken, selection,
      signal: owner.controller.signal, ledger: this.ledger, identity: input.identity,
      ...input.request === undefined ? {} : { request: input.request },
      ...this.options.scheduler === undefined ? {} : { scheduler: this.options.scheduler },
    }).then((outcome) => {
      if (owner !== this.owner || owner.controller.signal.aborted) return unavailable()
      {
        const ttl = !outcome.ok ? this.options.failureCooldownMs ?? 10_000
          : outcome.payload.status === 'settled' ? this.options.cacheTtlMs : this.options.pendingTtlMs ?? 5000
        this.settled.set(key, { expires: performance.now() + ttl, outcome })
      }
      return outcome
    }).catch((error: unknown) => {
      if (owner !== this.owner || owner.controller.signal.aborted) return unavailable()
      throw error
    })
    this.flights.set(key, operation)
    this.operations.add(operation)
    try { return await operation } finally {
      this.operations.delete(operation)
      if (this.flights.get(key) === operation) this.flights.delete(key)
    }
  }
}
