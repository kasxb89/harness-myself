/** A paid video submit is attempted once; every recovery is an original-task GET. */
import { describe, expect, it, vi } from 'vitest'
import { executeVideoTask, type VideoTaskOptions } from '../src/video-task.ts'
import type { CreativeVideoReceipt } from '../src/creative-types.ts'

const fingerprint = 'a'.repeat(64)
const accepted: CreativeVideoReceipt = { model: 'model_5', route: '/v1/videos', backendFingerprint: fingerprint, phase: 'accepted', taskId: 'public-task-1' }
const json = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), { status, ...headers === undefined ? {} : { headers } })

function fixture(overrides: Partial<VideoTaskOptions> = {}) {
  const receipts: CreativeVideoReceipt[] = []
  const submit = vi.fn(async () => json({ id: 'public-task-1' }, 200, { 'x-oneapi-request-id': 'gateway-request-1' }))
  const read = vi.fn(async () => json({ status: 'completed' }))
  const save = vi.fn(async () => '/private/artifacts/video.mp4')
  const options: VideoTaskOptions = {
    model: 'model_5', route: '/v1/videos', backendFingerprint: fingerprint, signal: new AbortController().signal,
    submitTimeoutMs: 180_000, taskTimeoutMs: 900_000, queryTimeoutMs: 1000, pollIntervalMs: 1, queryRetryLimit: 2,
    received: async (receipt) => { receipts.push(receipt) }, submit, read, save, ...overrides,
  }
  return { options, submit, read, save, receipts }
}

describe('single-submission video task receipts', () => {
  it('persists submitting and accepted facts before the first GET, then marks the saved result complete', async () => {
    const f = fixture()
    f.read.mockImplementation(async () => {
      expect(f.receipts.at(-1)).toMatchObject({ phase: 'accepted', taskId: 'public-task-1', requestId: 'gateway-request-1' })
      return json({ data: { task_status: 'SUCCESS', result_url: 'https://ignored.invalid/private.mp4' } })
    })
    const outcome = await executeVideoTask(f.options)
    expect(outcome).toMatchObject({ ok: true, submissionState: 'completed', taskId: 'public-task-1', requestId: 'gateway-request-1', path: '/private/artifacts/video.mp4' })
    expect(f.receipts.map(receipt => receipt.phase)).toEqual(['submitting', 'submitting', 'accepted', 'completed'])
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(f.save).toHaveBeenCalledWith('public-task-1', expect.any(AbortSignal))
  })

  it('retains acceptance across local cancellation and resumes with no second submission', async () => {
    const controller = new AbortController()
    const f = fixture({ signal: controller.signal })
    f.read.mockImplementation(async () => { controller.abort(); return json({ status: 'running' }) })
    const stopped = await executeVideoTask(f.options)
    expect(stopped).toMatchObject({ ok: false, submissionState: 'pending', code: 'VIDEO_WAIT_STOPPED', taskId: 'public-task-1', videoReceipt: { phase: 'accepted' } })
    if (stopped.videoReceipt === undefined) throw new Error('Expected the original retained video receipt')
    const resumed = fixture({ resumeReceipt: stopped.videoReceipt })
    expect(await executeVideoTask(resumed.options)).toMatchObject({ ok: true, taskId: 'public-task-1' })
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(resumed.read).toHaveBeenCalledTimes(1)
  })

  it('never repeats a disconnected submission, including recovery with an unknown receipt', async () => {
    const f = fixture({ submit: vi.fn(async () => { throw new Error('connection closed') }) })
    const unknown = await executeVideoTask(f.options)
    expect(unknown).toMatchObject({ ok: false, submissionState: 'unknown', videoReceipt: { phase: 'submitting' } })
    expect(f.read).not.toHaveBeenCalled()
    if (unknown.videoReceipt === undefined) throw new Error('Expected the original retained video receipt')
    const resumed = fixture({ resumeReceipt: unknown.videoReceipt })
    expect(await executeVideoTask(resumed.options)).toMatchObject({ submissionState: 'unknown', code: 'VIDEO_SUBMISSION_UNKNOWN' })
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(resumed.read).not.toHaveBeenCalled()
  })

  it('does not poll until acceptance persistence succeeds and returns that receipt for final settlement', async () => {
    const f = fixture({ received: async (receipt) => { if (receipt.taskId !== undefined) throw new Error('disk interrupted') } })
    expect(await executeVideoTask(f.options)).toMatchObject({ submissionState: 'pending', taskId: 'public-task-1', videoReceipt: { phase: 'accepted' } })
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.read).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })

  it('keeps a completed remote task queryable after local saving fails', async () => {
    const f = fixture({ save: vi.fn(async () => { throw new Error('disk unavailable') }) })
    const pending = await executeVideoTask(f.options)
    expect(pending).toMatchObject({ submissionState: 'pending', taskId: 'public-task-1' })
    if (pending.videoReceipt === undefined) throw new Error('Expected the original retained video receipt')
    const resumed = fixture({ resumeReceipt: pending.videoReceipt })
    expect(await executeVideoTask(resumed.options)).toMatchObject({ ok: true })
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(resumed.save).toHaveBeenCalledTimes(1)
  })

  it('refuses a changed backend without reading or dispatching any request', async () => {
    const f = fixture({ resumeReceipt: accepted, backendFingerprint: 'b'.repeat(64) })
    expect(await executeVideoTask(f.options)).toMatchObject({ submissionState: 'pending', code: 'VIDEO_BACKEND_CHANGED' })
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })

  it.each(['SUCCESS', 'succeeded', 'completed', 'succeed'])('saves confirmed %s results through the fixed task identity', async (state) => {
    const f = fixture({ resumeReceipt: accepted, read: vi.fn(async () => json({ status: state })) })
    expect(await executeVideoTask(f.options)).toMatchObject({ ok: true })
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.save).toHaveBeenCalledWith('public-task-1', expect.any(AbortSignal))
  })

  it.each([json({ status: 'unexpected', secret: 'private' }), json({ error: 'private' }, 403)])('preserves an accepted task when a GET cannot establish its outcome', async (response) => {
    const f = fixture({ resumeReceipt: accepted, read: vi.fn(async () => response) })
    const result = await executeVideoTask(f.options)
    expect(result).toMatchObject({ ok: false, submissionState: 'pending', taskId: 'public-task-1' })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('preserves uncertainty when the gateway funding rejection may occur after acceptance', async () => {
    const f = fixture({ submit: vi.fn(async () => json({ error: { code: 'insufficient_user_quota', type: 'new_api_error' } }, 403)) })
    expect(await executeVideoTask(f.options)).toMatchObject({ ok: false, submissionState: 'unknown', code: 'INSUFFICIENT_BALANCE' })
    expect(f.read).not.toHaveBeenCalled()
  })
})

