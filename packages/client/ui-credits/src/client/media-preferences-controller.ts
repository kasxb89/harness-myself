/** Root lifecycle and account isolation for the two composer media selectors. */
import { defineStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { CreditsSnapshot } from './session-store.ts'
import { requestPreferences, type MediaPreferences, type MediaSelection, type PreferenceCatalog, type PreferenceFailure, type PreferenceKind, type PreferenceReply, type PreferenceResult } from './media-preferences.ts'

/** Only acknowledged choices appear as saved in the composer. */
export interface MediaPreferenceView {
  readonly identity: string | null
  readonly saved: MediaPreferences | null
  readonly catalog: PreferenceCatalog | null
  readonly loading: boolean
  readonly saving: boolean
  readonly failure: PreferenceFailure | null
}
/** The metadata admitted with the next ordinary user submission. */
export interface MediaPreferenceHint { readonly scope: string; readonly revision: string; readonly accountOwner: string }
/** The two selections reviewed together in the compact editor. */
export interface MediaPreferenceChoices { readonly image: MediaSelection | null; readonly video: MediaSelection | null }
/** Account-owned transport callbacks and view source injected into the slot. */
export interface MediaPreferencesInjected {
  readonly hooks: { readonly mediaPreferences: ObservableSnapshot<MediaPreferenceView> }
  /** Load the authorized directory only after an explicit open or retry. */
  readonly loadCatalog: () => Promise<void>
  /**
   * Save both reviewed kinds with one owner- and revision-checked write.
   * @param choices - Complete editor draft.
   * @returns True after the Host acknowledges both selections.
   */
  readonly savePreferences: (choices: MediaPreferenceChoices) => Promise<boolean>
  /**
   * Save one kind with the last confirmed revision.
   * @param kind - Selector being edited.
   * @param selection - Explicit model parameters or platform default.
   * @returns True after the Host acknowledges this account's save.
   */
  readonly savePreference: (kind: PreferenceKind, selection: MediaSelection | null) => Promise<boolean>
}
/** Root controller with disposal and a non-network prompt hint accessor. */
export interface MediaPreferencesController extends MediaPreferencesInjected {
  /** Subscribe to identity changes and restore private preferences. @returns Cleanup aborting all pending reads and writes. */
  readonly start: () => () => void
  /**
   * Read confirmed metadata for the next request without waiting for media services.
   * @returns The current owner-bound metadata, absent when following both platform defaults.
   */
  readonly promptHint: () => MediaPreferenceHint | undefined
}

/**
 * Create an account-isolated controller, never a shared module singleton.
 * @param source - Existing product account source.
 * @param timeoutMs - Configured client deadline for each operation.
 * @param request - HTTP adapter; replace only in owner tests.
 * @returns Root-owned view and lifecycle callbacks.
 */
export function createMediaPreferences(source: ObservableSnapshot<CreditsSnapshot>, timeoutMs: number,
  request: typeof requestPreferences = requestPreferences): MediaPreferencesController {
  const view = defineStore({
    init: (): MediaPreferenceView => ({ identity: null, saved: null, catalog: null, loading: false, saving: false, failure: null }),
    actions: { replace: (draft, next: MediaPreferenceView) => { Object.assign(draft, next) } },
  }).create()
  let active = false
  let generation = 0
  let read: AbortController | undefined
  let write: AbortController | undefined
  let catalogPending: Promise<void> | undefined
  let login: { id: string; owner: string; epoch: number } | null = null
  const publish = (change: Partial<MediaPreferenceView>): void => { view.actions.replace({ ...view.getSnapshot(), ...change }) }
  const current = (key: number, signal: AbortSignal): boolean => active && generation === key && !signal.aborted
  const matches = (reply: PreferenceReply): boolean => login !== null && reply.accountId === login.id && reply.accountOwner === login.owner
  const accept = (result: PreferenceResult, key: number, signal: AbortSignal, withCatalog: boolean): boolean => {
    if (!current(key, signal)) return false
    if (!result.ok) { publish({ failure: result.failure }); return false }
    if (!matches(result.reply)) { publish({ failure: 'account' }); return false }
    const { preferences, catalog } = result.reply
    publish({ saved: preferences, failure: null, ...withCatalog ? { catalog: catalog ?? null } : {} })
    return true
  }
  const operation = async (catalog: boolean): Promise<void> => {
    if (login === null || !active || view.getSnapshot().saving) return
    read?.abort()
    const controller = new AbortController()
    read = controller
    const key = generation
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
    publish({ loading: true, failure: null })
    try {
      accept(await request(catalog ? 'catalog' : 'read', signal), key, controller.signal, catalog)
    }
    finally { if (current(key, controller.signal)) publish({ loading: false }); if (read === controller) read = undefined }
  }
  const loadCatalog = (): Promise<void> => {
    if (catalogPending !== undefined) return catalogPending
    const pending = operation(true).finally(() => { if (catalogPending === pending) catalogPending = undefined })
    catalogPending = pending
    return pending
  }
  const observe = (): void => {
    const snapshot = source.getSnapshot()
    const session = snapshot.session
    const next = session?.signedIn === true && session.account !== undefined && session.accountOwner !== undefined
      ? { id: session.account.id, owner: session.accountOwner, epoch: snapshot.accountEpoch } : null
    if (next?.id === login?.id && next?.owner === login?.owner && next?.epoch === login?.epoch) return
    generation += 1
    read?.abort(); write?.abort(); read = undefined; write = undefined; catalogPending = undefined
    login = next
    view.actions.replace({ identity: next === null ? null : JSON.stringify([next.id, next.owner, next.epoch]),
      saved: null, catalog: null, loading: false, saving: false, failure: null })
    if (next !== null) void operation(false)
  }
  const savePreferences = async (choices: MediaPreferenceChoices): Promise<boolean> => {
    const state = view.getSnapshot()
    if (!active || login === null || state.saved === null || state.saving) return false
    read?.abort(); read = undefined; catalogPending = undefined
    const controller = new AbortController()
    write = controller
    const key = generation
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
    const body = { schema_version: 1, expected_account_owner: login.owner, expected_revision: state.saved.revision,
      image: choices.image, video: choices.video }
    publish({ saving: true, loading: false, failure: null })
    try { return accept(await request('save', signal, body), key, controller.signal, false) }
    finally { if (current(key, controller.signal)) publish({ saving: false }); if (write === controller) write = undefined }
  }
  return {
    hooks: { mediaPreferences: view }, loadCatalog, savePreferences,
    savePreference: async (kind, selection) => {
      const saved = view.getSnapshot().saved
      if (saved === null) return false
      return savePreferences({ image: kind === 'image' ? selection : saved.image,
        video: kind === 'video' ? selection : saved.video })
    },
    promptHint: () => {
      const saved = view.getSnapshot().saved
      const snapshot = source.getSnapshot()
      if (!active || login === null || snapshot.accountEpoch !== login.epoch || snapshot.session?.accountOwner !== login.owner
        || saved === null || saved.image === null && saved.video === null) return undefined
      return { scope: saved.scope, revision: saved.revision, accountOwner: login.owner }
    },
    start: () => {
      active = true
      const unsubscribe = source.subscribe(observe)
      observe()
      return () => {
        active = false; generation += 1; unsubscribe(); read?.abort(); write?.abort(); login = null
        view.actions.replace({ identity: null, saved: null, catalog: null, loading: false, saving: false, failure: null })
      }
    },
  }
}
