// @vitest-environment jsdom
/** Public avatars use the current forum content reader without adding profile edits or uploads. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForumCenter } from '../src/client/ForumCenter.tsx'
import { forumCenterView } from '../src/client/forum-adapter.ts'
import { forumAuthor, forumConfig } from '../src/client/forum-wire.ts'
import { forumNotification, forumProfile } from '../src/client/forum-extended-wire.ts'
import { forumContentUrl } from '../src/client/forum-api.ts'
import type { ForumAvatar, ForumState } from '../src/client/forum-types.ts'
import type { ForumCenterProps, ForumCenterView } from '../src/client/forum-view.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { zh } from '../src/client/locales.ts'
import { forumExampleComment, forumExampleConfig, forumExamplePost } from './forum-model-fixtures.client.ts'

const avatar: ForumAvatar = { id: '33333333-3333-4333-8333-333333333333', kind: 'image', mime_type: 'image/png',
  size_bytes: 120, sha256: 'a'.repeat(64), expires_at: 100 }
const author = { id: 2, display_name: '云上记录', avatar }
const dictionary: ReadonlyMap<string, string> = new Map(Object.entries(zh))
const t: DemandTranslate = (key, values) => (dictionary.get(key) ?? key).replace(/\{(\w+)\}/gu,
  (raw: string, name: string) => values !== undefined && name in values ? String(values[name]) : raw)
const owner = { id: '1', owner: 'a'.repeat(64), epoch: 1 }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* Real geometry belongs to browser acceptance. */ }
    unobserve(): void { /* No retained observation. */ }
    disconnect(): void { /* No retained observation. */ }
  })
})
afterEach(() => { cleanup(); document.querySelector('base')?.remove(); vi.unstubAllGlobals() })

function state(avatars = true): ForumState {
  const post = forumExamplePost({ author }), comment = forumExampleComment({ author })
  const config = forumExampleConfig()
  return { accountId: owner.id, availability: 'ready', config: { ...config,
    capabilities: { ...config.capabilities, forum_profile_avatar_v1: avatars } }, error: null,
  posts: { items: [post], status: 'ready', error: null, hasMore: false, loadingMore: false },
  selectedPostId: post.id, selectedPost: post, selectedPostStatus: 'ready', selectedPostError: null,
  comments: { items: [comment], status: 'ready', error: null, hasMore: false, loadingMore: false },
  commentDraft: '', activePostDraftScope: null, postDrafts: [], pending: [] }
}
function props(view: ForumCenterView): ForumCenterProps {
  return { view, postDraft: { title: '', body: '' }, replyDraft: '', postLocked: false, replyLocked: false,
    postOperation: { state: 'idle' }, replyOperation: { state: 'idle' }, postComposerOpen: false, t,
    onOpenPostComposer: vi.fn(), onClosePostComposer: vi.fn(), onOpenPost: vi.fn(), onBack: vi.fn(), onRefresh: vi.fn(),
    onLoadMore: vi.fn(), onLoadMoreReplies: vi.fn(), onStartPost: vi.fn(), onChangePost: vi.fn(), onSubmitPost: vi.fn(),
    onCheckPost: vi.fn(), onChangeReply: vi.fn(), onSubmitReply: vi.fn(), onCheckReply: vi.fn(),
    onToggleLike: vi.fn(), onCheckLike: vi.fn() }
}

