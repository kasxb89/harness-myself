import { describe, expect, it } from 'vitest'
import { FORUM_ERRORS, forumId, forumQuery, forumRequest, forumResponse } from '../src/forum-protocol.ts'
import { DemandProtocolError, demandObject } from '../src/demand-protocol.ts'

const ids = {
  post: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  comment: '33333333-3333-4333-8333-333333333333',
}
const account = { id: '42', owner: 'captured-owner' }
const success = (data: unknown): unknown => ({ success: true, data })
const configuration = () => ({ revision: 0, enabled: false,
  capabilities: { immediate_publish: true, likes: true, comments: true } })
const post = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ids.post, title: '分享一个做法', body: '这里是完整正文', author: { id: 42, display_name: '' },
  created_at: 1_795_046_400, like_count: 0, comment_count: 0, liked: false, ...overrides,
})
const comment = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ids.comment, post_id: ids.post, body: '补充一个例子', author: { id: 42, display_name: '示例' },
  created_at: 1_795_046_401, ...overrides,
})
const response = (kind: string, data: unknown, resourceId?: string) =>
  forumResponse(kind, success(data), account, resourceId === undefined ? {} : { resourceId })

describe('forum text posts, comments and desired-state likes', () => {
  it('accepts UUID resource segments and rejects paths or other resource families', () => {
    expect(forumId(ids.post)).toBe(ids.post)
    for (const id of ['../posts', `${ids.post}/comments`, `${ids.post}?admin=1`, 'official-demand', '', 42, null]) {
      expect(() => forumId(id)).toThrow(DemandProtocolError)
    }
  })

  it('projects the direct revision-zero config without requiring a community schema version', () => {
    const config = configuration()
    expect(response('config', { ...config, schema_version: 99, secret: 'hidden', capabilities: {
      ...config.capabilities, uploads: true, private_participant_messages: true,
    } })).toEqual(config)
    expect(() => response('config', { config })).toThrow(DemandProtocolError)
  })

  it('requires a nonnegative config revision and all boolean capabilities', () => {
    for (const revision of [-1, 0.5, '1', undefined]) {
      expect(() => response('config', { ...configuration(), revision })).toThrow(DemandProtocolError)
    }
    for (const key of ['immediate_publish', 'likes', 'comments']) {
      expect(() => response('config', { ...configuration(), capabilities: {
        ...configuration().capabilities, [key]: 'true',
      } })).toThrow(DemandProtocolError)
    }
    expect(() => response('config', { ...configuration(), enabled: 0 })).toThrow(DemandProtocolError)
  })

  it('forwards only the original post submission key, title and body', () => {
    const input = { client_request_id: 'post-operation', title: '  原始标题  ', body: '\n保留原始正文\n',
      author_id: 99, phone: 'hidden', token: 'hidden', publish_to_community: true, attachment_ids: [ids.comment],
      media_url: 'https://hidden.invalid', review: 'approved', schema_version: 1 }
    expect(forumRequest('create-post', input)).toEqual({ client_request_id: 'post-operation',
      title: '  原始标题  ', body: '\n保留原始正文\n' })
  })

  it('counts post title, body and durable key limits in Unicode scalar values', () => {
    const input = { client_request_id: '😀'.repeat(80), title: '😀'.repeat(200), body: '😀'.repeat(20_000) }
    expect(forumRequest('create-post', input)).toEqual(input)
    for (const [key, maximum] of [['client_request_id', 80], ['title', 200], ['body', 20_000]] as const) {
      expect(() => forumRequest('create-post', { ...input, [key]: '😀'.repeat(maximum + 1) })).toThrow(DemandProtocolError)
    }
  })

  it('requires nonblank post fields and object request bodies', () => {
    const input = { client_request_id: 'post-operation', title: '标题', body: '正文' }
    for (const key of ['client_request_id', 'title', 'body']) {
      for (const value of [undefined, '', ' \n\t ', 1, null]) {
        expect(() => forumRequest('create-post', { ...input, [key]: value })).toThrow(DemandProtocolError)
      }
    }
    for (const value of [null, [], 'body']) expect(() => forumRequest('create-post', value)).toThrow(DemandProtocolError)
  })

  it('omits comment titles and media fields while preserving the bounded original body', () => {
    const input = { client_request_id: 'comment-operation', body: '😀'.repeat(4000) }
    expect(forumRequest('create-comment', { ...input, title: '不发送', post_id: ids.other,
      attachments: [ids.comment], storage_path: '/hidden', author_id: 99 })).toEqual(input)
    expect(() => forumRequest('create-comment', { ...input, body: '😀'.repeat(4001) })).toThrow(DemandProtocolError)
    expect(() => forumRequest('create-comment', { ...input, client_request_id: '😀'.repeat(81) })).toThrow(DemandProtocolError)
    expect(() => forumRequest('create-comment', { ...input, body: ' \n ' })).toThrow(DemandProtocolError)
    expect(() => forumRequest('create-comment', { body: '正文' })).toThrow(DemandProtocolError)
  })

  it('accepts only the explicit boolean desired state for the PUT like body', () => {
    for (const liked of [true, false]) {
      expect(forumRequest('like', { liked, increment: 1, client_request_id: 'unused', like_count: 99,
        user_id: 99, token: 'hidden' })).toEqual({ liked })
    }
    for (const liked of [undefined, null, 0, 1, 'true', 'false']) {
      expect(() => forumRequest('like', { liked })).toThrow(DemandProtocolError)
    }
  })

  it('keeps only bounded cursor and limit queries on post and comment lists', () => {
    for (const kind of ['posts', 'comments']) {
      const query = new URLSearchParams({ cursor: 'a'.repeat(256), limit: '100' })
      expect(forumQuery(kind, query).toString()).toBe(query.toString())
      expect(forumQuery(kind, new URLSearchParams({ cursor: '', limit: '1' })).get('cursor')).toBe('')
      expect(forumQuery(kind, new URLSearchParams()).toString()).toBe('')
    }
  })

  it('rejects duplicate, privileged, search and malformed list queries', () => {
    const queries = [new URLSearchParams({ cursor: 'a'.repeat(257) }), new URLSearchParams('cursor=a&cursor=b'),
      new URLSearchParams('limit=1&limit=2'), ...['0', '101', '-1', '1.5', '1e2', ''].map(limit => new URLSearchParams({ limit })),
      ...['q', 'review', 'reviewed', 'deleted', 'author_id', 'user_id', 'post_id', 'owner'].map(key => new URLSearchParams({ [key]: '42' }))]
    for (const kind of ['posts', 'comments']) {
      for (const query of queries) expect(() => forumQuery(kind, query)).toThrow(DemandProtocolError)
    }
    for (const kind of ['config', 'post', 'create-post', 'create-comment', 'like']) {
      expect(() => forumQuery(kind, new URLSearchParams({ limit: '1' }))).toThrow(DemandProtocolError)
    }
  })

  it('requires the upstream success/data envelope and operation-specific wrappers', () => {
    for (const input of [{ post: post() }, { success: false, data: { post: post() } },
      { success: 'true', data: { post: post() } }, { success: true, payload: { post: post() } },
      { success: true, data: null }, { success: true, data: [] }]) {
      expect(() => forumResponse('post', input, account, { resourceId: ids.post })).toThrow(DemandProtocolError)
    }
    expect(() => response('post', post(), ids.post)).toThrow(DemandProtocolError)
    expect(() => response('create-comment', { post: post(), replayed: false }, ids.post)).toThrow(DemandProtocolError)
  })

  it('projects exact public post fields and removes nested account, moderation and media data', () => {
    const source = post({ author: { id: 42, display_name: '', phone: 'hidden', email: 'hidden', token: 'hidden' },
      schema_version: 1, updated_at: 2, view_count: 9, reviewed_at: 3, delete_reason: 'hidden',
      private_text: 'hidden', attachments: [ids.comment], media_url: 'https://hidden.invalid', storage_path: '/hidden' })
    expect(response('post', { post: source, request_id: 'hidden' }, ids.post)).toEqual({ post: post() })
  })

  it('validates post identities, authors, timestamps, counts and viewer-liked booleans', () => {
    const invalid = [{ id: 'not-a-uuid' }, { author: { id: 0, display_name: '' } },
      { author: { id: '42', display_name: '' } }, { author: { id: 42 } }, { created_at: -1 },
      { like_count: -1 }, { comment_count: 0.5 }, { liked: 1 }, { title: '😀'.repeat(201) },
      { body: '😀'.repeat(20_001) }]
    for (const fields of invalid) expect(() => response('post', { post: post(fields) }, ids.post)).toThrow(DemandProtocolError)
    const maximum = post({ title: '😀'.repeat(200), body: '😀'.repeat(20_000), like_count: 2, comment_count: 3, liked: true })
    expect(response('post', { post: maximum }, ids.post)).toEqual({ post: maximum })
  })

  it('binds detail and like receipts to the selected post without requiring author ownership', () => {
    const otherAuthor = post({ author: { id: 77, display_name: '其他用户' } })
    for (const kind of ['post', 'like']) {
      expect(response(kind, { post: otherAuthor }, ids.post)).toEqual({ post: otherAuthor })
      expect(() => response(kind, { post: otherAuthor }, ids.other)).toThrow(DemandProtocolError)
    }
  })

  it('projects list pagination without inventing views, sequence or unread counts', () => {
    const items = [post({ author: { id: 77, display_name: '其他用户' } })]
    expect(response('posts', { items, next_cursor: 'opaque-next', has_more: true, view_count: 99,
      last_seq: 100, unread_count: 10 })).toEqual({ items, next_cursor: 'opaque-next', has_more: true })
    expect(response('posts', { items: [], next_cursor: '', has_more: false })).toEqual({ items: [], next_cursor: '', has_more: false })
    for (const fields of [{ items: {} }, { next_cursor: null }, { next_cursor: 'a'.repeat(257) }, { has_more: 1 }]) {
      expect(() => response('posts', { items, next_cursor: '', has_more: false, ...fields })).toThrow(DemandProtocolError)
    }
    expect(() => response('posts', { items: [post(), post()], next_cursor: '', has_more: false })).toThrow(DemandProtocolError)
  })

  it('projects ordinary comments and requires every comment to belong to the selected parent', () => {
    const original = comment({ author: { id: 77, display_name: '', phone: 'hidden', key: 'hidden' },
      post_title: 'hidden', reviewed_at: 3, deleted_at: 4, attachments: [ids.post], seq: 8 })
    const expected = comment({ author: { id: 77, display_name: '' } })
    expect(response('comments', { items: [original], next_cursor: '', has_more: false }, ids.post))
      .toEqual({ items: [expected], next_cursor: '', has_more: false })
    expect(() => response('comments', { items: [original], next_cursor: '', has_more: false }, ids.other)).toThrow(DemandProtocolError)
    expect(() => response('comments', { items: [comment(), comment()], next_cursor: '', has_more: false }, ids.post)).toThrow(DemandProtocolError)
    for (const fields of [{ id: 'invalid' }, { post_id: 'invalid' }, { body: '😀'.repeat(4001) },
      { author: { id: 0, display_name: '' } }, { created_at: -1 }]) {
      expect(() => response('comments', { items: [comment(fields)], next_cursor: '', has_more: false }, ids.post)).toThrow(DemandProtocolError)
    }
    expect(demandObject(response('comments', { items: [comment({ body: '😀'.repeat(4000) })],
      next_cursor: '', has_more: false }, ids.post)).items).toHaveLength(1)
  })

  it('requires post creation receipts to belong to the captured account with explicit replay status', () => {
    for (const replayed of [true, false]) expect(response('create-post', { post: post(), replayed })).toEqual({ post: post(), replayed })
    expect(() => response('create-post', { post: post({ author: { id: 77, display_name: '其他用户' } }), replayed: false })).toThrow(DemandProtocolError)
    for (const replayed of [undefined, null, 'true', 0]) {
      expect(() => response('create-post', { post: post(), replayed })).toThrow(DemandProtocolError)
    }
  })

  it('requires comment creation receipts to match both captured author and selected parent', () => {
    for (const replayed of [true, false]) {
      expect(response('create-comment', { comment: comment(), replayed }, ids.post)).toEqual({ comment: comment(), replayed })
    }
    expect(() => response('create-comment', { comment: comment(), replayed: false }, ids.other)).toThrow(DemandProtocolError)
    expect(() => response('create-comment', { comment: comment({ author: { id: 77, display_name: '其他用户' } }), replayed: false }, ids.post))
      .toThrow(DemandProtocolError)
    expect(() => response('create-comment', { comment: comment() }, ids.post)).toThrow(DemandProtocolError)
  })

  it('rejects operations belonging to other API families, including forum media operations', () => {
    for (const kind of ['upload-init', 'upload-complete', 'link', 'message', 'read', 'action']) {
      expect(() => forumRequest(kind, {})).toThrow(DemandProtocolError)
      expect(() => response(kind, {})).toThrow(DemandProtocolError)
    }
  })

  it('retains only the frozen forum error codes for safe local reporting', () => {
    expect([...FORUM_ERRORS].sort()).toEqual(['FORUM_AUTH_REQUIRED', 'FORUM_FORBIDDEN', 'FORUM_INVALID_INPUT',
      'FORUM_CURSOR_INVALID', 'FORUM_CLOSED', 'FORUM_NOT_FOUND', 'FORUM_REQUEST_CONFLICT',
      'FORUM_REVISION_CONFLICT', 'FORUM_UNAVAILABLE'].sort())
  })
})
