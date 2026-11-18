/** Example-only records supplied through the same presentation types as server data. */
import type {
  DemandAttachment, DemandConversation, DemandDraft, DemandDraftSummary, DemandEngineer, DemandMessage, DemandPageState, DemandSummary,
} from '../src/client/types.ts'

/** Distinct server presence and admission flags keep offline messaging testable. */
export const exampleEngineers: readonly DemandEngineer[] = [
  {
    id: 'example-engineer-lin', displayName: '示例工程师林', avatarUrl: null,
    introduction: '实现响应式页面并改进表单体验', categoryIds: ['example-frontend'], skills: ['React', '表单'],
    presence: 'available', canStart: true, unavailableReason: null,
  },
  {
    id: 'example-engineer-chen', displayName: '示例工程师陈', avatarUrl: null,
    introduction: '整理文件并编写业务自动化脚本', categoryIds: ['example-automation'], skills: ['Python', '文件处理'],
    presence: 'offline', canStart: true, unavailableReason: null,
  },
  {
    id: 'example-engineer-zhou', displayName: '示例工程师周', avatarUrl: null,
    introduction: '维护页面样式和设计规范', categoryIds: ['example-frontend'], skills: ['CSS'],
    presence: 'busy', canStart: false, unavailableReason: '当前不接受新需求',
  },
]

/** One authorized attachment or pending upload, with no real remote resource. */
export function attachment(patch: Partial<DemandAttachment> = {}): DemandAttachment {
  return { id: 'example-file', name: '示例说明.pdf', kind: 'file', sizeBytes: 2048, status: 'ready', ...patch }
}

/** A persisted message or server-reported pending send. */
export function message(patch: Partial<DemandMessage> = {}): DemandMessage {
  return {
    id: 'example-message', author: 'user', text: '请增加订单筛选功能', createdAt: '2026-11-18T02:00:00Z',
    state: 'sent', read: false, retryable: false, attachments: [], ...patch,
  }
}

/** A saved request summary, independent of the selected conversation. */
export function request(patch: Partial<DemandSummary> = {}): DemandSummary {
  return {
    id: 'example-request', number: 'EXAMPLE-018', title: '示例订单页面改版', engineer: exampleEngineers[0] ?? null,
    status: 'communicating', updatedAt: '2026-11-18T02:00:00Z', preview: '请增加订单筛选功能', unreadCount: 2,
    ...patch,
  }
}

/** A selected saved conversation; drafts override requestId, number, and status. */
export function conversation(patch: Partial<DemandConversation> = {}): DemandConversation {
  return {
    scopeKey: 'example-request', requestId: 'example-request', number: 'EXAMPLE-018', title: '示例订单页面改版',
    engineer: exampleEngineers[0] ?? null, status: 'communicating', messages: [], messagesStatus: 'ready', error: null,
    hasEarlier: false, loadingEarlier: false, canSend: true, readOnlyReason: null, delivery: null,
    acceptingDelivery: false, ...patch,
  }
}

/** Draft fields remain controller-owned in tests, as they do in the page. */
export function draft(patch: Partial<DemandDraft> = {}): DemandDraft {
  return {
    scopeKey: 'example-request', text: '', title: '', budget: '', expectedDate: '', attachments: [], sending: false,
    error: null, ...patch,
  }
}

/** An actual saved local scope supplied by the controller, including an unresolved first publication. */
export function draftSummary(patch: Partial<DemandDraftSummary> = {}): DemandDraftSummary {
  return {
    scopeKey: 'example-draft', title: '示例未发布需求', engineer: exampleEngineers[0] ?? null,
    updatedAt: '2026-11-18T02:00:00Z', pending: false, error: null, ...patch,
  }
}

/** Ready directory fixture; unavailable-service cases explicitly clear server records. */
export function demandState(patch: Partial<DemandPageState> = {}): DemandPageState {
  return {
    availability: 'ready', error: null,
    categories: [{ id: 'example-frontend', label: '示例前端开发' }, { id: 'example-automation', label: '示例业务自动化' }],
    engineers: exampleEngineers, requests: [], drafts: [], requestsStatus: 'ready', requestsHaveMore: false, loadingMoreRequests: false,
    conversation: null, draft: null,
    uploadRules: { maxFiles: 4, maxFileBytes: 5 * 1024 * 1024, accept: 'image/*,video/*,.pdf,.txt' },
    ...patch,
  }
}
