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
    const mine = communityBoardPresentation(state, legacy, 'mine', '', t)
    expect(mine.rows.map(item => item.key)).toEqual(['legacy-draft:draft:original', 'community-publication:publication:original',
      'legacy-order:same-id', 'community-order:same-id'])
    expect(mine.rows[3]?.updatedAt).toBe(new Date(order.updated_at * 1000).toISOString())
    expect(JSON.stringify(mine.rows)).not.toContain('PRIVATE-')
    expect(JSON.stringify(mine.rows)).not.toContain('public_budget')
    const discovery = communityBoardPresentation(state, legacy, 'public', 'server-owned-query', t)
    expect(discovery.rows.map(item => item.key)).toEqual(['community-listing:same-id'])
    expect(discovery.rows[0]?.action).toBe('view-demand')
    expect(communityBoardPresentation(state, legacy, 'accepted', '', t).rows.map(item => item.key)).toEqual(['community-order:same-id'])
    expect(communityBoardPresentation(state, legacy, 'mine', '私密需求', t).rows.map(item => item.key)).toEqual(['legacy-order:same-id'])
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
    const accepted = communityBoardPresentation(state, legacy, 'accepted', '', t)
    expect(accepted.rows[0]?.action).toBe('view')
    expect(accepted.error).toBe(zh.requestReadOnly)
    expect(accepted.loading).toBe(false)
    expect(accepted.hasMore).toBe(false)
    expect(communityBoardPresentation(state, legacy, 'mine', '', t)).toMatchObject({ loading: true, hasMore: true, loadingMore: true })
    const failedConfig = communityBoardPresentation({ ...state, availability: 'error',
      error: { code: 'COMMUNITY_NETWORK', unknown: false, operationId: null } }, legacy, 'accepted', '', t)
    expect(failedConfig.rows).toHaveLength(1)
    expect(failedConfig.error).toContain(zh.communityIssueNetwork)
    const disabled = communityBoardPresentation(ready({ availability: 'disabled',
      listings: { ...base.listings, items: [communityListing()] } }), legacy, 'public', '', t)
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
    expect(JSON.stringify(view.draft)).not.toContain('公开预算原文')
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
