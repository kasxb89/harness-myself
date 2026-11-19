// @vitest-environment jsdom
/** Pure community views enforce supplied permissions and explicit public consent without transport. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.ts'
import { CommunityDemandDetails } from '../src/client/CommunityDemandDetails.tsx'
import { CommunityDemandPublish } from '../src/client/CommunityDemandPublish.tsx'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Browser geometry belongs to the integration owner. */ }
    unobserve(): void { /* No geometry observation in these pure view tests. */ }
    disconnect(): void { /* No retained observer. */ }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, params) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu,
  (placeholder: string, name: string) => params !== undefined && name in params ? String(params[name]) : placeholder)

function detailsProps(): ComponentProps<typeof CommunityDemandDetails> {
  return {
    open: true, t,
    demand: { id: 'public-example', title: '示例公开页面需求', serviceName: '示例页面服务', brief: '已批准公开的页面说明',
      authorDisplayName: '示例发布者', attachments: [{ id: 'public-file', name: '公开说明.pdf', kind: 'file', sizeBytes: 1024 }] },
    access: { relation: 'visitor', canClaim: true, canOpenConversation: false, reason: null }, operation: { state: 'idle' },
    onClose: vi.fn(), onClaim: vi.fn(), onCheck: vi.fn(), onOpenConversation: vi.fn(), onDownloadAttachment: vi.fn(),
  }
}

function publishProps(): ComponentProps<typeof CommunityDemandPublish> {
  return {
    open: true, t, draft: { title: '示例公开需求', brief: '仅此处输入的公开说明', serviceId: 'service-a' },
    services: [{ id: 'service-a', label: '示例页面服务' }, { id: 'service-b', label: '示例文档服务' }],
    attachments: [], attachmentAccept: '.pdf,image/*', canPublish: true, unavailableReason: null, locked: false,
    operation: { state: 'idle' }, onClose: vi.fn(), onChange: vi.fn(), onAddAttachments: vi.fn(),
    onRemoveAttachment: vi.fn(), onRetryAttachment: vi.fn(), onSubmit: vi.fn(), onCheck: vi.fn(), onOfficialCustomization: vi.fn(),
  }
}

