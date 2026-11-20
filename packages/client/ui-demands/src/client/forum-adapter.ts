/** Forum presentation uses confirmed records and frozen operation identities from its account model. */
import type { DemandTranslate } from './DemandUI.tsx'
import type { DemandLocaleKey } from './locales.ts'
import type { ForumAttachment, ForumComment, ForumFace, ForumIssue, ForumPendingView, ForumPost, ForumState, ForumUploadTarget } from './forum-types.ts'
import type { ForumCenterView, ForumImageComposerView, ForumImageView, ForumOperationView, ForumPostSummary, ForumReplyView } from './forum-view.ts'
import type { ForumAccountControlLabels, ForumAccountControlsProps, ForumAccountNickname } from './ForumAccountControls.tsx'
import { demandTime } from './DemandUI.tsx'

/**
 * Supply account-tool copy from the forum dictionary without inventing any account data.
 * @param t - Current locale dictionary.
 * @returns Complete account-tool labels and formatters.
 */
export function forumAccountControlLabels(t: DemandTranslate): ForumAccountControlLabels {
  return {
    history: t('forumCollections'), scopes: { all: t('forumAllPosts'), mine: t('forumMyPosts'), comments: t('forumMyComments') },
    notifications: t('forumNotifications'), notificationsUnread: count => t('forumNotificationsUnread', { count }),
    notificationAction: (kind, name) => t(kind === 'reply' ? 'forumNotificationReply' : 'forumNotificationLike', { name }),
    notificationTime: value => demandTime(value, t),
    notificationOpen: item => t('forumNotificationOpen', { title: item.postTitle }),
    markRead: item => t('forumNotificationMarkRead', { title: item.postTitle }),
    noNotifications: t('forumNoNotifications'), loading: t('loading'), retry: t('retry'), loadMore: t('forumLoadMoreNotifications'),
    nickname: t('forumNickname'), nicknameTitle: t('forumNicknameTitle'), nicknameField: t('forumNicknameField'),
    nicknameHint: t('forumNicknameHint'), saveNickname: t('forumNicknameSave'), savingNickname: t('forumNicknameSaving'),
    cancel: t('cancel'), close: t('close'),
  }
}

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
    FORUM_REQUEST_CONFLICT: 'forumIssueConflict', FORUM_IDEMPOTENCY_CONFLICT: 'forumIssueConflict',
    FORUM_REVISION_CONFLICT: 'forumIssueRevisionConflict',
    FORUM_UNAVAILABLE: 'forumIssueUnavailable', FORUM_STORAGE_UNAVAILABLE: 'forumIssueUnavailable', FORUM_STORAGE: 'forumIssueStorage',
    FORUM_RATE_LIMITED: 'forumIssueRateLimit', RATE_LIMITED: 'forumIssueRateLimit',
    FORUM_LIKE_NOT_CONFIRMED: 'forumIssueNotConfirmed',
    FORUM_PROFILE_INVALID: 'forumIssueProfileInvalid',
    FORUM_ATTACHMENT_INVALID: 'forumIssueAttachmentInvalid',
    FORUM_UPLOAD_UNSUPPORTED: 'uploadUnsupported', FORUM_UPLOAD_TOO_LARGE: 'uploadTooLarge',
    FORUM_UPLOAD_OFFSET_CONFLICT: 'forumIssueUploadOffset',
    FORUM_UPLOAD_FILE_MISMATCH: 'uploadFileMismatch', FORUM_UPLOAD_RESELECT: 'uploadReselect',
    FORUM_UPLOAD_PENDING: 'forumImagesPending', FORUM_UPLOAD_TOO_MANY: 'forumIssueTooManyImages',
    FORUM_UPLOAD_INVALID: 'forumIssueImageInvalid', FORUM_UPLOAD_FAILED: 'forumIssueUploadFailed',
    FORUM_RESULT_UNKNOWN: 'forumOperationUnknown', FORUM_PENDING_STORAGE_FAILED: 'pendingStorageFailed',
    FORUM_PROTOCOL_INVALID: 'forumIssueProtocol',
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
/**
 * Hide contact-like retained names while preserving the backend pseudonym bound to its exact author ID.
 * @param value - Public forum display name; never an account login fallback.
 * @param id - Author ID from that same public record.
 * @returns A safe display name, or null for the generic localized member label.
 */
