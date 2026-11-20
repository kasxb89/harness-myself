// @vitest-environment jsdom
/** Public upload controls expose the real media selection and retain owner commands. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.ts'
import { CommunityDemandPublish } from '../src/client/CommunityDemandPublish.tsx'
import { DemandUploads } from '../src/client/DemandAttachments.tsx'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'

const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, params) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu,
  (placeholder: string, name: string) => params !== undefined && name in params ? String(params[name]) : placeholder)
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Geometry belongs to the built-browser test. */ }
    unobserve(): void { /* No browser geometry resource. */ }
    disconnect(): void { /* No retained browser observer. */ }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function publishProps(): ComponentProps<typeof CommunityDemandPublish> {
  return { open: true, draft: { title: '企业官网', brief: '交付响应式页面', serviceId: '', allowPublic: true },
    services: [], attachments: [], attachmentAccept: 'image/png,video/mp4', canPublish: true, unavailableReason: null,
    locked: false, operation: { state: 'idle' }, onClose: vi.fn(), onChange: vi.fn(), onAddAttachments: vi.fn(),
    onRemoveAttachment: vi.fn(), onRetryAttachment: vi.fn(), onSubmit: vi.fn(), onCheck: vi.fn(), t }
}

describe('public media upload presentation', () => {
  it.each([
    ['image/png,video/mp4', '上传图片 / 视频'],
    ['image/png,image/jpeg', '上传图片'],
    ['video/mp4', '上传视频'],
    ['application/pdf', '添加附件'],
  ])('describes only the selectable types for %s', (accept, label) => {
    const props = publishProps()
    render(<CommunityDemandPublish {...props} attachmentAccept={accept} />)
    const region = screen.getByRole('region', { name: zh.communityPublicAttachments })
    expect(within(region).getByRole('button', { name: label })).toHaveProperty('disabled', false)
    expect(within(region).getByLabelText(zh.selectAttachmentFiles)).toHaveProperty('accept', accept)
    expect(within(region).getByText('选择文件或拖到这里，上传完成后可预览')).toBeTruthy()
  })

  it('delegates one chooser or drop selection without submitting or replacing controlled data', () => {
    const props = publishProps()
    render(<CommunityDemandPublish {...props} />)
    const input = screen.getByLabelText(zh.selectAttachmentFiles)
    const click = vi.spyOn(input, 'click')
    const target = screen.getByRole('button', { name: '上传图片 / 视频' })
    fireEvent.click(target)
    expect(click).toHaveBeenCalledOnce()
    const image = new File(['image bytes'], '官网参考.png', { type: 'image/png' })
    const video = new File(['video bytes'], '镜头参考.mp4', { type: 'video/mp4' })
    fireEvent.change(input, { target: { files: [image] } })
    expect(props.onAddAttachments).toHaveBeenNthCalledWith(1, [image])
    fireEvent.dragOver(target, { dataTransfer: { types: ['Files'], files: [video] } })
    fireEvent.drop(target, { dataTransfer: { types: ['Files'], files: [video] } })
    expect(props.onAddAttachments).toHaveBeenNthCalledWith(2, [video])
    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(props.onChange).not.toHaveBeenCalled()
    click.mockRestore()
  })

  it('freezes chooser and drop while the original publication outcome is unknown', () => {
    const props = publishProps()
    const view = render(<CommunityDemandPublish {...props} operation={{ state: 'unknown', checking: false }} />)
    const file = new File(['bytes'], '参考.png', { type: 'image/png' })
    const target = screen.getByRole('button', { name: '上传图片 / 视频' })
    expect(target).toHaveProperty('disabled', true)
    fireEvent.drop(target, { dataTransfer: { types: ['Files'], files: [file] } })
    fireEvent.change(screen.getByLabelText(zh.selectAttachmentFiles), { target: { files: [file] } })
    expect(props.onAddAttachments).not.toHaveBeenCalled()
    view.rerender(<CommunityDemandPublish {...props} attachmentAccept="" />)
    expect(screen.getByRole('button', { name: zh.addAttachments })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(zh.selectAttachmentFiles)).toHaveProperty('disabled', true)
  })

  it('previews only supplied authorized ready media while preserving progress, removal and original retry', () => {
    const remove = vi.fn(), retry = vi.fn()
    render(<DemandUploads attachments={[
      { id: 'image-operation', name: '官网参考.png', kind: 'image', sizeBytes: 1024, status: 'ready', previewUrl: '/authorized/image' },
      { id: 'video-operation', name: '参考片段.mp4', kind: 'video', sizeBytes: 2048, status: 'ready', previewUrl: '/authorized/video' },
      { id: 'pending-operation', name: '上传中.png', kind: 'image', sizeBytes: 1024, status: 'uploading', progressPercent: 42 },
      { id: 'failed-operation', name: '待重试.png', kind: 'image', sizeBytes: 1024, status: 'failed', error: '网络暂时不可用' },
    ]} remove={remove} retry={retry} t={t} />)
    expect(screen.getByRole('img', { name: '官网参考.png' }).getAttribute('src')).toBe('/authorized/image')
    const video = screen.getByLabelText('参考片段.mp4')
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toBe('/authorized/video')
    expect(video).toHaveProperty('controls', true)
    expect(video).toHaveProperty('autoplay', false)
    expect(screen.getByRole('progressbar', { name: '上传中.png' })).toHaveProperty('value', 42)
    expect(screen.queryByRole('img', { name: '上传中.png' })).toBeNull()
    expect(screen.getByText('网络暂时不可用')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除官网参考.png' }))
    expect(remove).toHaveBeenCalledExactlyOnceWith('image-operation')
    fireEvent.click(screen.getByRole('button', { name: zh.retryAttachment }))
    expect(retry).toHaveBeenCalledExactlyOnceWith('failed-operation')
    fireEvent.click(screen.getByRole('button', { name: '预览官网参考.png' }))
    expect(screen.getByRole('dialog', { name: zh.imagePreview })).toBeTruthy()
    expect(screen.getAllByRole('img', { name: '官网参考.png' })).toHaveLength(2)
  })
})
