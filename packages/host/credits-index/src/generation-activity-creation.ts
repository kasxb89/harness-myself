/** Creation observations retain original project and attempt identities without counting parent runs as clips. @module */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CreativeOperation } from './creative-store.ts'
import type {
  CreationActivityOutcome, CreationActivityStage, CreationOperationActivity, CreationTaskObserver, VideoProjectActivity,
} from './creation-activity.ts'
import type { GenerationActivityLease, GenerationActivityReporter, GenerationActivityTask } from './generation-activity.ts'

/** Current local login; access tokens and creation content never enter the bridge. */
export interface GenerationCreationAccount {
  readonly epoch: string
  readonly accountId: string
  readonly sessionFingerprint: string
}

/** Account fencing and runtime-root attribution supplied by the Host integration. */
export interface GenerationActivityCreationOptions {
  readonly reporter: Pick<GenerationActivityReporter, 'observeTask' | 'observeUntrackedMedia'>
  readonly current: () => GenerationCreationAccount | undefined
  readonly rootSession: (rawSessionId: string) => SessionId | undefined
  /** Report collection degradation without affecting generation or account renewal. */
  readonly unavailable?: () => void
}

interface CapturedOwner extends GenerationCreationAccount { readonly sessionId?: SessionId }
interface ObservedTask {
  readonly owner: CapturedOwner
  readonly lease: GenerationActivityLease
  stage: CreationActivityStage
  ended: boolean
}
interface OperationRun {
  readonly operation: CreativeOperation
  readonly owner: CapturedOwner
  readonly kind: 'image' | 'video'
  readonly parent: ObservedTask
  readonly videoKey?: string
  readonly clips: Map<string, ObservedTask>
  readonly foreground: Set<ObservedTask>
  outcome?: CreationActivityOutcome
  closed: boolean
}

const inactiveObserver: CreationTaskObserver = () => undefined
const videoKey = (accountId: string, fingerprint: string, sessionId: string, projectId: string): string =>
  JSON.stringify([accountId, fingerprint, sessionId, projectId])
const sameAccount = (owner: GenerationCreationAccount, current: GenerationCreationAccount | undefined): boolean =>
  current !== undefined && owner.epoch === current.epoch && owner.accountId === current.accountId
  && owner.sessionFingerprint === current.sessionFingerprint
const interrupted = (stage: CreationActivityStage): CreationActivityOutcome =>
  stage === 'preparing' || stage === 'editing' ? 'stopped' : 'unknown'
const durableAttempt = (value: string | undefined): value is string =>
  value !== undefined && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)

/** Synchronous adapter for committed CreativeStore operations and actual executor phases. */
export class GenerationActivityCreation {
  private readonly operations = new Map<string, OperationRun>()
  private readonly endedOperations = new WeakSet<CreativeOperation>()
  private readonly projects = new Map<string, OperationRun>()
  private readonly observed = new Set<ObservedTask>()
  private closed = false
  private warned = false

  /** @param options - Current-login lookup, root attribution and independent activity reporter. */
  constructor(private readonly options: GenerationActivityCreationOptions) {}

  /**
   * Observe one committed live creation operation, separately from its media attempts.
   * @param event - Actual CreativeStore activation or release; retained records alone are never active.
   */
  operation(event: CreationOperationActivity): void {
    this.guard(() => { this.operationChanged(event) }, undefined)
  }

  /**
   * Capture one foreground execution; an absent creation operation remains independent media.
   * @param operation - Exact live invocation, or undefined when no project was associated.
   * @param kind - Actual executor media category.
   * @returns A contained observer, permanently inert after its end, account change or disposal.
   */
  task(operation: CreativeOperation | undefined, kind: 'image' | 'video'): CreationTaskObserver {
    return this.guard(() => this.foregroundObserver(operation, kind), inactiveObserver)
  }

  /**
   * Apply a project or clip phase to its already-live CreativeStore operation.
   * @param event - Original owning account, video project, durable attempt and observed phase.
   */
  project(event: VideoProjectActivity): void {
    this.guard(() => { this.projectChanged(event) }, undefined)
  }

  /** Release old-login observations; an unreadable lookup preserves the last known collection. */
  refresh(): void {
    this.guard(() => { this.reconcile() }, undefined)
  }

