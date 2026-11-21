// @vitest-environment jsdom
/** Forum media and account presentation never invent a publication, identity, reply or upload result. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ForumCenter } from '../src/client/ForumCenter.tsx'
import { ForumImageComposer, ForumImages } from '../src/client/ForumImages.tsx'
import type { ForumCenterProps, ForumImageComposerView, ForumImageUploadView, ForumPostDetail } from '../src/client/forum-view.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Browser acceptance checks geometry. */ }
    unobserve(): void { /* No geometry subscription in jsdom. */ }
    disconnect(): void { /* No retained observer. */ }
  })
})
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); vi.unstubAllGlobals() })
const labels: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, values) => (labels.get(key) ?? key).replace(/\{(\w+)\}/gu, (raw: string, name: string) =>
  values !== undefined && name in values ? String(values[name]) : raw)
const image: ForumImageUploadView = { id: 'forum-image-original', name: '图片.png', sizeBytes: 24,
  previewUrl: 'https://example.invalid/signed-forum-image', status: 'ready', progressPercent: 100, error: null }
function media(patch: Partial<ForumImageComposerView> = {}): ForumImageComposerView {
  return { items: [], canAdd: true, accept: 'image/png,image/jpeg', maxAttachments: 8, maxBytes: 20_971_520,
    allowImageOnly: true, onAdd: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn(), ...patch }
}
function detail(patch: Partial<ForumPostDetail> = {}): ForumPostDetail {
  return { id: 'post-original', title: '图片工作流', body: '原始正文', excerpt: '原始正文', authorName: '云间', createdAt: '',
    likeCount: 0, replyCount: 2, replies: [], canReply: true, replyReason: null, hasMoreReplies: false,
    loadingMoreReplies: false, liked: false, canLike: true, likeOperation: { state: 'idle' }, ...patch }
}
function props(patch: Partial<ForumCenterProps> = {}): ForumCenterProps {
  return {
    view: { availability: 'ready', reason: null, accountName: null, canCreate: true,
      list: { posts: [], status: 'ready', error: null, hasMore: false, loadingMore: false },
      detail: { postId: null, post: null, status: 'ready', error: null } },
    postDraft: { title: '', body: '' }, replyDraft: '', postLocked: false, replyLocked: false,
    postOperation: { state: 'idle' }, replyOperation: { state: 'idle' }, postComposerOpen: false,
    onOpenPostComposer: vi.fn(), onClosePostComposer: vi.fn(), onOpenPost: vi.fn(), onBack: vi.fn(),
    onRefresh: vi.fn(), onLoadMore: vi.fn(), onLoadMoreReplies: vi.fn(), onStartPost: vi.fn(),
    onChangePost: vi.fn(), onSubmitPost: vi.fn(), onCheckPost: vi.fn(), onChangeReply: vi.fn(),
    onSubmitReply: vi.fn(), onCheckReply: vi.fn(), onToggleLike: vi.fn(), onCheckLike: vi.fn(), t, ...patch,
  }
}