export function forumPublicAuthorName(value: string, id: number): string | null {
  if (Number.isSafeInteger(id) && id > 0 && value === `论坛用户${id}`) return value
  const normalized = value.normalize('NFKC').replace(/[\s\p{Cf}().\-\u2010-\u2015\u2212]/gu, '')
  const phone = /(?:^|\D)\+?\d{7,15}(?!\d)/u.test(normalized)
  const masked = normalized.match(/[\d*xX•●]{7,20}/gu)?.some(part => /[*xX•●]/u.test(part)
    && part.replace(/\D/gu, '').length >= 3) === true
  return phone || masked ? null : value || null
}
function images(attachments: readonly ForumAttachment[] | undefined, url?: ForumFace['contentUrl']): readonly ForumImageView[] {
  return (attachments ?? []).map(attachment => ({ id: attachment.id, name: attachment.name, sizeBytes: attachment.size_bytes,
    previewUrl: url?.(attachment.id, 'inline') ?? null }))
}
function summary(post: ForumPost, url?: ForumFace['contentUrl']): ForumPostSummary {
  return { id: post.id, title: post.title, excerpt: post.body, authorName: forumPublicAuthorName(post.author.display_name, post.author.id),
    createdAt: timestamp(post.created_at), likeCount: post.like_count, replyCount: post.comment_count,
    images: images(post.attachments, url) }
}
function reply(comment: ForumComment, url?: ForumFace['contentUrl']): ForumReplyView {
  const author = comment.reply_to_author
  return { id: comment.id, authorName: forumPublicAuthorName(comment.author.display_name, comment.author.id),
    createdAt: timestamp(comment.created_at), body: comment.body, images: images(comment.attachments, url),
    replyTo: !comment.reply_to_comment_id ? null : { id: comment.reply_to_comment_id,
      authorName: author === undefined || author === null ? null : forumPublicAuthorName(author.display_name, author.id), excerpt: '' } }
}

/**
 * Bind only actual advertised account tools to their explicit account-scoped commands.
 * @param state - Current forum snapshot.
 * @param commands - Current account's explicit commands.
 * @param t - Current dictionary.
 * @param nickname - Controlled nickname form supplied by the workspace, if available.
 * @returns No tools when an older backend has not advertised their capabilities.
 */
export function forumAccountTools(state: ForumState, commands: Omit<ForumFace, 'hooks'>, t: DemandTranslate,
  nickname?: ForumAccountNickname): Omit<ForumAccountControlsProps, 'labels'> | undefined {
  const activity = state.activity, caps = state.config?.capabilities
  if (activity === undefined || caps === undefined) return undefined
  const history = caps.my_activity === true && commands.setFeedScope !== undefined
  const notices = caps.notifications === true && commands.openNotification !== undefined
    && commands.refreshNotifications !== undefined && commands.loadMoreNotifications !== undefined
  const profile = caps.forum_profile === true ? nickname : undefined
  if (!history && !notices && profile === undefined) return undefined
  const notifications = activity.notifications
  return { scope: activity.scope, scopes: history ? ['all', 'mine', 'comments'] : [],
    disabled: state.availability !== 'ready' || state.config?.enabled !== true,
    onScopeChange: (value) => { commands.setFeedScope?.(value) },
    ...(profile === undefined ? {} : { nickname: profile }),
    ...(!notices ? {} : { notifications: { unreadCount: notifications.unreadCount, status: notifications.status,
      items: notifications.items.map(item => ({ id: item.id, kind: item.type,
        actorName: forumPublicAuthorName(item.actor.display_name, item.actor.id) ?? t('forumMember'),
        postTitle: item.post_title, excerpt: '', createdAt: timestamp(item.created_at), unread: item.read_at === 0 })),
      error: forumIssueText(notifications.error, t), busy: notifications.readingIds.length > 0,
      hasMore: notifications.hasMore, loadingMore: notifications.loadingMore,
      onOpen: (id) => { commands.openNotification?.(id) }, onRetry: () => { commands.refreshNotifications?.() },
      onLoadMore: () => { commands.loadMoreNotifications?.() },
      ...(commands.markNotificationsRead === undefined ? {} : { onMarkRead: (id: string) => { commands.markNotificationsRead?.([id]) } }),
    } }),
  }
}

/**
 * Project scoped forum uploads without using demand IDs or link-endpoint paths as image sources.
 * @param state - Actual upload and configuration state.
 * @param commands - Current account's explicit media commands.
 * @param target - Exact draft or post destination.
 * @param t - Current dictionary.
 * @returns Qualified controls or retained original uploads when capabilities become unavailable.
 */
