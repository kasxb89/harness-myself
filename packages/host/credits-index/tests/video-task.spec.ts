/** A paid video submit is attempted once; every recovery is an original-task GET. */
import { describe, expect, it, vi } from 'vitest'
import { executeVideoTask, type VideoTaskOptions } from '../src/video-task.ts'
import type { CreativeVideoReceipt } from '../src/creative-types.ts'

const fingerprint = 'a'.repeat(64)
const accepted: CreativeVideoReceipt = { model: 'model_5', route: '/v1/videos', backendFingerprint: fingerprint, phase: 'accepted', taskId: 'public-task-1' }
const json = (body: unknown, status = 200, headers?: HeadersInit): Response => new Response(JSON.stringify(body), { status, headers })

function fixture(overrides: Partial<VideoTaskOptions> = {}) {
  const receipts: CreativeVideoReceipt[] = []
  const submit = vi.fn(async () => json({ id: 'public-task-1' }, 200, { 'x-oneapi-request-id': 'gateway-request-1' }))
  const read = vi.fn(async () => json({ status: 'completed' }))
  const save = vi.fn(async () => '/private/artifacts/video.mp4')
  const options: VideoTaskOptions = {
    model: 'model_5', route: '/v1/videos', backendFingerprint: fingerprint, signal: new AbortController().signal,
    submitTimeoutMs: 180_000, taskTimeoutMs: 900_000, queryTimeoutMs: 1000, pollIntervalMs: 1,
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
