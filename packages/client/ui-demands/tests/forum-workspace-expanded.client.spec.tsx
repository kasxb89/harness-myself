// @vitest-environment jsdom
/** Extended forum views use actual account collections, uploads and persisted profile receipts. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForumWorkspace } from '../src/client/ForumWorkspace.tsx'
import { forumAccountTools, forumCenterView, forumImageComposer } from '../src/client/forum-adapter.ts'
import type { ForumActivityState, ForumAttachment, ForumFace, ForumNotification, ForumState, ForumUploadView } from '../src/client/forum-types.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'
import { forumExampleConfig, forumExamplePost, forumExampleComment } from './forum-model-fixtures.client.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Browser acceptance checks geometry. */ }
    unobserve(): void { /* No geometry subscription in jsdom. */ }
    disconnect(): void { /* No retained observer. */ }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const labels: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, values) => (labels.get(key) ?? key).replace(/\{(\w+)\}/gu, (raw: string, name: string) =>
  values !== undefined && name in values ? String(values[name]) : raw)
function page<T = never>(items: readonly T[] = []) {
  return { items, status: 'ready' as const, error: null, hasMore: false, loadingMore: false }
}
const attachment: ForumAttachment = { id: 'forum-image', name: 'forum-image.png', kind: 'image', mime_type: 'image/png',
  size_bytes: 24, sha256: 'a'.repeat(64), status: 'ready', preview_path: '/attachments/forum-image/link', download_path: '/attachments/forum-image/link' }
function activity(patch: Partial<ForumActivityState> = {}): ForumActivityState {
  return { scope: 'all', myPosts: page(), myComments: page(),
    profile: { value: { id: 451129010, display_name: '云间', revision: 1 }, status: 'ready', saving: false, error: null },
    notifications: { ...page(), unreadCount: null, readingIds: [] }, highlightedCommentId: null, ...patch }
}
function state(patch: Partial<ForumState> = {}): ForumState {
  return { accountId: '451129010', availability: 'ready', config: { ...forumExampleConfig(), capabilities: {
    immediate_publish: true, likes: true, comments: true, image_uploads: true, my_activity: true,
    comment_replies: true, notifications: true, forum_profile: true, receipt_lookup: true },
  upload_rules: { max_attachments: 8, max_image_bytes: 20_971_520, chunk_bytes: 4_194_304,
    upload_ttl_seconds: 86_400, allowed_mime_types: ['image/png', 'image/jpeg'] } },
  error: null, posts: page(), selectedPostId: null, selectedPost: null, selectedPostStatus: 'ready', selectedPostError: null,
  comments: page(), commentDraft: '', activePostDraftScope: null, postDrafts: [], pending: [], activity: activity(), uploads: [], replyTarget: null, ...patch }
}
function commands(): Omit<ForumFace, 'hooks'> {
  return { refresh: vi.fn(), loadMorePosts: vi.fn(), openPost: vi.fn(), closePost: vi.fn(), startPost: vi.fn(),
    openPostDraft: vi.fn(), updatePostDraft: vi.fn(), publishPost: vi.fn(), updateCommentDraft: vi.fn(), sendComment: vi.fn(),
    loadMoreComments: vi.fn(), setLiked: vi.fn(), retryOperation: vi.fn(), setFeedScope: vi.fn(), loadMoreOwnPosts: vi.fn(),
    loadMoreOwnComments: vi.fn(), refreshNotifications: vi.fn(), loadMoreNotifications: vi.fn(), markNotificationsRead: vi.fn(),
    openNotification: vi.fn(), openHistoryComment: vi.fn(), updateNickname: vi.fn(), setReplyTarget: vi.fn(),
    addAttachments: vi.fn(), retryAttachment: vi.fn(), removeAttachment: vi.fn(),
    contentUrl: vi.fn(id => `/credits/api/forum/attachments/${id}/content`) }
}

