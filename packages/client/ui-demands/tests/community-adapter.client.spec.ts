/** Pure adapters keep public/private collections, operation identity and timestamp units distinct. */
import { describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.ts'
import {
  communityBoardPresentation, communityBoardTarget, communityChatPresentation, communityDetailsPresentation,
  communityIssueText, communityPublishPresentation, communityRulesPresentation, communityUploadPresentation,
} from '../src/client/community-adapter.ts'
import type { CommunityPublicationDraft, CommunityState, CommunityUploadView } from '../src/client/community-types.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'
import { demandState, draftSummary, request, serviceProfile } from './fixtures.client.ts'
import { communityConfig, communityListing, communityOrder, communityState } from './community-fixtures.client.ts'
import { exampleCommunityAttachment, exampleCommunityMessage } from './community-model-fixtures.client.ts'

const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, params) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu,
  (placeholder: string, name: string) => params !== undefined && name in params ? String(params[name]) : placeholder)
const ready = (patch: Partial<CommunityState> = {}): CommunityState => communityState({
  availability: 'ready', config: communityConfig(), ...patch,
})
function publication(patch: Partial<CommunityPublicationDraft> = {}): CommunityPublicationDraft {
  return { scopeKey: 'publication:original', createdAt: 1795000000000, orderId: null, sending: false, locked: false, error: null,
    publishToCommunity: false, title: '公开草稿', publicSummary: '明确的公开说明', publicBudget: '公开预算原文',
    serviceProfileId: 'service-a', privateText: 'PRIVATE-TEXT', ...patch }
}
function upload(patch: Partial<CommunityUploadView> = {}): CommunityUploadView {
  return { operationId: 'original-upload', target: { kind: 'publication', scopeKey: 'publication:original' }, scope: 'listing',
    attachment: null, name: '公开图片.png', sizeBytes: 100, mimeType: 'image/png', progressPercent: 25,
    status: 'uploading', reserved: false, error: null, ...patch }
}

