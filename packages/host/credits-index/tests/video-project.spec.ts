import { constants } from 'node:fs'
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobHandle } from '@deepseek-ai/dsh-jobs'
import type { VideoEditor } from '../src/video-edit.ts'
import { planVideoDurations, prepareVideoProject, readVideoProject, recoverVideoProjectOutputs, resolveVideoOutputDirectory, runVideoProject, VideoProjectError } from '../src/video-project.ts'
import type { VideoProjectInput, VideoProjectOptions, VideoProjectProvider } from '../src/video-project-types.ts'
import { VideoRelayError } from '../src/video-project-provider.ts'
import type { ArtifactOrigin, ArtifactPublishRequest } from '@deepseek-ai/dsh-artifacts-index'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

let directory: string | undefined

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function setup(durations = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
  directory = await mkdtemp(join(tmpdir(), 'dsh-video-project-final-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const events: string[] = []
  let submitted = 0
  let failSubmit = 0
  let failTask = ''
  let currentAccount = true
  let runningTask = ''
  const lengths = new Map<string, number>()
  const provider: VideoProjectProvider = {
    identity: { accountId: '7', sessionFingerprint: 'session-digest' },
    async assertCurrent() { if (!currentAccount) throw new VideoProjectError('ACCOUNT_CHANGED', '登录账号已变化，已停止后续提交。') },
    async model() { return { id: 'example-video', durations } },
    async build(_input, model, prompt, durationSeconds) { events.push('prepare'); return { model, prompt, durationSeconds } },
    async submit(request) {
      submitted += 1
      events.push(`submit-${String(submitted)}`)
      if (submitted === failSubmit) throw new Error('transport failed with secret')
      const taskId = `task-${String(submitted)}`
      lengths.set(taskId, Number(request.durationSeconds))
      return { taskId }
    },
    async check(taskId) { return { status: taskId === runningTask ? 'running' : taskId === failTask ? 'failed' : 'succeeded' } },
    async download(taskId, _request, path) {
      events.push(`download-${taskId}`)
      await writeFile(path, String(lengths.get(taskId)))
    },
  }
  const editor: VideoEditor = {
    async preflight() { events.push('preflight') },
    async probe(path) { return { durationSeconds: Number(await readFile(path, 'utf8')) } },
    async compose(request) {
      events.push('compose')
      const durationSeconds = request.totalDurationSeconds ?? 0
      await mkdir(dirname(request.outputPath), { recursive: true })
      await writeFile(request.outputPath, String(durationSeconds))
      return { path: request.outputPath, durationSeconds }
    },
  }
  const options: VideoProjectOptions = {
    stateDirectory: join(directory, 'state'), outputDirectory: 'artifacts/videos', maxTotalSeconds: 300, maxSegments: 32,
    pollIntervalMs: 1, taskTimeoutMs: 5000, editor: () => editor, acquireProvider: async () => provider,
  }
  const output: string[] = []
  const job: JobHandle = { id: JobId('video-project-1'), append: text => output.push(text), updateProgress: text => events.push(text) }
  const signal = new AbortController().signal
  const prepare = (origin?: ArtifactOrigin) => prepareVideoProject(options, { prompt: '拍一个茶杯广告', totalDurationSeconds: 40 },
    'chat-one', workspace, provider, editor, signal, origin)
  return {
    options, provider, editor, job, events, output, workspace, prepare, signal,
    get submitted() { return submitted },
    set failSubmit(value: number) { failSubmit = value }, set failTask(value: string) { failTask = value },
    set currentAccount(value: boolean) { currentAccount = value }, set runningTask(value: string) { runningTask = value },
  }
}

describe('minimum-request video duration planning', () => {
  it('uses 15+15+10 when supported and three 15-second clips when fixed', () => {
    expect(planVideoDurations(40, Array.from({ length: 12 }, (_, index) => index + 4), 32)).toEqual([15, 15, 10])
    expect(planVideoDurations(40, [15], 32)).toEqual([15, 15, 15])
    expect(planVideoDurations(40, [4, 8, 15], 32)).toEqual([15, 15, 15])
    expect(planVideoDurations(20, [6, 10, 15], 32)).toEqual([10, 10])
  })
  it('refuses unknown menus, fractional requests, and excess billable requests', () => {
    expect(() => planVideoDurations(40, [], 32)).toThrow('时长选项')
    expect(() => planVideoDurations(40.5, [15], 32)).toThrow('正整数')
    expect(() => planVideoDurations(40, [4], 2)).toThrow('项目上限')
  })
})

describe('explicit timeline execution', () => {
  it('shows the user funding rejection while preserving the unknown-submission barrier and saved work', async () => {
    const f = await setup()
    const manifest = await f.prepare()
    const submit = vi.spyOn(f.provider, 'submit').mockRejectedValue(new VideoRelayError('INSUFFICIENT_BALANCE', '余额不足，请充值'))
    const outcome = await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
    expect(outcome).toMatchObject({ status: 'failed', detail: 'INSUFFICIENT_BALANCE' })
    const result = JSON.parse(outcome.result ?? '') as { code: string; message: string }
    expect(result.code).toBe('INSUFFICIENT_BALANCE')
    expect(result.message).toContain('余额不足，请充值')
    expect(result.message).toContain('可能继续运行并计费')
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments[0]?.status).toBe('unknown')
    expect(retained.failureCode).toBe('INSUFFICIENT_BALANCE')
    expect(submit).toHaveBeenCalledOnce()
    expect(f.events).not.toContain('compose')
    const resumed = await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)
    expect(resumed).toMatchObject({ status: 'failed', detail: 'SUBMISSION_UNKNOWN' })
    expect(submit).toHaveBeenCalledOnce()
  })
  it('prepares exact ordered durations and isolated shot references once, then resumes the stored requests', async () => {
    const fixture = await setup()
    const build = vi.spyOn(fixture.provider, 'build').mockImplementation(async (input, model, prompt, durationSeconds) => ({
      model, prompt, durationSeconds, references: [...input.referenceImages ?? []],
    }))
    const input: VideoProjectInput = {
      prompt: '保留时间轴与人物身份', totalDurationSeconds: 20, shotPrompts: ['第一镜头', '第二镜头', '第三镜头'],
      shotDurations: [5, 10, 5], referenceImages: ['ma_shared'],
      shotReferenceImages: [['ma_actor_a', 'ma_shared'], ['ma_actor_b'], []],
    }
    const manifest = await prepareVideoProject(fixture.options, input, 'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)
    expect(manifest.segments.map(segment => segment.durationSeconds)).toEqual([5, 10, 5])
    expect(manifest.segments.map(segment => segment.request.references)).toEqual([
      ['ma_shared', 'ma_actor_a'], ['ma_shared', 'ma_actor_b'], ['ma_shared'],
    ])
    expect(build).toHaveBeenCalledTimes(3)
    expect(fixture.submitted).toBe(0)
    fixture.runningTask = 'task-1'
    const abort = new AbortController()
    const check = fixture.provider.check.bind(fixture.provider)
    fixture.provider.check = async (...args) => { const state = await check(...args); abort.abort(); return state }
    expect((await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, abort.signal)).status).toBe('killed')
    const retained = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    expect(retained.input).toEqual(input)
    expect(retained.segments.map(segment => segment.request)).toEqual(manifest.segments.map(segment => segment.request))
    fixture.runningTask = ''
    fixture.provider.check = check
    vi.spyOn(fixture.provider, 'model').mockRejectedValue(new Error('resume must not replan'))
    expect((await runVideoProject(fixture.options, retained, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('completed')
    expect(build).toHaveBeenCalledTimes(3)
    expect(fixture.submitted).toBe(3)
  })

  it.each([
    { shotDurations: [], code: 'INVALID_SHOT_DURATION' },
    { shotDurations: [5.5, 14.5], code: 'INVALID_SHOT_DURATION' },
    { shotDurations: [5, 5], code: 'SHOT_DURATION_MISMATCH' },
    { shotDurations: [2, 18], code: 'SHOT_DURATION_UNSUPPORTED' },
    { shotDurations: [5, 10, 5], maxSegments: 2, code: 'TOO_MANY_SEGMENTS' },
    { shotDurations: [10, 10], shotReferenceImages: [[]], code: 'SHOT_COUNT_MISMATCH' },
  ])('refuses an invalid timeline before building or submitting: %j', async ({ code, maxSegments, ...controls }) => {
    const fixture = await setup()
    if (maxSegments !== undefined) fixture.options.maxSegments = maxSegments
    const build = vi.spyOn(fixture.provider, 'build')
    await expect(prepareVideoProject(fixture.options, { prompt: '分镜', totalDurationSeconds: 20, ...controls },
      'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)).rejects.toMatchObject({ code })
    expect(build).not.toHaveBeenCalled()
    expect(fixture.submitted).toBe(0)
  })

  it('rejects a later unreadable shot reference before the first paid submission', async () => {
    const fixture = await setup()
    const build = vi.spyOn(fixture.provider, 'build').mockImplementation(async (input, model, prompt, durationSeconds) => {
      if (input.referenceImages?.includes('missing.png')) throw new VideoProjectError('VIDEO_REFERENCE_UNAVAILABLE', '参考图不可读')
      return { model, prompt, durationSeconds }
    })
    await expect(prepareVideoProject(fixture.options, { prompt: '分镜', totalDurationSeconds: 20,
      shotDurations: [10, 10], shotReferenceImages: [['ma_readable'], ['missing.png']] },
    'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)).rejects.toMatchObject({ code: 'VIDEO_REFERENCE_UNAVAILABLE' })
    expect(build).toHaveBeenCalledTimes(2)
    expect(fixture.submitted).toBe(0)
  })

  it.each([
    { shotDurations: ['15', 15, 10] }, { shotDurations: [15, 15] }, { shotDurations: [15, 10, 15] },
    { shotReferenceImages: [['ma_first']] }, { shotReferenceImages: [['ma_first'], [42], []] },
  ])('rejects inconsistent durable timeline fields without submitting: %j', async (invalidInput) => {
    const fixture = await setup()
    const manifest = await fixture.prepare()
    await writeFile(join(fixture.options.stateDirectory, manifest.id, 'manifest.json'),
      JSON.stringify({ ...manifest, input: { ...manifest.input, ...invalidInput } }))
    await expect(readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity))
      .rejects.toMatchObject({ code: 'INVALID_RECORD' })
    expect(fixture.submitted).toBe(0)
  })
})

describe('portable workspace output containment', () => {
  it('rejects parent traversal and absolute destinations with Windows path rules', () => {
    const root = 'C:\\workspace'
    expect(resolveVideoOutputDirectory(root, 'artifacts\\videos', win32)).toBe('C:\\workspace\\artifacts\\videos')
    expect(() => resolveVideoOutputDirectory(root, '..\\outside', win32)).toThrow('当前工作区')
    expect(() => resolveVideoOutputDirectory(root, '..\\workspace-other', win32)).toThrow('当前工作区')
    expect(() => resolveVideoOutputDirectory(root, 'D:\\outside', win32)).toThrow('当前工作区')
  })
})

describe('durable account-bound video projects', () => {
  it('retains the original generation source for clip recovery, resumed clips and final publication', async () => {
    const fixture = await setup()
    const destination = join(dirname(fixture.workspace), 'published')
    await mkdir(destination)
    let unavailable = true
    const publish = vi.fn(async (request: ArtifactPublishRequest) => {
      if (unavailable) throw new Error('volume temporarily unavailable')
      const path = join(destination, request.filename)
      await copyFile(request.sourcePath, path, constants.COPYFILE_EXCL)
      return { path }
    })
    fixture.options.publication = { capture: async () => ({ directory: destination }), validate: async () => {}, publish }
    const origin = { sessionId: SessionId('chat-one'), turn: 3, eventSeq: SessionSeq(8), toolCallId: ToolCallId('original-generate') }
    const preparing = fixture.prepare(origin)
    origin.turn = 99
    const manifest = await preparing
    expect(manifest.origin?.turn).toBe(3)
    expect((await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('failed')
    unavailable = false
    await recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
      fixture.provider.identity, fixture.signal, async () => {})
    const retained = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    expect(retained.origin).toEqual({ ...origin, turn: 3 })
    expect((await runVideoProject(fixture.options, retained, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('completed')
    expect(fixture.submitted).toBe(3)
    for (const [request] of publish.mock.calls) expect(request.origin).toEqual({ ...origin, turn: 3 })
    expect(publish.mock.calls.some(([request]) => request.sourcePath.includes('final-'))).toBe(true)
  })

  it('keeps legacy project sources absent and refuses damaged or cross-chat source records', async () => {
    const fixture = await setup()
    const manifest = await fixture.prepare()
    const path = join(fixture.options.stateDirectory, manifest.id, 'manifest.json')
    expect((await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)).origin).toBeUndefined()
    for (const origin of [null, { sessionId: 'chat-one', turn: -1 }, { sessionId: 'chat-one', turn: 1, eventSeq: 2.5 },
      { sessionId: 'different-chat', turn: 1 }, { sessionId: 'chat-one', turn: 1, toolCallId: '' }]) {
      await writeFile(path, JSON.stringify({ ...manifest, origin }))
      await expect(readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity))
        .rejects.toMatchObject({ code: 'INVALID_RECORD' })
    }
    expect(fixture.submitted).toBe(0)
  })
  it('publishes every verified clip before the next billable submission and resumes a failed copy without regenerating it', async () => {
    const fixture = await setup()
    const destination = join(dirname(fixture.workspace), 'selected-output')
    await mkdir(destination)
    let fail = true
    const publish = vi.fn(async (request: { destination: { directory: string }; sourcePath: string; filename: string }) => {
      if (fail) throw new Error('destination temporarily unavailable')
      const path = join(request.destination.directory, request.filename)
      await copyFile(request.sourcePath, path, constants.COPYFILE_EXCL)
      return { path }
    })
    fixture.options.publication = { capture: async () => ({ directory: destination }), validate: async () => {}, publish }
    const manifest = await fixture.prepare()
    expect(await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal))
      .toMatchObject({ status: 'failed', detail: 'ARTIFACT_PUBLISH_FAILED' })
    expect(fixture.submitted).toBe(1)
    expect(manifest.segments[0]?.status).toBe('saved')
    expect(manifest.segments[0]?.path).toBeTypeOf('string')
    expect(manifest.segments[0]?.publishedPath).toBeUndefined()
    const retained = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    fail = false
    expect((await runVideoProject(fixture.options, retained, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('completed')
    expect(fixture.submitted).toBe(3)
    expect(fixture.events.filter(event => event === 'download-task-1')).toHaveLength(1)
    expect(await Promise.all(retained.segments.map(segment => readFile(segment.publishedPath!, 'utf8')))).toEqual(['15', '15', '10'])
    expect(retained.segments.every(segment => segment.publishedPath?.startsWith(destination))).toBe(true)
    expect(retained.segments.every(segment => segment.path?.startsWith(fixture.options.stateDirectory))).toBe(true)
  })

  it('recovers only owned historical saved clips, including a project whose later shot failed, without upstream or composition work', async () => {
    const fixture = await setup()
    fixture.failTask = 'task-2'
    const manifest = await fixture.prepare()
    expect((await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('failed')
    const first = manifest.segments[0]!
    await rm(first.publishedPath!)
    delete first.publishedPath
    await writeFile(join(fixture.options.stateDirectory, manifest.id, 'manifest.json'), JSON.stringify(manifest))
    const capture = vi.fn(async () => { throw new Error('old project must retain its original workspace') })
    fixture.options.publication = { capture, validate: vi.fn(), publish: vi.fn() }
    const submit = vi.spyOn(fixture.provider, 'submit')
    const check = vi.spyOn(fixture.provider, 'check')
    const compose = vi.spyOn(fixture.editor, 'compose')
    const current = vi.fn(async () => {})
    const recovered = await recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
      fixture.provider.identity, fixture.signal, current)
    expect(recovered.status).toBe('failed')
    expect(recovered.segments[0]?.publishedPath?.startsWith(await realpath(manifest.outputDirectory))).toBe(true)
    expect(await readFile(recovered.segments[0]!.publishedPath!, 'utf8')).toBe('15')
    expect(await readFile(first.path!, 'utf8')).toBe('15')
    expect(submit).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(compose).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    const second = await recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
      fixture.provider.identity, fixture.signal, current)
    expect(second.segments[0]?.publishedPath).toBe(recovered.segments[0]?.publishedPath)
    await expect(recoverVideoProjectOutputs(fixture.options, manifest.id, 'other-chat', fixture.workspace,
      fixture.provider.identity, fixture.signal, current)).rejects.toMatchObject({ code: 'PROJECT_ACCESS_DENIED' })
    await expect(recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
      { accountId: 'other', sessionFingerprint: 'other' }, fixture.signal, current)).rejects.toMatchObject({ code: 'PROJECT_ACCESS_DENIED' })
  })

  it('serializes a free historical copy with explicit resume without copying or generating the same clip twice', async () => {
    const fixture = await setup()
    const destination = join(dirname(fixture.workspace), 'selected-output')
    await mkdir(destination)
    fixture.options.publication = { capture: async () => ({ directory: destination }), validate: async () => {},
      publish: async () => { throw new Error('first clip could not be published') } }
    const manifest = await fixture.prepare()
    expect((await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('failed')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const copied: string[] = []
    fixture.options.publication.publish = async (request) => {
      if (copied.length === 0) { entered.resolve(undefined); await release.promise }
      const path = join(destination, request.filename)
      await copyFile(request.sourcePath, path, constants.COPYFILE_EXCL)
      copied.push(request.sourcePath)
      return { path }
    }
    const recovery = recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
      fixture.provider.identity, fixture.signal, async () => {})
    await entered.promise
    const resumed = runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(fixture.submitted).toBe(1)
    release.resolve(undefined)
    await recovery
    expect((await resumed).status).toBe('completed')
    expect(fixture.submitted).toBe(3)
    expect(copied.filter(path => path === manifest.segments[0]?.path)).toHaveLength(1)
    expect(copied).toHaveLength(4)
    const saved = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    expect(saved.segments.every(segment => segment.publishedPath !== undefined)).toBe(true)
  })

  it('reloads published clips after backfill finishes during resume preflight before execution enters', async () => {
    const fixture = await setup()
    const destination = join(dirname(fixture.workspace), 'selected-output')
    await mkdir(destination)
    fixture.options.publication = { capture: async () => ({ directory: destination }), validate: async () => {},
      publish: async () => { throw new Error('temporarily unavailable') } }
    const manifest = await fixture.prepare()
    expect((await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('failed')
    const stale = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const copied: string[] = []
    fixture.options.publication.publish = async (request) => {
      const path = join(destination, request.filename)
      await copyFile(request.sourcePath, path, constants.COPYFILE_EXCL)
      copied.push(request.sourcePath)
      return { path }
    }
    vi.spyOn(fixture.editor, 'preflight').mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
    const resume = (async () => {
      await fixture.editor.preflight(fixture.signal, stale.outputDirectory)
      return runVideoProject(fixture.options, stale, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    })()
    await entered.promise
    await recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
      fixture.provider.identity, fixture.signal, async () => {})
    expect(stale.segments[0]?.publishedPath).toBeUndefined()
    expect(copied).toHaveLength(1)
    release.resolve(undefined)
    expect((await resume).status).toBe('completed')
    expect(copied.filter(path => path === manifest.segments[0]?.path)).toHaveLength(1)
    expect(copied).toHaveLength(4)
    expect(fixture.submitted).toBe(3)
  })

  it.each(['destination', 'clip'] as const)('keeps an owned historical projection with a retryable warning when its %s is unavailable', async (missing) => {
    const fixture = await setup()
    fixture.failTask = 'task-2'
    const manifest = await fixture.prepare()
    expect((await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('failed')
    const first = manifest.segments[0]!
    delete first.publishedPath
    if (missing === 'clip') await rm(first.path!)
    else {
      manifest.publicationDirectory = join(dirname(fixture.workspace), 'offline-output')
      fixture.options.publication = { capture: async () => { throw new Error('never recapture') }, validate: async () => {},
        publish: async () => { throw new Error('output volume is offline') } }
    }
    await writeFile(join(fixture.options.stateDirectory, manifest.id, 'manifest.json'), JSON.stringify(manifest))
    const retained = await recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
      fixture.provider.identity, fixture.signal, async () => {})
    expect(retained).toMatchObject({ publicationErrorCode: 'ARTIFACT_PUBLISH_FAILED', status: 'failed',
      failureCode: 'PROVIDER_TASK_FAILED', segments: [{ status: 'saved', path: first.path }, { status: 'failed' }, { status: 'pending' }] })
    expect(fixture.submitted).toBe(2)
    expect(await readFile(join(fixture.options.stateDirectory, manifest.id, 'manifest.json'), 'utf8')).not.toContain('publicationErrorCode')
    const denied = async () => { throw new VideoProjectError('ACCOUNT_CHANGED', '登录状态已变化') }
    await expect(recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
      fixture.provider.identity, fixture.signal, denied)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    let identityReads = 0
    const changedDuringCopy = async () => {
      if (++identityReads === 3) throw new VideoProjectError('ACCOUNT_CHANGED', '保存期间登录状态已变化')
    }
    await expect(recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
      fixture.provider.identity, fixture.signal, changedDuringCopy)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    await expect(recoverVideoProjectOutputs(fixture.options, manifest.id, 'other-chat', fixture.workspace,
      fixture.provider.identity, fixture.signal, async () => {})).rejects.toMatchObject({ code: 'PROJECT_ACCESS_DENIED' })
    const cancelled = AbortSignal.abort(new Error('cancelled'))
    await expect(recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
      fixture.provider.identity, cancelled, async () => {})).rejects.toThrow('cancelled')
  })

  it.each(['EACCES', 'ENOSPC'] as const)('removes only each uncommitted publication when repeated manifest writes fail with %s', async (code) => {
    const fixture = await setup()
    fixture.failTask = 'task-2'
    const manifest = await fixture.prepare()
    expect((await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('failed')
    const first = manifest.segments[0]!
    await rm(first.publishedPath!)
    delete first.publishedPath
    const destination = join(dirname(fixture.workspace), 'selected-output')
    await mkdir(destination)
    const existing = join(destination, 'keep-existing.mp4')
    await writeFile(existing, 'existing user file')
    manifest.publicationDirectory = destination
    const manifestPath = join(fixture.options.stateDirectory, manifest.id, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(manifest))
    const publish = vi.fn(async (request: { destination: { directory: string }; sourcePath: string; filename: string }) => {
      const path = join(request.destination.directory, request.filename)
      await copyFile(request.sourcePath, path, constants.COPYFILE_EXCL)
      return { path }
    })
    fixture.options.publication = { capture: async () => ({ directory: destination }), validate: async () => {}, publish }
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith(join(fixture.options.stateDirectory, manifest.id, '.manifest-'))) {
        throw Object.assign(new Error('state write unavailable'), { code })
      }
      return actual.writeFile(...args)
    })
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const retained = await recoverVideoProjectOutputs(fixture.options, manifest.id, 'chat-one', fixture.workspace,
          fixture.provider.identity, fixture.signal, async () => {})
        expect(retained.publicationErrorCode).toBe('ARTIFACT_PUBLISH_FAILED')
        expect(retained.segments[0]?.publishedPath).toBeUndefined()
        expect(await readdir(destination)).toEqual(['keep-existing.mp4'])
      }
      expect(publish).toHaveBeenCalledTimes(2)
      expect(await readFile(existing, 'utf8')).toBe('existing user file')
      expect(await readFile(first.path!, 'utf8')).toBe('15')
      expect(await readFile(manifestPath, 'utf8')).not.toContain('publishedPath')
      expect(fixture.submitted).toBe(2)
    } finally { vi.mocked(writeFile).mockImplementation(actual.writeFile) }
  })

  it('captures the selected output once and retries a failed publication without regenerating or recomposing', async () => {
    const fixture = await setup()
    const original = join(dirname(fixture.workspace), 'selected-output')
    let selected = original
    let publicationFails = true
    await mkdir(original)
    const capture = vi.fn(async () => ({ directory: selected }))
    const validate = vi.fn(async (destination: { directory: string }) => { expect(destination.directory).toBe(original) })
    const publish = vi.fn(async (request: { destination: { directory: string }; sourcePath: string; filename: string }) => {
      expect(request.destination.directory).toBe(original)
      if (publicationFails && basename(request.sourcePath).startsWith('final-')) throw new Error('disk unavailable')
      const path = join(request.destination.directory, request.filename)
      await copyFile(request.sourcePath, path)
      return { path }
    })
    fixture.options.publication = { capture, validate, publish }
    const manifest = await fixture.prepare()
    expect(manifest.publicationDirectory).toBe(original)
    expect(manifest.composedPath).toBeUndefined()
    selected = join(dirname(fixture.workspace), 'next-output')
    const failed = await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(failed).toMatchObject({ status: 'failed', detail: 'ARTIFACT_PUBLISH_FAILED' })
    expect(fixture.submitted).toBe(3)
    expect(fixture.events.filter(event => event === 'compose')).toHaveLength(1)
    expect(validate).toHaveBeenCalledTimes(3)
    expect(capture).toHaveBeenCalledTimes(1)
    const resumed = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    expect(resumed.composedPath?.startsWith(fixture.workspace)).toBe(true)
    expect(await readFile(resumed.composedPath!, 'utf8')).toBe('40')
    publicationFails = false
    const succeeded = await runVideoProject(fixture.options, resumed, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(succeeded.status).toBe('completed')
    expect(JSON.parse(succeeded.result ?? '{}')).toMatchObject({ final_path: resumed.finalPath })
    expect(resumed.finalPath?.startsWith(original)).toBe(true)
    expect(await readFile(resumed.finalPath!, 'utf8')).toBe('40')
    expect(await readFile(resumed.composedPath!, 'utf8')).toBe('40')
    expect(fixture.submitted).toBe(3)
    expect(fixture.events.filter(event => event === 'compose')).toHaveLength(1)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(5)
  })

  it('validates the retained destination before billing and never redirects a resumed project', async () => {
    const fixture = await setup()
    const retained = join(dirname(fixture.workspace), 'retained')
    const capture = vi.fn(async () => ({ directory: retained }))
    const validate = vi.fn(async () => { throw new Error('destination is no longer writable') })
    const publish = vi.fn(async () => ({ path: 'unused' }))
    fixture.options.publication = { capture, validate, publish }
    const manifest = await fixture.prepare()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)
      expect(outcome).toMatchObject({ status: 'failed', detail: 'ARTIFACT_DESTINATION_UNAVAILABLE' })
    }
    expect(capture).toHaveBeenCalledTimes(1)
    expect(validate).toHaveBeenNthCalledWith(1, { directory: retained }, expect.any(AbortSignal))
    expect(fixture.submitted).toBe(0)
    expect(publish).not.toHaveBeenCalled()
  })

  it('recovers when publication succeeds but recording completion fails without overwriting the first copy', async () => {
    const fixture = await setup()
    const destination = join(dirname(fixture.workspace), 'selected-output')
    await mkdir(destination)
    const published: string[] = []
    let recordDirectory = ''
    fixture.options.publication = {
      capture: async () => ({ directory: destination }), validate: async () => {},
      publish: async (request) => {
        const path = join(request.destination.directory, request.filename)
        await copyFile(request.sourcePath, path, constants.COPYFILE_EXCL)
        if (basename(request.sourcePath).startsWith('final-')) {
          published.push(path)
          if (published.length === 1) await rename(recordDirectory, recordDirectory + '-unavailable')
        }
        return { path }
      },
    }
    const manifest = await fixture.prepare()
    recordDirectory = join(fixture.options.stateDirectory, manifest.id)
    expect(await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal))
      .toMatchObject({ status: 'failed', detail: 'PROJECT_STORAGE_FAILED' })
    await rename(recordDirectory + '-unavailable', recordDirectory)
    const resumed = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    expect(resumed.finalPath).toBeUndefined()
    expect(resumed.composedPath).toBeDefined()
    expect((await runVideoProject(fixture.options, resumed, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('completed')
    expect(published).toHaveLength(2)
    expect(published[0]).not.toBe(published[1])
    expect(await Promise.all(published.map(path => readFile(path, 'utf8')))).toEqual(['40', '40'])
    expect(fixture.submitted).toBe(3)
    expect(fixture.events.filter(event => event === 'compose')).toHaveLength(1)
  })

  it('keeps older manifests in their original workspace when managed storage becomes available', async () => {
    const fixture = await setup()
    const manifest = await fixture.prepare()
    const restored = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    const capture = vi.fn(async () => { throw new Error('must not capture a different destination') })
    const validate = vi.fn(async () => {})
    const publish = vi.fn(async () => ({ path: 'unused' }))
    fixture.options.publication = { capture, validate, publish }
    expect((await runVideoProject(fixture.options, restored, fixture.provider, fixture.editor, fixture.job, fixture.signal)).status).toBe('completed')
    expect(restored.finalPath?.startsWith(fixture.workspace)).toBe(true)
    expect(capture).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('refuses an unwritable selected output before preparing paid requests', async () => {
    const fixture = await setup()
    const build = vi.spyOn(fixture.provider, 'build')
    fixture.options.publication = {
      capture: async () => { throw new Error('read-only disk') }, validate: async () => {}, publish: async () => ({ path: 'unused' }),
    }
    await expect(fixture.prepare()).rejects.toMatchObject({ code: 'ARTIFACT_DESTINATION_UNAVAILABLE' })
    expect(build).not.toHaveBeenCalled()
    expect(fixture.submitted).toBe(0)
  })

  it('retains the complete verbatim brief while limiting each planned request to its assigned shot', async () => {
    const fixture = await setup()
    const build = vi.spyOn(fixture.provider, 'build')
    const input: VideoProjectInput = {
      prompt: [
        '制作 40 秒的茶杯广告，保持白瓷茶杯与暖色晨光。',
        '完整台词：「杯沿留住晨光。」「热气慢慢升起。」「把今天握在手心。」',
        '配音语言：中文普通话，逐字保留台词及标点，禁止翻译或增删。',
        '字幕：逐字显示本镜对应台词，保留中文标点，禁止英文字幕。',
      ].join('\n'),
      totalDurationSeconds: 40,
      shotPrompts: [
        '镜头贴近杯沿，晨光从左侧照入。本镜台词：「杯沿留住晨光。」',
        '镜头缓慢上移，呈现杯口蒸汽。本镜台词：「热气慢慢升起。」',
        '镜头拉远，双手捧起茶杯。本镜台词：「把今天握在手心。」',
      ],
    }
    const manifest = await prepareVideoProject(fixture.options, input, 'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)
    expect(build).toHaveBeenCalledTimes(3)
    for (const [index, [originalInput, model, prompt, durationSeconds, signal]] of build.mock.calls.entries()) {
      expect(originalInput).toBe(input)
      expect(model).toBe('example-video')
      expect(prompt).toContain(input.prompt)
      expect(prompt.split(input.prompt)).toHaveLength(2)
      expect(prompt).toContain(`当前分镜 ${String(index + 1)}/3，本片时长 ${String(durationSeconds)} 秒：`)
      expect(prompt).toContain(input.shotPrompts?.[index])
      for (const [otherIndex, shotPrompt] of (input.shotPrompts ?? []).entries()) {
        if (otherIndex !== index) expect(prompt).not.toContain(shotPrompt)
      }
      expect(prompt).toContain('仅执行当前分镜的剧情、动作与分配台词；其他分镜只作上下文，不要在每段复述整篇或重复其他镜头的对白。')
      expect(prompt).toContain('只朗读本镜分配的台词，逐字保留用户原文、标点和语言，不改写、不翻译、不补造台词。')
      expect(prompt).toContain('仅在主说明或当前分镜明确要求字幕时显示本镜对应字幕，并按发声时序同步；逐字保留原文和标点，不擅自添加或翻译字幕。')
      expect(prompt).not.toContain('MiniMax-H3 原生音画表达')
      expect(prompt).not.toContain('<d>[Chinese]')
      expect(durationSeconds).toBe([15, 15, 10][index])
      expect(signal).toBe(fixture.signal)
      expect(manifest.segments[index]).toMatchObject({ prompt, request: { prompt, durationSeconds }, status: 'pending' })
    }
    const retained = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    expect(retained.input).toEqual(input)
    expect(retained.segments.map(segment => segment.prompt)).toEqual(build.mock.calls.map(call => call[2]))
    expect(fixture.submitted).toBe(0)
  })

  it('preserves explicit silence and subtitle restrictions for every assigned shot', async () => {
    const fixture = await setup([15])
    const build = vi.spyOn(fixture.provider, 'build')
    const input: VideoProjectInput = {
      prompt: '制作 30 秒无声茶杯短片。全片静音；无对白、无旁白、无音乐、无字幕。不得添加任何文字或声音。',
      totalDurationSeconds: 30,
      shotPrompts: ['固定机位呈现杯身釉色。', '缓慢推近杯中的清茶。'],
    }
    const manifest = await prepareVideoProject(fixture.options, input, 'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)
    expect(build).toHaveBeenCalledTimes(2)
    for (const [index, [, , prompt]] of build.mock.calls.entries()) {
      expect(prompt).toContain(input.prompt)
      expect(prompt).toContain(input.shotPrompts?.[index])
      expect(prompt).toContain('仅当主说明或当前分镜明确要求对白、演唱或旁白时才生成人声；尊重静音、无对白、无旁白和关闭音轨的要求，不强行配音。')
      expect(prompt).toContain('仅在主说明或当前分镜明确要求字幕时显示本镜对应字幕，并按发声时序同步；逐字保留原文和标点，不擅自添加或翻译字幕。')
      expect(manifest.segments[index]?.request.prompt).toBe(prompt)
    }
    expect(fixture.submitted).toBe(0)
  })

  it('keeps the main brief and continuity context when no individual shots are supplied', async () => {
    const fixture = await setup()
    const build = vi.spyOn(fixture.provider, 'build')
    const input: VideoProjectInput = { prompt: '白瓷茶杯从晨光进入柔和夕照，镜头保持缓慢平稳。', totalDurationSeconds: 40 }
    const manifest = await prepareVideoProject(fixture.options, input, 'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)
    expect(build).toHaveBeenCalledTimes(3)
    for (const [index, [, , prompt]] of build.mock.calls.entries()) {
      expect(prompt).toContain(input.prompt)
      expect(prompt).toContain(`分镜 ${String(index + 1)}/3`)
      expect(prompt).toContain('按主说明有序推进当前片段，承接前镜并自然过渡到后镜，不从头重复全片剧情。')
      expect(prompt).toContain('保持主体、风格、色彩与前后分镜连贯。')
      expect(prompt).toContain('仅当主说明或当前分镜明确要求对白、演唱或旁白时才生成人声；尊重静音、无对白、无旁白和关闭音轨的要求，不强行配音。')
      expect(prompt).toContain('仅在主说明或当前分镜明确要求字幕时显示本镜对应字幕，并按发声时序同步；逐字保留原文和标点，不擅自添加或翻译字幕。')
      expect(manifest.segments[index]?.request.prompt).toBe(prompt)
    }
    expect(fixture.submitted).toBe(0)
  })

  it('adds H3 native speech guidance without changing or double-wrapping the supplied line', async () => {
    const fixture = await setup([15])
    vi.spyOn(fixture.provider, 'model').mockResolvedValue({ id: 'MiniMax-H3', durations: [15] })
    const build = vi.spyOn(fixture.provider, 'build')
    const input: VideoProjectInput = {
      prompt: '镜头看向安静的茶杯。画外旁白逐字说出 <d>[Chinese]你好，世界。</d>，画内人物嘴唇闭合。',
      totalDurationSeconds: 15,
      shotPrompts: ['镜头缓慢推近茶杯，完整执行主说明中的这句画外旁白。'],
    }
    const manifest = await prepareVideoProject(fixture.options, input, 'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)
    const prompt = manifest.segments[0]!.prompt
    expect(build).toHaveBeenCalledExactlyOnceWith(input, 'MiniMax-H3', prompt, 15, fixture.signal)
    expect(prompt).toContain(input.prompt)
    expect(prompt.split('<d>[Chinese]你好，世界。</d>')).toHaveLength(2)
    expect(prompt).toContain('MiniMax-H3 原生音画表达：integrated_multimodal_description 描述本镜画面、动作和对白；overall_soundscape 只描述环境与非语言声音；non_diegetic_music 只描述背景配乐。')
    expect(prompt).toContain('仅对本镜明确要求发声的原句使用 <d>[原语言]原句</d>，中文台词使用 <d>[Chinese]原句</d>；原句与标点逐字保留，已有标签不重复包裹。说话人标识、动作和语气放在 <d> 外。')
    expect(prompt).toContain('画外旁白使用 says in an off-screen voiceover，并在对应 <d> 后明确画内角色嘴唇保持闭合；需要显示的字幕用英文双引号括起原文，不翻译。')
    expect(fixture.submitted).toBe(0)
  })

  it('rejects an oversized combined later shot before preparing or submitting any request', async () => {
    const fixture = await setup([15])
    const build = vi.spyOn(fixture.provider, 'build')
    const input: VideoProjectInput = {
      prompt: '完整主说明：' + '茶'.repeat(3500), totalDurationSeconds: 30,
      shotPrompts: ['第一镜保持缓慢平移。', '第二镜详细说明：' + '杯'.repeat(3500)],
    }
    const original = structuredClone(input)
    await expect(prepareVideoProject(fixture.options, input, 'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal))
      .rejects.toMatchObject({ code: 'INVALID_PROMPT', message: '完整分镜提示词超过 7000 字符，尚未提交生成；请精简主说明或分镜，原文未截断。' })
    expect(build).not.toHaveBeenCalled()
    expect(fixture.submitted).toBe(0)
    expect(input).toEqual(original)
    expect(fixture.events).toEqual(['preflight'])
  })

  it.each([false, true])('retains audio=%s and audio references in the durable project input', async (audio) => {
    const fixture = await setup([15])
    const input: VideoProjectInput = {
      prompt: '按参考音频制作一段茶杯短片。', totalDurationSeconds: 15, audio,
      referenceAudios: ['reference-audio-id', 'voices/narration.mp3'],
    }
    const manifest = await prepareVideoProject(fixture.options, input, 'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)
    const retained = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    expect(retained.input).toEqual(input)
    expect(retained.input.audio).toBe(audio)
    expect(retained.input.referenceAudios).toEqual(input.referenceAudios)
    expect(fixture.submitted).toBe(0)
  })

  it.each([
    { audio: 'false' },
    { audio: null },
    { referenceAudios: 'voices/narration.mp3' },
    { referenceAudios: ['reference-audio-id', 7] },
  ])('rejects malformed audio fields in a retained record: %j', async (invalidInput) => {
    const fixture = await setup()
    const manifest = await fixture.prepare()
    const path = join(fixture.options.stateDirectory, manifest.id, 'manifest.json')
    await writeFile(path, JSON.stringify({ ...manifest, input: { ...manifest.input, ...invalidInput } }))
    await expect(readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity))
      .rejects.toMatchObject({ code: 'INVALID_RECORD' })
    expect(fixture.submitted).toBe(0)
  })

  it('plans from the selected resolution menu rather than another resolution maximum', async () => {
    const fixture = await setup()
    const model = vi.spyOn(fixture.provider, 'model').mockImplementation(async (_id, _signal, resolution) => ({
      id: 'example-video', durations: resolution === '2K' ? [5, 10, 15] : [15, 30],
    }))
    const manifest = await prepareVideoProject(fixture.options,
      { prompt: 'A synthetic clip', totalDurationSeconds: 30, resolution: '2K' },
      'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)
    expect(model).toHaveBeenCalledWith(undefined, fixture.signal, '2K')
    expect(manifest.segments.map(segment => segment.durationSeconds)).toEqual([15, 15])
    expect(fixture.submitted).toBe(0)
  })

  it('preflights and validates every request before billing, then verifies and saves the final 40 seconds', async () => {
    const fixture = await setup()
    const manifest = await fixture.prepare()
    expect(fixture.submitted).toBe(0)
    expect((await stat(join(fixture.options.stateDirectory, manifest.id, 'clips'))).isDirectory()).toBe(true)
    expect(fixture.events).toEqual(['preflight', 'prepare', 'prepare', 'prepare'])
    expect(manifest.segments.map(segment => segment.durationSeconds)).toEqual([15, 15, 10])
    const outcome = await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(outcome.status).toBe('completed')
    expect(fixture.submitted).toBe(3)
    const record = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    expect(record.status).toBe('completed')
    expect(await readFile(record.finalPath!, 'utf8')).toBe('40')
    expect(record.segments.every(segment => segment.path?.startsWith(fixture.options.stateDirectory))).toBe(true)
    if (process.platform !== 'win32') expect((await stat(join(fixture.options.stateDirectory, manifest.id, 'manifest.json'))).mode & 0o777).toBe(0o600)
    const result = JSON.parse(outcome.result ?? '{}') as Record<string, unknown>
    expect({ ...result, project_id: '<project>', final_path: '<workspace>/final.mp4', clip_paths: ['<clip1>', '<clip2>', '<clip3>'] }).toMatchSnapshot()
    expect(JSON.stringify(record)).not.toContain('Bearer')
  })

  it('fails local preflight and invalid shot count before any paid request', async () => {
    const fixture = await setup()
    const preflight = vi.spyOn(fixture.editor, 'preflight').mockRejectedValueOnce(new Error('ffmpeg missing'))
    await expect(fixture.prepare()).rejects.toThrow('ffmpeg missing')
    preflight.mockRestore()
    await expect(prepareVideoProject(fixture.options, { prompt: '茶杯', totalDurationSeconds: 40, shotPrompts: ['仅一个镜头'] }, 'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)).rejects.toMatchObject({ code: 'SHOT_COUNT_MISMATCH' })
    expect(fixture.submitted).toBe(0)
  })

  it('checks the actual configured output subtree before preparing or submitting any clip', async () => {
    const fixture = await setup()
    const checked: string[] = []
    fixture.editor.preflight = async (_signal, outputDirectory) => {
      if (outputDirectory === undefined) throw new Error('missing output directory')
      checked.push(outputDirectory)
      throw new VideoProjectError('VIDEO_EDIT_SANDBOX_DENIED', '指定输出目录不可写。')
    }
    await expect(fixture.prepare()).rejects.toMatchObject({ code: 'VIDEO_EDIT_SANDBOX_DENIED' })
    expect(checked).toHaveLength(1)
    expect(checked[0]).toMatch(/artifacts[/\\]videos[/\\]vp_[a-f0-9-]{36}$/u)
    expect(fixture.events).toEqual([])
    expect(fixture.submitted).toBe(0)
  })

  it('keeps successful clips after a later task fails and does not re-submit failed tasks on resume', async () => {
    const fixture = await setup()
    fixture.failTask = 'task-2'
    const manifest = await fixture.prepare()
    const outcome = await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(outcome.status).toBe('failed')
    expect(fixture.submitted).toBe(2)
    expect(manifest.segments[0]?.status).toBe('saved')
    expect(await readFile(manifest.segments[0]!.path!, 'utf8')).toBe('15')
    await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(fixture.submitted).toBe(2)
    expect(manifest.segments[2]?.status).toBe('pending')
  })

  it('never retries an unknown POST outcome and makes possible billing visible', async () => {
    const fixture = await setup()
    fixture.failSubmit = 1
    const manifest = await fixture.prepare()
    const first = await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(first.result).toContain('可能已计费')
    expect(first.result).not.toContain('secret')
    const retained = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    expect(retained.segments[0]?.status).toBe('unknown')
    await runVideoProject(fixture.options, retained, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(fixture.submitted).toBe(1)
  })

  it('stops further charges when the active product login changes', async () => {
    const fixture = await setup()
    const download = fixture.provider.download.bind(fixture.provider)
    fixture.provider.download = async (...args) => { await download(...args); fixture.currentAccount = false }
    const manifest = await fixture.prepare()
    const outcome = await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(outcome.status).toBe('failed')
    expect(outcome.result).toContain('ACCOUNT_CHANGED')
    expect(fixture.submitted).toBe(1)
    expect(manifest.segments[0]?.status).toBe('saved')
    expect(manifest.segments[1]?.status).toBe('pending')
  })

  it('cancels polling, retains the known task, and explicitly resumes without a duplicate charge', async () => {
    const fixture = await setup()
    fixture.runningTask = 'task-1'
    const manifest = await fixture.prepare()
    const abort = new AbortController()
    const check = fixture.provider.check.bind(fixture.provider)
    fixture.provider.check = async (...args) => { const result = await check(...args); abort.abort(); return result }
    const outcome = await runVideoProject(fixture.options, manifest, fixture.provider, fixture.editor, fixture.job, abort.signal)
    expect(outcome.status).toBe('killed')
    expect(outcome.result).toContain('可能继续运行并计费')
    expect(fixture.submitted).toBe(1)
    const retained = await readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)
    fixture.runningTask = ''
    fixture.provider.check = check
    const resumed = await runVideoProject(fixture.options, retained, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(resumed.status).toBe('completed')
    expect(fixture.submitted).toBe(3)
  })

  it('rejects completed records without a saved final path and positive verified duration', async () => {
    const fixture = await setup()
    const manifest = await fixture.prepare()
    const path = join(fixture.options.stateDirectory, manifest.id, 'manifest.json')
    for (const completion of [
      { status: 'completed' },
      { status: 'completed', finalPath: '/workspace/final.mp4' },
      { status: 'completed', finalPath: '/workspace/final.mp4', finalDurationSeconds: 0 },
    ]) {
      await writeFile(path, JSON.stringify({ ...manifest, ...completion }))
      await expect(readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity))
        .rejects.toMatchObject({ code: 'INVALID_RECORD' })
    }
  })

  it('rejects damaged publication destinations and incomplete retained composition records', async () => {
    const fixture = await setup()
    const manifest = await fixture.prepare()
    const path = join(fixture.options.stateDirectory, manifest.id, 'manifest.json')
    const composedPath = join(fixture.workspace, 'composed.mp4')
    for (const damaged of [
      { publicationDirectory: 'relative' }, { publicationDirectory: 5 }, { publicationDirectory: `${fixture.workspace}\nother` },
      { publicationDirectory: fixture.workspace, composedPath },
      { publicationDirectory: fixture.workspace, composedDurationSeconds: 40 },
      { publicationDirectory: fixture.workspace, composedPath: 'relative', composedDurationSeconds: 40 },
      { publicationDirectory: fixture.workspace, composedPath, composedDurationSeconds: 40 },
    ]) {
      await writeFile(path, JSON.stringify({ ...manifest, ...damaged }))
      await expect(readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)).rejects.toMatchObject({ code: 'INVALID_RECORD' })
    }
  })

  it('authorizes retained records by account, chat, and workspace and rejects damaged requests', async () => {
    const fixture = await setup()
    const manifest = await fixture.prepare()
    await expect(readVideoProject(fixture.options, manifest.id, 'another-chat', fixture.workspace, fixture.provider.identity)).rejects.toMatchObject({ code: 'PROJECT_ACCESS_DENIED' })
    await expect(readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, { accountId: '8', sessionFingerprint: 'other' })).rejects.toMatchObject({ code: 'PROJECT_ACCESS_DENIED' })
    await expect(readVideoProject(fixture.options, '../session', 'chat-one', fixture.workspace, fixture.provider.identity)).rejects.toMatchObject({ code: 'INVALID_PROJECT_ID' })
    const path = join(fixture.options.stateDirectory, manifest.id, 'manifest.json')
    const damaged = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    damaged.segments = [{ index: 1, durationSeconds: 15, prompt: '杯子', request: null, status: 'pending' }]
    await writeFile(path, JSON.stringify(damaged))
    await expect(readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)).rejects.toMatchObject({ code: 'INVALID_RECORD' })
  })
})