describe('extended forum projection', () => {
  it('uses the server-owned my-posts and my-comments pages, including their own pagination and errors', () => {
    const post = forumExamplePost({ id: 'mine-original', attachments: [attachment] })
    const comment = forumExampleComment({ id: 'mine-comment', post_title: '原帖子', attachments: [attachment] })
    const snapshot = state({ posts: page([forumExamplePost({ id: 'public-feed' })]),
      activity: activity({ scope: 'mine', myPosts: { ...page([post]), hasMore: true } }) })
    const actions = commands(), mine = forumCenterView(snapshot, t, actions.contentUrl)
    expect(mine.list.posts.map(item => item.id)).toEqual(['mine-original'])
    expect(mine.list.hasMore).toBe(true)
    expect(mine.list.posts[0]?.images?.[0]?.previewUrl).toBe('/credits/api/forum/attachments/forum-image/content')
    const history = forumCenterView({ ...snapshot, activity: activity({ scope: 'comments', myComments: {
      ...page([comment]), status: 'error', error: { code: 'FORUM_NETWORK', unknown: false, operationId: null }, hasMore: true } }) }, t, actions.contentUrl)
    expect(history.list.posts).toEqual([])
    expect(history.list.kind).toBe('comments')
    expect(history.list.comments?.map(item => [item.id, item.postId, item.postTitle])).toEqual([[comment.id, comment.post_id, '原帖子']])
    expect(history.list.error).toBe(zh.forumIssueNetwork)
    expect(history.list.hasMore).toBe(true)
    expect(JSON.stringify(history)).not.toContain('/attachments/forum-image/link')
  })

  it('gates old-backend tools and never derives notification counts or public identities from account data', () => {
    const actions = commands(), old = state({ config: forumExampleConfig() })
    expect(forumAccountTools(old, actions, t)).toBeUndefined()
    expect(forumImageComposer(old, actions, { kind: 'post', scopeKey: 'draft' }, t)).toBeUndefined()
    const snapshot = state({ activity: activity({ notifications: { ...page<ForumNotification>([{ id: 'notice-original', type: 'reply', post_id: 'post-original',
      comment_id: 'comment-original', actor: { id: 451129011, display_name: '+60 12-345-6789' }, post_title: '原帖子', created_at: 1, read_at: 0 }]),
    unreadCount: 18, readingIds: [] } }) })
    const tools = forumAccountTools(snapshot, actions, t)!
    expect(tools.notifications?.unreadCount).toBe(18)
    expect(tools.notifications?.items[0]?.actorName).toBe(zh.forumMember)
    expect(JSON.stringify(tools)).not.toContain('+60 12-345-6789')
    expect(actions.openNotification).not.toHaveBeenCalled()
    expect(actions.markNotificationsRead).not.toHaveBeenCalled()
    tools.notifications?.onOpen('notice-original')
    expect(actions.openNotification).toHaveBeenCalledExactlyOnceWith('notice-original')
    tools.notifications?.onMarkRead?.('notice-original')
    expect(actions.markNotificationsRead).toHaveBeenCalledExactlyOnceWith(['notice-original'])
  })

  it('keeps upload targets and original operation IDs separate, including explicit unknown and reselected-file recovery', () => {
    const actions = commands()
    const rows: readonly ForumUploadView[] = [
      { operationId: 'post-upload', target: { kind: 'post', scopeKey: 'draft-original' }, name: '原图.png', mimeType: 'image/png',
        sizeBytes: 24, attachment: null, progress: 41, status: 'unknown', error: null },
      { operationId: 'comment-upload', target: { kind: 'comment', postId: 'post-original' }, name: '原评论图.png', mimeType: 'image/png',
        sizeBytes: 24, attachment: null, progress: 0, status: 'select-file', error: null },
    ]
    const snapshot = state({ uploads: rows })
    const postMedia = forumImageComposer(snapshot, actions, { kind: 'post', scopeKey: 'draft-original' }, t)!
    expect(postMedia.items.map(item => item.id)).toEqual(['post-upload'])
    expect(postMedia.items[0]?.retryLabel).toBe(zh.forumCheckUpload)
    postMedia.onRetry('post-upload')
    expect(actions.retryAttachment).toHaveBeenCalledExactlyOnceWith('post-upload', undefined)
    const commentMedia = forumImageComposer(snapshot, actions, { kind: 'comment', postId: 'post-original' }, t)!
    expect(commentMedia.items[0]?.requiresFile).toBe(true)
    const file = new File(['PNG'], '原评论图.png', { type: 'image/png' })
    commentMedia.onRetry('comment-upload', file)
    expect(actions.retryAttachment).toHaveBeenLastCalledWith('comment-upload', file)
    const retained = forumImageComposer({ ...snapshot, config: forumExampleConfig(false) }, actions, { kind: 'post', scopeKey: 'draft-original' }, t)!
    expect(retained.items).toHaveLength(1)
    expect(retained.canAdd).toBe(false)
    expect(retained.maxBytes).toBeNull()
    expect(actions.addAttachments).not.toHaveBeenCalled()
  })

  it('keeps a specific file mismatch visible during an uncertain upload and requests the original file for the same operation', () => {
    const actions = commands(), target = { kind: 'post' as const, scopeKey: 'draft-original' }
    const snapshot = state({ uploads: [{ operationId: 'original-mismatch', target, name: '原图.png', mimeType: 'image/png',
      sizeBytes: 24, attachment: null, progress: 0, status: 'unknown',
      error: { code: 'FORUM_UPLOAD_FILE_MISMATCH', unknown: true, operationId: 'original-mismatch' } }] })
    const view = forumImageComposer(snapshot, actions, target, t)!
    expect(view.items[0]?.error).toContain(zh.uploadFileMismatch)
    expect(view.items[0]?.error).toContain(zh.forumUploadUnknown)
    expect(view.items[0]?.requiresFile).toBe(true)
    expect(view.items[0]?.retryLabel).toBe(zh.forumChooseOriginalImage)
    expect(actions.retryAttachment).not.toHaveBeenCalled()
    expect(actions.addAttachments).not.toHaveBeenCalled()
  })
})

