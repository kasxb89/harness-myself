/** Client-owned observation of the optional Desktop preload. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopUpdateBridge, DesktopUpdateView } from '../types.ts'

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
