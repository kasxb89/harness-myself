// @vitest-environment jsdom
/** Server-supplied people, request receipts, and scoped drafts govern the demand page. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type {} from '../src/client/index.ts'
import { DemandPage } from '../src/client/DemandPage.tsx'
import { zh } from '../src/client/locales.ts'
import type { DemandPageProps, DemandPageState } from '../src/client/types.ts'
import { communityConfig, communityListing, communityOrder, communityState } from './community-fixtures.client.ts'
import type { CommunityState } from '../src/client/community-types.ts'
import { attachment, conversation, demandState, draft, draftSummary, exampleEngineers, message, request, serviceProfile } from './fixtures.client.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Layout is exercised by the browser suite. */ }
    unobserve(): void { /* No layout observation in jsdom. */ }
    disconnect(): void { /* No retained browser observer. */ }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))

function unusedHook(): never { throw new Error('The demand page reads only its injected service snapshot') }

function page(partial: Partial<DemandPageState> = {}, shared: Partial<CommunityState> = {}) {
  const store = createSnapshotStore(demandState(partial))
  const communityStore = createSnapshotStore(communityState(shared))
  const community: DemandPageProps['community'] = {
    refresh: vi.fn(), setListingFilter: vi.fn(), loadMoreListings: vi.fn(), loadOrders: vi.fn(),
    openListing: vi.fn(), acceptListing: vi.fn(), openOrder: vi.fn(), startPublication: vi.fn(), openPublication: vi.fn(),
    updatePublication: vi.fn(), publish: vi.fn(), updateMessageDraft: vi.fn(), sendMessage: vi.fn(),
    loadMoreMessages: vi.fn(), markRead: vi.fn(), performAction: vi.fn(), retryOperation: vi.fn(),
    addAttachments: vi.fn(), retryUpload: vi.fn(), removeUpload: vi.fn(), contentUrl: vi.fn(() => null), downloadAttachment: vi.fn(),
  }
  const actions = {
    refresh: vi.fn<() => void>(), openLogin: vi.fn<() => void>(), startRequest: vi.fn<(id: string) => void>(),
    startServiceRequest: vi.fn<DemandPageProps['startServiceRequest']>(),
    setServiceFilter: vi.fn<DemandPageProps['setServiceFilter']>(), loadMoreServices: vi.fn<() => void>(),
    openRequest: vi.fn<(id: string) => void>(), updateDraft: vi.fn<DemandPageProps['updateDraft']>(),
    openDraft: vi.fn<DemandPageProps['openDraft']>(),
    send: vi.fn<() => void>(), addAttachments: vi.fn<DemandPageProps['addAttachments']>(),
    removeAttachment: vi.fn<(id: string) => void>(), retryAttachment: vi.fn<(id: string) => void>(),
    retryMessage: vi.fn<(id: string) => void>(), loadEarlierMessages: vi.fn<() => void>(),
    loadMoreRequests: vi.fn<() => void>(),
    downloadAttachment: vi.fn<(id: string) => void>(), acceptDelivery: vi.fn<(id: string) => void>(),
    setWorkspaceView: vi.fn<DemandPageProps['setWorkspaceView']>(),
  }
  const props: DemandPageProps = {
    ...actions,
    usePanelInfo: unusedHook, useSessions: unusedHook, useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook,
    useWorkspaces: unusedHook, useResource: unusedHook, useDemands: bindSnapshotSelector(store),
    useCommunity: bindSnapshotSelector(communityStore), community,
    t: (key, params) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu, (placeholder: string, name: string) =>
      params !== undefined && name in params ? String(params[name]) : placeholder),
  }
  render(<DemandPage {...props} />)
  return {
    ...actions, store, community, communityStore,
    set: (next: Partial<DemandPageState>) => { act(() => { store.set({ ...store.getSnapshot(), ...next }) }) },
    setCommunity: (next: Partial<CommunityState>) => { act(() => { communityStore.set({ ...communityStore.getSnapshot(), ...next }) }) },
  }
}

function openRequests() {
  if (screen.queryByRole('complementary', { name: zh.myRequests }) !== null) return
  fireEvent.click(screen.getByRole('button', { name: zh.viewConversations }))
}

function openOfficial() {
  fireEvent.click(screen.getByRole('tab', { name: zh.officialCustomization }))
}

