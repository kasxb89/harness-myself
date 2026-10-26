/** Shared account renewal, cooldown and rotating-cookie recovery ownership. */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { writePrivateState } from './private-state-file.ts'
import { sessionBodyFailure, sessionHttpFailure, sessionTransportFailure, type SessionFailure } from './session-failure.ts'
import { accountRetryAfter } from './account-read.ts'

/** Masked account facts retained by the private account session. */
export interface StoredAccount {
  readonly id: string
  readonly phone: string
}

/** Existing private sign-in document; renewal does not change its storage format. */
export interface StoredSession {
  readonly token?: string | undefined
  readonly backendBaseUrl?: string | undefined
  readonly upstream?: {
    readonly token?: string | undefined
    readonly refresh?: string | undefined
    readonly expiresAt?: string | undefined
  } | undefined
  readonly relay?: { readonly key?: string | undefined; readonly id?: number | undefined } | undefined
  readonly expiresAt: string
  readonly account: StoredAccount
}

/** The deployed API accepts the preceding rotating secret for at most 30 seconds. */
const REFRESH_RECOVERY_WINDOW_MS = 30_000

const State = z.object({
  schema: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  failures: z.number().int().nonnegative(),
  retryAt: z.number().nonnegative(),
  uncertainUntil: z.number().nonnegative().nullable(),
  recoveryAttempts: z.number().int().nonnegative(),
  terminal: z.boolean(),
  accessRejected: z.boolean(),
}).strict()
type RenewalState = z.infer<typeof State>

/** Inputs owned by the Credits Host and its serialized session writer. */
interface RefreshOptions {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly retryBaseDelayMs: number
  readonly retryMaxDelayMs: number
  readonly recoveryRetryLimit: number
  readonly store: {
    readonly path: string
    read(): Promise<StoredSession | null>
    write(session: StoredSession & { token: string }): Promise<void>
  }
  readonly version: () => number
  readonly mutate: <T>(operation: () => Promise<T>) => Promise<T>
  readonly fetch: (cookie: string, signal: AbortSignal) => Promise<Response>
  readonly unauthorized: (session: StoredSession, version: number) => Promise<boolean>
  readonly unavailable: (reason: 'temporary' | 'storage' | 'recovery-exhausted') => void
  readonly now?: () => number
}

/**
 * Respect a valid HTTP delay and otherwise use bounded exponential backoff.
 * @param header - Retry-After seconds or an HTTP date, without a response body dependency.
 * @param failures - Consecutive failed exchanges for this credential epoch.
 * @param now - Current Unix milliseconds.
 * @param baseMs - Configured minimum delay.
 * @param maxMs - Configured ceiling for locally chosen backoff.
 * @returns milliseconds before another exchange may start; a valid server delay is never shortened.
 */
export function refreshRetryDelay(header: string | null, failures: number, now: number, baseMs: number, maxMs: number): number {
  const backoff = Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, failures - 1), 30))
  const value = header?.trim()
  if (value === undefined || value === '') return backoff
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value)
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000
      ? Math.max(backoff, seconds * 1000) : backoff
  }
  // Date.parse also accepts inputs such as "1.5"; these are not HTTP dates.
  if (!/^(?:[A-Za-z]{3,9}, .+ GMT|[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/u.test(value)) return backoff
  const until = Date.parse(value)
  return Number.isFinite(until) ? Math.max(backoff, until - now) : backoff
}

/** Read only the refresh cookie, never an arbitrary cookie or credential header. */
function refreshCookie(response: Response): string | undefined {
  const headers = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? '']
  for (const header of headers) {
    const match = /(?:^|[,;]\s*)new_api_refresh=([^;,\s]+)/u.exec(header)
    if (match?.[1] !== undefined && match[1] !== '') return match[1]
  }
  return undefined
}

/** A rejected HTTP status remains authoritative even when its unread body failed. */
async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch (_unreadableRejectedBody: unknown) { /* The caller owns the status decision. */ }
}

