import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreativeError, CreativeStore, parseCreativePlan, type CreativeOwner, type CreativePlan } from '../src/creative-store.ts'
import type { VideoProjectManifest } from '../src/video-project.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

let root: string | undefined
let server: Server | undefined
afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve, reject) => {
    server!.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server!.closeAllConnections()
  })
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const plan = (kind: 'image' | 'video' = 'image'): CreativePlan => ({
  kind, title: '雨夜站台', brief: '穿红围巾的女孩在雨夜车站道别', style: '日系动漫',
  characters: [{ id: 'S1', name: '小雨', appearance: '黑色长发', clothing: '红围巾', personality: '安静', voice: '轻柔中文女声', referenceAssetIds: ['portrait'] }],
  assets: [{ id: 'portrait', name: '人物参考', kind: 'image', role: '身份参考', description: '固定人物外形', sourcePathOrAssetId: 'ma_portrait' }],
  shots: [{ id: 'departure', order: 1, title: '车站道别', durationSeconds: 5, camera: '侧面近景，缓慢推近', scene: '雨夜站台', action: '轻声道别', prompt: '女孩在站台上轻声说再见', dialogue: 'S1 1–3秒：“明天见。”', subtitles: '1–3秒：明天见。', characterIds: ['S1'], assetIds: ['portrait'] }],
})

async function fixture() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'yunshu-creative-store-')))
  const owner: CreativeOwner = { accountId: '7', sessionFingerprint: 'login-7', sessionId: 'chat-a', workspaceRoot: join(root, 'workspace') }
  await mkdir(owner.workspaceRoot)
  let live: Pick<CreativeOwner, 'accountId' | 'sessionFingerprint'> | undefined = owner
  let video: VideoProjectManifest | undefined
  const options = {
    directory: join(root, 'projects'), current: async () => live,
    video: async () => { if (video === undefined) throw new Error('No fixture video'); return video },
  }
  const store = new CreativeStore(options)
  const file = async (name: string, bytes = 'actual saved bytes') => { const path = join(owner.workspaceRoot, name); await writeFile(path, bytes); return path }
  return {
    store, options, owner, file,
    setLive: (value: typeof live) => { live = value }, setVideo: (value: VideoProjectManifest) => { video = value },
  }
}