describe('public demand detail view', () => {
  it('renders only approved public fields and delegates authorized attachment access', () => {
    const props = detailsProps()
    const supplied = { ...props.demand, phone: 'PRIVATE-PHONE', privateHistory: 'PRIVATE-HISTORY' }
    render(<CommunityDemandDetails {...props} demand={supplied} />)
    const dialog = screen.getByRole('dialog', { name: zh.communityPublicDetails })
    expect(within(dialog).getByText(props.demand.brief)).toBeTruthy()
    expect(within(dialog).getByText(props.demand.authorDisplayName)).toBeTruthy()
    expect(within(dialog).getByText(zh.communityAdminVisibility)).toBeTruthy()
    expect(dialog.textContent).not.toContain('PRIVATE-')
    expect(dialog.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下载公开说明.pdf' }))
    expect(props.onDownloadAttachment).toHaveBeenCalledExactlyOnceWith('public-file')
    fireEvent.click(screen.getByRole('button', { name: zh.communityClaim }))
    expect(props.onClaim).toHaveBeenCalledOnce()
  })

  it('uses viewer permissions and never offers owners or current claimers another claim', () => {
    const props = detailsProps()
    const view = render(<CommunityDemandDetails {...props}
      access={{ relation: 'owner', canClaim: true, canOpenConversation: false, reason: '这是你发布的需求' }} />)
    expect(screen.queryByRole('button', { name: zh.communityClaim })).toBeNull()
    view.rerender(<CommunityDemandDetails {...props}
      access={{ relation: 'claimer', canClaim: true, canOpenConversation: true, reason: null }} />)
    expect(screen.queryByRole('button', { name: zh.communityClaim })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.communicate }))
    expect(props.onOpenConversation).toHaveBeenCalledOnce()
    view.rerender(<CommunityDemandDetails {...props}
      access={{ relation: 'visitor', canClaim: false, canOpenConversation: false, reason: '已被其他用户接单' }} />)
    expect(screen.getByText('已被其他用户接单')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.communityClaim }))
    expect(props.onClaim).not.toHaveBeenCalled()
  })

  it('locks submissions and checks only the original unknown operation', () => {
    const props = detailsProps()
    const view = render(<CommunityDemandDetails {...props} operation={{ state: 'submitting' }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.communityClaiming }))
    expect(props.onClaim).not.toHaveBeenCalled()
    view.rerender(<CommunityDemandDetails {...props} operation={{ state: 'unknown', checking: false }} />)
    expect(screen.queryByRole('button', { name: zh.communityClaim })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(zh.communityClaimUnknown)
    fireEvent.click(screen.getByRole('button', { name: zh.communityCheckClaim }))
    expect(props.onCheck).toHaveBeenCalledOnce()
    view.rerender(<CommunityDemandDetails {...props} operation={{ state: 'unknown', checking: true }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.communityCheckClaim }))
    expect(props.onCheck).toHaveBeenCalledOnce()
    view.rerender(<CommunityDemandDetails {...props} operation={{ state: 'failed', message: '此需求已取消' }}
      access={{ ...props.access, canClaim: false, reason: null }} />)
    expect(screen.getByRole('alert').textContent).toBe('此需求已取消')
    expect(props.onClaim).not.toHaveBeenCalled()
  })

  it('keeps a known sealed failure distinct and retries only its original operation', () => {
    const props = detailsProps()
    const view = render(<CommunityDemandDetails {...props}
      operation={{ state: 'failed', message: '已被其他用户接单', recoverable: true }} />)
    expect(screen.getByRole('alert').textContent).toBe('已被其他用户接单')
    expect(screen.queryByText(zh.communityClaimUnknown)).toBeNull()
    expect(screen.queryByRole('button', { name: zh.communityClaim })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.communityRetryOriginal }))
    expect(props.onCheck).toHaveBeenCalledOnce()
    expect(props.onClaim).not.toHaveBeenCalled()
    view.rerender(<CommunityDemandDetails {...props}
      operation={{ state: 'failed', message: '已被其他用户接单', recoverable: true, recovering: true }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.communityRetryOriginal }))
    expect(props.onCheck).toHaveBeenCalledOnce()
  })
})

