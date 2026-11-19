/** Account-owned forum reads and immutable publication receipts, with no AI model requests. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { comment, ForumFailure, page, post, request, type Owner } from './api.ts'
import type { Draft, ForumFace, ForumProps, ForumState } from './types.ts'

const blank = (): Draft => ({ key: '', title: '', body: '', pending: false, uncertain: false })
const initial = (): ForumState => ({
  signedIn: false,
  enabled: false,
  loading: false,
  busy: false,
  posts: [],
  post: null,
  comments: [],
  feedCursor: '',
  commentsCursor: '',
  error: null,
  composing: false,
  draft: blank(),
  reply: blank(),
})
/** Transport and polling configuration owned by the forum plugin. */
export interface ForumConfig {
  readonly requestTimeoutMs: number
  readonly refreshMs: number
}
/** Replaceable boundary adapters for behavior tests. */
export interface Dependencies {
  readonly send?: typeof request
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>
  readonly uuid?: () => string
}

/**
 * Own account-bound community state and publication keys across remounts.
 * @param accounts - Existing non-secret product login source.
 * @param config - Validated deadlines and visible-page refresh cadence.
 * @param t - Forum dictionary.
 * @param deps - Optional test boundaries.
 * @returns Slot face and a lifecycle that aborts and joins owned requests on disposal.
 */
