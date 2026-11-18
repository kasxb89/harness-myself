/** JSON presentation data and event callbacks for the human-engineer demand page. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Service state without discarding already loaded history. */
export type DemandAvailability = 'loading' | 'ready' | 'login-required' | 'unconfigured' | 'disabled' | 'error'
/** Server-owned stages of one independent demand. */
export type DemandStatus = 'pending' | 'communicating' | 'in_progress' | 'awaiting_acceptance' | 'completed' | 'cancelled' | 'closed'
/** Presence is supplied by the server; the page does not infer it from the local clock. */
export type EngineerPresence = 'available' | 'busy' | 'offline'
/** A deployment-defined engineering domain. */
export interface DemandCategory {
  readonly id: string
  readonly label: string
}
/** One actual engineer published by the administrator. */
export interface DemandEngineer {
  readonly id: string
  readonly displayName: string
  readonly avatarUrl: string | null
  readonly introduction: string
  readonly categoryIds: readonly string[]
  readonly skills: readonly string[]
  readonly presence: EngineerPresence
  readonly canStart: boolean
  readonly unavailableReason: string | null
}
/** A published service capability routed through platform reception, never a live person. */
export interface DemandServiceProfile {
  readonly id: string
  readonly code: string
  readonly displayName: string
  readonly serviceDirection: string
  readonly introduction: string
  readonly categoryIds: readonly string[]
  readonly avatarUrl: string | null
  readonly canStart: boolean
}
/** Optional additive routing facts preserve compatibility with older direct-engineer projections. */
export interface DemandRouting {
  readonly serviceProfileId?: string | null
  readonly serviceProfileName?: string | null
  readonly intakeMode?: 'platform' | 'direct'
  readonly assigned?: boolean
}
/** A user's existing private demand. */
export interface DemandSummary extends DemandRouting {
  readonly id: string
  readonly number: string
  readonly title: string
  readonly engineer: DemandEngineer | null
  readonly status: DemandStatus
  readonly updatedAt: string
  readonly preview: string
  readonly unreadCount: number
}
/** Upload state or an authorized attachment returned with a confirmed message. */
export interface DemandAttachment {
  readonly id: string
  readonly name: string
  readonly kind: 'image' | 'video' | 'file'
  readonly sizeBytes: number
  readonly status: 'uploading' | 'ready' | 'failed'
  readonly progressPercent?: number | null
  readonly previewUrl?: string | null
  readonly error?: string | null
}
/** A persisted message or a scoped pending send supplied by the controller. */
export interface DemandMessage {
  readonly id: string
  readonly author: 'user' | 'engineer' | 'system'
  readonly authorName?: string | null
  readonly text: string
  readonly createdAt: string
  readonly state: 'sending' | 'sent' | 'failed'
  readonly read: boolean
  readonly retryable: boolean
  readonly attachments: readonly DemandAttachment[]
  readonly error?: string | null
}
/** The current delivery offered for the user's acceptance. */
export interface DemandDelivery {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly submittedAt: string
  readonly status: 'pending' | 'accepted'
  readonly attachments: readonly DemandAttachment[]
}
/** Selected demand or an unpublished draft with its own unique viewing identity. */
export interface DemandConversation extends DemandRouting {
  readonly scopeKey: string
  readonly requestId: string | null
  readonly number: string | null
  readonly title: string
  readonly engineer: DemandEngineer | null
  readonly status: DemandStatus | null
  readonly messages: readonly DemandMessage[]
  readonly messagesStatus: 'loading' | 'ready' | 'error'
  readonly error: string | null
  readonly hasEarlier: boolean
  readonly loadingEarlier: boolean
  readonly canSend: boolean
  readonly readOnlyReason: string | null
  readonly delivery: DemandDelivery | null
  readonly acceptingDelivery: boolean
}
/** Optional first-demand information, stored separately for each scopeKey by the controller. */
export interface DemandDraftFields {
  readonly text: string
  readonly title: string
  readonly budget: string
  readonly expectedDate: string
}
/** Current conversation's draft and upload state; server receipts govern send completion. */
export interface DemandDraft extends DemandDraftFields {
  readonly scopeKey: string
  readonly attachments: readonly DemandAttachment[]
  readonly sending: boolean
  readonly error: string | null
}
/** A real local scope that can be reopened without minting another request or operation key. */
export interface DemandDraftSummary extends DemandRouting {
  readonly scopeKey: string
  readonly title: string
  readonly engineer: DemandEngineer | null
  readonly updatedAt: string
  readonly pending: boolean
  readonly error: string | null
}
/** Deployment-controlled file chooser and upload constraints. */
export interface DemandUploadRules {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxImageBytes?: number
  readonly maxVideoBytes?: number
  readonly accept: string
}
/** Stable JSON projection from the Client model, not a second owner of business data. */
export interface DemandPageState {
  readonly availability: DemandAvailability
  readonly error: string | null
  readonly categories: readonly DemandCategory[]
  readonly engineers: readonly DemandEngineer[]
  readonly directoryMode: 'services' | 'engineers'
  readonly serviceProfiles: readonly DemandServiceProfile[]
  readonly servicesStatus: 'loading' | 'ready' | 'error'
  readonly servicesHaveMore: boolean
  readonly loadingMoreServices: boolean
  readonly servicesTotal: number
  readonly serviceQuery: string
  readonly serviceCategoryId: string
  readonly requests: readonly DemandSummary[]
  readonly drafts: readonly DemandDraftSummary[]
  readonly requestsStatus: 'loading' | 'ready' | 'error'
  readonly requestsHaveMore: boolean
  readonly loadingMoreRequests: boolean
  readonly conversation: DemandConversation | null
  readonly draft: DemandDraft | null
  readonly uploadRules: DemandUploadRules
}
/** Root-owned data and commands; no model call or AI-chat session is created by this UI. */
export interface DemandPageFace {
  readonly hooks: { readonly demands: ObservableSnapshot<DemandPageState> }
  readonly refresh: () => void
  readonly openLogin: () => void
  readonly startRequest: (engineerId: string) => void
  readonly startServiceRequest: (serviceProfileId: string) => void
  readonly setServiceFilter: (query: string, categoryId: string) => void
  readonly loadMoreServices: () => void
  readonly openRequest: (requestId: string) => void
  readonly openDraft: (scopeKey: string) => void
  readonly loadMoreRequests: () => void
  readonly updateDraft: (patch: Partial<DemandDraftFields>) => void
  readonly send: () => void
  /** Transient browser selection only; never put File objects into the snapshot or wire state. */
  readonly addAttachments: (files: readonly File[]) => void
  readonly removeAttachment: (attachmentId: string) => void
  readonly retryAttachment: (attachmentId: string) => void
  readonly retryMessage: (messageId: string) => void
  readonly loadEarlierMessages: () => void
  readonly downloadAttachment: (attachmentId: string) => void
  readonly acceptDelivery: (deliveryId: string) => void
}
/** Framework-bound main panel props and localized copy. */
export type DemandPageProps = PropsRuntime<'main'> & PropsLocale<'demands'> & InjectFace<DemandPageFace>