describe('explicit public publication view', () => {
  it('defaults consent to false and submits no private request or unapproved snapshot', () => {
    const props = publishProps()
    const view = render(<CommunityDemandPublish {...props} />)
    const publish = screen.getByRole('button', { name: zh.communityPublish })
    expect(screen.getByRole('checkbox', { name: zh.communityPublicConsent })).toHaveProperty('checked', false)
    expect(publish).toHaveProperty('disabled', true)
    const form = screen.getByRole('textbox', { name: zh.titleLabel }).closest('form')
    if (form === null) throw new Error('Publication fields belong to one explicit form')
    fireEvent.submit(form)
    expect(props.onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: zh.communityPublicConsent }))
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ allowPublic: true })
    expect(publish).toHaveProperty('disabled', true)
    view.rerender(<CommunityDemandPublish {...props} draft={{ ...props.draft, allowPublic: true }} />)
    const preview = screen.getByRole('region', { name: zh.communityPublicationPreview })
    expect(within(preview).getByText(props.draft.title)).toBeTruthy()
    expect(within(preview).getByText(props.draft.brief)).toBeTruthy()
    expect(screen.getByText(zh.communityPublicScope)).toBeTruthy()
    expect(publish).toHaveProperty('disabled', false)
    fireEvent.submit(form)
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith()
  })

  it('delegates category and file choices without starting a transport or creating another flow', () => {
    const props = publishProps()
    render(<CommunityDemandPublish {...props} draft={{ ...props.draft, allowPublic: true }} />)
    fireEvent.click(screen.getByRole('button', { name: `${zh.communityService} 示例页面服务` }))
    fireEvent.click(screen.getByRole('menuitem', { name: '示例文档服务' }))
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ serviceId: 'service-b' })
    const file = new File(['public example'], '公开附件.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText(zh.selectAttachmentFiles), { target: { files: [file] } })
    expect(props.onAddAttachments).toHaveBeenCalledExactlyOnceWith([file])
    fireEvent.click(screen.getByRole('button', { name: zh.officialCustomization }))
    expect(props.onOfficialCustomization).toHaveBeenCalledOnce()
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('announces both the service field and its controlled current value', () => {
    const props = publishProps()
    const view = render(<CommunityDemandPublish {...props} draft={{ ...props.draft, serviceId: '' }} />)
    const placeholderName = `${zh.communityService} ${zh.communityChooseService}`
    fireEvent.click(screen.getByRole('button', { name: placeholderName }))
    fireEvent.click(screen.getByRole('menuitem', { name: '示例文档服务' }))
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ serviceId: 'service-b' })
    expect(screen.getByRole('button', { name: placeholderName })).toBeTruthy()
    view.rerender(<CommunityDemandPublish {...props} draft={{ ...props.draft, serviceId: 'service-b' }} />)
    expect(screen.getByRole('button', { name: `${zh.communityService} 示例文档服务` })).toBeTruthy()
    expect(screen.queryByRole('button', { name: placeholderName })).toBeNull()
  })

  it('honors permission, field and attachment readiness before public submission', () => {
    const props = publishProps()
    const approved = { ...props.draft, allowPublic: true }
    const view = render(<CommunityDemandPublish {...props} draft={approved} canPublish={false} unavailableReason="暂不可公开发布" />)
    expect(screen.getByRole('button', { name: zh.communityPublish })).toHaveProperty('disabled', true)
    expect(screen.getByText('暂不可公开发布')).toBeTruthy()
    view.rerender(<CommunityDemandPublish {...props} draft={{ ...approved, brief: ' ' }} />)
    expect(screen.getByRole('button', { name: zh.communityPublish })).toHaveProperty('disabled', true)
    view.rerender(<CommunityDemandPublish {...props} draft={approved}
      attachments={[{ id: 'pending-file', name: '正在上传.pdf', kind: 'file', sizeBytes: 100, status: 'uploading' }]} />)
    expect(screen.getByRole('button', { name: zh.communityPublish })).toHaveProperty('disabled', true)
  })

  it('freezes every draft control for unknown results and exposes only the original-operation check', () => {
    const props = publishProps()
    const view = render(<CommunityDemandPublish {...props} draft={{ ...props.draft, allowPublic: true }}
      operation={{ state: 'unknown', checking: false }} />)
    expect(screen.queryByRole('button', { name: zh.communityPublish })).toBeNull()
    expect(screen.getByRole('textbox', { name: zh.titleLabel })).toHaveProperty('disabled', true)
    expect(screen.getByRole('checkbox', { name: zh.communityPublicConsent })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByRole('textbox', { name: zh.titleLabel }), { target: { value: '不得替换原操作' } })
    fireEvent.click(screen.getByRole('button', { name: zh.officialCustomization }))
    expect(props.onChange).not.toHaveBeenCalled()
    expect(props.onOfficialCustomization).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.communityCheckPublication }))
    expect(props.onCheck).toHaveBeenCalledOnce()
    view.rerender(<CommunityDemandPublish {...props} draft={{ ...props.draft, allowPublic: true }}
      operation={{ state: 'unknown', checking: true }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.communityCheckPublication }))
    expect(props.onCheck).toHaveBeenCalledOnce()
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps known publication failures sealed while offering an explicit original-operation retry', () => {
    const props = publishProps()
    render(<CommunityDemandPublish {...props} locked draft={{ ...props.draft, allowPublic: true }}
      operation={{ state: 'failed', message: '服务暂不可用', recoverable: true }} />)
    expect(screen.getByRole('alert').textContent).toBe('服务暂不可用')
    expect(screen.getByRole('textbox', { name: zh.titleLabel })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: zh.communityPublish })).toBeNull()
    expect(screen.queryByText(zh.communityPublicationUnknown)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.communityRetryOriginal }))
    expect(props.onCheck).toHaveBeenCalledOnce()
    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(props.onChange).not.toHaveBeenCalled()
  })
})
