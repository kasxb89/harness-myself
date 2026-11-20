/** Personal pages, recipient notifications and nickname CAS never rely on filtering a public page. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForumController } from '../src/client/forum-controller.ts'
import type { ForumResult } from '../src/client/forum-api.ts'
import { extendedAccount, extendedHarness, extendedPostId, extendedReplyId, successful, uncertain } from './forum-extended-fixtures.client.ts'
import { forumExampleComment, forumExamplePost } from './forum-model-fixtures.client.ts'

const controls: ForumController[] = []
afterEach(async () => { await Promise.all(controls.splice(0).map(control => control.dispose())); vi.useRealTimers() })
async function harness(options: Parameters<typeof extendedHarness>[0] = {}) {
  const value = extendedHarness(options); controls.push(value.control)
  await vi.waitFor(() => { expect(value.snapshot().activity?.profile.status).toBe('ready')
    expect(value.snapshot().activity?.notifications.unreadCount).toBeTypeOf('number') })
  return value
}
describe('forum account activity', () => {
  it('uses independent authenticated my-post and my-comment cursor endpoints', async () => {
    const h = await harness(), own = { id: 1, display_name: '论坛用户1' }
    h.rows.push(forumExamplePost({ id: '00000000-0000-4000-8000-000000009001', author: own }))
    h.replies.push(forumExampleComment({ id: '00000000-0000-4000-8000-000000009002', author: own }))
    h.control.setFeedScope?.('mine')
    await vi.waitFor(() => { expect(h.snapshot().activity?.myPosts.items).toHaveLength(1) })
    h.control.setFeedScope?.('comments')
    await vi.waitFor(() => { expect(h.snapshot().activity?.myComments.items).toHaveLength(1) })
    expect(h.snapshot().activity?.myComments.items[0]?.post_title).toBe(h.rows[0]?.title)
    expect(h.request.mock.calls.some(([, input]) => input.path.startsWith('/me/posts?'))).toBe(true)
    expect(h.request.mock.calls.some(([, input]) => input.path.startsWith('/me/comments?'))).toBe(true)
    h.control.refresh()
    await vi.waitFor(() => { expect(h.request.mock.calls.filter(([, input]) => input.path.startsWith('/me/comments?')).length).toBe(2) })
  })

  it('preserves server notification ID order, including 9/10 and full uint64 identities, and acknowledges only explicit actions', async () => {
    const h = await harness()
    expect(h.snapshot().activity?.notifications.items.map(item => item.id)).toEqual(['18446744073709551614', '10', '9'])
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/notifications/read')).toHaveLength(0)
    h.control.markNotificationsRead?.(['10'])
    await vi.waitFor(() => { expect(h.snapshot().activity?.notifications.unreadCount).toBe(2) })
    await vi.waitFor(() => { expect(h.snapshot().activity?.notifications.items.find(item => item.id === '10')?.read_at).toBe(123) })
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/notifications/read')).toHaveLength(1)
    h.control.openNotification?.('9')
    await vi.waitFor(() => { expect(h.snapshot().activity?.highlightedCommentId).toBe(extendedReplyId) })
    expect(h.snapshot().selectedPostId).toBe(extendedPostId)
    expect(h.request.mock.calls.some(([, input]) => input.path === `/posts/${extendedPostId}/comments/${extendedReplyId}`)).toBe(true)
  })

  it('recovers a lost nickname response by GET with one PATCH and keeps normal account identity untouched', async () => {
    let lost = false
    const h = await harness({ intercept: (input, answer) => {
      if (!lost && input.method === 'PATCH') { lost = true; return uncertain() }
      return answer
    } })
    const originalAccount = h.account.getSnapshot()
    h.control.updateNickname?.('阿泽😊')
    await vi.waitFor(() => { expect(h.snapshot().activity?.profile.error?.unknown).toBe(true) })
    h.control.refresh()
    await vi.waitFor(() => { expect(h.snapshot().activity?.profile.value?.display_name).toBe('阿泽😊')
      expect(h.snapshot().activity?.profile.error).toBeNull() })
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'PATCH')).toHaveLength(1)
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/profile' && input.method === 'GET')).toHaveLength(2)
    expect(h.account.getSnapshot()).toBe(originalAccount)
  })

  it('rechecks a cached profile after an error and never PATCHes an unsafe phone nickname', async () => {
    const h = await harness()
    h.control.updateNickname?.('+60 12-345-6789')
    expect(h.snapshot().activity?.profile.value).not.toBeNull()
    expect(h.snapshot().activity?.profile.error?.code).toBe('FORUM_PROFILE_INVALID')
    h.control.refresh()
    await vi.waitFor(() => { expect(h.snapshot().activity?.profile.error).toBeNull() })
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/profile' && input.method === 'GET')).toHaveLength(2)
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'PATCH')).toHaveLength(0)
  })

  it('uses the one background timer for unread reads outside the forum and clears it on sign-out', async () => {
    vi.useFakeTimers()
    const h = await harness({ interval: 1000 })
    const before = h.request.mock.calls.length
    h.control.setVisible(false)
    await vi.advanceTimersByTimeAsync(1001)
    const later = h.request.mock.calls.slice(before).map(([, input]) => input.path)
    expect(later).toEqual(['/notifications/unread'])
    h.account.set({ ...extendedAccount(), accountEpoch: 2, session: { signedIn: false, creditsPerYuan: 1000 } })
    expect(h.snapshot().activity?.notifications.unreadCount).toBeNull()
    const stopped = h.request.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.request.mock.calls).toHaveLength(stopped)
  })

  it('retains the verified unread count on network failure without treating it as zero', async () => {
    const h = await harness({ interval: 1000, intercept: (input, answer) => input.path === '/notifications/unread'
      ? { ok: false, code: 'FORUM_NETWORK', httpStatus: 0, unknown: false } : answer })
    vi.useFakeTimers(); h.control.setVisible(false)
    await vi.advanceTimersByTimeAsync(1001)
    expect(h.snapshot().activity?.notifications.unreadCount).toBe(3)
    expect(h.snapshot().activity?.notifications.error?.code).toBe('FORUM_NETWORK')
  })

  it('does not replace retained nickname or send a second PATCH when recovery confirms another revision/name', async () => {
    let recovery = false
    const h = await harness({ intercept: (input, answer) => {
      if (input.method === 'PATCH') { recovery = true; return uncertain() }
      if (recovery && input.path === '/profile') return successful({ profile: { id: 1, display_name: '另一昵称', revision: 3 } })
      return answer
    } })
    h.control.updateNickname?.('我的昵称')
    await vi.waitFor(() => { expect(h.snapshot().activity?.profile.error?.unknown).toBe(true) })
    h.control.updateNickname?.('我的昵称')
    await vi.waitFor(() => { expect(h.snapshot().activity?.profile.error?.code).toBe('FORUM_REVISION_CONFLICT') })
    expect(h.snapshot().activity?.profile.value?.display_name).toBe('另一昵称')
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'PATCH')).toHaveLength(1)
  })

  it('does not let an older read acknowledgement roll back a newer unread count', async () => {
    let reads = 0, listReads = 0
    let releaseFirst: (() => void) | undefined, releaseList: (() => void) | undefined
    const h = await harness({ intercept: (input, answer) => {
      if (input.path === '/notifications/read' && ++reads === 1) return new Promise<ForumResult>((resolve) => {
        releaseFirst = () => { resolve(answer) }
      })
      if (input.path.startsWith('/notifications?') && ++listReads === 2) return new Promise<ForumResult>((resolve) => {
        releaseList = () => { resolve(answer) }
      })
      return answer
    } })
    h.control.markNotificationsRead?.(['18446744073709551614', '10'])
    await vi.waitFor(() => { expect(releaseFirst).toBeTypeOf('function') })
    h.control.markNotificationsRead?.(['9'])
    await vi.waitFor(() => { expect(h.snapshot().activity?.notifications.readingIds.includes('9')).toBe(false) })
    releaseFirst?.()
    await vi.waitFor(() => { expect(releaseList).toBeTypeOf('function')
      expect(h.snapshot().activity?.notifications.readingIds).toHaveLength(0) })
    releaseList?.()
    await vi.waitFor(() => { expect(h.snapshot().activity?.notifications.unreadCount).toBe(0)
      expect(h.snapshot().activity?.notifications.items.every(item => item.read_at > 0)).toBe(true) })
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/notifications/read')).toHaveLength(2)
  })

  it.each([403, 404, 503])('revokes a no-longer-visible cached post on %s while retaining it for transport failures', async (status) => {
    let fail = false
    const h = await harness({ intercept: (input, answer) => fail && input.path === `/posts/${extendedPostId}`
      ? { ok: false, code: status === 503 ? 'FORUM_UNAVAILABLE' : 'FORUM_NOT_FOUND', httpStatus: status, unknown: false } : answer })
    h.control.openPost(extendedPostId)
    await vi.waitFor(() => { expect(h.snapshot().selectedPost).not.toBeNull(); expect(h.snapshot().comments.items).toHaveLength(1) })
    fail = true; h.control.refresh()
    await vi.waitFor(() => { expect(h.snapshot().selectedPostStatus).toBe('error') })
    if (status === 503) expect(h.snapshot().selectedPost?.id).toBe(extendedPostId)
    else { expect(h.snapshot().selectedPost).toBeNull(); expect(h.snapshot().comments.items).toHaveLength(0) }
  })
})
