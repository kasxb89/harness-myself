/** UI-owned forum presentation contracts; transport, permissions and operation keys stay with the owner. */
import type { DemandTranslate } from './DemandUI.tsx'
import type { ForumAccountControlsProps } from './ForumAccountControls.tsx'

/** A forum-owned image reference already normalized and authorized by its owner. */
export interface ForumImageView {
  readonly id: string
  readonly name: string
  readonly sizeBytes: number
  readonly previewUrl: string | null
  /** Older image-only owners omit the discriminator. */
  readonly kind?: 'image' | 'video'
  readonly mimeType?: string
}

/** A staged forum image retains its original upload identity until confirmed or explicitly removed. */
export interface ForumImageUploadView extends ForumImageView {
  readonly status: 'uploading' | 'ready' | 'failed'
  readonly progressPercent: number | null
  readonly error: string | null
  readonly requiresFile?: boolean
  readonly retryLabel?: string
}

/** Only verified backend limits allow new selections; no absent limit receives a UI default. */
export interface ForumImageComposerView {
  readonly items: readonly ForumImageUploadView[]
  readonly canAdd: boolean
  readonly accept: string | null
  readonly maxAttachments: number | null
  readonly maxBytes: number | null
  /** Video choices remain absent until their owner supplies a verified independent bound. */
  readonly maxVideoBytes?: number | null
  readonly allowImageOnly: boolean
  readonly onAdd: (files: readonly File[]) => void
  readonly onRemove: (id: string) => void
  readonly onRetry: (id: string, file?: File) => void
}

/** A specific existing comment selected by a person; it is never inferred from the draft text. */
export interface ForumReplyTargetView {
  readonly id: string
  readonly authorName: string | null
  readonly excerpt: string
}

/** Recover an uncertain or sealed submission through its original owner callback. */
export type ForumOperationView =
  | { readonly state: 'idle' | 'submitting' }
  | { readonly state: 'unknown'; readonly checking: boolean; readonly message?: string }
  | { readonly state: 'failed'; readonly message: string; readonly recoverable?: boolean; readonly recovering?: boolean }

/** Only actual supplied counts are displayed; null means the count is unavailable. */
export interface ForumPostSummary {
  readonly id: string
  readonly title: string
  readonly excerpt: string
  readonly authorName: string | null
  readonly authorAvatarUrl?: string | null
  readonly createdAt: string
  readonly likeCount: number | null
  readonly replyCount: number | null
  readonly images?: readonly ForumImageView[]
}

/** Receipt-owned public reply. */
export interface ForumReplyView {
  readonly id: string
  readonly authorName: string | null
  readonly authorAvatarUrl?: string | null
  readonly createdAt: string
  readonly body: string
  readonly images?: readonly ForumImageView[]
  readonly replyTo?: ForumReplyTargetView | null
}

/** Confirmed comments in the current person's server-owned history collection. */
export interface ForumCommentHistoryView extends ForumReplyView {
  readonly postId: string
  readonly postTitle: string
}

/** Server-normalized permissions are independent of role names or visible counts. */
export interface ForumPostDetail extends ForumPostSummary {
  readonly body: string
  readonly replies: readonly ForumReplyView[]
  readonly canReply: boolean
  readonly replyReason: string | null
  readonly hasMoreReplies: boolean
  readonly loadingMoreReplies: boolean
  readonly liked: boolean
  readonly canLike: boolean
  readonly likeOperation: ForumOperationView
}

/** Parent-owned fields survive closing the composer and navigation. */
export interface ForumPostDraft {
  readonly title: string
  readonly body: string
}

/** Retained data stays visible during loading, query errors or disabled publication. */
export interface ForumCenterView {
  readonly availability: 'loading' | 'ready' | 'disabled' | 'error' | 'login-required'
  readonly reason: string | null
  readonly accountName: string | null
  readonly canCreate: boolean
  readonly list: {
    readonly kind?: 'posts' | 'comments'
    readonly posts: readonly ForumPostSummary[]
    readonly comments?: readonly ForumCommentHistoryView[]
    readonly status: 'loading' | 'ready' | 'error'
    readonly error: string | null
    readonly hasMore: boolean
    readonly loadingMore: boolean
  }
  readonly detail: {
    readonly postId: string | null
    readonly post: ForumPostDetail | null
    readonly status: 'loading' | 'ready' | 'error'
    readonly error: string | null
  }
}

/** Pure view inputs; permissions and original submission identity remain outside React. */
export interface ForumCenterProps {
  readonly view: ForumCenterView
  readonly postDraft: ForumPostDraft
  readonly replyDraft: string
  readonly accountControls?: Omit<ForumAccountControlsProps, 'labels'>
  readonly postMedia?: ForumImageComposerView
  readonly replyMedia?: ForumImageComposerView
  readonly replyTarget?: ForumReplyTargetView | null
  readonly highlightedReplyId?: string | null
  readonly onSelectReply?: (id: string) => void
  readonly onCancelReply?: () => void
  readonly onOpenHistoryComment?: (postId: string, commentId: string) => void
  readonly postLocked: boolean
  readonly replyLocked: boolean
  readonly postOperation: ForumOperationView
  readonly replyOperation: ForumOperationView
  readonly postComposerOpen: boolean
  readonly onOpenPostComposer: () => void
  readonly onClosePostComposer: () => void
  readonly onOpenPost: (id: string) => void
  readonly onBack: () => void
  readonly onRefresh: () => void
  readonly onLoadMore: () => void
  readonly onLoadMoreReplies: () => void
  readonly onStartPost: () => void
  readonly onChangePost: (patch: Partial<ForumPostDraft>) => void
  readonly onSubmitPost: () => void
  readonly onCheckPost: () => void
  readonly onChangeReply: (text: string) => void
  readonly onSubmitReply: () => void
  readonly onCheckReply: () => void
  readonly onToggleLike: (postId: string) => void
  readonly onCheckLike: (postId: string) => void
  readonly t: DemandTranslate
}
