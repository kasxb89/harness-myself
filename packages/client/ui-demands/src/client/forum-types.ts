/** Account-owned forum contracts, independent of orders, model sessions and billing. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Public forum author without login/contact metadata. */
export interface ForumAuthor { readonly id: number; readonly display_name: string }
/** Published post as projected by the user-facing API. */
export interface ForumPost {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly author: ForumAuthor
  readonly created_at: number
  readonly like_count: number
  readonly comment_count: number
  readonly liked: boolean
}
/** Published comment belonging to one exact post. */
export interface ForumComment {
  readonly id: string
  readonly post_id: string
  readonly body: string
  readonly author: ForumAuthor
  readonly created_at: number
}
/** Backend-owned forum availability and supported interactions. */
export interface ForumConfig {
  readonly revision: number
  readonly enabled: boolean
  readonly capabilities: { readonly immediate_publish: boolean; readonly likes: boolean; readonly comments: boolean }
}
/** Localizable failure; unknown means the original operation needs explicit confirmation. */
export interface ForumIssue { readonly code: string; readonly unknown: boolean; readonly operationId: string | null }
/** One account-owned cursor page, keeping verified records during refresh. */
export interface ForumPage<T> {
  readonly items: readonly T[]
  readonly status: 'loading' | 'ready' | 'error'
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly error: ForumIssue | null
}
/** Independent new-post scope and its original pending submission. */
export interface ForumPostDraft {
  readonly scopeKey: string
  readonly title: string
  readonly body: string
  readonly createdAt: number
  readonly postId: string | null
  readonly sending: boolean
  readonly locked: boolean
  readonly error: ForumIssue | null
}
/** Recoverable operation without pretending an unconfirmed comment is server content. */
export interface ForumPendingView {
  readonly operationId: string
  readonly scopeKey: string
  readonly postId: string | null
  readonly kind: 'post' | 'comment' | 'like'
  readonly title: string
  readonly body: string
  readonly liked: boolean | null
  readonly inflight: boolean
  readonly error: ForumIssue | null
}
/** Complete forum model snapshot for a pure root-owned view adapter. */
export interface ForumState {
  readonly availability: 'loading' | 'ready' | 'disabled' | 'unavailable' | 'login-required' | 'error'
  readonly accountId: string | null
  readonly config: ForumConfig | null
  readonly error: ForumIssue | null
  readonly posts: ForumPage<ForumPost>
  readonly selectedPostId: string | null
  readonly selectedPost: ForumPost | null
  readonly selectedPostStatus: 'loading' | 'ready' | 'error'
  readonly selectedPostError: ForumIssue | null
  readonly comments: ForumPage<ForumComment>
  readonly commentDraft: string
  readonly activePostDraftScope: string | null
  readonly postDrafts: readonly ForumPostDraft[]
  readonly pending: readonly ForumPendingView[]
}
/** Observable forum model and explicit user commands; no mutation is automatically replayed. */
export interface ForumFace {
  readonly hooks: { readonly forum: ObservableSnapshot<ForumState> }
  readonly refresh: () => void
  readonly loadMorePosts: () => void
  readonly openPost: (id: string) => void
  readonly closePost: () => void
  readonly startPost: () => void
  readonly openPostDraft: (scopeKey: string) => void
  readonly updatePostDraft: (scopeKey: string, patch: { readonly title?: string; readonly body?: string }) => void
  readonly publishPost: (scopeKey: string) => void
  readonly updateCommentDraft: (postId: string, body: string) => void
  readonly sendComment: (postId: string) => void
  readonly loadMoreComments: (postId: string) => void
  readonly setLiked: (postId: string, liked: boolean) => void
  readonly retryOperation: (operationId: string) => void
}
