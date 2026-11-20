/** New forum DTOs and journals reject contradictory media without changing old text-only bodies. */
import { describe, expect, it } from 'vitest'
import { forumAttachment, forumAuthor, forumComment, forumConfig, forumPost } from '../src/client/forum-wire.ts'
import { forumNotificationId, forumUpload } from '../src/client/forum-extended-wire.ts'
import { createForumJournal, parseForumOperation, type ForumOperation } from '../src/client/forum-pending.ts'
import { createForumUploadJournal, type ForumUploadRecord } from '../src/client/forum-upload-journal.ts'
import { extendedConfiguration } from './forum-extended-fixtures.client.ts'
import { forumExampleComment, forumExamplePost, forumMemory } from './forum-model-fixtures.client.ts'

const id = '00000000-0000-4000-8000-000000003001', second = '00000000-0000-4000-8000-000000003002'
const owner = { id: '1', owner: 'a'.repeat(64) }
const attachment = () => ({ id, name: '论坛图片.gif', kind: 'image', mime_type: 'image/gif', size_bytes: 7,
  sha256: 'a'.repeat(64), status: 'ready', preview_path: `/attachments/${id}/link`, download_path: `/attachments/${id}/link` })
const operation = (): ForumOperation => ({ version: 1, operationId: second, scopeKey: 'post-draft:original', postId: null,
  kind: 'post', method: 'POST', path: '/posts', body: JSON.stringify({ client_request_id: second, title: '原始图片帖', body: '', attachment_ids: [id] }), createdAt: 100 })
function upload(): ForumUploadRecord {
  return { version: 1, operationId: second, target: { kind: 'post', scopeKey: 'post-draft:original' },
    body: JSON.stringify({ client_upload_id: second, target_kind: 'post', post_id: '', name: 'private.png', mime_type: 'image/png', size_bytes: 7 }),
    file: { name: 'private.png', type: 'image/png', size: 7, lastModified: 100 }, parts: [], sha256: null,
    uploadId: null, attachmentId: null, attachment: null, completeBody: null }
}
describe('extended forum protocol boundaries', () => {
  it('accepts verified image-only content and keeps empty text without ready image metadata invalid', () => {
    expect(forumPost(forumExamplePost({ body: '', attachments: [forumAttachment(attachment())] })).attachments).toHaveLength(1)
    expect(forumComment(forumExampleComment({ body: '', attachments: [forumAttachment(attachment())] })).body).toBe('')
    expect(() => forumPost(forumExamplePost({ body: '', attachments: [] }))).toThrow('FORUM_PROTOCOL_INVALID')
    expect(() => forumComment(forumExampleComment({ body: '' }))).toThrow('FORUM_PROTOCOL_INVALID')
  })

  it('accepts only ready forum link metadata, never raw signed URLs or another resource family', () => {
    expect(forumAttachment(attachment()).mime_type).toBe('image/gif')
    for (const patch of [{ status: 'uploading' }, { kind: 'video' }, { mime_type: 'text/html' }, { sha256: 'invalid' },
      { preview_path: `/community/attachments/${id}/link` }, { download_path: 'https://private.invalid/token' }]) {
      expect(() => forumAttachment({ ...attachment(), ...patch })).toThrow('FORUM_PROTOCOL_INVALID')
    }
  })

  it('does not advertise uploads without actual server rules and preserves explicit dynamic capacities', () => {
    const configuration = extendedConfiguration()
    expect(forumConfig(configuration).upload_rules).toEqual(configuration.upload_rules)
    expect(() => forumConfig({ ...configuration, upload_rules: undefined })).toThrow('FORUM_PROTOCOL_INVALID')
    expect(() => forumConfig({ ...configuration, upload_rules: { ...configuration.upload_rules, chunk_bytes: 0 } })).toThrow('FORUM_PROTOCOL_INVALID')
  })

  it('allows assembling with no public attachment while ready must have its exact image', () => {
    const value = { id, attachment_id: id, offset: 7, chunk_bytes: 3, status: 'assembling', expires_at: 2000000000, attachment: null }
    expect(forumUpload(value).attachment).toBeNull()
    expect(() => forumUpload({ ...value, status: 'ready' })).toThrow('FORUM_PROTOCOL_INVALID')
    expect(() => forumUpload({ ...value, attachment: attachment() })).toThrow('FORUM_PROTOCOL_INVALID')
    expect(forumUpload({ ...value, status: 'ready', attachment: attachment() }).attachment?.id).toBe(id)
  })

  it('keeps notification keys exact decimal strings and only accepts a bound public pseudonym exception', () => {
    expect(forumNotificationId('18446744073709551615')).toBe('18446744073709551615')
    for (const value of ['0', '01', id, 10]) expect(() => forumNotificationId(value)).toThrow('FORUM_PROTOCOL_INVALID')
    expect(forumAuthor({ id: 451129010, display_name: '论坛用户451129010' }).display_name).toBe('论坛用户451129010')
    expect(forumAuthor({ id: 451129010, display_name: '论坛用户451129011' }).display_name).toBe('')
    expect(forumAuthor({ id: 1, display_name: '阿泽😊' }).display_name).toBe('阿泽😊')
  })

  it('retains the original image-only JSON byte string and refuses attachment or reply substitution under its UUID', () => {
    const journal = createForumJournal(forumMemory()), original = operation()
    journal.put(owner, original)
    expect(journal.read(owner)[0]?.body).toBe(original.body)
    expect(() => { journal.put(owner, { ...original, body: original.body.replace(id, second) }) }).toThrow('FORUM_PENDING_BODY_CHANGED')
    expect(() => parseForumOperation({ ...original, body: JSON.stringify({ client_request_id: second, title: '原标题', body: '' }) })).toThrow()
    const comment: ForumOperation = { ...original, kind: 'comment', postId: forumExamplePost().id,
      scopeKey: `post:${forumExamplePost().id}`, path: `/posts/${forumExamplePost().id}/comments`,
      body: JSON.stringify({ client_request_id: second, body: '', attachment_ids: [id], reply_to_comment_id: forumExampleComment().id }) }
    journal.remove(owner, original.operationId); journal.put(owner, comment)
    expect(() => { journal.put(owner, { ...comment, body: comment.body.replace(forumExampleComment().id, second) }) })
      .toThrow('FORUM_PENDING_BODY_CHANGED')
  })

  it('keeps upload originals account isolated and allows only append-only verified progress', () => {
    const journal = createForumUploadJournal(forumMemory()), original = upload()
    journal.put(owner, original)
    expect(journal.read({ ...owner, owner: 'b'.repeat(64) })).toEqual([])
    const first = { ...original, sha256: 'a'.repeat(64), uploadId: id, attachmentId: id,
      parts: [{ offset: 0, size: 3, sha256: 'b'.repeat(64) }] }
    journal.put(owner, first)
    expect(() => { journal.put(owner, { ...first, parts: [{ offset: 0, size: 3, sha256: 'c'.repeat(64) }] }) })
      .toThrow('FORUM_PENDING_BODY_CHANGED')
    expect(() => { journal.put(owner, { ...first, uploadId: second }) }).toThrow('FORUM_PENDING_BODY_CHANGED')
    expect(() => { journal.put(owner, { ...first, completeBody: JSON.stringify({ sha256: 'd'.repeat(64) }) }) }).toThrow()
    expect(journal.read(owner)[0]?.body).toBe(original.body)
  })
})
