/** Account- and Session-owned reads for foreground media calls and visible projects. */
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CreativeProjectView } from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReadCreativeProjects } from './api.ts'

/** Immutable presentation facts for one explicitly addressed conversation. */
export interface CreativeSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'signed-out' | 'failed'
  readonly projects: readonly CreativeProjectView[]
  readonly refreshing: boolean
  readonly failure: 'invalid' | 'unavailable' | null
}

interface Bucket {
  readonly source: SnapshotStore<CreativeSnapshot>
  readonly visible: Set<symbol>
  revealed: boolean
}
interface Request {
  readonly sessionId: SessionId
  readonly abort: AbortController
  readonly epoch: number
  task: Promise<void>
  again: boolean
}

/** Deployment-owned read cadence and ordinary right-sidebar navigation. */
export interface CreativeControllerOptions {
  readonly pollIntervalMs: number
  /** @param sessionId - owning foreground conversation. @returns whether navigation was admitted. */
  readonly reveal: (sessionId: SessionId) => boolean
}

const EMPTY: CreativeSnapshot = { phase: 'idle', projects: [], refreshing: false, failure: null }
const SIGNED_OUT: CreativeSnapshot = { phase: 'signed-out', projects: [], refreshing: false, failure: null }
const MEDIA_TOOLS = new Set(['update_creation_plan', 'generate_image', 'generate_video', 'generate_video_project'])

function active(project: CreativeProjectView): boolean {
  return ['planned', 'running', 'saving', 'editing'].includes(project.status)
    || project.shots.some(shot => ['running', 'saving', 'editing'].includes(shot.status))
    || project.assets.some(asset => asset.status !== undefined && ['running', 'saving', 'editing'].includes(asset.status))
}

/** Owns read cancellation and keeps late account or Session results silent. */
export class CreativeController {
  private readonly buckets = new Map<SessionId, Bucket>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly pendingCalls = new Set<SessionEvent<'tool/call'>['data']['callId']>()
  private selected: SessionId | undefined
  private account: string | null = null
  private epoch = 0
  private foreground = true
  private request: Request | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  /** @param read - cancellable, read-only Host request. @param options - cadence and foreground navigation. */
  constructor(private readonly read: ReadCreativeProjects, private readonly options: CreativeControllerOptions) {}

  /**
   * Resolve one identity-stable source without starting a request.
   * @param sessionId - scope to observe.
   * @returns the conversation's project source.
   */
  source(sessionId: SessionId): ObservableSnapshot<CreativeSnapshot> { return this.bucket(sessionId).source }

  /**
   * Clear earlier account data before accepting a new identity.
   * @param accountId - authoritative signed-in account, or null while signed out/not yet known.
   */
  accountChanged(accountId: string | null): void {
    if (this.closed || accountId === this.account) return
    this.account = accountId
    this.epoch += 1
    this.pendingCalls.clear()
    this.stop()
    for (const bucket of this.buckets.values()) {
      bucket.revealed = false
      bucket.source.set(accountId === null ? SIGNED_OUT : EMPTY)
    }
    if (accountId !== null && this.selected !== undefined && this.foreground) void this.refresh(this.selected)
  }

  /**
   * Follow the conversation currently occupying the main panel.
   * @param sessionId - foreground conversation, absent on another page.
   */
  select(sessionId: SessionId | undefined): void {
    if (this.closed || this.selected === sessionId) return
    this.stop()
    this.pendingCalls.clear()
    this.selected = sessionId
    if (sessionId !== undefined && this.foreground && this.account !== null) void this.refresh(sessionId)
  }

  /**
   * Suspend reads while the application document is hidden.
   * @param visible - whether the application document is foreground-visible.
   */
  setForeground(visible: boolean): void {
    if (this.closed || visible === this.foreground) return
    this.foreground = visible
    this.stop()
    if (visible && this.selected !== undefined && this.account !== null) void this.refresh(this.selected)
  }

  /**
   * Supervise named media calls until their first actual project record becomes readable.
   * @param sessionId - event's conversation, which must still be foreground-selected.
   * @param event - ordinary logged call, result or turn boundary; no model prose is inspected.
   */
  observe(sessionId: SessionId, event: SessionEvent<'tool/call' | 'tool/result' | 'turn/end'>): void {
    if (this.closed || sessionId !== this.selected || this.account === null) return
    switch (event.type) {
      case 'tool/call':
        if (!MEDIA_TOOLS.has(event.data.name)) return
        this.pendingCalls.add(event.data.callId)
        break
      case 'tool/result':
        this.pendingCalls.delete(event.data.message.source.callId)
        break
      case 'turn/end':
        this.pendingCalls.clear()
        break
    }
    void this.refresh(sessionId)
  }