/** Keep the observed renewal status and its server-directed wait without reading an error body. */
function responseFailure(response: Response): SessionFailure {
  const retryAfterSeconds = accountRetryAfter(response.headers)
  return { ...sessionHttpFailure(response.status, 'renewal'),
    ...retryAfterSeconds === undefined ? {} : { retryAfterSeconds } }
}

/** One session file's renewal exchange and recovery timers, shared with other local Hosts. */
export class SessionRefresh {
  private readonly life = new AbortController()
  private readonly flights = new Map<string, { token: string; promise: Promise<StoredSession | null> }>()
  private readonly rejectionWrites = new Set<Promise<void>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly localCooldowns = new Map<string, number>()
  private readonly rejectedAccess = new Set<string>()
  private readonly now: () => number
  private readonly stateFile: string
  private observedFailure: { fingerprint: string; value: SessionFailure } | undefined

  constructor(private readonly options: RefreshOptions) {
    this.now = options.now ?? Date.now
    this.stateFile = `${options.store.path}.renewal`
  }

  /**
   * Join this Host's exchange or the file-owned exchange, without replaying a stale credential.
   * @param previous - Captured account and credential epoch of the consumer.
   * @returns the committed same-account session, or null while unavailable or signed out.
   */
  async refresh(previous: StoredSession): Promise<StoredSession | null> {
    if (this.life.signal.aborted || previous.token === undefined) return null
    if (previous.upstream?.refresh === undefined) {
      this.noteFailure(previous, { reason: 'renewal_unavailable', stage: 'renewal' })
      return null
    }
    const fingerprint = this.fingerprint(previous)
    const pending = this.flights.get(fingerprint)
    if (pending !== undefined) return await pending.promise
    if ((this.localCooldowns.get(fingerprint) ?? 0) > this.now()) return null
    const version = this.options.version()
    const timer = this.timers.get(fingerprint)
    if (timer !== undefined) { clearTimeout(timer); this.timers.delete(fingerprint) }
    const operation = Promise.resolve().then(async () => {
      try {
        await mkdir(dirname(this.stateFile), { recursive: true })
        return await withFileLock(this.stateFile, () => this.exchange(previous, version, fingerprint), {
          waitMs: this.options.timeoutMs + this.options.retryBaseDelayMs,
        })
      } catch (_unavailableRenewalStorage: unknown) {
        if (this.isStopped()) return null
        this.noteFailure(previous, { reason: 'storage', stage: 'renewal' })
        this.localCooldowns.set(fingerprint, this.now() + this.options.retryMaxDelayMs)
        this.options.unavailable('storage')
        return null
      }
    })
    this.flights.set(fingerprint, { token: previous.token, promise: operation })
    try { return await operation } finally { this.flights.delete(fingerprint) }
  }

  /**
   * Await exchanges of a captured local sign-in before server logout.
   * @param token - Product-local sign-in owner, not an upstream bearer token.
   * @returns the last committed same-account renewal, or null when none is running.
   */
  async pending(token: string): Promise<StoredSession | null> {
    const pending = [...this.flights.values()].filter(flight => flight.token === token)
    const settled = await Promise.all(pending.map(flight => flight.promise))
    return settled.find(session => session?.token === token) ?? null
  }

  /**
   * Stop other consumers reusing a bearer token explicitly rejected with HTTP401.
   * @param previous - Exact captured owner, refresh cookie and bearer token.
   */
  async rejectAccess(previous: StoredSession): Promise<void> {
    if (this.life.signal.aborted) return
    this.rejectedAccess.add(this.accessFingerprint(previous))
    const operation = (async () => {
      try {
        await mkdir(dirname(this.stateFile), { recursive: true })
        await withFileLock(this.stateFile, async () => {
          if (this.life.signal.aborted || !this.sameEpoch(await this.options.store.read(), previous)) return
          const state = await this.readState(this.fingerprint(previous))
          if (!this.isStopped()) await this.save({ ...state, accessRejected: true })
        }, { waitMs: this.options.timeoutMs + this.options.retryBaseDelayMs })
      } catch (_unavailableRejectionStorage: unknown) {
        if (!this.life.signal.aborted) this.options.unavailable('storage')
      }
    })()
    this.rejectionWrites.add(operation)
    try { await operation } finally { this.rejectionWrites.delete(operation) }
  }

