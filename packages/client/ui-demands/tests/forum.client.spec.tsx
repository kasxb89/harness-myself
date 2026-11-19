// @vitest-environment jsdom
/** Pure forum views retain controlled drafts and recover only the original parent-owned operation. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.ts'
import { ForumCenter } from '../src/client/ForumCenter.tsx'
import type { ForumCenterProps, ForumPostDetail, ForumPostSummary } from '../src/client/forum-view.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Geometry belongs to the browser lane. */ }
    unobserve(): void { /* No geometry subscription in jsdom. */ }
    disconnect(): void { /* No retained observer. */ }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const translations: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, params) => (translations.get(key) ?? key).replace(/\{(\w+)\}/gu,
  (placeholder: string, name: string) => params !== undefined && name in params ? String(params[name]) : placeholder)

function summary(patch: Partial<ForumPostSummary> = {}): ForumPostSummary {
  return { id: 'post-1', title: '分享工作流程', excerpt: '来自真实帖子正文的摘要', authorName: '真实作者', createdAt: '2026-11-19T02:00:00Z',
    likeCount: null, replyCount: null, ...patch }
}

function detail(patch: Partial<ForumPostDetail> = {}): ForumPostDetail {
  return { ...summary(), body: '这是已确认的帖子正文', replies: [], canReply: true, replyReason: null,
    hasMoreReplies: false, loadingMoreReplies: false, liked: false, canLike: true, likeOperation: { state: 'idle' }, ...patch }
}

function forumProps(): ForumCenterProps {
  return {
    view: { availability: 'ready', reason: null, accountName: '当前账号', canCreate: true,
      list: { posts: [], status: 'ready', error: null, hasMore: false, loadingMore: false },
      detail: { postId: null, post: null, status: 'ready', error: null } },
    postDraft: { title: '', body: '' }, replyDraft: '', postLocked: false, replyLocked: false,
    postOperation: { state: 'idle' }, replyOperation: { state: 'idle' }, t,
    postComposerOpen: false, onOpenPostComposer: vi.fn(), onClosePostComposer: vi.fn(),
    onOpenPost: vi.fn(), onBack: vi.fn(), onRefresh: vi.fn(), onLoadMore: vi.fn(), onLoadMoreReplies: vi.fn(),
    onStartPost: vi.fn(), onChangePost: vi.fn(), onSubmitPost: vi.fn(), onCheckPost: vi.fn(), onChangeReply: vi.fn(),
    onSubmitReply: vi.fn(), onCheckReply: vi.fn(), onToggleLike: vi.fn(), onCheckLike: vi.fn(),
  }
}

function withDetail(props: ForumCenterProps, post: ForumPostDetail): ForumCenterProps {
  return { ...props, view: { ...props.view, detail: { postId: post.id, post, status: 'ready', error: null } } }
}