const retainedVideo: CreativeVideoReceipt = { route: '/v1/videos', model: 'video-model', phase: 'accepted',
  taskId: 'original-video', backendFingerprint: 'a'.repeat(64) }
const recoveryJson = (body: unknown, status = 200) => Response.json(body, { status })
function recoveryOptions(change: Partial<VideoTaskOptions> = {}): VideoTaskOptions {
  return { model: retainedVideo.model, route: retainedVideo.route, backendFingerprint: retainedVideo.backendFingerprint,
    signal: new AbortController().signal, submitTimeoutMs: 1000, taskTimeoutMs: 1000,
    queryTimeoutMs: 100, pollIntervalMs: 1, queryRetryLimit: 1,
    submit: vi.fn(async () => recoveryJson({ task_id: retainedVideo.taskId, status: 'queued' }, 202)),
    read: vi.fn(async () => recoveryJson({ status: 'succeeded', task_result: { videos: [{ url: 'https://media.invalid/original.mp4' }] } })),
    save: vi.fn(async () => '/artifacts/original.mp4'), received: vi.fn(async () => {}), ...change }
}

describe('single video submission and original-task recovery', () => {
  it('keeps every nonterminal provider status pending and saves the actual completed task once', async () => {
    const read = vi.fn<VideoTaskOptions['read']>()
    for (const status of ['pending', 'queued', 'processing', 'running']) read.mockResolvedValueOnce(recoveryJson({ data: { task_status: status } }))
    read.mockResolvedValueOnce(recoveryJson({ data: { task_status: 'succeeded', task_result: { videos: [{ url: 'https://media.invalid/original.mp4' }] } } }))
    const run = recoveryOptions({ read })
    expect(await executeVideoTask(run)).toMatchObject({ ok: true, submissionState: 'completed', taskId: retainedVideo.taskId,
      path: '/artifacts/original.mp4', videoReceipt: { phase: 'completed' } })
    expect(run.submit).toHaveBeenCalledOnce()
    expect(run.save).toHaveBeenCalledOnce()
    expect(run.save).toHaveBeenCalledWith(retainedVideo.taskId, expect.any(AbortSignal))
  })

  it('retains the accepted task through transient query errors and recovers only by GET', async () => {
    const first = recoveryOptions({ queryRetryLimit: 0, read: vi.fn(async () => { throw new Error('temporary network failure') }) })
    const pending = await executeVideoTask(first)
    expect(pending).toMatchObject({ ok: false, submissionState: 'pending', code: 'VIDEO_QUERY_UNAVAILABLE',
      taskId: retainedVideo.taskId, videoReceipt: { phase: 'accepted' } })
    if (pending.videoReceipt === undefined) throw new Error('Expected the accepted video task receipt before recovery')
    const resumed = recoveryOptions({ resumeReceipt: pending.videoReceipt })
    expect(await executeVideoTask(resumed)).toMatchObject({ ok: true, taskId: retainedVideo.taskId })
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(resumed.read).toHaveBeenCalledWith(retainedVideo.taskId, expect.any(AbortSignal))
    expect(first.submit).toHaveBeenCalledOnce()
  })

  it('keeps a completed video recoverable after download or disk failure without a new generation', async () => {
    const first = recoveryOptions({ save: vi.fn(async () => { throw new Error('disk temporarily unavailable') }) })
    const pending = await executeVideoTask(first)
    expect(pending).toMatchObject({ ok: false, submissionState: 'pending', code: 'VIDEO_DOWNLOAD_UNAVAILABLE', taskId: retainedVideo.taskId })
    if (pending.videoReceipt === undefined) throw new Error('Expected the completed video task receipt before saving again')
    const resume = recoveryOptions({ resumeReceipt: pending.videoReceipt,
      read: vi.fn(async () => recoveryJson({ status: 'completed' })) })
    expect(await executeVideoTask(resume)).toMatchObject({ ok: true, path: '/artifacts/original.mp4' })
    expect(resume.save).toHaveBeenCalledWith(retainedVideo.taskId, expect.any(AbortSignal))
    expect(resume.submit).not.toHaveBeenCalled()
  })

  it('marks only an explicit terminal provider rejection failed and preserves submission uncertainty without an id', async () => {
    const failed = recoveryOptions({ read: vi.fn(async () => recoveryJson({ status: 'failed' })) })
    expect(await executeVideoTask(failed)).toMatchObject({ ok: false, submissionState: 'failed', code: 'TASK_FAILED', taskId: retainedVideo.taskId })
    expect(failed.save).not.toHaveBeenCalled()
    const unknown = recoveryOptions({ submit: vi.fn(async () => { throw new Error('response lost') }) })
    expect(await executeVideoTask(unknown)).toMatchObject({ ok: false, submissionState: 'unknown', code: 'VIDEO_SUBMISSION_UNKNOWN' })
    expect(unknown.submit).toHaveBeenCalledOnce()
    expect(unknown.read).not.toHaveBeenCalled()
  })
})


