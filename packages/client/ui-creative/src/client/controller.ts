/** Account- and Session-owned reads for foreground media calls and visible projects. */
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CreativePlanChange, CreativeProjectId, CreativeProjectView } from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { recoverCreativeImage, saveCreativePlan, uploadCreativeAsset, type CreativeRecoverResult,
  type CreativeUploadResult, type CreativeSaveResult, type ReadCreativeProjects } from './api.ts'

/** Immutable presentation facts for one explicitly addressed conversation. */
export interface CreativeSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'signed-out' | 'failed'
  readonly projects: readonly CreativeProjectView[]
  readonly refreshing: boolean
  readonly failure: 'invalid' | 'unavailable' | null
  /** Shared view selection, cleared with account ownership and retained independently for each conversation. */
  readonly selectedProjectId?: CreativeProjectId
  /** A retained shot in the selected project; absent when that project has no shots. */
  readonly selectedShotId?: string
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
const MEDIA_TOOLS = new Set(['update_creation_plan', 'generate_image', 'query_image_task', 'query_video_task',
  'generate_video', 'generate_video_project', 'edit_video'])

function active(project: CreativeProjectView): boolean {
  return ['running', 'saving', 'editing'].includes(project.status)
    || project.tasks.some(task => ['running', 'saving', 'editing'].includes(task.status))
    || project.shots.some(shot => ['running', 'saving', 'editing'].includes(shot.status))
    || project.assets.some(asset => asset.status !== undefined && ['running', 'saving', 'editing'].includes(asset.status))
}

function selection(projects: readonly CreativeProjectView[], projectId?: CreativeProjectId,
  shotId?: string): Pick<CreativeSnapshot, 'selectedProjectId' | 'selectedShotId'> {
  const project = projects.find(item => item.id === projectId) ?? projects[0]
  if (project === undefined) return {}
  const shot = (project.id === projectId ? project.shots.find(item => item.id === shotId) : undefined)
    ?? [...project.shots].sort((a, b) => a.order - b.order)[0]
  return { selectedProjectId: project.id, ...(shot === undefined ? {} : { selectedShotId: shot.id }) }
}

/** Owns read cancellation and keeps late account or Session results silent. */
export class CreativeController {
  private readonly buckets = new Map<SessionId, Bucket>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly mutations = new Set<AbortController>()
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
   * Select a retained project for every view of the currently owned conversation.
   * @param sessionId - currently selected conversation.
   * @param projectId - retained project to select, ignored when absent.
   */
  selectProject(sessionId: SessionId, projectId: string): void {
    if (this.closed || this.account === null || sessionId !== this.selected) return
    const bucket = this.bucket(sessionId)
    const before = bucket.source.getSnapshot()
    const project = before.projects.find(item => item.id === projectId)
    if (project === undefined || before.selectedProjectId === project.id) return
    const { selectedProjectId: _project, selectedShotId: _shot, ...rest } = before
    bucket.source.set({ ...rest, ...selection(before.projects, project.id) })
  }

  /**
   * Select only a shot belonging to the shared current project.
   * @param sessionId - currently selected conversation.
   * @param shotId - shot belonging to that conversation's selected project.
   */
  selectShot(sessionId: SessionId, shotId: string): void {
    if (this.closed || this.account === null || sessionId !== this.selected) return
    const bucket = this.bucket(sessionId)
    const before = bucket.source.getSnapshot()
    const current = selection(before.projects, before.selectedProjectId, before.selectedShotId)
    const project = before.projects.find(item => item.id === current.selectedProjectId)
    if (project === undefined || !project.shots.some(item => item.id === shotId) || before.selectedShotId === shotId) return
    bucket.source.set({ ...before, ...current, selectedShotId: shotId })
  }

