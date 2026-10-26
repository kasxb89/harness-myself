import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreativeError, CreativeStore, creativePlanRevision, parseCreativePlan, parseCreativePlanChange, type CreativeOwner, type CreativePlan } from '../src/creative-store.ts'
import type { VideoProjectManifest, VideoProjectRead } from '../src/video-project.ts'
import type { CreativeImageReceipt, CreativeVideoReceipt, CreativePlanChange } from '../src/creative-types.ts'
import type { VideoGenerationIntent } from '../src/video-generation-intent.ts'
import type { CreationOperationActivity } from '../src/creation-activity.ts'
import { VideoWorkStore } from '../src/video-work-store.ts'
import { ImageInvocationStore } from '../src/image-invocation.ts'
import { ImageResultStore, type ImageResultRef } from '../src/image-result-store.ts'

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

function intent(messageId = 'human-1', callId = 'call-1', maxWorks = 1, rootCallSeq?: number): VideoGenerationIntent {
  return { grant: { schema: 1, messageId, sourceSeq: 1, maxWorks, turn: 1, callId, rootCallId: callId,
    ...rootCallSeq === undefined ? {} : { rootCallSeq } }, calls: [], evidence: [] }
}

describe('creation entry ownership', () => {
  it.each(['image', 'video'] as const)('retains independent %s entry sources across restart without changing legacy records', async (kind) => {
    const { store, owner, options } = await fixture()
    const input = { kind, prompt: 'separate entry', shots: [{ prompt: 'one' }] }
    const legacy = await store.begin(owner, input)
    await store.dispatched(legacy)
    await store.finish(legacy, { status: 'unknown' })
    const legacyPath = join(options.directory, legacy.projectId, 'project.json')
    const original = await readFile(legacyPath, 'utf8')
    const panel = await store.begin(owner, { ...input, source: 'ai-creation' })
    await store.dispatched(panel)
    await store.finish(panel, { status: 'unknown' })
    const restarted = new CreativeStore(options)
    const chat = await restarted.begin(owner, { ...input, source: 'chat',
      ...kind === 'video' ? { videoIntent: intent() } : {} })
    restarted.release(chat)
    const projects = await new CreativeStore(options).projects(owner)
    expect(projects.find(project => project.id === panel.projectId)?.tasks[0]).toMatchObject({ source: 'ai-creation', status: 'unknown' })
    expect(projects.find(project => project.id === chat.projectId)?.tasks[0]).toMatchObject({ source: 'chat' })
    expect(projects.find(project => project.id === legacy.projectId)?.tasks[0]).not.toHaveProperty('source')
    expect(await readFile(legacyPath, 'utf8')).toBe(original)
  })

  it('keeps an AI Creation original shot locked without spending a new chat request allowance', async () => {
    const { store, owner, options } = await fixture()
    const original = await store.begin(owner, { kind: 'video', source: 'ai-creation', prompt: 'manual', shots: [{ prompt: 'one' }] })
    await store.dispatched(original)
    await store.finish(original, { status: 'unknown' })
    const restarted = new CreativeStore(options)
    await expect(restarted.preflightVideoWorkCount(owner, undefined, { planId: original.projectId, shotIds: ['shot_1'] }))
      .rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    await expect(restarted.preflightVideoWorkCount(owner, intent(), { planId: original.projectId, shotIds: ['shot_1'] }))
      .resolves.toMatchObject(intent())
    await expect(restarted.begin(owner, { kind: 'video', source: 'chat', prompt: 'independent',
      shots: [{ prompt: 'new' }], videoIntent: intent() })).resolves.toMatchObject({ owner })
    await expect(restarted.begin(owner, { kind: 'video', source: 'chat', prompt: 'unrequested extra',
      shots: [{ prompt: 'new' }], videoIntent: intent('human-1', 'call-2') }))
      .resolves.toBeDefined()
  })

  it.each(['unrecognized', 'conflicting-chat-grant', 'conflicting-chat-project', 'conflicting-chat-work'] as const)('refuses damaged durable entry attribution: %s', async (damage) => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'video', source: 'ai-creation', prompt: 'one', shots: [{ prompt: 'one' }] })
    store.release(operation)
    const path = join(options.directory, operation.projectId, 'project.json')
    const record = JSON.parse(await readFile(path, 'utf8')) as { operations: Record<string, unknown>[] }
    const saved = record.operations[0]!
    if (damage === 'unrecognized') saved.source = 'guessed'
    else if (damage === 'conflicting-chat-grant') saved.requestGrant = intent().grant
    else if (damage === 'conflicting-chat-project') saved.videoProjectId = 'vp_conflicting_chat'
    else saved.workId = `vw_${'a'.repeat(64)}_1`
    await writeFile(path, JSON.stringify(record))
    await expect(new CreativeStore(options).projects(owner)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
  })
})

