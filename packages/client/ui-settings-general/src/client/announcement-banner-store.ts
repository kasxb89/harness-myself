/** Account-scoped public banner reads and versioned local viewing preferences. @module */
import { createSnapshotStore, defineStore, type ObservableSnapshot, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { CreditsSnapshot } from '@deepseek-ai/dsh-client-ui-credits/src/client/session-store.ts'
import { readAnnouncementBanner, type AnnouncementBannerData, type AnnouncementBannerRead } from './announcement-banner-reader.ts'

function storedDismissals(value: unknown): [string, string][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const state = value as Record<string, unknown>
  if (state.schemaVersion !== 1 || state.byViewer === null || typeof state.byViewer !== 'object'
    || Array.isArray(state.byViewer)) return []
  return Object.entries(state.byViewer).flatMap(([key, item]) =>
    typeof item === 'string' && validViewer(key) && validRevision(item) ? [[key, item]] : [])
}

interface DismissalState { schemaVersion: 1; byViewer: Record<string, string> }
type DismissalActions = { dismiss: (draft: DismissalState, viewer: string, revision: string) => void }
const validViewer = (value: string): boolean => /^[a-f0-9]{64}:/u.test(value) && value.length <= 512
const validRevision = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value)

/** @returns A bounded local preference store; no announcement content or authentication fields are persisted. */
export function createAnnouncementDismissalStore(): EngineStoreHandle<DismissalState, DismissalActions> {
  return defineStore({
    init: (): DismissalState => ({ schemaVersion: 1, byViewer: {} }),
    persist: 'dsh.announcements.dismissed.v1',
    actions: {
      dismiss: (draft, viewer: string, revision: string) => {
        if (!validViewer(viewer) || !validRevision(revision)) return
        const entries = storedDismissals(draft).filter(([key]) => key !== viewer).slice(-127)
        draft.schemaVersion = 1
        draft.byViewer = Object.fromEntries([...entries, [viewer, revision]])
      },
    },
  })
}

/**
 * @param value - Persisted viewing preference.
 * @param viewer - Deployment and stable account identity.
 * @param revision - Current feed version.
 * @returns Whether this version was explicitly closed.
 */
export function isBannerDismissed(value: unknown, viewer: string, revision: string): boolean {
  return storedDismissals(value).some(([key, item]) => key === viewer && item === revision)
}

export interface AnnouncementBannerView {
  readonly account: string
  readonly data: AnnouncementBannerData | null
}
export interface AnnouncementBannerInjected {
  readonly hooks: { readonly announcementBanner: ObservableSnapshot<AnnouncementBannerView> }
}

/**
 * Read public announcements independently of account login and balance completion.
 * @param source - Shared account identity source; token epochs cancel stale reads without changing stored viewing keys.
 * @param read - Bounded Host reader.
 * @returns Root lifecycle and observable view; disposing cancels every request and timer.
 */
export function createAnnouncementBannerController(
  source: ObservableSnapshot<CreditsSnapshot>, read: (signal: AbortSignal) => Promise<AnnouncementBannerRead> = readAnnouncementBanner,
): AnnouncementBannerInjected & { start: () => () => void } {
  const view = createSnapshotStore<AnnouncementBannerView>({ account: 'signed-out', data: null })
  let disposed = true
  let active: AbortController | null = null
  let identity = ''
  const identityOf = (): { identity: string; account: string } => {
    const state = source.getSnapshot(), session = state.session
    const account = session?.signedIn === true && typeof session.account?.id === 'string' ? session.account.id : 'signed-out'
    return { account, identity: JSON.stringify([account, state.accountEpoch, session?.accountOwner]) }
  }
  const refresh = (): void => {
    if (disposed || active !== null) return
    const owner = identity
    const controller = new AbortController()
    active = controller
    void read(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])).then((answer) => {
      if (!disposed && !controller.signal.aborted && owner === identity && answer.ok) {
        view.set({ account: identityOf().account, data: answer.payload })
      }
    }).catch(() => { /* A public banner read never enters the login or chat failure path. */ }).finally(() => {
      if (active === controller) active = null
    })
  }
  return {
    hooks: { announcementBanner: view },
    start: () => {
      disposed = false
      const changed = (): void => {
        const next = identityOf()
        if (next.identity === identity) return
        identity = next.identity
        active?.abort(); active = null
        view.set({ account: next.account, data: null })
        refresh()
      }
      const off = source.subscribe(changed)
      changed()
      const timer = setInterval(refresh, 60_000)
      return () => {
        disposed = true; identity = ''; off(); clearInterval(timer); active?.abort(); active = null
        view.set({ account: 'signed-out', data: null })
      }
    },
  }
}
