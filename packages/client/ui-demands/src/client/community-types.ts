/** Community-order model contracts, separate from official/private engineer demands. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Server-owned community lifecycle; no engineer status is substituted. */
export type CommunityStatus = 'open' | 'accepted' | 'awaiting_acceptance' | 'completed' | 'cancelled'
/** Actual authenticated user's part in one order. */
export type CommunityRole = 'publisher' | 'acceptor' | 'admin'
/** Immutable attachment visibility domain. */
export type CommunityScope = 'listing' | 'conversation'
/** Review state is independent from the existing participant lifecycle. */
export type CommunityApprovalStatus = 'pending' | 'approved' | 'rejected'
/** Public user projection without phone, login name or credentials. */
export interface CommunityUser { readonly id: number; readonly display_name: string }
/** Validated ready attachment in this namespace only. */
export interface CommunityAttachment {
  readonly id: string
  readonly name: string
  readonly kind: 'image' | 'video'
  readonly mime_type: string
  readonly size_bytes: number
  readonly status: 'ready'
  readonly sha256: string
  readonly scope: CommunityScope
}
/** Public listing with public assets only. */
export interface CommunityListing {
  readonly schema_version: 1
  readonly id: string
  readonly number: string
  readonly title: string
  readonly public_summary: string
  readonly public_budget: string
  readonly expected_delivery_date?: string
  readonly approval_status?: CommunityApprovalStatus
  readonly approval_reason?: string
  readonly service_profile_id: string
  readonly service_profile_name: string
  readonly publisher: CommunityUser
  readonly status: CommunityStatus
  readonly public_attachments: readonly CommunityAttachment[]
  readonly created_at: number
  readonly updated_at: number
  readonly can_accept: boolean
}
/** Private order received only for the current publisher, acceptor or authorized administrator. */
export interface CommunityOrder {
  readonly schema_version: 1
  readonly id: string
  readonly number: string
  readonly title: string
  readonly status: CommunityStatus
  readonly revision: number
  readonly publisher: CommunityUser
  readonly acceptor: CommunityUser | null
  readonly my_role: CommunityRole
  readonly listing: CommunityListing
  readonly private_text: string
  readonly last_seq: number
  readonly last_read_seq: number
  readonly unread_count: number
  readonly delivery_message_id: string
  readonly created_at: number
  readonly updated_at: number
  readonly accepted_at: number
  readonly closed_at: number
  readonly can_send: boolean
  readonly can_deliver: boolean
  readonly can_accept_delivery: boolean
  readonly can_cancel: boolean
  readonly can_reopen: boolean
}
/** Persisted sender identity and sequence, never mapped to an engineer. */
export interface CommunityMessage {
  readonly id: string
  readonly order_id: string
  readonly seq: number
  readonly sender_id: number
  readonly author_kind: CommunityRole | 'system'
  readonly author_name: string
  readonly kind: 'message' | 'delivery' | 'system'
  readonly text: string
  readonly attachments: readonly CommunityAttachment[]
  readonly created_at: number
  readonly client_message_id: string
  readonly read: boolean
}
/** Server message with an account-derived alignment flag only. */
export interface CommunityMessageView extends CommunityMessage { readonly isSelf: boolean }
/** Dynamic backend limits for image/video uploads. */
export interface CommunityUploadRules {
  readonly max_image_bytes: number
  readonly max_video_bytes: number
  readonly max_attachments: number
  readonly chunk_bytes: number
  readonly allowed_mime_types: readonly string[]
  readonly upload_ttl_seconds: number
}
/** Explicitly versioned capability probe. */
export interface CommunityConfig {
  readonly schema_version: 1
  readonly enabled: boolean
  readonly capabilities: {
    readonly community_orders_v1: boolean
    readonly explicit_publication: boolean
    readonly single_acceptor: boolean
    readonly resumable_upload: boolean
    readonly private_participant_messages: boolean
    readonly community_approval_v1?: boolean
  }
  readonly publication_policy?: 'approval_required'
  readonly upload_rules: CommunityUploadRules
}
/** Localizable error identity, preserving unknown mutation outcomes. */
export interface CommunityIssue {
  readonly code: string
  readonly unknown: boolean
  readonly operationId: string | null
}
/** Independent list cursor and retained verified items. */
export interface CommunityPage<T> {
  readonly items: readonly T[]
  readonly status: 'loading' | 'ready' | 'error'
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly error: CommunityIssue | null
}
/** Explicit publication fields; false is never promoted to public consent. */
export interface CommunityPublicationFields {
  readonly publishToCommunity: boolean
  readonly title: string
  readonly publicSummary: string
  readonly publicBudget: string
  readonly expectedDeliveryDate?: string
  readonly serviceProfileId: string
  readonly privateText: string
}
/** A publication scope whose independent operation key survives an uncertain response. */
export interface CommunityPublicationDraft extends CommunityPublicationFields {
  readonly scopeKey: string
  readonly createdAt: number
  readonly orderId: string | null
  readonly sending: boolean
  readonly locked: boolean
  readonly error: CommunityIssue | null
}
/** An immutable upload destination, separate from its listing/conversation visibility. */
export type CommunityUploadTarget = { readonly kind: 'publication'; readonly scopeKey: string }
  | { readonly kind: 'order'; readonly orderId: string }