describe('forum image presentation', () => {
  it('opens a confirmed video only on explicit preview with one native seek control and stops it on close', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    onTestFinished(() => { pause.mockRestore(); load.mockRestore() })
    const video = { ...image, id: 'forum-video-original', kind: 'video' as const, name: '工作流.mp4',
      mimeType: 'video/mp4', previewUrl: 'https://example.invalid/owned-forum-video' }
    render(<ForumImages images={[image, video]} t={t} />)
    expect(document.querySelector('video')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '播放工作流.mp4' }))
    const dialog = screen.getByRole('dialog', { name: zh.forumVideoPreview })
    const player = within(dialog).getByLabelText(video.name)
    expect(player).toBeInstanceOf(HTMLVideoElement)
    expect(player).toHaveProperty('controls', true)
    expect(player).toHaveProperty('autoplay', false)
    expect(player.getAttribute('playsinline')).not.toBeNull()
    expect(player.getAttribute('preload')).toBe('none')
    expect(player.getAttribute('src')).toBe(video.previewUrl)
    expect(within(dialog).queryByRole('slider')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: zh.close }))
    expect(document.querySelector('video')).toBeNull()
    expect(pause).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledOnce()
  })

  it('does not expose an unready video and keeps the original retry identity when video upload is unavailable', () => {
    const data = media({ canAdd: false, items: [{ ...image, kind: 'video', name: '原片.mp4',
      previewUrl: null, status: 'failed', requiresFile: true }] })
    render(<ForumImageComposer media={data} disabled={false} t={t} />)
    expect(document.querySelector('video')).toBeNull()
    expect(screen.queryByRole('button', { name: '播放原片.mp4' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retryAttachment }))
    const original = new File(['retained video'], '原片.mp4', { type: 'video/mp4' })
    fireEvent.change(screen.getByLabelText(zh.forumChooseOriginalMedia, { selector: 'input' }), { target: { files: [original] } })
    expect(data.onRetry).toHaveBeenCalledExactlyOnceWith(image.id, original)
    expect(data.onAdd).not.toHaveBeenCalled()
  })

  it('previews only confirmed image references in the shared lightbox', () => {
    render(<ForumImages images={[image, { ...image, id: 'unavailable', name: '暂不可预览', previewUrl: null }]} t={t} />)
    expect(screen.getAllByRole('img')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '预览图片.png' }))
    expect(screen.getByRole('dialog', { name: zh.imagePreview })).toBeTruthy()
    expect(within(screen.getByRole('dialog')).getByRole('img', { name: image.name }).getAttribute('src')).toBe(image.previewUrl)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('暂不可预览')).toBeTruthy()
  })

  it('uses only verified selection rules and emits the original files without submitting a surrounding form', () => {
    const data = media(), submit = vi.fn()
    const view = render(<form onSubmit={submit}><ForumImageComposer media={data} disabled={false} t={t} /></form>)
    const input = screen.getByLabelText(zh.forumAddImages, { selector: 'input' })
    const file = new File(['PNG'], '原图.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(data.onAdd).toHaveBeenCalledExactlyOnceWith([file])
    expect(input.getAttribute('accept')).toBe('image/png,image/jpeg')
    expect(submit).not.toHaveBeenCalled()
    view.rerender(<form onSubmit={submit}><ForumImageComposer media={{ ...data, maxBytes: null }} disabled={false} t={t} /></form>)
    expect(screen.queryByRole('button', { name: zh.forumAddImages })).toBeNull()
    expect(screen.queryByLabelText(zh.forumAddImages, { selector: 'input' })).toBeNull()
  })

  it('keeps failed and uploading images visible with exact explicit retry/remove and freezes edits for sealed submissions', () => {
    const data = media({ items: [{ ...image, status: 'failed', error: '请重新选择原文件' },
      { ...image, id: 'upload-in-progress', status: 'uploading', progressPercent: 41, previewUrl: null }] })
    const view = render(<ForumImageComposer media={data} disabled={false} t={t} />)
    expect(screen.getByRole('progressbar')).toHaveProperty('value', 41)
    expect(screen.getByText('请重新选择原文件')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retryAttachment }))
    expect(data.onRetry).toHaveBeenCalledExactlyOnceWith(image.id)
    fireEvent.click(screen.getAllByRole('button', { name: '移除图片.png' })[0]!)
    expect(data.onRemove).toHaveBeenCalledExactlyOnceWith(image.id)
    view.rerender(<ForumImageComposer media={data} disabled t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.retryAttachment }))
    fireEvent.click(screen.getAllByRole('button', { name: '移除图片.png' })[0]!)
    expect(data.onRetry).toHaveBeenCalledOnce()
    expect(data.onRemove).toHaveBeenCalledOnce()
    expect(screen.getByText('请重新选择原文件')).toBeTruthy()
  })

  it('reselects an original file for the same upload identity instead of creating a new selection', () => {
    const data = media({ items: [{ ...image, status: 'failed', requiresFile: true }] })
    render(<ForumImageComposer media={data} disabled={false} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.retryAttachment }))
    expect(data.onRetry).not.toHaveBeenCalled()
    const file = new File(['original PNG'], '图片.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(zh.forumChooseOriginalImage, { selector: 'input' }), { target: { files: [file] } })
    expect(data.onRetry).toHaveBeenCalledExactlyOnceWith(image.id, file)
    expect(data.onAdd).not.toHaveBeenCalled()
  })

  it('permits image-only publication only when explicitly supported and prevents submission until all original uploads are ready', () => {
    const p = props({ postComposerOpen: true, postDraft: { title: '纯图片帖子', body: '' }, postMedia: media({ items: [image] }) })
    const view = render(<ForumCenter {...p} />)
    const input = screen.getByRole('textbox', { name: zh.forumPostBody })
    fireEvent.submit(input.closest('form')!)
    expect(p.onSubmitPost).toHaveBeenCalledOnce()
    view.rerender(<ForumCenter {...p} postMedia={media({ items: [{ ...image, status: 'uploading' }] })} />)
    expect(screen.getByRole('button', { name: zh.forumPublish })).toHaveProperty('disabled', true)
    fireEvent.submit(input.closest('form')!)
    expect(p.onSubmitPost).toHaveBeenCalledOnce()
    expect(screen.getByText(zh.forumMediaPending)).toBeTruthy()
    view.rerender(<ForumCenter {...p} postMedia={media({ items: [image], allowImageOnly: false })} />)
    fireEvent.submit(input.closest('form')!)
    expect(p.onSubmitPost).toHaveBeenCalledOnce()
  })
})