  /**
   * Hold visible supervision for one mounted tab occurrence.
   * @param sessionId - tab's fixed conversation.
   * @param visible - selected and expanded according to the official tab hook.
   * @param signal - official tab occurrence lifetime.
   * @returns idempotent release; hidden tabs keep data without polling.
   */
  watch(sessionId: SessionId, visible: boolean, signal: AbortSignal): () => void {
    if (this.closed || signal.aborted || !visible) return () => {}
    const bucket = this.bucket(sessionId)
    const id = Symbol()
    bucket.visible.add(id)
    if (sessionId === this.selected) void this.refresh(sessionId)
    const release = (): void => {
      bucket.visible.delete(id)
      signal.removeEventListener('abort', release)
      if (sessionId === this.selected && bucket.visible.size === 0) {
        bucket.revealed = true
        this.stop()
      }
    }
    signal.addEventListener('abort', release, { once: true })
    return release
  }

  /**
   * Re-read after a logged tool transition, reconnection, tab reveal or explicit refresh.
   * @param sessionId - conversation whose read is requested.
   * @returns completion of the current read; overlapping invalidations coalesce into one later read.
   */
  refresh(sessionId: SessionId): Promise<void> {
    if (this.closed || !this.foreground || this.account === null || sessionId !== this.selected) return Promise.resolve()
    this.clearTimer()
    if (this.request !== undefined) {
      this.request.again = true
      return this.request.task
    }
    const bucket = this.bucket(sessionId)
    const before = bucket.source.getSnapshot()
    bucket.source.set({ ...before, phase: before.projects.length === 0 ? 'loading' : before.phase, refreshing: true })
    const request: Request = { sessionId, abort: new AbortController(), epoch: this.epoch, task: Promise.resolve(), again: false }
    this.request = request
    const task = this.execute(request, bucket)
    request.task = task
    this.tasks.add(task)
    void task.finally(() => { this.tasks.delete(task) })
    return task
  }

  /** Stop supervision, abort reads and await owned work before completing plugin teardown. */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.pendingCalls.clear()
    this.stop()
    await Promise.all(this.tasks)
  }

  private async execute(request: Request, bucket: Bucket): Promise<void> {
    try {
      const result = await this.read(request.sessionId, request.abort.signal)
      if (!this.current(request)) return
      if (!result.ok) {
        if (result.code === 'signed-out') { this.accountChanged(null); return }
        bucket.source.set({ ...bucket.source.getSnapshot(), phase: 'failed', refreshing: false, failure: result.code })
        return
      }
      if (result.payload.accountId !== this.account) {
        // A Host account switch outruns the authoritative client account source; reveal no stale data.
        this.accountChanged(null)
        return
      }
      bucket.source.set({ phase: 'ready', projects: result.payload.projects, refreshing: false, failure: null })
      if (!bucket.revealed && result.payload.projects.length > 0) {
        bucket.revealed = this.options.reveal(request.sessionId)
      }
    } catch (_unexpectedReadFailure) {
      if (this.current(request)) {
        bucket.source.set({ ...bucket.source.getSnapshot(), phase: 'failed', refreshing: false, failure: 'unavailable' })
      }
    } finally {
      if (this.request === request) {
        this.request = undefined
        if (this.current(request)) {
          if (request.again) void this.refresh(request.sessionId)
          else this.schedule(request.sessionId)
        }
      }
    }
  }

  private current(request: Request): boolean {
    return !this.closed && !request.abort.signal.aborted && request.epoch === this.epoch
      && request.sessionId === this.selected && this.foreground && this.account !== null
  }
  private schedule(sessionId: SessionId): void {
    const bucket = this.bucket(sessionId)
    const pending = this.pendingCalls.size > 0
    const awaitingFirstRecord = pending && !bucket.revealed
    const visibleWork = bucket.visible.size > 0 && (pending || bucket.source.getSnapshot().projects.some(active))
    if (!awaitingFirstRecord && !visibleWork) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(sessionId) }, this.options.pollIntervalMs)
  }
  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
  private stop(): void {
    this.clearTimer()
    const current = this.request
    this.request = undefined
    current?.abort.abort()
    if (current !== undefined) {
      const bucket = this.bucket(current.sessionId)
      const previous = bucket.source.getSnapshot()
      bucket.source.set({ ...previous, phase: previous.phase === 'loading' ? 'idle' : previous.phase, refreshing: false })
    }
  }
  private bucket(sessionId: SessionId): Bucket {
    let bucket = this.buckets.get(sessionId)
    if (bucket === undefined) {
      bucket = { source: createSnapshotStore(this.account === null ? SIGNED_OUT : EMPTY), visible: new Set(), revealed: false }
      this.buckets.set(sessionId, bucket)
    }
    return bucket
  }
}
