/** Host-only ordinary Session discovery, reading, and inbox delivery values. */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare const confirmationIdentity: unique symbol

/** Opaque Host-issued consent for one caller, target, human request, and action. */
export interface PeerSessionConfirmation {
  readonly [confirmationIdentity]: true
}

/** Ordinary local-operator Session metadata exposed to another Session. */
export interface PeerSessionSummary {
  readonly sessionId: SessionId
  readonly title: string
  readonly cwd: string
  readonly running: boolean
}

/** Bounded ordinary-Session discovery request; only the caller workspace is listed. */
export interface PeerSessionListRequest {
  readonly offset?: number
  readonly limit?: number
}

/** A discovery page and its next bounded-page offset. */
export interface PeerSessionListValue {
  readonly items: readonly PeerSessionSummary[]
  readonly nextOffset?: number
}

/** Bounded history request, optionally authorized for one other workspace. */
export interface PeerSessionReadRequest {
  readonly sessionId: SessionId
  readonly beforeSeq?: number
  readonly limit?: number
  readonly confirmation?: PeerSessionConfirmation
}

/** One text-only history item; attachments and hidden tool data are excluded. */
export interface PeerSessionMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly sourceKind: string
  readonly senderSessionId?: SessionId
  readonly truncated: boolean
}

/** A chronological bounded history page with an exclusive continuation. */
export interface PeerSessionReadValue {
  readonly session: PeerSessionSummary
  readonly messages: readonly PeerSessionMessage[]
  readonly nextBeforeSeq?: number
}

/** One tool-owned submission; the model must not provide its identity. */
export interface PeerSessionSendRequest {
  readonly sessionId: SessionId
  /** Exact durable root tool/call seq followed by ':' and the native or nested call id. */
  readonly submissionId: string
  readonly message: string
  readonly delivery: 'queue' | 'notice'
  readonly confirmation?: PeerSessionConfirmation
}

/** Durable inbox acceptance, which does not claim model processing or a reply. */
export interface PeerSessionSendValue {
  readonly status: 'accepted'
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly delivery: 'queue' | 'notice'
  readonly duplicate: boolean
}

/** Explicit handling categories for Host peer-session operations. */
export type PeerSessionErrorCode =
  | 'PEER_CALLER_NOT_LIVE'
  | 'PEER_HUMAN_REQUEST_REQUIRED'
  | 'PEER_TARGET_CONFIRMATION_REQUIRED'
  | 'PEER_CONFIRMATION_DECLINED'
  | 'PEER_INVALID_REQUEST'
  | 'PEER_SELF_MESSAGE'
  | 'PEER_SESSION_ARCHIVED'
  | 'PEER_SESSION_NOT_FOUND'
  | 'PEER_SUBAGENT_TARGET'
  | 'PEER_SESSION_UNREADABLE'
  | 'PEER_SESSION_WRITER_HELD'
  | 'PEER_SESSION_UNAVAILABLE'
  | 'PEER_MESSAGE_TOO_LARGE'
  | 'PEER_DELIVERY_UNCONFIRMED'
  | 'PEER_DURABILITY_UNAVAILABLE'
  | 'PEER_SERVICE_DISPOSED'