describe('legacy video submission identity and work associations', () => {
  it('adopts original-source old operations into stable works without changing the original creation records', async () => {
    const { store, owner, options } = await fixture()
    const original = await store.begin(owner, { kind: 'video', source: 'chat', prompt: 'old original',
      shots: [{ prompt: 'one' }], videoIntent: intent('human-a', 'old-call') })
    await store.dispatched(original)
    await store.finish(original, { status: 'unknown' })
    const another = await store.begin(owner, { kind: 'video', source: 'chat', prompt: 'independent message',
      shots: [{ prompt: 'same' }], videoIntent: intent('human-b', 'another-call') })
    store.release(another)
    const path = join(options.directory, original.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    const current = intent('human-a', 'retry-with-different-call')
    const links = await new CreativeStore(options).videoWorkLinks(owner, current)
    expect(links).toEqual([{ projectId: original.projectId, operationId: original.operationId }])
    const works = new VideoWorkStore({ directory: join(owner.workspaceRoot, 'work-registry'), current: options.current })
    const source = { messageId: current.grant.messageId, sourceSeq: current.grant.sourceSeq, turn: current.grant.turn }
    const adopted = await works.prepare(owner, source, 10, links)
    expect(adopted.works).toHaveLength(1)
    expect(await works.claim(owner, source)).toMatchObject({ kind: 'existing', work: { state: 'linked', link: links[0] } })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await store.videoWorkLinks(owner, { ...current, grant: { ...current.grant, sourceSeq: 999 } })).toEqual([])
  })

  it('uses real logged operation evidence to adopt a legacy operation without a saved request grant', async () => {
    const { store, owner, options } = await fixture()
    const original = await store.begin(owner, { kind: 'video', prompt: 'legacy', shots: [{ prompt: 'one' }] })
    store.release(original)
    const current = intent('human-a', 'new-call')
    const evidence = [{ messageId: 'human-a', callId: 'old-call', operationId: original.operationId }]
    expect(await new CreativeStore(options).videoWorkLinks(owner, { ...current, evidence }))
      .toEqual([{ projectId: original.projectId, operationId: original.operationId }])
    expect(await store.videoWorkLinks(owner, { ...intent('human-b', 'other-new-call'), evidence })).toEqual([])
  })

  it('does not treat a logged video without a readable original operation as an empty work list', async () => {
    const { store, owner } = await fixture()
    const current = intent('human-a', 'new-call')
    await expect(store.videoWorkLinks(owner, { ...current, evidence: [{ messageId: 'human-a', callId: 'old-call',
      videoProjectId: 'vp_00000000-0000-0000-0000-000000000001' }] }))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' })
  })

  it('persists the host-issued finished-work id while keeping pre-existing private records unchanged', async () => {
    const { store, owner, options } = await fixture()
    const works = new VideoWorkStore({ directory: join(owner.workspaceRoot, 'work-registry'), current: options.current })
    const current = intent()
    const batch = await works.prepare(owner, current.grant)
    const workId = batch.works[0]!.workId
    const operation = await store.begin(owner, { kind: 'video', source: 'chat', prompt: 'one requested video',
      shots: [{ prompt: 'one' }], videoIntent: current, videoWorkId: workId })
    store.release(operation)
    const path = join(options.directory, operation.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    expect(JSON.parse(before)).toMatchObject({ operations: [{ workId }] })
    expect(await new CreativeStore(options).videoWorkLinks(owner, intent('human-1', 'later-call')))
      .toEqual([{ projectId: operation.projectId, operationId: operation.operationId }])
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('rejects the same finished-work id across new real messages even after its registry claim file is lost', async () => {
    const { store, owner, options } = await fixture()
    const workDirectory = join(owner.workspaceRoot, 'work-registry')
    const works = new VideoWorkStore({ directory: workDirectory, current: options.current })
    const firstIntent = intent('human-a', 'call-a')
    const claimed = await works.claim(owner, firstIntent.grant)
    if (claimed.kind !== 'claimed') throw new Error('expected original claim')
    const workId = claimed.work.workId
    const original = await store.begin(owner, { kind: 'video', source: 'chat', prompt: 'original',
      shots: [{ prompt: 'one' }], videoIntent: firstIntent, videoWorkId: workId })
    await works.attach(claimed.claim, { projectId: original.projectId, operationId: original.operationId })
    await store.dispatched(original)
    await store.finish(original, { status: 'unknown' })
    const path = join(options.directory, original.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    await unlink(join(workDirectory, `${workId}.json`))
    const newIntent = intent('human-b', 'new-call')
    const newClaim = await works.claim(owner, newIntent.grant, workId)
    expect(newClaim.kind).toBe('claimed')
    const restarted = new CreativeStore(options)
    await expect(restarted.preflightVideoWorkCount(owner, newIntent, { videoWorkId: workId }))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
    await expect(restarted.begin(owner, { kind: 'video', source: 'chat', prompt: 'changed prompt, same work',
      shots: [{ prompt: 'different' }], videoIntent: newIntent, videoWorkId: workId }))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await restarted.projects(owner)).flatMap(project => project.tasks)).toHaveLength(1)
  })

  it('rechecks finished-work identity at begin after independent message preflights both passed', async () => {
    const { store, owner, options } = await fixture()
    const works = new VideoWorkStore({ directory: join(owner.workspaceRoot, 'work-registry'), current: options.current })
    const batch = await works.prepare(owner, intent().grant)
    const workId = batch.works[0]!.workId
    const first = intent('human-a', 'call-a')
    const second = intent('human-b', 'call-b')
    await Promise.all([first, second].map(source => store.preflightVideoWorkCount(owner, source, { videoWorkId: workId })))
    const results = await Promise.allSettled([first, second].map(videoIntent => store.begin(owner, {
      kind: 'video', source: 'chat', prompt: 'same actual work', shots: [{ prompt: 'one' }], videoIntent, videoWorkId: workId,
    })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')?.reason)
      .toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
  })

  it('retains an old pre-result submission for its original human without blocking a later human', async () => {
    const { store, owner, options } = await fixture()
    const original = await store.begin(owner, { kind: 'video', prompt: 'legacy original', shots: [{ prompt: 'one' }] })
    const receipt: CreativeVideoReceipt = { route: '/v1/videos', model: 'MiniMax-H3', phase: 'submitting',
      requestId: 'old-original', backendFingerprint: 'b'.repeat(64), origin: {
        sessionId: owner.sessionId as import('@deepseek-ai/dsh-session/types').SessionId, turn: 2,
        eventSeq: 10 as import('@deepseek-ai/dsh-session/types').SessionSeq,
        toolCallId: 'call-0' as import('@deepseek-ai/dsh-llm/brand').ToolCallId,
      } }
    await store.videoReceipt(original, receipt)
    await store.finish(original, { status: 'unknown' })
    store.release(original)
    const path = join(options.directory, original.projectId, 'project.json')
    const bytes = await readFile(path, 'utf8')
    const calls = [{ callId: 'call-0', messageId: 'human-a', name: 'generate_video', rootCallSeq: 12, turn: 2, native: true as const },
      { callId: 'call-0', messageId: 'human-b', name: 'generate_video', rootCallSeq: 20, turn: 3, native: true as const }]
    const restarted = new CreativeStore(options)
    await expect(restarted.preflightVideoWorkCount(owner, { ...intent('human-a', 'call-0', 3, 12), calls }))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
    await expect(restarted.begin(owner, { kind: 'video', prompt: 'unrequested duplicate', shots: [{ prompt: 'one' }],
      videoIntent: { ...intent('human-a', 'another-call', 1, 15), calls } }))
      .resolves.toBeDefined()
    await expect(restarted.begin(owner, { kind: 'video', prompt: 'independent b', shots: [{ prompt: 'one' }],
      videoIntent: { ...intent('human-b', 'call-0', 1, 20), calls } })).resolves.toMatchObject({ owner })
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  it.each(['ambiguous-humans', 'ptc-child'] as const)('does not assign an old receipt to another human from %s', async (scenario) => {
    const { store, owner, options } = await fixture()
    const original = await store.begin(owner, { kind: 'video', prompt: 'legacy original', shots: [{ prompt: 'one' }] })
    await store.videoReceipt(original, { route: '/v1/videos', model: 'MiniMax-H3', phase: 'submitting',
      backendFingerprint: 'b'.repeat(64), origin: {
        sessionId: owner.sessionId as import('@deepseek-ai/dsh-session/types').SessionId, turn: 1,
        eventSeq: 0 as import('@deepseek-ai/dsh-session/types').SessionSeq,
        toolCallId: 'call-0' as import('@deepseek-ai/dsh-llm/brand').ToolCallId,
      } })
    await store.finish(original, { status: 'unknown' })
    store.release(original)
    const calls = scenario === 'ambiguous-humans'
      ? [{ callId: 'call-0', messageId: 'human-a', name: 'generate_video', rootCallSeq: 3, turn: 1, native: true as const },
        { callId: 'call-0', messageId: 'human-b', name: 'generate_video', rootCallSeq: 5, turn: 1, native: true as const }]
      : [{ callId: 'call-0', messageId: 'human-b', name: 'generate_video', rootCallSeq: 3, turn: 1 }]
    await expect(new CreativeStore(options).begin(owner, { kind: 'video', prompt: 'independent b', shots: [{ prompt: 'one' }],
      videoIntent: { ...intent('human-b', 'new-call', 1, 10), calls } })).resolves.toMatchObject({ owner })
  })

  it('protects an old PTC submission when repeated root ids belong to one original human', async () => {
    const { store, owner, options } = await fixture()
    const original = await store.begin(owner, { kind: 'video', prompt: 'legacy original', shots: [{ prompt: 'one' }] })
    await store.videoReceipt(original, { route: '/v1/videos', model: 'MiniMax-H3', phase: 'submitting',
      backendFingerprint: 'b'.repeat(64), origin: {
        sessionId: owner.sessionId as import('@deepseek-ai/dsh-session/types').SessionId, turn: 1,
        toolCallId: 'ptc-root' as import('@deepseek-ai/dsh-llm/brand').ToolCallId,
      } })
    await store.finish(original, { status: 'unknown' })
    store.release(original)
    const calls = [3, 5].map(rootCallSeq => ({ callId: 'ptc-root', messageId: 'human-a', name: 'run_ptc',
      rootCallSeq, turn: 1, native: true as const }))
    const current = intent('human-a', 'ptc-child', 3, 5)
    await expect(new CreativeStore(options).begin(owner, { kind: 'video', prompt: 'same uncertain submission', shots: [{ prompt: 'one' }],
      videoIntent: { ...current, grant: { ...current.grant, rootCallId: 'ptc-root' }, calls } }))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
  })

  it('admits different human requests when the provider reuses the same raw call id', async () => {
    const { store, owner } = await fixture()
    const input = { kind: 'video' as const, prompt: 'one requested video', shots: [{ prompt: 'one clip' }] }
    const first = await store.begin(owner, { ...input, videoIntent: intent('human-a', 'call-0') })
    await store.dispatched(first)
    await store.finish(first, { status: 'unknown' })
    const current = { ...intent('human-b', 'call-0'),
      evidence: [{ messageId: 'human-a', callId: 'call-0', operationId: first.operationId }] }
    await expect(store.begin(owner, { ...input, videoIntent: current }))
      .resolves.toMatchObject({ owner })
  })

  it('counts distinct root call events with reused provider call ids as distinct requested works', async () => {
    const { store, owner, options } = await fixture()
    const input = { kind: 'video' as const, prompt: 'one of three requested videos', shots: [{ prompt: 'one clip' }] }
    for (const seq of [10, 20, 30]) {
      const operation = await store.begin(owner, { ...input, videoIntent: intent('human-three', 'call-0', 3, seq) })
      expect(operation).not.toHaveProperty('remainingVideoWorks')
      store.release(operation)
    }
    const restarted = new CreativeStore(options)
    await expect(restarted.preflightVideoWorkCount(owner, intent('human-three', 'call-0', 3, 30)))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
    await expect(restarted.begin(owner, { ...input, videoIntent: intent('human-three', 'call-0', 3, 40) }))
      .resolves.toBeDefined()
  })

  it('uses the original operation evidence to disambiguate a legacy grant without rewriting it', async () => {
    const { store, owner, options } = await fixture()
    const input = { kind: 'video' as const, prompt: 'one of three requested videos', shots: [{ prompt: 'one clip' }] }
    const first = await store.begin(owner, { ...input, videoIntent: intent('human-three', 'call-0', 3) })
    store.release(first)
    const path = join(options.directory, first.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    const current = intent('human-three', 'call-0', 3, 20)
    const evidence = [{ messageId: 'human-three', callId: 'call-0', rootCallSeq: 10, operationId: first.operationId }]
    await expect(store.preflightVideoWorkCount(owner, current)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
    await expect(store.begin(owner, { ...input, videoIntent: { ...current, evidence } })).resolves.toMatchObject({ owner })
    const replay = { ...intent('human-three', 'call-0', 3, 10), evidence }
    await expect(new CreativeStore(options).preflightVideoWorkCount(owner, replay))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('uses a saved exact grant to disambiguate its old logged result without a root call sequence', async () => {
    const { store, owner } = await fixture()
    const input = { kind: 'video' as const, prompt: 'one of three requested videos', shots: [{ prompt: 'one clip' }] }
    const first = await store.begin(owner, { ...input, videoIntent: intent('human-three', 'call-0', 3, 10) })
    store.release(first)
    const evidence = [{ messageId: 'human-three', callId: 'call-0', operationId: first.operationId }]
    await expect(store.begin(owner, { ...input, videoIntent: { ...intent('human-three', 'call-0', 3, 20), evidence } }))
      .resolves.toMatchObject({ owner })
    await expect(store.preflightVideoWorkCount(owner, { ...intent('human-three', 'call-0', 3, 10), evidence }))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
  })

  it('retains independent old operations sharing a raw call id without inferring a numeric ceiling', async () => {
    const { store, owner, options } = await fixture()
    const input = { kind: 'video' as const, prompt: 'one of three requested videos', shots: [{ prompt: 'one clip' }] }
    const originals = []
    for (const [index, seq] of [10, 20].entries()) {
      const operation = await store.begin(owner, { ...input, videoIntent: intent('human-three', `old-${String(index)}`, 3) })
      store.release(operation)
      const path = join(options.directory, operation.projectId, 'project.json')
      const record = JSON.parse(await readFile(path, 'utf8')) as { operations: { requestGrant: { callId: string } }[] }
      record.operations[0]!.requestGrant.callId = 'call-0'
      await writeFile(path, JSON.stringify(record))
      originals.push({ operation, path, bytes: await readFile(path, 'utf8'), seq })
    }
    const evidence = originals.map(({ operation, seq }) => ({ messageId: 'human-three', callId: 'call-0',
      rootCallSeq: seq, operationId: operation.operationId }))
    const restarted = new CreativeStore(options)
    await expect(restarted.begin(owner, { ...input, videoIntent: { ...intent('human-three', 'call-0', 3, 30), evidence } }))
      .resolves.toMatchObject({ owner })
    await expect(restarted.preflightVideoWorkCount(owner, { ...intent('human-three', 'call-0', 3, 40), evidence }))
      .resolves.toBeDefined()
    for (const original of originals) expect(await readFile(original.path, 'utf8')).toBe(original.bytes)
  })

  it('checks distinct logged submissions with reused provider call ids without imposing a quantity ceiling', async () => {
    const { store, owner } = await fixture()
    const evidence = [10, 20].map(rootCallSeq => ({ messageId: 'human-three', callId: 'call-0', rootCallSeq,
      videoProjectId: `vp_${String(rootCallSeq)}` }))
    const input = { kind: 'video' as const, prompt: 'third requested video', shots: [{ prompt: 'one clip' }] }
    await expect(store.begin(owner, { ...input, videoIntent: { ...intent('human-three', 'call-0', 3, 30), evidence } }))
      .resolves.toMatchObject({ owner })
    await expect(store.preflightVideoWorkCount(owner, { ...intent('human-three', 'call-0', 3, 40), evidence }))
      .resolves.toBeDefined()
  })

  it.each(['running', 'unknown'] as const)('admits a later human request using the same plan while the earlier request is %s', async (status) => {
    const { store, owner, options } = await fixture()
    const planId = await store.updatePlan(owner, plan('video'))
    const input = { kind: 'video' as const, source: 'chat' as const, prompt: 'one independent video', planId,
      shotIds: ['departure'], shots: [{ prompt: 'one clip' }] }
    const first = await store.begin(owner, { ...input, videoIntent: intent('human-a', 'call-a') })
    await store.dispatched(first)
    if (status === 'unknown') await store.finish(first, { status: 'unknown' })
    const reader = status === 'unknown' ? new CreativeStore(options) : store
    await expect(reader.preflightVideoWorkCount(owner, intent('human-b', 'call-b'), input)).resolves.toMatchObject(intent('human-b', 'call-b'))
    const second = await reader.begin(owner, { ...input, videoIntent: intent('human-b', 'call-b') })
    expect(second.operationId).not.toBe(first.operationId)
    expect(second).toMatchObject({ projectId: planId })
    const project = (await reader.projects(owner)).find(item => item.id === planId)
    expect(project?.tasks).toHaveLength(2)
    expect(project?.tasks.find(item => item.id === first.operationId)?.status).toBe(status)
    await expect(reader.begin(owner, { ...input, videoIntent: intent('human-b', 'call-b-extra') }))
      .resolves.toBeDefined()
  })

  it('admits three distinct PTC calls sharing a root and plan while preserving the exact submission identity', async () => {
    const { store, owner, options } = await fixture()
    const planId = await store.updatePlan(owner, plan('video'))
    const input = { kind: 'video' as const, source: 'chat' as const, prompt: 'three requested works', planId,
      shotIds: ['departure'], shots: [{ prompt: 'one clip' }] }
    const batchIntent = (callId: string): VideoGenerationIntent => {
      const original = intent('human-three', callId, 3, 50)
      return { ...original, grant: { ...original.grant, rootCallId: 'ptc-root' } }
    }
    const first = await store.begin(owner, { ...input, videoIntent: batchIntent('ptc-child-1') })
    expect(first).not.toHaveProperty('remainingVideoWorks')
    await store.dispatched(first)
    await store.finish(first, { status: 'unknown' })
    const restarted = new CreativeStore(options)
    await expect(restarted.preflightVideoWorkCount(owner, batchIntent('ptc-child-1'), input))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
    await expect(restarted.begin(owner, { ...input, videoIntent: batchIntent('ptc-child-1') }))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
    const next = await Promise.allSettled(['ptc-child-2', 'ptc-child-3', 'ptc-child-4'].map(callId =>
      restarted.begin(owner, { ...input, videoIntent: batchIntent(callId) })))
    const admitted = next.filter(item => item.status === 'fulfilled').map(item => item.value)
    expect(admitted).toHaveLength(3)
    expect(next.filter(item => item.status === 'rejected')).toHaveLength(0)
    expect((await restarted.projects(owner)).find(item => item.id === planId)?.tasks).toHaveLength(4)
  })

  it.each(['persisted', 'logged'] as const)('refuses replay of the same call without a plan even when the batch has capacity: %s', async (source) => {
    const { store, owner, options } = await fixture()
    const current = intent('human-batch', 'one-submission', 3)
    if (source === 'persisted') {
      const operation = await store.begin(owner, { kind: 'video', prompt: 'one', shots: [{ prompt: 'one' }], videoIntent: current })
      store.release(operation)
    }
    const replay = source === 'logged' ? { ...current, evidence: [{ messageId: current.grant.messageId, callId: current.grant.callId,
      videoProjectId: 'vp_00000000-0000-0000-0000-000000000001' }] } : current
    const restarted = new CreativeStore(options)
    await expect(restarted.preflightVideoWorkCount(owner, replay)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
    await expect(restarted.begin(owner, { kind: 'video', prompt: 'same submission', shots: [{ prompt: 'one' }], videoIntent: replay }))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
  })

  it('atomically admits a single submission after concurrent preflights pass for the same call', async () => {
    const { store, owner, options } = await fixture()
    const current = intent('human-batch', 'same-call', 3)
    await Promise.all([store.preflightVideoWorkCount(owner, current), store.preflightVideoWorkCount(owner, current)])
    const results = await Promise.allSettled([1, 2].map(() => store.begin(owner, {
      kind: 'video', source: 'chat', prompt: 'same submission', shots: [{ prompt: 'one' }], videoIntent: current,
    })))
    const accepted = results.filter(item => item.status === 'fulfilled')
    expect(accepted).toHaveLength(1)
    expect(results.find(item => item.status === 'rejected')?.reason).toMatchObject({ code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
    const operation = accepted[0]!.value
    expect(operation).not.toHaveProperty('remainingVideoWorks')
    const persisted = await readFile(join(options.directory, operation.projectId, 'project.json'), 'utf8')
    expect(persisted).not.toContain('remainingVideoWorks')
    expect((await new CreativeStore(options).projects(owner)).flatMap(project => project.tasks)).toHaveLength(1)
  })

  it('checks the complete saved plan against human duration while allowing shorter component shots', async () => {
    const { store, owner } = await fixture()
    const source = plan('video')
    const first = source.shots[0]!
    const planId = await store.updatePlan(owner, { ...source, shots: [
      { ...first, durationSeconds: 15 }, { ...first, id: 'arrival', order: 2, durationSeconds: 15 },
    ] })
    await expect(store.preflightVideoWorkCount(owner, { ...intent(), requestedDurationSeconds: 10 },
      { planId, shotIds: ['departure'] })).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' })
    await expect(store.preflightVideoWorkCount(owner, { ...intent(), requestedDurationSeconds: 30 },
      { planId, shotIds: ['departure'] })).resolves.toMatchObject({ requestedDurationSeconds: 30 })
  })

  it.each([false, true])('preserves unknown work while leaving finished-work reservation to its owner (missing intent: %s)', async (missing) => {
    const { store, owner } = await fixture()
    const planId = await store.updatePlan(owner, plan('video'))
    const original = await store.begin(owner, { kind: 'video', prompt: 'one video', planId, shotIds: ['departure'],
      shots: [{ prompt: 'one clip' }], videoIntent: intent() })
    await store.dispatched(original)
    await store.finish(original, { status: 'unknown', errorCode: 'TRANSPORT' })
    const check = store.preflightVideoWorkCount(owner, missing ? undefined : intent('human-1', 'call-2'),
      { planId, shotIds: ['departure'] })
    if (missing) await expect(check).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    else await expect(check).resolves.toBeDefined()
    expect((await store.projects(owner)).find(project => project.id === planId)?.tasks[0]).toMatchObject({ status: 'unknown' })
  })

  it('does not block an unrelated plan using an original message count', async () => {
    const { store, owner } = await fixture()
    const original = await store.begin(owner, { kind: 'video', prompt: 'one video', shots: [{ prompt: 'one clip' }], videoIntent: intent() })
    await store.dispatched(original)
    await store.finish(original, { status: 'unknown', errorCode: 'TRANSPORT' })
    const separatePlanId = await store.updatePlan(owner, plan('video'))
    await expect(store.preflightVideoWorkCount(owner, intent('human-1', 'call-2'),
      { planId: separatePlanId, shotIds: ['departure'] })).resolves.toBeDefined()
  })

  it('does not infer finished-work identity from plan size or a numeric grant after restart', async () => {
    const { store, owner, options } = await fixture()
    const input = { kind: 'video' as const, prompt: '120秒视频', shots: Array.from({ length: 8 }, () => ({ prompt: 'one 15-second clip', durationSeconds: 15 })) }
    const first = await store.begin(owner, { ...input, videoIntent: intent() })
    store.release(first)
    const restarted = new CreativeStore(options)
    await expect(restarted.begin(owner, { kind: 'video', prompt: 'quality v2', shots: [{ prompt: 'v2' }], videoIntent: intent('human-1', 'call-2') }))
      .resolves.toBeDefined()
    await expect(restarted.begin(owner, { kind: 'video', prompt: 'explicit new human request', shots: [{ prompt: 'new' }], videoIntent: intent('human-2', 'call-3') }))
      .resolves.toMatchObject({ owner })
  })

  it('does not impose a legacy numeric grant ceiling on distinct prepared submissions', async () => {
    const { store, owner } = await fixture()
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => store.begin(owner, {
      kind: 'video', prompt: `version ${String(index)}`, shots: [{ prompt: 'one clip' }],
      videoIntent: intent('human-batch', `call-${String(index)}`, 3),
    })))
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(4)
    expect(results.filter(item => item.status === 'rejected')).toHaveLength(0)
  })

  it('does not count logged legacy evidence or persisted grants as a quantity ceiling', async () => {
    const { store, owner } = await fixture()
    const first = await store.begin(owner, { kind: 'video', prompt: 'one', shots: [{ prompt: 'one' }], videoIntent: intent('human-batch', 'call-1', 2) })
    store.release(first)
    const next = intent('human-batch', 'call-2', 2)
    await expect(store.begin(owner, { kind: 'video', prompt: 'two', shots: [{ prompt: 'two' }],
      videoIntent: { ...next, evidence: [{ messageId: 'human-batch', callId: 'call-1', operationId: first.operationId }] } }))
      .resolves.toMatchObject({ owner })
    const third = intent('human-batch', 'call-3', 2)
    await expect(store.preflightVideoWorkCount(owner, third)).resolves.toBeDefined()
  })

  it('attributes old operations only by real logged results without assigning legacy work to a new human', async () => {
    const { store, owner } = await fixture()
    const old = await store.begin(owner, { kind: 'video', prompt: 'old', shots: [{ prompt: 'old' }] })
    store.release(old)
    const current = intent('human-1', 'call-2')
    const evidence = [{ messageId: 'human-1', callId: 'call-1', operationId: old.operationId }]
    await expect(store.begin(owner, { kind: 'video', prompt: 'v2', shots: [{ prompt: 'v2' }], videoIntent: { ...current, evidence } }))
      .resolves.toBeDefined()
    await expect(store.begin(owner, { kind: 'video', prompt: 'new request', shots: [{ prompt: 'new' }],
      videoIntent: { ...intent('human-2', 'call-3'), evidence } })).resolves.toMatchObject({ owner })
  })

  it.each(['completed', 'failed', 'unknown'] as const)('isolates unattributed legacy %s work across consecutive human requests and restart', async (status) => {
    const { store, owner, options } = await fixture()
    const old = await store.begin(owner, { kind: 'video', prompt: 'old', shots: [{ prompt: 'old' }] })
    if (status === 'unknown') await store.dispatched(old)
    const savedPath = join(owner.workspaceRoot, 'legacy-video.mp4')
    if (status === 'completed') await writeFile(savedPath, 'local synthetic video bytes')
    await store.finish(old, { status, ...status === 'completed' ? { paths: [savedPath] } : {} })
    const path = join(options.directory, old.projectId, 'project.json')
    const original = await readFile(path, 'utf8')
    const restarted = new CreativeStore(options)
    const first = await restarted.begin(owner, { kind: 'video', prompt: 'first independent request', shots: [{ prompt: 'one' }],
      videoIntent: intent('human-new-1', 'call-new-1') })
    restarted.release(first)
    await expect(restarted.begin(owner, { kind: 'video', prompt: 'unrequested second version', shots: [{ prompt: 'one' }],
      videoIntent: intent('human-new-1', 'call-new-2') })).resolves.toBeDefined()
    await expect(new CreativeStore(options).begin(owner, { kind: 'video', prompt: 'second independent request', shots: [{ prompt: 'two' }],
      videoIntent: intent('human-new-2', 'call-new-3') })).resolves.toMatchObject({ owner })
    expect(await readFile(path, 'utf8')).toBe(original)
    if (status === 'unknown') {
      await expect(new CreativeStore(options).preflightVideoWorkCount(owner, intent('human-new-3', 'call-new-4'),
        { planId: old.projectId, shotIds: ['shot_1'] })).resolves.toMatchObject(intent('human-new-3', 'call-new-4'))
      await expect(new CreativeStore(options).preflightVideoWorkCount(owner, undefined,
        { planId: old.projectId, shotIds: ['shot_1'] })).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
      expect(await readFile(path, 'utf8')).toBe(original)
    }
  })

  it.each(['account', 'chat', 'workspace'] as const)('ignores malformed records with a different declared %s before parsing their operations', async (scope) => {
    const { store, owner, options } = await fixture()
    const foreignOwner = { ...owner, ...scope === 'account' ? { accountId: 'another-account' }
      : scope === 'chat' ? { sessionId: 'another-chat' } : { workspaceRoot: join(owner.workspaceRoot, 'another-workspace') } }
    const foreignId = await store.updatePlan(owner, plan('video'))
    const path = join(options.directory, foreignId, 'project.json')
    const record = JSON.parse(await readFile(path, 'utf8')) as { owner: CreativeOwner; operations: unknown }
    record.owner = foreignOwner
    record.operations = 'malformed legacy operations'
    await writeFile(path, JSON.stringify(record))
    const original = await readFile(path, 'utf8')
    await expect(new CreativeStore(options).begin(owner, { kind: 'video', prompt: 'independent request', shots: [{ prompt: 'one' }],
      videoIntent: intent() })).resolves.toMatchObject({ owner })
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('still stops new video work when an owned record cannot be validated', async () => {
    const { store, owner, options } = await fixture()
    const id = await store.updatePlan(owner, plan('video'))
    const path = join(options.directory, id, 'project.json')
    const record = JSON.parse(await readFile(path, 'utf8')) as { operations: unknown }
    record.operations = 'malformed operations'
    await writeFile(path, JSON.stringify(record))
    await expect(new CreativeStore(options).preflightVideoWorkCount(owner, intent()))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' })
  })

  it.each(['missing-file', 'broken-json', 'missing-owner', 'invalid-owner'] as const)('retains an explicit refusal for an unreadable or unattributable record: %s', async (damage) => {
    const { store, owner, options } = await fixture()
    const id = await store.updatePlan(owner, plan('video'))
    const path = join(options.directory, id, 'project.json')
    if (damage === 'missing-file') await unlink(path)
    else if (damage === 'broken-json') await writeFile(path, '{')
    else {
      const record = JSON.parse(await readFile(path, 'utf8')) as { owner?: unknown }
      if (damage === 'missing-owner') delete record.owner
      else record.owner = { accountId: owner.accountId, sessionId: 42, workspaceRoot: owner.workspaceRoot }
      await writeFile(path, JSON.stringify(record))
    }
    await expect(new CreativeStore(options).preflightVideoWorkCount(owner, intent()))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' })
  })

  it('does not turn an unclaimed prepared orphan into a new paid work through resume', async () => {
    const { store, owner } = await fixture()
    const manifest: VideoProjectManifest = {
      version: 1, id: 'vp_00000000-0000-0000-0000-000000000000' as VideoProjectManifest['id'], ownerSessionId: owner.sessionId,
      workspaceRoot: owner.workspaceRoot, identity: owner, input: { prompt: 'orphan', totalDurationSeconds: 15 }, model: 'MiniMax-H3',
      status: 'prepared', segments: [{ index: 1, durationSeconds: 15, prompt: 'one shot', request: {}, status: 'pending' }],
      outputDirectory: join(owner.workspaceRoot, 'video'), updatedAt: new Date().toISOString(),
    }
    await expect(store.resumeVideo(owner, manifest)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' })
    const granted = await store.begin(owner, { kind: 'video', prompt: 'authorized', shots: [{ prompt: 'one shot' }],
      videoProjectId: manifest.id, videoIntent: intent() })
    store.release(granted)
    await expect(store.resumeVideo(owner, manifest)).resolves.toMatchObject({
      projectId: granted.projectId, operationId: granted.operationId, owner,
    })
  })
})

const acceptedImage: CreativeImageReceipt = {
  route: '/toapis/v1/images/generations', model: 'yunshu-internal-gpt-image-2', phase: 'accepted',
  taskId: 'task-original', requestId: 'req-original', backendFingerprint: 'a'.repeat(64),
}
const submittingImage: CreativeImageReceipt = {
  route: acceptedImage.route, model: acceptedImage.model, phase: 'submitting',
  requestId: 'req-original', backendFingerprint: acceptedImage.backendFingerprint,
}

async function fixture(activity?: (event: CreationOperationActivity) => void) {
  root = await realpath(await mkdtemp(join(tmpdir(), 'yunshu-creative-store-')))
  const owner: CreativeOwner = { accountId: '7', sessionFingerprint: 'login-7', sessionId: 'chat-a', workspaceRoot: join(root, 'workspace') }
  await mkdir(owner.workspaceRoot)
  let live: Pick<CreativeOwner, 'accountId' | 'sessionFingerprint'> | undefined = owner
  let video: VideoProjectRead | undefined
  const options = {
    directory: join(root, 'projects'), current: async () => live,
    ...activity === undefined ? {} : { activity },
    video: async () => { if (video === undefined) throw new Error('No fixture video'); return video },
  }
  const store = new CreativeStore(options)
  const file = async (name: string, bytes = 'actual saved bytes') => { const path = join(owner.workspaceRoot, name); await writeFile(path, bytes); return path }
  return {
    store, options, owner, file,
    setLive: (value: typeof live) => { live = value }, setVideo: (value: VideoProjectRead) => { video = value },
  }
}

describe('process-live creation operations', () => {
  it('observes only committed begin, explicit resume and final release rather than retained running records', async () => {
    const events: CreationOperationActivity[] = []
    const { store, owner, options, file } = await fixture(event => events.push(event))
    const operation = await store.begin(owner, { kind: 'image', prompt: 'private prompt', shots: [{ prompt: 'private shot' }] })
    expect(events).toEqual([{ active: true, kind: 'image', operation }])
    await store.receipt(operation, acceptedImage)
    await store.finish(operation, { status: 'unknown' })
    store.release(operation)
    expect(events.map(event => event.active)).toEqual([true, false])
    const restarted = new CreativeStore(options)
    await restarted.projects(owner)
    expect(events).toHaveLength(2)
    const resumed = await restarted.resumeImage(owner, operation.projectId, operation.operationId)
    expect(events.at(-1)).toEqual({ active: true, kind: 'image', operation: resumed.operation })
    await restarted.finish(resumed.operation, { kind: 'image', status: 'completed', paths: [await file('saved.png')] })
    restarted.release(resumed.operation)
    expect(events.map(event => event.active)).toEqual([true, false, true, false])
    expect(events.every(event => event.operation.operationId === operation.operationId)).toBe(true)
  })

  it('keeps one project operation for eight shots and contains observer failures during begin and release', async () => {
    const events: CreationOperationActivity[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store, owner } = await fixture((event) => { events.push(event); throw new Error('private observer failure') })
      const operation = await store.begin(owner, { kind: 'video', prompt: 'eight clips',
        shots: Array.from({ length: 8 }, () => ({ prompt: 'clip', durationSeconds: 15 })),
        videoProjectId: 'vp_00000000-0000-0000-0000-000000000000' })
      store.release(operation)
      store.release(operation)
      expect(events).toEqual([
        { active: true, kind: 'video', operation, videoProjectId: 'vp_00000000-0000-0000-0000-000000000000' },
        { active: false, kind: 'video', operation, videoProjectId: 'vp_00000000-0000-0000-0000-000000000000' },
      ])
      expect(warn).toHaveBeenCalledTimes(2)
    } finally { warn.mockRestore() }
  })
})

describe('verified image output purpose', () => {
  it.each(['image', 'video'] as const)('derives %s names from the original retained invocation without new persisted fields', async (kind) => {
    const { store, owner, options } = await fixture()
    const id = await store.updatePlan(owner, plan(kind))
    const prompt = '原始生成提示词，不应被恢复查询替换'
    const operation = await store.begin(owner, { kind, planId: id, shotIds: ['departure'], prompt, shots: [{ prompt }] })
    expect(operation.outputNaming).toEqual({ title: '车站道别', prompt, role: kind === 'image' ? 'image' : 'shot', index: 1 })
    const receipt = { route: '/v1/videos', model: 'MiniMax-H3', phase: 'accepted' as const, taskId: 'original-name-task', backendFingerprint: 'a'.repeat(64) }
    if (kind === 'image') await store.receipt(operation, receipt)
    else await store.videoReceipt(operation, receipt)
    await store.finish(operation, { status: 'unknown' })
    store.release(operation)
    const path = join(options.directory, id, 'project.json')
    expect(await readFile(path, 'utf8')).not.toContain('outputNaming')
    const restarted = new CreativeStore(options)
    const recovered = kind === 'image' ? await restarted.resumeImage(owner, id, operation.operationId)
      : await restarted.resumeVideoTask(owner, id, operation.operationId)
    expect(recovered.operation.outputNaming).toEqual(operation.outputNaming)
    expect(recovered.receipt.taskId).toBe('original-name-task')
    expect(await readFile(path, 'utf8')).not.toContain('outputNaming')
    restarted.release(recovered.operation)
  })

  it('names an explicitly linked reference material and keeps automatic plans on a short-brief fallback', async () => {
    const { store, owner } = await fixture()
    const id = await store.updatePlan(owner, plan('video'))
    const material = await store.begin(owner, { kind: 'image', planId: id, assetId: 'portrait', prompt: '人物外形', shots: [{ prompt: '人物外形' }] })
    expect(material.outputNaming).toEqual({ title: '人物参考', prompt: '人物外形', role: 'reference-image' })
    store.release(material)
    const prompt = '完整的自动计划提示词'.repeat(20)
    const automatic = await store.begin(owner, { kind: 'image', prompt, shots: [{ prompt }] })
    expect(automatic.outputNaming).toEqual({ prompt, role: 'image' })
    store.release(automatic)
  })

  it.each(['standalone', 'image-shot', 'image-asset', 'video-asset'] as const)(
    'derives %s image purpose from the exact validated operation, without persisting a new field', async (association) => {
      const { store, owner, options } = await fixture()
      const planId = association === 'standalone' ? undefined : await store.updatePlan(owner,
        plan(association === 'video-asset' ? 'video' : 'image'))
      const operation = await store.begin(owner, { kind: 'image', prompt: 'A finished image, storyboard and video words prove nothing',
        shots: [{ prompt: 'one image' }], ...planId === undefined ? {} : { planId },
        ...association === 'image-shot' ? { shotIds: ['departure'] } : association.endsWith('asset') ? { assetId: 'portrait' } : {} })
      expect(operation.imageRole).toBe(association === 'video-asset' ? 'storyboard' : 'final')
      expect(JSON.parse(await readFile(join(options.directory, operation.projectId, 'project.json'), 'utf8'))).not.toHaveProperty('imageRole')
      expect(await readFile(join(options.directory, operation.projectId, 'project.json'), 'utf8')).not.toContain('imageRole')
    })

  it('restores an original storyboard image after restart and plan edits without changing its role or ownership', async () => {
    const { store, owner, options, setLive } = await fixture()
    const originalPlan = plan('video')
    const id = await store.updatePlan(owner, originalPlan)
    const original = await store.begin(owner, { kind: 'image', prompt: 'material', planId: id, assetId: 'portrait', shots: [{ prompt: 'material' }] })
    await store.receipt(original, acceptedImage)
    await store.finish(original, { status: 'unknown', imageReceipt: acceptedImage })
    store.release(original)
    await expect(store.updatePlan(owner, { ...originalPlan, kind: 'image' }, id)).rejects.toMatchObject({ code: 'CREATIVE_PLAN_CONFLICT' })
    await expect(store.updatePlan(owner, { ...originalPlan, assets: [] }, id)).rejects.toBeInstanceOf(CreativeError)
    await expect(store.updatePlan(owner, { ...originalPlan, assets: originalPlan.assets.map(asset => ({ ...asset, kind: 'video' })) }, id))
      .rejects.toBeInstanceOf(CreativeError)
    await store.updatePlan(owner, { ...originalPlan, title: 'Renamed video', assets: originalPlan.assets.map(asset => ({ ...asset, name: 'Renamed material' })) }, id)
    const other = await store.updatePlan(owner, plan('image'))
    const restarted = new CreativeStore(options)
    await expect(restarted.resumeImage(owner, other, original.operationId)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    const foreign = { ...owner, accountId: '8', sessionFingerprint: 'login-8' }
    setLive(foreign)
    await expect(restarted.resumeImage(foreign, id, original.operationId)).rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    setLive(owner)
    const recovered = await restarted.resumeImage(owner, id, original.operationId)
    expect(recovered).toEqual({ operation: { ...original, outputNaming: { ...original.outputNaming, title: 'Renamed material' } }, receipt: acceptedImage })
    expect(recovered.operation.imageRole).toBe('storyboard')
    expect(await readFile(join(options.directory, id, 'project.json'), 'utf8')).not.toContain('imageRole')
  })

  it('leaves an old video-plan image receipt without a material association unclassified', async () => {
    const { store, owner, options } = await fixture()
    const id = await store.updatePlan(owner, plan('video'))
    const legacy = await store.begin(owner, { kind: 'video', prompt: 'legacy unknown kind', planId: id,
      shotIds: ['departure'], shots: [{ prompt: 'legacy unknown kind' }] })
    await store.receipt(legacy, acceptedImage)
    await store.finish(legacy, { status: 'unknown', imageReceipt: acceptedImage })
    store.release(legacy)
    expect((await new CreativeStore(options).resumeImage(owner, id, legacy.operationId)).operation).not.toHaveProperty('imageRole')
  })
})

describe('retained ordinary video receipts', () => {
  const submitting: CreativeVideoReceipt = {
    route: '/v1/videos', model: 'model_5', phase: 'submitting',
    requestId: 'req-original-video', backendFingerprint: 'b'.repeat(64),
  }
  const accepted: CreativeVideoReceipt = { ...submitting, phase: 'accepted', taskId: 'public-original-video' }

  it('recovers the original accepted operation after restart and a fresh login without allocating another generation', async () => {
    const { store, owner, options, file, setLive } = await fixture()
    const operation = await store.begin(owner, { kind: 'video', prompt: 'one clip', shots: [{ prompt: 'one clip' }] })
    await store.videoReceipt(operation, submitting)
    await store.videoReceipt(operation, accepted)
    expect((await store.projects(owner))[0]?.tasks[0]).toMatchObject({ videoReceipt: accepted, canQuery: false, status: 'running' })
    store.release(operation)
    const restarted = new CreativeStore(options)
    expect((await restarted.projects(owner))[0]?.tasks[0]).toMatchObject({ videoReceipt: accepted, canQuery: true, status: 'unknown' })
    await expect(restarted.begin(owner, { kind: 'video', prompt: 'retry', planId: operation.projectId,
      shotIds: ['shot_1'], shots: [{ prompt: 'retry' }] })).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    const current = { ...owner, sessionFingerprint: 'fresh-login' }
    setLive(current)
    const resumed = await restarted.resumeVideoTask(current, operation.projectId, operation.operationId)
    expect(resumed).toEqual({ operation: { ...operation, owner: current }, receipt: accepted })
    await expect(restarted.resumeVideoTask(current, operation.projectId, operation.operationId)).rejects.toMatchObject({ code: 'CREATIVE_SHOT_RUNNING' })
    await restarted.finish(resumed.operation, { status: 'completed', kind: 'video', paths: [await file('original.mp4')],
      videoReceipt: { ...accepted, phase: 'completed' } })
    expect((await restarted.projects(current))[0]).toMatchObject({ status: 'completed', tasks: [{ id: operation.operationId,
      status: 'completed', canQuery: false, videoReceipt: { ...accepted, phase: 'completed' } }], outputs: [{ name: 'original.mp4' }] })
    await expect(restarted.resumeVideoTask(current, operation.projectId, operation.operationId)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_TASK_SETTLED' })
  })

  it('keeps the original video source across recovery and rejects changed or cross-chat receipt origins', async () => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'video', prompt: 'one clip', shots: [{ prompt: 'one clip' }] })
    const origin = { sessionId: owner.sessionId as import('@deepseek-ai/dsh-session/types').SessionId, turn: 3 }
    const receipt = { ...accepted, origin }
    await store.videoReceipt(operation, receipt)
    await expect(store.videoReceipt(operation, { ...receipt, origin: { ...origin, turn: 7 } }))
      .rejects.toMatchObject({ code: 'CREATIVE_VIDEO_RECEIPT_CONFLICT' })
    await expect(store.videoReceipt(operation, { ...receipt, origin: { ...origin, sessionId: 'other-chat' as typeof origin.sessionId } }))
      .rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    await store.finish(operation, { status: 'unknown', videoReceipt: receipt })
    const restarted = new CreativeStore(options)
    const resumed = await restarted.resumeVideoTask(owner, operation.projectId, operation.operationId)
    expect(resumed.receipt.origin).toEqual(origin)
    restarted.release(resumed.operation)
  })

  it('keeps a submitted video uncertain after local cancellation and refuses unconfirmed task recovery', async () => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'video', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.videoReceipt(operation, submitting)
    await store.finish(operation, { status: 'cancelled' })
    const restarted = new CreativeStore(options)
    expect((await restarted.projects(owner))[0]?.tasks[0]).toMatchObject({ status: 'unknown', canQuery: false,
      videoReceipt: { phase: 'submitting', requestId: accepted.requestId } })
    await expect(restarted.resumeVideoTask(owner, operation.projectId, operation.operationId)).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_TASK_UNCONFIRMED' })
    await expect(restarted.begin(owner, { kind: 'video', prompt: 'retry', planId: operation.projectId,
      shotIds: ['shot_1'], shots: [{ prompt: 'retry' }] })).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
  })

  it('atomically retains accepted identity on settlement and permits exactly one concurrent query', async () => {
    const { store, owner } = await fixture()
    const operation = await store.begin(owner, { kind: 'video', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.finish(operation, { status: 'cancelled', videoReceipt: accepted })
    expect((await store.projects(owner))[0]?.tasks[0]).toMatchObject({ status: 'unknown', videoReceipt: accepted, canQuery: true })
    const claims = await Promise.allSettled([store.resumeVideoTask(owner, operation.projectId, operation.operationId),
      store.resumeVideoTask(owner, operation.projectId, operation.operationId)])
    expect(claims.filter(claim => claim.status === 'fulfilled')).toHaveLength(1)
    expect(claims.find(claim => claim.status === 'rejected')).toMatchObject({ reason: { code: 'CREATIVE_SHOT_RUNNING' } })
    store.release(operation)
  })

  it('refuses another chat, workspace, account and an old-login callback without changing the original receipt', async () => {
    const { store, owner, options, setLive } = await fixture()
    const operation = await store.begin(owner, { kind: 'video', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.videoReceipt(operation, accepted)
    store.release(operation)
    const path = join(options.directory, operation.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    await expect(store.resumeVideoTask({ ...owner, sessionId: 'other-chat' }, operation.projectId, operation.operationId)).rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    await expect(store.resumeVideoTask({ ...owner, workspaceRoot: join(owner.workspaceRoot, 'other') }, operation.projectId, operation.operationId)).rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    const other = { ...owner, accountId: '8', sessionFingerprint: 'login-8' }
    setLive(other)
    await expect(store.resumeVideoTask(other, operation.projectId, operation.operationId)).rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    await expect(store.videoReceipt(operation, accepted)).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('rejects invalid or replaced identities and receipt-kind confusion before writing', async () => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'video', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.videoReceipt(operation, accepted)
    const path = join(options.directory, operation.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    for (const changed of [{ taskId: 'different-task' }, { route: '/other/videos' }, { model: 'different-model' },
      { backendFingerprint: 'c'.repeat(64) }, { phase: 'submitting' as const }]) {
      await expect(store.videoReceipt(operation, { ...accepted, ...changed })).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_RECEIPT_CONFLICT' })
    }
    for (const changed of [{ taskId: 'sk-secret' }, { route: 'https://elsewhere.invalid/v1/videos' }, { backendFingerprint: 'invalid' }]) {
      await expect(store.videoReceipt(operation, { ...accepted, ...changed })).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    }
    await expect(store.receipt(operation, acceptedImage)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    expect(await readFile(path, 'utf8')).toBe(before)
    store.release(operation)
  })

  it('clears a pre-dispatch video receipt only with executor proof and preserves known task evidence', async () => {
    const { store, owner } = await fixture()
    const untouched = await store.begin(owner, { kind: 'video', prompt: 'never sent', shots: [{ prompt: 'never sent' }] })
    await store.videoReceipt(untouched, { route: accepted.route, model: accepted.model, phase: 'submitting', backendFingerprint: accepted.backendFingerprint })
    await store.finish(untouched, { status: 'cancelled', notSubmitted: true })
    expect((await store.projects(owner)).find(project => project.id === untouched.projectId)?.tasks[0]).toMatchObject({ status: 'cancelled' })
    expect((await store.projects(owner)).find(project => project.id === untouched.projectId)?.tasks[0]).not.toHaveProperty('videoReceipt')
    const submitted = await store.begin(owner, { kind: 'video', prompt: 'sent', shots: [{ prompt: 'sent' }] })
    await store.videoReceipt(submitted, accepted)
    await expect(store.finish(submitted, { status: 'cancelled', notSubmitted: true })).rejects.toMatchObject({ code: 'CREATIVE_VIDEO_RECEIPT_CONFLICT' })
    expect((await store.projects(owner)).find(project => project.id === submitted.projectId)?.tasks[0]).toMatchObject({ status: 'unknown', videoReceipt: accepted })
  })

  it('rejects a video receipt on a character image operation in a video plan without changing its record', async () => {
    const { store, owner, options } = await fixture()
    const id = await store.updatePlan(owner, plan('video'))
    const operation = await store.begin(owner, { kind: 'image', prompt: 'portrait', planId: id,
      assetId: 'portrait', shots: [{ prompt: 'portrait' }] })
    const path = join(options.directory, id, 'project.json')
    const before = await readFile(path, 'utf8')
    await expect(store.videoReceipt(operation, accepted)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    await expect(store.matchVideoOutput(operation, Buffer.from('video bytes'))).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    await expect(store.finish(operation, { status: 'unknown', videoReceipt: accepted })).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    await expect(store.resumeVideoTask(owner, id, operation.operationId)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('reuses only the full unchanged original video after interrupted settlement, without duplicating outputs', async () => {
    const { store, owner, options, file } = await fixture()
    const operation = await store.begin(owner, { kind: 'video', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.videoReceipt(operation, accepted)
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 1)
    const path = await file('retained.mp4')
    await writeFile(path, bytes)
    await store.saved(operation, path, 'video')
    await store.finish(operation, { status: 'unknown', videoReceipt: { ...accepted, phase: 'completed' } })
    const restarted = new CreativeStore(options)
    const retained = await restarted.resumeVideoTask(owner, operation.projectId, operation.operationId)
    const different = Buffer.from(bytes)
    different[different.length - 1] = 2
    expect(await restarted.matchVideoOutput(retained.operation, different)).toBeUndefined()
    expect(await restarted.matchImageOutput(retained.operation, bytes)).toBeUndefined()
    expect(await restarted.matchVideoOutput(retained.operation, bytes)).toBe(path)
    expect((await readFile(path)).equals(bytes)).toBe(true)
    await restarted.finish(retained.operation, { status: 'completed', kind: 'video', paths: [path] })
    const project = (await restarted.projects(owner))[0]
    expect(project?.tasks).toHaveLength(1)
    expect(project?.tasks[0]?.outputs).toHaveLength(1)
    expect(project?.outputs).toHaveLength(1)
  })
})

describe('trusted independent chat image submissions', () => {
  it.each(['image', 'video'] as const)('admits distinct concurrent claims for the same %s plan association', async (kind) => {
    const { store, owner, options } = await fixture()
    const planId = await store.updatePlan(owner, plan(kind))
    const claims = new ImageInvocationStore({ directory: join(owner.workspaceRoot, 'claims'),
      apiBaseUrl: 'https://fixture.test/harness', current: options.current })
    const [first, second] = await Promise.all([1, 2].map(sourceSeq => claims.claim(owner, {
      sourceSeq, rootCallId: `root-${String(sourceSeq)}`, callId: 'image-call',
    })))
    if (first?.kind !== 'claimed' || second?.kind !== 'claimed') throw new Error('Fixture claims unavailable')
    const input = { kind: 'image' as const, source: 'chat' as const, prompt: 'same image prompt', planId,
      ...kind === 'video' ? { assetId: 'portrait' } : { shotIds: ['departure'] }, shots: [{ prompt: 'same image prompt' }] }
    const attempts = await Promise.allSettled([first.claim, second.claim, first.claim].map(claim =>
      store.begin(owner, { ...input, imageInvocationId: claim.invocationId })))
    const accepted = attempts.filter(item => item.status === 'fulfilled').map(item => item.value)
    expect(accepted).toHaveLength(2)
    expect(new Set(accepted.map(item => item.operationId)).size).toBe(2)
    expect(attempts.find(item => item.status === 'rejected')?.reason)
      .toMatchObject({ code: 'CREATIVE_IMAGE_SUBMISSION_DUPLICATE' })
    for (const operation of accepted) store.release(operation)
    const restarted = new CreativeStore(options)
    await expect(restarted.begin(owner, { ...input, imageInvocationId: first.claim.invocationId }))
      .rejects.toMatchObject({ code: 'CREATIVE_IMAGE_SUBMISSION_DUPLICATE' })
    const project = (await restarted.projects(owner)).find(item => item.id === planId)
    expect(project?.tasks).toHaveLength(2)
    expect(JSON.stringify(project)).not.toContain('imageInvocationId')
  })

  it.each([false, true])('keeps UNKNOWN independent from a later claim and queries only the old receipt (receipt: %s)', async (hasReceipt) => {
    const { store, owner, options } = await fixture()
    const planId = await store.updatePlan(owner, plan('image'))
    const input = { kind: 'image' as const, source: 'chat' as const, prompt: 'same image prompt', planId,
      shotIds: ['departure'], shots: [{ prompt: 'same image prompt' }] }
    const first = await store.begin(owner, { ...input, imageInvocationId: `ii_${'a'.repeat(64)}` })
    await store.dispatched(first)
    if (hasReceipt) await store.receipt(first, acceptedImage)
    await store.finish(first, { status: 'unknown' })
    const path = join(options.directory, planId, 'project.json')
    const before = JSON.parse(await readFile(path, 'utf8')) as { operations: unknown[] }
    const restarted = new CreativeStore(options)
    await expect(restarted.begin(owner, { ...input, source: 'ai-creation' }))
      .rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    const second = await restarted.begin(owner, { ...input, imageInvocationId: `ii_${'b'.repeat(64)}` })
    expect(second.operationId).not.toBe(first.operationId)
    const after = JSON.parse(await readFile(path, 'utf8')) as { operations: unknown[] }
    expect(after.operations).toHaveLength(2)
    expect(after.operations[0]).toEqual(before.operations[0])
    const begin = vi.spyOn(restarted, 'begin')
    if (hasReceipt) {
      const resumed = await restarted.resumeImage(owner, planId, first.operationId)
      expect(resumed.receipt).toEqual(acceptedImage)
      expect(resumed.operation.operationId).toBe(first.operationId)
      restarted.release(resumed.operation)
    } else {
      await expect(restarted.resumeImage(owner, planId, first.operationId))
        .rejects.toMatchObject({ code: 'CREATIVE_IMAGE_TASK_UNCONFIRMED' })
    }
    expect(begin).not.toHaveBeenCalled()
    expect((await restarted.projects(owner)).find(item => item.id === planId)?.tasks).toHaveLength(2)
    restarted.release(second)
  })

  it('refuses forged entry attribution and malformed image invocation ids', async () => {
    const { store, owner } = await fixture()
    const input = { kind: 'image' as const, prompt: 'one', shots: [{ prompt: 'one' }], imageInvocationId: `ii_${'c'.repeat(64)}` }
    for (const invalid of [{ ...input }, { ...input, source: 'ai-creation' as const },
      { ...input, kind: 'video' as const, source: 'chat' as const }, { ...input, source: 'chat' as const, imageInvocationId: 'prompt' }]) {
      await expect(store.begin(owner, invalid)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    }
    expect(await store.projects(owner)).toEqual([])
  })
})

describe('retained image receipts and query-only recovery', () => {
  it('recovers a no-task-id original result after restart and sign-in without exposing its private reference or sources', async () => {
    const { store, owner, options, file, setLive } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'original sync image', shots: [{ prompt: 'original sync image' }] })
    await store.receipt(operation, submittingImage)
    const results = new ImageResultStore({ directory: join(owner.workspaceRoot, 'private-image-results'), current: options.current })
    const sourceUrl = 'https://images.example/original.png?signature=private-source-signature'
    const sourceInline = Buffer.from('private original image bytes').toString('base64')
    const reference = await results.retain({ owner, operationId: operation.operationId,
      backendFingerprint: submittingImage.backendFingerprint }, submittingImage, [{ url: sourceUrl }, { b64_json: sourceInline }],
    ref => store.imageResult(operation, ref))
    await store.saved(operation, await file('partial-sync.png'), 'image')
    await store.finish(operation, { status: 'unknown', errorCode: 'IMAGE_DOWNLOAD_UNAVAILABLE' })
    const path = join(options.directory, operation.projectId, 'project.json')
    const raw = await readFile(path, 'utf8')
    expect(raw).toContain(reference)
    expect(raw).not.toContain(sourceUrl)
    expect(raw).not.toContain(sourceInline)
    const restarted = new CreativeStore(options)
    const published = await restarted.projects(owner)
    expect(published[0]?.tasks[0]).toMatchObject({ id: operation.operationId, status: 'unknown',
      recovery: 'image-result', canQuery: true, imageReceipt: { phase: 'submitting', requestId: 'req-original' },
      outputs: [{ name: 'partial-sync.png' }] })
    expect(published[0]?.tasks[0]?.imageReceipt).not.toHaveProperty('taskId')
    expect(JSON.stringify(published)).not.toMatch(/imageResultRef|ir_[a-f0-9]{64}|private-source-signature|b64_json/u)
    await expect(restarted.resumeImage({ ...owner, sessionId: 'another-chat' }, operation.projectId, operation.operationId))
      .rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    await expect(restarted.resumeImage({ ...owner, workspaceRoot: join(owner.workspaceRoot, 'another') },
      operation.projectId, operation.operationId)).rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    const otherOwner = { ...owner, accountId: 'another-account', sessionFingerprint: 'another-login' }
    setLive(otherOwner)
    await expect(restarted.resumeImage(otherOwner, operation.projectId, operation.operationId))
      .rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    const newOwner = { ...owner, sessionFingerprint: 'new-login-for-original-account' }
    setLive(newOwner)
    const recovered = await restarted.resumeImage(newOwner, operation.projectId, operation.operationId)
    expect(recovered).toMatchObject({ operation: { projectId: operation.projectId, operationId: operation.operationId, owner: newOwner },
      receipt: submittingImage, imageResultRef: reference })
    expect((await restarted.projects(newOwner))[0]?.tasks[0]).toMatchObject({ canQuery: false, recovery: 'image-result' })
    const restored = await new ImageResultStore({ directory: join(owner.workspaceRoot, 'private-image-results'), current: options.current })
      .load({ owner: newOwner, operationId: operation.operationId, backendFingerprint: submittingImage.backendFingerprint }, reference)
    expect(restored.items).toEqual([{ url: sourceUrl }, { b64_json: sourceInline }])
    await restarted.receipt(recovered.operation, { ...submittingImage, phase: 'completed' })
    await restarted.finish(recovered.operation, { status: 'completed', paths: [await file('remaining-sync.png')], kind: 'image' })
    const final = (await restarted.projects(newOwner))[0]
    expect(final?.tasks).toHaveLength(1)
    expect(final?.tasks[0]).toMatchObject({ id: operation.operationId, status: 'completed', canQuery: false })
    expect(final?.outputs.map(item => item.name).sort()).toEqual(['partial-sync.png', 'remaining-sync.png'])
    expect(JSON.stringify(final)).not.toContain(reference)
  })

  it('rejects result linking from another workspace, chat, account or expired login without changing the operation', async () => {
    const { store, owner, options, setLive } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    await store.receipt(operation, submittingImage)
    const path = join(options.directory, operation.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    const reference = `ir_${'a'.repeat(64)}` as ImageResultRef
    for (const changed of [{ ...owner, workspaceRoot: join(owner.workspaceRoot, 'another-workspace') },
      { ...owner, sessionId: 'another-chat' }]) {
      await expect(store.imageResult({ ...operation, owner: changed }, reference))
        .rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    }
    const other = { ...owner, accountId: 'another-account', sessionFingerprint: 'another-login' }
    setLive(other)
    await expect(store.imageResult({ ...operation, owner: other }, reference)).rejects.toMatchObject({ code: 'CREATIVE_ACCESS_DENIED' })
    setLive({ ...owner, sessionFingerprint: 'renewed-login' })
    await expect(store.imageResult(operation, reference)).rejects.toMatchObject({ code: 'CREATIVE_ACCOUNT_CHANGED' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('links only one original result after a receipt and rejects replacement or a released invocation', async () => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    const reference = `ir_${'a'.repeat(64)}` as ImageResultRef
    await expect(store.imageResult(operation, reference)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    await store.receipt(operation, submittingImage)
    await expect(store.imageResult(operation, '../private-result' as ImageResultRef)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    await store.imageResult(operation, reference)
    const path = join(options.directory, operation.projectId, 'project.json')
    const before = await readFile(path, 'utf8')
    await expect(store.imageResult(operation, `ir_${'b'.repeat(64)}` as ImageResultRef))
      .rejects.toMatchObject({ code: 'CREATIVE_IMAGE_RESULT_CONFLICT' })
    store.release(operation)
    await expect(store.imageResult(operation, reference)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it.each(['malformed-reference', 'missing-receipt', 'video-receipt'] as const)(
    'rejects damaged private result linkage instead of treating it as a new submission: %s', async (damage) => {
      const { store, owner, options } = await fixture()
      const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
      await store.receipt(operation, submittingImage)
      await store.imageResult(operation, `ir_${'a'.repeat(64)}` as ImageResultRef)
      store.release(operation)
      const path = join(options.directory, operation.projectId, 'project.json')
      const raw = JSON.parse(await readFile(path, 'utf8')) as { operations: Record<string, unknown>[] }
      const retained = raw.operations[0]!
      if (damage === 'malformed-reference') retained.imageResultRef = 'https://private.example/result?token=secret'
      else if (damage === 'missing-receipt') delete retained.imageReceipt
      else retained.videoReceipt = acceptedImage
      await writeFile(path, JSON.stringify(raw))
      const before = await readFile(path, 'utf8')
      await expect(new CreativeStore(options).projects(owner)).rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
      expect(await readFile(path, 'utf8')).toBe(before)
    },
  )

  it('keeps original generating locations across recovery and refuses changed or cross-chat receipt sources', async () => {
    const { store, owner, options } = await fixture()
    const operation = await store.begin(owner, { kind: 'image', prompt: 'one', shots: [{ prompt: 'one' }] })
    const origin = { sessionId: owner.sessionId as import('@deepseek-ai/dsh-session/types').SessionId, turn: 3 }
    const receipt = { ...acceptedImage, origin }
    await store.receipt(operation, receipt)
    await expect(store.receipt(operation, { ...receipt, origin: { ...origin, turn: 7 } })).rejects.toMatchObject({ code: 'CREATIVE_IMAGE_RECEIPT_CONFLICT' })
    await expect(store.receipt(operation, { ...receipt, origin: { ...origin, sessionId: 'other-chat' as typeof origin.sessionId } }))
      .rejects.toMatchObject({ code: 'CREATIVE_INVALID' })
    await store.finish(operation, { status: 'running', imageReceipt: receipt })
    const restarted = new CreativeStore(options)
    const resumed = await restarted.resumeImage(owner, operation.projectId, operation.operationId)
    expect(resumed.receipt.origin).toEqual(origin)
    restarted.release(resumed.operation)
  })

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
  it('retains a single-video receipt across restart, refuses resubmission and exclusively recovers the original task', async () => {
    const { store, owner, options, file } = await fixture()
    const operation = await store.begin(owner, { kind: 'video', prompt: 'clip', shots: [{ prompt: 'clip' }] })
    const receipt = { ...acceptedImage, route: '/v1/videos', model: 'video-model', taskId: 'original-video' }
    await store.videoReceipt(operation, receipt)
    await store.finish(operation, { status: 'running', videoReceipt: receipt, errorCode: 'VIDEO_QUERY_UNAVAILABLE' })
    const restarted = new CreativeStore(options)
    expect((await restarted.projects(owner))[0]?.tasks[0]).toMatchObject({ status: 'unknown', canQuery: true, videoReceipt: receipt })
    await expect(restarted.begin(owner, { kind: 'video', prompt: 'duplicate', planId: operation.projectId,
      shotIds: ['shot_1'], shots: [{ prompt: 'duplicate' }] })).rejects.toMatchObject({ code: 'CREATIVE_SUBMISSION_UNKNOWN' })
    await expect(restarted.resumeImage(owner, operation.projectId, operation.operationId)).rejects.toMatchObject({ code: 'CREATIVE_IMAGE_TASK_UNCONFIRMED' })
    const recovered = await restarted.resumeVideoTask(owner, operation.projectId, operation.operationId)
    await expect(restarted.resumeVideoTask(owner, operation.projectId, operation.operationId)).rejects.toMatchObject({ code: 'CREATIVE_SHOT_RUNNING' })
    const saved = await file('recovered.mp4')
    await restarted.finish(recovered.operation, { status: 'completed', kind: 'video', paths: [saved], videoReceipt: { ...receipt, phase: 'completed' } })
    expect((await restarted.projects(owner))[0]?.tasks[0]).toMatchObject({ status: 'completed', canQuery: false, outputs: [{ name: 'recovered.mp4' }] })
  })

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
      { kind: 'character', value: plan().characters[0]!, assets: [{ ...plan().assets[0]!, id: 'uploaded' }] },
      { kind: 'remove-character', id: 'S1' }, { kind: 'remove-asset', id: 'portrait' }, { kind: 'remove-shot', id: 'departure' },
    ]
    valid.forEach((change) => { expect(parseCreativePlanChange(JSON.parse(JSON.stringify(change)))).toEqual(change) })
    for (const invalid of [null, [], {}, { kind: 'generate', id: 'departure' },
      { kind: 'shot', id: 'departure', patch: { status: 'completed' } },
      { kind: 'shot', id: 'departure', patch: { durationSeconds: 0 } },
      { kind: 'shot', id: '../outside', patch: {} }, { kind: 'reorder', shotIds: [1] },
      { kind: 'character', value: { ...plan().characters[0], outputs: [] } },
      { kind: 'character', value: plan().characters[0], assets: [{ ...plan().assets[0], kind: 'video' }] },
      { kind: 'character', value: plan().characters[0], assets: [{ ...plan().assets[0], sourcePathOrAssetId: '/tmp/unuploaded.png' }] },
      { kind: 'character', value: plan().characters[0], assets: [{ ...plan().assets[0], outputs: [] }] },
      { kind: 'character', value: plan().characters[0], assets: [plan().assets[0], plan().assets[0]] },
      { kind: 'asset', value: { ...plan().assets[0], sourcePathOrAssetId: null } },
      { kind: 'add-shot', value: { ...plan().shots[0], actualDurationSeconds: 30 } },
      { kind: 'remove-shot', id: 'departure', owner: 'other' },
    ]) expect(() => parseCreativePlanChange(invalid)).toThrow(CreativeError)
  })

  it('commits uploaded character materials and bindings atomically while rejecting stale, duplicate and active edits', async () => {
    const { store, owner } = await fixture()
    const id = await store.updatePlan(owner, plan())
    const original = (await store.projects(owner))[0]!
    const assets = ['front', 'side'].map(id => ({ ...plan().assets[0]!, id, name: `${id}.png`, sourcePathOrAssetId: `ma_${id}` }))
    const change: CreativePlanChange = { kind: 'character', value: { ...plan().characters[0]!, referenceAssetIds: ['portrait', 'front', 'side'] }, assets }
    await store.revise(owner, id, original.planRevision, change)
    const saved = (await store.projects(owner))[0]!
    expect(saved.characters[0]?.referenceAssetIds).toEqual(['portrait', 'front', 'side'])
    expect(saved.assets.map(asset => asset.sourcePathOrAssetId)).toEqual(['ma_portrait', 'ma_front', 'ma_side'])
    expect(saved.assets.slice(1).every(asset => asset.referenceUrl?.includes('asset_id='))).toBe(true)
    await expect(store.revise(owner, id, original.planRevision, change)).rejects.toMatchObject({ code: 'CREATIVE_PLAN_STALE' })
    await expect(store.revise(owner, id, saved.planRevision, change)).rejects.toMatchObject({ code: 'CREATIVE_PLAN_CONFLICT' })
    const operation = await store.begin(owner, { kind: 'image', prompt: 'scene', planId: id,
      shotIds: ['departure'], shots: [{ prompt: 'scene' }] })
    const active: CreativePlanChange = { kind: 'character', value: { ...saved.characters[0]!, referenceAssetIds: ['portrait', 'extra'] },
      assets: [{ ...assets[0]!, id: 'extra', sourcePathOrAssetId: 'ma_extra' }] }
    await expect(store.revise(owner, id, saved.planRevision, active)).rejects.toMatchObject({ code: 'CREATIVE_PLAN_RUNNING' })
    expect(await store.plan(owner, id)).toMatchObject({ characters: [{ referenceAssetIds: ['portrait', 'front', 'side'] }] })
    expect((await store.plan(owner, id)).assets.some(asset => asset.id === 'extra')).toBe(false)
    await store.finish(operation, { status: 'failed', kind: 'image', errorCode: 'TASK_FAILED' })
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
