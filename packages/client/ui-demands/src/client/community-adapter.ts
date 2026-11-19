/** Pure presentation adapters; wire parsing, authorization and operations remain with their existing owners. */
import type { DemandAttachment, DemandPageState, DemandUploadRules } from './types.ts'
import type { DemandTranslate } from './DemandUI.tsx'
import type { DemandLocaleKey } from './locales.ts'
import type {
  CommunityAttachment, CommunityIssue, CommunityListing, CommunityOrder, CommunityPendingView,
  CommunityPublicationDraft, CommunityState, CommunityUploadRules, CommunityUploadView,
} from './community-types.ts'
import type {
  CommunityBoardRow, CommunityBoardView, CommunityChatMessageView, CommunityChatView, CommunityDemandAccess,
  CommunityOperationView, CommunityPublicDemandView, CommunityPublishDraft, CommunityServiceChoice,
} from './community-view.ts'

/** Approved media URL lookup. A denied lookup remains absent; no URL is constructed here. */
export type CommunityContentLookup = (attachmentId: string) => string | null
/** Parent-owned card destination; these kinds identify existing entities rather than HTTP routes. */
export interface CommunityBoardTarget {
  readonly kind: 'legacy-order' | 'legacy-draft' | 'community-order' | 'community-publication' | 'community-listing'
  readonly id: string
}
/** Selected board rows and actual load states from their owning collections. */
export interface CommunityBoardPresentation {
  readonly rows: readonly CommunityBoardRow[]
  readonly loading: boolean
  readonly error: string | null
  readonly hasMore: boolean
  readonly loadingMore: boolean
}
/** Public-safe detail and the original accept operation, if any. */
export interface CommunityDetailsPresentation {
  readonly demand: CommunityPublicDemandView
  readonly access: CommunityDemandAccess
  readonly operation: CommunityOperationView
  readonly operationId: string | null
}
/** Controlled publication view; private text and budget are not promoted to public fields. */
export interface CommunityPublishPresentation {
  readonly draft: CommunityPublishDraft
  readonly services: readonly CommunityServiceChoice[]
  readonly attachments: readonly DemandAttachment[]
  readonly locked: boolean
  readonly operation: CommunityOperationView
  readonly operationId: string | null
  readonly canPublish: boolean
  readonly unavailableReason: string | null
  readonly rules: DemandUploadRules
}
/** Authorized participant chat and a lookup from pending view keys to original operation IDs. */
export interface CommunityChatPresentation {
  readonly conversation: CommunityChatView
  readonly draftText: string
  readonly attachments: readonly DemandAttachment[]
  readonly locked: boolean
  readonly sending: boolean
  readonly draftError: string | null
  readonly rules: DemandUploadRules
  readonly messageOperations: Readonly<Record<string, string>>
}

