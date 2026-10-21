import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreativeError, CreativeStore, creativePlanRevision, parseCreativePlan, parseCreativePlanChange, type CreativeOwner, type CreativePlan } from '../src/creative-store.ts'
import type { VideoProjectManifest, VideoProjectRead } from '../src/video-project.ts'
import type { CreativeImageReceipt, CreativePlanChange } from '../src/creative-types.ts'

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

const acceptedImage: CreativeImageReceipt = {
  route: '/toapis/v1/images/generations', model: 'yunshu-internal-gpt-image-2', phase: 'accepted',
  taskId: 'task-original', requestId: 'req-original', backendFingerprint: 'a'.repeat(64),
}
const submittingImage: CreativeImageReceipt = {
  route: acceptedImage.route, model: acceptedImage.model, phase: 'submitting',
  requestId: 'req-original', backendFingerprint: acceptedImage.backendFingerprint,
}

async function fixture() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'yunshu-creative-store-')))
  const owner: CreativeOwner = { accountId: '7', sessionFingerprint: 'login-7', sessionId: 'chat-a', workspaceRoot: join(root, 'workspace') }
  await mkdir(owner.workspaceRoot)
  let live: Pick<CreativeOwner, 'accountId' | 'sessionFingerprint'> | undefined = owner
  let video: VideoProjectRead | undefined
  const options = {
    directory: join(root, 'projects'), current: async () => live,
    video: async () => { if (video === undefined) throw new Error('No fixture video'); return video },
  }
  const store = new CreativeStore(options)
  const file = async (name: string, bytes = 'actual saved bytes') => { const path = join(owner.workspaceRoot, name); await writeFile(path, bytes); return path }
  return {
    store, options, owner, file,
    setLive: (value: typeof live) => { live = value }, setVideo: (value: VideoProjectRead) => { video = value },
  }
}

