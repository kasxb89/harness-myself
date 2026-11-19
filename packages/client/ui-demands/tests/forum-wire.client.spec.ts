/** Exact source-defined forum DTO boundaries and Unicode limits. */
import { describe, expect, it } from 'vitest'
import { forumComment, forumConfig, forumPage, forumPost, forumText } from '../src/client/forum-wire.ts'
import { forumExampleComment as comment, forumExampleConfig as config, forumExamplePost as post } from './forum-model-fixtures.client.ts'

describe('forum wire', () => {
  it('accepts the direct non-schema config and drops moderation and contact metadata', () => {
    expect(forumConfig(config())).toEqual(config())
    expect(forumPost({ ...post(), author: { ...post().author, phone: 'not-public' }, reviewed_at: 1, delete_reason: 'not-public', view_count: 5 }))
      .toEqual(post())
    expect(forumComment({ ...comment(), post_title: 'Admin-only', deleted_at: 10 })).toEqual(comment())
    expect(() => forumConfig({ data: config() })).toThrow('FORUM_PROTOCOL_INVALID')
  })
  it('enforces real Unicode scalar limits and rejects invalid counters, author IDs and surrogate text', () => {
    expect(forumPost(post({ body: '😀'.repeat(20_000) })).body).toHaveLength(40_000)
    expect(() => forumPost(post({ body: '😀'.repeat(20_001) }))).toThrow()
    expect(() => forumText('\uD800', 20_000)).toThrow()
    expect(() => forumComment(comment({ body: 'x'.repeat(4001) }))).toThrow()
    expect(() => forumPost(post({ like_count: -1 }))).toThrow()
    expect(() => forumPost(post({ author: { id: 0, display_name: '' } }))).toThrow()
  })
  it('requires one bounded cursor page with unique IDs and an advancing opaque cursor', () => {
    expect(forumPage({ items: [post()], has_more: true, next_cursor: 'cursor_2' }, forumPost).items).toHaveLength(1)
    expect(() => forumPage({ items: [post(), post()], has_more: false, next_cursor: '' }, forumPost)).toThrow()
    expect(() => forumPage({ items: [post()], has_more: true, next_cursor: '' }, forumPost)).toThrow()
  })
})