const targetKinds: readonly CommunityBoardTarget['kind'][] = [
  'legacy-order', 'legacy-draft', 'community-order', 'community-publication', 'community-listing',
]
const key = (kind: CommunityBoardTarget['kind'], id: string): string => `${kind}:${id}`
const seconds = (value: number): string => new Date(value * 1000).toISOString()
const milliseconds = (value: number): string => new Date(value).toISOString()
const issueKeys: Readonly<Record<string, DemandLocaleKey>> = {
  COMMUNITY_DISABLED: 'communityIssueUnavailable', COMMUNITY_ACCOUNT_CHANGED: 'communityIssueSignIn',
  ACCOUNT_CHANGED: 'communityIssueSignIn', COMMUNITY_UNAVAILABLE: 'communityIssueUnavailable',
  COMMUNITY_CANCELLED: 'communityIssueNetwork', COMMUNITY_STORAGE_UNAVAILABLE: 'communityIssueUnavailable',
  COMMUNITY_AUTH_REQUIRED: 'communityIssueSignIn', COMMUNITY_CURSOR_INVALID: 'invalidRequestFields',
  COMMUNITY_FORBIDDEN: 'requestReadOnly', COMMUNITY_READ_ONLY: 'requestReadOnly', COMMUNITY_REOPEN_FORBIDDEN: 'requestReadOnly',
  COMMUNITY_NOT_FOUND: 'communityIssueNotFound', COMMUNITY_ALREADY_ACCEPTED: 'communityIssueNotOpen',
  COMMUNITY_ORDER_NOT_OPEN: 'communityIssueNotOpen', COMMUNITY_STATUS_CONFLICT: 'communityIssueNotOpen',
  COMMUNITY_SELF_ACCEPT_FORBIDDEN: 'communityIssueSelf', COMMUNITY_EXPLICIT_PUBLICATION_REQUIRED: 'communityIssueConsent',
  COMMUNITY_IDEMPOTENCY_CONFLICT: 'communityIssueOperationChanged', COMMUNITY_REVISION_CONFLICT: 'communityIssueNotOpen',
  COMMUNITY_STATE_CONFLICT: 'communityIssueNotOpen', COMMUNITY_ATTACHMENT_IN_USE: 'communityIssueOperationChanged',
  COMMUNITY_INVALID_INPUT: 'invalidRequestFields', COMMUNITY_ATTACHMENT_NOT_READY: 'communityIssueAttachmentNotReady',
  COMMUNITY_UPLOAD_TOO_MANY: 'communityIssueTooManyAttachments', COMMUNITY_UPLOAD_TOO_LARGE: 'uploadTooLarge',
  COMMUNITY_UPLOAD_UNSUPPORTED: 'uploadUnsupported', COMMUNITY_UPLOAD_RESELECT: 'uploadReselect',
  COMMUNITY_UPLOAD_FILE_MISMATCH: 'uploadFileMismatch', COMMUNITY_PENDING_STORAGE_FAILED: 'pendingStorageFailed',
  COMMUNITY_PENDING_FULL: 'pendingStorageFailed', COMMUNITY_PENDING_INVALID: 'pendingStorageFailed',
  COMMUNITY_PENDING_BODY_CHANGED: 'communityIssueOperationChanged', COMMUNITY_NETWORK: 'communityIssueNetwork',
  COMMUNITY_TIMEOUT: 'communityIssueNetwork', COMMUNITY_UPLOAD_FAILED: 'uploadFailed',
}

/**
 * Localize a model issue without exposing raw protocol or transport details.
 * @param issue - Model-owned result classification, or no issue.
 * @param t - Existing demand locale translator.
 * @returns Localized copy that preserves unknown outcomes, or null.
 */
export function communityIssueText(issue: CommunityIssue | null, t: DemandTranslate): string | null {
  return issue === null ? null : t(issue.unknown ? 'communityIssueUnknown' : issueKeys[issue.code] ?? 'errorHint')
}

function unavailable(state: CommunityState, t: DemandTranslate): string | null {
  if (state.accountId === null || state.availability === 'login-required') return t('communityIssueSignIn')
  if (state.availability === 'loading') return t('loading')
  if (state.availability === 'error') return communityIssueText(state.error, t) ?? t('errorHint')
  return state.availability === 'ready' && state.config?.enabled === true ? null : t('communityIssueUnavailable')
}

function operation(pending: CommunityPendingView | undefined, failure: CommunityIssue | null, t: DemandTranslate): CommunityOperationView {
  if (pending?.inflight) return { state: 'submitting' }
  const error = pending === undefined ? failure : pending.error
  if (error?.unknown || pending !== undefined && error === null) return {
    state: 'unknown', checking: false, message: communityIssueText(error, t) ?? t('communityIssueUnknown'),
  }
  return error === null ? { state: 'idle' } : {
    state: 'failed', message: communityIssueText(error, t) ?? t('errorHint'), recoverable: pending !== undefined, recovering: false,
  }
}

/**
 * Recover the original entity from a board key without resolving any route.
 * @param rowKey - Exact key returned in a normalized board row.
 * @returns Its parent-owned destination or null for an unrelated key.
 */
export function communityBoardTarget(rowKey: string): CommunityBoardTarget | null {
  for (const kind of targetKinds) if (rowKey.startsWith(`${kind}:`)) {
    const id = rowKey.slice(kind.length + 1)
    return id === '' ? null : { kind, id }
  }
  return null
}

function orderRow(item: CommunityOrder, t: DemandTranslate): CommunityBoardRow {
  return { key: key('community-order', item.id), origin: 'community', title: item.title,
    serviceName: item.listing.service_profile_name.trim() || t('communityBoardPublic'), updatedAt: seconds(item.updated_at),
    action: item.can_send ? 'communicate' : 'view' }
}

