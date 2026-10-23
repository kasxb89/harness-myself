import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { executeImageTask, type ImageTaskOptions } from '../src/image-task.ts'
import type { CreativeImageReceipt } from '../src/creative-types.ts'
import { Config } from '../src/index.ts'
import { VideoProjectError } from '../src/video-project.ts'
import mediaContract from './fixtures/media-submission-api-contract-v3.json' with { type: 'json' }
import type { CreationTaskActivity } from '../src/creation-activity.ts'

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
  it('observes the original image queue, generation and actual saving without inventing a new task', async () => {
    const events: CreationTaskActivity[] = []
    const states = ['queued', 'running', 'succeeded']
    const input = options({ route: '/v1/images/generations', activity: event => events.push(event),
      read: vi.fn(async () => {
        const state = states.shift()
        return json({ status: state, ...state === 'succeeded' ? { data: [image] } : {} })
      }) })
    expect(await executeImageTask(input)).toMatchObject({ ok: true, submissionState: 'completed' })
    expect(events).toEqual([
      { type: 'stage', stage: 'preparing' }, { type: 'stage', stage: 'submitting' },
      { type: 'stage', stage: 'accepted' }, { type: 'stage', stage: 'queued' },
      { type: 'stage', stage: 'generating' }, { type: 'stage', stage: 'saving' },
      { type: 'end', stage: 'saving', outcome: 'completed' },
    ])
    expect(input.submit).toHaveBeenCalledOnce()
    expect(input.read).toHaveBeenCalledTimes(3)
  })

  it('contains a rejecting observer while preserving a query-only unknown image outcome', async () => {
    const events: CreationTaskActivity[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const input = options({ resumeReceipt: { ...receipt, taskId: 'task_canonical_original' },
        read: vi.fn(async () => json({ status: 'UNKNOWN' })),
        // oxlint-disable-next-line typescript/no-misused-promises -- Contain a JavaScript observer's rejected Promise.
        activity: (event) => { events.push(event); return Promise.reject(new Error('private observer detail')) } })
      expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', code: 'IMAGE_STATUS_INVALID' })
      await Promise.resolve()
      expect(events.at(-1)).toEqual({ type: 'end', stage: 'unknown', outcome: 'unknown' })
      expect(events).not.toContainEqual({ type: 'stage', stage: 'generating' })
      expect(warn).toHaveBeenCalledWith('Creation activity observer failed')
      expect(input.submit).not.toHaveBeenCalled()
      expect(input.save).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  const capacity = mediaContract.find(entry => entry.method === 'POST' && entry.http_status === 429 && entry.response.media_kind === 'image')
  const canonical = mediaContract.find(entry => entry.method === 'GET' && entry.response.media_kind === 'image')
  if (capacity === undefined || canonical === undefined || typeof capacity.response.id !== 'string') throw new Error('Actual image receipt fixtures are required')
  const originalId = capacity.response.id

  it('retains the actual image capacity proof, header and original immutable route as failed without a local not-submitted result', async () => {
    const input = options({ submit: vi.fn(async () => json(capacity.response, capacity.http_status, { 'x-oneapi-request-id': 'actual-header' })) })
    const result = await executeImageTask(input)
    expect(result).toMatchObject({ submissionState: 'failed', taskId: originalId, requestId: 'actual-header',
      code: 'media_account_capacity_exhausted', imageReceipt: { route: receipt.route, phase: 'submitting', taskId: originalId } })
    expect(result.message).toContain('未扣费')
    expect(input.submit).toHaveBeenCalledOnce()
    expect(input.read).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
  })

  it('recovers an actual image not-sent proof through the fixed canonical GET without submitting', async () => {
    const input = options({ resumeReceipt: { ...receipt, taskId: originalId },
      read: vi.fn(async () => json(canonical.response, canonical.http_status)) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'failed', taskId: originalId, code: 'MEDIA_SUBMISSION_NOT_SENT' })
    expect(input.read).toHaveBeenCalledExactlyOnceWith(originalId, expect.any(AbortSignal), true)
    expect(input.submit).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
  })

  it('prefers the canonical original task over a retained platform task native failure projection', async () => {
    const input = options({ resumeReceipt: { ...receipt, taskId: originalId },
      read: vi.fn(async (_taskId: string, _signal: AbortSignal, canonicalRead?: boolean) => canonicalRead === true
        ? json(canonical.response, canonical.http_status) : json({ id: originalId, model: 'gpt-image-2', status: 'failed' })) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'failed', taskId: originalId, code: 'MEDIA_SUBMISSION_NOT_SENT' })
    expect(input.read).toHaveBeenCalledExactlyOnceWith(originalId, expect.any(AbortSignal), true)
    expect(input.submit).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
  })

  it('keeps actual Toapis legacy queued and canonical UNKNOWN projections unresolved without a new POST', async () => {
    const native = mediaContract.find(entry => entry.method === 'GET' && entry.path.startsWith('/toapis/'))
    const original = mediaContract.find(entry => entry.method === 'GET' && entry.path === '/v1/tasks/task_legacy_image_missing_key')
    if (native === undefined || original === undefined || typeof original.response.task_id !== 'string') throw new Error('Actual Toapis legacy wire pair required')
    const taskId = original.response.task_id
    const input = options({ resumeReceipt: { ...receipt, taskId },
      read: vi.fn(async (_id: string, _signal: AbortSignal, canonicalRead?: boolean) => canonicalRead === true
        ? json(original.response, original.http_status) : json(native.response, native.http_status)) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', taskId, code: 'IMAGE_STATUS_INVALID' })
    expect(input.read).toHaveBeenNthCalledWith(1, taskId, expect.any(AbortSignal), true)
    expect(input.read).toHaveBeenCalledOnce()
    expect(input.submit).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
  })

  it('continues the original native image query when the old server has no canonical task endpoint', async () => {
    let nativeReads = 0
    const input = options({ resumeReceipt: receipt,
      read: vi.fn(async (_id: string, _signal: AbortSignal, canonicalRead?: boolean) => {
        if (canonicalRead === true) return json({}, 404)
        nativeReads += 1
        return nativeReads === 1 ? json({ id: receipt.taskId, status: 'queued' })
          : json({ id: receipt.taskId, status: 'succeeded', result: { data: [image] } })
      }) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'completed', taskId: receipt.taskId })
    expect(nativeReads).toBe(2)
    expect(input.read).toHaveBeenCalledTimes(3)
    expect(input.submit).not.toHaveBeenCalled()
  })

  it.each([200, 404, 503])('keeps an old native failure pending when canonical HTTP%s has no financial proof', async (httpStatus) => {
    const input = options({ resumeReceipt: receipt,
      read: vi.fn(async (_taskId: string, _signal: AbortSignal, canonicalRead?: boolean) => canonicalRead === true
        ? json({ id: receipt.taskId, status: 'FAILURE', provider_terminal_confirmed: true }, httpStatus)
        : json({ id: receipt.taskId, model: 'gpt-image-2', status: 'failed' })) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', taskId: receipt.taskId, code: 'IMAGE_STATUS_INVALID' })
    expect(input.read).toHaveBeenCalledTimes(2)
    expect(input.submit).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
  })

  it.each([
    { upstream_submitted: true }, { schema_version: undefined }, { model: 'gpt-image-2' }, { media_kind: 'video' },
    { task_id: 'another-task' }, { billing_state: 'refunded', refund_confirmed: false }, { resubmittable: false },
    { recovery: { method: 'POST', path: '/v1/tasks/' + originalId } },
  ])('does not settle or save an invalid image POST or GET proof %j', async (patch) => {
    const malformed = { ...capacity.response.media_submission_receipt, ...patch }
    const post = options({ submit: vi.fn(async () => json({ ...capacity.response, media_submission_receipt: malformed }, 403)) })
    expect((await executeImageTask(post)).submissionState).toMatch(/^(?:pending|unknown)$/u)
    expect(post.submit).toHaveBeenCalledOnce()
    expect(post.read).not.toHaveBeenCalled()
    expect(post.save).not.toHaveBeenCalled()
    const get = options({ resumeReceipt: { ...receipt, taskId: originalId },
      read: vi.fn(async () => json({ ...canonical.response, media_submission_receipt: malformed, result: { data: [image] } })) })
    expect(await executeImageTask(get)).toMatchObject({ submissionState: 'pending', taskId: originalId, code: 'IMAGE_STATUS_INVALID' })
    expect(get.submit).not.toHaveBeenCalled()
    expect(get.read).toHaveBeenCalledOnce()
    expect(get.save).not.toHaveBeenCalled()
  })

  it('does not invent an image task from conflicting outer IDs or let a misplaced proof fall through', async () => {
    for (const body of [{ ...capacity.response, task_id: 'another-task' },
      { code: 'insufficient_user_quota', data: { media_submission_receipt: capacity.response.media_submission_receipt } }]) {
      const input = options({ submit: vi.fn(async () => json(body, 403, { 'x-request-id': 'safe-header-only' })) })
      const result = await executeImageTask(input)
      expect(result).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN', requestId: 'safe-header-only' })
      expect(result).not.toHaveProperty('taskId')
      expect(input.read).not.toHaveBeenCalled()
      expect(input.save).not.toHaveBeenCalled()
    }
  })
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

  it('checks the initiating login after receipt persistence and before invoking the paid POST', async () => {
    let changed = false
    const input = options({
      received: async () => { changed = true },
      beforeSubmit: () => { if (changed) throw new VideoProjectError('IMAGE_ACCOUNT_CHANGED', 'Login changed before dispatch') },
    })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'not-submitted', code: 'IMAGE_ACCOUNT_CHANGED' })
    expect(input.submit).not.toHaveBeenCalled()
  })

  it('retains an unknown outcome for a real submission failure after the final login check', async () => {
    const beforeSubmit = vi.fn()
    const input = options({ beforeSubmit, submit: vi.fn(async () => { throw new Error('connection lost after sending') }) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN' })
    expect(beforeSubmit).toHaveBeenCalledOnce()
    expect(input.submit).toHaveBeenCalledOnce()
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

  it.each([400, 401, 403])('recognizes a definite HTTP %i rejection without retrying submission', async (status) => {
    const input = options({ submit: vi.fn(async () => json({ error: 'rejected' }, status)) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'failed', code: `HTTP_${String(status)}` })
    expect(input.submit).toHaveBeenCalledOnce()
    expect(input.read).not.toHaveBeenCalled()
  })

  it.each([undefined, 'original-limited-task'])('retains generic HTTP429 uncertainty with original task %s', async (id) => {
    const input = options({ submit: vi.fn(async () => json({ error: 'busy', ...id === undefined ? {} : { id } }, 429)) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: id === undefined ? 'unknown' : 'pending',
      code: id === undefined ? 'IMAGE_SUBMISSION_UNKNOWN' : 'IMAGE_QUERY_PENDING',
      ...id === undefined ? {} : { taskId: id, imageReceipt: { taskId: id, phase: 'accepted' } } })
    expect(input.submit).toHaveBeenCalledOnce()
    expect(input.read).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
  })

  it('retains generic HTTP429 uncertainty for an empty response while preserving its request header', async () => {
    const input = options({ submit: vi.fn(async () => new Response(null, { status: 429,
      headers: { 'X-Oneapi-Request-Id': 'limited-request' } })) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN',
      requestId: 'limited-request', imageReceipt: { requestId: 'limited-request', phase: 'submitting' } })
    expect(input.submit).toHaveBeenCalledOnce()
    expect(input.read).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
  })

  it.each([408, 500, 502, 504])('retains an uncertain HTTP %i submission as unknown', async (status) => {
    const input = options({ submit: vi.fn(async () => json({ error: 'private server error' }, status)) })
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN' })
    expect(input.submit).toHaveBeenCalledOnce()
  })
})