describe('retained image receipts and query-only recovery', () => {
  it('retains an accepted receipt across restart and settles the original invocation without another begin', async () => {
    const { store, owner, options, file, setLive } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.dispatched(operation)
    await store.receipt(operation, submittingImage)
    await store.receipt(operation, { route: acceptedImage.route, model: acceptedImage.model, phase: 'accepted',
      taskId: 'task-original', backendFingerprint: acceptedImage.backendFingerprint })
    expect((await store.projects(owner))[0]?.tasks[0]).toMatchObject({
      imageReceipt: acceptedImage, canQuery: false, status: 'running', model: acceptedImage.model,
    })
    store.release(operation)
    const restarted = new CreativeStore(options)
    expect((await restarted.projects(owner))[0]?.tasks[0]).toMatchObject({
      imageReceipt: acceptedImage, canQuery: true, status: 'unknown', errorCode: 'SUBMISSION_UNKNOWN',
    })
    await expect(restarted.begin(owner, { kind: 'image', prompt: 'one', planId: operation.projectId,
      shotIds: ['shot_1'], shots: [{ prompt: 'one' }] })).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    const currentOwner = { ...owner, sessionFingerprint: 'new-login-7' }
    setLive(currentOwner)
    const recovered = await restarted.resumeImage(currentOwner, operation.projectId, operation.operationId)
    expect(recovered).toEqual({ operation: { ...operation, owner: currentOwner }, receipt: acceptedImage })
    expect((await restarted.projects(currentOwner))[0]?.tasks[0]).toMatchObject({ status: 'running', canQuery: false })
    expect((await restarted.projects(currentOwner))[0]?.tasks[0]?.errorCode).toBeUndefined()
    await expect(restarted.resumeImage(currentOwner, operation.projectId, operation.operationId))
      .rejects.toMatchObject({ code: 'CREATIVE_SHOT_RUNNING' })
    await restarted.finish(recovered.operation, { status: 'unknown', errorCode: 'TRANSPORT' })
    expect((await restarted.projects(currentOwner))[0]?.tasks[0]?.canQuery).toBe(true)
    const secondRead = await restarted.resumeImage(currentOwner, operation.projectId, operation.operationId)
    await restarted.receipt(secondRead.operation, { ...acceptedImage, phase: 'completed' })
    await restarted.finish(secondRead.operation, { status: 'completed', paths: [await file('recovered.png')], kind: 'image' })
    const project = (await restarted.projects(currentOwner))[0]
    expect(project).toMatchObject({ status: 'completed', tasks: [{ id: operation.operationId,
      status: 'completed', imageReceipt: { ...acceptedImage, phase: 'completed' }, canQuery: false }],
    outputs: [{ name: 'recovered.png' }] })
    expect(project?.tasks).toHaveLength(1)
    expect(project?.tasks[0]?.errorCode).toBeUndefined()
    await expect(restarted.resumeImage(currentOwner, operation.projectId, operation.operationId))
      .rejects.toMatchObject({ code: 'CREATIVE_IMAGE_TASK_SETTLED' })
  })

  it('keeps legacy dispatched cancellations uncertain without rewriting the original record', async () => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'legacy', shots: [{ prompt: 'legacy' }] })
    await store.dispatched(operation)
    await store.finish(operation, { status: 'unknown' })
    const path = join(options.directory, operation.projectId, 'project.json')
    const legacy = JSON.parse(await readFile(path, 'utf8')) as { operations: { status: string }[] }
    legacy.operations[0]!.status = 'cancelled'
    await writeFile(path, JSON.stringify(legacy))
    const before = await readFile(path, 'utf8')
    const restarted = new CreativeStore(options)
    expect(await restarted.projects(owner)).toMatchObject([{ status: 'unknown', tasks: [{ status: 'unknown' }] }])
    await expect(restarted.begin(owner, { kind: 'image', prompt: 'retry', planId: operation.projectId,
      shotIds: ['shot_1'], shots: [{ prompt: 'retry' }] })).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('keeps cancellation after dispatch uncertain and refuses another paid invocation', async () => {
    const { store, owner } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.receipt(operation, acceptedImage)
    await store.finish(operation, { status: 'cancelled' })
    expect((await store.projects(owner))[0]).toMatchObject({ status: 'unknown', tasks: [{
      status: 'unknown', imageReceipt: acceptedImage, canQuery: true,
    }] })
    await expect(store.begin(owner, { kind: 'image', prompt: 'one', planId: operation.projectId,
      shotIds: ['shot_1'], shots: [{ prompt: 'one' }] })).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
  })

  it('preserves cancellation only when the executor proves no submission and no receipt id exists', async () => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.dispatched(operation)
    await store.receipt(operation, { route: acceptedImage.route, model: acceptedImage.model, phase: 'submitting',
      backendFingerprint: acceptedImage.backendFingerprint })
    await store.finish(operation, { status: 'cancelled', notSubmitted: true })
    expect((await new CreativeStore(options).projects(owner))[0]?.tasks[0]).toMatchObject({ status: 'cancelled' })
    expect((await store.projects(owner))[0]?.tasks[0]?.canQuery).toBeUndefined()
    expect((await store.projects(owner))[0]?.tasks[0]?.imageReceipt).toBeUndefined()
    await expect(store.begin(owner, { kind: 'image', prompt: 'explicit request', planId: operation.projectId,
      shotIds: ['shot_1'], shots: [{ prompt: 'explicit request' }] })).resolves.toMatchObject({ projectId: operation.projectId })
  })

  it('rejects a not-submitted claim after a request id or accepted task was retained', async () => {
    const { store, owner, options } = await fixture()
    for (const receipt of [submittingImage, acceptedImage]) {
      const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
      await store.receipt(operation, receipt)
      const path = join(options.directory, operation.projectId, 'project.json')
      const before = await readFile(path, 'utf8')
      await expect(store.finish(operation, { status: 'cancelled', notSubmitted: true }))
        .rejects.toMatchObject({ code: 'CREATIVE_IMAGE_RECEIPT_CONFLICT' })
      expect(await readFile(path, 'utf8')).toBe(before)
      expect((await new CreativeStore(options).projects(owner)).find(project => project.id === operation.projectId)?.tasks[0])
        .toMatchObject({ status: 'unknown', imageReceipt: receipt })
    }
  })

  it('retains a request id without inventing a task id or allowing query or resubmission', async () => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.receipt(operation, submittingImage)
    await store.finish(operation, { status: 'unknown', errorCode: 'TRANSPORT' })
    const restarted = new CreativeStore(options)
    expect((await restarted.projects(owner))[0]?.tasks[0]).toMatchObject({
      imageReceipt: { phase: 'submitting', requestId: 'req-original' }, canQuery: false,
    })
    const path = join(options.directory, operation.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    await expect(restarted.resumeImage(owner, operation.projectId, operation.operationId))
      .rejects.toMatchObject({ code: 'CREATIVE_IMAGE_TASK_UNCONFIRMED' })
    await expect(restarted.begin(owner, { kind: 'image', prompt: 'one', planId: operation.projectId,
      shotIds: ['shot_1'], shots: [{ prompt: 'one' }] })).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('allows inline completion without a task id and leaves legacy unknown records locked', async () => {
    const { store, owner, options, file } = await fixture()
    const inline = await store.begin(owner, { kind: 'image', prompt: 'inline', shots: [{ prompt: 'inline' }] })
    await store.receipt(inline, { ...submittingImage, phase: 'completed' })
    await store.finish(inline, { status: 'completed', paths: [await file('inline.png')], kind: 'image' })
    expect((await store.projects(owner))[0]?.tasks[0]).toMatchObject({
      status: 'completed', imageReceipt: { phase: 'completed' }, canQuery: false,
    })
    const legacy = await store.begin(owner, { kind: 'image', prompt: 'legacy', shots: [{ prompt: 'legacy' }] })
    await store.dispatched(legacy)
    store.release(legacy)
    const restarted = new CreativeStore(options)
    const project = (await restarted.projects(owner)).find(project => project.id === legacy.projectId)
    expect(project?.tasks[0]).toMatchObject({ status: 'unknown' })
    expect(project?.tasks[0]?.imageReceipt).toBeUndefined()
    await expect(restarted.resumeImage(owner, legacy.projectId, legacy.operationId))
      .rejects.toMatchObject({ code: 'CREATIVE_IMAGE_TASK_UNCONFIRMED' })
    await expect(restarted.begin(owner, { kind: 'image', prompt: 'legacy', planId: legacy.projectId,
      shotIds: ['shot_1'], shots: [{ prompt: 'legacy' }] })).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
  })

  it('retains partial files and concurrent plan edits while exclusively recovering an image material', async () => {
    const { store, owner, file } = await fixture()
    const id = await store.updatePlan(owner, plan('video'))
    const operation = await store.begin(owner, { kind: 'image', prompt: 'portrait', planId: id, assetId: 'portrait', shots: [{ prompt: 'portrait' }] })
    await store.receipt(operation, acceptedImage)
    await store.saved(operation, await file('partial.png'), 'image')
    await store.finish(operation, { status: 'unknown', errorCode: 'TRANSPORT' })
    await store.updatePlan(owner, { ...plan('video'), title: '用户已修改的计划' }, id)
    const outcomes = await Promise.allSettled([
      store.resumeImage(owner, id, operation.operationId), store.resumeImage(owner, id, operation.operationId),
    ])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
    const recovered = outcomes.find(result => result.status === 'fulfilled')
    if (recovered?.status !== 'fulfilled') throw new Error('Expected a single owned recovery')
    await store.finish(recovered.value.operation, { status: 'failed', errorCode: 'TASK_FAILED' })
    const project = (await store.projects(owner))[0]
    expect(project).toMatchObject({ title: '用户已修改的计划', assets: [{ id: 'portrait', status: 'failed', outputs: [{ name: 'partial.png' }] }],
      tasks: [{ id: operation.operationId, status: 'failed', canQuery: false }] })
    await expect(store.begin(owner, { kind: 'image', prompt: 'explicit new portrait', planId: id,
      assetId: 'portrait', shots: [{ prompt: 'explicit new portrait' }] })).resolves.toMatchObject({ projectId: id })
  })

  it('matches only original image outputs after partial-result restart without writing or a JSON-size image limit', async () => {
    const { store, owner, options, file } = await fixture()
    const earlier = await store.begin(owner, { kind: 'image', prompt: 'earlier', shots: [{ prompt: 'earlier' }] })
    const earlierBytes = Buffer.from('earlier operation image')
    await store.finish(earlier, { status: 'completed', paths: [await file('earlier.png', earlierBytes.toString())], kind: 'image' })
    const operation = await store.begin(owner, { kind: 'image', prompt: 'partial', planId: earlier.projectId,
      shotIds: ['shot_1'], shots: [{ prompt: 'partial' }] })
    await store.receipt(operation, acceptedImage)
    const path = await file('partial-large.png')
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 123, 71)
    await writeFile(path, bytes)
    await store.saved(operation, path, 'image')
    await store.finish(operation, { status: 'unknown', errorCode: 'TRANSPORT' })
    const restarted = new CreativeStore(options)
    const recovered = await restarted.resumeImage(owner, operation.projectId, operation.operationId)
    const recordPath = join(options.directory, operation.projectId, 'project.json')
    const before = await readFile(recordPath, 'utf8')
    expect(await restarted.matchImageOutput(recovered.operation, bytes)).toBe(path)
    const different = Buffer.from(bytes)
    different[different.byteLength - 1] = 72
    expect(await restarted.matchImageOutput(recovered.operation, different)).toBeUndefined()
    expect(await restarted.matchImageOutput(recovered.operation, earlierBytes)).toBeUndefined()
    expect(await restarted.matchImageOutput(recovered.operation, bytes.subarray(1))).toBeUndefined()
    expect((await readFile(path)).equals(bytes)).toBe(true)
    expect(await readFile(recordPath, 'utf8')).toBe(before)
    await restarted.saved(recovered.operation, path, 'image')
    expect((await restarted.projects(owner))[0]?.tasks.find(task => task.id === operation.operationId)?.outputs).toHaveLength(1)
    await rm(path)
    expect(await restarted.matchImageOutput(recovered.operation, bytes)).toBeUndefined()
  })

  it.each(['rewrite', 'replacement'] as const)('does not reuse an image changed by %s during comparison', async (change) => {
    const { store, owner, options, file } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'partial', shots: [{ prompt: 'partial' }] })
    await store.receipt(operation, acceptedImage)
    const path = await file('partial.png')
    const bytes = Buffer.alloc(128 * 1024 + 123, 71)
    await writeFile(path, bytes)
    const timestamp = new Date('2000-01-01T00:00:00.000Z')
    await utimes(path, timestamp, timestamp)
    await store.saved(operation, path, 'image')
    const recordPath = join(options.directory, operation.projectId, 'project.json')
    const recordBefore = await readFile(recordPath, 'utf8')
    const before = await stat(path, { bigint: true })
    const comparedFirstBlock = Promise.withResolvers<undefined>()
    const continueReading = Promise.withResolvers<undefined>()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (args[0] === path) {
        const read = handle.read.bind(handle)
        Object.defineProperty(handle, 'read', { value: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          if (position === 64 * 1024) {
            comparedFirstBlock.resolve(undefined)
            await continueReading.promise
          }
          return await read(buffer, offset, length, position)
        } })
      }
      return handle
    })
    const matching = store.matchImageOutput(operation, bytes)
    const edited = Buffer.from(bytes)
    edited[0] = 72
    const retained = join(owner.workspaceRoot, 'retained-original.png')
    try {
      await comparedFirstBlock.promise
      if (change === 'rewrite') {
        await writeFile(path, edited)
        // Whole-second timestamps round-trip on Windows; compare observed stats, not the requested Date.
        await utimes(path, timestamp, timestamp)
        const changed = await stat(path, { bigint: true })
        expect(changed.mtimeNs).toBe(before.mtimeNs)
        expect(changed.ctimeNs).not.toBe(before.ctimeNs)
      } else {
        await rename(path, retained)
        await writeFile(path, bytes)
        await utimes(path, timestamp, timestamp)
        expect((await stat(path, { bigint: true })).ino).not.toBe(before.ino)
      }
      continueReading.resolve(undefined)
      expect(await matching).toBeUndefined()
      expect(await readFile(path)).toEqual(change === 'rewrite' ? edited : bytes)
      if (change === 'replacement') expect(await readFile(retained)).toEqual(bytes)
      expect(await readFile(recordPath, 'utf8')).toBe(recordBefore)
      expect((await store.projects(owner))[0]?.tasks).toMatchObject([{ id: operation.operationId,
        status: 'saving', imageReceipt: acceptedImage, outputs: [{ name: 'partial.png' }] }])
    } finally {
      continueReading.resolve(undefined)
      vi.mocked(open).mockImplementation(actual.open)
      await matching
    }
  })

  it('rejects another account, chat, workspace and late old-login receipt writes', async () => {
    const { store, owner, setLive, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.receipt(operation, acceptedImage)
    store.release(operation)
    const path = join(options.directory, operation.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    await expect(store.receipt({ ...operation, owner: { ...owner, workspaceRoot: join(owner.workspaceRoot, 'other') } }, acceptedImage))
      .rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    await expect(store.resumeImage({ ...owner, sessionId: 'other-chat' }, operation.projectId, operation.operationId))
      .rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    await expect(store.resumeImage({ ...owner, workspaceRoot: join(owner.workspaceRoot, 'other') }, operation.projectId, operation.operationId))
      .rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    setLive({ accountId: '8', sessionFingerprint: 'login-8' })
    await expect(store.resumeImage({ ...owner, accountId: '8', sessionFingerprint: 'login-8' }, operation.projectId, operation.operationId))
      .rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    setLive({ ...owner, sessionFingerprint: 'new-login-7' })
    await expect(store.receipt(operation, acceptedImage)).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('rejects unsafe receipt fields and changed task identities without rewriting the original record', async () => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    for (const receipt of [
      ...['https://user:password@example.test/image', '//example.test/image', '/toapis/../image',
        '/toapis/image?token=private', '/toapis/image#private', '/toapis/image\\private'].map(route => ({ ...acceptedImage, route })),
      ...['', 'sk-private-key', 'nap_private', 'task/private', 'private\nheader', 'x'.repeat(257)].map(taskId => ({ ...acceptedImage, taskId })),
      { ...acceptedImage, backendFingerprint: 'not-a-backend' },
      { ...submittingImage, phase: 'accepted' as const },
    ]) await expect(store.receipt(operation, receipt)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    await store.receipt(operation, acceptedImage)
    const path = join(options.directory, operation.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    for (const receipt of [
      { ...acceptedImage, route: '/v1/images/generations' }, { ...acceptedImage, model: 'other-model' },
      { ...acceptedImage, taskId: 'other-task' }, { ...acceptedImage, requestId: 'other-request' },
      { ...acceptedImage, backendFingerprint: 'b'.repeat(64) }, { ...acceptedImage, phase: 'submitting' as const },
    ]) await expect(store.receipt(operation, receipt)).rejects.toMatchObject({ code: 'CREATIVE_IMAGE_RECEIPT_CONFLICT' })
    expect(await readFile(path, 'utf8')).toBe(before)
    store.release(operation)
    await expect(store.receipt(operation, acceptedImage)).rejects.toMatchObject({ code: 'CREATIVE_IMAGE_NOT_RUNNING' })
    const corrupted = JSON.parse(before) as { operations: { imageReceipt: object }[] }
    corrupted.operations[0]!.imageReceipt = { ...acceptedImage, backendFingerprint: 'unsafe' }
    await writeFile(path, JSON.stringify(corrupted))
    await expect(new CreativeStore(options).projects(owner)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
  })
})

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
    expect((await store.projects(owner))[0]).toMatchObject({ status: 'editing', outputs: [{ name: 'clip.mp4' }], shots: [{ status: 'completed', outputs: [{ name: 'clip.mp4' }] }] })
    expect(JSON.stringify(await store.projects(owner))).not.toContain('not public')
    expect((await new CreativeStore(options).projects(owner))[0]?.status).toBe('interrupted')
    video.status = 'failed'; video.failureCode = 'SUBMISSION_UNKNOWN'
    expect((await store.projects(owner))[0]).toMatchObject({ status: 'unknown', errorCode: 'SUBMISSION_UNKNOWN' })
    video.status = 'completed'; delete video.failureCode; video.finalPath = await file('final.mp4'); video.finalDurationSeconds = 5
    store.release(operation)
    expect((await new CreativeStore(options).projects(owner))[0]).toMatchObject({ status: 'completed', outputs: [{ name: 'clip.mp4' }, { name: 'final.mp4' }] })
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
      expect(current?.outputs).toMatchObject([{ name: 'updated-portrait.png' }])
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

describe('creation plan revisions and task projections', () => {
  it('parses every supported browser edit and rejects execution fields and malformed values', () => {
    const valid: CreativePlanChange[] = [
      { kind: 'shot', id: 'departure', patch: { title: '镜头', durationSeconds: 8, camera: '推近', scene: '雨夜', action: '挥手', prompt: '女孩挥手', dialogue: '再见', subtitles: '再见', characterIds: ['S1'], assetIds: ['portrait'] } },
      { kind: 'reorder', shotIds: ['departure'] }, { kind: 'character', value: plan().characters[0]! },
      { kind: 'asset', value: plan().assets[0]! }, { kind: 'add-shot', value: plan().shots[0]! },
      { kind: 'remove-character', id: 'S1' }, { kind: 'remove-asset', id: 'portrait' }, { kind: 'remove-shot', id: 'departure' },
    ]
    valid.forEach((change) => { expect(parseCreativePlanChange(JSON.parse(JSON.stringify(change)))).toEqual(change) })
    for (const invalid of [null, [], {}, { kind: 'generate', id: 'departure' },
      { kind: 'shot', id: 'departure', patch: { status: 'completed' } },
      { kind: 'shot', id: 'departure', patch: { durationSeconds: 0 } },
      { kind: 'shot', id: '../outside', patch: {} }, { kind: 'reorder', shotIds: [1] },
      { kind: 'character', value: { ...plan().characters[0], outputs: [] } },
      { kind: 'asset', value: { ...plan().assets[0], sourcePathOrAssetId: null } },
      { kind: 'add-shot', value: { ...plan().shots[0], actualDurationSeconds: 30 } },
      { kind: 'remove-shot', id: 'departure', owner: 'other' },
    ]) expect(() => parseCreativePlanChange(invalid)).toThrow(CreativeError)
  })

  it('keeps normalized plan revisions stable across progress, login generations and old v1 records', async () => {
    const { store, owner, options, file, setLive } = await fixture()
    const id = await store.updatePlan(owner, plan())
    const before = (await store.projects(owner))[0]!
    expect(before).toMatchObject({ sessionId: owner.sessionId, tasks: [], completedShots: 0, totalShots: 1 })
    expect(before.planRevision).toMatch(/^[a-f0-9]{64}$/u)
    expect(creativePlanRevision(await store.plan(owner, id))).toBe(before.planRevision)
    const operation = await store.begin(owner, { kind: 'image', model: 'gpt-image-2', prompt: 'scene', planId: id,
      shotIds: ['departure'], shots: [{ prompt: 'scene' }] })
    await store.saved(operation, await file('progress.png'), 'image')
    const running = (await store.projects(owner))[0]!
    expect(running.planRevision).toBe(before.planRevision)
    expect(running.tasks).toMatchObject([{ id: operation.operationId, model: 'gpt-image-2', status: 'saving', shotIds: ['departure'], outputs: [{ name: 'progress.png' }], completedShots: 0, totalShots: 1 }])
    await store.finish(operation, { status: 'completed', paths: [await file('done.png')], kind: 'image' })
    const completed = (await store.projects(owner))[0]!
    expect(completed.planRevision).toBe(before.planRevision)
    expect(completed).toMatchObject({ completedShots: 1, totalShots: 1, tasks: [{ completedShots: 1, totalShots: 1 }] })
    const nextOwner = { ...owner, sessionFingerprint: 'new-login' }
    setLive(nextOwner)
    await store.updatePlan(nextOwner, plan(), id)
    expect((await new CreativeStore(options).projects(nextOwner))[0]?.planRevision).toBe(before.planRevision)
    const path = join(options.directory, id, 'project.json')
    const legacy = JSON.parse(await readFile(path, 'utf8')) as { version: number; operations: { model?: string }[] }
    delete legacy.operations[0]!.model
    await writeFile(path, JSON.stringify(legacy))
    const restored = (await new CreativeStore(options).projects(nextOwner))[0]!
    expect(legacy.version).toBe(1)
    expect(restored.planRevision).toBe(before.planRevision)
    expect(restored.tasks[0]?.model).toBeUndefined()
    expect(JSON.stringify(restored)).not.toMatch(/sessionFingerprint|workspaceRoot|new-login|request/u)
  })

  it('accepts only one concurrent edit of a displayed revision and does not overwrite its winner', async () => {
    const { store, owner, options } = await fixture()
    const id = await store.updatePlan(owner, plan())
    const current = (await store.projects(owner))[0]!
    const changes = await Promise.allSettled([
      store.revise(owner, id, current.planRevision, { kind: 'shot', id: 'departure', patch: { title: '新的镜头标题', durationSeconds: 8 } }),
      store.revise(owner, id, current.planRevision, { kind: 'shot', id: 'departure', patch: { title: '过期的改动' } }),
    ])
    expect(changes[0]).toEqual({ status: 'fulfilled', value: id })
    expect(changes[1]).toMatchObject({ status: 'rejected', reason: { code: 'CREATIVE_PLAN_STALE', status: 409 } })
    const project = (await new CreativeStore(options).projects(owner))[0]!
    expect(project.planRevision).not.toBe(current.planRevision)
    expect(project.shots[0]).toMatchObject({ title: '新的镜头标题', durationSeconds: 8 })
  })

  it('checks the prepared planning revision in the same queue that records a generation and locks its shots', async () => {
    const { store, owner, options } = await fixture()
    const id = await store.updatePlan(owner, plan('video'))
    const expectedRevision = creativePlanRevision(await store.plan(owner, id))
    const change: CreativePlanChange = { kind: 'shot', id: 'departure', patch: { prompt: '用户刚刚修改的镜头' } }
    const changed = store.revise(owner, id, expectedRevision, change)
    const begin = store.begin(owner, {
      kind: 'video', planId: id, shotIds: ['departure'], expectedRevision,
      prompt: '旧的分镜', shots: [{ prompt: '旧的分镜', durationSeconds: 5 }],
    })
    await expect(changed).resolves.toBe(id)
    await expect(begin).rejects.toMatchObject({ code: 'CREATIVE_PLAN_STALE', status: 409 })
    const current = (await new CreativeStore(options).projects(owner))[0]!
    expect(current).toMatchObject({ shots: [{ prompt: '用户刚刚修改的镜头', status: 'planned' }], tasks: [], outputs: [] })
    const operation = await store.begin(owner, {
      kind: 'video', planId: id, shotIds: ['departure'], expectedRevision: current.planRevision,
      prompt: '最新分镜', shots: [{ prompt: '最新分镜', durationSeconds: 5 }],
    })
    try {
      await expect(store.revise(owner, id, current.planRevision, {
        kind: 'shot', id: 'departure', patch: { prompt: '运行期间的改稿' },
      })).rejects.toMatchObject({ code: 'CREATIVE_PLAN_RUNNING', status: 409 })
      expect((await store.projects(owner))[0]?.tasks).toMatchObject([{ id: operation.operationId, status: 'running' }])
    } finally { store.release(operation) }
  })

  it('edits, adds, reorders and explicitly removes unreferenced plan entries without starting generation', async () => {
    const { store, owner } = await fixture()
    const id = await store.updatePlan(owner, plan())
    const change = async (value: CreativePlanChange) => {
      const before = (await store.projects(owner))[0]!
      await store.revise(owner, id, before.planRevision, value)
      return (await store.projects(owner))[0]!
    }
    const otherShot = { ...plan().shots[0]!, id: 'arrival', order: 2, title: '抵达' }
    await change({ kind: 'add-shot', value: otherShot })
    expect((await change({ kind: 'reorder', shotIds: ['arrival', 'departure'] })).shots.map(shot => [shot.id, shot.order]))
      .toEqual([['arrival', 1], ['departure', 2]])
    await change({ kind: 'character', value: { ...plan().characters[0]!, appearance: '短发', voice: '温柔女声' } })
    await change({ kind: 'asset', value: { ...plan().assets[0]!, description: '新的参考要求' } })
    for (const shot of ['arrival', 'departure']) await change({ kind: 'shot', id: shot, patch: { characterIds: [], assetIds: [] } })
    await change({ kind: 'remove-character', id: 'S1' })
    await change({ kind: 'remove-asset', id: 'portrait' })
    const final = await change({ kind: 'remove-shot', id: 'arrival' })
    expect(final).toMatchObject({ characters: [], assets: [], tasks: [], outputs: [], shots: [{ id: 'departure' }] })
  })

  it('rejects referenced deletions, invalid ordering and malformed complete plans without persisting them', async () => {
    const { store, owner, options } = await fixture()
    const id = await store.updatePlan(owner, plan())
    const current = (await store.projects(owner))[0]!
    const record = await readFile(join(options.directory, id, 'project.json'), 'utf8')
    const changes: CreativePlanChange[] = [
      { kind: 'remove-character', id: 'S1' }, { kind: 'remove-asset', id: 'portrait' }, { kind: 'remove-shot', id: 'departure' },
      { kind: 'reorder', shotIds: [] }, { kind: 'reorder', shotIds: ['missing'] },
      { kind: 'shot', id: 'missing', patch: { title: '不存在' } },
      { kind: 'shot', id: 'departure', patch: { durationSeconds: -1 } },
      { kind: 'shot', id: 'departure', patch: { characterIds: ['missing'] } },
      { kind: 'add-shot', value: { ...plan().shots[0]! } },
    ]
    for (const change of changes) {
      await expect(store.revise(owner, id, current.planRevision, change)).rejects.toBeInstanceOf(CreativeError)
      expect(await readFile(join(options.directory, id, 'project.json'), 'utf8')).toBe(record)
    }
  })

  it('blocks edits to running shots and their character/reference data while allowing unrelated changes', async () => {
    const { store, owner } = await fixture()
    const initial = plan()
    const id = await store.updatePlan(owner, { ...initial, shots: [...initial.shots, { ...initial.shots[0]!, id: 'other', order: 2 }] })
    const current = (await store.projects(owner))[0]!
    const operation = await store.begin(owner, { kind: 'image', prompt: 'running', planId: id, shotIds: ['departure'], shots: [{ prompt: 'running' }] })
    const forbidden: CreativePlanChange[] = [
      { kind: 'shot', id: 'departure', patch: { prompt: 'changed' } },
      { kind: 'reorder', shotIds: ['other', 'departure'] },
      { kind: 'character', value: { ...initial.characters[0]!, appearance: 'changed' } },
      { kind: 'asset', value: { ...initial.assets[0]!, sourcePathOrAssetId: 'ma_changed' } },
    ]
    for (const change of forbidden) await expect(store.revise(owner, id, current.planRevision, change)).rejects.toMatchObject({ code: 'CREATIVE_PLAN_RUNNING', status: 409 })
    await store.revise(owner, id, current.planRevision, { kind: 'shot', id: 'other', patch: { title: '无关镜头可编辑' } })
    await store.finish(operation, { status: 'failed', errorCode: 'STOPPED' })
    const next = (await store.projects(owner))[0]!
    await store.revise(owner, id, next.planRevision, { kind: 'shot', id: 'departure', patch: { title: '任务结束后可编辑' } })
    const generated = (await store.projects(owner))[0]!
    await expect(store.revise(owner, id, generated.planRevision, { kind: 'remove-shot', id: 'departure' })).rejects.toMatchObject({ code: 'CREATIVE_PLAN_CONFLICT' })
  })

  it('refuses edits from another account, chat, workspace or login generation', async () => {
    const { store, owner, setLive } = await fixture()
    const id = await store.updatePlan(owner, plan())
    const current = (await store.projects(owner))[0]!
    const change: CreativePlanChange = { kind: 'shot', id: 'departure', patch: { title: '越权修改' } }
    expect(await store.owner(owner, id, owner.sessionId)).toEqual(owner)
    await expect(store.owner(owner, id, 'other-chat')).rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    await expect(store.owner({ ...owner, accountId: '8' }, id, owner.sessionId)).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
    for (const other of [{ ...owner, accountId: '8' }, { ...owner, sessionId: 'other-chat' }, { ...owner, workspaceRoot: join(owner.workspaceRoot, 'other') }]) {
      await expect(store.revise(other, id, current.planRevision, change)).rejects.toBeInstanceOf(CreativeError)
    }
    setLive(undefined)
    await expect(store.owner(owner, id, owner.sessionId)).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
    await expect(store.revise(owner, id, current.planRevision, change)).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
  })

  it('includes generated material images in both real outputs and task outputs, deduplicating shared paths', async () => {
    const { store, owner, file } = await fixture()
    const id = await store.updatePlan(owner, plan())
    const path = await file('portrait.png')
    const asset = await store.begin(owner, { kind: 'image', model: 'image-model', prompt: 'portrait', planId: id, assetId: 'portrait', shots: [{ prompt: 'portrait' }] })
    await store.saved(asset, path, 'image')
    await store.finish(asset, { status: 'completed', paths: [path], kind: 'image' })
    const shot = await store.begin(owner, { kind: 'image', prompt: 'scene', planId: id, shotIds: ['departure'], shots: [{ prompt: 'scene' }] })
    await store.finish(shot, { status: 'completed', paths: [path], kind: 'image' })
    const project = (await store.projects(owner))[0]!
    const referenceUrl = new URL(project.assets[0]!.referenceUrl!, 'https://local.invalid')
    expect(referenceUrl.pathname).toBe('/credits/api/creative/reference')
    expect(Object.fromEntries(referenceUrl.searchParams)).toEqual({ session_id: owner.sessionId, project_id: id, asset_id: 'portrait' })
    expect(project.outputs).toHaveLength(1)
    expect(project.assets[0]?.outputs).toHaveLength(1)
    expect(project.tasks).toMatchObject([
      { id: asset.operationId, assetId: 'portrait', model: 'image-model', status: 'completed', outputs: [{ name: 'portrait.png' }], completedShots: 0, totalShots: 0 },
      { id: shot.operationId, shotIds: ['departure'], status: 'completed', outputs: [{ name: 'portrait.png' }], completedShots: 1, totalShots: 1 },
    ])
  })

  it('keeps edited shot timing distinct from executed duration while projecting real long-video task facts', async () => {
    const { store, owner, file, setVideo } = await fixture()
    const id = await store.updatePlan(owner, plan('video'))
    const clip = await file('scene.mp4')
    const published = await file('published-scene.mp4')
    const video: VideoProjectManifest = {
      version: 1, id: 'vp_00000000-0000-0000-0000-000000000000' as VideoProjectManifest['id'], ownerSessionId: owner.sessionId,
      workspaceRoot: owner.workspaceRoot, identity: owner, input: { prompt: 'story', totalDurationSeconds: 15 }, model: 'MiniMax-H3',
      status: 'running', segments: [{ index: 1, durationSeconds: 15, prompt: 'shot', request: { secret: 'not-public' }, status: 'saved', taskId: 'upstream-private', path: clip, publishedPath: published }],
      outputDirectory: join(owner.workspaceRoot, 'video'), updatedAt: new Date().toISOString(),
    }
    setVideo(video)
    const operation = await store.begin(owner, { kind: 'video', prompt: 'story', planId: id, shotIds: ['departure'], shots: [{ prompt: 'shot' }], videoProjectId: video.id })
    await store.preview(operation, clip, async () => [], `${operation.operationId}_clip_1`)
    store.release(operation)
    const before = (await store.projects(owner))[0]!
    await store.revise(owner, id, before.planRevision, { kind: 'shot', id: 'departure', patch: { durationSeconds: 8 } })
    const project = (await store.projects(owner))[0]!
    expect(project.shots[0]).toMatchObject({ durationSeconds: 8, actualDurationSeconds: 15 })
    expect((await store.plan(owner, id)).shots[0]).not.toHaveProperty('actualDurationSeconds')
    expect(project.tasks).toMatchObject([{ id: operation.operationId, videoProjectId: video.id, model: 'MiniMax-H3', completedShots: 1, totalShots: 1, outputs: [{ name: 'published-scene.mp4' }] }])
    expect(project.outputs).toMatchObject([{ name: 'published-scene.mp4' }])
    expect(JSON.stringify(project)).not.toMatch(/not-public|upstream-private|sessionFingerprint|workspaceRoot/u)
    setVideo({ ...video, publicationErrorCode: 'ARTIFACT_PUBLISH_FAILED' })
    const retained = (await store.projects(owner))[0]!
    expect(retained).toMatchObject({ status: project.status, errorCode: 'ARTIFACT_PUBLISH_FAILED',
      outputs: [{ name: 'published-scene.mp4' }], tasks: [{ errorCode: 'ARTIFACT_PUBLISH_FAILED' }] })
  })
})
