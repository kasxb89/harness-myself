/** Current-login workload snapshots, independent of models, billing and Desktop presence. @module */
import { createHash, randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { apiUrl } from './api-url.ts'
import { readPublicStatus } from './public-status.ts'

/** Provider observations do not infer generation from a receipt, queue admission or local saving. */
export type GenerationActivityStage = 'preparing' | 'submitting' | 'accepted' | 'queued' | 'generating'
  | 'saving' | 'editing' | 'unknown'

/** Host-private login epoch; access and confirmed presence may be temporarily unavailable. */
export interface GenerationActivityAccount {
  readonly epoch: string
  readonly token?: string
  readonly runtimeSessionId?: string
}

/** One actual project execution or retained media attempt, without user content or upstream keys. */
export interface GenerationActivityTask {
  readonly sessionId?: SessionId
  readonly operationId: string
  readonly attemptId?: string
  readonly projectId?: string
  readonly shotId?: string
  readonly kind: 'image' | 'video'
  readonly stage: GenerationActivityStage
}

/** Synchronous observations never await reporting or affect provider cancellation. */
export interface GenerationActivityLease {
  /** @param stage - Actual current workflow observation. */
  update(stage: GenerationActivityStage): void
  /** @param outcome - Local execution settlement; absence preserves uncertain media as unknown. */
  end(outcome?: 'completed' | 'failed' | 'stopped' | 'unknown'): void
}

/** Reporting degradation, without attributing a creative failure to the server. */
export type GenerationActivityFailure = 'network' | 'timeout' | 'authorization' | 'unavailable' | 'unsupported'
  | 'protocol' | 'capacity'

/** Host-owned schedule and credential lookup; lookup never renews or invalidates a login. */
export interface GenerationActivityReporterOptions {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly heartbeatMs: number
  readonly minReportIntervalMs: number
  /** @returns Local login, optionally with usable access and its acknowledged presence UUID. */
  readonly account: () => GenerationActivityAccount | undefined
  /** @param reason - Reporting degradation only; creative work and login remain unchanged. */
  readonly unavailable: (reason: GenerationActivityFailure) => void
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

type ActivityKind = 'chat_activity' | 'project_run' | 'storyboard_task'
type LocalOutcome = 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
interface ActivityRow {
  readonly activity_id: string
  readonly kind: ActivityKind
  readonly work_state: 'active' | 'unknown' | 'ended'
  readonly phase: string
  readonly chat_session_id?: string
  readonly project_id?: string
  readonly shot_ids?: readonly string[]
  readonly attempt_id?: string
  readonly outcome?: LocalOutcome
}
interface ChatEntry { readonly id: string; references: number }
interface TaskEntry {
  readonly input: GenerationActivityTask
  readonly id: string
  readonly kind: 'project_run' | 'storyboard_task'
  stage: GenerationActivityStage
  references: number
}
interface Snapshot {
  readonly body: string
  readonly sequence: number
  readonly tombstones: readonly string[]
}
interface ActivityEpoch {
  readonly owner: string
  readonly chats: Map<SessionId, ChatEntry>
  readonly tasks: Map<string, TaskEntry>
  readonly unknown: Map<string, TaskEntry>
  readonly ended: Map<string, ActivityRow>
  untracked: number
  unknownUntracked: boolean
  everSent: boolean
  runtimeId: string | undefined
  sequence: number
  dirty: boolean
  stopped: boolean
  retry: Snapshot | undefined
}
interface Flight { readonly controller: AbortController; done: Promise<void> }

const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
const SNAPSHOT_PATH = '/api/client-activity/workload-snapshot'
const MAX_ROWS = 256
const MAX_BYTES = 262_144
const inactiveLease: GenerationActivityLease = { update: () => undefined, end: () => undefined }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Stable namespaces preserve logical cross-runtime deduplication without serializing source identifiers. */
function opaqueId(kind: string, value: string): string {
  return `${kind}_${createHash('sha256').update(JSON.stringify(['yunshu-workload-v1', kind, value])).digest('hex')}`
}

/** Late transports remain observed and cannot initiate another request after cancellation. */
async function interruptible<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const abort = Promise.withResolvers<never>()
  const stop = (): void => { abort.reject(signal.reason) }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try { return await Promise.race([pending, abort.promise]) }
  finally { signal.removeEventListener('abort', stop) }
}

class ReportingFailure extends Error {
  constructor(readonly reason: GenerationActivityFailure, readonly retryMs?: number) { super(reason) }
}

/** At most one report, bounded complete snapshots, monotonic scheduling and login-isolated leases. */
export class GenerationActivityReporter {
  private epoch: ActivityEpoch | undefined
  private closed = false
  private runtimeAvailable = false
  private support: boolean | undefined
  private failure: GenerationActivityFailure | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDue = Number.POSITIVE_INFINITY
  private nextChangeAt = 0
  private cooldownUntil = 0
  private flight: Flight | undefined
  private readonly operations = new Set<Flight>()
  private readonly statusUrl: string
  private readonly snapshotUrl: string

  /** @param options - Explicit reporting intervals, account lookup and independent transport. */
  constructor(private readonly options: GenerationActivityReporterOptions) {
    for (const [name, value] of Object.entries({ timeoutMs: options.timeoutMs, heartbeatMs: options.heartbeatMs,
      minReportIntervalMs: options.minReportIntervalMs })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new RangeError(`Generation activity ${name} must be a positive timer interval`)
      }
    }
    if (options.timeoutMs > 3000 || options.minReportIntervalMs > options.heartbeatMs) {
      throw new RangeError('Generation activity timeout must be at most 3000 ms and minimum interval must not exceed heartbeat')
    }
    this.statusUrl = apiUrl(options.baseUrl, '/api/status')
    this.snapshotUrl = apiUrl(options.baseUrl, SNAPSHOT_PATH)
    this.schedule(0)
  }

  /**
   * Count one local owner of a root chat without duplicating child agents or owned creative jobs.
   * @param expectedEpoch - Login epoch captured by the activity owner.
   * @param sessionId - Actual runtime root chat supplied by the Host integration.
   * @returns Idempotent synchronous release, inert after login change or disposal.
   */
  observeChat(expectedEpoch: string, sessionId: SessionId): () => void {
    const epoch = this.current(expectedEpoch)
    if (epoch === undefined || epoch.stopped) return () => undefined
    const chat = this.chat(epoch, sessionId)
    if (chat === undefined) return () => undefined
    chat.references += 1
    this.changed(epoch)
    let ended = false
    return () => {
      if (ended || epoch !== this.epoch || this.closed) return
      ended = true
      chat.references -= 1
      this.releaseChat(epoch, sessionId)
      this.changed(epoch)
    }
  }

  /**
   * Observe an actual project or retained submission attempt, independently of its root chat.
   * @param expectedEpoch - Login epoch captured before creative execution.
   * @param input - Stable identifiers; an attempt requires its original persisted UUID.
   * @returns Synchronous observer; an ended lease cannot restart the execution.
   */
  observeTask(expectedEpoch: string, input: GenerationActivityTask): GenerationActivityLease {
    const epoch = this.current(expectedEpoch)
    if (epoch === undefined || epoch.stopped) return inactiveLease
    if (input.attemptId === undefined && input.projectId === undefined
      || input.attemptId !== undefined && !UUID.test(input.attemptId)) {
      epoch.stopped = true
      this.flight?.controller.abort()
      this.warn('protocol')
      return inactiveLease
    }
    const key = JSON.stringify([input.operationId, input.projectId, input.shotId, input.attemptId])
    let entry = epoch.tasks.get(key)
    if (entry === undefined) {
      if (!this.capacity(epoch, 1 + (input.sessionId !== undefined && !epoch.chats.has(input.sessionId) ? 1 : 0))) return inactiveLease
      const previous = epoch.unknown.get(key)
      if (previous !== undefined) {
        epoch.unknown.delete(key)
        this.endRow(epoch, this.taskRow(previous), 'interrupted')
      }
      if (input.sessionId !== undefined) this.chat(epoch, input.sessionId)
      entry = { input, id: randomUUID(), kind: input.attemptId === undefined ? 'project_run' : 'storyboard_task',
        stage: input.stage, references: 0 }
      epoch.tasks.set(key, entry)
    }
    entry.references += 1
    this.changed(epoch)
    const task = entry
    let ended = false
    return {
      update: (stage) => {
        if (ended || epoch !== this.epoch || this.closed || task.stage === stage) return
        task.stage = stage
        this.changed(epoch)
      },
      end: (outcome = 'unknown') => {
        if (ended || epoch !== this.epoch || this.closed) return
        ended = true
        task.references -= 1
        if (task.references === 0) {
          epoch.tasks.delete(key)
          if (task.kind === 'storyboard_task' && outcome === 'unknown') {
            task.stage = 'unknown'
            epoch.unknown.set(key, task)
          } else this.endRow(epoch, this.taskRow(task), outcome === 'completed' ? 'succeeded'
            : outcome === 'failed' ? 'failed' : outcome === 'stopped' ? 'cancelled' : 'interrupted')
          if (input.sessionId !== undefined) this.releaseChat(epoch, input.sessionId)
        }
        this.changed(epoch)
      },
    }
  }

  /**
   * Mark legacy media without a durable attempt as uncollected, preserving other independent counters.
   * @param expectedEpoch - Original captured login epoch.
   * @returns Idempotent local settlement; an unknown result keeps task collection unavailable for this epoch.
   */
  observeUntrackedMedia(expectedEpoch: string): (outcome: 'completed' | 'failed' | 'stopped' | 'unknown') => void {
    const epoch = this.current(expectedEpoch)
    if (epoch === undefined || epoch.stopped) return () => undefined
    epoch.untracked += 1
    this.changed(epoch)
    let ended = false
    return (outcome) => {
      if (ended || epoch !== this.epoch || this.closed) return
      ended = true
      epoch.untracked -= 1
      if (outcome === 'unknown') epoch.unknownUntracked = true
      this.changed(epoch)
    }
  }

  /**
   * Pause freshness after a collector error without interpreting unobserved work as idle.
   * @param available - True only after complete runtime reconciliation or confirmed provider removal.
   */
  setRuntimeAvailable(available: boolean): void {
    if (this.closed || this.runtimeAvailable === available) return
    this.runtimeAvailable = available
    if (!available) this.flight?.controller.abort()
    else this.schedule(0)
  }

  /** Recheck the current epoch and schedule the latest state after presence or access becomes usable. */
  refresh(): void { this.schedule(0) }

  /** Drop the previous login's state and cancel its transport; late leases and acknowledgements are inert. */
  invalidate(): void {
    this.epoch = undefined
    this.failure = undefined
    this.cooldownUntil = 0
    this.nextChangeAt = 0
    this.flight?.controller.abort()
    this.schedule(0)
  }

  /** Stop admission, timers and transport, then wait until owned reporting can initiate no further work. */
  async dispose(): Promise<void> {
    this.closed = true
    this.epoch = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const operation of this.operations) operation.controller.abort()
    await Promise.all([...this.operations].map(operation => operation.done))
  }

  private readAccount(): GenerationActivityAccount | undefined {
    try { return this.options.account() }
    catch (_unconfirmedAccount: unknown) { this.warn('authorization'); return undefined }
  }

  private current(expectedEpoch: string): ActivityEpoch | undefined {
    if (this.closed) return undefined
    const account = this.readAccount()
    if (account === undefined || account.epoch !== expectedEpoch) return undefined
    if (this.epoch?.owner !== account.epoch) {
      this.failure = undefined
      this.cooldownUntil = 0
      this.nextChangeAt = 0
      this.flight?.controller.abort()
      this.epoch = { owner: account.epoch, chats: new Map(), tasks: new Map(), unknown: new Map(), ended: new Map(),
        untracked: 0, unknownUntracked: false, everSent: false, runtimeId: undefined,
        sequence: 0, dirty: true, stopped: false, retry: undefined }
    }
    return this.epoch
  }

  private chat(epoch: ActivityEpoch, id: SessionId): ChatEntry | undefined {
    let found = epoch.chats.get(id)
    if (found !== undefined) return found
    if (!this.capacity(epoch, 1)) return undefined
    found = { id: randomUUID(), references: 0 }
    epoch.chats.set(id, found)
    return found
  }

  private releaseChat(epoch: ActivityEpoch, id: SessionId): void {
    const entry = epoch.chats.get(id)
    if (entry === undefined || entry.references > 0
      || [...epoch.tasks.values(), ...epoch.unknown.values()].some(task => task.input.sessionId === id)) return
    epoch.chats.delete(id)
    this.endRow(epoch, { activity_id: entry.id, kind: 'chat_activity', work_state: 'active', phase: 'busy',
      chat_session_id: opaqueId('chat', id) }, 'interrupted')
  }

  private endRow(epoch: ActivityEpoch, row: ActivityRow, outcome: LocalOutcome): void {
    if (this.support === false && !epoch.everSent) return
    epoch.ended.set(row.activity_id, { ...row, work_state: 'ended', phase: 'ended', outcome })
  }

  private capacity(epoch: ActivityEpoch, additional: number): boolean {
    if (epoch.chats.size + epoch.tasks.size + epoch.unknown.size + epoch.ended.size + additional <= MAX_ROWS) return true
    epoch.stopped = true
    this.flight?.controller.abort()
    this.warn('capacity')
    return false
  }

  private changed(epoch: ActivityEpoch): void {
    epoch.dirty = true
    this.schedule(Math.max(0, this.nextChangeAt - performance.now()))
  }

  private taskRow(task: TaskEntry): ActivityRow {
    const input = task.input
    const uncertain = task.stage === 'unknown' || task.kind === 'storyboard_task' && task.stage === 'editing'
    const phase = uncertain ? 'unknown' : task.kind === 'project_run' && task.stage === 'submitting' ? 'preparing' : task.stage
    return { activity_id: task.id, kind: task.kind, work_state: uncertain ? 'unknown' : 'active', phase,
      ...input.sessionId === undefined ? {} : { chat_session_id: opaqueId('chat', input.sessionId) },
      ...input.projectId === undefined ? {} : { project_id: opaqueId('project', input.projectId) },
      ...input.attemptId === undefined ? {} : { attempt_id: input.attemptId },
      ...input.shotId === undefined || task.kind !== 'storyboard_task' ? {} : { shot_ids: [opaqueId('shot', input.shotId)] } }
  }

  private snapshot(epoch: ActivityEpoch): Snapshot {
    if (epoch.sequence === Number.MAX_SAFE_INTEGER) throw new ReportingFailure('capacity')
    const tasks = [...epoch.tasks.values(), ...epoch.unknown.values()]
    const collected = epoch.untracked === 0 && !epoch.unknownUntracked
    const include = (row: ActivityRow): boolean => collected || row.kind !== 'storyboard_task'
    const activities: ActivityRow[] = [...epoch.ended.values()].filter(include)
    for (const [sessionId, entry] of epoch.chats) {
      const busy = entry.references > 0 || tasks.some(task => task.input.sessionId === sessionId && task.stage !== 'unknown')
      activities.push({ activity_id: entry.id, kind: 'chat_activity', chat_session_id: opaqueId('chat', sessionId),
        work_state: busy ? 'active' : 'unknown', phase: busy ? 'busy' : 'unknown' })
    }
    activities.push(...tasks.map(task => this.taskRow(task)).filter(include))
    if (activities.length > MAX_ROWS) throw new ReportingFailure('capacity')
    const sequence = ++epoch.sequence
    const body = JSON.stringify({ schema_version: 1, runtime_session_id: epoch.runtimeId, sequence, complete: true,
      collections: { chat_activity: 'collected', project_run: 'collected', storyboard_task: collected ? 'collected' : 'not_collected',
        local_operation: 'not_collected', shots: 'not_collected' }, activities, shots: [] })
    if (Buffer.byteLength(body) > MAX_BYTES) throw new ReportingFailure('capacity')
    return { body, sequence, tombstones: [...epoch.ended.values()].filter(include).map(row => row.activity_id) }
  }

  private schedule(delay: number): void {
    if (this.closed) return
    const due = Math.max(performance.now() + delay, this.cooldownUntil)
    if (this.timer !== undefined && this.timerDue <= due) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timerDue = due
    this.timer = setTimeout(() => { this.timer = undefined; this.timerDue = Number.POSITIVE_INFINITY; this.dispatch() },
      Math.min(2_147_483_647, Math.max(0, due - performance.now())))
    this.timer.unref()
  }

  private dispatch(): void {
    if (this.closed || this.flight !== undefined) return
    const waitUntil = Math.max(this.cooldownUntil, this.nextChangeAt)
    if (performance.now() < waitUntil) { this.schedule(waitUntil - performance.now()); return }
    const account = this.readAccount()
    if (!this.runtimeAvailable || account === undefined) {
      this.schedule(this.options.heartbeatMs)
      return
    }
    const epoch = this.current(account.epoch)
    if (epoch === undefined || epoch.stopped || account.token === undefined || account.runtimeSessionId === undefined) {
      this.schedule(this.options.heartbeatMs)
      return
    }
    if (!UUID.test(account.runtimeSessionId)) { this.warn('protocol'); this.schedule(this.options.heartbeatMs); return }
    if (epoch.runtimeId !== account.runtimeSessionId) {
      epoch.runtimeId = account.runtimeSessionId
      epoch.sequence = 0
      epoch.retry = undefined
      epoch.dirty = true
    }
    this.nextChangeAt = performance.now() + this.options.minReportIntervalMs
    const operation: Flight = { controller: new AbortController(), done: Promise.resolve() }
    this.flight = operation
    this.operations.add(operation)
    operation.done = this.send(epoch, operation.controller.signal).finally(() => {
      this.operations.delete(operation)
      if (this.flight === operation) this.flight = undefined
      this.schedule(this.epoch?.dirty === true
        ? Math.max(0, this.nextChangeAt - performance.now()) : this.options.heartbeatMs)
    })
  }

  private async request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted()
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return (this.options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal })
    })
    void pending.then((response) => {
      if (signal.aborted) void response.body?.cancel().catch((_closedLateBody: unknown) => {})
    }, (_transportFailure: unknown) => { /* The same rejection is observed by the bounded await. */ })
    return await interruptible(pending, signal)
  }

  private async decoded(response: Response, signal: AbortSignal): Promise<unknown> {
    const result = await interruptible(readPublicStatus(() => Promise.resolve(response), signal), signal)
    if (!result.ok) throw new ReportingFailure(result.reason === 'invalid' ? 'protocol' : result.reason)
    return result.value
  }

  private async capability(signal: AbortSignal): Promise<boolean> {
    const response = await this.request(this.statusUrl, { headers: { accept: 'application/json' } }, signal)
    if (response.status === 404) { await interruptible(response.body?.cancel() ?? Promise.resolve(), signal); return false }
    const value = record(await this.decoded(response, signal))
    const capability = record(record(value?.data)?.client_activity_workload)
    if (value?.success !== true || capability === undefined) return false
    if (Object.keys(capability).length !== 4 || capability.schema_version !== 1 || capability.snapshot_path !== SNAPSHOT_PATH
      || capability.heartbeat_interval_seconds !== 30 || capability.workload_timeout_seconds !== 90) {
      throw new ReportingFailure('protocol')
    }
    return true
  }

  private async send(epoch: ActivityEpoch, owner: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([owner, AbortSignal.timeout(this.options.timeoutMs)])
    try {
      if (this.support !== true) {
        this.support = await this.capability(signal)
        if (!this.support) {
          if (!epoch.everSent) epoch.ended.clear()
          this.cooldownUntil = performance.now() + this.options.heartbeatMs
          this.warn('unsupported')
          return
        }
      }
      signal.throwIfAborted()
      if (!this.accepts(epoch, owner)) return
      const latest = this.readAccount()
      if (latest?.epoch !== epoch.owner || latest.token === undefined || latest.runtimeSessionId !== epoch.runtimeId) return
      const snapshot = epoch.retry !== undefined && !epoch.dirty ? epoch.retry : this.snapshot(epoch)
      epoch.retry = snapshot
      epoch.dirty = false
      epoch.everSent = true
      const response = await this.request(this.snapshotUrl, { method: 'POST',
        headers: { authorization: `Bearer ${latest.token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: snapshot.body }, signal)
      if (!response.ok) {
        const retry = response.headers.get('retry-after')
        const serverDate = Date.parse(response.headers.get('date') ?? '')
        const retryDate = Date.parse(retry ?? '')
        const retryMs = retry !== null && /^\d+$/u.test(retry) ? Number(retry) * 1000
          : Number.isFinite(serverDate) && Number.isFinite(retryDate) ? Math.max(0, retryDate - serverDate) : 0
        await interruptible(response.body?.cancel() ?? Promise.resolve(), signal)
        if (response.status === 404 || response.status === 405 || response.status === 501) {
          this.support = false
          throw new ReportingFailure('unsupported')
        }
        throw new ReportingFailure(response.status === 401 || response.status === 403 ? 'authorization'
          : response.status === 413 ? 'capacity' : response.status === 409 || response.status === 400 ? 'protocol' : 'unavailable',
        response.status === 429 ? Math.max(this.options.heartbeatMs, Math.min(2_147_483_647, retryMs)) : undefined)
      }
      const value = record(await this.decoded(response, signal))
      const data = record(value?.data)
      if (value?.success !== true || data?.schema_version !== 1 || data.accepted_sequence !== snapshot.sequence
        || data.disposition !== 'accepted' && data.disposition !== 'duplicate'
        || data.recorded !== (data.disposition === 'accepted') || !Number.isSafeInteger(data.server_time)
        || data.heartbeat_interval_seconds !== 30 || data.workload_timeout_seconds !== 90) throw new ReportingFailure('protocol')
      if (!this.accepts(epoch, owner)) return
      const current = this.readAccount()
      if (current?.epoch !== epoch.owner || current.runtimeSessionId !== epoch.runtimeId) return
      for (const id of snapshot.tombstones) epoch.ended.delete(id)
      epoch.retry = undefined
      this.failure = undefined
    } catch (error) {
      if (owner.aborted || this.closed || epoch !== this.epoch || !this.runtimeAvailable) return
      const reason = error instanceof ReportingFailure ? error.reason
        : signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'network'
      if (reason === 'capacity' || reason === 'protocol') epoch.stopped = true
      this.cooldownUntil = performance.now() + (error instanceof ReportingFailure && error.retryMs !== undefined
        ? error.retryMs : this.options.heartbeatMs)
      this.warn(reason)
    }
  }

  private accepts(epoch: ActivityEpoch, owner: AbortSignal): boolean {
    return epoch === this.epoch && !this.closed && !owner.aborted && this.runtimeAvailable
  }

  private warn(reason: GenerationActivityFailure): void {
    if (this.closed || this.failure === reason) return
    this.failure = reason
    try { this.options.unavailable(reason) }
    catch (_reportingFailure: unknown) {
      process.emitWarning('Generation activity reporting is unavailable; creative execution remains independent.', {
        code: 'GENERATION_ACTIVITY_REPORTING',
      })
    }
  }
}
