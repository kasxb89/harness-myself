/** Conversation view and session-local presentation state. */
import type { DraftInput } from './draft-editor.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Cross-panel access to the Conversation shell's existing one-shot View request. */
export interface ConversationViewNavigation {
  /**
   * Select a registered View and request its exact target-owned focus identity.
   * @param sessionId - Already retained and opened Session whose View will receive the request.
   * @param view - Registered, visible Conversation View identity.
   * @param focus - Opaque target-owned focus identity.
   * @returns False without changing selection if the Session or View is unavailable.
   */
  open(sessionId: SessionId, view: string, focus: string): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** One-shot View navigation shared with global panels. */
    conversationViews: ConversationViewNavigation
  }
}

/**
 * One conversation view tab, projected from a 'conversation.view' slot
 * entry's registration options (label falls back to the entry id).
 */
export interface ViewTab { id: string; label: string }

/** One-shot focus request addressed to a Conversation View. */
export interface ConversationViewRequest {
  /** Target `conversation.view` entry id. */
  readonly view: string
  /** Target-owned opaque focus identity. */
  readonly focus: string
}

/** Per-session state owned by the target-neutral Conversation shell. */
export interface ConversationStoreState {
  /** Composer draft (persisted; survives session switches and reloads). */
  draft: DraftInput
  /** Preferred `conversation.view` entry id; null resolves to Chat when registered. */
  view: string | null
  /** Focus request consumed and acknowledged by the addressed View. */
  viewRequest: ConversationViewRequest | null
}
