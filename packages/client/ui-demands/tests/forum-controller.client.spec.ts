/** Real forum model commands against isolated exact-shape DTOs and one-attempt transport. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createForumController, type ForumController } from '../src/client/forum-controller.ts'
import type { ForumOwner, ForumRequest, ForumResult } from '../src/client/forum-api.ts'
import { createForumJournal, type ForumJournal } from '../src/client/forum-pending.ts'
import type { ForumComment, ForumPost } from '../src/client/forum-types.ts'
import { forumExampleComment as comment, forumExampleConfig as configuration,
  forumExamplePost as post, forumMemory } from './forum-model-fixtures.client.ts'

type Account = ReturnType<Context['creditsSession']['getSnapshot']>
const hash = 'a'.repeat(64), id = post().id, otherId = '00000000-0000-4000-8000-000000001002'
const ok = (payload: unknown): ForumResult => ({ ok: true, payload })
const unknown = (): ForumResult => ({ ok: false, code: 'FORUM_TIMEOUT', httpStatus: 0, unknown: true })
function account(accountId = '1', epoch = 1): Account {
  return { loaded: true, accountEpoch: epoch, balance: null, failure: null,
    session: { signedIn: true, creditsPerYuan: 1000, account: { id: accountId, phone: '' }, accountOwner: hash } }
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Missing resolver') }
  const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve }
}
const controls: ForumController[] = []
afterEach(async () => { await Promise.all(controls.splice(0).map(control => control.dispose())); vi.useRealTimers() })
function body(input: ForumRequest): Record<string, unknown> { return JSON.parse(input.body ?? '{}') as Record<string, unknown> }
function harness(options: {
  enabled?: boolean
  rows?: ForumPost[]
  journal?: ForumJournal
  intercept?: (owner: ForumOwner, input: ForumRequest) => ForumResult | undefined | Promise<ForumResult | undefined>
} = {}) {
  const source = createSnapshotStore(account()), rows = options.rows ?? [post(), post({ id: otherId, title: 'Second independent post' })]
  const history = new Map<string, ForumComment[]>(), journal = options.journal ?? createForumJournal(forumMemory())
  const receipts = new Map<string, ForumResult>(); let nonce = 0, serverNonce = 2000
  const request = vi.fn(async (owner: ForumOwner, input: ForumRequest): Promise<ForumResult> => {
    const intercepted = await options.intercept?.(owner, input)
    if (intercepted !== undefined) return intercepted
    if (input.path === '/config') return ok(configuration(options.enabled ?? true))
    if (input.path.startsWith('/posts?')) return ok({ items: rows, next_cursor: '', has_more: false })
    const postId = input.path.split('/')[2], rowIndex = rows.findIndex(row => row.id === postId), row = rows[rowIndex]
    if (input.path.includes('/comments?')) return ok({ items: history.get(postId ?? '') ?? [], next_cursor: '', has_more: false })
    if (input.method === 'GET' && row !== undefined) return ok({ post: row })
    const payload = body(input)
    if (input.method === 'PUT' && row !== undefined) {
      const updated = { ...row, liked: payload.liked === true,
        like_count: row.like_count + (payload.liked === true ? row.liked ? 0 : 1 : row.liked ? -1 : 0) }
      rows[rowIndex] = updated; return ok({ post: updated })
    }
    if (input.method === 'POST') {
      const key = String(payload.client_request_id), prior = receipts.get(key)
      if (prior !== undefined) return prior
      const nextId = `00000000-0000-4000-8000-${String(++serverNonce).padStart(12, '0')}`
      const author = { id: Number(owner.id), display_name: 'Current test author' }
      if (input.path === '/posts') {
        const value = post({ id: nextId, title: String(payload.title).trim(), body: String(payload.body).trim(), author, created_at: 300 })
        rows.unshift(value); const reply = ok({ post: value, replayed: false }); receipts.set(key, reply); return reply
      }
      if (row !== undefined) {
        const value = comment({ id: nextId, post_id: row.id, body: String(payload.body).trim(), author, created_at: 300 })
        history.set(row.id, [value, ...history.get(row.id) ?? []]); rows[rowIndex] = { ...row, comment_count: row.comment_count + 1 }
        const reply = ok({ comment: value, replayed: false }); receipts.set(key, reply); return reply
      }
    }
    return { ok: false, code: 'FORUM_NOT_FOUND', httpStatus: 404, unknown: false }
  })
  const control = createForumController(source, { enabled: true, foregroundPollMs: 60_000, backgroundPollMs: 60_000 }, {
    request, journal, uuid: () => `00000000-0000-4000-8000-${String(++nonce).padStart(12, '0')}`, isForeground: () => true,
  })
  controls.push(control); control.start()
  const snapshot = () => control.hooks.forum.getSnapshot()
  const ready = async () => { await vi.waitFor(() => {
    expect(snapshot().availability).toBe(options.enabled === false ? 'disabled' : 'ready'); expect(snapshot().posts.status).toBe('ready')
  }) }
  const open = async (postId = id) => {
    control.openPost(postId); await vi.waitFor(() => {
      expect(snapshot().selectedPostId).toBe(postId); expect(snapshot().selectedPostStatus).toBe('ready')
      expect(snapshot().comments.status).toBe('ready')
    })
  }
  const draft = (title = 'Independent publication', text = 'Public body') => {
    control.startPost(); const scope = snapshot().activePostDraftScope
    if (scope === null) throw new Error('Expected new draft')
    control.updatePostDraft(scope, { title, body: text }); return scope
  }
  return { control, source, rows, request, history, journal, snapshot, ready, open, draft }
}

describe('forum model', () => {
  it('retains published history when closed and blocks all new writes without creating sessions', async () => {
    const h = harness({ enabled: false }); await h.ready(); await h.open()
    h.control.startPost(); h.control.updateCommentDraft(id, 'Closed'); h.control.sendComment(id); h.control.setLiked(id, true)
    expect(h.snapshot().postDrafts).toHaveLength(0); expect(h.snapshot().selectedPost?.author.display_name).toBe('Test author')
    expect(h.request.mock.calls.filter(([, input]) => input.method !== 'GET')).toHaveLength(0)
    expect(h.request.mock.calls.every(([, input]) => input.path.startsWith('/posts') || input.path === '/config')).toBe(true)
  })
  it('gracefully handles an unsupported config without old API fallback', async () => {
    const h = harness({ intercept: (_owner, input) => input.path === '/config'
      ? { ok: false, code: 'FORUM_NOT_FOUND', httpStatus: 404, unknown: false } : undefined })
    await vi.waitFor(() => { expect(h.snapshot().availability).toBe('unavailable') })
    h.control.startPost(); h.control.openPost(id)
    expect(h.request).toHaveBeenCalledTimes(1)
  })
  it('persists before dispatch, suppresses only a double submit, and lets an independent draft proceed', async () => {
    const first = deferred<ForumResult>(), writes: ForumRequest[] = []
    const h = harness({ intercept: (_owner, input) => {
      if (input.path === '/posts' && input.method === 'POST') {
        writes.push(input); if (writes.length === 1) return first.promise
      }
      return undefined
    } }); await h.ready()
    const scope = h.draft(' First title ', ' First body ')
    h.control.publishPost(scope); h.control.publishPost(scope)
    expect(h.journal.read({ id: '1', owner: hash })).toHaveLength(1)
    const second = h.draft('Independent second'); h.control.publishPost(second)
    first.resolve(unknown())
    await vi.waitFor(() => { expect(h.snapshot().postDrafts.find(row => row.scopeKey === second)?.postId).toBeTypeOf('string') })
    expect(writes).toHaveLength(2)
    expect(body(writes[0] ?? { method: 'POST', path: '/', signal: new AbortController().signal }).title).toBe(' First title ')
    expect(h.snapshot().pending).toHaveLength(1)
    const original = h.snapshot().pending[0]
    if (original === undefined) throw new Error('Expected original operation')
    h.control.updatePostDraft(scope, { body: 'Changed body' }); h.control.retryOperation(original.operationId)
    await vi.waitFor(() => { expect(h.snapshot().pending).toHaveLength(0) })
    expect(writes[2]?.body).toBe(writes[0]?.body)
    expect(h.snapshot().postDrafts.find(row => row.scopeKey === scope)?.body).toBe(' First body ')
  })
  it('keeps two explicit identical publications independent and retains a new receipt over an older feed', async () => {
    const held = deferred<ForumResult>(); let hold = false
    const h = harness({ intercept: (_owner, input) => input.path.startsWith('/posts?') && hold ? held.promise : undefined })
    await h.ready(); hold = true; h.control.refresh()
    await vi.waitFor(() => { expect(h.request.mock.calls.filter(([, input]) => input.path.startsWith('/posts?'))).toHaveLength(2) })
    const first = h.draft('Same explicit title', 'Same explicit body'); h.control.publishPost(first)
    await vi.waitFor(() => { expect(h.snapshot().postDrafts.find(row => row.scopeKey === first)?.postId).toBeTypeOf('string') })
    const second = h.draft('Same explicit title', 'Same explicit body'); h.control.publishPost(second)
    await vi.waitFor(() => { expect(h.snapshot().postDrafts.find(row => row.scopeKey === second)?.postId).toBeTypeOf('string') })
    const marker = '00000000-0000-4000-8000-000000001005'
    held.resolve(ok({ items: [post({ id: marker })], next_cursor: '', has_more: false }))
    await vi.waitFor(() => { expect(h.snapshot().posts.items.some(row => row.id === marker)).toBe(true) })
    expect(h.snapshot().posts.items.filter(row => row.title === 'Same explicit title')).toHaveLength(2)
    const keys = h.request.mock.calls.filter(([, input]) => input.method === 'POST').map(([, input]) => body(input).client_request_id)
    expect(new Set(keys).size).toBe(2)
  })
  it('does not infer an unknown publication from matching feed title or automatically replay it on restore', async () => {
    const h = harness({ intercept: (_owner, input) => input.path === '/posts' && input.method === 'POST' ? unknown() : undefined })
    await h.ready(); h.control.publishPost(h.draft('Synthetic forum topic', 'Synthetic public text'))
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.unknown).toBe(true) })
    await h.control.dispose()
    const restored = harness({ journal: h.journal }); await restored.ready()
    expect(restored.snapshot().pending[0]?.error).toMatchObject({ code: 'FORUM_RESULT_UNKNOWN', unknown: true })
    expect(restored.request.mock.calls.every(([, input]) => input.method === 'GET')).toBe(true)
    const op = restored.snapshot().pending[0]
    if (op === undefined) throw new Error('Expected restored operation')
    restored.control.retryOperation(op.operationId)
    await vi.waitFor(() => { expect(restored.snapshot().pending).toHaveLength(0) })
  })
  it('comments keep one original key per submit while another post and new text remain independent', async () => {
    let first = true
    const h = harness({ intercept: (_owner, input) => {
      if (input.path === `/posts/${id}/comments` && input.method === 'POST' && first) { first = false; return unknown() }
      return undefined
    } }); await h.ready(); await h.open()
    h.control.updateCommentDraft(id, 'First exact comment'); h.control.sendComment(id); h.control.sendComment(id)
    await vi.waitFor(() => { expect(h.snapshot().pending).toHaveLength(1) })
    await h.open(otherId); h.control.updateCommentDraft(otherId, 'Other post'); h.control.sendComment(otherId)
    await vi.waitFor(() => { expect(h.snapshot().comments.items).toHaveLength(1) })
    h.control.updateCommentDraft(id, 'New independent text'); h.control.sendComment(id)
    await vi.waitFor(() => { expect(h.history.get(id)).toHaveLength(1) })
    const op = h.snapshot().pending[0]
    if (op === undefined) throw new Error('Expected unknown comment')
    h.control.retryOperation(op.operationId)
    await vi.waitFor(() => { expect(h.snapshot().pending).toHaveLength(0) })
    const writes = h.request.mock.calls.map(([, input]) => input)
      .filter(input => input.path === `/posts/${id}/comments` && input.method === 'POST')
    expect(writes).toHaveLength(3); expect(writes[2]?.body).toBe(writes[0]?.body); expect(writes[1]?.body).not.toBe(writes[0]?.body)
    expect(h.rows.find(row => row.id === id)?.comment_count).toBe(2)
  })
  it('checks an unknown like by GET and confirms the desired state without a second PUT', async () => {
    const h = harness({ intercept: (_owner, input) => {
      if (input.method === 'PUT') { h.rows[0] = post({ liked: true, like_count: 1 }); return unknown() }
      return undefined
    } }); await h.ready()
    h.control.setLiked(id, true); h.control.setLiked(id, true)
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.unknown).toBe(true) })
    const op = h.snapshot().pending[0]
    if (op === undefined) throw new Error('Expected unknown like')
    h.control.retryOperation(op.operationId)
    await vi.waitFor(() => { expect(h.snapshot().pending).toHaveLength(0) })
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'PUT')).toHaveLength(1)
    expect(h.snapshot().posts.items.find(row => row.id === id)).toMatchObject({ liked: true, like_count: 1 })
  })
  it('requires another explicit gesture after an unknown like is not confirmed by GET', async () => {
    let first = true
    const h = harness({ intercept: (_owner, input) => {
      if (input.method === 'PUT' && first) { first = false; return unknown() }
      return undefined
    } }); await h.ready(); h.control.setLiked(id, true)
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.unknown).toBe(true) })
    const op = h.snapshot().pending[0]
    if (op === undefined) throw new Error('Expected unknown like')
    h.control.retryOperation(op.operationId)
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.code).toBe('FORUM_LIKE_NOT_CONFIRMED') })
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'PUT')).toHaveLength(1)
    h.control.retryOperation(op.operationId)
    await vi.waitFor(() => { expect(h.snapshot().pending).toHaveLength(0) })
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'PUT')).toHaveLength(2)
  })
  it('rejects late old-account replies and joins cancellation without exposing its pending text to another user', async () => {
    const held = deferred<ForumResult>(); let signal: AbortSignal | undefined
    const h = harness({ intercept: (_owner, input) => {
      if (input.path === '/posts' && input.method === 'POST') { signal = input.signal; return held.promise }
      return undefined
    } }); await h.ready(); h.control.publishPost(h.draft('Account A private draft'))
    h.source.set(account('2', 2)); expect(signal?.aborted).toBe(true)
    held.resolve(ok({ post: post({ author: { id: 1, display_name: 'Old user' } }), replayed: false }))
    await h.ready()
    expect(h.snapshot().accountId).toBe('2'); expect(h.snapshot().postDrafts).toHaveLength(0); expect(h.snapshot().pending).toHaveLength(0)
    const stop = h.control.dispose(); await stop
    expect(h.snapshot().accountId).toBeNull()
  })
  it('preserves known rejection as known and never dispatches after persistence failure', async () => {
    const h = harness({ intercept: (_owner, input) => input.method === 'POST'
      ? { ok: false, code: 'FORUM_REQUEST_CONFLICT', httpStatus: 409, unknown: false } : undefined })
    await h.ready(); h.control.publishPost(h.draft())
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error).toMatchObject({ code: 'FORUM_REQUEST_CONFLICT', unknown: false }) })
    const memory = forumMemory(); memory.setItem = () => { throw new Error('Storage unavailable') }
    const blocked = harness({ journal: createForumJournal(memory) }); await blocked.ready(); blocked.control.publishPost(blocked.draft())
    expect(blocked.request.mock.calls.filter(([, input]) => input.method !== 'GET')).toHaveLength(0)
    expect(blocked.snapshot().error?.code).toBe('FORUM_PENDING_STORAGE_FAILED')
  })
  it('paginates exact opaque cursors and keeps server ordering without duplicate rows', async () => {
    const h = harness({ intercept: (_owner, input) => {
      if (input.path === '/posts?limit=30') return ok({ items: [post()], next_cursor: 'cursor_2', has_more: true })
      if (input.path === '/posts?limit=30&cursor=cursor_2') return ok({
        items: [post(), post({ id: otherId, created_at: 99 })], next_cursor: '', has_more: false })
      return undefined
    } }); await h.ready(); h.control.loadMorePosts(); h.control.loadMorePosts()
    await vi.waitFor(() => { expect(h.snapshot().posts.items).toHaveLength(2) })
    expect(h.snapshot().posts.hasMore).toBe(false)
    expect(h.request.mock.calls.filter(([, input]) => input.path.includes('cursor='))).toHaveLength(1)
  })
  it('rejects a foreign post comment and reports detail failure instead of endless loading', async () => {
    const h = harness({ intercept: (_owner, input) => {
      if (input.path.includes('/comments?')) return ok({ items: [comment({ post_id: otherId })], next_cursor: '', has_more: false })
      if (input.path === `/posts/${otherId}`) return { ok: false, code: 'FORUM_NOT_FOUND', httpStatus: 404, unknown: false }
      return undefined
    } }); await h.ready(); h.control.openPost(id)
    await vi.waitFor(() => { expect(h.snapshot().comments.error?.code).toBe('FORUM_PROTOCOL_INVALID') })
    h.control.openPost(otherId)
    await vi.waitFor(() => { expect(h.snapshot().selectedPostError?.code).toBe('FORUM_NOT_FOUND') })
    expect(h.snapshot().selectedPostStatus).toBe('error')
  })
  it('does not close a different draft when an earlier publication succeeds', async () => {
    const held = deferred<ForumResult>()
    const h = harness({ intercept: (_owner, input) => input.method === 'POST' && input.path === '/posts' ? held.promise : undefined })
    await h.ready(); const firstScope = h.draft('First title', 'First body'); h.control.publishPost(firstScope)
    const secondScope = h.draft('Second untouched draft')
    held.resolve(ok({ post: post({ title: 'First title', body: 'First body',
      author: { id: 1, display_name: 'Current author' } }), replayed: false }))
    await vi.waitFor(() => { expect(h.snapshot().postDrafts.find(row => row.scopeKey === firstScope)?.postId).toBe(id) })
    expect(h.snapshot().activePostDraftScope).toBe(secondScope)
    expect(h.snapshot().postDrafts.find(row => row.scopeKey === secondScope)?.body).toBe('Public body')
  })
  it('retains a confirmed comment across a late older comments page', async () => {
    const held = deferred<ForumResult>(); let hold = false
    const h = harness({ intercept: (_owner, input) => input.path.includes('/comments?') && hold ? held.promise : undefined })
    await h.ready(); await h.open(); hold = true; h.control.openPost(id)
    await vi.waitFor(() => { expect(h.request.mock.calls.filter(([, input]) => input.path.includes('/comments?'))).toHaveLength(2) })
    h.control.updateCommentDraft(id, 'New confirmed response'); h.control.sendComment(id)
    await vi.waitFor(() => { expect(h.snapshot().comments.items[0]?.body).toBe('New confirmed response') })
    held.resolve(ok({ items: [comment({ id: '00000000-0000-4000-8000-000000002000' })], next_cursor: '', has_more: false }))
    await vi.waitFor(() => { expect(h.snapshot().comments.items).toHaveLength(2); expect(h.snapshot().pending).toHaveLength(0) })
    expect(h.snapshot().comments.items[0]?.body).toBe('New confirmed response')
  })
  it('does not let a late pre-like GET overwrite the confirmed liked state', async () => {
    const held = deferred<ForumResult>(); let hold = false
    const h = harness({ intercept: (_owner, input) => input.path.startsWith('/posts?') && hold ? held.promise : undefined })
    await h.ready(); hold = true; h.control.refresh()
    await vi.waitFor(() => { expect(h.request.mock.calls.filter(([, input]) => input.path.startsWith('/posts?'))).toHaveLength(2) })
    h.control.setLiked(id, true)
    await vi.waitFor(() => {
      expect(h.snapshot().pending).toHaveLength(0)
      expect(h.snapshot().posts.items.find(row => row.id === id)?.liked).toBe(true)
    })
    const thirdId = '00000000-0000-4000-8000-000000001003'
    held.resolve(ok({ items: [post(), post({ id: thirdId })], next_cursor: '', has_more: false }))
    await vi.waitFor(() => { expect(h.snapshot().posts.items.some(row => row.id === thirdId)).toBe(true) })
    expect(h.snapshot().posts.items.find(row => row.id === id)?.liked).toBe(true)
  })
})
