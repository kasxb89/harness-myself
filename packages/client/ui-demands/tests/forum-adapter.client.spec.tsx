// @vitest-environment jsdom
/** Public forum projections and exact recovery identities stay separate from private request state. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForumWorkspace } from '../src/client/ForumWorkspace.tsx'
import { forumCenterView, forumIssueText, forumOperationView } from '../src/client/forum-adapter.ts'
import type { ForumFace, ForumPendingView, ForumPostDraft, ForumState } from '../src/client/forum-types.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'
import { forumExampleConfig, forumExamplePost, forumExampleComment } from './forum-model-fixtures.client.ts'

afterEach(cleanup)
const labels: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, values) => (labels.get(key) ?? key).replace(/\{(\w+)\}/gu, (raw: string, key: string) =>
  values !== undefined && key in values ? String(values[key]) : raw)
function state(patch: Partial<ForumState> = {}): ForumState {
  const empty = { items: [], status: 'ready' as const, hasMore: false, loadingMore: false, error: null }
  return { accountId: '1', availability: 'ready', config: forumExampleConfig(), error: null, posts: empty,
    selectedPostId: null, selectedPost: null, selectedPostStatus: 'ready', selectedPostError: null,
    comments: empty, commentDraft: '', activePostDraftScope: null, postDrafts: [], pending: [], ...patch }
}
function draft(scopeKey: string, patch: Partial<ForumPostDraft> = {}): ForumPostDraft {
  return { scopeKey, title: '同名草稿', body: '原内容', postId: null, createdAt: 1,
    sending: false, locked: true, error: null, ...patch }
}
function pending(scopeKey: string, operationId: string): ForumPendingView {
  return { scopeKey, operationId, postId: null, kind: 'post', title: '同名草稿', body: '原内容',
    liked: null, inflight: false, error: { code: 'FORUM_TIMEOUT', unknown: true, operationId } }
}
function commands(): Omit<ForumFace, 'hooks'> {
  return { refresh: vi.fn(), loadMorePosts: vi.fn(), openPost: vi.fn(), closePost: vi.fn(), startPost: vi.fn(),
    openPostDraft: vi.fn(), updatePostDraft: vi.fn(), publishPost: vi.fn(), updateCommentDraft: vi.fn(),
    sendComment: vi.fn(), loadMoreComments: vi.fn(), setLiked: vi.fn(), retryOperation: vi.fn() }
}

describe('forum presentation', () => {
  it('retains real authors and counts, rejects stale cross-post replies and gates writes on a verified detail', () => {
    const post = forumExamplePost({ like_count: 0, comment_count: 1 })
    const snapshot = state({ selectedPostId: post.id, selectedPost: post,
      comments: { items: [forumExampleComment(), forumExampleComment({ id: 'other-comment', post_id: 'another-post', body: '不得串贴' })],
        status: 'ready', error: null, hasMore: false, loadingMore: false } })
    const view = forumCenterView(snapshot, t)
    expect(view.detail.post?.authorName).toBe(post.author.display_name)
    expect(view.detail.post?.excerpt).toBe(post.body)
    expect(view.detail.post?.likeCount).toBe(0)
    expect(view.detail.post?.replies.map(reply => reply.body)).toEqual([forumExampleComment().body])
    expect(view.detail.post?.canReply).toBe(true)
    const stale = forumCenterView({ ...snapshot, selectedPostStatus: 'error' }, t)
    expect(stale.detail.post?.body).toBe(post.body)
    expect(stale.detail.post?.canReply).toBe(false)
    expect(stale.detail.post?.canLike).toBe(false)
  })

  it('distinguishes network, timeout and closed publication while preserving uncertain outcomes', () => {
    expect(forumIssueText({ code: 'FORUM_NETWORK', unknown: false, operationId: null }, t)).toBe(zh.forumIssueNetwork)
    expect(forumIssueText({ code: 'FORUM_CLOSED', unknown: false, operationId: null }, t)).toBe(zh.forumIssueClosed)
    const operation = forumOperationView(pending('original', 'original-operation'), t)
    expect(operation).toMatchObject({ state: 'unknown', checking: false })
    expect('message' in operation && operation.message).toContain(zh.forumIssueTimeout)
    const disabled = forumCenterView(state({ availability: 'disabled', config: forumExampleConfig(false) }), t)
    expect(disabled.canCreate).toBe(false)
  })
})

describe('forum workspace recovery', () => {
  it('shows a rejected local post validation without locking or inventing a pending server submission', () => {
    const actions = commands(), invalid = draft('invalid-draft', { locked: false, body: '字'.repeat(20_001),
      error: { code: 'FORUM_INVALID_INPUT', unknown: false, operationId: null } })
    render(<ForumWorkspace state={state({ activePostDraftScope: invalid.scopeKey, postDrafts: [invalid] })} commands={actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumContinuePost }))
    expect(screen.getByRole('alert').textContent).toContain(zh.forumIssueInvalid)
    expect(screen.getByRole('textbox', { name: zh.forumPostBody })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('button', { name: zh.forumCheckOriginal })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: zh.forumPostBody }), { target: { value: '修改后的正文' } })
    expect(actions.updatePostDraft).toHaveBeenCalledExactlyOnceWith(invalid.scopeKey, { body: '修改后的正文' })
    expect(actions.retryOperation).not.toHaveBeenCalled()
  })

  it('opens a retained draft in one click and confirms its original key rather than an identical-title draft', () => {
    const actions = commands(), a = draft('scope-a'), b = draft('scope-b')
    const base = state({ activePostDraftScope: b.scopeKey, postDrafts: [a, b],
      pending: [pending(a.scopeKey, 'operation-a'), pending(b.scopeKey, 'operation-b')] })
    const view = render(<ForumWorkspace state={base} commands={actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumResumeNamed.replace('{title}', a.title) }))
    expect(actions.openPostDraft).toHaveBeenCalledExactlyOnceWith(a.scopeKey)
    view.rerender(<ForumWorkspace state={{ ...base, activePostDraftScope: a.scopeKey }} commands={actions} t={t} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.forumCheckOriginal }))
    expect(actions.retryOperation).toHaveBeenCalledExactlyOnceWith('operation-a')
    expect(actions.startPost).not.toHaveBeenCalled()
    expect(actions.publishPost).not.toHaveBeenCalled()
  })

  it('closes only the opened draft after its exact receipt and leaves another draft open', () => {
    const actions = commands(), a = draft('scope-a'), b = draft('scope-b', { locked: false, title: '另一篇帖子' })
    const base = state({ activePostDraftScope: b.scopeKey, postDrafts: [a, b] })
    const view = render(<ForumWorkspace state={base} commands={actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumContinuePost }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    view.rerender(<ForumWorkspace state={{ ...base, postDrafts: [{ ...a, postId: 'receipt-a' }, b] }} commands={actions} t={t} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: zh.forumPostTitle })).toHaveProperty('value', b.title)
    view.rerender(<ForumWorkspace state={{ ...base, activePostDraftScope: null,
      postDrafts: [{ ...a, postId: 'receipt-a' }, { ...b, postId: 'receipt-b' }] }} commands={actions} t={t} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actions.updatePostDraft).not.toHaveBeenCalled()
  })
})
