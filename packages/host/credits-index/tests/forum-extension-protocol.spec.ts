/** Forum media-v1 remains a public DTO projection under one captured account. */
import { describe, expect, it } from 'vitest'
import { DemandProtocolError } from '../src/demand-protocol.ts'
import { forumQuery, forumRequest, forumResponse } from '../src/forum-protocol.ts'

const postId = '11111111-1111-4111-8111-111111111111'
const commentId = '22222222-2222-4222-8222-222222222222'
const assetId = '33333333-3333-4333-8333-333333333333'
const otherId = '44444444-4444-4444-8444-444444444444'
const account = { id: '451129010' }
const author = { id: Number(account.id), display_name: `论坛用户${account.id}` }
const asset = (overrides: Record<string, unknown> = {}) => ({ id: assetId, name: 'image.png', kind: 'image', mime_type: 'image/png',
  size_bytes: 8, sha256: 'a'.repeat(64), status: 'ready', preview_path: `/attachments/${assetId}/link`,
  download_path: `/attachments/${assetId}/link`, ...overrides })
const post = (overrides: Record<string, unknown> = {}) => ({ id: postId, title: 'Title', body: 'Body', author,
  created_at: 1, like_count: 0, comment_count: 0, liked: false, ...overrides })
const comment = (overrides: Record<string, unknown> = {}) => ({ id: commentId, post_id: postId, body: 'Reply', author,
  created_at: 1, ...overrides })
const response = (kind: string, data: unknown, route: { resourceId?: string; secondaryId?: string } = {}) =>
  forumResponse(kind, { success: true, data }, account, route)
const page = (items: unknown[]) => ({ items, next_cursor: '', has_more: false })