describe('pure forum center', () => {
  it('shows a real empty state and keeps two same-title posts distinct without invented counts', () => {
    const props = forumProps()
    const view = render(<ForumCenter {...props} />)
    expect(screen.getByText(zh.forumEmpty)).toBeTruthy()
    expect(screen.queryByRole('list', { name: zh.forumPostList })).toBeNull()
    const first = summary(), second = summary({ id: 'post-2', authorName: '另一位作者', likeCount: 3, replyCount: 0 })
    view.rerender(<ForumCenter {...props} view={{ ...props.view,
      list: { ...props.view.list, posts: [first, second] } }} />)
    const rows = within(screen.getByRole('list', { name: zh.forumPostList })).getAllByRole('article')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).queryByText(/赞|回复/u)).toBeNull()
    expect(within(rows[1]!).getByText('3 赞')).toBeTruthy()
    expect(within(rows[1]!).getByText('0 回复')).toBeTruthy()
    fireEvent.click(within(rows[1]!).getByRole('button'))
    expect(props.onOpenPost).toHaveBeenCalledExactlyOnceWith('post-2')
  })

  it('keeps loaded posts during query errors and disables repeated pagination while loading', () => {
    const props = forumProps()
    const view = render(<ForumCenter {...props} view={{ ...props.view,
      list: { posts: [summary()], status: 'error', error: '读取失败，内容仍保留', hasMore: true, loadingMore: false } }} />)
    expect(screen.getByRole('heading', { name: summary().title })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('读取失败，内容仍保留')
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    fireEvent.click(screen.getByRole('button', { name: zh.forumLoadMore }))
    expect(props.onRefresh).toHaveBeenCalledOnce()
    expect(props.onLoadMore).toHaveBeenCalledOnce()
    view.rerender(<ForumCenter {...props} view={{ ...props.view,
      list: { posts: [summary()], status: 'loading', error: null, hasMore: true, loadingMore: true } }} />)
    expect(screen.getByRole('button', { name: zh.forumLoadingMore })).toHaveProperty('disabled', true)
    expect(screen.getByRole('heading', { name: summary().title })).toBeTruthy()
  })

  it('opens a text note over its retained feed and returns keyboard focus without changing a draft', () => {
    const props = forumProps(), item = summary({ excerpt: '<img src="unapproved">\n只展示真实文字' })
    const base = { ...props, view: { ...props.view, list: { ...props.view.list, posts: [item] } } }
    const view = render(<ForumCenter {...base} />)
    expect(screen.getByText(/<img src="unapproved">/u)).toBeTruthy()
    const open = screen.getByRole('button', { name: zh.forumOpenPost.replace('{title}', item.title) })
    open.focus()
    fireEvent.click(open)
    expect(props.onOpenPost).toHaveBeenCalledExactlyOnceWith(item.id)
    view.rerender(<ForumCenter {...withDetail(base, detail())} replyDraft="尚未发送的回复" />)
    const dialog = screen.getByRole('dialog', { name: item.title })
    expect(within(dialog).getByRole('heading', { name: item.title })).toBeTruthy()
    expect(screen.getByRole('list', { name: zh.forumPostList }).contains(open)).toBe(true)
    expect(within(dialog).getByRole('textbox', { name: zh.forumReplyBody })).toHaveProperty('value', '尚未发送的回复')
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onBack).toHaveBeenCalledOnce()
    view.rerender(<ForumCenter {...base} replyDraft="尚未发送的回复" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(open)
    expect(props.onSubmitReply).not.toHaveBeenCalled()
    expect(props.onSubmitPost).not.toHaveBeenCalled()
    expect(props.onChangeReply).not.toHaveBeenCalled()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('distinguishes loading, disabled and sign-in states without showing fabricated posts', () => {
    const props = forumProps()
    const view = render(<ForumCenter {...props} view={{ ...props.view, availability: 'loading',
      list: { ...props.view.list, status: 'loading' } }} />)
    expect(screen.getByRole('status', { name: zh.loading })).toBeTruthy()
    expect(screen.queryByText(zh.forumEmpty)).toBeNull()
    view.rerender(<ForumCenter {...props} view={{ ...props.view, availability: 'disabled', canCreate: false }} />)
    expect(screen.getByRole('heading', { name: zh.forumDisabled })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.forumNewPost })).toHaveProperty('disabled', true)
    view.rerender(<ForumCenter {...props} view={{ ...props.view, availability: 'login-required', canCreate: false }} />)
    expect(screen.getByRole('heading', { name: zh.forumSignIn })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('keeps title and body controlled, retains the draft on close, and submits only complete fields', () => {
    const props = forumProps()
    const view = render(<ForumCenter {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumNewPost }))
    expect(props.onStartPost).toHaveBeenCalledOnce()
    expect(props.onOpenPostComposer).toHaveBeenCalledOnce()
    expect(vi.mocked(props.onStartPost).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(props.onOpenPostComposer).mock.invocationCallOrder[0]!)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<ForumCenter {...props} postComposerOpen />)
    let dialog = screen.getByRole('dialog', { name: zh.forumNewPost })
    expect(within(dialog).getByText('以 当前账号 的身份发帖')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: zh.forumPublish })).toHaveProperty('disabled', true)
    fireEvent.change(within(dialog).getByRole('textbox', { name: zh.forumPostTitle }), { target: { value: '草稿标题' } })
    expect(props.onChangePost).toHaveBeenCalledExactlyOnceWith({ title: '草稿标题' })
    expect(within(dialog).getByRole('textbox', { name: zh.forumPostTitle })).toHaveProperty('value', '')
    view.rerender(<ForumCenter {...props} postComposerOpen postDraft={{ title: '草稿标题', body: '尚未发布的正文' }} />)
    fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
    expect(props.onClosePostComposer).toHaveBeenCalledOnce()
    view.rerender(<ForumCenter {...props} postDraft={{ title: '草稿标题', body: '尚未发布的正文' }} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(props.onSubmitPost).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.forumContinuePost }))
    expect(props.onStartPost).toHaveBeenCalledOnce()
    view.rerender(<ForumCenter {...props} postComposerOpen postDraft={{ title: '草稿标题', body: '尚未发布的正文' }} />)
    dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('textbox', { name: zh.forumPostBody })).toHaveProperty('value', '尚未发布的正文')
    fireEvent.click(within(dialog).getByRole('button', { name: zh.forumPublish }))
    expect(props.onSubmitPost).toHaveBeenCalledOnce()
  })

  it('locks uncertain and sealed failed publication to its original recovery callback', () => {
    const props = { ...forumProps(), postDraft: { title: '原提交标题', body: '原提交内容' } }
    const view = render(<ForumCenter {...props} postOperation={{ state: 'unknown', checking: false }} />)
    expect(screen.getByText(zh.forumOperationUnknown)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.forumCheckOriginal }))
    expect(props.onCheckPost).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh.forumContinuePost }))
    view.rerender(<ForumCenter {...props} postComposerOpen postOperation={{ state: 'unknown', checking: false }} />)
    const dialog = screen.getByRole('dialog')
    const title = within(dialog).getByRole('textbox', { name: zh.forumPostTitle })
    expect(title).toHaveProperty('disabled', true)
    fireEvent.change(title, { target: { value: '不能替换原内容' } })
    fireEvent.submit(title.closest('form')!)
    expect(props.onChangePost).not.toHaveBeenCalled()
    expect(props.onSubmitPost).not.toHaveBeenCalled()
    view.rerender(<ForumCenter {...props} postComposerOpen postOperation={{ state: 'failed', message: '原请求失败', recoverable: true }} />)
    expect(within(dialog).getByRole('alert').textContent).toBe('原请求失败')
    expect(within(dialog).getByRole('textbox', { name: zh.forumPostTitle })).toHaveProperty('disabled', true)
    fireEvent.click(within(dialog).getByRole('button', { name: zh.forumRetryOriginal }))
    expect(props.onCheckPost).toHaveBeenCalledTimes(2)
    expect(props.onSubmitPost).not.toHaveBeenCalled()
    expect(props.onStartPost).not.toHaveBeenCalled()
  })

  it('starts a separate post explicitly while resuming an uncertain draft never creates a new scope', () => {
    const props = { ...forumProps(), postDraft: { title: '原帖未确认', body: '原帖内容' } }
    const view = render(<ForumCenter {...props} postOperation={{ state: 'unknown', checking: false }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumContinuePost }))
    expect(props.onStartPost).not.toHaveBeenCalled()
    expect(props.onOpenPostComposer).toHaveBeenCalledOnce()
    view.rerender(<ForumCenter {...props} postComposerOpen postOperation={{ state: 'unknown', checking: false }} />)
    expect(screen.getByRole('textbox', { name: zh.forumPostTitle })).toHaveProperty('value', '原帖未确认')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.cancel }))
    expect(props.onClosePostComposer).toHaveBeenCalledOnce()
    view.rerender(<ForumCenter {...props} postOperation={{ state: 'unknown', checking: false }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumNewPost }))
    expect(props.onStartPost).toHaveBeenCalledOnce()
    expect(props.onOpenPostComposer).toHaveBeenCalledTimes(2)
    view.rerender(<ForumCenter {...props} postComposerOpen postDraft={{ title: '', body: '' }} postOperation={{ state: 'idle' }} />)
    expect(screen.getByRole('textbox', { name: zh.forumPostTitle })).toHaveProperty('value', '')
    expect(screen.getByRole('textbox', { name: zh.forumPostTitle })).toHaveProperty('disabled', false)
    expect(props.onSubmitPost).not.toHaveBeenCalled()
    expect(props.onCheckPost).not.toHaveBeenCalled()
  })

  it('renders receipt authors and post text literally without interpreting media or HTML', () => {
    const props = forumProps()
    const post = detail({ body: '<img src="https://example.invalid/unapproved">\n这是文字，不是媒体',
      replies: [{ id: 'reply-1', authorName: '回帖者原名', createdAt: '', body: '这是一条真实回复' }] })
    render(<ForumCenter {...withDetail(props, post)} />)
    expect(screen.getByText('真实作者')).toBeTruthy()
    expect(screen.getByText('回帖者原名')).toBeTruthy()
    expect(screen.getByText('这是一条真实回复')).toBeTruthy()
    expect(screen.getByText(/<img src="https:\/\/example.invalid\/unapproved">/u)).toBeTruthy()
    expect(screen.getByRole('dialog').querySelectorAll('img,video,a')).toHaveLength(0)
  })

  it('keeps likes controlled and checks an uncertain toggle with the exact post id', () => {
    const props = forumProps(), post = detail({ id: 'second-post', likeCount: 4 })
    const view = render(<ForumCenter {...withDetail(props, post)} />)
    let like = screen.getByRole('button', { name: '点赞 4' })
    expect(like.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(like)
    expect(props.onToggleLike).toHaveBeenCalledExactlyOnceWith('second-post')
    expect(like.getAttribute('aria-pressed')).toBe('false')
    view.rerender(<ForumCenter {...withDetail(props, { ...post, liked: true, likeOperation: { state: 'unknown', checking: false } })} />)
    like = screen.getByRole('button', { name: '已点赞 4' })
    expect(like.getAttribute('aria-pressed')).toBe('true')
    expect(like).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: zh.forumCheckOriginal }))
    expect(props.onCheckLike).toHaveBeenCalledExactlyOnceWith('second-post')
    expect(props.onToggleLike).toHaveBeenCalledTimes(1)
  })

  it('retains controlled replies and obeys permission and original-operation locks', () => {
    const props = forumProps(), post = detail()
    const view = render(<ForumCenter {...withDetail(props, post)} replyDraft="保留中的回复" />)
    const input = screen.getByRole('textbox', { name: zh.forumReplyBody })
    fireEvent.change(input, { target: { value: '请求父层修改' } })
    expect(props.onChangeReply).toHaveBeenCalledExactlyOnceWith('请求父层修改')
    expect(input).toHaveProperty('value', '保留中的回复')
    fireEvent.click(screen.getByRole('button', { name: zh.forumSendReply }))
    expect(props.onSubmitReply).toHaveBeenCalledOnce()
    view.rerender(<ForumCenter {...withDetail(props, { ...post, canReply: false, replyReason: '此帖暂不可回复' })}
      replyDraft="保留中的回复" />)
    expect(input).toHaveProperty('disabled', true)
    expect(input).toHaveProperty('value', '保留中的回复')
    expect(screen.getByText('此帖暂不可回复')).toBeTruthy()
    fireEvent.submit(input.closest('form')!)
    expect(props.onSubmitReply).toHaveBeenCalledTimes(1)
    view.rerender(<ForumCenter {...withDetail(props, post)} replyDraft="保留中的回复"
      replyOperation={{ state: 'unknown', checking: true }} />)
    expect(screen.getByRole('button', { name: zh.forumChecking })).toHaveProperty('disabled', true)
    expect(input).toHaveProperty('disabled', true)
    view.rerender(<ForumCenter {...withDetail(props, post)} replyDraft="保留中的回复"
      replyOperation={{ state: 'failed', message: '回复失败', recoverable: true }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumRetryOriginal }))
    expect(props.onCheckReply).toHaveBeenCalledOnce()
    expect(props.onSubmitReply).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(props.onBack).toHaveBeenCalledOnce()
  })
})
