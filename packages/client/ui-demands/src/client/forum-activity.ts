/** Account-scoped forum history, nickname and notification state, independent of public-feed paging. */
import type { ForumOwner } from './forum-api.ts'
import type { ForumModelContext } from './forum-model-context.ts'
import type { ForumActivityState, ForumComment, ForumIssue, ForumNotification, ForumPage, ForumPost, ForumProfile } from './forum-types.ts'
import { forumNotification, forumNotificationId, forumProfile } from './forum-extended-wire.ts'
import { forumAuthor, forumComment, forumInteger, forumObject, forumPage, forumPost, forumText } from './forum-wire.ts'

interface Page<T> {
  items: T[]
  cursor: string
  hasMore: boolean
  status: 'ready' | 'loading' | 'error'
  loadingMore: boolean
  error: ForumIssue | null
  flight: boolean
}
const page = <T>(): Page<T> => ({ items: [], cursor: '', hasMore: false, status: 'ready', loadingMore: false, error: null, flight: false })
const view = <T>(state: Page<T>): ForumPage<T> => ({ items: state.items, status: state.status,
  hasMore: state.hasMore, loadingMore: state.loadingMore, error: state.error })
const issue = (code: string, unknown = false): ForumIssue => ({ code, unknown, operationId: null })

/** Capability-qualified account tools owned by the existing forum controller lifecycle. */
export interface ForumActivityModel {
  readonly snapshot: () => ForumActivityState
  readonly reset: () => void
  readonly refresh: (owner: ForumOwner) => Promise<void>
  readonly background: (owner: ForumOwner) => Promise<void>
  readonly setScope: (scope: ForumActivityState['scope']) => void
  readonly loadMoreOwnPosts: () => void
  readonly loadMoreOwnComments: () => void
  readonly refreshNotifications: () => void
  readonly loadMoreNotifications: () => void
  readonly markRead: (ids: readonly string[]) => void
  readonly openNotification: (id: string) => void
  readonly openComment: (postId: string, commentId: string) => void
  readonly updateNickname: (displayName: string) => void
}

/** Compose the optional account tools under the existing single forum lifecycle.
 * @param ctx - Captured account, transport and disposal seats owned by the forum controller.
 * @param targets - Existing post navigation and verified comment insertion.
 * @returns Account-tool snapshots and explicit user commands.
 */
