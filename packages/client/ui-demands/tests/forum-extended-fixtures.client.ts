/** Synthetic exact-revision forum endpoints; these fixtures never open a socket or create real users. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { sha256 } from '@noble/hashes/sha2.js'
import { vi } from 'vitest'
import { createForumController } from '../src/client/forum-controller.ts'
import type { ForumOwner, ForumRequest, ForumResult } from '../src/client/forum-api.ts'
import { createForumJournal } from '../src/client/forum-pending.ts'
import { createForumUploadJournal } from '../src/client/forum-upload-journal.ts'
import type { ForumAttachment, ForumComment, ForumConfig, ForumNotification, ForumPost } from '../src/client/forum-types.ts'
import { forumExampleComment, forumExamplePost, forumMemory } from './forum-model-fixtures.client.ts'

export const extendedPostId = '00000000-0000-4000-8000-000000001001'
export const extendedReplyId = '00000000-0000-4000-8000-000000002001'
export const ownerHash = 'a'.repeat(64)
export const successful = (payload: unknown): ForumResult => ({ ok: true, payload })
export const uncertain = (): ForumResult => ({ ok: false, code: 'FORUM_TIMEOUT', httpStatus: 0, unknown: true })
export function extendedConfiguration(): ForumConfig {
  return { revision: 2, enabled: true, capabilities: { immediate_publish: true, comments: true, likes: true,
    image_uploads: true, my_activity: true, comment_replies: true, notifications: true, forum_profile: true, receipt_lookup: true },
  upload_rules: { max_attachments: 2, max_image_bytes: 100, chunk_bytes: 3, upload_ttl_seconds: 60, allowed_mime_types: ['image/png'] } }
}
export function extendedAccount(id = '1', epoch = 1): ReturnType<Context['creditsSession']['getSnapshot']> {
  return { loaded: true, accountEpoch: epoch, balance: null, failure: null,
    session: { signedIn: true, creditsPerYuan: 1000, account: { id, phone: '' }, accountOwner: ownerHash } }
}
export const fileDigest = (bytes: Uint8Array): string => [...sha256(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')
export function requestBody(input: ForumRequest): Record<string, unknown> { return JSON.parse(input.body ?? '{}') as Record<string, unknown> }

export function extendedHarness(options: {
  readonly config?: ForumConfig
  readonly intercept?: (input: ForumRequest, answer: ForumResult) => ForumResult | Promise<ForumResult>
  readonly interval?: number
} = {}) {
  const account = createSnapshotStore(extendedAccount()), storage = forumMemory()
  const rows: ForumPost[] = [forumExamplePost({ attachments: [] })]
  const replies: ForumComment[] = [forumExampleComment({ attachments: [], reply_to_comment_id: '' })]
  const receipts = new Map<string, ForumResult>(), uploads = new Map<string, {
    id: string
    body: string
    name: string
    type: string
    size: number
    bytes: number[]
    attachment: ForumAttachment | null
  }>()
  const notification = (id: string): ForumNotification => ({ id, type: 'reply', post_id: extendedPostId,
    comment_id: extendedReplyId, actor: { id: 2, display_name: '其他成员' }, post_title: rows[0]?.title ?? '标题', created_at: 100, read_at: 0 })
  let notices = [notification('18446744073709551614'), notification('10'), notification('9')]
  let profile = { id: 1, display_name: '论坛用户1', revision: 0 }, nonce = 3000, uuid = 1000
  const uploadDto = (value: (typeof uploads extends Map<string, infer V> ? V : never)) => ({
    id: value.id, attachment_id: value.id, offset: value.bytes.length, chunk_bytes: options.config?.upload_rules?.chunk_bytes ?? 3,
    status: value.attachment === null ? 'uploading' : 'ready', expires_at: 2000000000, attachment: value.attachment,
  })
  const base = async (owner: ForumOwner, input: ForumRequest): Promise<ForumResult> => {
    const [path, query = ''] = input.path.split('?'), parts = path?.split('/') ?? [], data = requestBody(input)
    if (path === '/config') return successful(options.config ?? extendedConfiguration())
    if (path === '/profile') {
      if (input.method === 'PATCH') profile = { ...profile, display_name: String(data.display_name), revision: profile.revision + 1 }
      return successful({ profile })
    }
    if (path === '/notifications/unread') return successful({ unread_count: notices.filter(item => item.read_at === 0).length })
    if (path === '/notifications/read') {
      const ids = Array.isArray(data.notification_ids) ? data.notification_ids : []
      notices = notices.map(item => ids.includes(item.id) ? { ...item, read_at: 123 } : item)
      return successful({ unread_count: notices.filter(item => item.read_at === 0).length })
    }
    if (path === '/notifications') return successful({ items: notices, next_cursor: '', has_more: false,
      unread_count: notices.filter(item => item.read_at === 0).length })
    if (path === '/me/posts') return successful({ items: rows.filter(item => item.author.id === Number(owner.id)), next_cursor: '', has_more: false })
    if (path === '/me/comments') return successful({ items: replies.filter(item => item.author.id === Number(owner.id))
      .map(item => ({ ...item, post_title: rows.find(row => row.id === item.post_id)?.title ?? '标题' })), next_cursor: '', has_more: false })
    if (path === '/receipts') return receipts.get(new URLSearchParams(query).get('client_request_id') ?? '')
      ?? { ok: false, code: 'FORUM_NOT_FOUND', httpStatus: 404, unknown: false }
    if (path === '/uploads' && input.method === 'POST') {
      const key = String(data.client_upload_id)
      let value = uploads.get(key)
      if (value === undefined) {
        value = { id: `00000000-0000-4000-8000-${String(++nonce).padStart(12, '0')}`, body: input.body ?? '',
          name: String(data.name), type: String(data.mime_type), size: Number(data.size_bytes), bytes: [], attachment: null }
        uploads.set(key, value)
      }
      if (value.body !== input.body) return { ok: false, code: 'FORUM_REQUEST_CONFLICT', httpStatus: 409, unknown: false }
      return successful(uploadDto(value))
    }
    if (parts[1] === 'uploads') {
      const value = [...uploads.values()].find(item => item.id === parts[2])
      if (value === undefined) return { ok: false, code: 'FORUM_NOT_FOUND', httpStatus: 404, unknown: false }
      if (parts[3] === 'chunks') {
        if (input.offset !== value.bytes.length) return { ok: false, code: 'FORUM_UPLOAD_OFFSET_CONFLICT', httpStatus: 409, unknown: false }
        value.bytes.push(...new Uint8Array(await input.blob?.arrayBuffer() ?? new ArrayBuffer(0)))
        input.onProgress?.(input.blob?.size ?? 0)
      }
      if (parts[3] === 'complete') {
        const digest = fileDigest(new Uint8Array(value.bytes))
        if (data.sha256 !== digest || value.bytes.length !== value.size) return { ok: false, code: 'FORUM_ATTACHMENT_INVALID', httpStatus: 400, unknown: false }
        value.attachment = { id: value.id, name: '论坛图片.png', kind: 'image', mime_type: value.type, size_bytes: value.size,
          sha256: digest, status: 'ready', preview_path: `/attachments/${value.id}/link`, download_path: `/attachments/${value.id}/link` }
      }
      return successful(uploadDto(value))
    }
    if (path === '/posts' && input.method === 'GET') return successful({ items: rows, next_cursor: '', has_more: false })
    if (input.method === 'POST' && (path === '/posts' || parts[3] === 'comments')) {
      const key = String(data.client_request_id), old = receipts.get(key)
      if (old !== undefined) return old
      const attachments = (Array.isArray(data.attachment_ids) ? data.attachment_ids : []).map(id =>
        [...uploads.values()].find(item => item.attachment?.id === id)?.attachment)
        .filter((value): value is ForumAttachment => value != null)
      const id = `00000000-0000-4000-8000-${String(++nonce).padStart(12, '0')}`, author = { id: Number(owner.id), display_name: profile.display_name }
      let result: ForumResult
      if (path === '/posts') {
        const post = forumExamplePost({ id, author, title: String(data.title).trim(), body: String(data.body).trim(), attachments })
        rows.unshift(post); result = successful({ post, replayed: false })
      } else {
        const comment = forumExampleComment({ id, author, post_id: parts[2] ?? '', body: String(data.body).trim(), attachments,
          reply_to_comment_id: typeof data.reply_to_comment_id === 'string' ? data.reply_to_comment_id : '' })
        replies.unshift(comment); result = successful({ comment, replayed: false })
      }
      receipts.set(key, result); return result
    }
    if (parts[1] === 'posts') {
      if (parts[3] === 'comments' && parts[4] !== undefined) return successful({ comment: replies.find(item => item.id === parts[4]) })
      if (parts[3] === 'comments') return successful({ items: replies.filter(item => item.post_id === parts[2]), next_cursor: '', has_more: false })
      return successful({ post: rows.find(item => item.id === parts[2]) })
    }
    return { ok: false, code: 'FORUM_NOT_FOUND', httpStatus: 404, unknown: false }
  }
  const request = vi.fn(async (owner: ForumOwner, input: ForumRequest): Promise<ForumResult> => {
    const answer = await base(owner, input); return options.intercept === undefined ? answer : options.intercept(input, answer)
  })
  const control = createForumController(account, { enabled: true, foregroundPollMs: options.interval ?? 60000,
    backgroundPollMs: options.interval ?? 60000 }, { request, journal: createForumJournal(storage),
    uploadJournal: createForumUploadJournal(storage),
    uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`, isForeground: () => true })
  control.start()
  return { control, account, request, rows, replies, receipts, uploads, storage,
    snapshot: () => control.hooks.forum.getSnapshot() }
}
