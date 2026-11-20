/** Root-local admission and a manually opened reminder for sidebar features. */
import { defineStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { creditsReadFailure, creditsRetrySeconds, type CreditsReadFailure } from './read-failure.ts'
import type { CreditsSnapshot } from './session-store.ts'

/** Presentation distinguishes a confirmed logout from an unfinished or failed read. */
export type SidebarLoginMode = 'signed-out' | 'checking' | 'unconfirmed'

/** Temporary dialog data; no pending feature callback or credentials are retained. */
export interface SidebarLoginState {
  open: boolean
  mode: SidebarLoginMode
  refreshing: boolean
  failure: CreditsReadFailure | null
}

/** Private commands and framework-bound view source shared with the overlay. */
export interface SidebarLoginInjected {
  readonly hooks: { readonly sidebarLogin: ObservableSnapshot<SidebarLoginState> }
  readonly dismissSidebarLogin: () => void
  readonly retrySidebarLogin: () => void
  readonly goToSidebarLogin: () => void
}

function admission(snapshot: CreditsSnapshot): { mode: SidebarLoginMode | null; failure: CreditsReadFailure | null } {
  const failure = snapshot.readFailure ?? (snapshot.failure === null ? null
    : creditsReadFailure({ code: snapshot.failure }, 'ACCOUNT_UNAVAILABLE'))
  if (failure?.kind === 'auth' || failure?.kind === 'accountChanged' || failure?.kind === 'sessionRefresh') {
    return { mode: 'unconfirmed', failure }
  }
  if (snapshot.session?.signedIn === true) return { mode: null, failure }
  if (!snapshot.loaded && failure === null) return { mode: 'checking', failure }
  return { mode: snapshot.session?.signedIn === false && failure === null ? 'signed-out' : 'unconfirmed', failure }
}

/**
 * Create one in-memory sidebar policy and reminder for this client root.
 * @param source - Existing shared account state; subscription retains its normal refresh lifecycle.
 * @param refresh - Existing read-only session refresh, with cancellation owned by this reminder.
 * @param openLogin - Direct navigation to the existing account page, outside the sidebar policy.
 * @returns A synchronous admission callback, overlay commands, and disposable source observation.
 */
export function createSidebarLogin(
  source: ObservableSnapshot<CreditsSnapshot>, refresh: (signal: AbortSignal) => Promise<boolean>, openLogin: () => void,
): SidebarLoginInjected & { request: () => boolean; start: () => () => void } {
  const view = defineStore({
    init: (): SidebarLoginState => ({ open: false, mode: 'checking', refreshing: false, failure: null }),
    actions: { patch: (draft, patch: Partial<SidebarLoginState>) => { Object.assign(draft, patch) } },
  }).create()
  let active = false, disposed = false
  let pending: AbortController | undefined
  const dismiss = (): void => {
    const previous = pending
    pending = undefined
    previous?.abort()
    view.actions.patch({ open: false, refreshing: false })
  }
  const synchronize = (): void => {
    if (!active || !view.getSnapshot().open) return
    const state = admission(source.getSnapshot())
    if (state.mode === null) { dismiss(); return }
    view.actions.patch({ mode: pending === undefined ? state.mode : 'checking', failure: state.failure })
  }
  const retry = (): void => {
    if (!active || !view.getSnapshot().open || pending !== undefined
      || creditsRetrySeconds(view.getSnapshot().failure) > 0) return
    const controller = new AbortController()
    pending = controller
    view.actions.patch({ mode: 'checking', refreshing: true })
    void (async () => {
      let failure: CreditsReadFailure | null = null
      try { await refresh(controller.signal) }
      catch (error) { failure = creditsReadFailure(error, 'ACCOUNT_UNAVAILABLE') }
      if (pending !== controller || controller.signal.aborted || !view.getSnapshot().open) return
      pending = undefined
      const state = admission(source.getSnapshot())
      if (state.mode === null) { dismiss(); return }
      view.actions.patch({ mode: state.mode === 'checking' ? 'unconfirmed' : state.mode,
        failure: failure ?? state.failure, refreshing: false })
    })()
  }
  return {
    hooks: { sidebarLogin: view },
    request: () => {
      if (!active) return false
      const state = admission(source.getSnapshot())
      if (state.mode === null) { dismiss(); return true }
      view.actions.patch({ open: true, mode: pending === undefined ? state.mode : 'checking', failure: state.failure })
      return false
    },
    dismissSidebarLogin: dismiss,
    retrySidebarLogin: retry,
    goToSidebarLogin: () => {
      if (!active || !view.getSnapshot().open) return
      dismiss()
      openLogin()
    },
    start: () => {
      if (active || disposed) return () => {}
      active = true
      const unsubscribe = source.subscribe(synchronize)
      return () => {
        active = false
        disposed = true
        unsubscribe()
        dismiss()
      }
    },
  }
}
