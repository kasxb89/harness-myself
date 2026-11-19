/** Forum presentation uses confirmed records and frozen operation identities from its account model. */
import type { DemandTranslate } from './DemandUI.tsx'
import type { DemandLocaleKey } from './locales.ts'
import type { ForumIssue, ForumPendingView, ForumPost, ForumState } from './forum-types.ts'
import type { ForumCenterView, ForumOperationView, ForumPostSummary } from './forum-view.ts'

/**
 * Localize the reported cause without classifying every transport failure as a service failure.
 * @param issue - Structured model or Host failure.
 * @param t - Page dictionary.
 * @returns User-facing cause, without a token or raw upstream response.
 */
export function forumIssueText(issue: ForumIssue | null, t: DemandTranslate): string | null {
  if (issue === null) return null
  const labels: Readonly<Record<string, DemandLocaleKey>> = {
    FORUM_NETWORK: 'forumIssueNetwork', FORUM_TIMEOUT: 'forumIssueTimeout',
    FORUM_ACCOUNT_CHANGED: 'forumIssueSignIn', ACCOUNT_CHANGED: 'forumIssueSignIn',
    FORUM_AUTH_REQUIRED: 'forumIssueSignIn', LOGIN_REQUIRED: 'forumIssueSignIn',
    FORUM_CLOSED: 'forumIssueClosed', FORUM_NOT_FOUND: 'forumIssueNotFound',
    FORUM_INVALID_INPUT: 'forumIssueInvalid', FORUM_CURSOR_INVALID: 'forumIssueInvalid',
    FORUM_REQUEST_CONFLICT: 'forumIssueConflict', FORUM_REVISION_CONFLICT: 'forumIssueConflict',
    FORUM_UNAVAILABLE: 'forumIssueUnavailable', FORUM_STORAGE: 'forumIssueStorage',
    FORUM_RATE_LIMITED: 'forumIssueRateLimit', RATE_LIMITED: 'forumIssueRateLimit',
    FORUM_LIKE_NOT_CONFIRMED: 'forumIssueNotConfirmed',
  }
  return t(labels[issue.code] ?? 'forumIssueFailed')
}

/**
 * Present a pending operation without treating its local UUID as a confirmed server entity.
 * @param operation - Exact account-owned original submission, if any.
 * @param t - Page dictionary.
 * @returns Submission and explicit-recovery state.
 */
export function forumOperationView(operation: ForumPendingView | undefined, t: DemandTranslate): ForumOperationView {
  if (operation === undefined) return { state: 'idle' }
  if (operation.error?.unknown) return { state: 'unknown', checking: operation.inflight,
    message: `${t('forumOperationUnknown')} ${forumIssueText(operation.error, t) ?? ''}`.trim() }
  if (operation.error !== null) return { state: 'failed', recoverable: true, recovering: operation.inflight,
    message: forumIssueText(operation.error, t) ?? t('forumIssueFailed') }
  return operation.inflight ? { state: 'submitting' }
    : { state: 'unknown', checking: false, message: t('forumOperationUnknown') }
}

function timestamp(seconds: number): string {
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}
function summary(post: ForumPost): ForumPostSummary {
  return { id: post.id, title: post.title, excerpt: post.body, authorName: post.author.display_name || null,
    createdAt: timestamp(post.created_at), likeCount: post.like_count, replyCount: post.comment_count }
}

/**
 * Convert the authenticated forum snapshot into a pure list/detail view.
 * @param state - Current account's forum records, permissions and pending operations.
 * @param t - Page dictionary.
 * @returns Presentation with writes disabled until the current detail and config are verified.
 */
export function forumCenterView(state: ForumState, t: DemandTranslate): ForumCenterView {
  const enabled = state.availability === 'ready' && state.config?.enabled === true
  const selected = state.selectedPost?.id === state.selectedPostId ? state.selectedPost : null
  const verifiedDetail = enabled && state.selectedPostStatus === 'ready'
  const availability = state.availability === 'unavailable' ? 'disabled' : state.availability
  const reason = forumIssueText(state.error, t)
    ?? (availability === 'login-required' ? t('forumSignIn') : availability === 'disabled' ? t('forumDisabled') : null)
  return { availability, reason, accountName: null,
    canCreate: enabled && state.config.capabilities.immediate_publish,
    list: { posts: state.posts.items.map(summary), status: state.posts.status,
      error: forumIssueText(state.posts.error, t), hasMore: state.posts.hasMore, loadingMore: state.posts.loadingMore },
    detail: { postId: state.selectedPostId, status: state.selectedPostStatus,
      error: forumIssueText(state.selectedPostError, t) ?? forumIssueText(state.comments.error, t),
      post: selected === null ? null : { ...summary(selected), body: selected.body,
        replies: state.comments.items.filter(comment => comment.post_id === selected.id).map(comment => ({
          id: comment.id, authorName: comment.author.display_name || null,
          createdAt: timestamp(comment.created_at), body: comment.body,
        })),
        canReply: verifiedDetail && state.config.capabilities.comments,
        replyReason: verifiedDetail ? null : reason ?? t('forumPostUnavailable'),
        hasMoreReplies: state.comments.hasMore, loadingMoreReplies: state.comments.loadingMore,
        liked: selected.liked, canLike: verifiedDetail && state.config.capabilities.likes,
        likeOperation: forumOperationView(state.pending.find(operation => operation.kind === 'like'
          && operation.postId === selected.id), t),
      } },
  }
}