export function createForumActivity(ctx: ForumModelContext, targets: {
  readonly openPost: (owner: ForumOwner, id: string) => Promise<void>
  readonly focusComment: (comment: ForumComment) => void
}): ForumActivityModel {
  let scope: ForumActivityState['scope'] = 'all', myPosts = page<ForumPost>(), myComments = page<ForumComment>()
  let notifications = page<ForumNotification>(), unreadCount: number | null = null, noticeVersion = 0, unreadFlight = false
  let reconcileNotifications = false
  let profile: ForumProfile | null = null, profileStatus: 'ready' | 'loading' | 'error' = 'ready'
  let profileError: ForumIssue | null = null, profileFlight = false, saving = false, highlighted: string | null = null
  let unknownProfile: { readonly name: string; readonly revision: number } | null = null
  const reading = new Set<string>()
  const allowed = (captured: ForumOwner, key: 'my_activity' | 'notifications' | 'forum_profile'): boolean =>
    ctx.valid(captured) && ctx.config()?.capabilities[key] === true
  const readProfile = async (captured: ForumOwner): Promise<void> => {
    if (!allowed(captured, 'forum_profile') || profileFlight) return
    profileFlight = true; if (profile === null) profileStatus = 'loading'; ctx.publish()
    try {
      const answer = await ctx.perform(captured, { method: 'GET', path: '/profile' })
      if (!ctx.valid(captured)) return
      if (!answer.ok) { profileStatus = 'error'; profileError = issue(answer.code); return }
      const value = forumProfile(forumObject(answer.payload).profile)
      if (String(value.id) !== captured.id) throw new Error('FORUM_PROTOCOL_INVALID')
      if (profile === null || value.revision >= profile.revision) profile = value
      profileStatus = 'ready'
      if (unknownProfile !== null) {
        profileError = value.display_name === unknownProfile.name && value.revision >= unknownProfile.revision + 1
          ? null : issue('FORUM_REVISION_CONFLICT')
        unknownProfile = null
      } else profileError = null
    } catch (_invalid: unknown) { if (ctx.valid(captured)) { profileStatus = 'error'; profileError = issue('FORUM_PROTOCOL_INVALID') } }
    finally { if (ctx.valid(captured)) { profileFlight = false; ctx.publish() } }
  }
  const readOwn = async (captured: ForumOwner, kind: 'posts' | 'comments', more = false): Promise<void> => {
    if (!allowed(captured, 'my_activity')) return
    const state: Page<ForumPost | ForumComment> = kind === 'posts' ? myPosts : myComments
    if (state.flight || more && !state.hasMore) return
    state.flight = true; state.loadingMore = more; state.error = null
    if (state.items.length === 0) state.status = 'loading'
    ctx.publish()
    try {
      const query = new URLSearchParams({ limit: '30' }); if (more) query.set('cursor', state.cursor)
      const answer = await ctx.perform(captured, { method: 'GET', path: `/me/${kind}?${query}` })
      if (!ctx.valid(captured)) return
      if (!answer.ok) { state.status = 'error'; state.error = issue(answer.code); return }
      const result = forumPage<ForumPost | ForumComment>(answer.payload, value => kind === 'posts' ? forumPost(value) : forumComment(value, true))
      if (result.items.some(item => String(item.author.id) !== captured.id)) throw new Error('FORUM_PROTOCOL_INVALID')
      state.items = [...new Map([...(more ? state.items : []), ...result.items].map(item => [item.id, item])).values()]
      state.cursor = result.next_cursor; state.hasMore = result.has_more; state.status = 'ready'
    } catch (_invalid: unknown) { if (ctx.valid(captured)) { state.status = 'error'; state.error = issue('FORUM_PROTOCOL_INVALID') } }
    finally { if (ctx.valid(captured)) { state.flight = false; state.loadingMore = false; ctx.publish() } }
  }
  const readUnread = async (captured: ForumOwner): Promise<void> => {
    if (!allowed(captured, 'notifications') || unreadFlight) return
    const version = noticeVersion; unreadFlight = true
    try {
      const answer = await ctx.perform(captured, { method: 'GET', path: '/notifications/unread' })
      if (!ctx.valid(captured)) return
      if (!answer.ok) { notifications.error = issue(answer.code); return }
      const count = forumInteger(forumObject(answer.payload).unread_count)
      if (version === noticeVersion) unreadCount = count
    } catch (_invalid: unknown) { if (ctx.valid(captured)) notifications.error = issue('FORUM_PROTOCOL_INVALID') }
    finally { if (ctx.valid(captured)) { unreadFlight = false; ctx.publish() } }
  }
  const readNotifications = async (captured: ForumOwner, more = false): Promise<void> => {
    const state = notifications
    if (!allowed(captured, 'notifications') || state.flight || more && !state.hasMore) return
    const version = noticeVersion; state.flight = true; state.loadingMore = more; state.error = null
    if (state.items.length === 0) state.status = 'loading'
    ctx.publish()
    try {
      const query = new URLSearchParams({ limit: '30' }); if (more) query.set('cursor', state.cursor)
      const answer = await ctx.perform(captured, { method: 'GET', path: `/notifications?${query}` })
      if (!ctx.valid(captured)) return
      if (!answer.ok) { state.status = 'error'; state.error = issue(answer.code); return }
      const result = forumPage(answer.payload, forumNotification), current = new Map(state.items.map(item => [item.id, item]))
      state.items = [...new Map([...(more ? state.items : []), ...result.items.map((item) => {
        const retained = current.get(item.id)
        return retained !== undefined && retained.read_at > item.read_at ? retained : item
      })].map(item => [item.id, item])).values()]
      state.cursor = result.next_cursor; state.hasMore = result.has_more; state.status = 'ready'
      const count = forumInteger(forumObject(answer.payload).unread_count)
      if (version === noticeVersion) unreadCount = count
    } catch (_invalid: unknown) { if (ctx.valid(captured)) { state.status = 'error'; state.error = issue('FORUM_PROTOCOL_INVALID') } }
    finally { if (ctx.valid(captured)) {
      state.flight = false; state.loadingMore = false; ctx.publish()
      if (reconcileNotifications && reading.size === 0) {
        reconcileNotifications = false; ctx.track(() => readNotifications(captured))
      }
    } }
  }
  const markRead = async (captured: ForumOwner, ids: readonly string[]): Promise<void> => {
    if (!allowed(captured, 'notifications') || ids.length === 0 || ids.length > 100) return
    const values = [...new Set(ids.map(forumNotificationId))]
    if (values.some(id => reading.has(id))) return
    for (const id of values) reading.add(id)
    const version = ++noticeVersion; ctx.publish()
    try {
      const answer = await ctx.perform(captured, { method: 'POST', path: '/notifications/read', body: JSON.stringify({ notification_ids: values }) })
      if (!ctx.valid(captured)) return
      if (!answer.ok) { notifications.error = issue(answer.code, answer.unknown); return }
      const count = forumInteger(forumObject(answer.payload).unread_count)
      if (version === noticeVersion) unreadCount = count
      notifications.error = null
    } catch (_invalid: unknown) { if (ctx.valid(captured)) notifications.error = issue('FORUM_PROTOCOL_INVALID', true) }
    finally { if (ctx.valid(captured)) {
      for (const id of values) reading.delete(id)
      reconcileNotifications = true
      if (reading.size === 0 && !notifications.flight) { reconcileNotifications = false; await readNotifications(captured) }
      ctx.publish()
    } }
  }
  const openTarget = async (captured: ForumOwner, postId: string, commentId: string | null): Promise<void> => {
    await targets.openPost(captured, postId)
    if (!ctx.valid(captured)) return
    highlighted = null
    if (commentId !== null) {
      const answer = await ctx.perform(captured, { method: 'GET', path: `/posts/${postId}/comments/${commentId}` })
      if (!ctx.valid(captured)) return
      if (!answer.ok) { notifications.error = issue(answer.code); ctx.publish(); return }
      const comment = forumComment(forumObject(answer.payload).comment)
      if (comment.id !== commentId || comment.post_id !== postId) throw new Error('FORUM_PROTOCOL_INVALID')
      targets.focusComment(comment); highlighted = comment.id
    }
    ctx.publish()
  }
  return {
    snapshot: (): ForumActivityState => ({ scope, myPosts: view(myPosts), myComments: view(myComments),
      profile: { value: profile, status: profileStatus, saving, error: profileError },
      notifications: { ...view(notifications), unreadCount, readingIds: [...reading] }, highlightedCommentId: highlighted }),
    reset: (): void => { scope = 'all'; myPosts = page(); myComments = page(); notifications = page(); unreadCount = null
      profile = null; profileStatus = 'ready'; profileError = null; profileFlight = false; saving = false; highlighted = null; unknownProfile = null
      reading.clear(); noticeVersion = 0; unreadFlight = false; reconcileNotifications = false },
    refresh: async (captured: ForumOwner): Promise<void> => {
      await Promise.all([profile === null || profileError !== null ? readProfile(captured) : undefined, readNotifications(captured),
        scope === 'mine' ? readOwn(captured, 'posts') : scope === 'comments' ? readOwn(captured, 'comments') : undefined])
    },
    background: readUnread,
    setScope: (next: ForumActivityState['scope']): void => {
      const captured = ctx.owner()
      if (captured === null || next !== 'all' && !allowed(captured, 'my_activity')) return
      scope = next; ctx.publish()
      if (next !== 'all') ctx.track(() => readOwn(captured, next === 'mine' ? 'posts' : 'comments'))
    },
    loadMoreOwnPosts: (): void => { const captured = ctx.owner()
      if (captured !== null) ctx.track(() => readOwn(captured, 'posts', true)) },
    loadMoreOwnComments: (): void => { const captured = ctx.owner()
      if (captured !== null) ctx.track(() => readOwn(captured, 'comments', true)) },
    refreshNotifications: (): void => { const captured = ctx.owner(); if (captured !== null) ctx.track(() => readNotifications(captured)) },
    loadMoreNotifications: (): void => { const captured = ctx.owner()
      if (captured !== null) ctx.track(() => readNotifications(captured, true)) },
    markRead: (ids: readonly string[]): void => { const captured = ctx.owner()
      if (captured !== null) ctx.track(() => markRead(captured, ids)) },
    openNotification: (id: string): void => {
      const captured = ctx.owner(), item = notifications.items.find(row => row.id === id)
      if (captured === null || item === undefined || !allowed(captured, 'notifications')) return
      ctx.track(async () => {
        await openTarget(captured, item.post_id, item.comment_id || null)
        if (ctx.valid(captured)) await markRead(captured, [item.id])
      })
    },
    openComment: (postId: string, commentId: string): void => { const captured = ctx.owner()
      if (captured !== null) ctx.track(() => openTarget(captured, postId, commentId)) },
    updateNickname: (displayName: string): void => {
      const captured = ctx.owner(), previous = profile
      if (captured === null || previous === null || !allowed(captured, 'forum_profile') || saving) return
      if (unknownProfile !== null) { ctx.track(() => readProfile(captured)); return }
      let name: string
      try {
        name = forumText(displayName.trim(), 40)
        if (forumAuthor({ id: previous.id, display_name: name }).display_name !== name) throw new Error('FORUM_PROFILE_INVALID')
      } catch (_input: unknown) { profileError = issue('FORUM_PROFILE_INVALID'); ctx.publish(); return }
      const body = JSON.stringify({ display_name: name, revision: previous.revision }); saving = true; profileError = null; ctx.publish()
      ctx.track(async () => {
        try {
          const answer = await ctx.perform(captured, { method: 'PATCH', path: '/profile', body })
          if (!ctx.valid(captured)) return
          if (!answer.ok) {
            if (answer.unknown) unknownProfile = { name, revision: previous.revision }
            if (answer.httpStatus === 409) await readProfile(captured)
            profileError = issue(answer.code, answer.unknown); return
          }
          const value = forumProfile(forumObject(answer.payload).profile)
          if (String(value.id) !== captured.id || value.display_name !== name || value.revision !== previous.revision + 1) throw new Error('FORUM_PROTOCOL_INVALID')
          profile = value; profileStatus = 'ready'; profileError = null
        } catch (_invalid: unknown) { if (ctx.valid(captured)) {
          unknownProfile = { name, revision: previous.revision }; profileError = issue('FORUM_PROTOCOL_INVALID', true)
        } }
        finally { if (ctx.valid(captured)) { saving = false; ctx.publish() } }
      })
    },
  }
}