/** Credential-free staged file presentation; browser File objects remain outside snapshots. */
export interface CommunityUploadView {
  readonly operationId: string
  readonly target: CommunityUploadTarget
  readonly scope: CommunityScope
  readonly attachment: CommunityAttachment | null
  readonly name: string
  readonly sizeBytes: number
  readonly mimeType: string
  readonly progressPercent: number
  readonly status: 'uploading' | 'ready' | 'failed' | 'reselect'
  readonly reserved: boolean
  readonly error: CommunityIssue | null
}
/** Local unconfirmed message, kept separate from server sequence and author DTOs. */
export interface CommunityLocalMessage {
  readonly operationId: string
  readonly orderId: string
  readonly text: string
  readonly attachments: readonly CommunityAttachment[]
  readonly createdAt: number
  readonly state: 'sending' | 'unknown' | 'failed'
  readonly error: CommunityIssue | null
}
/** Current private conversation and its own unsent text, with server-owned permissions. */
export interface CommunityConversation {
  readonly order: CommunityOrder
  readonly messages: readonly CommunityMessageView[]
  readonly pendingMessages: readonly CommunityLocalMessage[]
  readonly status: 'loading' | 'ready' | 'error'
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly draftText: string
  readonly error: CommunityIssue | null
}
/** Recoverable original mutation, scoped independently from other orders. */
export interface CommunityPendingView {
  readonly operationId: string
  readonly scopeKey: string
  readonly orderId: string | null
  readonly kind: 'publication' | 'accept' | 'message' | 'action' | 'upload'
  readonly inflight: boolean
  readonly error: CommunityIssue | null
}
/** Complete account-owned community snapshot for a root-owned view adapter. */
export interface CommunityState {
  readonly availability: 'loading' | 'ready' | 'disabled' | 'unavailable' | 'login-required' | 'error'
  readonly accountId: string | null
  readonly config: CommunityConfig | null
  readonly error: CommunityIssue | null
  readonly listingQuery: string
  readonly listingServiceProfileId: string
  readonly listings: CommunityPage<CommunityListing>
  readonly orders: Readonly<Record<'published' | 'accepted' | 'all', CommunityPage<CommunityOrder>>>
  readonly selectedListing: CommunityListing | null
  readonly selectedListingStatus: 'loading' | 'ready' | 'error'
  readonly selectedListingError: CommunityIssue | null
  readonly claimingListingIds: readonly string[]
  readonly selectedOrderId: string | null
  readonly selectedOrderStatus: 'loading' | 'ready' | 'error'
  readonly selectedOrderError: CommunityIssue | null
  readonly conversation: CommunityConversation | null
  readonly activePublicationScope: string | null
  readonly publications: readonly CommunityPublicationDraft[]
  readonly uploads: readonly CommunityUploadView[]
  readonly pending: readonly CommunityPendingView[]
}
/** Participant lifecycle operation; no wallet or payment behavior is implied. */
export type CommunityAction = 'cancel' | 'reopen' | 'deliver' | 'accept_delivery' | 'request_changes'
/** Stable root adapter commands and observable model source. */
export interface CommunityFace {
  readonly hooks: { readonly community: ObservableSnapshot<CommunityState> }
  readonly refresh: () => void
  readonly setListingFilter: (query: string, serviceProfileId?: string) => void
  readonly loadMoreListings: () => void
  readonly loadOrders: (view: 'published' | 'accepted' | 'all', more?: boolean) => void
  readonly openListing: (id: string) => void
  readonly acceptListing: (id: string) => void
  readonly openOrder: (id: string) => void
  readonly startPublication: () => void
  readonly openPublication: (scopeKey: string) => void
  readonly updatePublication: (scopeKey: string, patch: Partial<CommunityPublicationFields>) => void
  readonly publish: (scopeKey: string) => void
  readonly updateMessageDraft: (orderId: string, text: string) => void
  readonly sendMessage: (orderId: string) => void
  readonly loadMoreMessages: (orderId: string) => void
  readonly markRead: (orderId: string, lastSeq: number) => void
  readonly performAction: (orderId: string, action: CommunityAction, text?: string, attachmentIds?: readonly string[]) => void
  readonly retryOperation: (operationId: string) => void
  readonly addAttachments: (target: CommunityUploadTarget, scope: CommunityScope, files: readonly File[]) => void
  readonly retryUpload: (operationId: string, file?: File) => void
  readonly removeUpload: (operationId: string) => void
  readonly contentUrl: (attachmentId: string, disposition?: 'inline' | 'attachment') => string | null
  readonly downloadAttachment: (attachmentId: string) => void
}
