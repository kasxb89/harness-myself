/** Negotiated profile avatars retain public metadata while signed media stays inside the Host. */
import { describe, expect, it } from 'vitest'
import { forumResponse } from '../src/forum-protocol.ts'
import { demandObject } from '../src/demand-protocol.ts'

const ids = { post: '11111111-1111-4111-8111-111111111111', comment: '22222222-2222-4222-8222-222222222222',
  avatar: '33333333-3333-4333-8333-333333333333' }
const account = { id: '42' }, base = 'https://api.example.test/harness'
const path = `/api/product/forum/attachments/${ids.avatar}/content`
const meta = { id: ids.avatar, kind: 'image', mime_type: 'image/png', size_bytes: 120, sha256: 'a'.repeat(64), expires_at: 100 }
const avatar = { ...meta, url: base + path + '?token=private-avatar-capability', name: 'private.png', phone: 'private-contact' }
const author = { id: 42, display_name: '云上记录', avatar }
const post = { id: ids.post, title: '企业网站交流', body: '公开帖子正文', author, created_at: 100,
  like_count: 0, comment_count: 1, liked: false }
const comment = { id: ids.comment, post_id: ids.post, body: '公开回复', author, created_at: 101 }
function response(kind: string, data: unknown) {
  return forumResponse(kind, { success: true, data }, account, {}, base)
}

describe('forum-profile-avatar-v1 Host fields', () => {
  it('retains safe avatar metadata in posts, comments, replies, profiles and notification actors', () => {
    const page = { next_cursor: '', has_more: false }
    const samples = [response('post', { post }), response('like', { post }),
      response('posts', { items: [post], ...page }), response('my-posts', { items: [post], ...page }),
      response('comments', { items: [{ ...comment, reply_to_comment_id: ids.comment, reply_to_author: author }], ...page }),
      response('my-comments', { items: [comment], ...page }), response('comment', { comment }),
      response('profile', { profile: { ...author, revision: 1 } }), response('profile-update', { profile: { ...author, revision: 2 } }),
      response('notifications', { items: [{ id: '1', type: 'reply', post_id: ids.post, comment_id: ids.comment,
        actor: author, post_title: post.title, created_at: 102, read_at: 0 }], ...page, unread_count: 1 }),
      response('receipt', { post, replayed: true }), response('receipt', { comment, replayed: true }),
      response('create-post', { post, replayed: false }), response('create-comment', { comment, replayed: false }),
    ]
    for (const value of samples) {
      const json = JSON.stringify(value)
      expect(json).toContain(JSON.stringify(meta))
      expect(json).not.toMatch(/private-avatar-capability|private\.png|private-contact|"url"|"phone"/u)
    }
  })

  it('accepts exact deployment URLs and canonical relative paths while rejecting other origins, resources and private families', () => {
    for (const url of [path + '?token=cap', '/harness' + path + '?token=cap', base + path + '?token=cap']) {
      expect(response('post', { post: { ...post, author: { ...author, avatar: { ...avatar, url } } } })).toMatchObject({ post: { author: { avatar: meta } } })
    }
    for (const url of ['https://other.example.test/harness' + path + '?token=cap', 'https://api.example.test' + path + '?token=cap',
      '//api.example.test/harness' + path + '?token=cap', base + path.replace(ids.avatar, ids.post) + '?token=cap',
      base + '/api/product/demands/attachments/' + ids.avatar + '/content?token=cap',
      base + path.replace('/attachments/', '/temporary/../attachments/') + '?token=cap',
      base + path, base + path + '?token=cap&extra=1', base + path + '?token=cap#fragment']) {
      expect(() => response('post', { post: { ...post, author: { ...author, avatar: { ...avatar, url } } } })).toThrow()
    }
  })

  it('rejects non-image, malformed, oversized or inconsistent avatar data before projecting a profile', () => {
    for (const value of [{ ...avatar, kind: 'video' }, { ...avatar, mime_type: 'image/svg+xml' }, { ...avatar, size_bytes: 0 },
      { ...avatar, size_bytes: 20 * 1024 * 1024 + 1 }, { ...avatar, sha256: 'bad' }, { ...avatar, expires_at: 0 },
      { ...avatar, id: 'not-a-uuid' }, null]) {
      expect(() => response('profile', { profile: { ...author, avatar: value, revision: 1 } })).toThrow()
    }
  })

  it('preserves legacy no-avatar fields and exact pseudonym privacy with an additive capability', () => {
    const oldAuthor = { id: 451129010, display_name: '论坛用户451129010' }
    expect(demandObject(response('post', { post: { ...post, author: oldAuthor } }).post).author).toEqual(oldAuthor)
    expect(demandObject(response('post', { post: { ...post, author: { ...oldAuthor, display_name: '+86 13800138000' } } }).post).author)
      .toEqual({ id: oldAuthor.id, display_name: '' })
    const config = { revision: 1, enabled: true, capabilities: { immediate_publish: true, likes: true, comments: true } }
    expect(response('config', config)).toEqual(config)
    expect(response('config', { ...config, capabilities: { ...config.capabilities, forum_profile_avatar_v1: true } }))
      .toMatchObject({ capabilities: { forum_profile_avatar_v1: true } })
    expect(() => response('config', { ...config, capabilities: { ...config.capabilities, forum_profile_avatar_v1: 'true' } })).toThrow()
  })
})