describe('extended forum workspace binding', () => {
  it('binds actual history, notification and specific reply commands without mutations on render', () => {
    const actions = commands(), post = forumExamplePost()
    const snapshot = state({ selectedPostId: post.id, selectedPost: post, comments: page([forumExampleComment()]),
      activity: activity({ notifications: { ...page<ForumNotification>([{ id: 'notice-original', type: 'reply', post_id: post.id,
        comment_id: forumExampleComment().id, actor: { id: 2, display_name: '小林' }, post_title: post.title, created_at: 1, read_at: 0 }]),
      unreadCount: 1, readingIds: [] } }) })
    const view = render(<ForumWorkspace state={{ ...snapshot, selectedPostId: null }} commands={actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumMyPosts }))
    expect(actions.setFeedScope).toHaveBeenCalledExactlyOnceWith('mine')
    fireEvent.click(screen.getByRole('button', { name: '消息，1 条未读' }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.forumNotificationOpen.replace('{title}', post.title) }))
    expect(actions.openNotification).toHaveBeenCalledExactlyOnceWith('notice-original')
    expect(actions.markNotificationsRead).not.toHaveBeenCalled()
    view.rerender(<ForumWorkspace state={snapshot} commands={actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumReplyTo.replace('{name}', forumExampleComment().author.display_name) }))
    expect(actions.setReplyTarget).toHaveBeenCalledExactlyOnceWith(post.id, forumExampleComment().id)
    expect(actions.sendComment).not.toHaveBeenCalled()
    expect(actions.publishPost).not.toHaveBeenCalled()
  })

  it('keeps the nickname as a local draft until the backend confirms the actual profile value', () => {
    const actions = commands(), snapshot = state()
    const view = render(<ForumWorkspace state={snapshot} commands={actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '云间' }))
    fireEvent.change(screen.getByRole('textbox', { name: zh.forumNicknameField }), { target: { value: '山野' } })
    fireEvent.click(screen.getByRole('button', { name: zh.forumNicknameSave }))
    expect(actions.updateNickname).toHaveBeenCalledExactlyOnceWith('山野')
    expect(screen.getByRole('dialog', { name: zh.forumNicknameTitle })).toBeTruthy()
    expect(screen.getByRole('button', { name: '云间' })).toBeTruthy()
    view.rerender(<ForumWorkspace state={{ ...snapshot, activity: activity({ profile: {
      ...snapshot.activity!.profile, saving: true } }) }} commands={actions} t={t} />)
    expect(screen.getByRole('button', { name: zh.forumNicknameSaving })).toHaveProperty('disabled', true)
    view.rerender(<ForumWorkspace state={{ ...snapshot, activity: activity({ profile: {
      ...snapshot.activity!.profile, value: { id: 451129010, display_name: '山野', revision: 2 } } }) }} commands={actions} t={t} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: '山野' })).toBeTruthy()
    expect(actions.updateNickname).toHaveBeenCalledOnce()
  })

  it('binds image selection to the exact post draft and preserves the original upload when the backend loses capability', () => {
    const actions = commands(), draft = { scopeKey: 'draft-original', title: '原帖标题', body: '', createdAt: 1,
      postId: null, sending: false, locked: false, error: null }
    const snapshot = state({ activePostDraftScope: draft.scopeKey, postDrafts: [draft], uploads: [{
      operationId: 'upload-original', target: { kind: 'post', scopeKey: draft.scopeKey }, name: attachment.name,
      mimeType: attachment.mime_type, sizeBytes: attachment.size_bytes, attachment, progress: 100, status: 'ready', error: null }] })
    const view = render(<ForumWorkspace state={snapshot} commands={actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumContinuePost }))
    const file = new File(['PNG'], '第二张图.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(zh.forumAddImages, { selector: 'input' }), { target: { files: [file] } })
    expect(actions.addAttachments).toHaveBeenCalledExactlyOnceWith({ kind: 'post', scopeKey: draft.scopeKey }, [file])
    expect(screen.getByRole('img', { name: attachment.name }).getAttribute('src')).toBe('/credits/api/forum/attachments/forum-image/content')
    view.rerender(<ForumWorkspace state={{ ...snapshot, availability: 'disabled', config: forumExampleConfig(false) }} commands={actions} t={t} />)
    expect(screen.getByRole('img', { name: attachment.name })).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.forumAddImages })).toBeNull()
    expect(screen.getByRole('button', { name: zh.forumPublish })).toHaveProperty('disabled', true)
    expect(actions.publishPost).not.toHaveBeenCalled()
  })

  it('offers explicit recovery for a failed profile read and closes account-owned editors on an account switch', () => {
    const actions = commands(), snapshot = state({ activity: activity({ profile: { value: null, status: 'error', saving: false,
      error: { code: 'FORUM_NETWORK', unknown: false, operationId: null } } }) })
    const view = render(<ForumWorkspace state={snapshot} commands={actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.forumNickname }))
    expect(screen.getByRole('textbox', { name: zh.forumNicknameField }).matches(':disabled')).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe(zh.forumIssueNetwork)
    fireEvent.click(screen.getByRole('button', { name: zh.forumReloadProfile }))
    expect(actions.refresh).toHaveBeenCalledOnce()
    expect(actions.updateNickname).not.toHaveBeenCalled()
    view.rerender(<ForumWorkspace state={state({ accountId: '451129011' })} commands={actions} t={t} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actions.updateNickname).not.toHaveBeenCalled()
  })

  it('preserves the nickname draft and requires an explicit profile check after an unknown save', () => {
    const actions = commands(), snapshot = state()
    const view = render(<ForumWorkspace state={snapshot} commands={actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '云间' }))
    fireEvent.change(screen.getByRole('textbox', { name: zh.forumNicknameField }), { target: { value: '保留的昵称草稿' } })
    fireEvent.click(screen.getByRole('button', { name: zh.forumNicknameSave }))
    expect(actions.updateNickname).toHaveBeenCalledOnce()
    view.rerender(<ForumWorkspace state={{ ...snapshot, activity: activity({ profile: { ...snapshot.activity!.profile,
      error: { code: 'FORUM_TIMEOUT', unknown: true, operationId: null } } }) }} commands={actions} t={t} />)
    expect(screen.getByRole('textbox', { name: zh.forumNicknameField })).toHaveProperty('value', '保留的昵称草稿')
    expect(screen.getByRole('alert').textContent).toContain(zh.forumOperationUnknown)
    expect(screen.getByRole('button', { name: zh.forumNicknameSave })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: zh.forumCheckProfile }))
    expect(actions.refresh).toHaveBeenCalledOnce()
    expect(actions.updateNickname).toHaveBeenCalledOnce()
  })
})
