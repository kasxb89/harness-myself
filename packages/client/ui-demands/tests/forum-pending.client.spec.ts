/** Frozen forum submissions are isolated from community/demand journals and replacement accounts. */
import { describe, expect, it } from 'vitest'
import { createForumJournal, parseForumOperation, type ForumOperation } from '../src/client/forum-pending.ts'
import { forumMemory } from './forum-model-fixtures.client.ts'
const owner = { id: '1', owner: 'a'.repeat(64) }, uuid = '00000000-0000-4000-8000-000000000001'
function original(): ForumOperation {
  return { version: 1, operationId: uuid, scopeKey: 'post-draft:original', postId: null, kind: 'post', method: 'POST',
    path: '/posts', body: JSON.stringify({ client_request_id: uuid, title: 'Original title', body: 'Original body' }), createdAt: 100 }
}
describe('forum pending journal', () => {
  it('persists the exact original request independently by account ID and login owner', () => {
    const memory = forumMemory(), journal = createForumJournal(memory)
    journal.put(owner, original()); expect(journal.read(owner)).toEqual([original()])
    expect([...memory.data.keys()][0]).toContain('yunshu.forum.pending.v1:')
    expect(journal.read({ ...owner, id: '2' })).toEqual([])
    expect(journal.read({ ...owner, owner: 'b'.repeat(64) })).toEqual([])
    expect(() =>{  journal.put(owner, { ...original(), body: original().body.replace('Original body', 'Changed body') }) }).toThrow('FORUM_PENDING_BODY_CHANGED')
    journal.remove(owner, uuid); expect(journal.read(owner)).toEqual([])
  })
  it('binds comments to one parent and stores like intent without inventing a server nonce field', () => {
    const postId = '00000000-0000-4000-8000-000000001001'
    const comment: ForumOperation = { ...original(), kind: 'comment', scopeKey: `post:${postId}`, postId,
      path: `/posts/${postId}/comments`, body: JSON.stringify({ client_request_id: uuid, body: 'Comment' }) }
    expect(parseForumOperation(comment)).toEqual(comment)
    expect(() => parseForumOperation({ ...comment, postId: 'other-parent' })).toThrow()
    const like: ForumOperation = { ...comment, kind: 'like', method: 'PUT', path: `/posts/${postId}/like`, body: '{"liked":true}' }
    expect(parseForumOperation(like)).toEqual(like)
    expect(() => parseForumOperation({ ...like, body: JSON.stringify({ liked: true, client_request_id: uuid }) })).toThrow()
    expect(() => parseForumOperation({ ...comment, body: JSON.stringify({ client_request_id: uuid, body: 'Comment', title: 'Not stored' }) })).toThrow()
  })
  it('fails visibly on corruption and storage failure before a mutation can be sent', () => {
    const memory = forumMemory(), journal = createForumJournal(memory)
    journal.put(owner, original()); const key = [...memory.data.keys()][0]
    if (key === undefined) throw new Error('Missing storage key')
    memory.data.set(key, '{corrupt'); expect(() => journal.read(owner)).toThrow()
    memory.data.clear(); memory.setItem = () => { throw new Error('Storage refused') }
    expect(() =>{  journal.put(owner, original()) }).toThrow('Storage refused')
  })
})
