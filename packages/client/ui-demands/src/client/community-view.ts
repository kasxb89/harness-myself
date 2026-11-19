/** UI-owned community presentation data. These types do not describe an API wire format. */
import type { DemandAttachment } from './types.ts'

/** A confirmed attachment explicitly approved for public display by the owning adapter. */
export type CommunityPublicAttachment = Pick<DemandAttachment, 'id' | 'name' | 'kind' | 'sizeBytes' | 'previewUrl'>

/** Public-safe fields only; private messages and contact details are not accepted by this view. */
export interface CommunityPublicDemandView {
  readonly id: string
  readonly title: string
  readonly serviceName: string
  readonly brief: string
  readonly authorDisplayName: string
  readonly attachments: readonly CommunityPublicAttachment[]
}

/** The current viewer's actual relationship, without treating a user as an engineer. */
export interface CommunityDemandAccess {
  readonly relation: 'owner' | 'claimer' | 'visitor'
  readonly canClaim: boolean
  readonly canOpenConversation: boolean
  readonly reason: string | null
}

/** The owner retains operation identity and resolves unknown results through the original operation. */
export type CommunityOperationView =
  | { readonly state: 'idle' | 'submitting' }
  | { readonly state: 'unknown'; readonly checking: boolean; readonly message?: string }
  | { readonly state: 'failed'; readonly message: string; readonly recoverable?: boolean; readonly recovering?: boolean }

/** A supplied service choice; no category or capability is invented by the form. */
export interface CommunityServiceChoice {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
}

/** Controlled publication fields. Omitted public consent is always treated as false. */
export interface CommunityPublishDraft {
  readonly title: string
  readonly brief: string
  readonly serviceId: string
  readonly allowPublic?: boolean
}

/** The parent owns collection selection and resolves each collection through authorized data access. */
export type CommunityBoardView = 'mine' | 'public' | 'accepted'

/** A card action names presentation only; the parent resolves its original entity and operation. */
export type CommunityBoardAction = 'view-demand' | 'communicate' | 'view' | 'continue-draft' | 'check-submission'

/** Minimal card content; a stable parent-owned key keeps legacy and community identities independent. */
interface CommunityBoardCard {
  readonly key: string
  readonly title: string
  readonly serviceName: string
  readonly updatedAt: string
  readonly action: CommunityBoardAction
  readonly disabled?: boolean
  readonly busy?: boolean
}

/** Public rows must contain only approved fields; only draft rows accept necessary operation feedback. */
export type CommunityBoardRow = CommunityBoardCard & (
  | { readonly origin: 'draft'; readonly feedback?: string }
  | { readonly origin?: 'legacy' | 'community'; readonly feedback?: never }
)

/** Receipt-owned author roles remain distinct from the legacy engineer directory. */
export type CommunityChatAuthorKind = 'publisher' | 'acceptor' | 'admin' | 'system'

/** One received or locally pending message, resolved by its original parent-owned key. */
export interface CommunityChatMessageView {
  readonly key: string
  readonly authorKind: CommunityChatAuthorKind
  readonly authorName: string | null
  readonly isSelf: boolean
  readonly text: string
  readonly createdAt: string
  readonly attachments: readonly DemandAttachment[]
  readonly state: 'sent' | 'sending' | 'failed' | 'unknown'
  readonly recovery: 'none' | 'retry' | 'check'
  readonly recovering: boolean
  readonly error: string | null
}

/** Authorized chat projection; send permission is supplied directly rather than derived from order status. */
export interface CommunityChatView {
  readonly key: string
  readonly title: string
  readonly counterparty: { readonly name: string | null; readonly role: 'publisher' | 'acceptor' } | null
  readonly messages: readonly CommunityChatMessageView[]
  readonly status: 'loading' | 'ready' | 'error'
  readonly error: string | null
  readonly hasMoreMessages: boolean
  readonly loadingMoreMessages: boolean
  readonly canSend: boolean
  readonly readOnlyReason: string | null
}