describe('forum media and activity protocol additions', () => {
  it('preserves legacy omitted fields and original Unicode keys while retaining explicit media/reply bindings', () => {
    const original = { client_request_id: '原始 😀 key', title: 'Title', body: ' Body ' }
    expect(forumRequest('create-post', original)).toEqual(original)
    expect(forumRequest('create-post', { ...original, body: '', attachment_ids: [assetId], owner_id: 99 }))
      .toEqual({ ...original, body: '', attachment_ids: [assetId] })
    const reply = { client_request_id: 'reply-key', body: '', attachment_ids: [assetId], reply_to_comment_id: commentId }
    expect(forumRequest('create-comment', reply)).toEqual(reply)
    expect(forumRequest('create-comment', { client_request_id: 'old', body: 'Body', title: '' }))
      .toEqual({ client_request_id: 'old', body: 'Body' })
    expect(forumRequest('create-comment', { ...reply, attachment_ids: [], body: 'Body', reply_to_comment_id: '' }))
      .toEqual({ ...reply, attachment_ids: [], body: 'Body', reply_to_comment_id: '' })
  })

  it('rejects duplicate, foreign-shaped and oversized attachment sets or blank text-only submissions', () => {
    const body = { client_request_id: 'key', title: 'Title', body: '' }
    for (const attachment_ids of [[], [assetId, assetId], ['../community'], Array(9).fill(assetId), null]) {
      expect(() => forumRequest('create-post', { ...body, attachment_ids })).toThrow(DemandProtocolError)
    }
    expect(() => forumRequest('create-comment', { client_request_id: 'key', body: 'Body', reply_to_comment_id: '../post' }))
      .toThrow(DemandProtocolError)
  })

  it('projects only verified image metadata and refuses signed, cross-domain or wrong-id preview paths', () => {
    const image = asset({ token: 'secret', owner_id: 99, storage_path: '/private', phone: 'hidden' })
    expect(response('post', { post: post({ body: '', attachments: [image] }) }, { resourceId: postId }))
      .toEqual({ post: post({ body: '', attachments: [asset()] }) })
    for (const fields of [{ kind: 'video' }, { mime_type: 'image/svg+xml' }, { status: 'uploading' },
      { sha256: 'A'.repeat(64) }, { preview_path: 'https://host.invalid/image?token=secret' },
      { preview_path: `/api/product/community-demands/attachments/${assetId}/link` },
      { download_path: `/attachments/${otherId}/link` }]) {
      expect(() => response('post', { post: post({ attachments: [asset(fields)] }) })).toThrow(DemandProtocolError)
    }
    expect(response('post', { post: post({ attachments: [asset({ preview_path: `/api/product/forum/attachments/${assetId}/link` })] }) }))
      .toMatchObject({ post: { attachments: [{ preview_path: `/api/product/forum/attachments/${assetId}/link` }] } })
  })

  it('binds reply detail to both selected post and comment without exposing phone-like reply authors', () => {
    const input = comment({ attachments: [asset()], reply_to_comment_id: otherId,
      reply_to_author: { id: 99, display_name: '+60 123456789', phone: 'secret' }, post_title: 'Parent title' })
    expect(response('comment', { comment: input }, { resourceId: postId, secondaryId: commentId }))
      .toMatchObject({ comment: { reply_to_author: { id: 99, display_name: '' }, post_title: 'Parent title' } })
    for (const route of [{ resourceId: otherId }, { resourceId: postId, secondaryId: otherId }]) {
      expect(() => response('comment', { comment: input }, route)).toThrow(DemandProtocolError)
    }
    expect(() => response('comment', { comment: comment({ reply_to_comment_id: '', reply_to_author: author }) }))
      .toThrow(DemandProtocolError)
  })

  it('allows only the exact server pseudonym bound to its author and retains custom non-phone names', () => {
    expect(response('post', { post: post() })).toEqual({ post: post() })
    expect(response('post', { post: post({ author: { ...author, display_name: '论坛用户451129011' } }) }))
      .toMatchObject({ post: { author: { display_name: '' } } })
    expect(response('post', { post: post({ author: { ...author, display_name: '风铃😊' } }) }))
      .toMatchObject({ post: { author: { display_name: '风铃😊' } } })
  })

  it('validates target-bound upload init and keeps incomplete metadata null until a verified ready attachment', () => {
    const input = { client_upload_id: 'upload-key', target_kind: 'post', post_id: '', name: 'image.gif', mime_type: 'image/gif', size_bytes: 8 }
    expect(forumRequest('upload-init', { ...input, user_id: 99, scope: 'conversation' })).toEqual(input)
    expect(forumRequest('upload-init', { ...input, target_kind: 'comment', post_id: postId }))
      .toMatchObject({ target_kind: 'comment', post_id: postId })
    for (const fields of [{ target_kind: 'post', post_id: postId }, { target_kind: 'comment', post_id: '' },
      { mime_type: 'video/webm' }, { name: '../image.png' }, { size_bytes: 0 }]) {
      expect(() => forumRequest('upload-init', { ...input, ...fields })).toThrow(DemandProtocolError)
    }
    const uploading = { id: assetId, attachment_id: assetId, offset: 4, chunk_bytes: 4, status: 'uploading', expires_at: 100, attachment: null }
    expect(response('upload-status', uploading, { resourceId: assetId })).toEqual(uploading)
    const assembling = { ...uploading, offset: 8, status: 'assembling' }
    expect(response('upload-status', assembling, { resourceId: assetId })).toEqual(assembling)
    const ready = { ...uploading, offset: 8, status: 'ready', attachment: asset() }
    expect(response('upload-complete', ready, { resourceId: assetId })).toEqual(ready)
    for (const invalid of [{ ...ready, attachment: null }, { ...ready, attachment: asset({ id: otherId }) },
      { ...uploading, attachment: asset() }]) expect(() => response('upload-status', invalid)).toThrow(DemandProtocolError)
    expect(() => response('upload-status', ready, { resourceId: otherId })).toThrow(DemandProtocolError)
    expect(forumRequest('upload-complete', { sha256: 'a'.repeat(64), token: 'secret' })).toEqual({ sha256: 'a'.repeat(64) })
  })

  it('keeps optional capability gates compatible with old text-only config and validates new upload rules', () => {
    const caps = { immediate_publish: true, likes: true, comments: true, image_uploads: true, my_activity: true,
      comment_replies: true, notifications: true, forum_profile: true, receipt_lookup: true }
    const rules = { max_attachments: 8, max_image_bytes: 20971520, chunk_bytes: 4194304, upload_ttl_seconds: 86400,
      allowed_mime_types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] }
    const config = { revision: 1, enabled: true, capabilities: caps, upload_rules: rules }
    expect(response('config', { ...config, private_key: 'secret' })).toEqual(config)
    expect(() => response('config', { ...config, capabilities: { ...caps, notifications: 'true' } })).toThrow(DemandProtocolError)
    expect(() => response('config', { ...config, upload_rules: { ...rules, allowed_mime_types: ['video/mp4'] } }))
      .toThrow(DemandProtocolError)
    expect(() => response('config', { revision: 1, enabled: true, capabilities: caps })).toThrow(DemandProtocolError)
    expect(() => response('config', { ...config, upload_rules: { ...rules, chunk_bytes: 0 } })).toThrow(DemandProtocolError)
  })

  it('requires own-author activity and own original receipts without mutating their omitted legacy fields', () => {
    expect(response('my-posts', page([post()]))).toEqual(page([post()]))
    expect(response('my-comments', page([comment({ post_title: 'Parent' })]))).toEqual(page([comment({ post_title: 'Parent' })]))
    for (const kind of ['my-posts', 'my-comments']) {
      const item = kind === 'my-posts' ? post({ author: { id: 99, display_name: 'Other' } }) : comment({ author: { id: 99, display_name: 'Other' } })
      expect(() => response(kind, page([item]))).toThrow(DemandProtocolError)
    }
    expect(response('receipt', { post: post(), replayed: true })).toEqual({ post: post(), replayed: true })
    expect(response('receipt', { comment: comment(), replayed: true })).toEqual({ comment: comment(), replayed: true })
    expect(() => response('receipt', { post: post(), replayed: false })).toThrow(DemandProtocolError)
    expect(() => response('receipt', { post: post(), comment: comment(), replayed: true })).toThrow(DemandProtocolError)
  })

  it('allows only current-account pagination and original kind/key receipt lookup', () => {
    for (const kind of ['my-posts', 'my-comments', 'notifications']) {
      expect(forumQuery(kind, new URLSearchParams('limit=20&cursor=opaque')).toString()).toBe('limit=20&cursor=opaque')
      for (const query of ['author_id=99', 'user_id=99', 'review=all', 'limit=0', 'limit=1&limit=2']) {
        expect(() => forumQuery(kind, new URLSearchParams(query))).toThrow(DemandProtocolError)
      }
    }
    const query = new URLSearchParams({ kind: 'comment', client_request_id: '原始 😀 key' })
    expect(forumQuery('receipt', query).toString()).toBe(query.toString())
    for (const query of ['', 'kind=post', 'kind=admin&client_request_id=k', 'kind=post&client_request_id=k&user_id=99']) {
      expect(() => forumQuery('receipt', new URLSearchParams(query))).toThrow(DemandProtocolError)
    }
  })

  it('projects forum-only profile and notification metadata without account contacts or authority', () => {
    expect(response('profile', { profile: { ...author, revision: 1, phone: 'secret', username: 'secret' } }))
      .toEqual({ profile: { ...author, revision: 1 } })
    expect(forumRequest('profile-update', { display_name: '  设计师😊  ', revision: 1, role: 10 }))
      .toEqual({ display_name: '设计师😊', revision: 1 })
    expect(forumRequest('profile-update', { display_name: '设计师👩‍💻', revision: 1 })).toEqual({ display_name: '设计师👩‍💻', revision: 1 })
    for (const display_name of ['13800138000', '+60 12-345-6789', ' ', 'a'.repeat(41), 'a\nb']) {
      expect(() => forumRequest('profile-update', { display_name, revision: 1 })).toThrow(DemandProtocolError)
    }
    expect(() => response('profile', { profile: { id: 99, display_name: 'Other', revision: 1 } })).toThrow(DemandProtocolError)
    const notice = { id: '18446744073709551615', type: 'reply', post_id: postId, comment_id: commentId, actor: author,
      post_title: 'Title', created_at: 1, read_at: 0 }
    expect(response('notifications', { ...page([{ ...notice, phone: 'secret' }]), unread_count: 1 }))
      .toEqual({ ...page([notice]), unread_count: 1 })
    expect(forumRequest('notifications-read', { notification_ids: ['1', notice.id], recipient_id: 99 }))
      .toEqual({ notification_ids: ['1', notice.id] })
    for (const id of ['0', '01', postId, '18446744073709551616']) {
      expect(() => forumRequest('notifications-read', { notification_ids: [id] })).toThrow(DemandProtocolError)
    }
    expect(() => forumRequest('notifications-read', { notification_ids: [] })).toThrow(DemandProtocolError)
    expect(response('notifications-read', { unread_count: 0, auth_version: 1 })).toEqual({ unread_count: 0 })
  })
})
