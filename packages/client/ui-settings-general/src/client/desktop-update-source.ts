/** Client-owned observation of the optional Desktop preload. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopUpdateBridge, DesktopUpdatePresentation, DesktopUpdateView } from '../types.ts'

/**
 * Identify a release that the shell can download or install without another check.
 * @param state - The current shell-owned release and failure state.
 * @returns Whether a discovered release remains actionable.
 */
export function hasDesktopUpdate(state: DesktopUpdatePresentation | undefined): boolean {
  if (state?.phase === 'available' || state?.phase === 'ready') return true
  if (state?.phase !== 'error' || !state.version) return false
  switch (state.failure) {
    case 'download':
    case 'download-network':
    case 'install':
    case 'install-network':
    case 'stop-failed':
    case 'tasks-changed':
    case 'tasks-unavailable':
      return true
    default:
      return false
  }
}

/** Owns one preload subscription across settings and sidebar controls. */
export class DesktopUpdateSource {
  /** Framework-observed carrier status shared by both sidebar controls. */
  readonly store = createSnapshotStore<DesktopUpdateView>({ failed: false, opening: false })
  private live = true
  private received = false
  private readonly unsubscribe: (() => void) | undefined

  /** @param bridge - Optional isolated Electron API, absent in ordinary browsers. */
  constructor(private readonly bridge: DesktopUpdateBridge | undefined) {
    this.unsubscribe = bridge?.subscribe((presentation) => {
      if (!this.live) return
      this.received = true
      this.store.set({ ...this.store.getSnapshot(), presentation, failed: false })
    })
    void bridge?.status().then((presentation) => {
      if (this.live && !this.received) this.store.set({ ...this.store.getSnapshot(), presentation })
    }, () => {
      if (this.live && !this.received) this.store.set({ ...this.store.getSnapshot(), failed: true })
    })
  }

  /** Open the current update action, including an already discovered release. */
  open(): void {
    const bridge = this.bridge
    if (!this.live || bridge === undefined) return
    this.run(() => bridge.open())
  }

  /** Run a manual check without implicitly accepting an available download. */
  check(): void {
    const bridge = this.bridge
    if (!this.live || typeof bridge?.check !== 'function') return
    this.run(bridge.check.bind(bridge))
  }

  /** Check for a release, or resume the discovered update through the shell's confirmations. */
  activate(): void {
    if (!this.live || typeof this.bridge?.check !== 'function') return
    const state = this.store.getSnapshot().presentation
    if (hasDesktopUpdate(state) || state?.phase === 'downloading' || state?.phase === 'verifying') this.open()
    else this.check()
  }

  /** Coalesce actions while allowing the shell's download progress window to reopen. */
  private run(action: () => Promise<void>): void {
    const state = this.store.getSnapshot()
    if (state.presentation?.phase === 'downloading' || state.presentation?.phase === 'verifying') {
      void Promise.resolve().then(() => { if (this.live) return action() }).catch(() => {
        if (this.live) this.store.set({ ...this.store.getSnapshot(), failed: true })
      })
      return
    }
    if (state.opening || state.presentation?.phase === 'checking' || state.presentation?.phase === 'installing') return
    this.store.set({ ...state, opening: true })
    void Promise.resolve().then(() => { if (this.live) return action() }).catch(() => {
      if (this.live) this.store.set({ ...this.store.getSnapshot(), failed: true })
    }).finally(() => {
      if (this.live) this.store.set({ ...this.store.getSnapshot(), opening: false })
    })
  }

  /** Detach the carrier and ignore any pending status or action completion. */
  dispose(): void { this.live = false; this.unsubscribe?.() }
}
