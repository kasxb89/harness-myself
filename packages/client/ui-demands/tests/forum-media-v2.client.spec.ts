/** Media-v2 decoders preserve original order and gate new uploads on backend capacities. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForumConfig } from '../src/client/forum-types.ts'
import type { ForumController } from '../src/client/forum-controller.ts'
import { createForumController } from '../src/client/forum-controller.ts'
import { forumAttachment, forumComment, forumConfig, forumPost } from '../src/client/forum-wire.ts'
import { forumCenterView, forumImageComposer } from '../src/client/forum-adapter.ts'
import { createForumJournal } from '../src/client/forum-pending.ts'
import { createForumUploadJournal } from '../src/client/forum-upload-journal.ts'
import type { DemandTranslate } from '../src/client/DemandUI.tsx'
import { en } from '../src/client/locales.ts'
import { extendedConfiguration, extendedHarness, extendedPostId, successful, uncertain } from './forum-extended-fixtures.client.ts'
import { forumExamplePost } from './forum-model-fixtures.client.ts'

const labels = new Map<string, string>(Object.entries(en))
const t: DemandTranslate = key => labels.get(key) ?? key
const id = '00000000-0000-4000-8000-000000003001'
const video = { id, name: 'forum-video.mp4', kind: 'video', mime_type: 'video/mp4', size_bytes: 7,
  sha256: 'a'.repeat(64), status: 'ready', preview_path: `/attachments/${id}/link`, download_path: `/attachments/${id}/link` }
const config = () => { const old = extendedConfiguration(); return { ...old,
  capabilities: { ...old.capabilities, forum_media_v2: true, video_uploads: true },
  upload_rules_v2: { ...old.upload_rules!, max_image_bytes: 5, max_video_bytes: 10, allowed_mime_types: ['image/png', 'video/mp4'] } } }
const controls: ForumController[] = []
afterEach(async () => { await Promise.all(controls.splice(0).map(control => control.dispose())) })
async function harness(options: Parameters<typeof extendedHarness>[0] = {}) {
  const h = extendedHarness(options); controls.push(h.control)
  await vi.waitFor(() => { expect(h.snapshot().availability).toBe('ready'); expect(h.snapshot().posts.status).toBe('ready') }); return h
}
const movie = () => new File([new Uint8Array([1,2,3,4,5,6,7])], 'private.mp4', { type: 'video/mp4', lastModified: 100 })
function draft(h: Awaited<ReturnType<typeof harness>>) { h.control.startPost(); const scope = h.snapshot().activePostDraftScope!
  h.control.updatePostDraft(scope, { title: '工作流', body: '' }); return scope }

describe('negotiated forum video model', () => {
  it('decodes ready video only in v2 media and projects the authorized content URL', async () => {
    expect(forumAttachment(video).kind).toBe('video')
    const post = forumPost({ ...forumExamplePost(), body: '', attachments: [], media: [video] })
    expect(post.media?.[0]?.kind).toBe('video')
    expect(forumComment({ id, post_id: post.id, body: '', author: post.author, created_at: 1, media: [video] }).media).toHaveLength(1)
    expect(() => forumPost({ ...post, attachments: [video] })).toThrow()
    expect(() => forumPost({ ...post, media: [] })).toThrow()
    expect(() => forumAttachment({ ...video, mime_type: 'video/webm' })).toThrow()
    const h = await harness()
    const view = forumCenterView({ ...h.snapshot(), selectedPostId: post.id, selectedPost: post },
      t, key => `/owner/attachments/${key}/content`)
    expect(view.detail.post?.images).toMatchObject([{ id, kind: 'video', mimeType: 'video/mp4', previewUrl: `/owner/attachments/${id}/content` }])
    expect(JSON.stringify(view)).not.toContain('/link')
  })
  it('rejects inconsistent v2 capacities and does not promote videos from legacy rules', () => {
    expect(forumConfig(config()).upload_rules_v2?.max_video_bytes).toBe(10)
    expect(() => forumConfig({ ...config(), upload_rules_v2: undefined })).toThrow()
    expect(() => forumConfig({ ...config(), upload_rules: { ...extendedConfiguration().upload_rules, allowed_mime_types: ['video/mp4'] } })).toThrow()
    expect(() => forumConfig({ ...config(), capabilities: { ...config().capabilities, forum_media_v2: false } })).toThrow()
  })
  it('normalizes the actual Go upload_rules location only with explicit media-v2 capability', () => {
    const current = config(), sourceRules = current.upload_rules_v2
    expect(forumConfig({ ...current, upload_rules_v2: undefined, upload_rules: sourceRules }))
      .toEqual({ revision: current.revision, enabled: true, capabilities: current.capabilities, upload_rules_v2: sourceRules })
    expect(() => forumConfig({ ...current, upload_rules_v2: undefined, upload_rules: sourceRules,
      capabilities: { ...current.capabilities, forum_media_v2: undefined, video_uploads: undefined } })).toThrow()
  })
  it.each(['legacy', 'off', 'oversize', 'wrong-mime', 'image-size'] as const)('refuses %s before upload init', async (caseName) => {
    const value: ForumConfig = caseName === 'legacy' ? extendedConfiguration() : caseName === 'off'
      ? { ...config(), capabilities: { ...config().capabilities, video_uploads: false } } : config()
    const h = await harness({ config: value }), scope = draft(h)
    const file = caseName === 'oversize' ? new File([new Uint8Array(11)], 'large.mp4', { type: 'video/mp4' })
      : caseName === 'wrong-mime' ? new File(['x'], 'clip.webm', { type: 'video/webm' })
        : caseName === 'image-size' ? new File([new Uint8Array(6)], 'large.png', { type: 'image/png' }) : movie()
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [file])
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/uploads')).toHaveLength(0)
    expect(h.snapshot().uploads).toHaveLength(0)
  })
  it('uploads native bytes once under v2 limits and binds textless video without another operation key', async () => {
    const h = await harness({ config: config() }), scope = draft(h), file = movie()
    const picker = forumImageComposer(h.snapshot(), h.control, { kind: 'post', scopeKey: scope }, t)
    expect(picker?.accept).toBe('image/png,video/mp4'); expect(picker?.maxVideoBytes).toBe(10)
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [file])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('ready') })
    expect([...h.uploads.values()][0]?.bytes).toEqual([...new Uint8Array(await file.arrayBuffer())])
    expect(h.snapshot().uploads?.[0]?.attachment?.kind).toBe('video')
    h.control.publishPost(scope); h.control.publishPost(scope)
    await vi.waitFor(() => { expect(h.snapshot().selectedPost?.media?.[0]?.kind).toBe('video') })
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/uploads' && input.method === 'POST')).toHaveLength(1)
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/posts' && input.method === 'POST')).toHaveLength(1)
    expect(h.snapshot().selectedPost?.attachments).toEqual([])
  })
  it('allows an advertised video-only composer and keeps image choices unavailable', async () => {
    const current = config(), h = await harness({ config: { ...current,
        capabilities: { ...current.capabilities, image_uploads: false } } }), scope = draft(h)
    const picker = forumImageComposer(h.snapshot(), h.control, { kind: 'post', scopeKey: scope }, t)
    expect(picker?.accept).toBe('video/mp4'); expect(picker?.maxBytes).toBeNull()
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [movie()])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('ready') })
    h.control.publishPost(scope)
    await vi.waitFor(() => { expect(h.snapshot().selectedPost?.media?.[0]?.kind).toBe('video') })
    expect(h.snapshot().pending).toHaveLength(0)
  })
  it('freezes a video-only comment and resolves a lost response by the original receipt without duplicate POST', async () => {
    let lost = false
    const h = await harness({ config: config(), intercept: (input, answer) => {
      if (!lost && input.method === 'POST' && input.path.endsWith('/comments')) { lost = true; return uncertain() }; return answer
    } })
    h.control.openPost(extendedPostId)
    await vi.waitFor(() => { expect(h.snapshot().selectedPost?.id).toBe(extendedPostId) })
    h.control.addAttachments?.({ kind: 'comment', postId: extendedPostId }, [movie()])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('ready') })
    h.control.sendComment(extendedPostId)
    await vi.waitFor(() => { expect(h.snapshot().pending[0]?.error?.unknown).toBe(true) })
    const original = h.snapshot().pending[0]!.operationId
    h.control.retryOperation(original)
    await vi.waitFor(() => { expect(h.snapshot().pending).toHaveLength(0) })
    expect(h.snapshot().comments.items.find(item => item.author.id === 1)?.media?.[0]?.kind).toBe('video')
    expect(h.request.mock.calls.filter(([, input]) => input.method === 'POST' && input.path.endsWith('/comments'))).toHaveLength(1)
    expect(h.request.mock.calls.filter(([, input]) => input.path.startsWith('/receipts?'))).toHaveLength(1)
  })
  it('preserves retained video when capability refresh removes upload support and blocks new publication', async () => {
    let advertised: ForumConfig = config()
    const h = await harness({ config: config(), intercept: (input, answer) => input.path === '/config' ? successful(advertised) : answer }), scope = draft(h)
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [movie()])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('ready') })
    const original = h.snapshot().uploads![0]!
    advertised = extendedConfiguration(); h.control.refresh()
    await vi.waitFor(() => { expect(h.snapshot().config?.capabilities.forum_media_v2).toBeUndefined() })
    h.control.publishPost(scope)
    expect(h.snapshot().uploads?.[0]?.operationId).toBe(original.operationId)
    expect(h.snapshot().uploads?.[0]?.attachment).toEqual(original.attachment)
    expect(h.request.mock.calls.filter(([, input]) => input.path === '/posts' && input.method === 'POST')).toHaveLength(0)
    const picker = forumImageComposer(h.snapshot(), h.control, { kind: 'post', scopeKey: scope }, t)
    expect(picker?.items[0]?.kind).toBe('video'); expect(picker?.accept).toBe('image/png')
  })
  it('recovers a ready original video by GET without a File, new init or complete after restart', async () => {
    let lost = false
    const h = await harness({ config: config(), intercept: (input, answer) => {
        if (!lost && input.path.endsWith('/complete')) { lost = true; return uncertain() }; return answer
      } }), scope = draft(h)
    h.control.addAttachments?.({ kind: 'post', scopeKey: scope }, [movie()])
    await vi.waitFor(() => { expect(h.snapshot().uploads?.[0]?.status).toBe('unknown') })
    const original = h.snapshot().uploads![0]!.operationId; await h.control.dispose()
    const restored = createForumController(h.account, { enabled: true }, { request: h.request,
      journal: createForumJournal(h.storage), uploadJournal: createForumUploadJournal(h.storage) })
    controls.push(restored); restored.start()
    await vi.waitFor(() => { expect(restored.hooks.forum.getSnapshot().availability).toBe('ready') })
    const start = h.request.mock.calls.length; restored.retryAttachment?.(original)
    await vi.waitFor(() => { expect(restored.hooks.forum.getSnapshot().uploads?.[0]?.status).toBe('ready') })
    expect(restored.hooks.forum.getSnapshot().uploads?.[0]?.operationId).toBe(original)
    expect(h.request.mock.calls.slice(start).map(([, input]) => input.method)).toEqual(['GET'])
    expect(h.request.mock.calls.filter(([, input]) => input.path.endsWith('/complete'))).toHaveLength(1)
  })
})