function boardError(state: CommunityState, errors: readonly (string | null)[], t: DemandTranslate, publicView = false): string | null {
  const global = communityIssueText(state.error, t) ?? (state.availability === 'error' ? t('errorHint') : null)
  const blocked = publicView && ['disabled', 'unavailable', 'login-required'].includes(state.availability) ? unavailable(state, t) : null
  const messages = Array.from(new Set([...errors, global, blocked].filter((item): item is string => item !== null)))
  return messages.length === 0 ? null : messages.join(' · ')
}

/**
 * Merge only the selected authorized collection while keeping legacy data out of public discovery.
 * @param community - Current account-owned community snapshot.
 * @param legacy - Existing private demand snapshot, used only for My requests.
 * @param view - Controlled collection selection.
 * @param search - Local visible-field search for mine/accepted; public search remains server-owned.
 * @param t - Existing demand locale translator.
 * @returns Minimal cards and the selected collections' retained loading/error/paging state.
 */
export function communityBoardPresentation(community: CommunityState, legacy: DemandPageState,
  view: CommunityBoardView, search: string, t: DemandTranslate): CommunityBoardPresentation {
  if (view === 'public') return {
    rows: community.listings.items.map(item => ({ key: key('community-listing', item.id), origin: 'community', title: item.title,
      serviceName: item.service_profile_name.trim() || t('communityBoardPublic'),
      updatedAt: seconds(item.updated_at), action: 'view-demand' })),
    loading: community.listings.status === 'loading', error: boardError(community, [communityIssueText(community.listings.error, t)], t, true),
    hasMore: community.listings.hasMore, loadingMore: community.listings.loadingMore,
  }
  const page = community.orders[view === 'mine' ? 'published' : 'accepted']
  const rows: CommunityBoardRow[] = []
  if (view === 'mine') {
    const current = legacy.conversation
    const drafts = current !== null && current.requestId === null && !legacy.drafts.some(item => item.scopeKey === current.scopeKey)
      ? [...legacy.drafts, { ...current, updatedAt: '', pending: legacy.draft?.scopeKey === current.scopeKey && legacy.draft.sending,
        error: legacy.draft?.scopeKey === current.scopeKey ? legacy.draft.error : null }] : legacy.drafts
    for (const item of drafts) rows.push({ key: key('legacy-draft', item.scopeKey), origin: 'draft',
      title: item.title.trim() || item.serviceProfileName?.trim() || t('newRequest'),
      serviceName: item.serviceProfileName?.trim() || (item.assigned === false ? t('platformReception') : item.engineer?.displayName.trim())
        || t('pageTitle'), updatedAt: item.updatedAt, action: item.pending ? 'check-submission' : 'continue-draft',
      busy: item.pending && legacy.draft?.scopeKey === item.scopeKey && legacy.draft.sending,
      ...(item.error === null ? {} : { feedback: item.error }) })
    for (const item of community.publications) if (item.orderId === null) {
      const original = community.pending.find(value => value.kind === 'publication' && value.scopeKey === item.scopeKey)
      rows.push({ key: key('community-publication', item.scopeKey), origin: 'draft', title: item.title.trim() || t('newRequest'),
        serviceName: legacy.serviceProfiles.find(value => value.id === item.serviceProfileId)?.displayName || t('communityBoardPublic'),
        updatedAt: milliseconds(item.createdAt), action: item.locked || original !== undefined ? 'check-submission' : 'continue-draft',
        busy: item.sending, ...(item.error === null ? {} : { feedback: communityIssueText(item.error, t) ?? t('errorHint') }) })
    }
    for (const item of legacy.requests) rows.push({ key: key('legacy-order', item.id), origin: 'legacy',
      title: item.title.trim() || t('newRequest'),
      serviceName: item.serviceProfileName?.trim() || (item.assigned === false ? t('platformReception') : item.engineer?.displayName.trim())
        || t('pageTitle'), updatedAt: item.updatedAt, action: 'communicate' })
  }
  rows.push(...page.items.map(item => orderRow(item, t)))
  const query = search.trim().toLocaleLowerCase()
  const error = boardError(community, [communityIssueText(page.error, t),
    view === 'mine' && legacy.requestsStatus === 'error' ? legacy.error ?? t('errorHint') : null], t)
  return { rows: query === '' ? rows : rows.filter(item => `${item.title} ${item.serviceName}`.toLocaleLowerCase().includes(query)),
    loading: page.status === 'loading' || view === 'mine' && legacy.requestsStatus === 'loading',
    error, hasMore: page.hasMore || view === 'mine' && legacy.requestsHaveMore,
    loadingMore: page.loadingMore || view === 'mine' && legacy.loadingMoreRequests }
}

