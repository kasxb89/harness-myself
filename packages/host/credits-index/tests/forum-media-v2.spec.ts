/** Negotiated forum media preserves legacy image arrays and original mutation bytes. */
import { describe, expect, it } from 'vitest'
import { forumRequest, forumResponse } from '../src/forum-protocol.ts'

const id = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const image = { id, name: 'forum-image.png', kind: 'image', mime_type: 'image/png', size_bytes: 7,
  sha256: 'a'.repeat(64), status: 'ready', preview_path: `/attachments/${id}/link`, download_path: `/attachments/${id}/link` }
const video = { ...image, id: other, name: 'forum-video.mp4', kind: 'video', mime_type: 'video/mp4',
  preview_path: `/attachments/${other}/link`, download_path: `/attachments/${other}/link` }
const row = { id, title: '工作流', body: '', author: { id: 1, display_name: '成员' }, created_at: 1,
  like_count: 0, comment_count: 0, liked: false }
const parse = (kind: string, data: unknown) => forumResponse(kind, { success: true, data }, { id: '1' })
const rules = { max_attachments: 3, max_image_bytes: 30, max_video_bytes: 70, chunk_bytes: 7, upload_ttl_seconds: 60,
  allowed_mime_types: ['image/png', 'video/mp4'] }
const config = { revision: 2, enabled: true, capabilities: { immediate_publish: true, comments: true, likes: true,
  image_uploads: true, forum_media_v2: true, video_uploads: true }, upload_rules_v2: rules }

describe('forum media version two projections', () => {
  it('retains image-only legacy arrays and all ordered v2 media on textless posts, comments and receipts', () => {
    const post = { ...row, attachments: [image], media: [video, image] }
    expect(parse('post', { post })).toEqual({ post })
    expect(parse('receipt', { post, replayed: true })).toEqual({ post, replayed: true })
    for (const kind of ['posts', 'my-posts']) expect(parse(kind, { items: [post], next_cursor: '', has_more: false }))
      .toEqual({ items: [post], next_cursor: '', has_more: false })
    expect(parse('create-post', { post, replayed: false })).toEqual({ post, replayed: false })
    const comment = { id: other, post_id: id, body: '', author: row.author, created_at: 1, attachments: [], media: [video] }
    expect(parse('comment', { comment })).toEqual({ comment })
    for (const kind of ['comments', 'my-comments']) expect(parse(kind, { items: [comment], next_cursor: '', has_more: false }))
      .toEqual({ items: [comment], next_cursor: '', has_more: false })
    expect(parse('create-comment', { comment, replayed: false })).toEqual({ comment, replayed: false })
    expect(() => parse('post', { post: { ...post, attachments: [video] } })).toThrow()
    expect(() => parse('post', { post: { ...post, media: [{ ...video, mime_type: 'image/png' }] } })).toThrow()
    expect(() => parse('post', { post: { ...post, media: [video, video] } })).toThrow()
    expect(() => parse('post', { post: { ...post, media: [] } })).toThrow()
  })
  it('requires complete capability-qualified v2 rules without relaxing legacy image rules', () => {
    expect(parse('config', config)).toEqual(config)
    for (const change of [{ upload_rules_v2: undefined }, { upload_rules_v2: { ...rules, max_video_bytes: 0 } },
      { capabilities: { ...config.capabilities, forum_media_v2: false } },
      { upload_rules_v2: { ...rules, allowed_mime_types: ['video/webm'] } }]) {
      expect(() => parse('config', { ...config, ...change })).toThrow()
    }
    expect(() => parse('config', { ...config, upload_rules: rules })).toThrow()
  })
  it('normalizes the current Go v2 config upload_rules field only under its explicit capability', () => {
    const sourceRules = { max_attachments: 8, max_image_bytes: 20971520, max_video_bytes: 134217728,
      chunk_bytes: 4194304, upload_ttl_seconds: 86400,
      allowed_mime_types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4'] }
    const actualField = { revision: 2, enabled: true, capabilities: config.capabilities, upload_rules: sourceRules }
    expect(parse('config', actualField)).toEqual({ revision: 2, enabled: true,
      capabilities: config.capabilities, upload_rules_v2: sourceRules })
    expect(() => parse('config', { ...actualField,
      capabilities: { immediate_publish: true, comments: true, likes: true, image_uploads: true } })).toThrow()
    expect(() => parse('config', { ...actualField, upload_rules: { ...sourceRules, max_video_bytes: 0 } })).toThrow()
  })
  it('allows negotiated MP4 upload and ready metadata but preserves original text request bytes', () => {
    const input = { client_upload_id: id, target_kind: 'post', post_id: '', name: 'private.mp4', mime_type: 'video/mp4', size_bytes: 7 }
    expect(forumRequest('upload-init', input)).toEqual(input)
    expect(parse('upload-status', { id, attachment_id: other, status: 'ready', offset: 7, chunk_bytes: 7, expires_at: 100,
      attachment: video })).toMatchObject({ attachment: video })
    expect(() => forumRequest('upload-init', { ...input, mime_type: 'video/webm' })).toThrow()
    const original = { client_request_id: '原key😀', title: '原标题', body: ' 原正文 ' }
    expect(JSON.stringify(forumRequest('create-post', original))).toBe(JSON.stringify(original))
  })
})