describe('community UI adapter', () => {
  it('merges authorized mine sources without merging identical IDs or putting legacy data in public discovery', () => {
    const listing = communityListing({ id: 'same-id' })
    const order = communityOrder({ id: 'same-id', listing })
    const legacy = demandState({ requests: [request({ id: 'same-id', title: '私密需求', preview: 'PRIVATE-PREVIEW' })],
      drafts: [draftSummary({ scopeKey: 'draft:original', title: '旧私密草稿' })] })
    const state = ready({ publications: [publication()], listings: { ...ready().listings, items: [listing] },
      orders: { ...ready().orders, published: { ...ready().orders.published, items: [order] },
        accepted: { ...ready().orders.accepted, items: [order] } } })
    const before = JSON.stringify({ state, legacy })
    const mine = communityBoardPresentation(state, legacy, 'mine', '', t, () => null)
    expect(mine.rows.map(item => item.key)).toEqual(['legacy-draft:draft:original', 'community-publication:publication:original',
      'legacy-order:same-id', 'community-order:same-id'])
    expect(mine.rows[3]?.updatedAt).toBe(new Date(order.updated_at * 1000).toISOString())
    expect(JSON.stringify(mine.rows)).not.toContain('PRIVATE-')
    expect(JSON.stringify(mine.rows)).not.toContain('public_budget')
    const discovery = communityBoardPresentation(state, legacy, 'public', 'server-owned-query', t, () => null)
    expect(discovery.rows.map(item => item.key)).toEqual(['community-listing:same-id'])
    expect(discovery.rows[0]?.action).toBe('view-demand')
    expect(communityBoardPresentation(state, legacy, 'accepted', '', t, () => null).rows.map(item => item.key)).toEqual(['community-order:same-id'])
    expect(communityBoardPresentation(state, legacy, 'mine', '私密需求', t, () => null).rows.map(item => item.key)).toEqual(['legacy-order:same-id'])
    expect(communityBoardTarget('legacy-draft:draft:original')).toEqual({ kind: 'legacy-draft', id: 'draft:original' })
    expect(communityBoardTarget('community-order:same-id')).toEqual({ kind: 'community-order', id: 'same-id' })
    expect(communityBoardTarget('unrelated:key')).toBeNull()
    expect(communityBoardTarget('community-order:')).toBeNull()
    expect(JSON.stringify({ state, legacy })).toBe(before)
  })

  it('retains source errors and independent paging while permissions determine the community card action', () => {
    const base = ready()
    const state = ready({ orders: { ...base.orders, accepted: { status: 'error', items: [communityOrder({ can_send: false })],
      hasMore: false, loadingMore: false, error: { code: 'COMMUNITY_FORBIDDEN', unknown: false, operationId: null } } } })
    const legacy = demandState({ requestsStatus: 'loading', requestsHaveMore: true, loadingMoreRequests: true })
    const accepted = communityBoardPresentation(state, legacy, 'accepted', '', t, () => null)
    expect(accepted.rows[0]?.action).toBe('view')
    expect(accepted.error).toBe(zh.requestReadOnly)
    expect(accepted.loading).toBe(false)
    expect(accepted.hasMore).toBe(false)
    expect(communityBoardPresentation(state, legacy, 'mine', '', t, () => null)).toMatchObject({ loading: true, hasMore: true, loadingMore: true })
    const failedConfig = communityBoardPresentation({ ...state, availability: 'error',
      error: { code: 'COMMUNITY_NETWORK', unknown: false, operationId: null } }, legacy, 'accepted', '', t, () => null)
    expect(failedConfig.rows).toHaveLength(1)
    expect(failedConfig.error).toContain(zh.communityIssueNetwork)
    const disabled = communityBoardPresentation(ready({ availability: 'disabled',
      listings: { ...base.listings, items: [communityListing()] } }), legacy, 'public', '', t, () => null)
    expect(disabled.rows).toHaveLength(1)
    expect(disabled.error).toBe(zh.communityIssueUnavailable)
  })

  it('projects only listing-scope public assets and preserves denied URLs without constructing a fallback', () => {
    const listing = communityListing({ public_attachments: [exampleCommunityAttachment({ id: 'public', scope: 'listing' }),
      exampleCommunityAttachment({ id: 'private', scope: 'conversation' })] })
    const urls = vi.fn<(id: string) => null>(() => null)
    const state = ready()
    const detail = communityDetailsPresentation(listing, state, t, urls)
    expect(detail.demand.attachments.map(item => item.id)).toEqual(['public'])
    expect(detail.demand.attachments[0]?.previewUrl).toBeUndefined()
    expect(urls).toHaveBeenCalledExactlyOnceWith('public')
    expect(detail.access).toMatchObject({ relation: 'visitor', canClaim: true, canOpenConversation: false })
    expect(JSON.stringify(detail.demand)).not.toContain('private_text')
    const owner = communityDetailsPresentation(listing, ready({ accountId: String(listing.publisher.id) }), t, urls)
    expect(owner.access).toMatchObject({ relation: 'owner', canClaim: false, canOpenConversation: true })
    const order = communityOrder({ id: listing.id })
    const participant = communityDetailsPresentation(listing, ready({ orders: { ...state.orders,
      accepted: { ...state.orders.accepted, items: [order] } } }), t, urls)
    expect(participant.access).toMatchObject({ relation: 'claimer', canClaim: false, canOpenConversation: true })
  })

  it('shows original public budget and summary on cards while denying private covers and invented delivery dates', () => {
    const listing = communityListing({ public_summary: '原公开摘要', public_budget: 'RM 800–1200，可商议',
      public_attachments: [exampleCommunityAttachment({ id: 'allowed', scope: 'listing' }),
        exampleCommunityAttachment({ id: 'denied', scope: 'listing' }),
        exampleCommunityAttachment({ id: 'private-cover', scope: 'conversation' })] })
    const state = ready({ listings: { ...ready().listings, items: [listing] } })
    const lookup = vi.fn((id: string): string | null => id === 'allowed' ? '/authorized/allowed' : null)
    const card = communityBoardPresentation(state, demandState(), 'public', '', t, lookup).rows[0]
    expect(card).toMatchObject({ brief: '原公开摘要', publicBudget: 'RM 800–1200，可商议',
      authorDisplayName: listing.publisher.display_name })
    expect(card?.expectedDeliveryDate).toBe('')
    expect(card?.attachments).toMatchObject([{ id: 'allowed', previewUrl: '/authorized/allowed' }, { id: 'denied' }])
    expect(card?.attachments?.[1]?.previewUrl).toBeUndefined()
    expect(lookup.mock.calls.map(([id]) => id)).toEqual(['allowed', 'denied'])
    expect(JSON.stringify(card)).not.toContain('private-cover')
    const detail = communityDetailsPresentation(listing, state, t, lookup)
    expect(detail.demand.publicBudget).toBe('RM 800–1200，可商议')
    expect(detail.demand.expectedDeliveryDate).toBe('')
  })

  it('gates discovery on declared approval and keeps pending owners and participant history separate', () => {
    const approved = communityListing({ id: 'approved', expected_delivery_date: '2026-12-08' })
    const pending = communityListing({ id: 'pending', approval_status: 'pending' })
    const rejected = communityListing({ id: 'rejected', approval_status: 'rejected', approval_reason: '仅发布人可见' })
    const legacy = { ...communityListing() }; delete legacy.approval_status; delete legacy.expected_delivery_date
    const rejectedOrder = communityOrder({ id: rejected.id, my_role: 'publisher',
      publisher: { id: 1, display_name: '发布人' }, listing: { ...rejected, publisher: { id: 1, display_name: '发布人' } },
      acceptor: { id: 2, display_name: '接单人' } })
    const state = ready({ listings: { ...ready().listings, items: [approved, pending, rejected, legacy] },
      orders: { ...ready().orders, published: { ...ready().orders.published, items: [rejectedOrder] } } })
    const publicBoard = communityBoardPresentation(state, demandState(), 'public', '', t, () => null)
    expect(publicBoard.approvedPublic).toBe(true)
    expect(publicBoard.rows.map(row => row.key)).toEqual(['community-listing:approved'])
    expect(publicBoard.rows[0]?.expectedDeliveryDate).toBe('2026-12-08')
    const own = communityBoardPresentation(state, demandState(), 'mine', '', t, () => null)
    expect(own.rows[0]).toMatchObject({ approvalStatus: 'rejected', approvalReason: '仅发布人可见' })
    const oldConfig = { ...communityConfig(), capabilities: { ...communityConfig().capabilities } }
    delete oldConfig.capabilities.community_approval_v1; delete oldConfig.publication_policy
    const oldState = { ...state, config: oldConfig }
    expect(communityBoardPresentation(oldState, demandState(), 'public', '', t, () => null)).toMatchObject({
      rows: [], approvedPublic: false, error: zh.communityApprovalUnavailable,
    })
    expect(communityBoardPresentation(oldState, demandState(), 'mine', '', t, () => null).rows).toHaveLength(1)
    const unapproved = communityDetailsPresentation(pending, state, t, () => null)
    expect(unapproved.access).toMatchObject({ canClaim: false, reason: zh.communityApprovalRequired })
  })

  it('keeps original acceptance recovery reachable outside a hidden or unsupported public listing', () => {
    const config = { ...communityConfig(), capabilities: { ...communityConfig().capabilities } }
    delete config.capabilities.community_approval_v1; delete config.publication_policy
    const original = { kind: 'accept' as const, operationId: 'original-accept', scopeKey: 'accept:hidden-order',
      orderId: 'hidden-order', inflight: false,
      error: { code: 'COMMUNITY_TIMEOUT', unknown: true, operationId: 'original-accept' } }
    const state = ready({ config, pending: [original], selectedListingStatus: 'error',
      selectedListingError: { code: 'COMMUNITY_NOT_FOUND', unknown: false, operationId: null } })
    const accepted = communityBoardPresentation(state, demandState(), 'accepted', '', t, () => null)
    expect(accepted.rows).toHaveLength(1)
    expect(accepted.rows[0]).toEqual({ key: 'community-acceptance:original-accept', origin: 'acceptance',
      title: zh.communityPendingAcceptance, serviceName: '', updatedAt: '', action: 'check-claim', busy: false, disabled: false,
      operation: { state: 'unknown', checking: false, message: zh.communityIssueUnknown } })
    expect(communityBoardTarget(accepted.rows[0]?.key ?? '')).toEqual({ kind: 'community-acceptance', id: original.operationId })
    expect(communityBoardPresentation(state, demandState(), 'public', '', t, () => null).rows).toHaveLength(0)
    const inflight = communityBoardPresentation({ ...state, pending: [{ ...original, inflight: true }] },
      demandState(), 'accepted', '', t, () => null)
    expect(inflight.rows[0]).toMatchObject({ busy: true, disabled: true, operation: { state: 'submitting' } })
    const failed = communityBoardPresentation({ ...state, pending: [{ ...original,
      error: { code: 'COMMUNITY_ALREADY_ACCEPTED', unknown: false, operationId: original.operationId } }] },
    demandState(), 'accepted', '', t, () => null)
    expect(failed.rows[0]).toMatchObject({ operation: { state: 'failed', recoverable: true, message: zh.communityIssueNotOpen } })
    expect(communityBoardPresentation({ ...state, accountId: null }, demandState(), 'accepted', '', t, () => null).rows).toHaveLength(0)
    expect(communityBoardPresentation({ ...state, pending: [] }, demandState(), 'accepted', '', t, () => null).rows).toHaveLength(0)
  })

  it('keeps known acceptance failures distinct from unknown outcomes and binds recovery to the original scope', () => {
    const listing = communityListing()
    const original = { operationId: 'original-accept', scopeKey: `accept:${listing.id}`, orderId: listing.id,
      kind: 'accept' as const, inflight: false,
      error: { code: 'COMMUNITY_ALREADY_ACCEPTED', unknown: false, operationId: 'original-accept' } }
    const detail = communityDetailsPresentation(listing, ready({ pending: [original] }), t, () => null)
    expect(detail.operationId).toBe(original.operationId)
    expect(detail.operation).toEqual({ state: 'failed', message: zh.communityIssueNotOpen, recoverable: true, recovering: false })
    const unknown = communityDetailsPresentation(listing, ready({ pending: [{ ...original,
      error: { ...original.error, code: 'COMMUNITY_TIMEOUT', unknown: true } }] }), t, () => null)
    expect(unknown.operation.state).toBe('unknown')
    const restored = communityDetailsPresentation(listing, ready({ pending: [{ ...original, error: null }],
      selectedListingError: { code: 'COMMUNITY_NOT_FOUND', unknown: false, operationId: null } }), t, () => null)
    expect(restored.operation.state).toBe('unknown')
    expect(communityDetailsPresentation(listing, ready({ pending: [{ ...original, scopeKey: 'accept:other' }] }), t, () => null)
      .operation.state).toBe('idle')
  })

  it('maps only the selected publication public fields and listing uploads without promoting private data or consent', () => {
    const draft = publication()
    const base = ready()
    const pending = { operationId: 'original-publish', scopeKey: draft.scopeKey, orderId: null, kind: 'publication' as const,
      inflight: false, error: { code: 'COMMUNITY_DISABLED', unknown: false, operationId: 'original-publish' } }
    const state = ready({ pending: [pending], uploads: [upload(), upload({ operationId: 'reserved-upload', reserved: true }),
      upload({ operationId: 'private-upload', scope: 'conversation' }),
      upload({ operationId: 'other-upload', target: { kind: 'publication', scopeKey: 'publication:other' } })] })
    const view = communityPublishPresentation({ ...draft, locked: true }, state,
      demandState({ serviceProfiles: [serviceProfile({ id: 'service-a' })] }), t)
    expect(view.draft.allowPublic).toBe(false)
    expect(view.services[0]).toEqual({ id: '', label: zh.communityUnspecifiedService })
    expect(view.draft.brief).toBe(draft.publicSummary)
    expect(JSON.stringify(view.draft)).not.toContain('PRIVATE-TEXT')
    expect(view.draft.publicBudget).toBe('公开预算原文')
    expect(view.attachments.map(item => item.id)).toEqual(['original-upload'])
    expect(view.operation).toMatchObject({ state: 'failed', recoverable: true })
    expect(view.operationId).toBe('original-publish')
    expect(view.locked).toBe(true)
    expect(view.rules.maxVideoBytes).toBe(base.config?.upload_rules.max_video_bytes)
    expect(communityPublishPresentation(draft, ready({ config: communityConfig() }), demandState(), t).canPublish).toBe(true)
    const disabled = communityPublishPresentation(draft, ready({ config: { ...communityConfig(), enabled: false } }), demandState(), t)
    expect(disabled.canPublish).toBe(false)
  })

  it('preserves upload operation IDs and actionable reselect state while missing configuration disables file selection', () => {
    const view = communityUploadPresentation(upload({ status: 'reselect', error: null }), t)
    expect(view).toMatchObject({ id: 'original-upload', status: 'failed', error: zh.uploadReselect, progressPercent: 25 })
    expect(view.previewUrl).toBeUndefined()
    expect(communityRulesPresentation(null)).toMatchObject({ maxFiles: 0, maxFileBytes: 0, accept: '' })
  })

  it('uses owner-authorized previews only for ready attachments in the selected public upload scope', () => {
    const draft = publication()
    const asset = exampleCommunityAttachment({ id: 'ready-listing-image', scope: 'listing' })
    const state = ready({ uploads: [
      upload({ operationId: 'ready-operation', status: 'ready', progressPercent: 100, attachment: asset }),
      upload({ operationId: 'pending-operation', attachment: asset }),
      upload({ operationId: 'wrong-asset-scope', status: 'ready', attachment: { ...asset, scope: 'conversation' } }),
      upload({ operationId: 'private-operation', scope: 'conversation', status: 'ready', attachment: { ...asset, scope: 'conversation' } }),
    ] })
    const contentUrl = vi.fn((id: string) => id === asset.id ? '/authorized/listing-image' : null)
    const view = communityPublishPresentation(draft, state, demandState(), t, contentUrl)
    expect(view.attachments.map(item => item.id)).toEqual(['ready-operation', 'pending-operation', 'wrong-asset-scope'])
    expect(view.attachments[0]?.previewUrl).toBe('/authorized/listing-image')
    expect(view.attachments[1]?.previewUrl).toBeUndefined()
    expect(view.attachments[2]?.previewUrl).toBeUndefined()
    expect(contentUrl).toHaveBeenCalledExactlyOnceWith(asset.id)
    const denied = communityPublishPresentation(draft, state, demandState(), t, () => null)
    expect(denied.attachments.every(item => item.previewUrl === undefined)).toBe(true)
    expect(communityPublishPresentation(draft, state, demandState(), t).attachments.every(item => item.previewUrl === undefined)).toBe(true)
  })

  it('uses actual persisted isSelf, raw-second timestamps and separate local operation identities without fake sequence fields', () => {
    const order = communityOrder({ id: 'chat-order', my_role: 'publisher', publisher: { id: 1, display_name: '当前发布人' },
      acceptor: { id: 2, display_name: '当前接单人' } })
    const raw = { ...exampleCommunityMessage({ id: 'same-id', order_id: order.id, author_kind: 'publisher',
      author_name: '原始作者', created_at: 1 }), isSelf: false }
    const asset = exampleCommunityAttachment({ id: 'reserved-asset' })
    const local = { operationId: 'same-id', orderId: order.id, text: '原本地消息', attachments: [asset], createdAt: 1000,
      state: 'unknown' as const, error: { code: 'COMMUNITY_TIMEOUT', unknown: true, operationId: 'same-id' } }
    const state = ready({ conversation: { order, messages: [raw], pendingMessages: [local,
      { ...local, operationId: 'other', orderId: 'other-order' }], status: 'ready', hasMore: true, loadingMore: false,
    draftText: '当前草稿', error: null }, uploads: [upload({ target: { kind: 'order', orderId: order.id }, scope: 'conversation' }),
      upload({ operationId: 'reserved', target: { kind: 'order', orderId: order.id }, scope: 'conversation', reserved: true,
        attachment: asset, status: 'ready' }),
      upload({ operationId: 'other', target: { kind: 'order', orderId: 'other-order' }, scope: 'conversation' })] })
    const view = communityChatPresentation(state, t, () => null)
    expect(view?.conversation.messages.map(item => item.key)).toEqual(['message:same-id', 'operation:same-id'])
    expect(view?.conversation.messages[0]).toMatchObject({ authorName: '原始作者', isSelf: false, authorKind: 'publisher' })
    expect(view?.conversation.messages[1]).toMatchObject({ isSelf: true, state: 'unknown', recovery: 'check' })
    expect(view?.conversation.messages[1]?.attachments.map(item => item.id)).toEqual(['reserved-asset'])
    expect(view?.conversation.messages.map(item => item.createdAt)).toEqual(['1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.000Z'])
    expect(JSON.stringify(view?.conversation.messages)).not.toContain('"seq"')
    expect(view?.messageOperations).toEqual({ 'operation:same-id': 'same-id' })
    expect(view?.attachments.map(item => item.id)).toEqual(['original-upload'])
    expect(view?.locked).toBe(true)
    expect(view?.conversation.hasMoreMessages).toBe(true)
  })

  it('respects explicit send permission and leaves known failed local sends eligible for original-key retry', () => {
    const order = communityOrder({ status: 'accepted', can_send: false })
    const state = ready({ conversation: { order, messages: [], pendingMessages: [], status: 'ready', hasMore: false,
      loadingMore: false, draftText: '保留草稿', error: null } })
    expect(communityChatPresentation(state, t, () => null)?.conversation.canSend).toBe(false)
    const failed = { operationId: 'failed-op', orderId: order.id, text: '原失败消息', attachments: [], createdAt: 1000,
      state: 'failed' as const, error: { code: 'COMMUNITY_NETWORK', unknown: false, operationId: 'failed-op' } }
    const active = ready({ conversation: { order: { ...order, can_send: true }, messages: [], pendingMessages: [failed],
      status: 'ready', hasMore: false, loadingMore: false, draftText: '保留草稿', error: null } })
    const view = communityChatPresentation(active, t, () => null)
    expect(view?.conversation.messages[0]).toMatchObject({ key: 'operation:failed-op', recovery: 'retry' })
    expect(view?.locked).toBe(false)
    const selfIssue = communityIssueText({ code: 'COMMUNITY_SELF_ACCEPT_FORBIDDEN', unknown: false, operationId: null }, t)
    expect(selfIssue).toBe(zh.communityIssueSelf)
    expect(communityIssueText({ code: 'COMMUNITY_TIMEOUT', unknown: true, operationId: 'original' }, t)).toBe(zh.communityIssueUnknown)
    expect(communityIssueText({ code: 'COMMUNITY_NETWORK', unknown: false, operationId: null }, t)).toBe(zh.communityIssueNetwork)
  })
})
