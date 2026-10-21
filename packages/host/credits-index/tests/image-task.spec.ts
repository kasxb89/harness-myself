import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { executeImageTask, type ImageTaskOptions } from '../src/image-task.ts'
import type { CreativeImageReceipt } from '../src/creative-types.ts'
import { Config } from '../src/index.ts'
import { VideoProjectError } from '../src/video-project.ts'

const fingerprint = 'a'.repeat(64)
const receipt: CreativeImageReceipt = { model: 'yunshu-internal-gpt-image-2', route: '/toapis/v1/images/generations',
  phase: 'accepted', taskId: 'original-task', requestId: 'original-request', backendFingerprint: fingerprint }
const json = (value: unknown, status = 200, headers?: HeadersInit): Response => new Response(JSON.stringify(value), {
  status, ...headers === undefined ? {} : { headers },
})
const image = { b64_json: 'aW1hZ2U=' }
function options(changes: Partial<ImageTaskOptions> = {}): ImageTaskOptions {
  return { model: receipt.model, route: receipt.route, backendFingerprint: fingerprint,
    signal: new AbortController().signal, submitTimeoutMs: 1000, taskTimeoutMs: 1000,
    queryTimeoutMs: 100, pollIntervalMs: 1, queryRetryLimit: 2,
    submit: vi.fn(async () => json({ id: receipt.taskId }, 202, { 'X-Oneapi-Request-Id': receipt.requestId! })),
    read: vi.fn(async () => json({ status: 'succeeded', result: { data: [image] } })),
    save: vi.fn(async () => '/artifacts/saved.png'), received: vi.fn(async () => {}), ...changes }
}