export function forumImageComposer(state: ForumState, commands: Omit<ForumFace, 'hooks'>,
  target: ForumUploadTarget, t: DemandTranslate): ForumImageComposerView | undefined {
  const rows = (state.uploads ?? []).filter(row => row.target.kind === target.kind
    && (row.target.kind === 'post' && target.kind === 'post' ? row.target.scopeKey === target.scopeKey
      : row.target.kind === 'comment' && target.kind === 'comment' && row.target.postId === target.postId))
  const rules = state.config?.upload_rules
  const supported = state.config?.capabilities.image_uploads === true && rules !== undefined
    && commands.addAttachments !== undefined && commands.removeAttachment !== undefined && commands.retryAttachment !== undefined
  if (!supported && rows.length === 0) return undefined
  return { items: rows.map((row) => {
    const requiresFile = row.status === 'select-file' || row.error?.code === 'FORUM_UPLOAD_FILE_MISMATCH'
    const cause = row.status === 'select-file' ? t('uploadReselect') : forumIssueText(row.error, t)
    const error = row.status !== 'unknown' ? cause : cause === null || row.error?.code === 'FORUM_RESULT_UNKNOWN'
      ? t('forumUploadUnknown') : `${cause} ${t('forumUploadUnknown')}`
    return { id: row.operationId, name: row.name, sizeBytes: row.sizeBytes,
      previewUrl: row.attachment === null ? null : commands.contentUrl?.(row.attachment.id, 'inline') ?? null,
      status: row.status === 'ready' ? 'ready' : row.status === 'uploading' ? 'uploading' : 'failed',
      progressPercent: row.progress, error, requiresFile,
      retryLabel: requiresFile ? t('forumChooseOriginalImage') : row.status === 'unknown' ? t('forumCheckUpload') : t('retryAttachment'),
    }
  }), canAdd: supported && state.availability === 'ready' && state.config.enabled,
  accept: supported ? rules.allowed_mime_types.join(',') : null,
  maxAttachments: supported ? rules.max_attachments : null, maxBytes: supported ? rules.max_image_bytes : null,
  allowImageOnly: supported,
  onAdd: (files) => { commands.addAttachments?.(target, files) },
  onRemove: (id) => { commands.removeAttachment?.(id) }, onRetry: (id, file) => { commands.retryAttachment?.(id, file) },
  }
}

/**
 * Convert the authenticated forum snapshot into a pure list/detail view.
 * @param state - Current account's forum records, permissions and pending operations.
 * @param t - Page dictionary.
 * @param url - Current Host authorization URL provider, never a raw link endpoint.
 * @returns Presentation with writes disabled until the current detail and config are verified.
 */
export function forumCenterView(state: ForumState, t: DemandTranslate, url?: ForumFace['contentUrl']): ForumCenterView {
  const enabled = state.availability === 'ready' && state.config?.enabled === true
  const selected = state.selectedPost?.id === state.selectedPostId ? state.selectedPost : null
  const verifiedDetail = enabled && state.selectedPostStatus === 'ready'
  const availability = state.availability === 'unavailable' ? 'disabled' : state.availability
  const reason = forumIssueText(state.error, t)
    ?? (availability === 'login-required' ? t('forumSignIn') : availability === 'disabled' ? t('forumDisabled') : null)
  const scope = state.activity?.scope ?? 'all'
  const page = scope === 'mine' ? state.activity?.myPosts ?? state.posts : scope === 'comments' ? state.activity?.myComments ?? state.comments : state.posts
  const profile = state.activity?.profile.value
  const accountName = profile === undefined || profile === null ? null : forumPublicAuthorName(profile.display_name, profile.id)
  return { availability, reason, accountName,
    canCreate: enabled && state.config.capabilities.immediate_publish,
    list: { kind: scope === 'comments' ? 'comments' : 'posts',
      posts: scope === 'comments' ? [] : (scope === 'mine' ? state.activity?.myPosts.items ?? state.posts.items : state.posts.items).map(post => summary(post, url)),
      comments: scope !== 'comments' ? [] : (state.activity?.myComments.items ?? []).map(comment => ({ ...reply(comment, url),
        postId: comment.post_id, postTitle: comment.post_title ?? '' })), status: page.status,
      error: forumIssueText(page.error, t), hasMore: page.hasMore, loadingMore: page.loadingMore },
    detail: { postId: state.selectedPostId, status: state.selectedPostStatus,
      error: forumIssueText(state.selectedPostError, t) ?? forumIssueText(state.comments.error, t),
      post: selected === null ? null : { ...summary(selected, url), body: selected.body,
        replies: state.comments.items.filter(comment => comment.post_id === selected.id).map(comment => reply(comment, url)),
        canReply: verifiedDetail && state.config.capabilities.comments,
        replyReason: verifiedDetail ? null : reason ?? t('forumPostUnavailable'),
        hasMoreReplies: state.comments.hasMore, loadingMoreReplies: state.comments.loadingMore,
        liked: selected.liked, canLike: verifiedDetail && state.config.capabilities.likes,
        likeOperation: forumOperationView(state.pending.find(operation => operation.kind === 'like'
          && operation.postId === selected.id), t),
      } },
  }
}
