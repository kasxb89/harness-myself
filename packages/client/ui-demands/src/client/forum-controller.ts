/** Account-owned forum object model; posts, comments and likes never create AI sessions or wallet actions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { requestForum, type ForumOwner, type ForumRequest, type ForumResult } from './forum-api.ts'
import { createForumJournal, type ForumJournal, type ForumOperation } from './forum-pending.ts'
import type { ForumComment, ForumConfig, ForumFace, ForumIssue, ForumPage, ForumPost, ForumPostDraft, ForumState } from './forum-types.ts'
import * as wire from './forum-wire.ts'
import { createForumActivity } from './forum-activity.ts'
import { createForumMedia } from './forum-media.ts'
import type { ForumModelContext } from './forum-model-context.ts'
import type { ForumUploadJournal } from './forum-upload-journal.ts'
import type { ForumReplyTarget } from './forum-types.ts'

/** Validated local feature availability and bounded I/O/poll timings. */
export interface ForumControllerConfig {
  readonly enabled: boolean
  readonly requestTimeoutMs?: number
  readonly uploadTimeoutMs?: number
  readonly foregroundPollMs?: number
  readonly backgroundPollMs?: number
}
/** Isolated transport, persistence and clock seams; no credentials are exposed. */
export interface ForumControllerDependencies {
  readonly request?: typeof requestForum
  readonly journal?: ForumJournal
  readonly uuid?: () => string
  readonly now?: () => number
  readonly isForeground?: () => boolean
  readonly uploadJournal?: ForumUploadJournal
}
/** Stable model lifecycle and public commands. */
export interface ForumController extends ForumFace {
  readonly start: () => () => void
  readonly setVisible: (visible: boolean) => void
  readonly dispose: () => Promise<void>
}
interface Page<T> {
  items: T[]
  cursor: string
  hasMore: boolean
  status: 'loading' | 'ready' | 'error'
  loadingMore: boolean
  error: ForumIssue | null
  flight: AbortController | null
}
const page = <T>(): Page<T> => ({ items: [], cursor: '', hasMore: false, status: 'ready', loadingMore: false, error: null, flight: null })
const presentation = <T>(state: Page<T>): ForumPage<T> => ({ items: state.items, status: state.status,
  hasMore: state.hasMore, loadingMore: state.loadingMore, error: state.error })
const issue = (code: string, unknown = false, operationId: string | null = null): ForumIssue => ({ code, unknown, operationId })
const blank = (availability: ForumState['availability']): ForumState => ({ availability, accountId: null, config: null,
  error: null, posts: presentation(page()), selectedPostId: null, selectedPost: null, selectedPostStatus: 'ready',
  selectedPostError: null, comments: presentation(page()), commentDraft: '', activePostDraftScope: null, postDrafts: [], pending: [] })
const newest = <T extends { readonly id: string; readonly created_at: number }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))

/**
 * Create an independent forum model without subscribing until start.
 * @param accountSource - Existing shared product login state.
 * @param config - Validated local feature and timing limits.
 * @param deps - One-attempt transport and pre-send persistence.
 * @returns Observable forum commands with joined cancellation/disposal.
 */