describe('forum history and targeted replies', () => {
  it('renders a supplied server comment collection and opens its exact post and comment without using the public feed', () => {
    const p = props({ accountControls: { scope: 'comments', scopes: ['all', 'mine', 'comments'], onScopeChange: vi.fn() },
      onOpenHistoryComment: vi.fn() })
    const view = { ...p.view, list: { ...p.view.list, posts: [detail({ title: '不属于我的评论列表' })], comments: [
      { id: 'my-comment', postId: 'post-original', postTitle: '评论对应的帖子', body: '已发布评论', createdAt: '', authorName: '云间', images: [image] },
    ] } }
    render(<ForumCenter {...p} view={view} />)
    expect(screen.queryByText('不属于我的评论列表')).toBeNull()
    expect(screen.getByText('已发布评论')).toBeTruthy()
    expect(screen.getByRole('img', { name: image.name })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看帖子：评论对应的帖子' }))
    expect(p.onOpenHistoryComment).toHaveBeenCalledExactlyOnceWith('post-original', 'my-comment')
    expect(p.onOpenPost).not.toHaveBeenCalled()
    expect(p.onSubmitReply).not.toHaveBeenCalled()
  })

  it('selects a specific reply without overwriting a controlled draft and cancels only the parent-owned recipient', () => {
    const post = detail({ replies: [{ id: 'reply-one', authorName: '小林', body: '先整理字段', createdAt: '' }] })
    const p = props({ view: { ...props().view, detail: { postId: post.id, post, status: 'ready', error: null } },
      replyDraft: '保留原回复内容', onSelectReply: vi.fn(), onCancelReply: vi.fn() })
    const view = render(<ForumCenter {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '回复小林' }))
    expect(p.onSelectReply).toHaveBeenCalledExactlyOnceWith('reply-one')
    expect(p.onChangeReply).not.toHaveBeenCalled()
    expect(p.onSubmitReply).not.toHaveBeenCalled()
    view.rerender(<ForumCenter {...p} replyTarget={{ id: 'reply-one', authorName: '小林', excerpt: '先整理字段' }} />)
    const input = screen.getByRole('textbox', { name: zh.forumReplyBody })
    expect(input).toHaveProperty('value', '保留原回复内容')
    fireEvent.click(screen.getByRole('button', { name: zh.forumCancelReply }))
    expect(p.onCancelReply).toHaveBeenCalledOnce()
    expect(input).toHaveProperty('value', '保留原回复内容')
    view.rerender(<ForumCenter {...p} replyLocked replyTarget={{ id: 'reply-one', authorName: '小林', excerpt: '先整理字段' }} />)
    fireEvent.click(screen.getByRole('button', { name: '回复小林' }))
    fireEvent.click(screen.getByRole('button', { name: zh.forumCancelReply }))
    expect(p.onSelectReply).toHaveBeenCalledOnce()
    expect(p.onCancelReply).toHaveBeenCalledOnce()
  })

  it('highlights only the requested confirmed comment and preserves retained images when interaction is disabled', () => {
    const post = detail({ images: [image], replies: [{ id: 'reply-one', authorName: '小林', body: '已确认回复', createdAt: '', images: [image] }] })
    const p = props({ view: { ...props().view, availability: 'disabled', detail: { postId: post.id, post, status: 'ready', error: null } },
      highlightedReplyId: 'reply-one', onSelectReply: vi.fn() })
    render(<ForumCenter {...p} />)
    const reply = screen.getByText('已确认回复').closest('article')!
    expect(document.activeElement).toBe(reply)
    expect(screen.getAllByRole('img', { name: image.name })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '回复小林' }))
    expect(p.onSelectReply).not.toHaveBeenCalled()
    expect(p.onSubmitReply).not.toHaveBeenCalled()
  })
})
