/** UI-owned forum presentation contracts; transport, permissions and operation keys stay with the owner. */
import type { DemandTranslate } from './DemandUI.tsx'

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
  readonly createdAt: string
  readonly likeCount: number | null
  readonly replyCount: number | null
}

/** Receipt-owned public reply. */
export interface ForumReplyView {
  readonly id: string
  readonly authorName: string | null
  readonly createdAt: string
  readonly body: string
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
    readonly posts: readonly ForumPostSummary[]
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