describe('creation plans and actual generation facts', () => {
  it('retains structured character, material and shot requirements without inventing generated outputs', async () => {
    const { store, owner } = await fixture()
    const id = await store.updatePlan(owner, plan())
    const project = (await store.projects(owner))[0]
    expect(typeof project?.updatedAt).toBe('string')
    expect(project).toMatchObject({ id, ...plan(), status: 'planned', shots: [{ ...plan().shots[0], status: 'planned', outputs: [] }], outputs: [] })
    expect(await store.projects({ ...owner, sessionId: 'chat-b' })).toEqual([])
    expect(await store.projects({ ...owner, accountId: '8' })).toEqual([])
  })

  it('associates real image files only to explicit plan and shot ids and reloads them after a process restart', async () => {
    const { store, owner, options, file } = await fixture()
    const id = await store.updatePlan(owner, plan())
    const other = await store.updatePlan(owner, { ...plan(), title: '另一个项目' })
    await expect(store.begin(owner, { kind: 'image', prompt: 'image', planId: id, shots: [{ prompt: 'image' }] })).rejects.toMatchObject({ code: 'CREATIVE_SHOT_MISMATCH' })
    const operation = await store.begin(owner, { kind: 'image', prompt: 'image', planId: id, shotIds: ['departure'], shots: [{ prompt: 'image' }] })
    expect((await store.projects(owner)).find(project => project.id === id)?.shots[0]?.status).toBe('running')
    const path = await file('girl.png')
    await store.finish(operation, { status: 'completed', paths: [path], kind: 'image' })
    const after = await new CreativeStore(options).projects(owner)
    const project = after.find(project => project.id === id)
    expect(project?.status).toBe('completed')
    expect(project?.outputs).toMatchObject([{ kind: 'image', name: 'girl.png' }])
    expect(project?.outputs[0]?.url).toContain('/credits/api/creative/media?')
    expect(project?.shots[0]?.outputs).toEqual(project?.outputs)
    expect(after.find(project => project.id === other)?.outputs).toEqual([])
    expect(JSON.stringify(project)).not.toContain(owner.workspaceRoot)
    expect(await readFile(path, 'utf8')).toBe('actual saved bytes')
    await expect(store.updatePlan(owner, { ...plan(), shots: [{ ...plan().shots[0]!, id: 'changed' }] }, id)).rejects.toMatchObject({ code: 'CREATIVE_PLAN_CONFLICT' })
  })

  it('creates a minimal real creation when generation did not supply a plan and marks stale in-flight calls interrupted', async () => {
    const { store, owner, options, file } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: '一只白猫', shots: [{ prompt: '一只白猫' }] })
    expect((await store.projects(owner))[0]?.status).toBe('running')
    expect((await new CreativeStore(options).projects(owner))[0]?.status).toBe('interrupted')
    await store.finish(operation, { status: 'completed', kind: 'image', paths: [await file('cat.png')] })
    expect((await store.projects(owner))[0]).toMatchObject({ brief: '一只白猫', status: 'completed', characters: [], assets: [] })
  })

  it('rejects late writes after logout and account/login switches without changing the retained project', async () => {
    const { store, owner, setLive, file, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    const recordPath = join(options.directory, operation.projectId, 'project.json')
    const before = await readFile(recordPath, 'utf8')
    const path = await file('late.png')
    for (const live of [undefined, { accountId: '8', sessionFingerprint: 'login-8' }, { accountId: '7', sessionFingerprint: 'new-login' }]) {
      setLive(live)
      await expect(store.finish(operation, { status: 'completed', kind: 'image', paths: [path] })).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
      expect(await readFile(recordPath, 'utf8')).toBe(before)
    }
  })

  it('shows each committed image before its batch settles and keeps partial files after a later failure', async () => {
    const { store, owner, file } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'two images', shots: [{ prompt: 'two images' }] })
    await store.saved(operation, await file('first.png'), 'image')
    expect((await store.projects(owner))[0]).toMatchObject({ status: 'saving', outputs: [{ name: 'first.png' }] })
    await store.finish(operation, { status: 'failed', errorCode: 'ARTIFACT_WRITE_FAILED' })
    expect((await store.projects(owner))[0]).toMatchObject({ status: 'failed', outputs: [{ name: 'first.png' }] })
    const empty = await store.begin(owner, { kind: 'image', prompt: 'no output', shots: [{ prompt: 'no output' }] })
    await expect(store.finish(empty, { status: 'completed' })).rejects.toMatchObject({ code: 'CREATIVE_OUTPUT_REQUIRED' })
  })

  it('exposes only actual manifest clip/status facts and keeps editing distinct from completion', async () => {
    const { store, owner, file, setVideo, options } = await fixture()
    const clip = await file('clip.mp4')
    const video: VideoProjectManifest = {
      version: 1, id: 'vp_00000000-0000-0000-0000-000000000000' as VideoProjectManifest['id'], ownerSessionId: owner.sessionId,
      workspaceRoot: owner.workspaceRoot, identity: owner, input: { prompt: 'anime', totalDurationSeconds: 5 }, model: 'fixture-model',
      status: 'running', segments: [{ index: 1, durationSeconds: 5, prompt: 'actual shot', request: { model: 'fixture-model', credential: 'not public' }, status: 'running', taskId: 'upstream-id' }],
      outputDirectory: join(owner.workspaceRoot, 'video'), updatedAt: new Date().toISOString(),
    }
    setVideo(video)
    const operation = await store.begin(owner, { kind: 'video', prompt: 'anime', shots: [{ prompt: 'actual shot', durationSeconds: 5 }], videoProjectId: video.id })
    expect((await store.projects(owner))[0]).toMatchObject({ status: 'running', shots: [{ status: 'running', outputs: [] }] })
    video.segments[0]!.status = 'saved'; video.segments[0]!.path = clip; video.status = 'editing'
    expect((await store.projects(owner))[0]).toMatchObject({ status: 'editing', outputs: [], shots: [{ status: 'completed', outputs: [{ name: 'clip.mp4' }] }] })
    expect(JSON.stringify(await store.projects(owner))).not.toContain('not public')
    expect((await new CreativeStore(options).projects(owner))[0]?.status).toBe('interrupted')
    video.status = 'failed'; video.failureCode = 'SUBMISSION_UNKNOWN'
    expect((await store.projects(owner))[0]).toMatchObject({ status: 'unknown', errorCode: 'SUBMISSION_UNKNOWN' })
    video.status = 'completed'; delete video.failureCode; video.finalPath = await file('final.mp4'); video.finalDurationSeconds = 5
    store.release(operation)
    expect((await new CreativeStore(options).projects(owner))[0]).toMatchObject({ status: 'completed', outputs: [{ name: 'final.mp4' }] })
  })

  it('resumes the latest retained record without overwriting a concurrent plan revision or committed asset', async () => {
    const { store, owner, file, options, setVideo } = await fixture()
    const id = await store.updatePlan(owner, plan('video'))
    const video: VideoProjectManifest = {
      version: 1, id: 'vp_00000000-0000-0000-0000-000000000000' as VideoProjectManifest['id'], ownerSessionId: owner.sessionId,
      workspaceRoot: owner.workspaceRoot, identity: owner, input: { prompt: 'anime', totalDurationSeconds: 5 }, model: 'fixture-model',
      status: 'prepared', segments: [{ index: 1, durationSeconds: 5, prompt: 'actual shot', request: { model: 'fixture-model' }, status: 'pending' }],
      outputDirectory: join(owner.workspaceRoot, 'video'), updatedAt: new Date().toISOString(),
    }
    setVideo(video)
    const original = await store.begin(owner, { kind: 'video', prompt: 'anime', planId: id, shotIds: ['departure'], shots: [{ prompt: 'actual shot' }], videoProjectId: video.id })
    store.release(original)
    const snapshotRead = Promise.withResolvers<undefined>()
    const continueResume = Promise.withResolvers<undefined>()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args)
      expect(args[0]).toBe(join(options.directory, id, 'project.json'))
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close()
        snapshotRead.resolve(undefined)
        await continueResume.promise
      })
      return handle
    })
    const resumed = store.resumeVideo(owner, video)
    try {
      await snapshotRead.promise
      await store.updatePlan(owner, { ...plan('video'), title: '并发修改后的标题', brief: '保留最新人物和分镜要求' }, id)
      const asset = await store.begin(owner, { kind: 'image', prompt: 'portrait', planId: id, assetId: 'portrait', shots: [{ prompt: 'portrait' }] })
      await store.finish(asset, { status: 'completed', kind: 'image', paths: [await file('updated-portrait.png')] })
      continueResume.resolve(undefined)
      expect(await resumed).toMatchObject({ projectId: id, operationId: original.operationId })
      const current = (await store.projects(owner))[0]
      expect(current).toMatchObject({ title: '并发修改后的标题', brief: '保留最新人物和分镜要求', assets: [{ id: 'portrait', status: 'completed', outputs: [{ name: 'updated-portrait.png' }] }] })
      expect(current?.outputs).toEqual([])
    } finally {
      continueResume.resolve(undefined)
      vi.mocked(open).mockImplementation(actual.open)
      await resumed
    }
  })

  it('keeps the finished video usable when preview extraction fails and retains successful actual frame sampling', async () => {
    const { store, owner, file } = await fixture()
    const operation = await store.begin(owner, { kind: 'video', prompt: 'video', shots: [{ prompt: 'video' }] })
    const path = await file('video.mp4')
    await store.finish(operation, { status: 'completed', kind: 'video', paths: [path] })
    await store.preview(operation, path, async () => { throw new Error('ffmpeg unavailable') })
    expect((await store.projects(owner))[0]).toMatchObject({ status: 'completed', outputs: [{ previewUnavailable: true, name: 'video.mp4' }] })
    const frame = await file('frame.jpg')
    await store.preview(operation, path, async () => [{ path: frame, timeSeconds: 2.5 }])
    const frames = (await store.projects(owner))[0]?.outputs[0]?.frames
    expect(frames).toMatchObject([{ timeSeconds: 2.5 }])
    expect(frames?.[0]?.url).toContain('frame=0')
  })

  it('rejects an old-login preview after extraction even when a new login has updated the same project owner', async () => {
    const { store, owner, file, setLive, options } = await fixture()
    const id = await store.updatePlan(owner, plan('video'))
    const operation = await store.begin(owner, { kind: 'video', prompt: 'scene', planId: id, shotIds: ['departure'], shots: [{ prompt: 'scene' }] })
    const path = await file('clip.mp4')
    const frame = await file('frame.jpg')
    await store.finish(operation, { status: 'completed', paths: [path], kind: 'video' })
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const pending = store.preview(operation, path, async () => {
      started.resolve(undefined); await release.promise; return [{ path: frame, timeSeconds: 0 }]
    })
    const refused = expect(pending).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
    await started.promise
    const nextOwner = { ...owner, sessionFingerprint: 'login-new' }
    setLive(nextOwner)
    await store.updatePlan(nextOwner, plan('video'), id)
    const recordPath = join(options.directory, id, 'project.json')
    const before = await readFile(recordPath, 'utf8')
    release.resolve(undefined)
    await refused
    expect(await readFile(recordPath, 'utf8')).toBe(before)
    expect((await store.projects(owner))[0]?.outputs[0]?.frames).toBeUndefined()
  })

  it('shows the latest explicit attempt while retaining old files and refusing blind resubmission of unknown charges', async () => {
    const { store, owner, file } = await fixture()
    const id = await store.updatePlan(owner, plan())
    const input = { kind: 'image' as const, prompt: 'scene', planId: id, shotIds: ['departure'], shots: [{ prompt: 'scene' }] }
    const failed = await store.begin(owner, input)
    await store.saved(failed, await file('partial.png'), 'image')
    await store.finish(failed, { status: 'failed', errorCode: 'ARTIFACT_WRITE_FAILED' })
    const retry = await store.begin(owner, input)
    expect((await store.projects(owner))[0]?.status).toBe('running')
    await store.finish(retry, { status: 'completed', kind: 'image', paths: [await file('redo.png')] })
    const completed = (await store.projects(owner))[0]
    expect(completed).toMatchObject({ status: 'completed', shots: [{ status: 'completed' }] })
    expect(completed?.errorCode).toBeUndefined()
    expect(completed?.outputs.map(output => output.name)).toEqual(['partial.png', 'redo.png'])
    const unknown = await store.begin(owner, input)
    await store.finish(unknown, { status: 'unknown', errorCode: 'TRANSPORT' })
    await expect(store.begin(owner, input)).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    expect((await store.projects(owner))[0]).toMatchObject({ status: 'unknown', errorCode: 'SUBMISSION_UNKNOWN' })
  })

  it('retains possible single-generation billing before dispatch and does not permit blind resubmission after restart', async () => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.dispatched(operation)
    expect((await store.projects(owner))[0]?.status).toBe('running')
    const restarted = new CreativeStore(options)
    expect((await restarted.projects(owner))[0]).toMatchObject({ status: 'unknown', errorCode: 'SUBMISSION_UNKNOWN' })
    await expect(restarted.begin(owner, { kind: 'image', prompt: 'one', planId: operation.projectId, shotIds: ['shot_1'], shots: [{ prompt: 'one' }] })).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
  })

  it('refuses invalid ids, broken references, oversized plans and generated-file symlinks', async () => {
    const { store, owner, file } = await fixture()
    expect(() => parseCreativePlan({ ...plan(), shots: [{ ...plan().shots[0], characterIds: ['missing'] }] })).toThrow()
    expect(() => parseCreativePlan({ ...plan(), brief: 'x'.repeat(12_001) })).toThrow()
    expect(() => parseCreativePlan({ ...plan(), shots: [plan().shots[0], plan().shots[0]] })).toThrow()
    await expect(store.updatePlan(owner, plan(), '../../private')).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    const original = await file('real.png')
    const link = join(owner.workspaceRoot, 'symlink.png')
    await symlink(original, link)
    await expect(store.finish(operation, { status: 'completed', paths: [link] })).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
  })

  it('serves only recorded output ids with range support and rejects moved-to-symlink files', async () => {
    const { store, owner, file } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    const path = await file('served.png', '0123456789')
    await store.finish(operation, { status: 'completed', paths: [path] })
    const output = (await store.projects(owner))[0]?.outputs[0]
    if (output === undefined) throw new Error('Expected saved output')
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture')
      void store.serve(request, response, { accountId: '7', sessionFingerprint: owner.sessionFingerprint, sessionId: url.searchParams.get('session_id') ?? '' }, url.searchParams.get('project_id') ?? '', url.searchParams.get('output_id') ?? '').catch(() => { response.writeHead(404); response.end() })
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected fixture listener')
    const base = `http://127.0.0.1:${String(address.port)}`
    const partial = await fetch(base + output.url, { headers: { range: 'bytes=2-5' } })
    expect(partial.status).toBe(206); expect(await partial.text()).toBe('2345')
    expect((await fetch(base + output.url, { method: 'HEAD' })).headers.get('content-length')).toBe('10')
    expect((await fetch(base + output.url.replace('chat-a', 'chat-b'))).status).toBe(404)
    expect((await fetch(base + output.url.replace(output.id, 'out_guessed'))).status).toBe(404)
    const target = await file('unrelated.png', 'never expose')
    await unlink(path); await symlink(target, path)
    expect((await fetch(base + output.url)).status).toBe(404)
  })

  it.each([
    { label: 'sign-out', live: undefined },
    { label: 'account switch', live: { accountId: '8', sessionFingerprint: 'login-8' } },
    { label: 'same-account login generation change', live: { accountId: '7', sessionFingerprint: 'new-login' } },
  ])('refuses media before sending headers after $label during file opening', async ({ live }) => {
    const { store, owner, file, setLive } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    const path = await file('private.png', 'old account private image')
    await store.finish(operation, { status: 'completed', paths: [path], kind: 'image' })
    const output = (await store.projects(owner))[0]?.outputs[0]
    if (output === undefined) throw new Error('Expected saved output')
    const opening = Promise.withResolvers<undefined>()
    const continueOpen = Promise.withResolvers<undefined>()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (args[0] === path) { opening.resolve(undefined); await continueOpen.promise }
      return handle
    })
    let headersSentAtRejection: boolean | undefined
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture')
      void store.serve(request, response, owner, url.searchParams.get('project_id') ?? '', url.searchParams.get('output_id') ?? '').catch((error: unknown) => {
        headersSentAtRejection = response.headersSent
        response.writeHead(error instanceof CreativeError ? error.status : 500)
        response.end(error instanceof CreativeError ? error.code : 'UNEXPECTED')
      })
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected fixture listener')
    const pending = fetch(`http://127.0.0.1:${String(address.port)}` + output.url)
    try {
      await opening.promise
      setLive(live)
      continueOpen.resolve(undefined)
      const result = await pending
      expect(result.status).toBe(409)
      expect(headersSentAtRejection).toBe(false)
      expect(result.headers.get('content-type')).toBeNull()
      expect(await result.text()).toBe('CREATIVE_ACCOUNT_CHANGED')
    } finally {
      continueOpen.resolve(undefined)
      vi.mocked(open).mockImplementation(actual.open)
      await pending
    }
  })
})