function attachment(item: CommunityAttachment, contentUrl: CommunityContentLookup): DemandAttachment {
  const previewUrl = contentUrl(item.id)
  return { id: item.id, name: item.name, kind: item.kind, sizeBytes: item.size_bytes, status: 'ready',
    ...(previewUrl === null ? {} : { previewUrl }) }
}

/**
 * Project only public listing fields and explicit acceptance permission.
 * @param listing - Validated public listing, never a private order projection.
 * @param community - Current viewer and original acceptance operations.
 * @param t - Existing demand locale translator.
 * @param contentUrl - Owner-approved attachment URL lookup.
 * @returns Public-safe detail, viewer relation and original operation identity.
 */
export function communityDetailsPresentation(listing: CommunityListing, community: CommunityState,
  t: DemandTranslate, contentUrl: CommunityContentLookup): CommunityDetailsPresentation {
  const own = String(listing.publisher.id) === community.accountId
  const orders = [...community.orders.all.items, ...community.orders.published.items, ...community.orders.accepted.items]
  if (community.conversation !== null) orders.push(community.conversation.order)
  const order = orders.find(item => item.id === listing.id)
  const original = community.pending.find(item => item.kind === 'accept' && item.scopeKey === `accept:${listing.id}`)
  const reason = unavailable(community, t)
  const canOpenConversation = community.accountId !== null && (own || order !== undefined)
  const canClaim = reason === null && listing.can_accept && !own && !canOpenConversation && original === undefined
  return { demand: { id: listing.id, title: listing.title, serviceName: listing.service_profile_name || t('communityBoardPublic'),
    brief: listing.public_summary, authorDisplayName: listing.publisher.display_name,
    attachments: listing.public_attachments.filter(item => item.scope === 'listing').map(item => attachment(item, contentUrl)) },
  access: { relation: own ? 'owner' : order?.my_role === 'acceptor' ? 'claimer' : 'visitor', canClaim, canOpenConversation,
    reason: own ? t('communityIssueSelf') : reason ?? (!canClaim && !canOpenConversation ? t('communityIssueNotOpen') : null) },
  operation: community.claimingListingIds.includes(listing.id) ? { state: 'submitting' }
    : operation(original, community.selectedListingError, t), operationId: original?.operationId ?? null }
}

/**
 * Preserve configured upload limits; an unavailable config disables file selection rather than inventing capacity.
 * @param rules - Validated community rules or no available configuration.
 * @returns Existing upload UI fields, with zero selection capacity until rules arrive.
 */
export function communityRulesPresentation(rules: CommunityUploadRules | null): DemandUploadRules {
  return { maxFiles: rules?.max_attachments ?? 0, maxFileBytes: Math.max(rules?.max_image_bytes ?? 0, rules?.max_video_bytes ?? 0),
    maxImageBytes: rules?.max_image_bytes ?? 0, maxVideoBytes: rules?.max_video_bytes ?? 0,
    accept: rules?.allowed_mime_types.join(',') ?? '' }
}

/**
 * Keep staged upload identity equal to its original operation, including reselect feedback.
 * @param upload - One staged model upload, already selected for its destination.
 * @param t - Existing demand locale translator.
 * @returns Shared upload presentation without constructing media URLs.
 */
export function communityUploadPresentation(upload: CommunityUploadView, t: DemandTranslate): DemandAttachment {
  const error = communityIssueText(upload.error, t) ?? (upload.status === 'reselect' ? t('uploadReselect') : null)
  return { id: upload.operationId, name: upload.name,
    kind: upload.mimeType.startsWith('image/') ? 'image' : upload.mimeType.startsWith('video/') ? 'video' : 'file',
    sizeBytes: upload.sizeBytes, status: upload.status === 'reselect' ? 'failed' : upload.status,
    progressPercent: upload.progressPercent, ...(error === null ? {} : { error }) }
}

/**
 * Map one explicit publication scope without revealing its private text or changing public consent.
 * @param draft - Original model publication scope.
 * @param community - Account-owned operations, uploads and capabilities.
 * @param legacy - Actual published service choices from the existing directory.
 * @param t - Existing demand locale translator.
 * @returns Controlled public fields, matched listing uploads and original-operation recovery.
 */
