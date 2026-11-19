// @vitest-environment jsdom
/** Person-to-person chat keeps receipt authors, controlled drafts and original send recovery independent. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.ts'
import { CommunityDemandChat } from '../src/client/CommunityDemandChat.tsx'
import type { CommunityChatMessageView } from '../src/client/community-view.ts'
import type { DemandAttachment } from '../src/client/types.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Geometry is verified by the integration owner. */ }
    unobserve(): void { /* No geometry observation in jsdom. */ }
    disconnect(): void { /* No retained observer. */ }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, params) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu,
  (placeholder: string, name: string) => params !== undefined && name in params ? String(params[name]) : placeholder)

function message(patch: Partial<CommunityChatMessageView> = {}): CommunityChatMessageView {
  return { key: 'example-message', authorKind: 'publisher', authorName: '示例发布人', isSelf: true, text: '示例历史消息',
    createdAt: '2026-11-19T02:00:00Z', attachments: [], state: 'sent', recovery: 'none', recovering: false, error: null, ...patch }
}

function chatProps(): ComponentProps<typeof CommunityDemandChat> {
  return {
    conversation: { key: 'example-chat', title: '示例用户需求', counterparty: { name: '当前接单人', role: 'acceptor' },
      messages: [], status: 'ready', error: null, hasMoreMessages: false, loadingMoreMessages: false, canSend: true, readOnlyReason: null },
    draftText: '', attachments: [], locked: false, sending: false, draftError: null,
    rules: { maxFiles: 4, maxFileBytes: 1024 * 1024, accept: 'image/*,video/*,.pdf' }, t,
    onBack: vi.fn(), onChange: vi.fn(), onSend: vi.fn(), onAddAttachments: vi.fn(), onRemoveAttachment: vi.fn(),
    onRetryAttachment: vi.fn(), onDownloadAttachment: vi.fn(), onRetryMessage: vi.fn(), onCheckMessage: vi.fn(),
    onLoadMoreMessages: vi.fn(), onRefresh: vi.fn(),
  }
}