describe('human-engineer demand page', () => {
  it('joins only authorized personal cards while public discovery never receives legacy private text', () => {
    const publicRow = communityListing()
    const owned = communityOrder({ id: 'own-community', title: '我的公开单', my_role: 'publisher',
      publisher: { id: 1, display_name: '我' }, acceptor: null })
    const shared = communityState({ availability: 'ready', config: communityConfig() })
    const actions = page({ requests: [request({ title: '旧私密需求', preview: '旧私密聊天不应公开' })] }, {
      ...shared, listings: { ...shared.listings, items: [publicRow] },
      orders: { ...shared.orders, published: { ...shared.orders.published, items: [owned] } },
    })
    expect(screen.getByRole('heading', { name: '旧私密需求' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: owned.title })).toBeTruthy()
    expect(screen.queryByText('旧私密聊天不应公开')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.communityBoardPublic }))
    expect(actions.community.setListingFilter).toHaveBeenCalledExactlyOnceWith('')
    expect(screen.queryByRole('heading', { name: '旧私密需求' })).toBeNull()
    expect(screen.getByRole('heading', { name: publicRow.title })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `${zh.communityViewDemand}：${publicRow.title}` }))
    expect(actions.community.openListing).toHaveBeenCalledExactlyOnceWith(publicRow.id)
    actions.setCommunity({ selectedListing: publicRow })
    const dialog = screen.getByRole('dialog', { name: zh.communityPublicDetails })
    expect(within(dialog).getByText(publicRow.public_summary)).toBeTruthy()
    expect(within(dialog).queryByText(owned.private_text)).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: zh.communityClaim }))
    expect(actions.community.acceptListing).toHaveBeenCalledExactlyOnceWith(publicRow.id)
    actions.setCommunity({ claimingListingIds: [publicRow.id] })
    expect(within(dialog).getByRole('button', { name: zh.communityClaiming })).toHaveProperty('disabled', true)
    actions.setCommunity({ claimingListingIds: [] })
    expect(actions.community.sendMessage).not.toHaveBeenCalled()
    expect(actions.send).not.toHaveBeenCalled()
  })

  it('keeps an uncertain acceptance on its original operation and opens ordinary-user chat only after a receipt', () => {
    const listing = communityListing(), order = communityOrder()
    const shared = communityState({ availability: 'ready', config: communityConfig() })
    const actions = page({}, { ...shared, listings: { ...shared.listings, items: [listing] } })
    fireEvent.click(screen.getByRole('button', { name: zh.communityBoardPublic }))
    fireEvent.click(screen.getByRole('button', { name: `${zh.communityViewDemand}：${listing.title}` }))
    actions.setCommunity({ selectedListing: listing, pending: [{ operationId: 'original-acceptance', scopeKey: `accept:${listing.id}`,
      orderId: listing.id, kind: 'accept', inflight: false,
      error: { code: 'COMMUNITY_NETWORK', unknown: true, operationId: 'original-acceptance' } }] })
    fireEvent.click(screen.getByRole('button', { name: zh.communityCheckClaim }))
    expect(actions.community.retryOperation).toHaveBeenCalledExactlyOnceWith('original-acceptance')
    expect(actions.community.acceptListing).not.toHaveBeenCalled()
    actions.setCommunity({ selectedOrderId: order.id, pending: [], conversation: {
      order, messages: [{ id: 'message-1', order_id: order.id, seq: 1, sender_id: 2, author_kind: 'publisher',
        author_name: '发布人原名', kind: 'message', text: '已接单后可见的消息', attachments: [], created_at: 1795000001,
        client_message_id: 'sender-original-key', read: false, isSelf: false }], pendingMessages: [], status: 'ready',
      hasMore: false, loadingMore: false, draftText: '收到，我来完成', error: null,
    } })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('已接单后可见的消息')).toBeTruthy()
    expect(screen.getByText('发布人原名 · 发布人')).toBeTruthy()
    expect(screen.queryByText(/工程师在线/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.send }))
    expect(actions.community.sendMessage).toHaveBeenCalledExactlyOnceWith(order.id)
    expect(actions.community.markRead).toHaveBeenCalledWith(order.id, 1)
    expect(actions.send).not.toHaveBeenCalled()
  })

  it('requires an explicit public selection and never substitutes the official create endpoint', () => {
    const actions = page({ directoryMode: 'services', serviceProfiles: [] }, {
      availability: 'ready', config: communityConfig(),
    })
    fireEvent.click(screen.getByRole('button', { name: zh.newRequest }))
    expect(actions.community.startPublication).toHaveBeenCalledOnce()
    const publication = { scopeKey: 'publication:test', title: '活动页面', publicSummary: '按照品牌色排版',
      publicBudget: '', serviceProfileId: '', privateText: '', publishToCommunity: false,
      createdAt: 1795000000000, orderId: null, sending: false, locked: false, error: null }
    actions.setCommunity({ activePublicationScope: publication.scopeKey, publications: [publication] })
    expect(screen.getByRole('button', { name: zh.communityPublish })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('checkbox', { name: zh.communityPublicConsent }))
    expect(actions.community.updatePublication).toHaveBeenCalledWith(publication.scopeKey, { publishToCommunity: true })
    expect(actions.community.publish).not.toHaveBeenCalled()
    actions.setCommunity({ publications: [{ ...publication, publishToCommunity: true }] })
    fireEvent.click(screen.getByRole('button', { name: zh.communityPublish }))
    expect(actions.community.publish).toHaveBeenCalledExactlyOnceWith(publication.scopeKey)
    expect(actions.startServiceRequest).not.toHaveBeenCalled()
    expect(actions.startRequest).not.toHaveBeenCalled()
    expect(actions.send).not.toHaveBeenCalled()
  })

  it('keeps existing participant conversations available when new community publication is disabled', () => {
    const order = communityOrder()
    const shared = communityState({ availability: 'disabled', config: { ...communityConfig(), enabled: false } })
    const actions = page({}, { ...shared, selectedOrderId: order.id,
      orders: { ...shared.orders, accepted: { ...shared.orders.accepted, items: [order] } },
      conversation: { order, messages: [], pendingMessages: [], draftText: '原订单继续沟通', status: 'ready',
        error: null, hasMore: false, loadingMore: false } })
    expect(screen.getByRole('button', { name: zh.newRequest })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: zh.communityBoardAccepted }))
    fireEvent.click(screen.getByRole('button', { name: `${zh.communicate}：${order.title}` }))
    expect(actions.community.openOrder).toHaveBeenCalledExactlyOnceWith(order.id)
    expect(screen.getByRole('button', { name: zh.send })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: zh.send }))
    expect(actions.community.sendMessage).toHaveBeenCalledExactlyOnceWith(order.id)
  })

  it('checks a pending message with its original identifier and stops read acknowledgements on the board', () => {
    const order = communityOrder(), shared = communityState({ availability: 'ready', config: communityConfig() })
    const actions = page({}, { ...shared, selectedOrderId: order.id,
      orders: { ...shared.orders, accepted: { ...shared.orders.accepted, items: [order] } },
      conversation: { order, messages: [], pendingMessages: [{ operationId: 'original-send', orderId: order.id,
        text: '结果未知的原消息', attachments: [], createdAt: 1795000001000, state: 'unknown',
        error: { code: 'COMMUNITY_NETWORK', unknown: true, operationId: 'original-send' } }],
      draftText: '', status: 'ready', error: null, hasMore: false, loadingMore: false },
      pending: [{ operationId: 'original-send', scopeKey: `order:${order.id}`, orderId: order.id,
        kind: 'message', inflight: false, error: { code: 'COMMUNITY_NETWORK', unknown: true, operationId: 'original-send' } }],
    })
    fireEvent.click(screen.getByRole('button', { name: zh.communityBoardAccepted }))
    fireEvent.click(screen.getByRole('button', { name: `${zh.communicate}：${order.title}` }))
    fireEvent.click(screen.getByRole('button', { name: zh.communityCheckMessage }))
    expect(actions.community.retryOperation).toHaveBeenCalledExactlyOnceWith('original-send')
    fireEvent.click(screen.getByRole('button', { name: zh.communityBackToBoard }))
    const current = actions.communityStore.getSnapshot().conversation
    if (current === null) throw new Error('The synthetic participant conversation is retained')
    actions.setCommunity({ conversation: { ...current, messages: [{ id: 'later-message', order_id: order.id,
      seq: 2, sender_id: 2, author_kind: 'publisher', author_name: '发布人', kind: 'message', text: '后台新消息',
      attachments: [], created_at: 1795000002, client_message_id: 'later-key', read: false, isSelf: false }] } })
    expect(actions.community.markRead).not.toHaveBeenCalled()
    expect(screen.queryByText('后台新消息')).toBeNull()
  })

  it('shows an actual failed order read with retry rather than leaving an endless loading view', () => {
    const order = communityOrder(), shared = communityState({ availability: 'ready', config: communityConfig() })
    const actions = page({}, { ...shared, orders: { ...shared.orders, accepted: { ...shared.orders.accepted, items: [order] } } })
    fireEvent.click(screen.getByRole('button', { name: zh.communityBoardAccepted }))
    fireEvent.click(screen.getByRole('button', { name: `${zh.communicate}：${order.title}` }))
    actions.setCommunity({ selectedOrderId: order.id, selectedOrderStatus: 'error',
      selectedOrderError: { code: 'COMMUNITY_FORBIDDEN', unknown: false, operationId: null } })
    expect(screen.getByRole('heading', { name: zh.errorTitle })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(actions.community.openOrder).toHaveBeenLastCalledWith(order.id)
    expect(actions.community.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps personal cards minimal while retaining searchable request data and independent identities', () => {
    const profile = serviceProfile()
    const first = request({ id: 'private-a', number: 'PRIVATE-101', title: '六月订单对账', preview: '核对退款明细',
      serviceProfileId: profile.id, serviceProfileName: profile.displayName, budget: '按里程碑协商，不超过 2k',
      expectedDate: '2026-12-01' })
    const second = request({ id: 'private-b', number: 'PRIVATE-102', title: '七月订单对账', preview: '导出季度报表',
      serviceProfileId: profile.id, serviceProfileName: profile.displayName, budget: '   ', unreadCount: 0 })
    const actions = page({ directoryMode: 'services', serviceProfiles: [profile], servicesTotal: 1,
      requests: [first, second], requestsHaveMore: true })
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: zh.personalRequests }).getAttribute('aria-selected')).toBe('true')
    const cards = screen.getByRole('list', { name: zh.personalRequests })
    expect(within(cards).getAllByRole('listitem')).toHaveLength(2)
    const firstCard = within(cards).getByRole('heading', { name: first.title }).closest('li')
    const secondCard = within(cards).getByRole('heading', { name: second.title }).closest('li')
    if (firstCard === null || secondCard === null) throw new Error('Each private request has its own card')
    expect(within(firstCard).getByText(profile.displayName)).toBeTruthy()
    expect(firstCard.querySelector('time')?.getAttribute('dateTime')).toBe(first.updatedAt)
    expect(firstCard.querySelectorAll('p')).toHaveLength(1)
    expect(within(firstCard).queryByText(first.preview)).toBeNull()
    expect(within(firstCard).queryByText(zh.statusCommunicating)).toBeNull()
    expect(within(firstCard).queryByText(first.budget ?? '')).toBeNull()
    expect(within(firstCard).queryByText('期望交付：2026-12-01')).toBeNull()
    expect(within(firstCard).queryByText('2 条未读')).toBeNull()
    expect(within(firstCard).queryByText(zh.budgetLabel)).toBeNull()
    expect(within(secondCard).queryByText(zh.budgetLabel)).toBeNull()
    expect(actions.store.getSnapshot().requests[0]?.budget).toBe(first.budget)
    expect(actions.store.getSnapshot().requests[0]?.preview).toBe(first.preview)
    expect(actions.store.getSnapshot().requests[0]?.expectedDate).toBe(first.expectedDate)
    expect(cards.textContent).not.toContain('¥')
    expect(screen.queryByRole('list', { name: zh.officialCustomization })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.loadMoreRequests }))
    expect(actions.loadMoreRequests).toHaveBeenCalledOnce()
    actions.set({ loadingMoreRequests: true })
    expect(screen.getByRole('button', { name: zh.loadingMoreRequests })).toHaveProperty('disabled', true)
    const search = screen.getByRole('searchbox', { name: zh.searchRequests })
    fireEvent.change(search, { target: { value: '里程碑' } })
    expect(screen.getByRole('heading', { name: first.title })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: second.title })).toBeNull()
    fireEvent.change(search, { target: { value: '退款明细' } })
    expect(screen.getByRole('heading', { name: first.title })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: second.title })).toBeNull()
    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '沟通：六月订单对账，需求 PRIVATE-101' }))
    expect(actions.openRequest).toHaveBeenCalledExactlyOnceWith(first.id)
    expect(screen.getByRole('complementary', { name: zh.myRequests })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.backToPersonalRequests }))
    fireEvent.click(screen.getByRole('button', { name: '沟通：七月订单对账，需求 PRIVATE-102' }))
    expect(actions.openRequest).toHaveBeenNthCalledWith(2, second.id)
    fireEvent.click(screen.getByRole('button', { name: zh.backToPersonalRequests }))
    openOfficial()
    expect(screen.getByRole('list', { name: zh.officialCustomization })).toBeTruthy()
    expect(screen.queryByRole('list', { name: zh.personalRequests })).toBeNull()
    expect(actions.startServiceRequest).not.toHaveBeenCalled()
    expect(actions.send).not.toHaveBeenCalled()
  })

  it('uses a neutral service source without showing assignment state or a missing-engineer label', () => {
    page({ requests: [request({ id: 'no-engineer', number: 'PRIVATE-103', title: '整理项目说明', engineer: null,
      status: 'pending', preview: '这里是保留在原会话中的消息摘要' }),
    request({ id: 'platform-request', number: 'PRIVATE-104', title: '梳理表单字段', engineer: null,
      assigned: false, status: 'pending', preview: '另一段历史会话摘要' })] })
    const cards = screen.getByRole('list', { name: zh.personalRequests })
    expect(within(cards).getByText(zh.pageTitle)).toBeTruthy()
    expect(within(cards).getByText(zh.platformReception)).toBeTruthy()
    for (const label of [zh.waitingAssignment, zh.unassignedEngineer, zh.statusPending,
      '这里是保留在原会话中的消息摘要', '另一段历史会话摘要']) {
      expect(within(cards).queryByText(label)).toBeNull()
    }
    expect(within(cards).getAllByRole('button', { name: /^沟通：/u })).toHaveLength(2)
  })

  it('reopens independent local draft cards without submitting or changing an unresolved operation', () => {
    const first = draftSummary({ scopeKey: 'private-draft-a', title: '整理订单资料', serviceProfileName: '订单服务',
      budget: '时间与范围确认后商议' })
    const second = draftSummary({ scopeKey: 'private-draft-b', title: '核对原发布结果', serviceProfileName: '订单服务',
      pending: true, error: zh.resultUnknown })
    const actions = page({ drafts: [first, second] })
    const cards = screen.getByRole('list', { name: zh.personalRequests })
    expect(within(cards).queryByText(first.budget ?? '')).toBeNull()
    expect(within(cards).getByText(zh.resultUnknown)).toBeTruthy()
    fireEvent.click(within(cards).getByRole('button', { name: '继续编辑：整理订单资料' }))
    expect(actions.openDraft).toHaveBeenCalledExactlyOnceWith(first.scopeKey)
    fireEvent.click(screen.getByRole('button', { name: zh.backToPersonalRequests }))
    fireEvent.click(screen.getByRole('button', { name: '核对发布结果：核对原发布结果' }))
    expect(actions.openDraft).toHaveBeenNthCalledWith(2, second.scopeKey)
    expect(actions.send).not.toHaveBeenCalled()
    expect(actions.startRequest).not.toHaveBeenCalled()
    expect(actions.startServiceRequest).not.toHaveBeenCalled()
    expect(actions.updateDraft).not.toHaveBeenCalled()
  })

  it('shows actual service profiles and server totals without presenting them as live engineers', () => {
    const actions = page({ directoryMode: 'services', serviceProfiles: [serviceProfile({ avatarUrl: 'https://example.invalid/service.png' })],
      servicesTotal: 100 })
    openOfficial()
    expect(screen.getByRole('tab', { name: zh.officialCustomization })).toBeTruthy()
    expect(screen.getByText('100 项服务')).toBeTruthy()
    expect(screen.getByText(zh.platformRoutingHint)).toBeTruthy()
    expect(screen.getByRole('heading', { name: '示例订单管理服务' })).toBeTruthy()
    expect(screen.getByText('订单查询与操作流程')).toBeTruthy()
    expect(screen.queryByText(zh.presenceAvailable)).toBeNull()
    expect(screen.queryByText(zh.presenceOffline)).toBeNull()
    expect(screen.queryByText('示例工程师林')).toBeNull()
    expect(screen.getByAltText('').getAttribute('loading')).toBe('lazy')
    fireEvent.click(screen.getByRole('button', { name: '为示例订单管理服务发布需求' }))
    expect(actions.startServiceRequest).toHaveBeenCalledExactlyOnceWith('example-service-orders')
    expect(actions.startRequest).not.toHaveBeenCalled()
  })

  it('delegates service search and pagination to the server-owned commands', () => {
    const actions = page({ directoryMode: 'services', serviceProfiles: [serviceProfile()], servicesTotal: 47, servicesHaveMore: true })
    openOfficial()
    const search = screen.getByRole('searchbox', { name: zh.searchServices })
    fireEvent.change(search, { target: { value: '排版' } })
    expect(actions.setServiceFilter).toHaveBeenCalledExactlyOnceWith('排版', '')
    actions.set({ serviceQuery: '排版', servicesTotal: 12 })
    fireEvent.click(screen.getByRole('button', { name: '示例前端开发' }))
    expect(actions.setServiceFilter).toHaveBeenLastCalledWith('排版', 'example-frontend')
    actions.set({ serviceCategoryId: 'example-frontend' })
    fireEvent.click(screen.getByRole('button', { name: zh.clearSearch }))
    expect(actions.setServiceFilter).toHaveBeenLastCalledWith('', 'example-frontend')
    expect(screen.getByText('12 项服务')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.loadMoreServices }))
    expect(actions.loadMoreServices).toHaveBeenCalledOnce()
    actions.set({ loadingMoreServices: true })
    const more = screen.getByRole('button', { name: zh.loadingMoreServices })
    expect(more).toHaveProperty('disabled', true)
    fireEvent.click(more)
    expect(actions.loadMoreServices).toHaveBeenCalledOnce()
    actions.set({ servicesHaveMore: false, loadingMoreServices: false })
    expect(screen.queryByRole('button', { name: zh.loadMoreServices })).toBeNull()
    expect(screen.getByRole('heading', { name: '示例订单管理服务' })).toBeTruthy()
  })

  it('keeps service read failures actionable and distinguishes an empty catalog from no search matches', () => {
    const actions = page({ directoryMode: 'services', serviceProfiles: [], servicesTotal: 0 })
    openOfficial()
    expect(screen.getByRole('heading', { name: zh.noServices })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /为.+发布需求/u })).toBeNull()
    actions.set({ serviceQuery: '未发布方向' })
    expect(screen.getByRole('heading', { name: zh.noMatchingServices })).toBeTruthy()
    actions.set({ servicesStatus: 'error' })
    expect(screen.getByText(zh.serviceLoadFailed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(actions.refresh).toHaveBeenCalledOnce()
  })

  it('shows platform reception before assignment and preserves the original service name afterward', () => {
    const pending = conversation({ status: 'pending', intakeMode: 'platform', assigned: false,
      serviceProfileId: 'example-service-orders', serviceProfileName: '示例订单管理服务',
      engineer: { id: 'platform-intake', displayName: '接待投影', avatarUrl: null, introduction: '', categoryIds: [], skills: [],
        presence: 'offline', canStart: false, unavailableReason: null },
    })
    const actions = page({ directoryMode: 'services', conversation: pending, draft: draft(), requests: [request({
      status: 'pending', assigned: false, intakeMode: 'platform', serviceProfileName: '示例订单管理服务',
    })] })
    openRequests()
    expect(screen.getByRole('heading', { name: zh.platformReception })).toBeTruthy()
    expect(screen.queryByText('接待投影')).toBeNull()
    expect(screen.queryByText(zh.presenceOffline)).toBeNull()
    expect(screen.queryByText(zh.offlineHint)).toBeNull()
    expect(screen.getAllByText(zh.waitingAssignment)).toHaveLength(2)
    expect(screen.getAllByText('服务：示例订单管理服务')).toHaveLength(1)
    expect(within(screen.getByRole('complementary', { name: zh.myRequests })).getByText('示例订单管理服务')).toBeTruthy()
    actions.set({ conversation: { ...pending, assigned: true, engineer: exampleEngineers[0] ?? null, status: 'communicating' } })
    expect(screen.getByRole('heading', { name: '示例工程师林' })).toBeTruthy()
    expect(screen.getByText(zh.presenceAvailable)).toBeTruthy()
    expect(screen.getAllByText('服务：示例订单管理服务')).toHaveLength(1)
    actions.set({ requests: [request({ status: 'pending' })] })
    const legacy = screen.getByRole('button', { name: /示例订单页面改版/u })
    expect(within(legacy).getByText(zh.statusPending)).toBeTruthy()
    expect(within(legacy).queryByText(zh.waitingAssignment)).toBeNull()
  })

  it('shows an unconfigured service without invented engineers or an ineffective retry', () => {
    const actions = page({ availability: 'unconfigured', categories: [], engineers: [] })
    expect(screen.getByRole('heading', { name: zh.unconfiguredTitle })).toBeTruthy()
    expect(screen.getByText(zh.unconfiguredHint)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
    expect(screen.queryByRole('button', { name: /向.+发起需求/u })).toBeNull()
    expect(screen.queryByText('示例工程师林')).toBeNull()
    expect(actions.refresh).not.toHaveBeenCalled()
    expect(actions.startRequest).not.toHaveBeenCalled()
  })

  it('requests another page without hiding retained requests and prevents repeated loading clicks', () => {
    const actions = page({ requests: [request()], requestsHaveMore: true })
    openRequests()
    fireEvent.click(screen.getByRole('button', { name: zh.loadMoreRequests }))
    expect(actions.loadMoreRequests).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: /示例订单页面改版/u })).toBeTruthy()
    actions.set({ loadingMoreRequests: true })
    const loading = screen.getByRole('button', { name: zh.loadingMoreRequests })
    expect(loading).toHaveProperty('disabled', true)
    fireEvent.click(loading)
    expect(actions.loadMoreRequests).toHaveBeenCalledOnce()
    actions.set({ requestsHaveMore: false, loadingMoreRequests: false })
    expect(screen.queryByRole('button', { name: zh.loadMoreRequests })).toBeNull()
    expect(screen.getByRole('button', { name: /示例订单页面改版/u })).toBeTruthy()
  })

  it('offers sign-in only when required, and retry only for a failed read', () => {
    const actions = page({ availability: 'login-required', categories: [], engineers: [] })
    fireEvent.click(screen.getByRole('button', { name: zh.openLogin }))
    expect(actions.openLogin).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
    actions.set({ availability: 'disabled' })
    expect(screen.getByRole('heading', { name: zh.disabledTitle })).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
    actions.set({ availability: 'error', error: 'Example service read failed' })
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(actions.refresh).toHaveBeenCalledOnce()
  })

  it('filters the supplied directory by category and skill and clears the search', () => {
    page()
    openOfficial()
    expect(screen.getByText('3 位工程师')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '示例业务自动化' }))
    expect(screen.getByRole('button', { name: '向示例工程师陈发起需求' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '向示例工程师林发起需求' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.allCategories }))
    const search = screen.getByRole('searchbox', { name: zh.searchEngineers })
    fireEvent.change(search, { target: { value: 'react' } })
    expect(screen.getByRole('button', { name: '向示例工程师林发起需求' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '向示例工程师陈发起需求' })).toBeNull()
    fireEvent.change(search, { target: { value: '没有此技能' } })
    expect(screen.getByText(zh.noMatches)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.clearSearch }))
    expect(search).toHaveProperty('value', '')
    expect(screen.getByText('3 位工程师')).toBeTruthy()
  })

  it('honors admission separately from presence and starts only the chosen engineer request', () => {
    const actions = page()
    openOfficial()
    const unavailable = screen.getByRole('button', { name: '向示例工程师周发起需求' })
    expect(unavailable).toHaveProperty('disabled', true)
    fireEvent.click(unavailable)
    expect(actions.startRequest).not.toHaveBeenCalled()
    expect(screen.getByText(zh.presenceOffline)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '向示例工程师陈发起需求' }))
    expect(actions.startRequest).toHaveBeenCalledExactlyOnceWith('example-engineer-chen')
    expect(screen.getByRole('tab', { name: zh.personalRequests }).getAttribute('aria-selected')).toBe('true')
  })

  it('opens the exact saved request and displays the server status and unread count', () => {
    const actions = page({ requests: [request(), request({
      id: 'example-request-complete', number: 'EXAMPLE-019', title: '示例文件归档',
      engineer: exampleEngineers[1] ?? null, status: 'completed', preview: '已整理完毕', unreadCount: 0,
    })] })
    openRequests()
    const selected = screen.getByRole('button', { name: /示例订单页面改版/u })
    expect(within(selected).getByText(zh.statusCommunicating)).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /示例文件归档/u })).getByText(zh.statusCompleted)).toBeTruthy()
    expect(screen.getByLabelText('示例订单页面改版，2 条未读消息')).toBeTruthy()
    fireEvent.click(selected)
    expect(actions.openRequest).toHaveBeenCalledExactlyOnceWith('example-request')
    expect(actions.startRequest).not.toHaveBeenCalled()
  })

  it('leads with the real service while retaining each request title, message, number, and identity', () => {
    const profile = serviceProfile({ avatarUrl: 'https://example.invalid/orders.png' })
    const first = request({ id: 'orders-a', number: 'EXAMPLE-101', title: '本月对账', preview: '请核对退款金额',
      serviceProfileId: profile.id, serviceProfileName: profile.displayName, assigned: false, unreadCount: 0 })
    const second = request({ id: 'orders-b', number: 'EXAMPLE-102', title: '历史报表', preview: '导出季度数据',
      serviceProfileId: profile.id, serviceProfileName: profile.displayName, status: 'completed', unreadCount: 0 })
    const actions = page({ directoryMode: 'services', serviceProfiles: [profile], requests: [first, second],
      conversation: conversation({ scopeKey: first.id, requestId: first.id }), draft: draft({ scopeKey: first.id }) })
    openRequests()
    const inbox = screen.getByRole('complementary', { name: zh.myRequests })
    const firstRow = within(inbox).getByRole('button', { name: /EXAMPLE-101/u })
    const secondRow = within(inbox).getByRole('button', { name: /EXAMPLE-102/u })
    expect(firstRow.querySelector('strong')?.textContent).toBe(profile.displayName)
    expect(secondRow.querySelector('strong')?.textContent).toBe(profile.displayName)
    expect(within(firstRow).getByText('本月对账 · 请核对退款金额')).toBeTruthy()
    expect(within(secondRow).getByText(zh.statusCompleted)).toBeTruthy()
    expect(firstRow.querySelector('img')?.getAttribute('src')).toBe(profile.avatarUrl)
    expect(secondRow.querySelector('img')?.getAttribute('src')).toBe(profile.avatarUrl)
    expect(inbox.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
    fireEvent.click(secondRow)
    expect(actions.openRequest).toHaveBeenCalledExactlyOnceWith(second.id)
    const search = within(inbox).getByRole('searchbox', { name: zh.searchRequests })
    for (const query of ['本月对账', '退款金额', 'EXAMPLE-101']) {
      fireEvent.change(search, { target: { value: query } })
      expect(within(inbox).getByRole('button', { name: /EXAMPLE-101/u })).toBeTruthy()
      expect(within(inbox).queryByRole('button', { name: /EXAMPLE-102/u })).toBeNull()
    }
    fireEvent.change(search, { target: { value: profile.displayName } })
    expect(within(inbox).getAllByRole('button', { name: /EXAMPLE-10[12]/u })).toHaveLength(2)
    actions.set({ serviceProfiles: [] })
    expect(within(inbox).getByRole('button', { name: /EXAMPLE-101/u }).querySelector('img')).toBeNull()
  })

  it('searches only the matching draft body and keeps status filters separate from unpublished drafts', () => {
    const first = draftSummary({ scopeKey: 'draft-a', title: '目录整理' })
    const second = draftSummary({ scopeKey: 'draft-b', title: '表格校对', serviceProfileName: '订单服务' })
    page({ drafts: [first, second],
      conversation: conversation({ scopeKey: second.scopeKey, requestId: null, number: null, status: null, title: second.title }),
      draft: draft({ scopeKey: second.scopeKey, text: '核对六月退款' }),
      requests: [request({ status: 'completed' })],
    })
    openRequests()
    const inbox = screen.getByRole('complementary', { name: zh.myRequests })
    const search = within(inbox).getByRole('searchbox', { name: zh.searchRequests })
    fireEvent.change(search, { target: { value: '六月退款' } })
    expect(within(inbox).getByRole('button', { name: /订单服务/u })).toBeTruthy()
    expect(within(inbox).queryByRole('button', { name: /目录整理/u })).toBeNull()
    fireEvent.change(search, { target: { value: '没有匹配项' } })
    expect(within(inbox).getByText(zh.noMatchingRequests)).toBeTruthy()
    expect(within(inbox).queryByText(zh.noRequests)).toBeNull()
    fireEvent.change(search, { target: { value: '' } })
    const filter = within(inbox).getByRole('button', { name: zh.filterRequests })
    expect(filter.textContent).toBe('')
    fireEvent.click(filter)
    fireEvent.click(screen.getByRole('menuitem', { name: zh.statusCompleted }))
    expect(filter.getAttribute('aria-pressed')).toBe('true')
    expect(within(inbox).queryByRole('group', { name: zh.draftsGroup })).toBeNull()
    expect(within(inbox).getByRole('button', { name: /示例订单页面改版/u })).toBeTruthy()
    fireEvent.click(filter)
    fireEvent.click(screen.getByRole('menuitem', { name: zh.allRequests }))
    expect(filter.getAttribute('aria-pressed')).toBe('false')
    expect(within(inbox).getByRole('group', { name: zh.draftsGroup })).toBeTruthy()
  })

  it('distinguishes a query with no matches from a genuinely empty inbox', () => {
    page()
    openRequests()
    const inbox = screen.getByRole('complementary', { name: zh.myRequests })
    expect(within(inbox).getByText(zh.noRequests)).toBeTruthy()
    fireEvent.change(within(inbox).getByRole('searchbox', { name: zh.searchRequests }), { target: { value: '订单' } })
    expect(within(inbox).getByText(zh.noMatchingRequests)).toBeTruthy()
    expect(within(inbox).queryByText(zh.noRequests)).toBeNull()
    expect(within(inbox).queryByRole('button', { name: zh.findEngineers })).toBeNull()
  })

  it('keeps text under controller ownership and permits the first text-only submission', () => {
    const selected = conversation({ scopeKey: 'example-draft', requestId: null, number: null, title: '', status: null })
    const actions = page({ conversation: selected, draft: draft({ scopeKey: selected.scopeKey }) })
    openRequests()
    const input = screen.getByPlaceholderText(zh.describeRequest)
    const send = screen.getByRole('button', { name: zh.send })
    expect(send).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '请制作一个可筛选的订单列表' } })
    expect(actions.updateDraft).toHaveBeenCalledExactlyOnceWith({ text: '请制作一个可筛选的订单列表' })
    actions.set({ draft: draft({ scopeKey: selected.scopeKey, text: '请制作一个可筛选的订单列表' }) })
    fireEvent.click(send)
    expect(actions.send).toHaveBeenCalledOnce()
    expect(input).toHaveProperty('value', '请制作一个可筛选的订单列表')
    expect(actions.openRequest).not.toHaveBeenCalled()
  })

  it('permits attachment-only submission but blocks uploading and failed attachments', () => {
    const selected = conversation({ scopeKey: 'example-draft', requestId: null, number: null, status: null })
    const pending = attachment({ status: 'uploading', progressPercent: 42 })
    const actions = page({ conversation: selected, draft: draft({ scopeKey: selected.scopeKey, attachments: [pending] }) })
    openRequests()
    const send = screen.getByRole('button', { name: zh.send })
    expect(send).toHaveProperty('disabled', true)
    expect(screen.getByText('已上传 42%')).toBeTruthy()
    const picker = screen.getByLabelText(zh.selectAttachmentFiles)
    expect(picker.getAttribute('accept')).toBe('image/*,video/*,.pdf,.txt')
    expect(picker).toHaveProperty('multiple', true)
    const file = new File(['Example request'], '示例需求.txt', { type: 'text/plain' })
    fireEvent.change(picker, { target: { files: [file] } })
    expect(actions.addAttachments).toHaveBeenCalledExactlyOnceWith([file])
    actions.set({ draft: draft({ scopeKey: selected.scopeKey, attachments: [attachment({ status: 'failed' })] }) })
    expect(send).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: zh.retryAttachment }))
    expect(actions.retryAttachment).toHaveBeenCalledExactlyOnceWith('example-file')
    fireEvent.click(screen.getByRole('button', { name: '移除示例说明.pdf' }))
    expect(actions.removeAttachment).toHaveBeenCalledExactlyOnceWith('example-file')
    actions.set({ draft: draft({ scopeKey: selected.scopeKey, attachments: [attachment()] }) })
    expect(send).toHaveProperty('disabled', false)
    fireEvent.click(send)
    expect(actions.send).toHaveBeenCalledOnce()
    actions.set({ draft: draft({ scopeKey: selected.scopeKey, attachments: [attachment()], sending: true }) })
    expect(screen.getByRole('button', { name: zh.sending })).toHaveProperty('disabled', true)
  })

  it('keeps the visible attachment formats synchronized with the supplied upload rules', () => {
    const selected = conversation()
    const uploadRules = { ...demandState().uploadRules, accept: 'image/png,video/mp4,.png' }
    const actions = page({ conversation: selected, draft: draft(), uploadRules })
    openRequests()
    expect(screen.queryByText(/格式：PNG \/ MP4$/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.attachmentRules }))
    expect(screen.getByText(/格式：PNG \/ MP4$/u)).toBeTruthy()
    expect(screen.getByLabelText(zh.selectAttachmentFiles).getAttribute('accept')).toBe(uploadRules.accept)
    const changedAccept = 'video/webm,application/x-custom,.special'
    actions.set({ uploadRules: { ...uploadRules, accept: changedAccept } })
    expect(screen.getByText(/格式：WebM \/ application\/x-custom \/ \.special$/u)).toBeTruthy()
    expect(screen.queryByText(/格式：PNG \/ MP4$/u)).toBeNull()
    expect(screen.getByLabelText(zh.selectAttachmentFiles).getAttribute('accept')).toBe(changedAccept)
    actions.set({ uploadRules: { ...uploadRules, accept: 'image/*,video/*' } })
    expect(screen.getByText(/格式：所有图片格式 \/ 所有视频格式$/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.attachmentRules }))
    expect(screen.queryByText(/格式：所有图片格式 \/ 所有视频格式$/u)).toBeNull()
  })

  it('sends with Enter while preserving newline, composition and held-key behavior', () => {
    const actions = page({ conversation: conversation(), draft: draft({ text: '确认需求范围' }) })
    openRequests()
    const input = screen.getByRole('textbox', { name: zh.messagePlaceholder })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyUp(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', repeat: true })
    expect(actions.send).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(actions.send).toHaveBeenCalledOnce()
    actions.set({ draft: draft({ text: '' }) })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(actions.send).toHaveBeenCalledOnce()
  })

  it('keeps the chat composer compact and exposes optional fields without changing the draft scope', () => {
    const selected = conversation({ scopeKey: 'example-draft', requestId: null, number: null, status: null })
    const actions = page({ conversation: selected, draft: draft({ scopeKey: selected.scopeKey, text: '当前需求内容' }) })
    openRequests()
    expect(screen.queryByRole('heading', { name: zh.pageTitle })).toBeNull()
    expect(screen.queryByLabelText(zh.budgetLabel)).toBeNull()
    expect(screen.getByRole('button', { name: zh.send })).toBeTruthy()
    const input = screen.getByRole('textbox', { name: zh.describeRequest })
    expect(input.style.height).toBe('36px')
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 300 })
    actions.set({ draft: draft({ scopeKey: selected.scopeKey, text: '较长需求说明'.repeat(80) }) })
    expect(input.style.height).toBe('160px')
    expect(input.style.overflowY).toBe('auto')
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 36 })
    actions.set({ draft: draft({ scopeKey: selected.scopeKey, text: '当前需求内容' }) })
    expect(input.style.height).toBe('36px')
    const details = screen.getByRole('button', { name: zh.optionalDetails })
    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    fireEvent.change(screen.getByLabelText(zh.titleLabel), { target: { value: '订单页面需求' } })
    expect(actions.updateDraft).toHaveBeenCalledExactlyOnceWith({ title: '订单页面需求' })
    expect(screen.getByLabelText(zh.budgetLabel)).toBeTruthy()
    expect(screen.getByLabelText(zh.expectedDateLabel)).toBeTruthy()
    fireEvent.click(details)
    expect(screen.queryByLabelText(zh.budgetLabel)).toBeNull()
    expect(input).toHaveProperty('value', '当前需求内容')
    expect(actions.send).not.toHaveBeenCalled()
    expect(actions.startRequest).not.toHaveBeenCalled()
  })

  it('preserves historical authors after reassignment and does not guess missing message authors', () => {
    page({ conversation: conversation({ engineer: exampleEngineers[1] ?? null, messages: [
      message({ id: 'example-former-author', author: 'engineer', authorName: '示例工程师林', text: '示例历史交接内容' }),
      message({ id: 'example-unnamed-author', author: 'engineer', text: '示例缺名历史内容' }),
    ] }), draft: draft() })
    openRequests()
    expect(screen.getByRole('heading', { name: '示例工程师陈' })).toBeTruthy()
    const messages = within(screen.getByRole('log'))
    expect(messages.getByText('示例工程师林')).toBeTruthy()
    expect(messages.getByText(zh.engineerName)).toBeTruthy()
    expect(messages.queryByText('示例工程师陈')).toBeNull()
  })

  it('uses server send and read receipts and retries only the selected failed message', () => {
    const selected = conversation({ messages: [
      message({ id: 'example-sending', text: '示例发送中', state: 'sending' }),
      message({ id: 'example-sent', text: '示例已发送', state: 'sent' }),
      message({ id: 'example-read', text: '示例已读', state: 'sent', read: true }),
      message({ id: 'example-failed', text: '示例发送失败', state: 'failed', retryable: true }),
    ] })
    const actions = page({ conversation: selected, draft: draft() })
    openRequests()
    expect(screen.getByText(zh.sending)).toBeTruthy()
    expect(screen.getByText(zh.sent)).toBeTruthy()
    expect(screen.getByText(zh.read)).toBeTruthy()
    expect(screen.getByText(zh.sendFailed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retryMessage }))
    expect(actions.retryMessage).toHaveBeenCalledExactlyOnceWith('example-failed')
    expect(actions.send).not.toHaveBeenCalled()
  })

  it('retains conversation messages when an earlier-message read fails and respects read-only state', () => {
    const selected = conversation({
      messages: [message()], messagesStatus: 'error', hasEarlier: true, canSend: false,
      readOnlyReason: '示例需求已经关闭',
    })
    const actions = page({ conversation: selected, draft: draft({ text: '待保留的草稿' }) })
    openRequests()
    expect(screen.getByText('请增加订单筛选功能')).toBeTruthy()
    expect(screen.getByText(zh.messagesFailed)).toBeTruthy()
    expect(screen.getByText('示例需求已经关闭')).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.send })).toBeNull()
    expect(screen.queryByRole('textbox', { name: zh.messagePlaceholder })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.loadEarlier }))
    expect(actions.loadEarlierMessages).toHaveBeenCalledOnce()
    expect(actions.send).not.toHaveBeenCalled()
  })

  it('opens authorized images in a dismissible preview and preserves native video controls', () => {
    const selected = conversation({ messages: [message({ author: 'engineer', attachments: [
      attachment({ id: 'example-image', kind: 'image', name: '示例界面.png', previewUrl: 'https://example.invalid/preview.png' }),
      attachment({ id: 'example-video', kind: 'video', name: '示例演示.mp4', previewUrl: 'https://example.invalid/demo.mp4' }),
    ] })] })
    const actions = page({ conversation: selected, draft: draft() })
    openRequests()
    const opener = screen.getByRole('button', { name: '预览示例界面.png' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: zh.imagePreview })
    expect(within(dialog).getByRole('img', { name: '示例界面.png' }).getAttribute('src')).toBe('https://example.invalid/preview.png')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(screen.getByLabelText('示例演示.mp4')).toHaveProperty('controls', true)
    fireEvent.click(screen.getByRole('button', { name: '下载示例界面.png' }))
    expect(actions.downloadAttachment).toHaveBeenCalledExactlyOnceWith('example-image')
  })

  it('requires inline delivery confirmation before invoking the exact acceptance action', () => {
    const selected = conversation({ status: 'awaiting_acceptance', delivery: {
      id: 'example-delivery', title: '示例订单页面交付', description: '包含筛选表单和移动端页面',
      submittedAt: '2026-11-18T03:00:00Z', status: 'pending', attachments: [],
    } })
    const actions = page({ conversation: selected, draft: draft() })
    openRequests()
    fireEvent.click(screen.getByRole('button', { name: zh.acceptDelivery }))
    expect(actions.acceptDelivery).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: zh.acceptConfirm })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('button', { name: zh.acceptConfirm })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.acceptDelivery }))
    fireEvent.click(screen.getByRole('button', { name: zh.acceptConfirm }))
    expect(actions.acceptDelivery).toHaveBeenCalledExactlyOnceWith('example-delivery')
    actions.set({ conversation: { ...selected, acceptingDelivery: true } })
    expect(screen.getByRole('button', { name: zh.accepting })).toHaveProperty('disabled', true)
  })

  it('reopens each saved draft by its existing scope and does not duplicate the selected draft row', () => {
    const first = draftSummary({ scopeKey: 'example-draft-a', title: '示例历史草稿' })
    const second = draftSummary({ scopeKey: 'example-draft-b', title: '示例当前草稿' })
    const actions = page({ drafts: [first, second],
      conversation: conversation({ scopeKey: second.scopeKey, requestId: null, number: null, status: null, title: second.title }),
      draft: draft({ scopeKey: second.scopeKey, text: '当前草稿正文' }),
    })
    openRequests()
    const group = screen.getByRole('group', { name: zh.draftsGroup })
    expect(within(group).getAllByRole('button')).toHaveLength(2)
    expect(within(group).getAllByText(second.title)).toHaveLength(1)
    fireEvent.click(within(group).getByRole('button', { name: /示例历史草稿/u }))
    expect(actions.openDraft).toHaveBeenCalledExactlyOnceWith(first.scopeKey)
    expect(actions.startRequest).not.toHaveBeenCalled()
    expect(actions.send).not.toHaveBeenCalled()
    actions.set({ conversation: conversation({ scopeKey: first.scopeKey, requestId: null, number: null, status: null, title: first.title }),
      draft: draft({ scopeKey: first.scopeKey, text: '恢复的旧草稿正文' }) })
    expect(screen.getByRole('textbox', { name: zh.describeRequest })).toHaveProperty('value', '恢复的旧草稿正文')
  })

  it('labels unresolved publication and checks the original operation without allowing its body to change', () => {
    const pending = draftSummary({ pending: true, error: zh.resultUnknown })
    const actions = page({ drafts: [pending],
      conversation: conversation({ scopeKey: pending.scopeKey, requestId: null, number: null, status: null, canSend: false }),
      draft: draft({ scopeKey: pending.scopeKey, text: '原始发布正文', attachments: [attachment()] }),
    })
    openRequests()
    expect(screen.getAllByText(zh.pendingPublish).length).toBeGreaterThan(0)
    expect(screen.getByText(zh.resultUnknown)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: zh.describeRequest })).toHaveProperty('disabled', true)
    const remove = screen.getByRole('button', { name: '移除示例说明.pdf' })
    expect(remove).toHaveProperty('disabled', true)
    fireEvent.click(remove)
    expect(actions.removeAttachment).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: zh.send })).toBeNull()
    actions.set({ draft: draft({ scopeKey: pending.scopeKey, text: '' }) })
    expect(screen.getByRole('button', { name: zh.confirmPublication })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: zh.confirmPublication }))
    expect(actions.send).toHaveBeenCalledOnce()
    expect(actions.startRequest).not.toHaveBeenCalled()
    actions.set({ draft: draft({ scopeKey: pending.scopeKey, text: '', sending: true }) })
    expect(screen.getByRole('button', { name: zh.sending })).toHaveProperty('disabled', true)
  })

  it('freezes attachment removal and retry while this draft is sending', () => {
    const actions = page({ conversation: conversation(), draft: draft({ sending: true,
      attachments: [attachment({ status: 'failed', error: '示例上传尚未确认' })],
    }) })
    openRequests()
    const remove = screen.getByRole('button', { name: '移除示例说明.pdf' })
    const retry = screen.getByRole('button', { name: zh.retryAttachment })
    expect(remove).toHaveProperty('disabled', true)
    expect(retry).toHaveProperty('disabled', true)
    fireEvent.click(remove)
    fireEvent.click(retry)
    expect(actions.removeAttachment).not.toHaveBeenCalled()
    expect(actions.retryAttachment).not.toHaveBeenCalled()
  })
})