export function communityPublishPresentation(draft: CommunityPublicationDraft, community: CommunityState,
  legacy: DemandPageState, t: DemandTranslate): CommunityPublishPresentation {
  const original = community.pending.find(item => item.kind === 'publication' && item.scopeKey === draft.scopeKey)
  const reason = unavailable(community, t)
  return { draft: { title: draft.title, brief: draft.publicSummary,
    serviceId: draft.serviceProfileId, allowPublic: draft.publishToCommunity },
  services: [{ id: '', label: t('communityUnspecifiedService') },
    ...legacy.serviceProfiles.map(item => ({ id: item.id, label: item.displayName, disabled: !item.canStart }))],
  attachments: community.uploads.filter(item => !item.reserved && item.target.kind === 'publication'
      && item.target.scopeKey === draft.scopeKey
      && item.scope === 'listing').map(item => communityUploadPresentation(item, t)),
  locked: draft.locked || original !== undefined || draft.orderId !== null, operation: operation(original, draft.error, t),
  operationId: original?.operationId ?? null, canPublish: reason === null && community.config?.capabilities.community_orders_v1 === true
      && community.config.capabilities.explicit_publication,
  unavailableReason: reason, rules: communityRulesPresentation(community.config?.capabilities.resumable_upload
    ? community.config.upload_rules : null) }
}

/**
 * Normalize authorized participant messages without assigning server sequences to local operations.
 * @param community - Current account-owned conversation, pending messages and scoped uploads.
 * @param t - Existing demand locale translator.
 * @param contentUrl - Owner-approved attachment URL lookup.
 * @returns Chat props plus original-operation key lookup, or null when no order is open.
 */
export function communityChatPresentation(community: CommunityState, t: DemandTranslate,
  contentUrl: CommunityContentLookup): CommunityChatPresentation | null {
  const source = community.conversation
  if (source === null) return null
  const order = source.order, own = order.my_role
  const local = source.pendingMessages.filter(item => item.orderId === order.id)
  const counterparty = own === 'publisher'
    ? order.acceptor === null ? null : { name: order.acceptor.display_name, role: 'acceptor' as const }
    : { name: order.publisher.display_name, role: 'publisher' as const }
  const messages: CommunityChatMessageView[] = source.messages.filter(item => item.order_id === order.id)
    .map(item => ({ key: `message:${item.id}`, authorKind: item.author_kind,
      authorName: item.author_name, isSelf: item.isSelf, text: item.text, createdAt: seconds(item.created_at),
      attachments: item.attachments.map(value => attachment(value, contentUrl)),
      state: 'sent', recovery: 'none', recovering: false, error: null }))
  const messageOperations: Record<string, string> = {}
  for (const item of local) {
    const messageKey = `operation:${item.operationId}`
    messageOperations[messageKey] = item.operationId
    messages.push({ key: messageKey, authorKind: own, authorName: null,
      isSelf: true, text: item.text, createdAt: milliseconds(item.createdAt),
      attachments: item.attachments.map(value => attachment(value, contentUrl)),
      state: item.state, recovery: item.state === 'unknown' ? 'check' : item.state === 'failed' ? 'retry' : 'none',
      recovering: community.pending.some(value => value.operationId === item.operationId && value.inflight),
      error: communityIssueText(item.error, t) })
  }
  const sending = local.some(item => item.state === 'sending')
  return { conversation: { key: key('community-order', order.id), title: order.title, counterparty, messages,
    status: source.status, error: source.status === 'error' ? communityIssueText(source.error, t) : null,
    hasMoreMessages: source.hasMore, loadingMoreMessages: source.loadingMore, canSend: order.can_send,
    readOnlyReason: order.can_send ? null : t(order.status === 'cancelled' ? 'communityIssueCancelled' : 'requestReadOnly') },
  draftText: source.draftText, attachments: community.uploads.filter(item => !item.reserved && item.target.kind === 'order'
    && item.target.orderId === order.id
    && item.scope === 'conversation').map(item => communityUploadPresentation(item, t)),
  locked: local.some(item => item.state === 'unknown' || item.state === 'sending') || community.accountId === null
    || community.config?.capabilities.community_orders_v1 !== true, sending,
  draftError: source.status === 'error' ? null : communityIssueText(source.error, t),
  rules: communityRulesPresentation(community.config?.capabilities.resumable_upload ? community.config.upload_rules : null),
  messageOperations }
}