describe('community person-to-person chat', () => {
  it('uses immutable message authors and actual self identity without inventing engineer presence', () => {
    const props = chatProps()
    render(<CommunityDemandChat {...props} conversation={{ ...props.conversation, messages: [
      message({ key: 'self', text: '当前用户发言' }),
      message({ key: 'same-role-peer', isSelf: false, authorName: '历史发布者', text: '同角色的另一用户发言' }),
      message({ key: 'former-acceptor', authorKind: 'acceptor', isSelf: false, authorName: '原接单人', text: '历史接单消息' }),
      message({ key: 'admin', authorKind: 'admin', isSelf: false, authorName: null, text: '管理员说明' }),
      message({ key: 'system', authorKind: 'system', isSelf: false, authorName: '系统记录', text: '需求已更新' }),
    ] }} />)
    const log = screen.getByRole('log')
    const self = within(log).getByText('当前用户发言').closest('article')
    const peer = within(log).getByText('同角色的另一用户发言').closest('article')
    expect(self?.getAttribute('data-author')).toBe('user')
    expect(peer?.getAttribute('data-author')).toBe('peer')
    expect(peer?.getAttribute('data-author-kind')).toBe('publisher')
    expect(within(log).getByText('原接单人 · 接单用户')).toBeTruthy()
    expect(within(log).queryByText('当前接单人 · 接单用户')).toBeNull()
    expect(within(log).getByText(zh.communityAdministrator)).toBeTruthy()
    expect(within(log).getByText('系统记录')).toBeTruthy()
    expect(within(log).getByText('需求已更新').closest('[data-author-kind="system"]')).toBeTruthy()
    expect(screen.queryByText(zh.presenceAvailable)).toBeNull()
    expect(screen.queryByText(zh.engineerName)).toBeNull()
    expect(screen.getByText(zh.communityChatPrivacy)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.communityBackToBoard }))
    expect(props.onBack).toHaveBeenCalledOnce()
  })

  it('keeps draft text controlled and protects Enter from multiline, composition, IME and repeats', () => {
    const props = chatProps()
    const view = render(<CommunityDemandChat {...props} />)
    const input = screen.getByRole('textbox', { name: zh.messagePlaceholder })
    expect(screen.getByRole('button', { name: zh.send })).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '确认需求范围' } })
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith('确认需求范围')
    expect(input).toHaveProperty('value', '')
    view.rerender(<CommunityDemandChat {...props} draftText="确认需求范围" />)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Enter', altKey: true })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyUp(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', repeat: true })
    expect(props.onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledOnce()
    view.rerender(<CommunityDemandChat {...props} draftText="确认需求范围" sending />)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledOnce()
  })

  it('retains read-only history and checks only the original unknown send while new sends stay forbidden', () => {
    const props = chatProps()
    const unknown = message({ key: 'original-unknown-key', state: 'unknown', recovery: 'check', text: '原发送内容' })
    const failed = message({ key: 'known-failed-key', state: 'failed', recovery: 'retry', text: '已确认失败的内容' })
    const conversation = { ...props.conversation, counterparty: null, canSend: false, readOnlyReason: '需求已关闭，仅可查看历史',
      messages: [unknown, failed] }
    const view = render(<CommunityDemandChat {...props} conversation={conversation} locked />)
    expect(screen.getByText(zh.communityBoardPublic)).toBeTruthy()
    expect(screen.getByText('需求已关闭，仅可查看历史')).toBeTruthy()
    expect(screen.getByText('原发送内容')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: zh.addAttachments })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retryMessage }))
    expect(props.onRetryMessage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.communityCheckMessage }))
    expect(props.onCheckMessage).toHaveBeenCalledExactlyOnceWith(unknown.key)
    view.rerender(<CommunityDemandChat {...props}
      conversation={{ ...conversation, messages: [{ ...unknown, recovering: true }, failed] }} locked />)
    fireEvent.click(screen.getByRole('button', { name: zh.communityCheckMessage }))
    expect(props.onCheckMessage).toHaveBeenCalledOnce()
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('freezes attachment changes under a lock and permits only ready attachment-only sends', () => {
    const props = chatProps()
    const file: DemandAttachment = { id: 'example-file', name: '示例附件.pdf', kind: 'file', sizeBytes: 512, status: 'failed' }
    const view = render(<CommunityDemandChat {...props} attachments={[file]} locked />)
    fireEvent.click(screen.getByRole('button', { name: '移除示例附件.pdf' }))
    fireEvent.click(screen.getByRole('button', { name: zh.retryAttachment }))
    const selected = new File(['example'], '新附件.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText(zh.selectAttachmentFiles), { target: { files: [selected] } })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '不能修改' } })
    expect(props.onRemoveAttachment).not.toHaveBeenCalled()
    expect(props.onRetryAttachment).not.toHaveBeenCalled()
    expect(props.onAddAttachments).not.toHaveBeenCalled()
    expect(props.onChange).not.toHaveBeenCalled()
    view.rerender(<CommunityDemandChat {...props} attachments={[{ ...file, status: 'uploading' }]} />)
    expect(screen.getByRole('button', { name: zh.send })).toHaveProperty('disabled', true)
    view.rerender(<CommunityDemandChat {...props} attachments={[{ ...file, status: 'ready' }]} />)
    fireEvent.click(screen.getByRole('button', { name: zh.send }))
    expect(props.onSend).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByLabelText(zh.selectAttachmentFiles), { target: { files: [selected] } })
    expect(props.onAddAttachments).toHaveBeenCalledExactlyOnceWith([selected])
  })

  it('uses approved media previews, native video controls and authorized download callbacks', () => {
    const props = chatProps()
    const media: readonly DemandAttachment[] = [
      { id: 'image', name: '示例图片.png', kind: 'image', sizeBytes: 512, status: 'ready', previewUrl: 'https://example.invalid/image.png' },
      { id: 'video', name: '示例视频.mp4', kind: 'video', sizeBytes: 1024, status: 'ready', previewUrl: 'https://example.invalid/video.mp4' },
      { id: 'file', name: '示例文件.pdf', kind: 'file', sizeBytes: 100, status: 'ready' },
    ]
    render(<CommunityDemandChat {...props} conversation={{ ...props.conversation, messages: [message({ attachments: media })] }} />)
    const log = screen.getByRole('log')
    expect(log.querySelector('video')).toHaveProperty('controls', true)
    fireEvent.click(screen.getByRole('button', { name: '预览示例图片.png' }))
    expect(screen.getByRole('dialog', { name: zh.imagePreview })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog', { name: zh.imagePreview })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下载示例文件.pdf' }))
    expect(props.onDownloadAttachment).toHaveBeenCalledExactlyOnceWith('file')
  })

  it('preserves all eight attachment removal targets beside a bounded long-text composer', () => {
    const props = chatProps()
    const attachments: readonly DemandAttachment[] = Array.from({ length: 8 }, (_, index) => ({
      id: `ready-${index}`, name: `完整保留的长附件名称-${index}-示例需求说明与资料.png`, kind: 'image', sizeBytes: 100, status: 'ready',
    }))
    const longDraft = '长草稿内容仅用于本地编辑'.repeat(500).slice(0, 5719)
    const view = render(<CommunityDemandChat {...props} attachments={attachments} rules={{ ...props.rules, maxFiles: 8 }} />)
    const input = screen.getByRole('textbox', { name: zh.messagePlaceholder })
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 5000 })
    view.rerender(<CommunityDemandChat {...props} draftText={longDraft} attachments={attachments}
      rules={{ ...props.rules, maxFiles: 8 }} />)
    expect(input).toHaveProperty('value', longDraft)
    expect(input.style.height).toBe('160px')
    expect(input.style.overflowY).toBe('auto')
    const list = screen.getByRole('list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(8)
    attachments.forEach((item, index) => {
      expect(within(list).getByText(item.name)).toBeTruthy()
      fireEvent.click(within(list).getByRole('button', { name: `移除${item.name}` }))
      expect(props.onRemoveAttachment).toHaveBeenNthCalledWith(index + 1, item.id)
    })
    expect(props.onSend).not.toHaveBeenCalled()
    expect(props.onRetryAttachment).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: zh.send })).toHaveProperty('disabled', false)
  })

  it('retains messages on read failures and labels forward pagination without claiming older history', () => {
    const props = chatProps()
    const conversation = { ...props.conversation, status: 'error' as const, error: '读取中断，已有记录仍在',
      hasMoreMessages: true, messages: [message()] }
    const view = render(<CommunityDemandChat {...props} conversation={conversation} />)
    expect(screen.getAllByRole('log')).toHaveLength(1)
    expect(screen.getByText('示例历史消息')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('读取中断，已有记录仍在')
    expect(screen.queryByRole('button', { name: zh.loadEarlier })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(props.onRefresh).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh.communityLoadMoreMessages }))
    expect(props.onLoadMoreMessages).toHaveBeenCalledOnce()
    view.rerender(<CommunityDemandChat {...props} conversation={{ ...conversation, loadingMoreMessages: true }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.communityLoadingMoreMessages }))
    expect(props.onLoadMoreMessages).toHaveBeenCalledOnce()
  })
})