export function createForumController(accountSource: Context['creditsSession'], config: ForumControllerConfig,
  deps: ForumControllerDependencies = {}): ForumController {
  for (const value of [config.requestTimeoutMs, config.uploadTimeoutMs, config.foregroundPollMs, config.backgroundPollMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000)) throw new Error('FORUM_CONFIG_INVALID')
  }
  const source = createSnapshotStore<ForumState>(blank(config.enabled ? 'loading' : 'unavailable'))
  const request = deps.request ?? requestForum, journal = deps.journal ?? createForumJournal(), now = deps.now ?? Date.now
  const uuid = (): string => wire.forumUuid((deps.uuid ?? randomUUID)())
  let active = false, visible = false, owner: ForumOwner | null = null, unsubscribe: (() => void) | undefined
  let disposed: Promise<void> | undefined, accountAbort = new AbortController(), timer: ReturnType<typeof setTimeout> | undefined
  let availability: ForumState['availability'] = config.enabled ? 'loading' : 'unavailable', error: ForumIssue | null = null
  let server: ForumConfig | null = null, unsupported = false, storageFailed = false, refreshTask: Promise<void> | undefined
  let mediaRestored = false
  let posts = page<ForumPost>(), selectedPostId: string | null = null, detailEpoch = 0
  let detailStatus: 'loading' | 'ready' | 'error' = 'ready', detailError: ForumIssue | null = null, activeDraft: string | null = null
  let changeVersion = 0
  const postRecords = new Map<string, ForumPost>(), versions = new Map<string, number>(), comments = new Map<string, Page<ForumComment>>()
  const confirmedCommentVersions = new Map<string, number>()
  const drafts = new Map<string, ForumPostDraft>(), commentDrafts = new Map<string, string>()
  const replyTargets = new Map<string, ForumReplyTarget>(), replyVersions = new Map<string, number>()
  const operations = new Map<string, ForumOperation>(), failures = new Map<string, ForumIssue>(), inflight = new Set<string>()
  const confirmed = new Set<string>(), likeChecked = new Set<string>()
  const tasks = new Set<Promise<void>>(), flights = new Set<AbortController>()
  const sameOwner = (captured: ForumOwner): boolean => {
    const state = accountSource.getSnapshot(), session = state.session
    return active && owner === captured && state.accountEpoch === captured.epoch && session?.signedIn === true
      && session.account?.id === captured.id && session.accountOwner === captured.owner
  }
  const pending = (scope: string, kind: ForumOperation['kind']): ForumOperation[] => [...operations.values()]
    .filter(item => item.scopeKey === scope && item.kind === kind && !confirmed.has(item.operationId))
  const commentPage = (id: string): Page<ForumComment> => {
    let state = comments.get(id)
    if (state === undefined) {
      state = page(); comments.set(id, state)
    }
    return state
  }
  const publish = (): void => {
    const current = selectedPostId === null ? null : postRecords.get(selectedPostId) ?? null
    source.set({ availability, accountId: owner?.id ?? null, config: server, error, posts: presentation(posts),
      selectedPostId, selectedPost: current, selectedPostStatus: detailStatus, selectedPostError: detailError,
      comments: presentation(selectedPostId === null ? page() : commentPage(selectedPostId)),
      commentDraft: selectedPostId === null ? '' : commentDrafts.get(selectedPostId) ?? '', activePostDraftScope: activeDraft,
      postDrafts: [...drafts.values()].map((draft) => {
        const op = pending(draft.scopeKey, 'post')[0]
        return { ...draft, locked: op !== undefined, sending: op !== undefined && inflight.has(op.operationId),
          error: op === undefined ? draft.error : failures.get(op.operationId) ?? null }
      }), pending: [...operations.values()].filter(item => !confirmed.has(item.operationId)).map((op) => {
        const body = wire.forumObject(wire.forumJson(op.body))
        return { operationId: op.operationId, scopeKey: op.scopeKey, postId: op.postId, kind: op.kind,
          title: op.kind === 'post' ? wire.forumText(body.title, 200) : '',
          body: op.kind === 'like' ? '' : wire.forumText(body.body, op.kind === 'post' ? 20_000 : 4000,
            Array.isArray(body.attachment_ids) && body.attachment_ids.length > 0),
          liked: op.kind === 'like' ? wire.forumBoolean(body.liked) : null, inflight: inflight.has(op.operationId),
          error: inflight.has(op.operationId) ? null : failures.get(op.operationId) ?? issue('FORUM_RESULT_UNKNOWN', true, op.operationId) }
      }), activity: activity.snapshot(), uploads: media.snapshot(),
      replyTarget: selectedPostId === null ? null : replyTargets.get(selectedPostId) ?? null })
  }
  const track = (work: () => Promise<void>): void => {
    const captured = owner
    const task = work().catch((_failure: unknown) => {
      if (captured !== null && sameOwner(captured)) { error = issue('FORUM_PROTOCOL_INVALID'); publish() }
    })
    tasks.add(task); void task.finally(() => { tasks.delete(task) })
  }
  const perform = async (captured: ForumOwner, input: Omit<ForumRequest, 'signal'>, signal?: AbortSignal): Promise<ForumResult> => {
    const flight = new AbortController(), accountSignal = accountAbort.signal, cancel = (): void => { flight.abort() }
    const deadlineState = { expired: false }
    const deadline = setTimeout(() => { deadlineState.expired = true; flight.abort() },
      input.blob === undefined ? config.requestTimeoutMs ?? 20_000 : config.uploadTimeoutMs ?? 120_000)
    flights.add(flight); accountSignal.addEventListener('abort', cancel, { once: true })
    signal?.addEventListener('abort', cancel, { once: true })
    if (!sameOwner(captured) || accountSignal.aborted || signal?.aborted === true) flight.abort()
    try {
      const answer = await request(captured, { ...input, signal: flight.signal })
      return deadlineState.expired ? { ok: false, code: 'FORUM_TIMEOUT', httpStatus: 0, unknown: input.method !== 'GET' } : answer
    } finally {
      clearTimeout(deadline); accountSignal.removeEventListener('abort', cancel)
      signal?.removeEventListener('abort', cancel); flights.delete(flight)
    }
  }
  const mergePost = (value: ForumPost, readVersion?: number): ForumPost => {
    const original = postRecords.get(value.id)
    if (original !== undefined && readVersion !== undefined && (versions.get(value.id) ?? 0) > readVersion) return original
    postRecords.set(value.id, value); posts.items = posts.items.map(item => item.id === value.id ? value : item)
    return value
  }
  const readPosts = async (captured: ForumOwner, more = false): Promise<void> => {
    const state = posts, version = changeVersion
    if (!sameOwner(captured) || unsupported || state.flight !== null || more && !state.hasMore) return
    const flight = new AbortController(); state.flight = flight; state.loadingMore = more; state.error = null
    if (state.items.length === 0) state.status = 'loading'
    publish()
    try {
      const query = new URLSearchParams({ limit: '30' }); if (more) query.set('cursor', state.cursor)
      const answer = await perform(captured, { method: 'GET', path: `/posts?${query}` }, flight.signal)
      if (!sameOwner(captured) || posts !== state || flight.signal.aborted) return
      if (!answer.ok) { state.status = 'error'; state.error = issue(answer.code); return }
      const result = wire.forumPage(answer.payload, wire.forumPost), values = new Map((more ? state.items : []).map(row => [row.id, row]))
      for (const item of result.items) values.set(item.id, mergePost(item, version))
      for (const item of state.items) if ((versions.get(item.id) ?? 0) > version) values.set(item.id, item)
      state.items = newest([...values.values()]); state.cursor = result.next_cursor; state.hasMore = result.has_more; state.status = 'ready'
    } catch (_protocol: unknown) {
      if (sameOwner(captured) && posts === state) { state.status = 'error'; state.error = issue('FORUM_PROTOCOL_INVALID') }
    } finally {
      if (sameOwner(captured) && posts === state) { state.flight = null; state.loadingMore = false; publish() }
    }
  }
  const readComments = async (captured: ForumOwner, id: string, more = false): Promise<void> => {
    const state = commentPage(id), version = changeVersion
    if (!sameOwner(captured) || state.flight !== null || more && !state.hasMore) return
    const flight = new AbortController(); state.flight = flight; state.loadingMore = more; state.error = null
    if (state.items.length === 0) state.status = 'loading'
    publish()
    try {
      const query = new URLSearchParams({ limit: '30' }); if (more) query.set('cursor', state.cursor)
      const answer = await perform(captured, { method: 'GET', path: `/posts/${id}/comments?${query}` }, flight.signal)
      if (!sameOwner(captured) || comments.get(id) !== state || flight.signal.aborted) return
      if (!answer.ok) { state.status = 'error'; state.error = issue(answer.code); return }
      const result = wire.forumPage(answer.payload, wire.forumComment)
      const values = new Map((more ? state.items : []).map(row => [row.id, row]))
      for (const item of result.items) { if (item.post_id !== id) throw new wire.ForumWireError(); values.set(item.id, item) }
      for (const item of state.items) if ((confirmedCommentVersions.get(item.id) ?? 0) > version) values.set(item.id, item)
      state.items = newest([...values.values()]); state.cursor = result.next_cursor; state.hasMore = result.has_more; state.status = 'ready'
    } catch (_protocol: unknown) {
      if (sameOwner(captured) && comments.get(id) === state) { state.status = 'error'; state.error = issue('FORUM_PROTOCOL_INVALID') }
    } finally {
      if (sameOwner(captured) && comments.get(id) === state) { state.flight = null; state.loadingMore = false; publish() }
    }
  }
  const readPost = async (captured: ForumOwner, id: string): Promise<void> => {
    const epoch = ++detailEpoch, version = changeVersion
    selectedPostId = id; activeDraft = null; detailStatus = 'loading'; detailError = null; publish()
    try {
      const answer = await perform(captured, { method: 'GET', path: `/posts/${id}` })
      if (!sameOwner(captured) || epoch !== detailEpoch || selectedPostId !== id) return
      if (!answer.ok) {
        if (answer.httpStatus === 403 || answer.httpStatus === 404) {
          postRecords.delete(id); comments.delete(id); replyTargets.delete(id)
          posts.items = posts.items.filter(item => item.id !== id)
        }
        detailStatus = 'error'; detailError = issue(answer.code); return
      }
      const post = wire.forumPost(wire.forumObject(answer.payload).post)
      if (post.id !== id) throw new wire.ForumWireError()
      mergePost(post, version); detailStatus = 'ready'; publish(); await readComments(captured, id)
    } catch (_protocol: unknown) {
      if (sameOwner(captured) && epoch === detailEpoch) { detailStatus = 'error'; detailError = issue('FORUM_PROTOCOL_INVALID') }
    } finally { if (sameOwner(captured) && epoch === detailEpoch) publish() }
  }
  const model: ForumModelContext = { owner: () => owner, valid: sameOwner, config: () => server, perform, publish, track }
  const activity = createForumActivity(model, { openPost: readPost, focusComment: (comment) => {
    const state = commentPage(comment.post_id)
    state.items = newest([...new Map([...state.items, comment].map(item => [item.id, item])).values()]); publish()
  } })
  const media = createForumMedia(model, { ...deps.uploadJournal === undefined ? {} : { journal: deps.uploadJournal }, uuid,
    canEdit: target => target.kind === 'post'
      ? drafts.get(target.scopeKey)?.postId === null && pending(target.scopeKey, 'post').length === 0
      : postRecords.has(target.postId) && pending(`post:${target.postId}`, 'comment').length === 0,
    reserved: id => [...operations.values()].some((operation) => {
      const body = wire.forumObject(wire.forumJson(operation.body))
      return Array.isArray(body.attachment_ids) && body.attachment_ids.includes(id)
    }),
    error: (value) => { error = value; if (value.code === 'FORUM_PENDING_STORAGE_FAILED') storageFailed = true; publish() },
  })
  const refreshAll = async (): Promise<void> => {
    if (refreshTask !== undefined) return refreshTask
    const captured = owner
    if (captured === null || !sameOwner(captured) || !config.enabled) return
    const task = (async () => {
      try {
        const answer = await perform(captured, { method: 'GET', path: '/config' })
        if (!sameOwner(captured)) return
        if (!answer.ok) {
          if (answer.httpStatus === 404) { availability = 'unavailable'; unsupported = true; error = null; return }
          availability = 'error'; error = issue(answer.code); return
        }
        server = wire.forumConfig(answer.payload); unsupported = false
        if (!mediaRestored) {
          try {
            for (const target of media.restore(captured)) if (target.kind === 'post' && !drafts.has(target.scopeKey)) {
              drafts.set(target.scopeKey, { scopeKey: target.scopeKey, title: '', body: '', createdAt: wire.forumInteger(now()),
                postId: null, sending: false, locked: false, error: null })
            }
            mediaRestored = true
          } catch (_storage: unknown) { storageFailed = true; error = issue('FORUM_PENDING_STORAGE_FAILED') }
        }
        availability = storageFailed ? 'error' : server.enabled ? 'ready' : 'disabled'
        if (!storageFailed) error = null
        publish(); await Promise.all([readPosts(captured), activity.refresh(captured)])
        if (sameOwner(captured) && selectedPostId !== null) await readPost(captured, selectedPostId)
      } catch (_protocol: unknown) {
        if (sameOwner(captured)) { availability = 'error'; error = issue('FORUM_PROTOCOL_INVALID') }
      } finally { if (sameOwner(captured)) publish() }
    })().finally(() => { if (refreshTask === task) refreshTask = undefined })
    refreshTask = task; return task
  }
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!active || owner === null || unsupported || !config.enabled
      || !visible && server?.capabilities.notifications !== true) return
    const foreground = deps.isForeground?.() ?? (typeof document === 'undefined'
      || document.visibilityState !== 'hidden' && document.hasFocus())
    timer = setTimeout(() => { timer = undefined; track(async () => {
      const captured = owner
      if (visible) await refreshAll()
      else if (captured !== null) await activity.background(captured)
      schedule()
    }) }, visible && foreground ? config.foregroundPollMs ?? 15_000 : config.backgroundPollMs ?? 60_000)
  }
  const save = (captured: ForumOwner, operation: ForumOperation): boolean => {
    if (!sameOwner(captured)) return false
    try { journal.put(captured, operation); operations.set(operation.operationId, operation); return true }
    catch (_storage: unknown) { storageFailed = true; error = issue('FORUM_PENDING_STORAGE_FAILED'); publish(); return false }
  }
  const remove = (captured: ForumOwner, operation: ForumOperation): void => {
    if (!sameOwner(captured)) return
    confirmed.add(operation.operationId)
    try {
      journal.remove(captured, operation.operationId); operations.delete(operation.operationId); failures.delete(operation.operationId)
    }
    catch (_storage: unknown) { storageFailed = true; error = issue('FORUM_PENDING_STORAGE_FAILED') }
  }
  const recordPostMutation = (post: ForumPost): void => {
    versions.set(post.id, ++changeVersion); mergePost(post)
  }
  const execute = async (operation: ForumOperation, recovering = false): Promise<void> => {
    const captured = owner
    if (captured === null || !sameOwner(captured) || inflight.has(operation.operationId) || confirmed.has(operation.operationId)) return
    inflight.add(operation.operationId); failures.delete(operation.operationId); publish()
    try {
      let answer: ForumResult
      if (recovering && operation.kind !== 'like' && server?.capabilities.receipt_lookup === true) {
        answer = await perform(captured, { method: 'GET', path: `/receipts?${new URLSearchParams({
          kind: operation.kind, client_request_id: operation.operationId,
        })}` })
        if (!sameOwner(captured)) return
        if (!answer.ok && answer.httpStatus !== 404) {
          failures.set(operation.operationId, issue(answer.code, true, operation.operationId)); return
        }
        if (!answer.ok) answer = await perform(captured, { method: operation.method, path: operation.path, body: operation.body })
      } else answer = await perform(captured, { method: operation.method, path: operation.path, body: operation.body })
      if (!sameOwner(captured)) return
      if (!answer.ok) { failures.set(operation.operationId, issue(answer.code, answer.unknown, operation.operationId)); return }
      const payload = wire.forumObject(answer.payload), body = wire.forumObject(wire.forumJson(operation.body))
      const imageIds = Array.isArray(body.attachment_ids) ? body.attachment_ids.map(wire.forumUuid) : []
      const checkImages = (value: ForumPost | ForumComment): void => {
        const actual = value.media ?? value.attachments ?? []
        if (actual.length !== imageIds.length || actual.some((item, index) => imageIds[index] !== item.id)) throw new wire.ForumWireError()
      }
      if (operation.kind === 'comment') {
        const comment = wire.forumComment(payload.comment)
        wire.forumBoolean(payload.replayed)
        if (comment.post_id !== operation.postId || String(comment.author.id) !== captured.id
          || comment.body !== String(body.body).trim() || (comment.reply_to_comment_id ?? '') !== (body.reply_to_comment_id ?? '')) {
          throw new wire.ForumWireError()
        }
        checkImages(comment); media.committed(captured, imageIds)
        if (replyTargets.get(comment.post_id)?.id === body.reply_to_comment_id) replyTargets.delete(comment.post_id)
        const state = commentPage(comment.post_id)
        state.items = newest([...new Map([...state.items, comment].map(item => [item.id, item])).values()]); state.status = 'ready'
        versions.set(comment.post_id, ++changeVersion); confirmedCommentVersions.set(comment.id, changeVersion)
        remove(captured, operation)
        const version = changeVersion, fresh = await perform(captured, { method: 'GET', path: `/posts/${comment.post_id}` })
        if (sameOwner(captured) && fresh.ok) {
          try {
            const post = wire.forumPost(wire.forumObject(fresh.payload).post)
            if (post.id !== comment.post_id) throw new wire.ForumWireError()
            mergePost(post, version)
          } catch (_readProtocol: unknown) { error = issue('FORUM_PROTOCOL_INVALID') }
        }
      } else {
        const post = wire.forumPost(payload.post)
        if (operation.kind === 'post') {
          wire.forumBoolean(payload.replayed)
          if (String(post.author.id) !== captured.id || post.title !== String(body.title).trim()
            || post.body !== String(body.body).trim()) {
            throw new wire.ForumWireError()
          }
          checkImages(post); media.committed(captured, imageIds)
          const draft = drafts.get(operation.scopeKey)
          if (draft !== undefined) drafts.set(operation.scopeKey, { ...draft, postId: post.id, error: null })
          posts.items = newest([...new Map([...posts.items, post].map(item => [item.id, item])).values()])
          if (activeDraft === operation.scopeKey) {
            activeDraft = null; selectedPostId = post.id; detailStatus = 'ready'; detailError = null
          }
        } else if (post.id !== operation.postId || post.liked !== body.liked) throw new wire.ForumWireError()
        recordPostMutation(post); remove(captured, operation)
      }
    } catch (_protocol: unknown) {
      if (sameOwner(captured)) failures.set(operation.operationId, issue('FORUM_PROTOCOL_INVALID', true, operation.operationId))
    } finally { if (sameOwner(captured)) { inflight.delete(operation.operationId); publish() } }
  }
  const checkLike = async (operation: ForumOperation): Promise<void> => {
    const captured = owner
    if (captured === null || !sameOwner(captured) || operation.postId === null || inflight.has(operation.operationId)) return
    inflight.add(operation.operationId); publish()
    try {
      const answer = await perform(captured, { method: 'GET', path: `/posts/${operation.postId}` })
      if (!sameOwner(captured)) return
      if (!answer.ok) { failures.set(operation.operationId, issue(answer.code, true, operation.operationId)); return }
      const post = wire.forumPost(wire.forumObject(answer.payload).post), desired = wire.forumObject(wire.forumJson(operation.body)).liked
      if (post.id !== operation.postId) throw new wire.ForumWireError()
      recordPostMutation(post)
      if (post.liked === desired) remove(captured, operation)
      else {
        likeChecked.add(operation.operationId)
        failures.set(operation.operationId, issue('FORUM_LIKE_NOT_CONFIRMED', false, operation.operationId))
      }
    } catch (_protocol: unknown) {
      if (sameOwner(captured)) failures.set(operation.operationId, issue('FORUM_PROTOCOL_INVALID', true, operation.operationId))
    } finally { if (sameOwner(captured)) { inflight.delete(operation.operationId); publish() } }
  }
  const clear = (): void => {
    accountAbort.abort(); accountAbort = new AbortController(); for (const flight of flights) flight.abort()
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    detailEpoch += 1; server = null; unsupported = false; storageFailed = false; error = null; refreshTask = undefined
    mediaRestored = false
    posts = page(); selectedPostId = null; detailStatus = 'ready'; detailError = null; activeDraft = null; changeVersion = 0
    postRecords.clear(); versions.clear(); comments.clear(); confirmedCommentVersions.clear(); drafts.clear(); commentDrafts.clear()
    replyTargets.clear(); replyVersions.clear(); activity.reset(); media.reset()
    operations.clear(); failures.clear(); inflight.clear(); confirmed.clear(); likeChecked.clear()
  }
  const observe = (): void => {
    const state = accountSource.getSnapshot(), session = state.session
    const next = session?.signedIn === true && session.account !== undefined && /^[1-9][0-9]*$/u.test(session.account.id)
      && Number.isSafeInteger(Number(session.account.id)) && typeof session.accountOwner === 'string'
      && /^[a-f0-9]{64}$/u.test(session.accountOwner)
      ? { id: session.account.id, owner: session.accountOwner, epoch: state.accountEpoch } : null
    if (owner?.id === next?.id && owner?.owner === next?.owner && owner?.epoch === next?.epoch) {
      if (next === null) { availability = !config.enabled ? 'unavailable' : state.loaded ? 'login-required' : 'loading'; publish() }
      return
    }
    clear(); owner = next
    availability = !config.enabled ? 'unavailable' : next === null ? state.loaded ? 'login-required' : 'loading' : 'loading'
    if (next !== null && config.enabled) {
      try {
        for (const operation of journal.read(next)) {
          operations.set(operation.operationId, operation)
          failures.set(operation.operationId, issue('FORUM_RESULT_UNKNOWN', true, operation.operationId))
          if (operation.kind === 'post') {
            const body = wire.forumObject(wire.forumJson(operation.body))
            drafts.set(operation.scopeKey, { scopeKey: operation.scopeKey, title: wire.forumText(body.title, 200),
              body: wire.forumText(body.body, 20_000, Array.isArray(body.attachment_ids) && body.attachment_ids.length > 0),
              createdAt: operation.createdAt, postId: null,
              sending: false, locked: true, error: null })
          }
        }
      } catch (_storage: unknown) { storageFailed = true; error = issue('FORUM_PENDING_STORAGE_FAILED') }
      track(async () => { await refreshAll(); schedule() })
    }
    publish()
  }
  const mutationReady = (): boolean => owner !== null && sameOwner(owner) && !storageFailed && !unsupported && server !== null
  const newOperation = (captured: ForumOwner, data: Omit<ForumOperation, 'version' | 'createdAt'>): ForumOperation | null => {
    const operation: ForumOperation = { ...data, version: 1, createdAt: wire.forumInteger(now()) }
    return save(captured, operation) ? operation : null
  }
  const dispose = (): Promise<void> => {
    if (disposed !== undefined) return disposed
    active = false; unsubscribe?.(); unsubscribe = undefined; owner = null; clear()
    source.set(blank(config.enabled ? 'login-required' : 'unavailable'))
    disposed = Promise.allSettled([...tasks]).then(() => undefined); return disposed
  }
  return {
    hooks: { forum: source },
    start: () => {
      if (disposed !== undefined) throw new Error('FORUM_CONTROLLER_DISPOSED')
      if (!active) { active = true; unsubscribe = accountSource.subscribe(observe); observe() }
      return () => { void dispose() }
    }, dispose,
    setVisible: (next) => { visible = next; if (active && next) track(async () => { await refreshAll(); schedule() }); else schedule() },
    refresh: () => { if (active) { unsupported = false; track(async () => { await refreshAll(); schedule() }) } },
    loadMorePosts: () => { const captured = owner; if (captured !== null) track(() => readPosts(captured, true)) },
    openPost: (id) => {
      try { wire.forumId(id) } catch (_input: unknown) { return }
      const captured = owner; if (captured !== null && server !== null && !unsupported) track(() => readPost(captured, id))
    },
    closePost: () => { selectedPostId = null; activeDraft = null; detailEpoch += 1; publish() },
    startPost: () => {
      if (!mutationReady() || server?.enabled !== true || !server.capabilities.immediate_publish) return
      const scopeKey = `post-draft:${uuid()}`
      drafts.set(scopeKey, { scopeKey, title: '', body: '', createdAt: wire.forumInteger(now()), postId: null,
        sending: false, locked: false, error: null })
      activeDraft = scopeKey; selectedPostId = null; detailEpoch += 1; publish()
    },
    openPostDraft: (scope) => { if (drafts.has(scope)) { activeDraft = scope; selectedPostId = null; detailEpoch += 1; publish() } },
    updatePostDraft: (scope, patch) => {
      const draft = drafts.get(scope)
      if (draft === undefined || draft.postId !== null || pending(scope, 'post').length > 0) return
      drafts.set(scope, { ...draft, ...patch, error: null }); publish()
    },
    publishPost: (scope) => {
      const captured = owner
      if (captured === null || !mutationReady()) return
      const original = pending(scope, 'post')[0]
      if (original !== undefined) { track(() => execute(original, true)); return }
      const draft = drafts.get(scope)
      if (draft === undefined || draft.postId !== null) return
      try {
        if (server?.enabled !== true || !server.capabilities.immediate_publish) throw new Error('FORUM_CLOSED')
        const images = media.ids({ kind: 'post', scopeKey: scope })
        const title = wire.forumText(draft.title, 200), body = wire.forumText(draft.body, 20_000, images.length > 0), operationId = uuid()
        const operation = newOperation(captured, { operationId, scopeKey: scope, postId: null, kind: 'post', method: 'POST', path: '/posts',
          body: JSON.stringify({ client_request_id: operationId, title, body, ...images.length === 0 ? {} : { attachment_ids: images } }) })
        if (operation !== null) track(() => execute(operation))
      } catch (failure: unknown) {
        const code = failure instanceof Error && ['FORUM_CLOSED', 'FORUM_UPLOAD_PENDING', 'FORUM_ATTACHMENT_INVALID'].includes(failure.message)
          ? failure.message : 'FORUM_INVALID_INPUT'
        drafts.set(scope, { ...draft, error: issue(code) })
        publish()
      }
    },
    updateCommentDraft: (id, body) => {
      try { wire.forumId(id); wire.forumText(body, 4000, true) } catch (_input: unknown) { return }
      if (postRecords.has(id)) { commentDrafts.set(id, body); publish() }
    },
    sendComment: (id) => {
      const captured = owner
      if (captured === null || !mutationReady() || !postRecords.has(id)) return
      if (server?.enabled !== true || !server.capabilities.comments) { commentPage(id).error = issue('FORUM_CLOSED'); publish(); return }
      const body = commentDrafts.get(id) ?? ''
      let images: readonly string[]
      try { images = media.ids({ kind: 'comment', postId: id }) }
      catch (failure: unknown) {
        commentPage(id).error = issue(failure instanceof Error && failure.message === 'FORUM_ATTACHMENT_INVALID'
          ? failure.message : 'FORUM_UPLOAD_PENDING'); publish(); return
      }
      if (body.trim() === '' && images.length === 0) return
      const target = replyTargets.get(id)
      if (target !== undefined && server.capabilities.comment_replies !== true) { commentPage(id).error = issue('FORUM_INVALID_INPUT'); publish(); return }
      const operationId = uuid(), operation = newOperation(captured, { operationId, scopeKey: `post:${id}`, postId: id,
        kind: 'comment', method: 'POST', path: `/posts/${id}/comments`, body: JSON.stringify({ client_request_id: operationId, body,
          ...images.length === 0 ? {} : { attachment_ids: images }, ...target === undefined ? {} : { reply_to_comment_id: target.id } }) })
      if (operation !== null) { commentDrafts.set(id, ''); publish(); track(() => execute(operation)) }
    },
    loadMoreComments: (id) => {
      const captured = owner
      if (captured !== null && postRecords.has(id)) track(() => readComments(captured, id, true))
    },
    setLiked: (id, liked) => {
      const captured = owner, current = postRecords.get(id)
      if (captured === null || !mutationReady() || current === undefined) return
      if (server?.enabled !== true || !server.capabilities.likes) { error = issue('FORUM_CLOSED'); publish(); return }
      const existing = pending(`post:${id}`, 'like')[0]
      if (existing !== undefined) return
      if (current.liked === liked) return
      const operationId = uuid(), operation = newOperation(captured, { operationId, scopeKey: `post:${id}`, postId: id,
        kind: 'like', method: 'PUT', path: `/posts/${id}/like`, body: JSON.stringify({ liked: wire.forumBoolean(liked) }) })
      if (operation !== null) track(() => execute(operation))
    },
    retryOperation: (id) => {
      const operation = operations.get(id)
      if (operation === undefined || confirmed.has(id) || !mutationReady()) return
      if (operation.kind === 'like' && !likeChecked.has(id)) track(() => checkLike(operation))
      else { likeChecked.delete(id); track(() => execute(operation, true)) }
    },
    setFeedScope: activity.setScope, loadMoreOwnPosts: activity.loadMoreOwnPosts, loadMoreOwnComments: activity.loadMoreOwnComments,
    refreshNotifications: activity.refreshNotifications, loadMoreNotifications: activity.loadMoreNotifications,
    markNotificationsRead: activity.markRead, openNotification: activity.openNotification, openHistoryComment: activity.openComment,
    updateNickname: activity.updateNickname,
    setReplyTarget: (postId, commentId) => {
      const captured = owner
      if (captured === null || !mutationReady() || server?.capabilities.comment_replies !== true
        || !postRecords.has(postId) || pending(`post:${postId}`, 'comment').length > 0) return
      const version = (replyVersions.get(postId) ?? 0) + 1; replyVersions.set(postId, version)
      if (commentId === null) { replyTargets.delete(postId); publish(); return }
      try { wire.forumId(commentId) } catch (_input: unknown) { return }
      track(async () => {
        const known = commentPage(postId).items.find(item => item.id === commentId)
        const answer = known === undefined ? await perform(captured, { method: 'GET', path: `/posts/${postId}/comments/${commentId}` }) : null
        if (!sameOwner(captured) || replyVersions.get(postId) !== version || pending(`post:${postId}`, 'comment').length > 0) return
        if (answer !== null && !answer.ok) { commentPage(postId).error = issue(answer.code); publish(); return }
        const comment = known ?? wire.forumComment(wire.forumObject(answer?.ok === true ? answer.payload : null).comment)
        if (comment.id !== commentId || comment.post_id !== postId) throw new wire.ForumWireError()
        replyTargets.set(postId, { id: comment.id, postId, author: comment.author, body: comment.body }); publish()
      })
    },
    addAttachments: media.add, retryAttachment: media.retry, removeAttachment: media.remove, contentUrl: media.contentUrl,
  }
}
