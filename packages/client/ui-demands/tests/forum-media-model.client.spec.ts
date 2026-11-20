/** Forum image bytes and original operation targets remain intact through explicit recovery. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createForumController, type ForumController } from '../src/client/forum-controller.ts'
import type { ForumResult } from '../src/client/forum-api.ts'
import { createForumJournal } from '../src/client/forum-pending.ts'
import { createForumUploadJournal } from '../src/client/forum-upload-journal.ts'
import { extendedAccount, extendedHarness, extendedPostId, extendedReplyId, fileDigest, requestBody,
  successful, uncertain } from './forum-extended-fixtures.client.ts'

const controls: ForumController[] = []
afterEach(async () => { await Promise.all(controls.splice(0).map(control => control.dispose())) })
async function harness(options: Parameters<typeof extendedHarness>[0] = {}) {
  const value = extendedHarness(options); controls.push(value.control)
  await vi.waitFor(() => { expect(value.snapshot().availability).toBe('ready'); expect(value.snapshot().posts.status).toBe('ready') })
  return value
}
const image = (bytes = [1, 2, 3, 4, 5, 6, 7]) => new File([new Uint8Array(bytes)], 'private-name.png', { type: 'image/png', lastModified: 100 })
function draft(h: Awaited<ReturnType<typeof harness>>, body = ''): string {
  h.control.startPost(); const scope = h.snapshot().activePostDraftScope
  if (scope === null) throw new Error('Missing draft')
  h.control.updatePostDraft(scope, { title: '公开图片作品', body }); return scope
}

describe('forum-only image model', () => {
  it('sends the original bytes, previews only ready assets and binds image-only publication exactly once', async () => {
    const h = await harness(), file = image(), scope = draft(h)
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [file])
    h.control.publishPost(scope)
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/posts' && input.method === 'POST')).toHaveLength(0)
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('ready') })
    const attachment = h.snapshot().uploads?.[0]?.attachment
    expect(attachment?.sha256).toBe(fileDigest(new Uint8Array(await file.arrayBuffer())))
    expect(h.control.contentUrl?.(attachment?.id ?? '')).toContain('/credits/api/forum/attachments/')
    expect(h.control.contentUrl?.(attachment?.id ?? '')).not.toContain('/link')
    expect([...h.uploads.values()][0]?.bytes).toEqual([...new Uint8Array(await file.arrayBuffer())])
    h.control.publishPost(scope); h.control.publishPost(scope)
    await vi.waitFor(() => { expect(h.snapshot().postDrafts.find(item => item.scopeKey === scope)?.postId).toBeTypeOf('string') })
    const posts = h.request.mock.calls.filter(([, input]) => input.path === '/posts' && input.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(requestBody(posts[0]![1])).toMatchObject({ body: '', attachment_ids: [attachment?.id] })
    expect(h.snapshot().selectedPost?.attachments?.[0]?.sha256).toBe(attachment?.sha256)
    expect(h.snapshot().uploads).toEqual([])
  })

  it('rejects invalid file selections before init and uses advertised count/byte limits', async () => {
    const h = await harness(), scope = draft(h, '正文')
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [new File(['x'], 'wrong.jpg', { type: 'image/jpeg' }),
      image(Array.from({ length: 101 }, () => 1))])
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/uploads')).toHaveLength(0)
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [image(), image(), image()])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.filter(item => item.status === 'ready')).toHaveLength(2) })
    expect(h.uploads.size).toBe(2)
    expect(h.snapshot().error?.code).toBe('FORUM_UPLOAD_TOO_MANY')
  })

  it('restores an image-only unknown post with its original UUID/body and queries its receipt without another POST', async () => {
    let lost = false
    const h = await harness({ intercept: (input, answer) => {
        if (!lost && input.method === 'POST' && input.path === '/posts') { lost = true; return uncertain() }
        return answer
      } }), scope = draft(h)
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [image()])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('ready') })
    h.control.publishPost(scope)
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.unknown).toBe(true) })
    const original = h.snapshot().pending[0]
    if (original === undefined) throw new Error('Missing original post')
    await h.control.dispose()
    const uuid = vi.fn(() => '00000000-0000-4000-8000-000000099999')
    const restored = createForumController(h.account, { enabled: true }, { request: h.request,
      journal: createForumJournal(h.storage), uploadJournal: createForumUploadJournal(h.storage), uuid })
    controls.push(restored); restored.start()
    await vi.waitFor(() => { expect(restored.hooks.forum.getSnapshot().availability).toBe('ready') })
    expect(restored.hooks.forum.getSnapshot().pending[0]?.operationId).toBe(original.operationId)
    expect(restored.hooks.forum.getSnapshot().postDrafts[0]?.body).toBe('')
    restored.retryOperation(original.operationId)
    await vi.waitFor(() => { expect(restored.hooks.forum.getSnapshot().pending).toHaveLength(0) })
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/posts' && input.method === 'POST')).toHaveLength(1)
    expect(h.request.mock.calls.filter(([, input]) => input.path.startsWith('/receipts?'))).toHaveLength(1)
    expect(uuid).not.toHaveBeenCalled()
    expect(restored.hooks.forum.getSnapshot().postDrafts[0]?.postId).toBeTypeOf('string')
  })

  it('checks the original upload offset after a lost chunk response and does not resend accepted bytes', async () => {
    let lost = false
    const h = await harness({ intercept: (input, answer) => {
        if (!lost && input.path.endsWith('/chunks')) { lost = true; return uncertain() }
        return answer
      } }), scope = draft(h)
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [image()])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('unknown') })
    const original = h.snapshot().uploads?.[0]?.operationId
    if (original === undefined) throw new Error('Missing original upload')
    h.control.retryAttachment?.(original)
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('ready') })
    const chunks = h.request.mock.calls.filter(([, input]) => input.path.endsWith('/chunks'))
    expect(chunks.map(([, input]) => input.offset)).toEqual([0, 3, 6])
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/uploads' && input.method === 'POST')).toHaveLength(1)
    expect(h.request.mock.calls.some(([, input]) => /\/uploads\/[^/]+$/u.test(input.path) && input.method === 'GET')).toBe(true)
  })

  it('queries an assembling original after complete timeout and never repeats complete while it is assembling', async () => {
    let held = false, assembling = true
    const h = await harness({ intercept: (input, answer): ForumResult => {
        if (!held && input.path.endsWith('/complete')) { held = true; return uncertain() }
        if (held && assembling && input.method === 'GET' && /\/uploads\/[^/]+$/u.test(input.path) && answer.ok) {
          return { ok: true, payload: { ...answer.payload as Record<string, unknown>, status: 'assembling', attachment: null } }
        }
        return answer
      } }), scope = draft(h)
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [image()])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('unknown') })
    const original = h.snapshot().uploads?.[0]?.operationId
    if (original === undefined) throw new Error('Missing original upload')
    h.control.retryAttachment?.(original)
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('unknown') })
    assembling = false; h.control.retryAttachment?.(original)
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('ready') })
    expect(h.request.mock.calls.filter(([, input]) => input.path.endsWith('/complete'))).toHaveLength(1)
  })

  it.each(['ready', 'assembling', 'uploading'] as const)('restores an original %s upload by GET before requiring a lost local File', async (status) => {
    let lost = false, restoredRead = false
    const h = await harness({ intercept: (input, answer): ForumResult => {
        if (!lost && (status === 'uploading' ? input.path.endsWith('/chunks') : input.path.endsWith('/complete'))) {
          lost = true; return uncertain()
        }
        if (restoredRead && status === 'assembling' && input.method === 'GET'
        && /\/uploads\/[^/]+$/u.test(input.path) && answer.ok) {
          return successful({ ...answer.payload as Record<string, unknown>, status: 'assembling', attachment: null })
        }
        return answer
      } }), scope = draft(h)
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [image()])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('unknown') })
    const operationId = h.snapshot().uploads?.[0]?.operationId
    if (operationId === undefined) throw new Error('Missing original upload')
    await h.control.dispose(); restoredRead = true
    const restored = createForumController(h.account, { enabled: true }, { request: h.request,
      journal: createForumJournal(h.storage), uploadJournal: createForumUploadJournal(h.storage) })
    controls.push(restored); restored.start()
    await vi.waitFor(() => { expect(restored.hooks.forum.getSnapshot().availability).toBe('ready') })
    expect(restored.hooks.forum.getSnapshot().uploads?.[0]?.status).toBe('unknown')
    const before = h.request.mock.calls.length
    restored.retryAttachment?.(operationId)
    await vi.waitFor(() => {
      const current = restored.hooks.forum.getSnapshot().uploads?.[0]
      expect(current?.status).toBe(status === 'ready' ? 'ready' : status === 'assembling' ? 'unknown' : 'select-file')
      expect(h.request.mock.calls.slice(before).filter(([, input]) => /\/uploads\/[^/]+$/u.test(input.path))).toHaveLength(1)
    })
    const recovery = h.request.mock.calls.slice(before).map(([, input]) => input)
    expect(recovery.every(input => input.method === 'GET')).toBe(true)
    if (status === 'ready') expect(restored.hooks.forum.getSnapshot().uploads?.[0]?.attachment?.sha256)
      .toBe(fileDigest(new Uint8Array(await image().arrayBuffer())))
    if (status === 'uploading') {
      const beforeMismatch = h.request.mock.calls.length
      restored.retryAttachment?.(operationId, image([9, 9, 9, 9, 9, 9, 9]))
      await vi.waitFor(() => {
        expect(restored.hooks.forum.getSnapshot().uploads?.[0]?.error?.code).toBe('FORUM_UPLOAD_FILE_MISMATCH')
      })
      expect(h.request.mock.calls.slice(beforeMismatch).every(([, input]) => input.method === 'GET')).toBe(true)
      expect(restored.hooks.forum.getSnapshot().uploads?.[0]?.operationId).toBe(operationId)
    }
  })

  it('freezes reference images and reply target and resolves a lost comment response by receipt GET only', async () => {
    let lost = false
    const h = await harness({ intercept: (input, answer) => {
      if (!lost && input.method === 'POST' && input.path.endsWith('/comments')) { lost = true; return uncertain() }
      return answer
    } })
    h.control.openPost(extendedPostId)
    await vi.waitFor(() => { expect(h.snapshot().comments.items).toHaveLength(1) })
    h.control.setReplyTarget?.(extendedPostId, extendedReplyId)
    await vi.waitFor(() => { expect(h.snapshot().replyTarget?.id).toBe(extendedReplyId) })
    h.control.addAttachments?.({ kind: 'comment', postId: extendedPostId }, [image()])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('ready') })
    h.control.sendComment(extendedPostId)
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.unknown).toBe(true) })
    const original = h.snapshot().pending[0]
    if (original === undefined) throw new Error('Missing original comment')
    h.control.setReplyTarget?.(extendedPostId, null)
    h.control.retryOperation(original.operationId)
    await vi.waitFor(() => { expect(h.snapshot().pending).toHaveLength(0) })
    const requests = h.request.mock.calls.filter(([, input]) => input.method === 'POST' && input.path.endsWith('/comments'))
    expect(requests).toHaveLength(1)
    expect(requestBody(requests[0]![1]).reply_to_comment_id).toBe(extendedReplyId)
    expect(requestBody(requests[0]![1]).attachment_ids).toHaveLength(1)
    expect(h.request.mock.calls.some(([, input]) => input.path.startsWith('/receipts?') && input.method === 'GET')).toBe(true)
    expect(h.snapshot().comments.items.find(item => item.author.id === 1)?.attachments).toHaveLength(1)
  })

  it('discards late upload progress after an account switch and joins the original work on disposal', async () => {
    let finish: ((value: ForumResult) => void) | undefined
    const h = await harness({ intercept: (input, answer) => input.path.endsWith('/chunks') && finish === undefined
        ? new Promise((resolve) => { finish = () => { resolve(answer) } }) : answer }), scope = draft(h)
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [image()])
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    h.account.set(extendedAccount('2', 2))
    expect(h.snapshot().uploads).toEqual([])
    finish?.(uncertain())
    await h.control.dispose()
    expect(h.snapshot().accountId).toBeNull()
    expect(h.request.mock.calls.filter(([, input]) => input.path.endsWith('/chunks'))).toHaveLength(1)
  })
})