export function createForumController(
  accounts: Pick<Context['creditsSession'], 'getSnapshot' | 'subscribe'>,
  config: ForumConfig,
  t: ForumProps['t'],
  deps: Dependencies = {},
): ForumFace & { start: () => () => Promise<void> } {
  const source = createSnapshotStore<{ -readonly [K in keyof ForumState]: ForumState[K] }>(initial()),
    send = deps.send ?? request,
    uuid = deps.uuid ?? randomUUID
  const storage = deps.storage ?? globalThis.localStorage
  let owner: Owner | null = null,
    selected: string | null = null,
    active = false,
    generation = 0,
    reading: number | null = null,
    revision = 0
  let writeError: string | null = null
  let life = new AbortController(),
    timer: ReturnType<typeof setInterval> | undefined
  const operations = new Set<Promise<void>>()
  const update = (fn: Parameters<typeof source.update>[0]): void => {
    source.update(fn)
  }
  const current = (captured: Owner): boolean => owner === captured && !life.signal.aborted
  const key = (captured: Owner): string => `yunshu.forum.v1:${captured.id}:${captured.owner}`
  const retain = (captured: Owner): void => {
    const s = source.getSnapshot()
    storage.setItem(key(captured), JSON.stringify({ draft: s.draft, reply: s.reply, postId: selected }))
    if (selected) storage.setItem(key(captured) + ':reply:' + selected, JSON.stringify(s.reply))
  }
  const readDraft = (v: unknown): Draft => {
    if (!v || typeof v !== 'object') return blank()
    const row = v as Record<string, unknown>
    if (
      typeof row.key !== 'string' ||
      row.key.length > 80 ||
      typeof row.title !== 'string' ||
      row.title.length > 800 ||
      typeof row.body !== 'string' ||
      row.body.length > 80_000
    )
      return blank()
    return {
      key: row.key,
      title: row.title,
      body: row.body,
      pending: false,
      uncertain: row.pending === true || row.uncertain === true,
    }
  }
  const track = (work: () => Promise<void>): void => {
    const task = work()
    operations.add(task)
    void task.finally(() => operations.delete(task))
  }
  const call = async (
    captured: Owner,
    path: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    body?: unknown,
  ) => {
    const signal = AbortSignal.any([life.signal, AbortSignal.timeout(config.requestTimeoutMs)])
    const result = await send(captured, path, method, body, signal)
    if (!current(captured)) throw new ForumFailure('ACCOUNT_CHANGED', true)
    return result
  }
  const failure = (error: unknown, writing = false): string =>
    error instanceof ForumFailure && error.code === 'FORUM_NOT_FOUND'
      ? t('removed')
      : error instanceof ForumFailure && error.code === 'FORUM_CLOSED'
        ? t('closed')
        : error instanceof ForumFailure && error.code === 'FORUM_REQUEST_CONFLICT'
          ? t('conflict')
          : writing
            ? t(error instanceof ForumFailure && error.uncertain ? 'unknown' : 'publishFailed')
            : t('unavailable')
  const refresh = async (): Promise<void> => {
    const captured = owner
    if (!captured || reading === generation) return
    reading = generation
    const stamp = generation,
      before = revision,
      id = selected
    update((s) => {
      s.loading = s.posts.length === 0 && s.post === null
    })
    try {
      const cfg = await call(captured, '/config')
      if (typeof cfg.enabled !== 'boolean') throw new ForumFailure('FORUM_PROTOCOL')
      const list = page(await call(captured, '/posts?limit=30'), post)
      const detail = id === null ? null : post((await call(captured, `/posts/${id}`)).post)
      const replies =
        id === null ? null : page(await call(captured, `/posts/${id}/comments?limit=30`), comment)
      if (stamp !== generation || before !== revision) return
      update((s) => {
        s.enabled = cfg.enabled === true
        s.posts = list.items
        s.feedCursor = list.cursor
        s.error = writeError ?? (s.draft.uncertain || s.reply.uncertain ? t('unknown') : null)
        if (detail !== null && replies !== null) {
          s.post = detail
          s.comments = replies.items
          s.commentsCursor = replies.cursor
        }
      })
    } catch (error) {
      if (current(captured) && stamp === generation && before === revision) {
        if (error instanceof ForumFailure && error.code === 'FORUM_NOT_FOUND') {
          selected = null
          update((s) => {
            s.post = null
            s.posts = s.posts.filter(p => p.id !== id)
            s.comments = []
            s.reply = blank()
          })
        }
        update((s) => {
          s.error = failure(error)
        })
      }
    } finally {
      if (reading === stamp) reading = null
      if (current(captured)) {
        update((s) => {
          s.loading = false
        })
        if (active && (stamp !== generation || before !== revision)) track(refresh)
      }
    }
  }
  const observe = (): void => {
    const snapshot = accounts.getSnapshot(),
      session = snapshot.session
    const next =
      session?.signedIn === true && session.account && session.accountOwner
        ? { id: session.account.id, owner: session.accountOwner, epoch: snapshot.accountEpoch }
        : null
    if (owner?.id === next?.id && owner?.owner === next?.owner && owner?.epoch === next?.epoch) return
    life.abort()
    life = new AbortController()
    owner = next
    generation++
    selected = null
    writeError = null
    source.set({ ...initial(), signedIn: next !== null })
    if (next) {
      try {
        const raw = storage.getItem(key(next))
        if (raw && raw.length <= 200_000) {
          const saved: unknown = JSON.parse(raw)
          if (saved && typeof saved === 'object') {
            const row = saved as Record<string, unknown>
            selected =
              typeof row.postId === 'string' && /^[A-Za-z0-9_-]{1,40}$/u.test(row.postId) ? row.postId : null
            update((s) => {
              s.draft = readDraft(row.draft)
              s.reply = readDraft(row.reply)
              s.composing = s.draft.body !== '' || s.draft.title !== ''
            })
          }
        }
      } catch (_storage: unknown) {
        update((s) => {
          s.error = t('storage')
        })
      }
      if (active) track(refresh)
    }
  }
  const publish = async (reply: boolean): Promise<void> => {
    const captured = owner,
      state = source.getSnapshot(),
      id = selected
    if (!captured || state.busy || !state.enabled || (reply && id === null)) return
    const draft = reply ? state.reply : state.draft
    if (!draft.body.trim() || (!reply && !draft.title.trim())) return
    const pending: Draft = { ...draft, key: draft.key || uuid(), pending: true }
    update((s) => {
      s.busy = true
      s.error = null
      if (reply) s.reply = pending
      else s.draft = pending
    })
    try {
      retain(captured)
    } catch (_storage: unknown) {
      update((s) => {
        s.busy = false
        if (reply) s.reply = { ...pending, pending: false }
        else s.draft = { ...pending, pending: false }
        s.error = t('storage')
      })
      return
    }
    revision++
    writeError = null
    try {
      const result = await call(captured, reply ? `/posts/${id}/comments` : '/posts', 'POST', {
        client_request_id: pending.key,
        body: pending.body,
        ...(reply ? {} : { title: pending.title }),
      })
      if (reply) {
        const published = comment(result.comment)
        update((s) => {
          const known = s.comments.some(row => row.id === published.id)
          s.comments = [published, ...s.comments.filter(row => row.id !== published.id)]
          if (s.post && !known && result.replayed !== true) s.post = { ...s.post, comment_count: s.post.comment_count + 1 }
        })
      } else {
        const published = post(result.post)
        selected = published.id
        generation++
        update((s) => {
          s.post = published
          s.comments = []
        })
      }
      update((s) => {
        if (reply) s.reply = blank()
        else {
          s.draft = blank()
          s.composing = false
        }
        s.error = null
      })
      try {
        retain(captured)
      } catch (_storage: unknown) {
        update((s) => {
          s.error = t('storage')
        })
      }
    } catch (error) {
      if (current(captured)) {
        writeError = failure(error, true)
        update((s) => {
          const failed = {
            ...pending,
            pending: false,
            uncertain: error instanceof ForumFailure && error.uncertain,
          }
          if (reply) s.reply = failed
          else s.draft = failed
          s.error = writeError
        })
      }
    } finally {
      if (current(captured)) {
        update((s) => {
          s.busy = false
        })
        await refresh()
      }
    }
  }
  return {
    hooks: { forum: source },
    start() {
      const unsub = accounts.subscribe(observe)
      observe()
      timer = setInterval(() => {
        if (active && !source.getSnapshot().busy) track(refresh)
      }, config.refreshMs)
      return async () => {
        active = false
        unsub()
        clearInterval(timer)
        life.abort()
        owner = null
        await Promise.allSettled(operations)
      }
    },
    activate() {
      active = true
      track(refresh)
      return () => {
        active = false
      }
    },
    refresh() {
      track(refresh)
    },
    open(id) {
      if (source.getSnapshot().busy) return
      if (selected !== id) {
        let restored = blank()
        if (owner) {
          try {
            retain(owner)
            const raw = id ? storage.getItem(key(owner) + ':reply:' + id) : null
            if (raw && raw.length <= 40_000) restored = readDraft(JSON.parse(raw) as unknown)
          } catch (_storage: unknown) {
            writeError = t('storage')
          }
        }
        selected = id
        generation++
        update((s) => {
          s.post = s.posts.find(p => p.id === id) ?? null
          s.comments = []
          s.reply = restored
          s.error = null
        })
        if (owner) {
          try {
            retain(owner)
          } catch (_storage: unknown) {
            update((s) => {
              s.error = t('storage')
            })
          }
        }
      }
      track(refresh)
    },
    compose(open) {
      update((s) => {
        s.composing = open
      })
    },
    edit(reply, field, value) {
      const s = source.getSnapshot(),
        draft = reply ? s.reply : s.draft
      if (draft.pending || draft.uncertain) return
      writeError = null
      update((next) => {
        const valueDraft = { ...draft, [field]: value, key: '' }
        if (reply) next.reply = valueDraft
        else next.draft = valueDraft
      })
      if (owner) {
        try {
          retain(owner)
        } catch (_storage: unknown) {
          update((next) => {
            next.error = t('storage')
          })
        }
      }
    },
    publish(reply) {
      track(() => publish(reply))
    },
    like(id) {
      const captured = owner,
        s = source.getSnapshot(),
        target = s.post?.id === id ? s.post : s.posts.find(p => p.id === id)
      if (!captured || s.busy || !s.enabled || !target) return
      update((next) => {
        next.busy = true
      })
      revision++
      track(async () => {
        try {
          const updated = post(
            (await call(captured, `/posts/${id}/like`, 'PUT', { liked: !target.liked })).post,
          )
          update((next) => {
            next.posts = next.posts.map(p => (p.id === id ? updated : p))
            if (next.post?.id === id) next.post = updated
          })
        } catch (_error: unknown) {
          if (current(captured))
            update((next) => {
              next.error = t('likeFailed')
            })
        } finally {
          if (current(captured)) {
            update((next) => {
              next.busy = false
            })
            await refresh()
          }
        }
      })
    },
    more(comments) {
      const captured = owner,
        s = source.getSnapshot(),
        id = selected,
        cursor = comments ? s.commentsCursor : s.feedCursor
      if (!captured || s.busy || !cursor || (comments && !id)) return
      const stamp = generation
      update((next) => {
        next.busy = true
      })
      track(async () => {
        try {
          const path = comments ? `/posts/${id}/comments` : '/posts'
          const payload = await call(captured, `${path}?limit=30&cursor=${encodeURIComponent(cursor)}`)
          if (stamp !== generation) return
          if (comments) {
            const p = page(payload, comment)
            update((next) => {
              const ids = new Set(next.comments.map(c => c.id))
              next.comments = [...next.comments, ...p.items.filter(c => !ids.has(c.id))]
              next.commentsCursor = p.cursor
            })
          } else {
            const p = page(payload, post)
            update((next) => {
              const ids = new Set(next.posts.map(c => c.id))
              next.posts = [...next.posts, ...p.items.filter(c => !ids.has(c.id))]
              next.feedCursor = p.cursor
            })
          }
        } catch (error) {
          if (current(captured))
            update((next) => {
              next.error = failure(error)
            })
        } finally {
          if (current(captured))
            update((next) => {
              next.busy = false
            })
        }
      })
    },
  }
}
