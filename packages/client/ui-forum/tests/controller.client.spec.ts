import type {} from '../src/client/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Context } from '@deepseek-ai/cordis'
import { createForumController } from '../src/client/controller.ts'
import { ForumFailure, type request } from '../src/client/api.ts'
import type { ForumProps } from '../src/client/types.ts'

const publicPost = {
  id: 'post-1',
  title: 'A useful idea',
  body: 'One discussion',
  author: { id: 1, display_name: 'Member' },
  created_at: 100,
  liked: false,
  like_count: 0,
  comment_count: 0,
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(fn => fn()))
})
const t: ForumProps['t'] = key => key
function fixture() {
  const accounts = createSnapshotStore<ReturnType<Context['creditsSession']['getSnapshot']>>({
    accountEpoch: 1,
    loaded: true,
    failure: null,
    balance: null,
    session: {
      signedIn: true,
      creditsPerYuan: 1000,
      account: { id: '1', phone: '' },
      accountOwner: 'a'.repeat(64),
    },
  })
  const store = new Map<string, string>(),
    storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
    }
  const send = vi.fn<typeof request>(async (_owner, path) =>
    path === '/config'
      ? { enabled: true }
      : path.includes('/comments')
        ? { items: [], next_cursor: '', has_more: false }
        : path.includes('?')
          ? { items: [publicPost], next_cursor: '', has_more: false }
          : { post: publicPost },
  )
  const controller = createForumController(accounts, { requestTimeoutMs: 1000, refreshMs: 300_000 }, t, {
    send,
    storage,
    uuid: () => 'publication-1',
  })
  cleanup.push(controller.start())
  controller.activate()
  return { controller, send, accounts, state: () => controller.hooks.forum.getSnapshot(), storage }
}
async function ready(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => {
    expect(f.state().enabled).toBe(true)
  })
}

describe('forum publication ownership', () => {
  it('retains an uncertain post and retries exactly the same key and body without automatic replay', async () => {
    const f = fixture()
    await ready(f)
    f.controller.edit(false, 'title', 'A useful idea')
    f.controller.edit(false, 'body', 'One discussion')
    f.send.mockImplementation(async (_o, path, method) => {
      if (method === 'POST') throw new ForumFailure('FORUM_NETWORK', true)
      return path === '/config'
        ? { enabled: true }
        : { items: [publicPost], next_cursor: '', has_more: false }
    })
    f.controller.publish(false)
    await vi.waitFor(() => {
      expect(f.state().draft.uncertain).toBe(true)
    })
    expect(f.state().error).toBe('unknown')
    expect(f.send.mock.calls.filter(c => c[2] === 'POST')).toHaveLength(1)
    f.controller.edit(false, 'body', 'changed')
    expect(f.state().draft.body).toBe('One discussion')
    f.send.mockImplementation(async (_o, path, method) =>
      method === 'POST' || path === '/posts/post-1'
        ? { post: publicPost, replayed: true }
        : path === '/config'
          ? { enabled: true }
          : { items: path.includes('/comments') ? [] : [publicPost], next_cursor: '', has_more: false },
    )
    f.controller.publish(false)
    await vi.waitFor(() => {
      expect(f.state().post?.id).toBe('post-1')
    })
    const writes = f.send.mock.calls.filter(c => c[2] === 'POST')
    expect(writes).toHaveLength(2)
    expect(writes[0]?.[3]).toEqual(writes[1]?.[3])
    expect(f.state().draft.body).toBe('')
  })
  it('does not send if the draft cannot be retained locally', async () => {
    const f = fixture()
    await ready(f)
    f.controller.edit(false, 'title', 'title')
    f.controller.edit(false, 'body', 'body')
    vi.spyOn(f.storage, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    f.controller.publish(false)
    await vi.waitFor(() => {
      expect(f.state().error).toBe('storage')
    })
    expect(f.send.mock.calls.filter(c => c[2] === 'POST')).toHaveLength(0)
  })
  it('removes deleted details and excludes late account responses after logout', async () => {
    const f = fixture()
    await ready(f)
    f.controller.open('post-1')
    await vi.waitFor(() => {
      expect(f.state().post?.id).toBe('post-1')
    })
    f.send.mockImplementation(async (_o, path) => {
      if (path === '/posts/post-1') throw new ForumFailure('FORUM_NOT_FOUND')
      return path === '/config' ? { enabled: true } : { items: [], next_cursor: '', has_more: false }
    })
    f.controller.refresh()
    await vi.waitFor(() => {
      expect(f.state().post).toBeNull()
    })
    f.accounts.set({
      ...f.accounts.getSnapshot(),
      accountEpoch: 2,
      session: { signedIn: false, creditsPerYuan: 1000 },
    })
    expect(f.state().posts).toEqual([])
    expect(f.state().signedIn).toBe(false)
  })
})

it('shows a confirmed comment even if the following read is unavailable', async () => {
  const f = fixture(); await ready(f); f.controller.open('post-1')
  await vi.waitFor(() =>{  expect(f.state().post?.id).toBe('post-1') })
  f.controller.edit(true, 'body', 'Visible receipt')
  const accepted = { id:'comment-1', post_id:'post-1', body:'Visible receipt', author:{ id:1,display_name:'Member' },created_at:100 }
  f.send.mockImplementation(async (_o,_path,method) => {
    if (method === 'POST') return { comment:accepted,replayed:false }
    throw new ForumFailure('FORUM_NETWORK',true)
  })
  f.controller.publish(true)
  await vi.waitFor(() =>{  expect(f.state().comments.some(c => c.id === 'comment-1')).toBe(true) })
  expect(f.state().reply.body).toBe('')
  await vi.waitFor(() =>{  expect(f.state().error).toBe('unavailable') })
  expect(f.state().comments[0]).toEqual(accepted)
})
