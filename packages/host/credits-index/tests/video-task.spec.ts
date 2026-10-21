import { describe, expect, it, vi } from 'vitest'
import { executeVideoTask, type VideoTaskOptions } from '../src/video-task.ts'
import type { CreativeVideoReceipt } from '../src/creative-types.ts'

const receipt: CreativeVideoReceipt = { route: '/v1/videos', model: 'video-model', phase: 'accepted',
  taskId: 'original-video', backendFingerprint: 'a'.repeat(64) }
const json = (body: unknown, status = 200) => Response.json(body, { status })
function options(change: Partial<VideoTaskOptions> = {}): VideoTaskOptions {
  return { model: receipt.model, route: receipt.route, backendFingerprint: receipt.backendFingerprint,
    signal: new AbortController().signal, submitTimeoutMs: 1000, taskTimeoutMs: 1000,
    queryTimeoutMs: 100, pollIntervalMs: 1, queryRetryLimit: 1,
    submit: vi.fn(async () => json({ task_id: receipt.taskId, status: 'queued' }, 202)),
    read: vi.fn(async () => json({ status: 'succeeded', task_result: { videos: [{ url: 'https://media.invalid/original.mp4' }] } })),
    save: vi.fn(async () => '/artifacts/original.mp4'), received: vi.fn(async () => {}), ...change }
}

describe('single video submission and original-task recovery', () => {
  it('keeps every nonterminal provider status pending and saves the actual completed task once', async () => {
    const read = vi.fn<VideoTaskOptions['read']>()
    for (const status of ['pending', 'queued', 'processing', 'running']) read.mockResolvedValueOnce(json({ data: { task_status: status } }))
    read.mockResolvedValueOnce(json({ data: { task_status: 'succeeded', task_result: { videos: [{ url: 'https://media.invalid/original.mp4' }] } } }))
    const run = options({ read })
    expect(await executeVideoTask(run)).toMatchObject({ ok: true, submissionState: 'completed', taskId: receipt.taskId,
      path: '/artifacts/original.mp4', videoReceipt: { phase: 'completed' } })
    expect(run.submit).toHaveBeenCalledOnce()
    expect(run.save).toHaveBeenCalledOnce()
    expect(run.save).toHaveBeenCalledWith({ taskId: receipt.taskId, url: 'https://media.invalid/original.mp4' }, 0, expect.any(AbortSignal))
  })

  it('retains the accepted task through transient query errors and recovers only by GET', async () => {
    const first = options({ queryRetryLimit: 0, read: vi.fn(async () => { throw new Error('temporary network failure') }) })
    const pending = await executeVideoTask(first)
    expect(pending).toMatchObject({ ok: false, submissionState: 'pending', code: 'VIDEO_QUERY_UNAVAILABLE',
      taskId: receipt.taskId, videoReceipt: { phase: 'accepted' } })
    if (pending.videoReceipt === undefined) throw new Error('Expected the accepted video task receipt before recovery')
    const resumed = options({ resumeReceipt: pending.videoReceipt })
    expect(await executeVideoTask(resumed)).toMatchObject({ ok: true, taskId: receipt.taskId })
    expect(resumed.submit).not.toHaveBeenCalled()
    expect(resumed.read).toHaveBeenCalledWith(receipt.taskId, expect.any(AbortSignal))
    expect(first.submit).toHaveBeenCalledOnce()
  })

  it('keeps a completed video recoverable after download or disk failure without a new generation', async () => {
    const first = options({ save: vi.fn(async () => { throw new Error('disk temporarily unavailable') }) })
    const pending = await executeVideoTask(first)
    expect(pending).toMatchObject({ ok: false, submissionState: 'pending', code: 'VIDEO_DOWNLOAD_UNAVAILABLE', taskId: receipt.taskId })
    if (pending.videoReceipt === undefined) throw new Error('Expected the completed video task receipt before saving again')
    const resume = options({ resumeReceipt: pending.videoReceipt,
      read: vi.fn(async () => json({ status: 'completed' })) })
    expect(await executeVideoTask(resume)).toMatchObject({ ok: true, path: '/artifacts/original.mp4' })
    expect(resume.save).toHaveBeenCalledWith({ taskId: receipt.taskId }, 0, expect.any(AbortSignal))
    expect(resume.submit).not.toHaveBeenCalled()
  })

  it('marks only an explicit terminal provider rejection failed and preserves submission uncertainty without an id', async () => {
    const failed = options({ read: vi.fn(async () => json({ status: 'failed' })) })
    expect(await executeVideoTask(failed)).toMatchObject({ ok: false, submissionState: 'failed', code: 'TASK_FAILED', taskId: receipt.taskId })
    expect(failed.save).not.toHaveBeenCalled()
    const unknown = options({ submit: vi.fn(async () => { throw new Error('response lost') }) })
    expect(await executeVideoTask(unknown)).toMatchObject({ ok: false, submissionState: 'unknown', code: 'VIDEO_SUBMISSION_UNKNOWN' })
    expect(unknown.submit).toHaveBeenCalledOnce()
    expect(unknown.read).not.toHaveBeenCalled()
  })
})