describe('image task execution and read-only recovery', () => {
  it('retains the generating source in receipts and keeps it when queried from another turn', async () => {
    const origin = { sessionId: 'original-chat' as import('@deepseek-ai/dsh-session/types').SessionId, turn: 2 }
    const first = options({ origin, queryRetryLimit: 0, read: vi.fn(async () => { throw new Error('temporary disconnect') }) })
    const pending = await executeImageTask(first)
    expect(pending.imageReceipt?.origin).toEqual(origin)
    if (pending.imageReceipt === undefined) throw new Error('Expected the accepted image task receipt before recovery')
    const resumed = options({ resumeReceipt: pending.imageReceipt,
      origin: { sessionId: origin.sessionId, turn: 9 } })
    const saved = await executeImageTask(resumed)
    expect(saved.imageReceipt?.origin).toEqual(origin)
    expect(resumed.submit).not.toHaveBeenCalled()
  })

  it('separates long image deadlines from account reads and accepts short local test budgets', () => {
    expect(Config({})).toMatchObject({ timeoutMs: 15000, imageSubmitTimeoutMs: 180000,
      imageTaskTimeoutMs: 600000, imagePollIntervalMs: 2000, imageQueryRetryLimit: 2,
      videoSubmitTimeoutMs: 180000, videoTaskTimeoutMs: 900000, videoPollIntervalMs: 6000, videoQueryRetryLimit: 2 })
    expect(Config({ imageSubmitTimeoutMs: 1, imageTaskTimeoutMs: 1 })).toMatchObject({ imageSubmitTimeoutMs: 1, imageTaskTimeoutMs: 1 })
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, 2147483648]) {
      expect(() => Config({ imageSubmitTimeoutMs: value })).toThrow()
      expect(() => Config({ imageTaskTimeoutMs: value })).toThrow()
    }
  })

  it('persists submission headers and accepted task before querying, then commits actual outputs', async () => {
    const receipts: CreativeImageReceipt[] = []
    const input = options({ received: async (value) => { receipts.push({ ...value }) }, read: vi.fn(async () => {
      expect(receipts.at(-1)).toMatchObject({ phase: 'accepted', taskId: 'original-task', requestId: 'original-request' })
      return json({ status: 'succeeded', result: { data: [image] } })
    }) })
    expect(await executeImageTask(input)).toMatchObject({ ok: true, submissionState: 'completed', taskId: receipt.taskId,
      requestId: receipt.requestId, paths: ['/artifacts/saved.png'], imageReceipt: { phase: 'completed' } })
    expect(receipts.map(value => value.phase)).toEqual(['submitting', 'submitting', 'accepted', 'completed'])
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it('retains the request ID when the response body fails after headers', async () => {
    const received = vi.fn(async () => {})
    const input = options({ received, submit: vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('private upstream diagnostic')) },
    }), { headers: { 'X-Oneapi-Request-Id': 'request-before-body-failure' } })) })
    const result = await executeImageTask(input)
    expect(result).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', requestId: 'request-before-body-failure' })
    expect(JSON.stringify(result)).not.toContain('private upstream diagnostic')
    expect(received).toHaveBeenCalledTimes(2)
    expect(input.read).not.toHaveBeenCalled()
  })

  it('excludes unsafe task and request identifiers before retaining or returning them', async () => {
    const input = options({ submit: async () => json({ id: 'sk-private-value' }, 200, { 'x-oneapi-request-id': 'nap_private-value' }) })
    const result = await executeImageTask(input)
    expect(result).toMatchObject({ submissionState: 'unknown', code: 'NO_TASK_ID' })
    expect(JSON.stringify(result)).not.toMatch(/sk-private|nap_private/u)
    expect(input.read).not.toHaveBeenCalled()
  })

  it('stops before submission if the durable admission callback fails', async () => {
    const input = options({ received: async () => { throw new Error('disk unavailable') } })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'not-submitted', code: 'IMAGE_RECEIPT_UNAVAILABLE' })
    expect(input.submit).not.toHaveBeenCalled()
  })

  it('distinguishes an abort after admission from an invoked paid POST', async () => {
    const controller = new AbortController()
    const input = options({ signal: controller.signal, submitting: async () => { controller.abort() } })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'not-submitted', code: 'ABORTED' })
    expect(input.submit).not.toHaveBeenCalled()
  })

  it('retains accepted identity but performs no GET when persisting the accepted receipt fails', async () => {
    const input = options({ received: async (value) => { if (value.phase === 'accepted') throw new Error('disk unavailable') } })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', code: 'IMAGE_RECEIPT_UNAVAILABLE', taskId: receipt.taskId })
    expect(input.read).not.toHaveBeenCalled()
  })

  it('uses an image submission deadline independent of short status requests', async () => {
    const input = options({ submitTimeoutMs: 100, queryTimeoutMs: 1, submit: vi.fn(async (signal: AbortSignal) => {
      await delay(15, undefined, { signal })
      return json({ data: [image] }, 200, { 'x-request-id': 'inline-request' })
    }) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'completed', requestId: 'inline-request', imageReceipt: { phase: 'completed' } })
    expect(input.read).not.toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it('never retries a timed out POST and reports its billing outcome as unknown', async () => {
    const input = options({ submitTimeoutMs: 1, submit: vi.fn(async (signal: AbortSignal) => {
      await delay(100, undefined, { signal })
      return json({ id: 'too-late' })
    }) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN' })
    expect(input.submit).toHaveBeenCalledOnce()
    expect(input.read).not.toHaveBeenCalled()
  })

  it('retries only transient GETs within a finite retry budget', async () => {
    let queries = 0
    const input = options({ read: vi.fn(async () => {
      if (++queries < 3) throw new Error('query disconnected')
      return json({ status: 'succeeded', result: { data: [image] } })
    }) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'completed' })
    expect(input.read).toHaveBeenCalledTimes(3)
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it('returns a pending known task when transient GET retries are exhausted', async () => {
    const input = options({ read: vi.fn(async () => json({}, 503)) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', code: 'IMAGE_QUERY_UNAVAILABLE', taskId: receipt.taskId })
    expect(input.read).toHaveBeenCalledTimes(3)
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it.each([false, true])('keeps a save-destination preparation failure separate from submission during resume=%s', async (resume) => {
    const input = options({ ...resume ? { resumeReceipt: receipt } : {}, prepare: async () => {
      throw new VideoProjectError('ARTIFACT_DESTINATION_UNAVAILABLE', 'unwritable destination')
    } })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: resume ? 'pending' : 'not-submitted',
      code: 'ARTIFACT_DESTINATION_UNAVAILABLE', ...resume ? { imageReceipt: receipt, taskId: receipt.taskId } : {} })
    expect(input.submit).not.toHaveBeenCalled()
    expect(input.read).not.toHaveBeenCalled()
  })

  it('closes an unread body when persisting its response-header receipt fails', async () => {
    const cancelled = vi.fn()
    const input = options({ received: async (value) => { if (value.requestId !== undefined) throw new Error('disk unavailable') },
      submit: async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'X-Oneapi-Request-Id': 'known-request' } }) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'unknown', requestId: 'known-request' })
    expect(cancelled).toHaveBeenCalledOnce()
    expect(input.read).not.toHaveBeenCalled()
  })

  it('resumes the exact accepted task with GET and never calls submission', async () => {
    const input = options({ resumeReceipt: receipt })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'completed', taskId: receipt.taskId, requestId: receipt.requestId })
    expect(input.submit).not.toHaveBeenCalled()
    expect(input.read).toHaveBeenCalledWith('original-task', expect.any(AbortSignal))
  })

  it('refuses to query another backend or resubmit a receipt without a task ID', async () => {
    for (const resumeReceipt of [{ ...receipt, backendFingerprint: 'b'.repeat(64) },
      { model: receipt.model, route: receipt.route, phase: 'submitting' as const, backendFingerprint: fingerprint }]) {
      const input = options({ resumeReceipt })
      expect(await executeImageTask(input)).toMatchObject({ ok: false })
      expect(input.submit).not.toHaveBeenCalled()
      expect(input.read).not.toHaveBeenCalled()
    }
  })

  it('retains task identity when local waiting is cancelled after acceptance', async () => {
    const controller = new AbortController()
    const input = options({ signal: controller.signal, read: vi.fn(async (_id: string, signal: AbortSignal) => {
      controller.abort()
      await delay(100, undefined, { signal })
      return json({})
    }) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', code: 'IMAGE_WAIT_STOPPED', taskId: receipt.taskId })
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it('bounds successful running status reads by the complete task deadline', async () => {
    const input = options({ taskTimeoutMs: 15, read: vi.fn(async () => json({ status: 'running' })) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', code: 'IMAGE_TASK_TIMEOUT', taskId: receipt.taskId })
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it('retains partial saved outputs and the task when a later download fails', async () => {
    const input = options({ read: async () => json({ status: 'succeeded', result: { data: [image, image] } }),
      save: async (_entry, index) => { if (index === 1) throw new Error('private download error'); return '/artifacts/first.png' } })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', code: 'IMAGE_DOWNLOAD_UNAVAILABLE',
      taskId: receipt.taskId, paths: ['/artifacts/first.png'] })
  })

  it.each([400, 401, 403, 429])('recognizes a definite HTTP %i rejection without retrying submission', async (status) => {
    const input = options({ submit: vi.fn(async () => json({ error: 'rejected' }, status)) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'failed', code: `HTTP_${String(status)}` })
    expect(input.submit).toHaveBeenCalledOnce()
    expect(input.read).not.toHaveBeenCalled()
  })

  it.each([408, 500, 502, 504])('retains an uncertain HTTP %i submission as unknown', async (status) => {
    const input = options({ submit: vi.fn(async () => json({ error: 'private server error' }, status)) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN' })
    expect(input.submit).toHaveBeenCalledOnce()
  })
})
