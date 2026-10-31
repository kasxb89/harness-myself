import { constants } from 'node:fs'
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobHandle } from '@deepseek-ai/dsh-jobs'
import type { VideoEditor } from '../src/video-edit.ts'
import { planVideoDurations, prepareVideoProject, readVideoProject, recoverVideoProjectOutputs, resolveVideoOutputDirectory, runVideoProject, VideoProjectError } from '../src/video-project.ts'
import type { VideoProjectInput, VideoProjectOptions, VideoProjectProvider, VideoProjectSubmission } from '../src/video-project-types.ts'
import { VideoRelayError } from '../src/video-project-provider.ts'
import type { VideoProjectRelay } from '../src/video-project-provider.ts'
import { createVideoProjectDispatch } from '../src/video-project-dispatch.ts'
import { h3SubmissionQueryRejection, h3SubmissionRejection } from '../src/video-submission-result.ts'
import notSentContract from './fixtures/h3-not-sent-contract.json' with { type: 'json' }
import mediaContract from './fixtures/media-submission-api-contract-v3.json' with { type: 'json' }
import type { ArtifactOrigin, ArtifactPublishRequest } from '@deepseek-ai/dsh-artifacts-index'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { VideoProjectActivity } from '../src/creation-activity.ts'
import { MAX_MEDIA_FILENAME_BYTES } from '../src/media-filename.ts'
import { catalogFromPricing, type VideoParams } from '../src/media.ts'
import { videoSpecificationDurations } from '../src/media-request-specification.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

let directory: string | undefined
const concurrentRuns = new Set<() => Promise<void>>()

function ownConcurrentRun<T>(running: Promise<T>, release: () => void): Promise<T> {
  const close = async (): Promise<void> => { release(); await running }
  concurrentRuns.add(close)
  void running.then(() => concurrentRuns.delete(close), () => concurrentRuns.delete(close))
  return running
}

