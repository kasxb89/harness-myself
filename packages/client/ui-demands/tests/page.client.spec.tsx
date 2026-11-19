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

function page(partial: Partial<DemandPageState> = {}) {
  const store = createSnapshotStore(demandState(partial))
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
  }
  const props: DemandPageProps = {
    ...actions,
    usePanelInfo: unusedHook, useSessions: unusedHook, useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook,
    useWorkspaces: unusedHook, useResource: unusedHook, useDemands: bindSnapshotSelector(store),
    t: (key, params) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu, (placeholder: string, name: string) =>
      params !== undefined && name in params ? String(params[name]) : placeholder),
  }
  render(<DemandPage {...props} />)
  return {
    ...actions, store,
    set: (next: Partial<DemandPageState>) => { act(() => { store.set({ ...store.getSnapshot(), ...next }) }) },
  }
}

function openRequests() {
  fireEvent.click(screen.getByRole('tab', { name: zh.myRequests }))
}

describe('human-engineer demand page', () => {
  it('shows actual service profiles and server totals without presenting them as live engineers', () => {
    const actions = page({ directoryMode: 'services', serviceProfiles: [serviceProfile({ avatarUrl: 'https://example.invalid/service.png' })],
      servicesTotal: 100 })
    expect(screen.getByRole('tab', { name: zh.findServices })).toBeTruthy()
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
    const unavailable = screen.getByRole('button', { name: '向示例工程师周发起需求' })
    expect(unavailable).toHaveProperty('disabled', true)
    fireEvent.click(unavailable)
    expect(actions.startRequest).not.toHaveBeenCalled()
    expect(screen.getByText(zh.presenceOffline)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '向示例工程师陈发起需求' }))
    expect(actions.startRequest).toHaveBeenCalledExactlyOnceWith('example-engineer-chen')
    expect(screen.getByRole('tab', { name: zh.myRequests }).getAttribute('aria-selected')).toBe('true')
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