  /** End all local observations synchronously; later callbacks cannot create another lease. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const state of this.operations.values()) this.closeOperation(state, 'stopped')
    for (const observed of this.observed) this.end(observed, interrupted(observed.stage))
    this.operations.clear()
    this.projects.clear()
  }

  private guard<T>(run: () => T, fallback: T): T {
    try { return run() }
    catch (_unavailableObservation: unknown) {
      this.notifyUnavailable()
      return fallback
    }
  }

  private notifyUnavailable(): void {
    if (this.warned) return
    this.warned = true
    try {
      if (this.options.unavailable !== undefined) this.options.unavailable()
      else console.warn('Creation activity observation unavailable')
    } catch (_unavailableReporter: unknown) { /* Collection never changes the creation result. */ }
  }

  private reconcile(): GenerationCreationAccount | undefined {
    const current = this.options.current()
    for (const state of this.operations.values()) {
      if (!sameAccount(state.owner, current)) this.closeOperation(state, 'stopped')
    }
    for (const observed of this.observed) {
      if (!sameAccount(observed.owner, current)) this.end(observed, interrupted(observed.stage))
    }
    return current
  }

  private observe(owner: CapturedOwner, input: Omit<GenerationActivityTask, 'sessionId'>): ObservedTask {
    const observed: ObservedTask = { owner, stage: input.stage, ended: false,
      lease: this.options.reporter.observeTask(owner.epoch, { ...input,
        ...owner.sessionId === undefined ? {} : { sessionId: owner.sessionId } }) }
    this.observed.add(observed)
    return observed
  }

  private untracked(owner: CapturedOwner, stage: CreationActivityStage): ObservedTask {
    const release = this.options.reporter.observeUntrackedMedia(owner.epoch)
    const observed: ObservedTask = { owner, stage, ended: false,
      lease: { update: () => undefined, end: (outcome) => { release(outcome ?? 'unknown') } } }
    this.observed.add(observed)
    return observed
  }

  private update(observed: ObservedTask, stage: CreationActivityStage): void {
    if (observed.ended || observed.stage === stage) return
    observed.lease.update(stage)
    observed.stage = stage
  }

  private end(observed: ObservedTask, outcome: CreationActivityOutcome): void {
    if (observed.ended) return
    observed.ended = true
    this.observed.delete(observed)
    this.guard(() => { observed.lease.end(outcome) }, undefined)
  }

  private closeOperation(state: OperationRun, outcome: CreationActivityOutcome): void {
    if (state.closed) return
    state.closed = true
    this.endedOperations.add(state.operation)
    for (const observed of [...state.clips.values(), ...state.foreground]) this.end(observed, interrupted(observed.stage))
    this.end(state.parent, outcome)
    if (this.operations.get(state.operation.operationId) === state) this.operations.delete(state.operation.operationId)
    if (state.videoKey !== undefined && this.projects.get(state.videoKey) === state) this.projects.delete(state.videoKey)
  }

  private operationChanged(event: CreationOperationActivity): void {
    if (this.closed) return
    const current = this.reconcile()
    const operation = event.operation
    const existing = this.operations.get(operation.operationId)
    if (!event.active) {
      if (existing?.operation === operation) this.closeOperation(existing, existing.outcome ?? 'stopped')
      return
    }
    if (current === undefined || operation.owner.accountId !== current.accountId
      || operation.owner.sessionFingerprint !== current.sessionFingerprint || existing !== undefined
      || this.endedOperations.has(operation)) return
    const sessionId = this.options.rootSession(operation.owner.sessionId)
    const owner: CapturedOwner = { ...current, ...sessionId === undefined ? {} : { sessionId } }
    const key = event.videoProjectId === undefined ? undefined : videoKey(current.accountId,
      current.sessionFingerprint, operation.owner.sessionId, event.videoProjectId)
    const state: OperationRun = { operation, owner, kind: event.kind, closed: false,
      clips: new Map(), foreground: new Set(), ...key === undefined ? {} : { videoKey: key },
      parent: this.observe(owner, { operationId: operation.operationId, projectId: operation.projectId,
        kind: event.kind, stage: 'preparing' }) }
    this.operations.set(operation.operationId, state)
    if (key !== undefined) this.projects.set(key, state)
  }

  private foregroundObserver(operation: CreativeOperation | undefined, kind: 'image' | 'video'): CreationTaskObserver {
    if (this.closed) return inactiveObserver
    const current = this.reconcile()
    if (current === undefined) return inactiveObserver
    const state = operation === undefined ? undefined : this.operations.get(operation.operationId)
    if (operation !== undefined && (state?.operation !== operation || state.kind !== kind)) return inactiveObserver
    const owner: CapturedOwner = state?.owner ?? current
    let observed: ObservedTask | undefined
    let ended = false
    return (event) => {
      this.guard(() => {
        if (this.closed || ended) return
        if (state?.closed || !sameAccount(owner, this.options.current())) {
          ended = true
          if (observed !== undefined) this.end(observed, interrupted(observed.stage))
          return
        }
        if (observed === undefined) {
          const attemptId = operation?.operationId.slice(3)
          if (operation === undefined || !durableAttempt(attemptId)) {
            observed = this.untracked(owner, event.stage)
            if (operation !== undefined) this.notifyUnavailable()
          } else {
            observed = this.observe(owner, { operationId: operation.operationId, kind, stage: event.stage,
              projectId: operation.projectId, attemptId })
          }
        }
        state?.foreground.add(observed)
        this.update(observed, event.stage)
        if (state !== undefined) this.update(state.parent, event.stage)
        if (event.type === 'end') {
          ended = true
          if (state !== undefined) state.outcome = event.outcome
          state?.foreground.delete(observed)
          this.end(observed, event.outcome)
        }
      }, undefined)
    }
  }

  private projectChanged(event: VideoProjectActivity): void {
    if (this.closed) return
    this.reconcile()
    const state = this.projects.get(videoKey(event.accountId, event.sessionFingerprint, event.ownerSessionId, event.projectId))
    if (state === undefined || state.closed || !sameAccount(state.owner, this.options.current())) return
    if (event.shotId === undefined) {
      this.update(state.parent, event.stage)
      if (event.type === 'end') this.closeOperation(state, event.outcome)
      return
    }
    const key = JSON.stringify([event.shotId, event.attemptId])
    let observed = state.clips.get(key)
    if (observed === undefined) {
      if (durableAttempt(event.attemptId)) {
        observed = this.observe(state.owner, { operationId: state.operation.operationId,
          projectId: state.operation.projectId, shotId: event.shotId, attemptId: event.attemptId,
          kind: 'video', stage: event.stage })
      } else {
        observed = this.untracked(state.owner, event.stage)
        this.notifyUnavailable()
      }
      state.clips.set(key, observed)
    }
    this.update(observed, event.stage)
    if (event.type === 'end') this.end(observed, event.outcome)
  }
}