  /**
   * Check known rejection state before using an unexpired bearer token.
   * Remain readable during teardown so existing owners can settle local records without starting renewal.
   * @param session - Captured current session; this does not verify it with the server.
   * @returns false for a rejected epoch or unreadable renewal metadata.
   */
  async canUseAccess(session: StoredSession): Promise<boolean> {
    if (this.knownAccessRejected(session)) return false
    try {
      const state = await this.readState(this.fingerprint(session))
      if (state.terminal || state.accessRejected) this.rejectedAccess.add(this.accessFingerprint(session))
      return !state.terminal && !state.accessRejected
    } catch (_unavailableRenewalState: unknown) {
      this.noteFailure(session, { reason: 'storage', stage: 'renewal' })
      return false
    }
  }

  /**
   * Read only an already observed rejection, without storage, renewal or network work.
   * @param session - Credential epoch used by a best-effort diagnostic.
   * @returns whether this Host already knows the access credential was rejected.
   */
  knownAccessRejected(session: StoredSession): boolean {
    return this.rejectedAccess.has(this.accessFingerprint(session))
  }

  /**
   * Read this Host's last safe failure for the exact captured renewal epoch; no I/O or token is returned.
   * @param session - Captured local login and upstream credential epoch.
   * @returns An observed safe failure, or undefined after another epoch or without a local observation.
   */
  lastFailure(session: StoredSession): SessionFailure | undefined {
    return this.observedFailure?.fingerprint === this.accessFingerprint(session) ? this.observedFailure.value : undefined
  }

  private noteFailure(session: StoredSession, value: SessionFailure): void {
    this.observedFailure = { fingerprint: this.accessFingerprint(session), value }
  }

  /** Stop recovery callbacks, abort owned HTTP work and await exchange/lock completion. */
  async dispose(): Promise<void> {
    this.life.abort('account renewal disposed')
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.allSettled([
      ...[...this.flights.values()].map(flight => flight.promise), ...this.rejectionWrites,
    ])
  }

  /** Whether owned work must stop before another effect. */
  private isStopped(): boolean { return this.life.signal.aborted }

  private fingerprint(session: StoredSession): string {
    return createHash('sha256').update(JSON.stringify([
      this.options.baseUrl, session.token, session.account.id, session.upstream?.refresh,
    ])).digest('hex')
  }

  private accessFingerprint(session: StoredSession): string {
    return createHash('sha256').update(JSON.stringify([
      this.fingerprint(session), session.upstream?.token, session.upstream?.expiresAt,
    ])).digest('hex')
  }