describe('negotiated forum author images', () => {
  it('retains optional avatar metadata in author, own profile and notification without signed URLs or private names', () => {
    const raw = { ...author, avatar: { ...avatar, url: 'https://private.invalid/?token=secret', name: 'private-customer.png', phone: 'private' } }
    expect(forumAuthor(raw)).toEqual(author)
    expect(forumProfile({ ...raw, revision: 3 })).toEqual({ ...author, revision: 3 })
    const post = forumExamplePost(), comment = forumExampleComment()
    expect(forumNotification({ id: '1', type: 'reply', post_id: post.id, comment_id: comment.id, actor: raw,
      post_title: post.title, created_at: 100, read_at: 0 }).actor).toEqual(author)
    expect(forumAuthor({ id: 451129010, display_name: '论坛用户451129010' }).display_name).toBe('论坛用户451129010')
    expect(forumAuthor({ id: 451129010, display_name: '+86 13800138000' }).display_name).toBe('')
    const config = forumExampleConfig()
    expect(forumConfig({ ...config, capabilities: { ...config.capabilities, forum_profile_avatar_v1: true } })
      .capabilities.forum_profile_avatar_v1).toBe(true)
    expect(forumConfig(config).capabilities.forum_profile_avatar_v1).toBeUndefined()
  })

  it('rejects malformed or non-image avatars without inventing a fallback attachment', () => {
    for (const value of [{ ...avatar, kind: 'video' }, { ...avatar, mime_type: 'image/svg+xml' }, { ...avatar, size_bytes: 0 },
      { ...avatar, size_bytes: 20 * 1024 * 1024 + 1 }, { ...avatar, sha256: 'bad' }, { ...avatar, expires_at: 0 },
      { ...avatar, id: 'not-a-uuid' }, null]) expect(() => forumAuthor({ ...author, avatar: value })).toThrow()
    expect(forumAuthor({ id: author.id, display_name: author.display_name })).not.toHaveProperty('avatar')
  })

  it('uses only the owner reader with the application mount once for list, detail and comment avatars', () => {
    const base = document.createElement('base'); base.href = 'https://app.invalid/preview/'; document.head.append(base)
    const url = vi.fn((id: string) => forumContentUrl(owner, id))
    const view = forumCenterView(state(), t, url), expected = forumContentUrl(owner, avatar.id)
    expect(view.list.posts[0]?.authorAvatarUrl).toBe(expected)
    expect(view.detail.post?.authorAvatarUrl).toBe(expected)
    expect(view.detail.post?.replies[0]?.authorAvatarUrl).toBe(expected)
    expect(expected.startsWith('/preview/credits/api/forum/attachments/')).toBe(true)
    expect(expected).not.toContain('/preview/preview/')
    expect(new URL(expected, base.href).searchParams.get('account_owner')).toBe(owner.owner)
    expect(url.mock.calls.every(([id]) => id === avatar.id)).toBe(true)
    expect(forumCenterView(state(), t, () => null).list.posts[0]?.authorAvatarUrl).toBeNull()
    const disabled = vi.fn(() => '/should-not-be-used')
    expect(forumCenterView(state(false), t, disabled).list.posts[0]).not.toHaveProperty('authorAvatarUrl')
    expect(disabled).not.toHaveBeenCalled()
  })

  it('renders actual avatars decoratively in feed and drawer, falls back after errors and resets when the source changes', () => {
    const view = forumCenterView(state(), t, id => forumContentUrl(owner, id)), callbacks = props(view)
    const rendered = render(<ForumCenter {...callbacks} />)
    const list = screen.getByRole('list', { name: zh.forumPostList })
    const image = list.querySelector('img')
    if (image === null) throw new Error('The supplied author avatar is shown')
    expect(image.getAttribute('src')).toBe(forumContentUrl(owner, avatar.id))
    expect(image.getAttribute('alt')).toBe('')
    expect(image.getAttribute('loading')).toBe('lazy')
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(screen.getByRole('dialog').querySelectorAll('img')).toHaveLength(2)
    expect(within(list).getByText(author.display_name)).toBeTruthy()
    fireEvent.error(image)
    expect(list.querySelector('img')).toBeNull()
    const replacement = forumContentUrl({ ...owner, owner: 'b'.repeat(64) }, avatar.id)
    const updated = { ...view, list: { ...view.list, posts: view.list.posts.map(row => ({ ...row, authorAvatarUrl: replacement })) } }
    rendered.rerender(<ForumCenter {...callbacks} view={updated} />)
    expect(list.querySelector('img')?.getAttribute('src')).toBe(replacement)
    expect(callbacks.onSubmitPost).not.toHaveBeenCalled()
    expect(callbacks.onSubmitReply).not.toHaveBeenCalled()
    expect(callbacks.onToggleLike).not.toHaveBeenCalled()
  })

  it('supports comment-history avatars and leaves legacy no-avatar authors as their existing initials', () => {
    const view = forumCenterView(state(), t, id => forumContentUrl(owner, id)), reply = view.detail.post?.replies[0]
    if (reply === undefined) throw new Error('The actual comment is supplied')
    const history = { ...view, list: { ...view.list, kind: 'comments' as const, posts: [],
      comments: [{ ...reply, postId: forumExamplePost().id, postTitle: forumExamplePost().title }] },
    detail: { ...view.detail, postId: null, post: null } }
    const current = render(<ForumCenter {...props(history)} />)
    expect(screen.getByRole('list', { name: zh.forumMyComments }).querySelector('img')?.getAttribute('src')).toBe(forumContentUrl(owner, avatar.id))
    current.rerender(<ForumCenter {...props(forumCenterView(state(false), t))} />)
    expect(screen.getByRole('list', { name: zh.forumPostList }).querySelector('img')).toBeNull()
    expect(screen.getAllByText(author.display_name).length).toBeGreaterThan(0)
  })
})