  /**
   * Clear earlier account data before accepting a new identity.
   * @param accountId - authoritative signed-in account, or null while signed out/not yet known.
   */
  accountChanged(accountId: string | null): void {
    if (this.closed || accountId === this.account) return
    this.account = accountId
    this.epoch += 1
    this.cancelMutations()
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
    this.cancelMutations()
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

  /**
   * Save a free structured plan revision and publish it to every view of the same conversation.
   * @param sessionId - owning foreground conversation.
   * @param projectId - project being edited.
   * @param expectedRevision - revision captured when editing began.
   * @param change - one structured plan edit.
   * @param signal - editor lifetime cancellation.
   * @returns the confirmed save or a failure that preserves the draft.
   */
  async save(sessionId: SessionId, projectId: string, expectedRevision: string, change: CreativePlanChange,
    signal: AbortSignal): Promise<CreativeSaveResult> {
    const epoch = this.epoch
    const account = this.account
    if (this.closed || signal.aborted || account === null || sessionId !== this.selected) {
      return { ok: false, code: 'signed-out' }
    }
    const result = await this.mutate(signal, owned => saveCreativePlan({ sessionId, projectId, expectedRevision, change }, owned))
    if (!this.mutationCurrent(sessionId, epoch, account, signal)) {
      return { ok: false, code: 'signed-out' }
    }
    if (!result.ok) {
      if (result.code === 'signed-out') this.accountChanged(null)
      return result
    }
    if (result.payload.accountId !== account) { this.accountChanged(null); return { ok: false, code: 'signed-out' } }
    // An earlier read may have captured the old plan. Replace it before publishing the committed revision.
    this.stop()
    const bucket = this.bucket(sessionId)
    const before = bucket.source.getSnapshot()
    bucket.source.set({ phase: 'ready', projects: result.payload.projects, refreshing: false, failure: null,
      ...selection(result.payload.projects, before.selectedProjectId, before.selectedShotId) })
    this.schedule(sessionId)
    return result
  }

  /**
   * Admit uploaded source ids only while their original account and conversation still own the view.
   * @param sessionId - owning foreground conversation.
   * @param file - user-selected material.
   * @param signal - editor lifetime cancellation.
   * @returns the uploaded source id or a contained upload failure.
   */
  async upload(sessionId: SessionId, file: File, signal: AbortSignal): Promise<CreativeUploadResult> {
    const epoch = this.epoch
    const account = this.account
    if (this.closed || signal.aborted || this.account === null || sessionId !== this.selected) return { ok: false }
    const result = await this.mutate(signal, owned => uploadCreativeAsset(file, owned))
    if (!this.mutationCurrent(sessionId, epoch, account, signal)) return { ok: false }
    return result
  }

  /**
   * Query an owned original image task and supervise its accepted background read.
   * @param sessionId - owning foreground conversation.
   * @param projectId - retained project whose task is queryable.
   * @param operationId - exact operation whose original task must be queried.
   * @param signal - requesting view lifetime cancellation.
   * @returns a confirmed listing or a contained failure; generation is never submitted.
   */
  async recover(sessionId: SessionId, projectId: string, operationId: string, signal: AbortSignal): Promise<CreativeRecoverResult> {
    const epoch = this.epoch
    const account = this.account
    if (this.closed || signal.aborted || account === null || sessionId !== this.selected) return { ok: false, code: 'signed-out' }
    const task = this.bucket(sessionId).source.getSnapshot().projects.find(project => project.id === projectId)
      ?.tasks.find(operation => operation.id === operationId)
    if (task?.canQuery !== true) return { ok: false, code: 'rejected' }
    const result = await this.mutate(signal, owned => recoverCreativeImage({ sessionId, projectId, operationId, kind: task.videoReceipt === undefined ? 'image' : 'video' }, owned))
    if (!this.mutationCurrent(sessionId, epoch, account, signal)) return { ok: false, code: 'signed-out' }
    if (!result.ok) {
      if (result.code === 'signed-out') this.accountChanged(null)
      return result
    }
    if (result.payload.accountId !== account) { this.accountChanged(null); return { ok: false, code: 'signed-out' } }
    this.stop()
    const bucket = this.bucket(sessionId)
    const before = bucket.source.getSnapshot()
    bucket.source.set({ phase: 'ready', projects: result.payload.projects, refreshing: false, failure: null,
      ...selection(result.payload.projects, before.selectedProjectId, before.selectedShotId) })
    this.schedule(sessionId)
    return result
  }

  /** Stop supervision, abort reads and await owned work before completing plugin teardown. */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cancelMutations()
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
      const before = bucket.source.getSnapshot()
      bucket.source.set({ phase: 'ready', projects: result.payload.projects, refreshing: false, failure: null,
        ...selection(result.payload.projects, before.selectedProjectId, before.selectedShotId) })
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

  private mutationCurrent(sessionId: SessionId, epoch: number, account: string | null, signal: AbortSignal): boolean {
    return !this.closed && !signal.aborted && epoch === this.epoch && this.account !== null
      && account === this.account && sessionId === this.selected
  }
  private async mutate<T>(signal: AbortSignal, run: (owned: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController()
    const cancel = (): void => { abort.abort() }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) abort.abort()
    this.mutations.add(abort)
    const task = run(abort.signal)
    this.tasks.add(task)
    try { return await task }
    finally {
      signal.removeEventListener('abort', cancel)
      this.mutations.delete(abort)
      this.tasks.delete(task)
    }
  }
  private cancelMutations(): void { for (const abort of this.mutations) abort.abort() }

  private current(request: Request): boolean {
    return !this.closed && !request.abort.signal.aborted && request.epoch === this.epoch
      && request.sessionId === this.selected && this.foreground && this.account !== null
  }
  private schedule(sessionId: SessionId): void {
    if (this.closed || !this.foreground || this.account === null || sessionId !== this.selected) return
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
      bucket = { source: createSnapshotStore(this.account === null ? SIGNED_OUT : EMPTY),
        visible: new Set(), revealed: false }
      this.buckets.set(sessionId, bucket)
    }
    return bucket
  }
}