  private async readState(fingerprint: string): Promise<RenewalState> {
    let source: string
    try { source = await readFile(this.stateFile, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      source = ''
    }
    const stored = source === '' ? undefined : State.parse(JSON.parse(source))
    return stored?.fingerprint === fingerprint ? stored : {
      schema: 1, fingerprint, failures: 0, retryAt: 0, uncertainUntil: null, recoveryAttempts: 0,
      terminal: false, accessRejected: false,
    }
  }

  private sameEpoch(current: StoredSession | null, previous: StoredSession): current is StoredSession {
    return this.sameOwner(current, previous)
      && current.upstream?.refresh === previous.upstream?.refresh && current.upstream?.token === previous.upstream?.token
      && current.upstream?.expiresAt === previous.upstream?.expiresAt
  }

  private sameOwner(current: StoredSession | null, previous: StoredSession): current is StoredSession {
    return current !== null && current.token === previous.token && current.account.id === previous.account.id
      && (current.backendBaseUrl ?? this.options.baseUrl) === (previous.backendBaseUrl ?? this.options.baseUrl)
  }

  private async exchange(previous: StoredSession, version: number, fingerprint: string): Promise<StoredSession | null> {
    if (this.life.signal.aborted || version !== this.options.version()) return null
    const current = await this.options.store.read()
    if (this.isStopped()) return null
    if (!this.sameEpoch(current, previous)) return this.sameOwner(current, previous) ? current : null
    const state = await this.readState(fingerprint)
    if (this.isStopped()) return null
    if (state.terminal) { await this.options.unauthorized(previous, version); return null }
    if (state.retryAt > this.now()) {
      if (this.lastFailure(previous) === undefined) this.noteFailure(previous, { reason: 'renewal_unavailable', stage: 'renewal' })
      this.schedule(previous, state); return null
    }
    if (state.uncertainUntil !== null && (state.uncertainUntil <= this.now()
      || state.recoveryAttempts > this.options.recoveryRetryLimit)) {
      this.options.unavailable('recovery-exhausted')
      this.noteFailure(previous, { reason: 'renewal_unavailable', stage: 'renewal' })
      this.localCooldowns.set(fingerprint, Number.MAX_SAFE_INTEGER)
      return null
    }
    const started = this.now()
    const pending: RenewalState = { ...state, uncertainUntil: state.uncertainUntil ?? started + REFRESH_RECOVERY_WINDOW_MS,
      recoveryAttempts: state.recoveryAttempts + 1, retryAt: started + this.options.retryBaseDelayMs }
    // Persist uncertainty before dispatch so another Host cannot replay after a crash.
    await this.save(pending)
    if (this.isStopped()) return null
    let response: Response | undefined
    let failure: SessionFailure | undefined
    let phase: 'fetch' | 'decode' | 'commit' = 'fetch'
    try {
      const remaining = Math.max(1, (pending.uncertainUntil ?? started) - this.now())
      response = await this.options.fetch(previous.upstream?.refresh ?? '', AbortSignal.any([
        this.life.signal, AbortSignal.timeout(Math.min(this.options.timeoutMs, remaining)),
      ]))
      if (this.isStopped()) { await discard(response); return null }
      if (response.status === 401) {
        this.noteFailure(previous, responseFailure(response))
        this.rejectedAccess.add(this.accessFingerprint(previous))
        await discard(response)
        if (this.isStopped()) return null
        await this.save({ ...pending, terminal: true })
        if (this.isStopped()) return null
        await this.options.unauthorized(previous, version)
        return null
      }
      if (response.status === 429) {
        this.noteFailure(previous, responseFailure(response))
        await discard(response)
        if (this.isStopped()) return null
        const next: RenewalState = { ...pending, uncertainUntil: state.uncertainUntil,
          recoveryAttempts: state.recoveryAttempts, failures: state.failures + 1,
          retryAt: Math.min(Number.MAX_SAFE_INTEGER, this.now()
            + refreshRetryDelay(response.headers.get('retry-after'), state.failures + 1, this.now(),
              this.options.retryBaseDelayMs, this.options.retryMaxDelayMs)) }
        phase = 'commit'
        await this.save(next)
        if (this.isStopped()) return null
        this.options.unavailable('temporary')
        this.schedule(previous, next)
        return null
      }
      if (!response.ok) {
        failure = responseFailure(response)
        await discard(response); throw new Error('Account renewal temporarily unavailable')
      }
      phase = 'decode'
      const raw: unknown = await response.json()
      const body = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const data = body.data !== null && typeof body.data === 'object' ? body.data as Record<string, unknown> : {}
      const user = data.user !== null && typeof data.user === 'object' ? data.user as Record<string, unknown> : {}
      const expiry = data.access_expires_at
      if (body.success === false) {
        failure = { reason: 'upstream_rejected', stage: 'renewal', status: response.status }
        throw new Error('Account renewal response was rejected')
      }
      if (body.success !== true || typeof data.access_token !== 'string' || data.access_token.trim() === ''
        || typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry * 1000 <= this.now()
        || !Number.isFinite(new Date(expiry * 1000).getTime())) {
        failure = { reason: 'protocol', stage: 'renewal', status: response.status }
        throw new Error('Account renewal response was not confirmed')
      }
      if (String(user.id) !== previous.account.id) {
        failure = { reason: 'identity_mismatch', stage: 'renewal', status: response.status }
        throw new Error('Account renewal response was not confirmed')
      }
      const rotated = refreshCookie(response)
      const candidate: StoredSession = { ...previous, backendBaseUrl: this.options.baseUrl,
        upstream: { token: data.access_token, refresh: rotated ?? previous.upstream?.refresh,
          expiresAt: new Date(expiry * 1000).toISOString() } }
      phase = 'commit'
      const committed = await this.options.mutate(async () => {
        const latest = await this.options.store.read()
        if (this.life.signal.aborted || version !== this.options.version()) return null
        if (!this.sameEpoch(latest, previous)) return this.sameOwner(latest, previous) ? latest : null
        if (candidate.token === undefined) return null
        await this.options.store.write({ ...candidate, token: candidate.token })
        return candidate
      })
      if (committed !== null) await this.save({ ...pending, failures: 0, retryAt: 0, recoveryAttempts: 0,
        fingerprint: this.fingerprint(committed), accessRejected: false,
        uncertainUntil: rotated === undefined ? pending.uncertainUntil : null })
      if (committed !== null) this.rejectedAccess.delete(this.accessFingerprint(previous))
      if (committed !== null) this.observedFailure = undefined
      return committed
    } catch (error: unknown) {
      if (this.isStopped()) return null
      this.noteFailure(previous, response?.status === 401 ? { reason: 'storage', stage: 'renewal', status: 401 }
        : failure ?? (phase === 'commit' ? { reason: 'storage', stage: 'renewal' }
          : phase === 'decode' && response !== undefined ? sessionBodyFailure(error, 'renewal', response.status)
            : sessionTransportFailure(error, 'renewal')))
      if (response?.status === 401) {
        this.localCooldowns.set(fingerprint, this.now() + this.options.retryMaxDelayMs)
        this.options.unavailable('storage')
        return null
      }
      const failed: RenewalState = { ...pending, failures: state.failures + 1,
        retryAt: Math.min(Number.MAX_SAFE_INTEGER, this.now()
          + refreshRetryDelay(response?.headers.get('retry-after') ?? null, state.failures + 1, this.now(),
            this.options.retryBaseDelayMs, this.options.retryMaxDelayMs)) }
      await this.save(failed)
      if (this.isStopped()) return null
      this.options.unavailable('temporary')
      this.schedule(previous, failed)
      return null
    }
  }

  private async save(state: RenewalState): Promise<void> {
    await writePrivateState(this.stateFile, JSON.stringify(state) + '\n')
  }

  private schedule(previous: StoredSession, state: RenewalState): void {
    if (this.life.signal.aborted || state.terminal || state.uncertainUntil === null
      || state.recoveryAttempts > this.options.recoveryRetryLimit || state.retryAt >= state.uncertainUntil
      || state.uncertainUntil <= this.now() || this.timers.has(state.fingerprint)) return
    const delay = Math.max(1, state.retryAt - this.now())
    const timer = setTimeout(() => {
      this.timers.delete(state.fingerprint)
      void this.refresh(previous).catch((_failedBackgroundRenewal: unknown) => {
        if (!this.isStopped()) process.emitWarning('Account renewal background recovery stopped after a reporting failure.', {
          code: 'ACCOUNT_RENEWAL_BACKGROUND_FAILURE',
        })
      })
    }, delay)
    timer.unref()
    this.timers.set(state.fingerprint, timer)
  }
}
