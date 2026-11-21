/** Account-owned forum contracts, independent of orders, model sessions and billing. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Public forum author without login/contact metadata. */
export interface ForumAuthor { readonly id: number; readonly display_name: string; readonly avatar?: ForumAvatar }
/** Ready profile image metadata; its signed source is kept inside the Host. */
export interface ForumAvatar {
  readonly id: string
  readonly kind: 'image'
  readonly mime_type: string
  readonly size_bytes: number
  readonly sha256: string
  readonly expires_at: number
}
/** A ready image or video belongs only to the forum and is read through the current Host authorization. */
export interface ForumAttachment {
  readonly id: string
  readonly name: string
  readonly kind: 'image' | 'video'
  readonly mime_type: string
  readonly size_bytes: number
  readonly sha256: string
  readonly status: 'ready'
  readonly preview_path: string
  readonly download_path: string
}
/** Server-advertised image limits; no local product capacity is invented. */
export interface ForumUploadRules {
  readonly max_attachments: number
  readonly max_image_bytes: number
  readonly chunk_bytes: number
  readonly upload_ttl_seconds: number
  readonly allowed_mime_types: readonly string[]
}
/** Negotiated media-v2 limits remain separate from the legacy image-only rules. */
export interface ForumMediaRules extends ForumUploadRules { readonly max_video_bytes: number }
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
  readonly attachments?: readonly ForumAttachment[]
  readonly media?: readonly ForumAttachment[]
}
/** Published comment belonging to one exact post. */
export interface ForumComment {
  readonly id: string
  readonly post_id: string
  readonly body: string
  readonly author: ForumAuthor
  readonly created_at: number
  readonly attachments?: readonly ForumAttachment[]
  readonly media?: readonly ForumAttachment[]
  readonly reply_to_comment_id?: string
  readonly reply_to_author?: ForumAuthor | null
  readonly post_title?: string
}
/** Backend-owned forum availability and supported interactions. */
export interface ForumConfig {
  readonly revision: number
  readonly enabled: boolean
  readonly capabilities: {
    readonly immediate_publish: boolean
    readonly likes: boolean
    readonly comments: boolean
    readonly image_uploads?: boolean
    readonly forum_media_v2?: boolean
    readonly video_uploads?: boolean
    readonly my_activity?: boolean
    readonly comment_replies?: boolean
    readonly notifications?: boolean
    readonly forum_profile?: boolean
    readonly forum_profile_avatar_v1?: boolean
    readonly receipt_lookup?: boolean
  }
  readonly upload_rules?: ForumUploadRules
  readonly upload_rules_v2?: ForumMediaRules
}
/** One independent media destination, without sharing demand or chat identifiers. */
export type ForumUploadTarget = { readonly kind: 'post'; readonly scopeKey: string }
  | { readonly kind: 'comment'; readonly postId: string }
/** A local upload keeps unknown outcomes visible until the original upload is recovered. */
export interface ForumUploadView {
  readonly operationId: string
  readonly target: ForumUploadTarget
  readonly name: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly attachment: ForumAttachment | null
  readonly progress: number
  readonly status: 'uploading' | 'ready' | 'error' | 'unknown' | 'select-file'
  readonly error: ForumIssue | null
}
/** A selected reply target is verified within the exact post before submission. */
export interface ForumReplyTarget { readonly id: string; readonly postId: string; readonly author: ForumAuthor; readonly body: string }
/** Editable forum identity, independent of account login fields. */
export interface ForumProfile {
  readonly id: number
  readonly display_name: string
  readonly revision: number
  readonly avatar?: ForumAvatar
}
/** A recipient-scoped notification carries forum targets and public authors only. */
export interface ForumNotification {
  readonly id: string
  readonly type: 'reply' | 'like'
  readonly post_id: string
  readonly comment_id: string
  readonly actor: ForumAuthor
  readonly post_title: string
  readonly created_at: number
  readonly read_at: number
}
/** Account tools use server-scoped cursor pages and retain verified state during read failures. */
export interface ForumActivityState {
  readonly scope: 'all' | 'mine' | 'comments'
  readonly myPosts: ForumPage<ForumPost>
  readonly myComments: ForumPage<ForumComment>
  readonly profile: {
    readonly value: ForumProfile | null
    readonly status: 'loading' | 'ready' | 'error'
    readonly saving: boolean
    readonly error: ForumIssue | null
  }
  readonly notifications: ForumPage<ForumNotification> & { readonly unreadCount: number | null; readonly readingIds: readonly string[] }
  readonly highlightedCommentId: string | null
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
  readonly activity?: ForumActivityState
  readonly uploads?: readonly ForumUploadView[]
  readonly replyTarget?: ForumReplyTarget | null
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
  readonly setFeedScope?: (scope: ForumActivityState['scope']) => void
  readonly loadMoreOwnPosts?: () => void
  readonly loadMoreOwnComments?: () => void
  readonly refreshNotifications?: () => void
  readonly loadMoreNotifications?: () => void
  readonly markNotificationsRead?: (ids: readonly string[]) => void
  readonly openNotification?: (id: string) => void
  readonly openHistoryComment?: (postId: string, commentId: string) => void
  readonly updateNickname?: (displayName: string) => void
  readonly setReplyTarget?: (postId: string, commentId: string | null) => void
  readonly addAttachments?: (target: ForumUploadTarget, files: readonly File[]) => void
  readonly retryAttachment?: (operationId: string, file?: File) => void
  readonly removeAttachment?: (operationId: string) => void
  readonly contentUrl?: (attachmentId: string, disposition?: 'inline' | 'attachment') => string | null
}
