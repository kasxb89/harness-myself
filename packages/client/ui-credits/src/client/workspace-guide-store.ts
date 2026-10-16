/** One manually opened examples dialog per client root. */
import { defineStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** One temporary operation outcome, rendered by the persistent overlay entry. */
export type WorkspaceGuideNotice = 'inserted' | 'changed' | 'busy' | 'alreadyOpen'

/** Root-local presentation state; neither draft text nor account credentials are persisted. */
export interface WorkspaceGuideState {
  /** Sole visible dialog and its account, absent while the guide is closed. */
  active: { ownerId: string; accountId: string } | null
  /** Last insertion outcome, independent of composer lifetime. */
  notice: { kind: WorkspaceGuideNotice; seq: number } | null
}

/** Private slot injection shared by guide entries and the notice overlay. */
export interface WorkspaceGuideInjected {
  /** Root-owned source adapted by the slot renderer into useWorkspaceGuide. */
  hooks: { workspaceGuide: ObservableSnapshot<WorkspaceGuideState> }
  /**
   * Reserve the only examples dialog after the user requests it.
   * @param ownerId - mounted composer instance.
   * @param accountId - current signed-in product account.
   * @returns whether this composer reserved the dialog.
   */
  claim: (ownerId: string, accountId: string) => boolean
  /** Close this composer's examples. @param ownerId - active composer instance. */
  dismiss: (ownerId: string) => void
  /** Release a disappearing composer or changed account. @param ownerId - disappearing composer instance. */
  release: (ownerId: string) => void
  /** Report an insertion outcome without retaining the composer. @param kind - localized notice identity. */
  notify: (kind: WorkspaceGuideNotice) => void
  /** Clear the completed notice. */
  dismissNotice: () => void
}

/**
 * Create a root-owned examples controller. Dialog ownership and insertion
 * notices stay in memory, and no account acknowledgement is read or written.
 * @returns stable slot callbacks and a bare presentation source.
 */
export function createWorkspaceGuide(): WorkspaceGuideInjected {
  const view = defineStore({
    init: (): WorkspaceGuideState => ({ active: null, notice: null }),
    actions: {
      open: (draft, ownerId: string, accountId: string) => { draft.active = { ownerId, accountId } },
      release: (draft, ownerId: string) => {
        if (draft.active?.ownerId === ownerId) draft.active = null
      },
      notify: (draft, kind: WorkspaceGuideNotice) => {
        draft.notice = { kind, seq: (draft.notice?.seq ?? 0) + 1 }
      },
      dismissNotice: (draft) => { draft.notice = null },
    },
  }).create()
  return {
    hooks: { workspaceGuide: view },
    claim: (ownerId, accountId) => {
      if (view.getSnapshot().active !== null) return false
      view.actions.open(ownerId, accountId)
      return true
    },
    dismiss: (ownerId) => {
      const active = view.getSnapshot().active
      if (active?.ownerId !== ownerId) return
      view.actions.release(ownerId)
    },
    release: view.actions.release,
    notify: view.actions.notify,
    dismissNotice: view.actions.dismissNotice,
  }
}