describe('bounded video reads and source retention', () => {
  it('retries only transient GET failures and preserves the original source during recovery', async () => {
    const origin = { sessionId: 'original-chat' as import('@deepseek-ai/dsh-session/types').SessionId, turn: 2 }
    const f = fixture({ origin })
    f.read.mockRejectedValueOnce(new Error('temporary disconnect'))
      .mockResolvedValueOnce(json({ error: 'private diagnostic' }, 503))
    const completed = await executeVideoTask(f.options)
    expect(completed).toMatchObject({ ok: true, videoReceipt: { phase: 'completed', origin } })
    expect(f.submit).toHaveBeenCalledOnce()
    expect(f.read).toHaveBeenCalledTimes(3)
    for (const call of f.read.mock.calls) expect(call).toEqual(['public-task-1', expect.any(AbortSignal)])
    const resumed = fixture({ resumeReceipt: { ...accepted, origin }, origin: { ...origin, turn: 9 } })
    expect(await executeVideoTask(resumed.options)).toMatchObject({ ok: true, videoReceipt: { origin } })
    expect(resumed.submit).not.toHaveBeenCalled()
  })

  it('stops after the finite GET retry budget without resubmitting or losing acceptance', async () => {
    const f = fixture({ queryRetryLimit: 2 })
    f.read.mockImplementation(async () => json({ error: 'private diagnostic' }, 503))
    expect(await executeVideoTask(f.options)).toMatchObject({ submissionState: 'pending', code: 'VIDEO_QUERY_UNAVAILABLE',
      taskId: 'public-task-1', videoReceipt: { phase: 'accepted' } })
    expect(f.read).toHaveBeenCalledTimes(3)
    expect(f.submit).toHaveBeenCalledOnce()
    expect(f.save).not.toHaveBeenCalled()
  })

  it('keeps an accepted task pending when preparing its recovery destination fails', async () => {
    const f = fixture({ resumeReceipt: accepted, prepare: async () => { throw new Error('destination unavailable') } })
    expect(await executeVideoTask(f.options)).toMatchObject({ submissionState: 'pending', taskId: accepted.taskId,
      videoReceipt: accepted })
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
  })
})
