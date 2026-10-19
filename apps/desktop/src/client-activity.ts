/** Process-owned, content-free presence reporting; timers never depend on renderer visibility. */
import { randomUUID } from 'node:crypto'

/** Fields accepted by the local authenticated activity route. */
export interface DesktopActivitySample {
  session_id: string
  event: 'start' | 'heartbeat' | 'stop'
  foreground: boolean
  platform: 'darwin' | 'win32' | 'linux'
  app_version: string
}

/** The Host owns account credentials and forwards only these selected fields. */
export type DesktopActivitySender = (sample: DesktopActivitySample, signal: AbortSignal) => Promise<void>

/** One tracker per Electron process; unavailable networking drops samples instead of replaying time. */
export class DesktopClientActivity {
  private readonly sessionId = randomUUID()
  private sender: DesktopActivitySender | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private pending: { controller: AbortController; done: Promise<void> } | undefined
  private lastForeground: boolean | undefined
  private lastSentAt = 0
  private stopped = false
  private disposal: Promise<void> | undefined
  private locked = false
  private suspended = false
  private queued = false

  /**
   * @param platform - native operating system, without device identifiers.
   * @param appVersion - installed product release.
   * @param isForeground - focused product window and operating-system idle projection.
   */
  constructor(
    private readonly platform: DesktopActivitySample['platform'],
    private readonly appVersion: string,
    private readonly isForeground: () => boolean,
  ) {}

  /**
   * Replace a Host connection; its loss cancels pending local transport without replay.
   * @param sender - authenticated Host sender, absent while restarting or disconnected.
   */
  connect(sender: DesktopActivitySender | undefined): void {
    if (this.stopped) return
    this.sender = sender
    this.pending?.controller.abort()
    clearInterval(this.timer)
    this.timer = undefined
    this.lastForeground = undefined
    this.lastSentAt = 0
    if (sender === undefined) return
    this.timer = setInterval(() => { this.sample() }, 5_000)
    this.timer.unref()
    this.sample()
  }

  /** @param locked - true after the OS locks; unlocked state resumes ordinary sampling. */
  setLocked(locked: boolean): void { this.locked = locked; this.sample(true) }

  /** @param suspended - true immediately before sleep; no timer gap is reported as foreground use. */
  setSuspended(suspended: boolean): void { this.suspended = suspended; this.sample(true) }

  /** Notify native focus changes without waiting for the idle poll. */
  changed(): void { this.sample(true) }

  /** Stop timers, settle the pending sample and attempt one bounded final stop. */
  dispose(): Promise<void> { return this.disposal ??= this.finish() }

  private async finish(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.pending?.controller.abort()
    await this.pending?.done
    const sender = this.sender
    this.sender = undefined
    if (sender === undefined) return
    try { await sender(this.payload('stop', false), AbortSignal.timeout(2_000)) }
    catch (_unavailableActivityHost: unknown) { /* The server expires an unconfirmed exit by heartbeat timeout. */ }
  }

  private payload(event: DesktopActivitySample['event'], foreground: boolean): DesktopActivitySample {
    return { session_id: this.sessionId, event, foreground, platform: this.platform, app_version: this.appVersion }
  }

  private sample(force = false): void {
    const sender = this.sender
    if (this.stopped || sender === undefined) return
    if (this.pending !== undefined) { this.queued ||= force; return }
    let foreground = false
    try { foreground = !this.locked && !this.suspended && this.isForeground() }
    catch (_unavailableNativeState: unknown) { /* Unknown OS state contributes no foreground time. */ }
    const now = Date.now()
    if (!force && foreground === this.lastForeground && now - this.lastSentAt < 30_000) return
    const controller = new AbortController()
    const first = this.lastForeground === undefined
    this.lastForeground = foreground
    this.lastSentAt = now
    const done = Promise.resolve().then(async () => {
      try { await sender(this.payload(first ? 'start' : 'heartbeat', foreground), AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)])) }
      catch (_unavailableActivityHost: unknown) { /* Presence cannot interrupt ordinary software use. */ }
    }).finally(() => {
      if (this.pending?.controller !== controller) return
      this.pending = undefined
      if (this.queued) { this.queued = false; this.sample(true) }
    })
    this.pending = { controller, done }
  }
}