afterEach(async () => {
  await Promise.all([...concurrentRuns].map(close => close()))
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
    // These failure-boundary fixtures deliberately use one worker; default scheduling has its own barrier case.
    maxConcurrentSegments: 1,
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

describe('readable video output names', () => {
  it('retains local plan and shot titles without sending them to the provider or replacing same-title files', async () => {
    const f = await setup([15])
    const build = vi.spyOn(f.provider, 'build')
    const input: VideoProjectInput = { prompt: '小狐狸走过春日山谷', title: '四季流转', shotTitles: ['春日苏醒'], totalDurationSeconds: 15 }
    const first = await prepareVideoProject(f.options, input, 'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect((await runVideoProject(f.options, first, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    const retained = await readVideoProject(f.options, first.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.input).toMatchObject({ title: '四季流转', shotTitles: ['春日苏醒'] })
    expect(basename(retained.finalPath!)).toMatch(/^四季流转-成片-[a-f0-9-]{36}\.mp4$/u)
    expect(basename(retained.segments[0]!.publishedPath!)).toMatch(/^春日苏醒-分镜-01-[a-f0-9-]{36}\.mp4$/u)
    expect(build.mock.calls[0]?.[0]).not.toHaveProperty('title')
    expect(build.mock.calls[0]?.[0]).not.toHaveProperty('shotTitles')
    const second = await prepareVideoProject(f.options, input, 'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect((await runVideoProject(f.options, second, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    expect(second.finalPath).not.toBe(retained.finalPath)
    expect(second.segments[0]?.publishedPath).not.toBe(retained.segments[0]?.publishedPath)
    expect(await Promise.all([retained.finalPath!, second.finalPath!].map(path => readFile(path, 'utf8')))).toEqual(['15', '15'])
    const paths = [retained.finalPath!, retained.segments[0]!.publishedPath!]
    expect((await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    expect([retained.finalPath, retained.segments[0]?.publishedPath]).toEqual(paths)
    expect(f.submitted).toBe(2)
    expect(f.events.filter(event => event === 'compose')).toHaveLength(2)
  })

  it('bounds long Chinese labels and removes Windows filename syntax from workspace outputs', async () => {
    const f = await setup([15])
    const title = '四季<>:"/\\|?*流转' + '山谷'.repeat(100)
    const manifest = await prepareVideoProject(f.options, { prompt: '春日山谷', title, shotTitles: ['CON'], totalDurationSeconds: 15 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect((await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    for (const path of [manifest.finalPath!, manifest.segments[0]!.publishedPath!]) {
      const name = basename(path)
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_MEDIA_FILENAME_BYTES)
      expect(name).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/u)
      expect(name).toMatch(/-[a-f0-9-]{36}\.mp4$/u)
    }
    expect(basename(manifest.segments[0]!.publishedPath!)).toContain('素材-CON-分镜-01-')
  })

  it('reads old v1 manifests and preserves already saved legacy paths without generation or renaming', async () => {
    const f = await setup()
    const manifest = await f.prepare()
    expect((await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    const legacyPath = join(manifest.outputDirectory, 'final-legacy-existing.mp4')
    await rename(manifest.finalPath!, legacyPath)
    manifest.finalPath = legacyPath
    await writeFile(join(f.options.stateDirectory, manifest.id, 'manifest.json'), JSON.stringify(manifest))
    const retained = await recoverVideoProjectOutputs(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity, f.signal, async () => {})
    expect(retained.input).not.toHaveProperty('title')
    expect(retained.input).not.toHaveProperty('shotTitles')
    expect(retained.finalPath).toBe(legacyPath)
    expect((await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    expect(retained.finalPath).toBe(legacyPath)
    expect(await readFile(legacyPath, 'utf8')).toBe('40')
    expect(f.submitted).toBe(3)
    expect(f.events.filter(event => event === 'compose')).toHaveLength(1)
  })

  it('refuses malformed retained naming metadata before resuming generation', async () => {
    const f = await setup()
    const manifest = await f.prepare()
    for (const fields of [{ title: '' }, { title: 42 }, { title: '名'.repeat(257) },
      { shotTitles: ['只有一镜'] }, { shotTitles: ['第一镜', '', '第三镜'] }, { shotTitles: ['第一镜', 42, '第三镜'] }]) {
      await writeFile(join(f.options.stateDirectory, manifest.id, 'manifest.json'), JSON.stringify({ ...manifest, input: { ...manifest.input, ...fields } }))
      await expect(readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)).rejects.toMatchObject({ code: 'INVALID_RECORD' })
    }
    expect(f.submitted).toBe(0)
  })
})

describe('minimum-request video duration planning', () => {
  it('observes eight distinct clips under one project and keeps queue, generation, saving and editing separate', async () => {
    const f = await setup([15])
    f.options.maxConcurrentSegments = 4
    const observations: VideoProjectActivity[] = []
    f.options.activity = event => observations.push(event)
    const queries = new Map<string, number>()
    f.provider.check = async (id) => {
      const count = (queries.get(id) ?? 0) + 1
      queries.set(id, count)
      return { status: count === 1 ? 'queued' : count === 2 ? 'running' : 'succeeded' }
    }
    const manifest = await prepareVideoProject(f.options, { prompt: 'private complete brief', totalDurationSeconds: 120 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect(new Set(manifest.segments.map(segment => segment.attemptId)).size).toBe(8)
    for (const segment of manifest.segments) expect(segment.attemptId).toMatch(/^[a-f0-9-]{36}$/u)
    expect(observations).toEqual([])
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
    const clips = observations.filter(event => event.shotId !== undefined)
    expect(new Set(clips.map(event => event.shotId)).size).toBe(8)
    expect(new Set(observations.map(event => event.projectId))).toEqual(new Set([manifest.id]))
    expect(new Set(observations.map(event => event.ownerSessionId))).toEqual(new Set(['chat-one']))
    for (let index = 1; index <= 8; index += 1) {
      const phases = clips.filter(event => event.shotId === String(index))
      expect(new Set(phases.map(event => event.attemptId))).toEqual(new Set([manifest.segments[index - 1]?.attemptId]))
      expect(phases.map(event => event.type === 'stage' ? event.stage : event.outcome))
        .toEqual(['preparing', 'submitting', 'accepted', 'queued', 'generating', 'saving', 'completed'])
    }
    expect(observations.filter(event => event.shotId === undefined).map(event => event.type === 'stage' ? event.stage : event.outcome))
      .toEqual(['preparing', 'editing', 'completed'])
    expect(JSON.stringify(observations)).not.toContain('private complete brief')
    expect(f.submitted).toBe(8)
  })

  it.each(['pending', 'running'] as const)('persists a missing legacy %s attempt before any POST or original-task GET', async (status) => {
    const f = await setup([4])
    const manifest = await prepareVideoProject(f.options, { prompt: 'legacy original clip', totalDurationSeconds: 4 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const segment = manifest.segments[0]
    if (segment === undefined) throw new Error('Expected one retained clip')
    delete segment.attemptId
    segment.status = status
    if (status === 'running') {
      manifest.status = 'running'
      segment.taskId = 'legacy-original-task'
    }
    const path = join(f.options.stateDirectory, manifest.id, 'manifest.json')
    await writeFile(path, JSON.stringify(manifest))
    const original = await readFile(path, 'utf8')
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments[0]?.attemptId).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe(original)
    const observations: VideoProjectActivity[] = []
    f.options.activity = event => observations.push(event)
    const originalSubmit = f.provider.submit.bind(f.provider)
    const attempts: string[] = []
    const assertCommittedAttempt = async (): Promise<void> => {
      const current = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
      const attempt = current.segments[0]?.attemptId
      expect(attempt).toMatch(/^[a-f0-9-]{36}$/u)
      if (attempt === undefined) throw new Error('Attempt must be committed before provider I/O')
      attempts.push(attempt)
    }
    f.provider.submit = async (...args) => { await assertCommittedAttempt(); return originalSubmit(...args) }
    f.provider.check = async () => { await assertCommittedAttempt(); return { status: 'succeeded' } }
    f.provider.download = async (_task, _request, destination) => { await writeFile(destination, '4') }
    expect(await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
    const completed = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(new Set(attempts)).toEqual(new Set([completed.segments[0]?.attemptId]))
    expect(observations.filter(event => event.shotId !== undefined)
      .every(event => event.attemptId === completed.segments[0]?.attemptId)).toBe(true)
    expect(f.submitted).toBe(status === 'pending' ? 1 : 0)
    expect(await runVideoProject(f.options, completed, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
    expect(f.submitted).toBe(status === 'pending' ? 1 : 0)
    const next = await prepareVideoProject(f.options, { prompt: 'explicit new work', totalDurationSeconds: 4 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect(next.segments[0]?.attemptId).not.toBe(completed.segments[0]?.attemptId)
  })

  it('ends uncertain submission observation without inventing generating or completed state', async () => {
    const f = await setup([15])
    const observations: VideoProjectActivity[] = []
    f.options.activity = event => observations.push(event)
    f.failSubmit = 1
    const manifest = await prepareVideoProject(f.options, { prompt: 'one clip', totalDurationSeconds: 15 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'failed', detail: 'SUBMISSION_UNKNOWN' })
    expect(observations.filter(event => event.shotId === '1').map(event => event.type === 'stage' ? event.stage : event.outcome))
      .toEqual(['preparing', 'submitting', 'unknown', 'unknown'])
    expect(observations.at(-1)).toMatchObject({ type: 'end', stage: 'unknown', outcome: 'unknown' })
    expect(f.submitted).toBe(1)
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    const count = observations.length
    expect(retained.segments[0]?.status).toBe('unknown')
    expect(observations).toHaveLength(count)
  })

  it('queries a coherent uncertain original ID without clearing its unknown lock when the original GET is unavailable', async () => {
    const f = await setup([4])
    const submit = vi.spyOn(f.provider, 'submit').mockRejectedValue(new VideoRelayError('VIDEO_SUBMIT_UNKNOWN',
      '原回执尚未通过完整核对', { taskId: 'task_original_media_unknown' }))
    const check = vi.spyOn(f.provider, 'check').mockRejectedValue(new VideoRelayError('VIDEO_READ_UNAVAILABLE', '原任务暂不可读取'))
    const manifest = await prepareVideoProject(f.options, { prompt: 'One original video', totalDurationSeconds: 8 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'failed', detail: 'SUBMISSION_UNKNOWN' })
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments.map(segment => segment.status)).toEqual(['unknown', 'pending'])
    expect(retained.segments[0]?.taskId).toBe('task_original_media_unknown')
    expect(await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'VIDEO_TASK_OBSERVATION_UNAVAILABLE' })
    expect(check.mock.calls.map(([id]) => id)).toEqual(['task_original_media_unknown'])
    expect(retained.segments.map(segment => segment.status)).toEqual(['unknown', 'pending'])
    expect(submit).toHaveBeenCalledOnce()
  })

  it('settles the actual non-H3 media no-charge proof with the original task and no automatic resubmission', async () => {
    const f = await setup([4])
    const actual = mediaContract.find(entry => entry.method === 'POST' && entry.http_status === 429 && entry.response.media_kind === 'video')
    if (actual === undefined) throw new Error('Actual media capacity fixture required')
    const rejection = h3SubmissionRejection(actual.response.model, actual.http_status, actual.response)
    if (rejection === undefined) throw new Error('Actual media rejection must decode')
    const submit = vi.spyOn(f.provider, 'submit').mockRejectedValue(rejection)
    const manifest = await prepareVideoProject(f.options, { prompt: 'Original no-charge video', totalDurationSeconds: 8 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'failed', detail: 'media_account_capacity_exhausted' })
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments.map(segment => segment.status)).toEqual(['failed', 'pending'])
    expect(retained.segments[0]?.taskId).toBe(actual.response.id)
    expect(await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'failed', detail: 'PROVIDER_TASK_FAILED' })
    expect(submit).toHaveBeenCalledOnce()
  })
  it.each([
    { status: 429, body: { code: 'h3_account_capacity_exhausted', data: null, submission_state: 'not_submitted', retryable: false, resubmittable: true },
      code: 'H3_ACCOUNT_CAPACITY_EXHAUSTED', taskId: undefined },
    { status: 502, body: { code: 'h3_upstream_auth_rejected', data: null, submission_state: 'failed', id: 'failed-h3-task', task_id: 'failed-h3-task',
      refund_confirmed: true, retryable: false, resubmittable: false }, code: 'H3_UPSTREAM_AUTH_REJECTED', taskId: 'failed-h3-task' },
  ])('persists a confirmed H3 $status rejection as failed and never resubmits it after fresh resume', async ({ status, body, code, taskId }) => {
    const f = await setup([4])
    const settled = h3SubmissionRejection('MiniMax-H3', status, body)
    if (settled === undefined) throw new Error('Expected exact H3 settlement fixture')
    const submit = vi.spyOn(f.provider, 'submit').mockRejectedValue(settled)
    const manifest = await prepareVideoProject(f.options, { prompt: 'A settled H3 attempt', totalDurationSeconds: 8 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const outcome = await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
    expect(outcome).toMatchObject({ status: 'failed', detail: code })
    expect(outcome.result).not.toContain('可能继续运行并计费')
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments[0]?.status).toBe('failed')
    expect(retained.segments[0]?.taskId).toBe(taskId)
    expect(retained.segments[1]?.status).toBe('pending')
    expect(await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'failed', detail: 'PROVIDER_TASK_FAILED' })
    expect(submit).toHaveBeenCalledOnce()
    expect(f.events).not.toContain('compose')
  })

  it('retains a queryable H3 unknown task and resumes its existing id without another POST', async () => {
    const f = await setup([4])
    const manifest = await prepareVideoProject(f.options, { prompt: 'An original H3 task', totalDurationSeconds: 4 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const check = vi.spyOn(f.provider, 'check').mockRejectedValueOnce(new VideoRelayError('VIDEO_STATUS_INVALID', '原任务尚未确认'))
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'failed', detail: 'VIDEO_STATUS_INVALID' })
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    const attempt = retained.segments[0]?.attemptId
    expect(attempt).toBe(manifest.segments[0]?.attemptId)
    expect(retained.segments[0]).toMatchObject({ status: 'running', taskId: 'task-1' })
    expect(f.submitted).toBe(1)
    expect(await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
    expect(retained.segments[0]?.attemptId).toBe(attempt)
    expect(f.submitted).toBe(1)
    expect(check.mock.calls.map(([id]) => id)).toEqual(['task-1', 'task-1'])
  })

  it.each(['not_charged', 'refunded'] as const)('settles an original H3 GET $0 proof without losing saved work or resubmitting accepted peers', async (billingState) => {
    const f = await setup([4])
    f.options.maxConcurrentSegments = 2
    f.provider.parallelism = async () => 2
    const manifest = await prepareVideoProject(f.options, { prompt: 'Four retained H3 clips', totalDurationSeconds: 16 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const [saved, rejected, peer] = manifest.segments
    if (saved === undefined || rejected === undefined || peer === undefined) throw new Error('Expected four planned clips')
    for (const segment of [saved, rejected, peer]) {
      segment.taskId = (await f.provider.submit(segment.request, f.signal)).taskId
      segment.status = 'running'
    }
    saved.path = join(f.options.stateDirectory, manifest.id, 'clips', 'retained-first.mp4')
    await mkdir(dirname(saved.path), { recursive: true })
    await f.provider.download(saved.taskId!, saved.request, saved.path, f.signal)
    saved.status = 'saved'
    manifest.status = 'failed'
    await writeFile(join(f.options.stateDirectory, manifest.id, 'manifest.json'), JSON.stringify(manifest))
    const receipt = { ...notSentContract.receipt, id: rejected.taskId, task_id: rejected.taskId,
      billing_state: billingState, ...billingState === 'refunded' ? { refund_confirmed: true } : {} }
    const proof = h3SubmissionQueryRejection('MiniMax-H3', 200,
      { task_id: rejected.taskId, status: 'UNKNOWN', submission_receipt: receipt }, rejected.taskId!)
    if (proof === undefined) throw new Error('Expected the complete original H3 GET proof')
    const submit = vi.spyOn(f.provider, 'submit')
    const compose = vi.spyOn(f.editor, 'compose')
    const peerObserved = Promise.withResolvers<undefined>()
    const check = vi.spyOn(f.provider, 'check').mockImplementation(async (id, _request, signal) => {
      if (id === rejected.taskId) { await peerObserved.promise; throw proof }
      if (id !== peer.taskId) throw new Error('Only original retained tasks may be queried')
      peerObserved.resolve(undefined)
      await new Promise<never>((_resolve, reject) => {
        const aborted = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('Original observation stopped')) }
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      })
      return { status: 'succeeded' }
    })
    const outcome = await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
    expect(outcome).toMatchObject({ status: 'failed', detail: 'H3_SUBMISSION_NOT_SENT' })
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained).toMatchObject({ failureCode: 'H3_SUBMISSION_NOT_SENT', segments: [
      { status: 'saved', taskId: 'task-1', path: saved.path }, { status: 'failed', taskId: 'task-2' },
      { status: 'running', taskId: 'task-3' }, { status: 'pending' },
    ] })
    expect(f.output.join('')).toContain('分镜 1/4 已保存\n分镜 2/4 失败\n分镜 3/4 查询已暂停，保留原任务\n分镜 4/4 尚未提交')
    check.mockRestore()
    const resumedChecks = vi.spyOn(f.provider, 'check')
    expect(await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'PROVIDER_TASK_FAILED' })
    expect(resumedChecks.mock.calls.map(([id]) => id)).toEqual(['task-3'])
    expect(retained.segments.map(segment => segment.status)).toEqual(['saved', 'failed', 'saved', 'pending'])
    expect(await readFile(saved.path, 'utf8')).toBe('4')
    expect(submit).not.toHaveBeenCalled()
    expect(f.submitted).toBe(3)
    expect(compose).not.toHaveBeenCalled()
  })

  it('removes a confirmed unsent original task from the unsettled billing warning', async () => {
    const f = await setup([4])
    const manifest = await prepareVideoProject(f.options, { prompt: 'One retained H3 clip', totalDurationSeconds: 4 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const segment = manifest.segments[0]!
    segment.taskId = (await f.provider.submit(segment.request, f.signal)).taskId
    segment.status = 'running'
    await writeFile(join(f.options.stateDirectory, manifest.id, 'manifest.json'), JSON.stringify(manifest))
    const proof = h3SubmissionQueryRejection('MiniMax-H3', 200,
      { task_id: segment.taskId, status: 'UNKNOWN', submission_receipt: {
        ...notSentContract.receipt, id: segment.taskId, task_id: segment.taskId,
      } }, segment.taskId)
    if (proof === undefined) throw new Error('Expected the complete original H3 GET proof')
    const check = vi.spyOn(f.provider, 'check').mockRejectedValue(proof)
    const submit = vi.spyOn(f.provider, 'submit')
    const outcome = await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
    expect(outcome).toMatchObject({ status: 'failed', detail: 'H3_SUBMISSION_NOT_SENT' })
    expect(outcome.result).not.toContain('可能继续运行并计费')
    expect(manifest.segments[0]).toMatchObject({ status: 'failed', taskId: 'task-1' })
    expect(check).toHaveBeenCalledOnce()
    expect(submit).not.toHaveBeenCalled()
  })

  it('keeps an accepted peer when another generic task failure is its stop signal reason', async () => {
    const f = await setup([4])
    f.options.maxConcurrentSegments = 2
    f.provider.parallelism = async () => 2
    const manifest = await prepareVideoProject(f.options, { prompt: 'Three independently retained tasks', totalDurationSeconds: 12 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const peerObserved = Promise.withResolvers<undefined>()
    const cancelled = new AbortController()
    const check = vi.spyOn(f.provider, 'check').mockImplementation(async (id, _request, signal) => {
      if (id === 'task-1') { await peerObserved.promise; return { status: 'failed' } }
      if (id !== 'task-2') throw new Error('The pending third clip must not be submitted')
      peerObserved.resolve(undefined)
      await new Promise<never>((_resolve, reject) => {
        const aborted = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('Peer observation stopped')) }
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      })
      return { status: 'succeeded' }
    })
    const running = ownConcurrentRun(runVideoProject(f.options, manifest, f.provider, f.editor, f.job, cancelled.signal), () => {
      cancelled.abort(); peerObserved.resolve(undefined)
    })
    expect(await running).toMatchObject({ status: 'failed', detail: 'PROVIDER_TASK_FAILED' })
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments).toMatchObject([
      { status: 'failed', taskId: 'task-1' }, { status: 'running', taskId: 'task-2' }, { status: 'pending' },
    ])
    expect(f.output.join('')).toContain('分镜 1/3 失败\n分镜 2/3 查询已暂停，保留原任务\n分镜 3/3 尚未提交')
    check.mockRestore()
    const resumedChecks = vi.spyOn(f.provider, 'check')
    expect(await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'PROVIDER_TASK_FAILED' })
    expect(resumedChecks.mock.calls.map(([id]) => id)).toEqual(['task-2'])
    expect(retained.segments.map(segment => segment.status)).toEqual(['failed', 'saved', 'pending'])
    expect(f.submitted).toBe(2)
    expect(f.events).not.toContain('compose')
  })

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

// The fixture's 5s clip deadline and late-receipt drain must precede the test deadline.
describe('bounded parallel video generation', { timeout: 15_000 }, () => {
  it('retains confirmed upstream completion when local saving fails and resumes the original task without another submission', async () => {
    const f = await setup([4])
    const manifest = await prepareVideoProject(f.options, { prompt: '已生成但保存中断的单段', totalDurationSeconds: 4 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const download = vi.spyOn(f.provider, 'download').mockRejectedValueOnce(new Error('private disk diagnostic'))
    const check = vi.spyOn(f.provider, 'check')
    expect((await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).status).toBe('failed')
    expect(f.events).toContain('视频项目：项目未完成 · 已保存 0/1 段\n分镜 1/1 上游已完成，保存未完成')
    expect(f.output.join('')).not.toContain('private disk diagnostic')
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments[0]).toMatchObject({ status: 'running', taskId: 'task-1' })
    expect((await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    expect(f.submitted).toBe(1)
    expect(download).toHaveBeenCalledTimes(2)
    expect(check.mock.calls.map(([id]) => id)).toEqual(['task-1', 'task-1'])
  })

  it('keeps every clip visible through independent queue, generation, saving, editing and terminal updates', async () => {
    const f = await setup([4])
    f.options.maxConcurrentSegments = 2
    f.provider.parallelism = async () => 2
    const manifest = await prepareVideoProject(f.options, { prompt: '四个有独立状态的镜头', totalDurationSeconds: 16 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const states = new Map<string, 'queued' | 'running' | 'succeeded'>([
      ['task-1', 'queued'], ['task-2', 'running'], ['task-3', 'queued'],
    ])
    vi.spyOn(f.provider, 'check').mockImplementation(async id => ({ status: states.get(id) ?? 'succeeded' }))
    const saving = Promise.withResolvers<undefined>()
    const releaseSave = Promise.withResolvers<undefined>()
    const download = f.provider.download.bind(f.provider)
    vi.spyOn(f.provider, 'download').mockImplementation(async (...args) => {
      if (args[0] === 'task-1') { saving.resolve(undefined); await releaseSave.promise }
      await download(...args)
    })
    const editing = Promise.withResolvers<undefined>()
    const releaseEdit = Promise.withResolvers<undefined>()
    const compose = f.editor.compose.bind(f.editor)
    vi.spyOn(f.editor, 'compose').mockImplementation(async (request) => {
      request.onProgress?.({ stage: 'normalizing', completedClips: 0, totalClips: 4 })
      editing.resolve(undefined)
      await releaseEdit.promise
      return await compose(request)
    })
    let now = 1000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const latest = () => f.events.filter(value => value.startsWith('视频项目：')).at(-1)
    const release = (): void => { states.clear(); releaseSave.resolve(undefined); releaseEdit.resolve(undefined) }
    const running = ownConcurrentRun(runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal), release)
    try {
      await vi.waitFor(() => { expect(latest()).toContain('分镜 2/4 生成中，已等待 0 秒') })
      expect(latest()).toBe([
        '视频项目：生成分镜 · 已保存 0/4 段',
        '分镜 1/4 排队中，已等待 0 秒', '分镜 2/4 生成中，已等待 0 秒', '分镜 3/4 尚未提交', '分镜 4/4 尚未提交',
      ].join('\n'))
      now = 6000
      await vi.waitFor(() => { expect(latest()).toContain('分镜 2/4 生成中，已等待 5 秒') })
      states.set('task-1', 'succeeded')
      await saving.promise
      expect(latest()).toContain('分镜 1/4 上游已完成，正在保存')
      expect(latest()).toContain('分镜 2/4 生成中，已等待 5 秒')
      expect(f.submitted).toBe(2)
      releaseSave.resolve(undefined)
      await vi.waitFor(() => { expect(latest()).toContain('分镜 3/4 排队中，已等待 0 秒') })
      expect(latest()).toContain('已保存 1/4 段\n分镜 1/4 已保存')
      expect(latest()).toContain('分镜 2/4 生成中，已等待 5 秒')
      expect(latest()).toContain('分镜 4/4 尚未提交')
      states.clear()
      await editing.promise
      expect(latest()).toBe(['视频项目：整理片段 0/4 · 已保存 4/4 段',
        ...Array.from({ length: 4 }, (_, index) => `分镜 ${String(index + 1)}/4 已保存`)].join('\n'))
      releaseEdit.resolve(undefined)
      expect((await running).status).toBe('completed')
      const terminal = ['视频项目：视频已完成 · 已保存 4/4 段',
        ...Array.from({ length: 4 }, (_, index) => `分镜 ${String(index + 1)}/4 已保存`)].join('\n')
      expect(latest()).toBe(terminal)
      expect(f.output.filter(value => value.startsWith('视频项目：'))).toEqual([terminal + '\n'])
      expect(f.output.join('')).not.toContain('排队中')
      expect(f.submitted).toBe(4)
    } finally { release(); await running; clock.mockRestore() }
  })

  it.each([
    { grant: undefined, local: undefined, expected: 4 },
    { grant: 1, local: undefined, expected: 1 },
    { grant: 2, local: undefined, expected: 2 },
    { grant: 16, local: undefined, expected: 16 },
    { grant: 16, local: 4, expected: 4 },
    { grant: 16, local: 2, expected: 2 },
  ])('schedules $expected clips from pool $grant and explicit local ceiling $local', async ({ grant, local, expected }) => {
    const f = await setup([10])
    if (local === undefined) delete f.options.maxConcurrentSegments
    else f.options.maxConcurrentSegments = local
    if (grant !== undefined) f.provider.parallelism = async () => grant
    const manifest = await prepareVideoProject(f.options, { prompt: 'One explicitly planned work with sixteen clips', totalDurationSeconds: 160 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const release = Promise.withResolvers<undefined>()
    const checking = new Set<string>()
    let peak = 0
    vi.spyOn(f.provider, 'check').mockImplementation(async (id) => {
      checking.add(id)
      peak = Math.max(peak, checking.size)
      await release.promise
      checking.delete(id)
      return { status: 'succeeded' }
    })
    const running = ownConcurrentRun(runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal), () => {
      release.resolve(undefined)
    })
    try {
      await vi.waitFor(() => { expect(checking.size).toBe(expected) })
      expect(f.submitted).toBe(expected)
    } finally { release.resolve(undefined); await running }
    expect(peak).toBe(expected)
    expect(f.submitted).toBe(16)
  })

  it('runs independent 120-second clips concurrently within the local limit and composes timeline order', async () => {
    const f = await setup([15])
    f.options.maxConcurrentSegments = 4
    f.provider.parallelism = async () => 16
    const manifest = await prepareVideoProject(f.options, { prompt: '连续的八段故事', totalDurationSeconds: 120 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const gates = Array.from({ length: 8 }, () => Promise.withResolvers<undefined>())
    const checking = new Set<string>()
    let peak = 0
    vi.spyOn(f.provider, 'check').mockImplementation(async (id) => {
      checking.add(id)
      peak = Math.max(peak, checking.size)
      await gates[Number(id.slice(5)) - 1]!.promise
      checking.delete(id)
      return { status: 'succeeded' }
    })
    const compose = vi.spyOn(f.editor, 'compose')
    const running = ownConcurrentRun(runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal), () => {
      for (const gate of gates) gate.resolve(undefined)
    })
    try {
      await vi.waitFor(() => { expect(checking.size).toBe(4) })
      expect(f.submitted).toBe(4)
      gates[3]!.resolve(undefined)
      await vi.waitFor(() => { expect(f.submitted).toBe(5) })
      gates[2]!.resolve(undefined)
      await vi.waitFor(() => { expect(f.submitted).toBe(6) })
      for (const gate of gates) gate.resolve(undefined)
      expect((await running).status).toBe('completed')
      expect(peak).toBe(4)
      expect(f.submitted).toBe(8)
      expect(compose).toHaveBeenCalledOnce()
      expect(compose.mock.calls[0]![0].clips.map(clip => basename(clip.path).slice(0, 8)))
        .toEqual(Array.from({ length: 8 }, (_, index) => `clip-${String(index + 1).padStart(3, '0')}`))
      const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
      expect(retained.segments.map(segment => segment.status)).toEqual(Array.from({ length: 8 }, () => 'saved'))
      expect(retained.segments.map(segment => segment.taskId)).toEqual(Array.from({ length: 8 }, (_, index) => `task-${String(index + 1)}`))
    } finally {
      for (const gate of gates) gate.resolve(undefined)
      await running
    }
  })

  it('keeps the project owned until a late peer submission settles after another submission becomes unknown', async () => {
    const f = await setup()
    f.options.maxConcurrentSegments = 2
    f.provider.parallelism = async () => 2
    const manifest = await f.prepare()
    const rejected = Promise.withResolvers<undefined>()
    const late = Promise.withResolvers<undefined>()
    const original = f.provider.submit.bind(f.provider)
    vi.spyOn(f.provider, 'submit').mockImplementation(async (...args) => {
      const task = await original(...args)
      if (task.taskId === 'task-1') { await rejected.promise; throw new Error('acceptance unknown') }
      await late.promise
      return task
    })
    const check = vi.spyOn(f.provider, 'check')
    const running = ownConcurrentRun(runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal), () => {
      rejected.resolve(undefined); late.resolve(undefined)
    })
    try {
      await vi.waitFor(() => { expect(f.submitted).toBe(2) })
      rejected.resolve(undefined)
      await vi.waitFor(() => { expect(manifest.segments[0]?.status).toBe('unknown') })
      expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal))
        .toMatchObject({ status: 'failed', detail: 'PROJECT_ALREADY_RUNNING' })
      late.resolve(undefined)
      expect(await running).toMatchObject({ status: 'failed', detail: 'SUBMISSION_UNKNOWN' })
      expect(f.submitted).toBe(2)
      expect(check).not.toHaveBeenCalled()
      const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
      expect(retained.segments.map(segment => segment.status)).toEqual(['unknown', 'running', 'pending'])
      expect(retained.segments[1]?.taskId).toBe('task-2')
      expect(f.output.join('')).toContain(['视频项目：项目未完成 · 已保存 0/3 段',
        '分镜 1/3 提交结果待确认，勿重新提交', '分镜 2/3 查询已暂停，保留原任务', '分镜 3/3 尚未提交'].join('\n'))
      expect((await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).detail).toBe('SUBMISSION_UNKNOWN')
      expect(f.submitted).toBe(2)
      expect(check).toHaveBeenCalledWith('task-2', expect.anything(), expect.anything())
      const recovered = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
      expect(recovered.segments.map(segment => segment.status)).toEqual(['unknown', 'saved', 'pending'])
    } finally { rejected.resolve(undefined); late.resolve(undefined); await running }
  })

  it('retains accepted and late task ids on cancellation, then resumes them without posting again', async () => {
    const f = await setup()
    f.options.maxConcurrentSegments = 2
    f.provider.parallelism = async () => 2
    const manifest = await f.prepare()
    const cancelled = new AbortController()
    const late = Promise.withResolvers<undefined>()
    const observed = Promise.withResolvers<undefined>()
    const original = f.provider.submit.bind(f.provider)
    const submit = vi.spyOn(f.provider, 'submit').mockImplementation(async (...args) => {
      const task = await original(...args)
      if (task.taskId === 'task-2') await late.promise
      return task
    })
    const check = vi.spyOn(f.provider, 'check').mockImplementation(async (_id, _request, signal) => {
      observed.resolve(undefined)
      await new Promise<never>((_resolve, reject) => {
        const abort = (): void => { reject(new Error('observation stopped')) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      return { status: 'succeeded' }
    })
    const running = ownConcurrentRun(runVideoProject(f.options, manifest, f.provider, f.editor, f.job, cancelled.signal), () => {
      cancelled.abort(); late.resolve(undefined)
    })
    try {
      await observed.promise
      await vi.waitFor(() => { expect(f.submitted).toBe(2) })
      cancelled.abort()
      expect((await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).detail).toBe('PROJECT_ALREADY_RUNNING')
      late.resolve(undefined)
      expect((await running).status).toBe('killed')
      const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
      expect(retained.segments.map(segment => segment.status)).toEqual(['running', 'running', 'pending'])
      expect(retained.segments.slice(0, 2).map(segment => segment.taskId)).toEqual(['task-1', 'task-2'])
      expect(f.output.join('')).toContain(['视频项目：项目已停止 · 已保存 0/3 段',
        '分镜 1/3 查询已暂停，保留原任务', '分镜 2/3 查询已暂停，保留原任务', '分镜 3/3 尚未提交'].join('\n'))
      check.mockRestore()
      submit.mockRestore()
      expect((await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
      expect(f.submitted).toBe(3)
    } finally { cancelled.abort(); late.resolve(undefined); await running; check.mockRestore(); submit.mockRestore() }
  })

  it('serializes complete manifest writes while parallel receipts arrive', async () => {
    const f = await setup()
    f.options.maxConcurrentSegments = 2
    f.provider.parallelism = async () => 2
    const manifest = await f.prepare()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let held = false, active = 0, peak = 0
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      if (typeof args[0] !== 'string' || !args[0].startsWith(join(f.options.stateDirectory, manifest.id, '.manifest-'))) {
        await actual.writeFile(...args)
        return
      }
      active += 1
      peak = Math.max(peak, active)
      try {
        if (!held && typeof args[1] === 'string' && args[1].includes('"taskId"')) {
          held = true
          entered.resolve(undefined)
          await release.promise
        }
        await actual.writeFile(...args)
      } finally { active -= 1 }
    })
    const running = ownConcurrentRun(runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal), () => {
      release.resolve(undefined)
    })
    try {
      await entered.promise
      await vi.waitFor(() => { expect(f.submitted).toBe(2) })
      expect(peak).toBe(1)
      release.resolve(undefined)
      expect((await running).status).toBe('completed')
      expect(peak).toBe(1)
      const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
      expect(retained.segments.map(segment => segment.taskId)).toEqual(['task-1', 'task-2', 'task-3'])
      expect(retained.segments.every(segment => segment.status === 'saved')).toBe(true)
    } finally { release.resolve(undefined); await running; vi.mocked(writeFile).mockImplementation(actual.writeFile) }
  })

  it.each(['failed', 'unknown'] as const)('recovers accepted peers beside a %s clip without submitting pending clips', async (status) => {
    const f = await setup()
    f.options.maxConcurrentSegments = 2
    f.provider.parallelism = async () => 2
    const manifest = await f.prepare()
    const first = manifest.segments[0]!, second = manifest.segments[1]!
    await f.provider.submit(first.request, f.signal)
    const accepted = await f.provider.submit(second.request, f.signal)
    first.status = status
    second.status = 'running'
    second.taskId = accepted.taskId
    manifest.status = 'failed'
    await writeFile(join(f.options.stateDirectory, manifest.id, 'manifest.json'), JSON.stringify(manifest))
    const check = vi.spyOn(f.provider, 'check')
    const compose = vi.spyOn(f.editor, 'compose')
    const result = await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
    expect(result.detail).toBe(status === 'unknown' ? 'SUBMISSION_UNKNOWN' : 'PROVIDER_TASK_FAILED')
    expect(check).toHaveBeenCalledOnce()
    expect(check.mock.calls[0]?.[0]).toBe('task-2')
    expect(f.submitted).toBe(2)
    expect(compose).not.toHaveBeenCalled()
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments.map(segment => segment.status)).toEqual([status, 'saved', 'pending'])
    expect(retained.segments[1]?.publishedPath).toBeDefined()
    expect(f.output.join('')).toContain(`分镜 1/3 ${status === 'failed' ? '失败' : '提交结果待确认，勿重新提交'}\n分镜 2/3 已保存\n分镜 3/3 尚未提交`)
    await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)
    expect(f.submitted).toBe(2)
  })

  it('stops every queued dispatch when the first submitting record cannot be saved', async () => {
    const f = await setup()
    f.options.maxConcurrentSegments = 2
    f.provider.parallelism = async () => 2
    const manifest = await f.prepare()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let failed = false
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      if (!failed && typeof args[0] === 'string' && args[0].startsWith(join(f.options.stateDirectory, manifest.id, '.manifest-'))
        && typeof args[1] === 'string' && args[1].includes('"status":"submitting"')) {
        failed = true
        throw new Error('controlled manifest storage failure')
      }
      await actual.writeFile(...args)
    })
    try {
      expect((await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).status).toBe('failed')
      expect(failed).toBe(true)
      expect(f.submitted).toBe(0)
      const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
      expect(retained.segments.map(segment => segment.status)).toEqual(['pending', 'pending', 'pending'])
    } finally { vi.mocked(writeFile).mockImplementation(actual.writeFile) }
  })

  it('reports every accepted task id when receipt storage fails and blocks later resubmission', async () => {
    const f = await setup()
    f.options.maxConcurrentSegments = 2
    f.provider.parallelism = async () => 2
    const manifest = await f.prepare()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const accepted = Promise.withResolvers<undefined>()
    const original = f.provider.submit.bind(f.provider)
    vi.spyOn(f.provider, 'submit').mockImplementation(async (...args) => {
      const task = await original(...args)
      if (f.submitted === 2) accepted.resolve(undefined)
      await accepted.promise
      return task
    })
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith(join(f.options.stateDirectory, manifest.id, '.manifest-'))
        && typeof args[1] === 'string' && args[1].includes('"taskId"')) {
        throw Object.assign(new Error('controlled receipt storage failure'), { code: 'ENOSPC' })
      }
      await actual.writeFile(...args)
    })
    const running = ownConcurrentRun(runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal), () => {
      accepted.resolve(undefined)
    })
    try {
      const outcome = await running
      expect(outcome).toMatchObject({ status: 'failed', detail: 'PROJECT_STORAGE_FAILED' })
      expect(JSON.parse(outcome.result ?? '')).toMatchObject({ task_ids: ['task-1', 'task-2'] })
      expect(f.submitted).toBe(2)
      const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
      expect(retained.segments.map(segment => segment.status)).toEqual(['submitting', 'submitting', 'pending'])
      expect((await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).detail).toBe('SUBMISSION_UNKNOWN')
      expect(f.submitted).toBe(2)
    } finally { accepted.resolve(undefined); await running; vi.mocked(writeFile).mockImplementation(actual.writeFile) }
  })
})

describe('explicit timeline execution', () => {
  it('retains original queue coordinates and funding reason when submit recovery is still unknown', async () => {
    const f = await setup()
    const manifest = await f.prepare()
    const taskId = 'vq_11111111-1111-4111-8111-111111111111'
    const submit = vi.spyOn(f.provider, 'submit').mockRejectedValue(new VideoRelayError('INSUFFICIENT_BALANCE',
      '余额不足，请充值；原排队回执尚未确认，不要重新生成。', { taskId }))
    const outcome = await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
    expect(outcome).toMatchObject({ status: 'failed', detail: 'INSUFFICIENT_BALANCE' })
    expect(JSON.parse(outcome.result ?? '')).toMatchObject({ code: 'INSUFFICIENT_BALANCE', task_ids: [taskId] })
    expect(outcome.result).toContain('余额不足，请充值')
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments[0]).toMatchObject({ status: 'unknown', taskId })
    expect(submit).toHaveBeenCalledOnce()
  })

  it('publishes the safe original-task funding failure in durable state and background output', async () => {
    const f = await setup()
    const manifest = await f.prepare()
    vi.spyOn(f.provider, 'check').mockResolvedValue({ status: 'failed', code: 'INSUFFICIENT_BALANCE', message: '余额不足，请充值' })
    const outcome = await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
    expect(outcome).toMatchObject({ status: 'failed', detail: 'INSUFFICIENT_BALANCE' })
    expect(JSON.parse(outcome.result ?? '')).toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    expect(outcome.result).toContain('余额不足，请充值')
    expect(f.output.join('')).toContain('余额不足，请充值')
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained).toMatchObject({ failureCode: 'INSUFFICIENT_BALANCE' })
    expect(retained.segments[0]?.status).toBe('failed')
    expect(f.submitted).toBe(1)
  })

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
      videos: [...input.referenceVideos ?? []], audios: [...input.referenceAudios ?? []],
    }))
    const input: VideoProjectInput = {
      prompt: '保留时间轴与人物身份', totalDurationSeconds: 20, shotPrompts: ['第一镜头', '第二镜头', '第三镜头'],
      shotDurations: [5, 10, 5], referenceImages: ['ma_shared'],
      shotReferenceImages: [['ma_actor_a', 'ma_shared'], ['ma_actor_b'], []],
      referenceVideos: ['ma_shared_video'], referenceAudios: ['ma_shared_audio'],
      shotReferenceVideos: [['ma_video_a'], ['ma_video_b'], []],
      shotReferenceAudios: [['ma_audio_a'], ['ma_audio_b', 'ma_shared_audio'], []],
    }
    const manifest = await prepareVideoProject(fixture.options, input, 'chat-one', fixture.workspace, fixture.provider, fixture.editor, fixture.signal)
    expect(manifest.segments.map(segment => segment.durationSeconds)).toEqual([5, 10, 5])
    expect(manifest.segments.map(segment => segment.request.references)).toEqual([
      ['ma_shared', 'ma_actor_a'], ['ma_shared', 'ma_actor_b'], ['ma_shared'],
    ])
    expect(manifest.segments.map(segment => segment.request.videos)).toEqual([
      ['ma_shared_video', 'ma_video_a'], ['ma_shared_video', 'ma_video_b'], ['ma_shared_video'],
    ])
    expect(manifest.segments.map(segment => segment.request.audios)).toEqual([
      ['ma_shared_audio', 'ma_audio_a'], ['ma_shared_audio', 'ma_audio_b'], ['ma_shared_audio'],
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
    { shotDurations: [10, 10], shotReferenceVideos: [[]], code: 'SHOT_COUNT_MISMATCH' },
    { shotDurations: [10, 10], shotReferenceAudios: [[]], code: 'SHOT_COUNT_MISMATCH' },
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
    { shotReferenceVideos: [['ma_first']] }, { shotReferenceVideos: [['ma_first'], [42], []] },
    { shotReferenceAudios: [['ma_first']] }, { shotReferenceAudios: [['ma_first'], [42], []] },
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
    const publish = vi.fn(async (request: {
      destination: { directory: string }
      sourcePath: string
      filename: string
      videoRole?: 'final' | 'shot'
    }) => {
      expect(request.destination.directory).toBe(original)
      if (publicationFails && request.videoRole === 'final') throw new Error('disk unavailable')
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
    expect(basename(resumed.composedPath!)).toMatch(/^拍一个茶杯广告-成片-[a-f0-9-]{36}\.mp4$/u)
    const retainedComposition = resumed.composedPath
    const retainedClips = resumed.segments.map(segment => segment.publishedPath)
    expect(await readFile(resumed.composedPath!, 'utf8')).toBe('40')
    publicationFails = false
    const succeeded = await runVideoProject(fixture.options, resumed, fixture.provider, fixture.editor, fixture.job, fixture.signal)
    expect(succeeded.status).toBe('completed')
    expect(JSON.parse(succeeded.result ?? '{}')).toMatchObject({ final_path: resumed.finalPath })
    expect(resumed.finalPath?.startsWith(original)).toBe(true)
    expect(await readFile(resumed.finalPath!, 'utf8')).toBe('40')
    expect(await readFile(resumed.composedPath!, 'utf8')).toBe('40')
    expect(resumed.composedPath).toBe(retainedComposition)
    expect(resumed.segments.map(segment => segment.publishedPath)).toEqual(retainedClips)
    expect(fixture.submitted).toBe(3)
    expect(fixture.events.filter(event => event === 'compose')).toHaveLength(1)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(5)
    expect(publish.mock.calls.map(([request]) => request.videoRole)).toEqual(['shot', 'shot', 'shot', 'final', 'final'])
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
        if (request.videoRole === 'final') {
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
    expect(model).toHaveBeenCalledWith(undefined, fixture.signal, '2K', undefined, undefined, undefined, undefined)
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

  it('reports accepted queue and generation waits separately without submitting another clip early', async () => {
    const f = await setup()
    const manifest = await f.prepare()
    let firstTaskPolls = 0
    const check = vi.spyOn(f.provider, 'check').mockImplementation(async (taskId) => {
      if (taskId !== 'task-1') return { status: 'succeeded' }
      expect(f.submitted).toBe(1)
      firstTaskPolls += 1
      return { status: firstTaskPolls === 1 ? 'queued' : firstTaskPolls === 2 ? 'running' : 'succeeded' }
    })
    const outcome = await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
    expect(outcome.status).toBe('completed')
    expect(f.events).toEqual(expect.arrayContaining([
      expect.stringMatching(/\n分镜 1\/3 排队中，已等待 \d+ 秒(?:\n|$)/u),
      expect.stringMatching(/\n分镜 1\/3 生成中，已等待 \d+ 秒(?:\n|$)/u),
    ]))
    expect(check).toHaveBeenCalledTimes(5)
    expect(f.submitted).toBe(3)
  })

  it.each(['unknown', 'submitting'] as const)('recovers two original %s task IDs after their model is retired without new-work discovery', async (status) => {
    const f = await setup([4])
    const manifest = await prepareVideoProject(f.options, { prompt: 'two original accepted clips', totalDurationSeconds: 8 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    for (const segment of manifest.segments) { segment.status = status; segment.taskId = `old-task-${String(segment.index)}` }
    const path = join(f.options.stateDirectory, manifest.id, 'manifest.json')
    await writeFile(path, JSON.stringify(manifest))
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    const prepareSubmissions = vi.fn(async () => { throw new Error('New capability must not be read during original-ID recovery') })
    const parallelism = vi.fn(async () => { throw new Error('Retired model catalog must not block original-ID GET') })
    const model = vi.fn(async () => { throw new Error('Retired model unavailable for new work') })
    const check = vi.fn<VideoProjectProvider['check']>(async () => ({ status: 'succeeded' }))
    const submit = vi.fn(async () => { throw new Error('Original IDs cannot be submitted again') })
    const recovered: VideoProjectProvider = { ...f.provider, prepareSubmissions, parallelism, model, check, submit,
      get submissionMode(): 'queued' { throw new Error('Pure original-ID recovery does not choose a submission transport') },
      async download(_taskId, _request, destination) { await writeFile(destination, '4') },
    }
    expect(await runVideoProject(f.options, retained, recovered, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
    expect(check.mock.calls.map(([id]) => id).toSorted()).toEqual(['old-task-1', 'old-task-2'])
    expect(prepareSubmissions).not.toHaveBeenCalled()
    expect(parallelism).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(retained.segments.every(segment => segment.status === 'saved')).toBe(true)
  })

  it.each(['capability', 'model', 'parallelism'] as const)('recovers original tasks beside an unsent clip when new-work %s preflight fails', async (phase) => {
    const f = await setup([4])
    f.options.maxConcurrentSegments = 4
    const manifest = await prepareVideoProject(f.options, { prompt: 'two retained clips and one unsent clip', totalDurationSeconds: 12 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const originalPending = structuredClone(manifest.segments[2])
    for (const segment of manifest.segments.slice(0, 2)) { segment.status = 'running'; segment.taskId = `old-task-${String(segment.index)}` }
    await writeFile(join(f.options.stateDirectory, manifest.id, 'manifest.json'), JSON.stringify(manifest))
    const code = phase === 'capability' ? 'VIDEO_QUEUE_CAPABILITY_UNAVAILABLE' : 'VIDEO_MODEL_UNAVAILABLE'
    const fail = (): never => { throw new VideoRelayError(code, '新生成暂不可用，保留原任务继续查询。') }
    const model = vi.fn(async () => fail())
    const prepareSubmissions = vi.fn(async () => {
      if (phase === 'capability') fail()
      if (phase === 'model') await model()
    })
    const parallelism = vi.fn(async () => phase === 'parallelism' ? fail() : 4)
    const check = vi.fn<VideoProjectProvider['check']>(async () => ({ status: 'succeeded' }))
    const submit = vi.fn(async () => { throw new Error('New POST must remain blocked by preflight') })
    const recovered: VideoProjectProvider = { ...f.provider, prepareSubmissions, parallelism, model, check, submit,
      async download(_id, _request, destination) { await writeFile(destination, '4') },
    }
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, recovered.identity)
    expect(await runVideoProject(f.options, retained, recovered, f.editor, f.job, f.signal)).toMatchObject({ status: 'failed', detail: code })
    expect(check.mock.calls.map(([id]) => id).toSorted()).toEqual(['old-task-1', 'old-task-2'])
    expect(retained.segments.slice(0, 2).every(segment => segment.status === 'saved')).toBe(true)
    expect(retained.segments[2]).toEqual(originalPending)
    expect(submit).not.toHaveBeenCalled()
    expect(prepareSubmissions).toHaveBeenCalledOnce()
    expect(parallelism).toHaveBeenCalledTimes(phase === 'parallelism' ? 1 : 0)
    expect(model).toHaveBeenCalledTimes(phase === 'model' ? 1 : 0)
  })

  it('does not start a POST or invent an original task when new-work preflight fails with no retained IDs', async () => {
    const f = await setup([4])
    const manifest = await prepareVideoProject(f.options, { prompt: 'unsent clips only', totalDurationSeconds: 8 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const pending = structuredClone(manifest.segments)
    f.provider.prepareSubmissions = async () => { throw new VideoRelayError('VIDEO_QUEUE_CAPABILITY_UNAVAILABLE', '排队服务暂不可读取。') }
    const check = vi.spyOn(f.provider, 'check')
    const submit = vi.spyOn(f.provider, 'submit')
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'VIDEO_QUEUE_CAPABILITY_UNAVAILABLE' })
    expect(check).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
    expect(manifest.segments).toEqual(pending)
  })

  it('retains the original GET failure when mixed-project admission preflight also failed', async () => {
    const f = await setup([4])
    const manifest = await prepareVideoProject(f.options, { prompt: 'one retained and one unsent clip', totalDurationSeconds: 8 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const first = manifest.segments[0]
    if (first === undefined) throw new Error('Retained task required')
    first.status = 'running'; first.taskId = 'old-task-1'
    const pending = structuredClone(manifest.segments[1])
    await writeFile(join(f.options.stateDirectory, manifest.id, 'manifest.json'), JSON.stringify(manifest))
    f.provider.prepareSubmissions = async () => { throw new VideoRelayError('VIDEO_QUEUE_CAPABILITY_UNAVAILABLE', '新生成不可用。') }
    const check = vi.spyOn(f.provider, 'check').mockRejectedValue(new VideoRelayError('VIDEO_READ_UNAVAILABLE', '原任务暂不可读取。'))
    const submit = vi.spyOn(f.provider, 'submit')
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'VIDEO_TASK_OBSERVATION_UNAVAILABLE' })
    expect(check).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled()
    expect(manifest.segments[0]).toMatchObject({ status: 'running', taskId: 'old-task-1' })
    expect(manifest.segments[1]).toEqual(pending)
  })

  it('retains a definitively unsent local submission as pending without claiming unknown acceptance or billing', async () => {
    const f = await setup([4])
    const manifest = await prepareVideoProject(f.options, { prompt: 'local credentials unavailable before transport', totalDurationSeconds: 8 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const originalAttempts = manifest.segments.map(segment => segment.attemptId)
    const submit = vi.spyOn(f.provider, 'submit').mockRejectedValueOnce(new VideoRelayError('VIDEO_SUBMIT_NOT_STARTED',
      '提交前凭据尚未准备好，本次没有发送生成请求。'))
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'VIDEO_SUBMIT_NOT_STARTED' })
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments.map(segment => segment.status)).toEqual(['pending', 'pending'])
    expect(retained.segments.map(segment => segment.attemptId)).toEqual(originalAttempts)
    expect(retained.segments.every(segment => segment.taskId === undefined)).toBe(true)
    expect(f.output.join('')).not.toContain('可能继续运行并计费')
    expect(f.submitted).toBe(0)
    submit.mockRestore()
    expect(await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
    expect(retained.segments.map(segment => segment.attemptId)).toEqual(originalAttempts)
    expect(f.submitted).toBe(2)
  })

  it('saves a reconciled original unknown task without submitting previously blocked pending clips in that run', async () => {
    const f = await setup([4])
    const manifest = await prepareVideoProject(f.options, { prompt: 'one uncertain and one unsent clip', totalDurationSeconds: 8 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const first = manifest.segments[0]
    if (first === undefined) throw new Error('Original clip required')
    first.status = 'unknown'; first.taskId = 'original-accepted-task'
    await writeFile(join(f.options.stateDirectory, manifest.id, 'manifest.json'), JSON.stringify(manifest))
    f.provider.download = async (_id, _request, destination) => { await writeFile(destination, '4') }
    const submit = vi.spyOn(f.provider, 'submit')
    const prepare = vi.fn(async () => { throw new Error('No new submission may be prepared in this recovery') })
    f.provider.prepareSubmissions = prepare
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'VIDEO_PROJECT_RESUME_REQUIRED' })
    expect(retained.segments.map(segment => segment.status)).toEqual(['saved', 'pending'])
    expect(submit).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('recovers a lost queue ACK after a failed original GET and a disk reload with no second create POST', async () => {
    const f = await setup([4])
    let phase: 'unavailable' | 'complete' = 'unavailable'
    const requests: { path: string; method: string }[] = []
    const gateway = 'task_1234567890abcdefghijklmnopqrstuv'
    let queueId = ''
    let operationId = ''
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      const path = new URL(url).pathname
      const method = init?.method ?? 'GET'
      requests.push({ path, method })
      if (path === '/harness/api/status') {
        return new Response(JSON.stringify({ data: { video_queue: {
          schema_version: 1, enabled: true, create_path: '/v1/video/queue', retrieve_path_template: '/v1/video/queue/:queue_id',
          cancel_path_template: '/v1/video/queue/:queue_id/cancel', max_count_per_item: 1, body_max_bytes: 65_536,
          poll_interval_seconds: 15, client_generated_id: true, queued_charge_reserved: false, lost_ack_recovery_method: 'GET',
        } } }))
      }
      if (method === 'POST') throw new Error('ACK lost after the original queue was durably created')
      if (phase === 'unavailable') return new Response('temporary observation failure', { status: 503 })
      return new Response(JSON.stringify({ schema_version: 1, object: 'video_queue_item', accepted: true,
        data: { id: queueId, operation_id: operationId, model: 'example-video', count: 1, duration_seconds: 4,
          task_id: gateway, state: 'succeeded', submission_state: 'accepted', created_at: 1, updated_at: 2 },
        cancelable: false, observation_timed_out: false, recovery: { method: 'GET', path: `/v1/video/queue/${queueId}` } }))
    }
    const relay: VideoProjectRelay = {
      async modelIds() { throw new Error('Recovery must not read model catalog') },
      async submit() { throw new Error('No legacy fallback is allowed') },
      async check() { throw new Error('Only the original server queue can recover this attempt') },
      async download(taskId, destination) { expect(taskId).toBe(gateway); await writeFile(destination, '4') },
    }
    const provider = (): VideoProjectProvider => {
      const dispatch = createVideoProjectDispatch({ relay,
        queue: { origin: 'https://queue.example/harness', timeoutMs: 1000, key: async () => 'synthetic-relay', fetch },
        async route() { throw new Error('No new model routing is allowed after a queue POST') },
      })
      return { ...f.provider,
        get submissionMode() { return dispatch.submissionMode }, get pollIntervalMs() { return dispatch.pollIntervalMs },
        async build(_input, model, prompt, seconds) { return { model, prompt, seconds } },
        prepareSubmissions: (...args) => dispatch.prepareSubmissions(...args), submit: (...args) => dispatch.submit(...args),
        check: (...args) => dispatch.check(...args), download: (...args) => dispatch.download(...args),
      }
    }
    const initial = provider()
    const manifest = await prepareVideoProject(f.options, { prompt: 'one original queue operation', totalDurationSeconds: 4 },
      'chat-one', f.workspace, initial, f.editor, f.signal)
    const attempt = manifest.segments[0]?.attemptId
    if (attempt === undefined) throw new Error('Persisted attempt required before POST')
    operationId = attempt; queueId = `vq_${attempt}`
    expect(await runVideoProject(f.options, manifest, initial, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'SUBMISSION_UNKNOWN' })
    const original = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, initial.identity)
    expect(original.segments[0]).toMatchObject({ status: 'unknown', taskId: queueId, attemptId: attempt })
    expect(await runVideoProject(f.options, original, provider(), f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'VIDEO_TASK_OBSERVATION_UNAVAILABLE' })
    const restarted = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, initial.identity)
    phase = 'complete'
    expect(await runVideoProject(f.options, restarted, provider(), f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
    expect(requests.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: '/harness/v1/video/queue' }])
    expect(requests.filter(call => call.path === '/harness/api/status')).toHaveLength(1)
    expect(requests.filter(call => call.path === `/harness/v1/video/queue/${queueId}`)).toHaveLength(4)
    expect(restarted.segments[0]).toMatchObject({ status: 'saved', taskId: queueId, attemptId: attempt })
  })

  it('retries only transient original-task GETs and resets the finite budget after a successful observation', async () => {
    const f = await setup([4])
    f.options.queryRetryLimit = 1
    const manifest = await prepareVideoProject(f.options, { prompt: 'one original task', totalDurationSeconds: 4 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const stages: VideoProjectActivity[] = []
    f.options.activity = event => stages.push(event)
    const check = vi.spyOn(f.provider, 'check')
      .mockRejectedValueOnce(new VideoRelayError('VIDEO_READ_UNAVAILABLE', '网络暂不可用'))
      .mockResolvedValueOnce({ status: 'running' })
      .mockRejectedValueOnce(new VideoRelayError('VIDEO_READ_RETRYABLE', '任务查询暂不可用'))
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValueOnce({ status: 'succeeded' })
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
    expect(check.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 5 }, () => 'task-1'))
    expect(f.submitted).toBe(1)
    expect(stages.filter(event => event.shotId === '1').map(event => event.type === 'stage' ? event.stage : event.outcome))
      .toEqual(['preparing', 'submitting', 'accepted', 'unknown', 'generating', 'unknown', 'queued', 'saving', 'completed'])
    expect(f.events).toEqual(expect.arrayContaining([expect.stringContaining('状态查询暂不可用，正在重试原任务')]))
  })

  it('pauses an exhausted GET retry budget as pending and resumes only the original task ID', async () => {
    const f = await setup([4])
    f.options.queryRetryLimit = 2
    const observations: VideoProjectActivity[] = []
    f.options.activity = event => observations.push(event)
    const manifest = await prepareVideoProject(f.options, { prompt: 'retain the accepted task', totalDurationSeconds: 4 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const check = vi.spyOn(f.provider, 'check').mockRejectedValue(new VideoRelayError('VIDEO_READ_UNAVAILABLE', '网络暂不可用'))
    const observed = await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
    expect(observed).toMatchObject({ status: 'failed', detail: 'VIDEO_TASK_OBSERVATION_UNAVAILABLE' })
    expect(JSON.parse(observed.result ?? '{}')).toMatchObject({ status: 'pending', task_ids: ['task-1'] })
    expect(check).toHaveBeenCalledTimes(3)
    expect(observations.at(-1)).toMatchObject({ type: 'end', stage: 'unknown', outcome: 'unknown' })
    expect(observations.filter(event => event.type === 'end').every(event => event.outcome === 'unknown')).toBe(true)
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained).toMatchObject({ status: 'running', failureCode: 'VIDEO_TASK_OBSERVATION_UNAVAILABLE' })
    expect(retained.segments[0]).toMatchObject({ status: 'running', taskId: 'task-1' })
    expect(f.submitted).toBe(1)
    check.mockResolvedValue({ status: 'succeeded' })
    expect(await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
    expect(check.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 4 }, () => 'task-1'))
    expect(f.submitted).toBe(1)
  })

  it('does not retry authorization loss or an unverified original-task state', async () => {
    const f = await setup([4])
    f.options.queryRetryLimit = 2
    const manifest = await prepareVideoProject(f.options, { prompt: 'retain uncertain state', totalDurationSeconds: 4 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const check = vi.spyOn(f.provider, 'check').mockRejectedValue(new VideoRelayError('VIDEO_STATUS_INVALID', '任务状态尚未核实'))
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'VIDEO_STATUS_INVALID' })
    expect(check).toHaveBeenCalledOnce()
    expect(manifest.segments[0]).toMatchObject({ status: 'running', taskId: 'task-1' })
    f.currentAccount = false
    expect(await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'ACCOUNT_CHANGED' })
    expect(check).toHaveBeenCalledOnce()
    expect(f.submitted).toBe(1)
  })

  it('admits every authorized clip durably before observing an opt-in server queue', async () => {
    const f = await setup([15])
    f.options.maxConcurrentSegments = 4
    const metadata: VideoProjectSubmission[] = []
    let project = ''
    const provider: VideoProjectProvider = { ...f.provider, submissionMode: 'queued',
      async submit(request, signal, submission) {
        if (submission === undefined) throw new Error('Durable clip metadata required')
        metadata.push(submission)
        const stored = await readVideoProject(f.options, project, 'chat-one', f.workspace, f.provider.identity)
        expect(stored.segments.some(segment => segment.status === 'submitting' && segment.attemptId === submission.attemptId)).toBe(true)
        return f.provider.submit(request, signal, submission)
      },
      async check(taskId) {
        const stored = await readVideoProject(f.options, project, 'chat-one', f.workspace, f.provider.identity)
        expect(f.submitted).toBe(8)
        expect(stored.segments.every(segment => segment.taskId !== undefined)).toBe(true)
        expect(stored.segments.flatMap(segment => segment.taskId ?? [])).toContain(taskId)
        return { status: 'succeeded' }
      },
    }
    const manifest = await prepareVideoProject(f.options, { prompt: 'eight queued clips', totalDurationSeconds: 120 },
      'chat-one', f.workspace, provider, f.editor, f.signal)
    project = manifest.id
    expect(await runVideoProject(f.options, manifest, provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
    expect(metadata.map(value => value.count)).toEqual(Array.from({ length: 8 }, () => 1))
    expect(metadata.map(value => value.durationSeconds)).toEqual(Array.from({ length: 8 }, () => 15))
    expect(new Set(metadata.map(value => value.attemptId))).toEqual(new Set(manifest.segments.map(segment => segment.attemptId)))
    expect(f.submitted).toBe(8)
  })

  it('retains all accepted server queue IDs through local cancellation and resumes without another POST', async () => {
    const f = await setup([15])
    f.options.maxConcurrentSegments = 4
    const stop = new AbortController()
    const querying = Promise.withResolvers<undefined>()
    const provider: VideoProjectProvider = { ...f.provider, submissionMode: 'queued',
      async check(_id, _request, signal) {
        querying.resolve(undefined)
        return new Promise((_resolve, reject) => {
          const cancelled = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('fixture cancelled')) }
          signal.addEventListener('abort', cancelled, { once: true })
          if (signal.aborted) cancelled()
        })
      },
    }
    const manifest = await prepareVideoProject(f.options, { prompt: 'eight accepted original tasks', totalDurationSeconds: 120 },
      'chat-one', f.workspace, provider, f.editor, f.signal)
    const running = ownConcurrentRun(runVideoProject(f.options, manifest, provider, f.editor, f.job, stop.signal), () => { stop.abort() })
    try {
      await querying.promise
      expect(f.submitted).toBe(8)
      stop.abort()
      expect(await running).toMatchObject({ status: 'killed' })
      const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, provider.identity)
      expect(retained.segments.every(segment => segment.status === 'running' && segment.taskId !== undefined)).toBe(true)
      const originalIds = retained.segments.map(segment => segment.taskId)
      const queries: string[] = []
      const resumed: VideoProjectProvider = { ...provider, async check(id) { queries.push(id); return { status: 'succeeded' } } }
      expect(await runVideoProject(f.options, retained, resumed, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
      expect(queries.toSorted()).toEqual(originalIds.toSorted())
      expect(f.submitted).toBe(8)
    } finally { stop.abort(); await running }
  })

  it('stops new server queue admissions after an uncertain POST and never automatically retries that clip', async () => {
    const f = await setup([15])
    f.options.maxConcurrentSegments = 1
    f.failSubmit = 2
    const provider: VideoProjectProvider = { ...f.provider, submissionMode: 'queued' }
    const check = vi.spyOn(provider, 'check')
    const manifest = await prepareVideoProject(f.options, { prompt: 'do not duplicate uncertain admission', totalDurationSeconds: 45 },
      'chat-one', f.workspace, provider, f.editor, f.signal)
    expect(await runVideoProject(f.options, manifest, provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'SUBMISSION_UNKNOWN' })
    expect(manifest.segments.map(segment => segment.status)).toEqual(['running', 'unknown', 'pending'])
    expect(check).not.toHaveBeenCalled()
    expect(f.submitted).toBe(2)
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, provider.identity)
    expect(await runVideoProject(f.options, retained, provider, f.editor, f.job, f.signal))
      .toMatchObject({ status: 'failed', detail: 'SUBMISSION_UNKNOWN' })
    expect(check.mock.calls.map(([id]) => id)).toEqual(['task-1'])
    expect(f.submitted).toBe(2)
  })

  it('keeps a thirty-minute accepted task in the background while a second independent project completes', async () => {
    const f = await setup([15])
    f.options.taskTimeoutMs = 15 * 60_000
    const first = await prepareVideoProject(f.options, { prompt: 'first long-running video', totalDurationSeconds: 15 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const second = await prepareVideoProject(f.options, { prompt: 'second independent video', totalDurationSeconds: 15 },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    const firstObserved = Promise.withResolvers<undefined>()
    const releaseFirst = Promise.withResolvers<undefined>()
    let minutes = 0
    const queries: string[] = []
    const timeoutControllers = new Set<AbortController>()
    vi.useFakeTimers({ toFake: ['performance', 'Date', 'setTimeout', 'clearTimeout'] })
    const timeouts = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      timeoutControllers.add(controller)
      setTimeout(() => { controller.abort(new DOMException('fixture request deadline', 'TimeoutError')) }, milliseconds)
      return controller.signal
    })
    const check = vi.spyOn(f.provider, 'check').mockImplementation(async (taskId, _request, signal) => {
      queries.push(taskId)
      if (taskId !== 'task-1') return { status: 'succeeded' }
      if (minutes === 0) { firstObserved.resolve(undefined); await releaseFirst.promise }
      vi.advanceTimersByTime(60_000)
      signal.throwIfAborted()
      minutes += 1
      return { status: minutes <= 30 ? 'running' : 'succeeded' }
    })
    const abort = new AbortController()
    const running = ownConcurrentRun(runVideoProject(f.options, first, f.provider, f.editor, f.job, abort.signal), () => {
      abort.abort(); releaseFirst.resolve(undefined)
    })
    try {
      await firstObserved.promise
      expect(f.submitted).toBe(1)
      expect(await runVideoProject(f.options, second, f.provider, f.editor, f.job, f.signal)).toMatchObject({ status: 'completed' })
      expect(f.submitted).toBe(2)
      releaseFirst.resolve(undefined)
      expect(await running).toMatchObject({ status: 'completed' })
      expect(minutes).toBe(31)
      expect(queries.filter(id => id === 'task-1')).toHaveLength(31)
      expect(f.submitted).toBe(2)
      expect(f.events).toEqual(expect.arrayContaining([expect.stringContaining('生成中，已等待 1800 秒')]))
      expect((await readVideoProject(f.options, first.id, 'chat-one', f.workspace, f.provider.identity)).segments[0])
        .toMatchObject({ status: 'saved', taskId: 'task-1' })
    } finally {
      abort.abort(); releaseFirst.resolve(undefined); await running
      for (const controller of timeoutControllers) controller.abort()
      timeouts.mockRestore(); check.mockRestore(); vi.useRealTimers()
    }
  })

  it('pauses a timed-out original-task GET without claiming a provider failure and resumes the retained id', async () => {
    const f = await setup()
    const report = vi.fn(() => { throw new Error('unavailable optional diagnostics') })
    f.options.failed = report
    const manifest = await f.prepare()
    const deadline = new AbortController()
    let observed: (() => void) | undefined
    const checking = new Promise<void>((resolve) => { observed = resolve })
    let polls = 0
    const check = vi.spyOn(f.provider, 'check').mockImplementation(async (_taskId, _request, signal) => {
      polls += 1
      if (polls === 1) return { status: 'queued' }
      observed?.()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new DOMException('fixture query cancelled', 'AbortError')) }, { once: true })
        if (signal.aborted) reject(new DOMException('fixture query cancelled', 'AbortError'))
      })
    })
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      const running = runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
      await checking
      deadline.abort(new DOMException('deadline', 'TimeoutError'))
      const outcome = await running
      expect(outcome).toMatchObject({ status: 'failed', detail: 'VIDEO_TASK_OBSERVATION_TIMEOUT' })
      expect(report).toHaveBeenCalledOnce()
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ id: manifest.id }), 'VIDEO_TASK_OBSERVATION_TIMEOUT')
      const result = JSON.parse(outcome.result ?? '') as { message: string; task_ids: string[] }
      expect(result.message).toContain('已暂停查询')
      expect(result.message).toContain('不要重新提交')
      expect(result.message).toContain('不代表生成失败')
      expect(result.task_ids).toEqual(['task-1'])
      expect(f.output.join('')).toContain(['视频项目：等待已暂停，保留原任务 · 已保存 0/3 段',
        '分镜 1/3 查询已暂停，保留原任务', '分镜 2/3 尚未提交', '分镜 3/3 尚未提交'].join('\n'))
      const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
      expect(retained.segments[0]).toMatchObject({ status: 'running', taskId: 'task-1' })
      expect(retained.segments.slice(1).map(segment => segment.status)).toEqual(['pending', 'pending'])
      expect(f.submitted).toBe(1)
      timer.mockRestore()
      check.mockRestore()
      const resumed = await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)
      expect(resumed.status).toBe('completed')
      expect(f.submitted).toBe(3)
    } finally { timer.mockRestore(); check.mockRestore() }
  })

  it('retains a throttled submission with no id as unknown without labelling it queued or retrying', async () => {
    const f = await setup()
    const manifest = await f.prepare()
    const submit = vi.spyOn(f.provider, 'submit').mockRejectedValue(new VideoRelayError('VIDEO_SUBMIT_BUSY', '视频服务繁忙，提交结果尚未确认，请先核对原任务，不要重新提交。'))
    const outcome = await runVideoProject(f.options, manifest, f.provider, f.editor, f.job, f.signal)
    expect(outcome).toMatchObject({ status: 'failed', detail: 'SUBMISSION_UNKNOWN' })
    expect(outcome.result).toContain('繁忙')
    expect(outcome.result).toContain('提交结果尚未确认')
    expect(outcome.result).not.toContain('排队中')
    const retained = await readVideoProject(f.options, manifest.id, 'chat-one', f.workspace, f.provider.identity)
    expect(retained.segments[0]).toMatchObject({ status: 'unknown' })
    expect(retained.segments[0]).not.toHaveProperty('taskId')
    await runVideoProject(f.options, retained, f.provider, f.editor, f.job, f.signal)
    expect(submit).toHaveBeenCalledOnce()
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
    for (const attemptId of ['', null, 'not-a-uuid', 123, manifest.segments[0]?.attemptId]) {
      await writeFile(path, JSON.stringify({ ...manifest, segments: manifest.segments.map(segment => ({ ...segment, attemptId })) }))
      await expect(readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity))
        .rejects.toMatchObject({ code: 'INVALID_RECORD' })
    }
    await writeFile(path, JSON.stringify(manifest))
    const damaged = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    damaged.segments = [{ index: 1, durationSeconds: 15, prompt: '杯子', request: null, status: 'pending' }]
    await writeFile(path, JSON.stringify(damaged))
    await expect(readVideoProject(fixture.options, manifest.id, 'chat-one', fixture.workspace, fixture.provider.identity)).rejects.toMatchObject({ code: 'INVALID_RECORD' })
  })
})

describe('retained complete paid video specifications', () => {
  it('plans two native mini clips, persists their quality/mode and resumes those exact requests', async () => {
    const f = await setup([5, 10])
    const [capability] = catalogFromPricing([{ model_name: 'example-video', kind: 'video', parameters: { oneOf: [
      { properties: { resolution: { const: '720p' }, quality: { const: 'mini' }, mode: { const: 'std' }, seconds: { const: 5 } } },
      { properties: { resolution: { const: '720p' }, quality: { const: 'fast' }, mode: { const: 'pro' }, seconds: { const: 10 } } },
    ] } }], null)
    if (capability === undefined) throw new Error('Expected published video specifications')
    const model = vi.spyOn(f.provider, 'model').mockImplementation(async (id, _signal, resolution, quality, mode) => ({
      id: id ?? capability.id,
      durations: videoSpecificationDurations(capability.params as VideoParams, {
        ...resolution === undefined ? {} : { resolution }, ...quality === undefined ? {} : { quality },
        ...mode === undefined ? {} : { mode },
      }),
    }))
    const build = vi.spyOn(f.provider, 'build').mockImplementation(async (input, id, prompt, durationSeconds) => ({
      model: id, prompt, durationSeconds,
      ...input.resolution === undefined ? {} : { resolution: input.resolution },
      ...input.quality === undefined ? {} : { quality: input.quality }, ...input.mode === undefined ? {} : { mode: input.mode },
    }))
    const mini: VideoProjectInput = { model: capability.id, prompt: '完整质量分镜测试', totalDurationSeconds: 10,
      resolution: '720p', quality: 'mini', mode: 'std' }
    const prepared = await prepareVideoProject(f.options, mini, 'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect(model).toHaveBeenCalledWith(capability.id, f.signal, '720p', 'mini', 'std', undefined, undefined)
    expect(prepared.segments.map(segment => segment.durationSeconds)).toEqual([5, 5])
    expect(build.mock.calls.map(call => ({ quality: call[0].quality, mode: call[0].mode, duration: call[3] })))
      .toEqual([{ quality: 'mini', mode: 'std', duration: 5 }, { quality: 'mini', mode: 'std', duration: 5 }])
    const restored = await readVideoProject(f.options, prepared.id, 'chat-one', f.workspace, f.provider.identity)
    expect(restored.input).toMatchObject({ quality: 'mini', mode: 'std', resolution: '720p' })
    expect(restored.segments.map(segment => segment.request)).toEqual(prepared.segments.map(segment => segment.request))
    const submit = vi.spyOn(f.provider, 'submit')
    expect((await runVideoProject(f.options, restored, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    expect(submit.mock.calls.map(call => call[0])).toEqual(restored.segments.map(segment => segment.request))
    expect(submit.mock.calls).toHaveLength(2)
    const completed = await readVideoProject(f.options, prepared.id, 'chat-one', f.workspace, f.provider.identity)
    expect(completed.input).toMatchObject({ quality: 'mini', mode: 'std' })
    expect((await runVideoProject(f.options, completed, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    expect(submit.mock.calls).toHaveLength(2)
    const fast = await prepareVideoProject(f.options, { ...mini, quality: 'fast', mode: 'pro' },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect(fast.segments.map(segment => segment.durationSeconds)).toEqual([10])
    expect(fast.segments[0]!.request).toMatchObject({ quality: 'fast', mode: 'pro', durationSeconds: 10 })
  })

  it('plans and recovers portrait clips using their exact size instead of another aspect ratio duration', async () => {
    const f = await setup([5, 10])
    const [capability] = catalogFromPricing([{ model_name: 'example-video', kind: 'video', parameters: { oneOf: [
      { properties: { resolution: { const: '720p' }, quality: { const: 'std' }, ratio: { const: '9:16' },
        size: { const: '720x1280' }, seconds: { const: 5 } } },
      { properties: { resolution: { const: '720p' }, quality: { const: 'std' }, ratio: { const: '16:9' },
        size: { const: '1280x720' }, seconds: { const: 10 } } },
      { properties: { resolution: { const: '720p' }, quality: { const: 'std' }, ratio: { const: '9:16' },
        size: { const: '1080x1920' }, seconds: { const: 10 } } },
    ] } }], null)
    if (capability === undefined) throw new Error('Expected complete video specifications')
    const model = vi.spyOn(f.provider, 'model').mockImplementation(async (id, _signal, resolution, quality, mode, ratio, size) => ({
      id: id ?? capability.id,
      durations: videoSpecificationDurations(capability.params as VideoParams, {
        ...resolution === undefined ? {} : { resolution }, ...quality === undefined ? {} : { quality },
        ...mode === undefined ? {} : { mode }, ...ratio === undefined ? {} : { ratio }, ...size === undefined ? {} : { size },
      }),
    }))
    vi.spyOn(f.provider, 'build').mockImplementation(async (input, id, prompt, durationSeconds) => ({
      model: id, prompt, durationSeconds,
      ...input.resolution === undefined ? {} : { resolution: input.resolution },
      ...input.quality === undefined ? {} : { quality: input.quality },
      ...input.ratio === undefined ? {} : { ratio: input.ratio }, ...input.size === undefined ? {} : { size: input.size },
    }))
    const input: VideoProjectInput = { model: capability.id, prompt: '竖屏规格测试', totalDurationSeconds: 10,
      resolution: '720p', quality: 'std', ratio: '9:16', size: '720x1280' }
    const prepared = await prepareVideoProject(f.options, input, 'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect(model).toHaveBeenCalledWith(capability.id, f.signal, '720p', 'std', undefined, '9:16', '720x1280')
    expect(prepared.segments.map(segment => segment.durationSeconds)).toEqual([5, 5])
    const restored = await readVideoProject(f.options, prepared.id, 'chat-one', f.workspace, f.provider.identity)
    expect(restored.input).toMatchObject({ resolution: '720p', quality: 'std', ratio: '9:16', size: '720x1280' })
    expect(restored.segments.map(segment => segment.request)).toEqual(prepared.segments.map(segment => segment.request))
    const submit = vi.spyOn(f.provider, 'submit')
    expect((await runVideoProject(f.options, restored, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    expect(submit.mock.calls.map(call => call[0])).toEqual(restored.segments.map(segment => segment.request))
    expect(f.submitted).toBe(2)
    const completed = await readVideoProject(f.options, prepared.id, 'chat-one', f.workspace, f.provider.identity)
    expect(completed.input).toMatchObject({ ratio: '9:16', size: '720x1280' })
    expect((await runVideoProject(f.options, completed, f.provider, f.editor, f.job, f.signal)).status).toBe('completed')
    expect(f.submitted).toBe(2)
    const largerPortrait = await prepareVideoProject(f.options, { ...input, size: '1080x1920' },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    expect(largerPortrait.segments.map(segment => segment.durationSeconds)).toEqual([10])
  })

  it('refuses malformed retained quality, mode or size before resuming any generation', async () => {
    const f = await setup([5])
    const prepared = await prepareVideoProject(f.options, { prompt: '保留参数', totalDurationSeconds: 5, quality: 'mini', mode: 'std' },
      'chat-one', f.workspace, f.provider, f.editor, f.signal)
    for (const changed of [{ quality: 42 }, { mode: false }, { size: 42 }]) {
      await writeFile(join(f.options.stateDirectory, prepared.id, 'manifest.json'), JSON.stringify({ ...prepared, input: { ...prepared.input, ...changed } }))
      await expect(readVideoProject(f.options, prepared.id, 'chat-one', f.workspace, f.provider.identity)).rejects.toMatchObject({ code: 'INVALID_RECORD' })
    }
    expect(f.submitted).toBe(0)
  })
})
