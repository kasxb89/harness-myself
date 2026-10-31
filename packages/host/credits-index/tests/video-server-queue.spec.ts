import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindVideoServerQueueRecovery, discoverVideoServerQueue } from '../src/video-server-queue.ts'
import type { VideoServerQueue } from '../src/video-server-queue.ts'
import type { VideoProjectAttemptId } from '../src/video-project.ts'
import type { VideoProjectRequest, VideoProjectSubmission } from '../src/video-project-types.ts'

const ATTEMPT = 'bc751f83-73b9-4c89-b756-e623b5ec7ab5' as VideoProjectAttemptId
const QUEUE = `vq_${ATTEMPT}`
const REQUEST: VideoProjectRequest = { model: 'example-video', prompt: 'private original prompt', seconds: 10 }
const SUBMISSION: VideoProjectSubmission = { attemptId: ATTEMPT, durationSeconds: 10, count: 1 }
const CAPABILITY = {
  schema_version: 1, enabled: true, create_path: '/v1/video/queue',
  retrieve_path_template: '/v1/video/queue/:queue_id', cancel_path_template: '/v1/video/queue/:queue_id/cancel',
  max_count_per_item: 1, body_max_bytes: 65_536, poll_interval_seconds: 15,
  client_generated_id: true, queued_charge_reserved: false, lost_ack_recovery_method: 'GET',
}

function receipt(state = 'queued', submissionState = 'not_submitted') {
  return { schema_version: 1, object: 'video_queue_item', accepted: true,
    data: { id: QUEUE, operation_id: ATTEMPT, model: 'example-video', count: 1, duration_seconds: 10,
      task_id: 'task_1234567890abcdefghijklmnopqrstuv', state, submission_state: submissionState, created_at: 1, updated_at: 2 },
    cancelable: state === 'queued', observation_timed_out: false, recovery: { method: 'GET', path: `/v1/video/queue/${QUEUE}` } }
}
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
interface Call { path: string; method: string; authorization: string | null; body: string | undefined }
function transport(handler?: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    const call: Call = { path: new URL(url).pathname, method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? init.body : undefined }
    calls.push(call)
    return handler === undefined ? response({ data: { video_queue: CAPABILITY } }) : handler(call, calls.length - 1)
  }
  return { calls, fetch }
}
const freshSignal = () => new AbortController().signal

it.each([true, false])('reads a legal public status larger than a queue ACK with queue capability=%s', async (enabled) => {
  const models = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`model-${String(index)}`, { description: '快'.repeat(500) }]))
  const body = { data: { client_model_presentation: { schema_version: 1, models }, ...enabled ? { video_queue: CAPABILITY } : {} } }
  expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(65536)
  const upstream = transport(() => response(body))
  const queue = await discoverVideoServerQueue({ origin: 'https://queue.example/harness', timeoutMs: 1000,
    fetch: upstream.fetch, key: async () => 'unused-public-status' }, freshSignal())
  expect(queue === undefined).toBe(!enabled)
  expect(upstream.calls.map(call => call.method)).toEqual(['GET'])
})

it('bounds public status to one MiB and joins reader cancellation before returning a safe preflight error', async () => {
  let canceled = false
  const upstream = transport(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1_048_577)) },
    cancel() { canceled = true },
  })))
  await expect(discoverVideoServerQueue({ origin: 'https://queue.example/harness', timeoutMs: 1000,
    fetch: upstream.fetch, key: async () => 'unused-public-status' }, freshSignal())).rejects
    .toMatchObject({ code: 'VIDEO_QUEUE_CAPABILITY_UNAVAILABLE' })
  expect(canceled).toBe(true)
  expect(upstream.calls.map(call => call.method)).toEqual(['GET'])
})

it('does not mark a credential preflight failure as an uncertain submitted queue', async () => {
  const upstream = transport()
  const queue = await discoverVideoServerQueue({ origin: 'https://queue.example/harness', timeoutMs: 1000,
    fetch: upstream.fetch, key: async () => { throw new Error('synthetic account changed') } }, freshSignal())
  if (queue === undefined) throw new Error('Queue capability fixture is required')
  await expect(queue.submit(REQUEST, SUBMISSION, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_SUBMISSION_NOT_STARTED', queueId: undefined })
  expect(upstream.calls.map(call => call.method)).toEqual(['GET'])
})

it('keeps an already canceled queue invocation explicitly unsent without a create or recovery fetch', async () => {
  const f = await fixture()
  const stopped = new AbortController()
  stopped.abort(new Error('synthetic canceled before invoke'))
  await expect(f.queue.submit(REQUEST, SUBMISSION, stopped.signal)).rejects
    .toMatchObject({ code: 'VIDEO_QUEUE_SUBMISSION_NOT_STARTED', queueId: undefined })
  expect(f.calls.map(call => call.method)).toEqual(['GET'])
})

async function fixture(handler?: (call: Call, index: number) => Response | Promise<Response>) {
  const upstream = transport((call, index) => call.path === '/harness/api/status'
    ? response({ data: { video_queue: CAPABILITY } }) : handler === undefined ? response(receipt()) : handler(call, index))
  const key = vi.fn(async () => 'synthetic-relay-key')
  const options = { origin: 'https://queue.example/harness', timeoutMs: 1000, fetch: upstream.fetch, key }
  const queue = await discoverVideoServerQueue(options, freshSignal())
  if (queue === undefined) throw new Error('Fixture queue must be supported')
  return { ...upstream, key, options, queue }
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  })))
})

describe('explicit server video queue discovery', () => {
  it.each([
    { value: { data: {} }, status: 200 },
    { value: { data: { video_queue: { enabled: false } } }, status: 200 },
    { value: 'legacy html not found', status: 404 },
  ])('retains legacy operation only for a definite missing or disabled capability $status', async ({ value, status }) => {
    const f = transport(() => response(value, status))
    const key = vi.fn(async () => 'unused-key')
    expect(await discoverVideoServerQueue({ origin: 'https://queue.example/harness', timeoutMs: 1000, fetch: f.fetch, key }, freshSignal()))
      .toBeUndefined()
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ path: '/harness/api/status', method: 'GET', authorization: null })
    expect(key).not.toHaveBeenCalled()
  })

  it.each([
    { enabled: 'true' }, { schema_version: 2 }, { create_path: 'https://evil.example/queue' },
    { retrieve_path_template: '/v1/video/queue/:queue_id?token=x' }, { cancel_path_template: '//evil.example/cancel' },
    { max_count_per_item: 2 }, { body_max_bytes: 65_537 }, { poll_interval_seconds: 0 },
    { client_generated_id: false }, { queued_charge_reserved: true }, { lost_ack_recovery_method: 'POST' }, { extra: true },
  ])('rejects an incompatible advertised capability without sending a POST %j', async (patch) => {
    const f = transport(() => response({ data: { video_queue: { ...CAPABILITY, ...patch } } }))
    await expect(discoverVideoServerQueue({ origin: 'https://queue.example/harness', timeoutMs: 1000,
      fetch: f.fetch, key: async () => 'unused-key' }, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_CAPABILITY_INVALID' })
    expect(f.calls.map(call => call.method)).toEqual(['GET'])
  })

  it.each([401, 403, 408, 429, 500, 503])('does not choose a legacy POST after a capability HTTP%s failure', async (status) => {
    const f = transport(() => response({ error: { message: 'private upstream diagnostics and keys' } }, status))
    await expect(discoverVideoServerQueue({ origin: 'https://queue.example', timeoutMs: 1000,
      fetch: f.fetch, key: async () => 'unused' }, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_CAPABILITY_UNAVAILABLE' })
    expect(f.calls.map(call => call.method)).toEqual(['GET'])
  })

  it.each([
    () => new Response('{invalid json'),
    () => response({}),
    () => new Response(new Uint8Array(65_537)),
    () => new Response(new Uint8Array([0xff, 0xfe])),
  ])('reports malformed discovery as unavailable instead of falling back', async (reply) => {
    const f = transport(reply)
    await expect(discoverVideoServerQueue({ origin: 'https://queue.example', timeoutMs: 1000,
      fetch: f.fetch, key: async () => 'unused' }, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_CAPABILITY_UNAVAILABLE' })
    expect(f.calls).toHaveLength(1)
  })

  it('reports a network discovery failure without starting queue polling', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('private network detail') })
    await expect(discoverVideoServerQueue({ origin: 'https://queue.example', timeoutMs: 1000,
      fetch, key: async () => 'unused' }, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_CAPABILITY_UNAVAILABLE' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('single original server video admission', () => {
  it('uses the persisted attempt for queue and operation identities, separately retaining duration and count', async () => {
    const f = await fixture()
    expect(f.queue.supports(REQUEST)).toBe(true)
    expect(f.queue.supports(REQUEST, SUBMISSION)).toBe(true)
    expect(await f.queue.submit(REQUEST, SUBMISSION, freshSignal())).toMatchObject({ queueId: QUEUE, operationId: ATTEMPT,
      model: 'example-video', count: 1, durationSeconds: 10, gatewayTaskId: 'task_1234567890abcdefghijklmnopqrstuv', state: 'queued' })
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]).toMatchObject({ path: '/harness/v1/video/queue', method: 'POST', authorization: 'Bearer synthetic-relay-key' })
    expect(JSON.parse(f.calls[1]?.body ?? '{}')).toEqual({ schema_version: 1, queue_id: QUEUE, operation_id: ATTEMPT, count: 1, request: REQUEST })
    expect(f.queue.pollIntervalMs).toBe(15_000)
  })

  it.each([
    { request: { ...REQUEST, _blackrxReferences: [] } },
    { request: { ...REQUEST, __yunshu_files: [{ base64: 'private' }] } },
    { request: { ...REQUEST, content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] } },
    { request: { ...REQUEST, reference_video: ['ma_private_upload'] } },
    { request: { ...REQUEST, reference_video: ['C:\\private\\clip.mp4'] } },
    { request: { ...REQUEST, first_frame_image: '/private/picture.png' } },
    { request: { ...REQUEST, content: [{ type: 'video_url', video_url: { url: 'file:///private/clip.mp4' } }] } },
    { request: { ...REQUEST, reference_video: ['https://user:private@uploads.example/video.mp4'] } },
    { request: { ...REQUEST, n: 3 } }, { request: { ...REQUEST, count: 2 } },
    { request: { ...REQUEST, seconds: 0 } }, { request: { ...REQUEST, seconds: '10s' } },
    { request: { ...REQUEST, duration: 15 } }, { request: { ...REQUEST, seconds: 3601 } },
    { request: { ...REQUEST, extra: 'x'.repeat(32_769) } }, { request: { ...REQUEST, prompt: ' ' } },
    { request: { ...REQUEST, metadata: { authorization: 'private-key' } } },
  ])('rejects unsupported or private request fields before any POST', async ({ request }) => {
    const f = await fixture()
    expect(f.queue.supports(request)).toBe(false)
    await expect(f.queue.submit(request, SUBMISSION, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_REQUEST_UNSUPPORTED' })
    expect(f.calls.map(call => call.method)).toEqual(['GET'])
  })

  it('accepts public uploaded reference URLs without uploading or rewriting them', async () => {
    const f = await fixture()
    const request = { ...REQUEST, reference_video: ['https://uploads.example/owned-video.mp4'] }
    expect(f.queue.supports(request, SUBMISSION)).toBe(true)
    await f.queue.submit(request, SUBMISSION, freshSignal())
    expect(JSON.parse(f.calls[1]?.body ?? '{}')).toMatchObject({ request })
    expect(f.calls).toHaveLength(2)
  })

  it.each([
    { ...SUBMISSION, durationSeconds: 15 },
    { ...SUBMISSION, attemptId: 'not-a-persisted-uuid' as VideoProjectAttemptId },
  ])('refuses invalid clip metadata without probing or submitting', async (submission) => {
    const f = await fixture()
    expect(f.queue.supports(REQUEST, submission)).toBe(false)
    await expect(f.queue.submit(REQUEST, submission, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_REQUEST_UNSUPPORTED' })
    expect(f.calls).toHaveLength(1)
  })

  it('recovers a lost acknowledgement with one original-ID GET and exactly one create POST', async () => {
    const f = await fixture((call) => {
      if (call.method === 'POST') throw new Error('lost acknowledgement after durable acceptance')
      return response(receipt())
    })
    expect(await f.queue.submit(REQUEST, SUBMISSION, freshSignal())).toMatchObject({ queueId: QUEUE, state: 'queued' })
    expect(f.calls.map(call => [call.method, call.path])).toEqual([
      ['GET', '/harness/api/status'], ['POST', '/harness/v1/video/queue'], ['GET', `/harness/v1/video/queue/${QUEUE}`],
    ])
  })

  it.each([200, 202, 400, 401, 404, 409, 429, 500, 503])('recovers an invalid create acknowledgement at HTTP%s by GET only', async (status) => {
    const f = await fixture(call => call.method === 'POST' ? response({ accepted: true, data: { id: 'unrelated' } }, status) : response(receipt()))
    expect(await f.queue.submit(REQUEST, SUBMISSION, freshSignal())).toMatchObject({ queueId: QUEUE })
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(f.calls.at(-1)?.path).toBe(`/harness/v1/video/queue/${QUEUE}`)
  })

  it('retains the deterministic original identity when lost acknowledgement recovery is also unavailable', async () => {
    const f = await fixture(() => { throw new Error('private prompt or key cannot be reported') })
    const error = await f.queue.submit(REQUEST, SUBMISSION, freshSignal()).catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'VIDEO_QUEUE_SUBMISSION_UNKNOWN', queueId: QUEUE })
    expect(String(error)).not.toContain('private prompt or key')
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('retains the original queue identity after cancellation during the first POST and never falls back', async () => {
    const cancel = new AbortController()
    const f = await fixture(() => { cancel.abort(new Error('user stop')); throw new Error('connection closed') })
    await expect(f.queue.submit(REQUEST, SUBMISSION, cancel.signal)).rejects.toMatchObject({ code: 'VIDEO_QUEUE_SUBMISSION_UNKNOWN', queueId: QUEUE })
    expect(f.calls.map(call => call.method)).toEqual(['GET', 'POST'])
  })
})

describe('original queue observation and safe cancellation', () => {
  it.each(['error_code', 'failure_code'])('retains gateway funding category from %s without raw diagnostics', async (field) => {
    const body = receipt('failed', 'not_submitted')
    const f = await fixture(() => response({ ...body, data: { ...body.data, [field]: 'insufficient_user_quota',
      failure_reason: 'private vendor details and credential' } }))
    const result = await f.queue.read(QUEUE, REQUEST, freshSignal())
    expect(result).toMatchObject({ state: 'failed', submissionState: 'not_submitted',
      failure: { code: 'INSUFFICIENT_BALANCE', message: '余额不足，请充值' } })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(0)
  })

  it.each(['pre_consume_token_quota_failed', 'insufficient_quota', 'QUOTA', ''])
  ('does not infer funding from raw reason or legacy error when the public failure code is %s', async (failureCode) => {
    const body = receipt('failed', 'not_submitted')
    const f = await fixture(() => response({ ...body, data: { ...body.data, error_code: 'insufficient_user_quota',
      failure_code: failureCode, failure_reason: '余额不足，请充值 private vendor details' } }))
    expect(await f.queue.read(QUEUE, REQUEST, freshSignal())).not.toHaveProperty('failure')
  })

  it.each([402, 403])('recovers original GET after a funding HTTP%s without another POST or a false non-submission claim', async (status) => {
    const f = await fixture(call => call.method === 'POST'
      ? response({ code: 'insufficient_user_quota', message: 'private diagnostic' }, status)
      : response({ code: 'not_found' }, 404))
    const error = await f.queue.submit(REQUEST, SUBMISSION, freshSignal()).catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'INSUFFICIENT_BALANCE', queueId: QUEUE,
      failure: { code: 'INSUFFICIENT_BALANCE' },
      message: '余额不足，请充值；视频排队受理结果尚未确认；请保留原队列编号，仅查询原队列，不要重新生成。' })
    expect(String(error)).toContain('余额不足，请充值')
    expect(String(error)).not.toContain('private')
    expect(f.calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET'])
  })

  it.each([
    { state: 'queued', submission: 'not_submitted', timedOut: false },
    { state: 'dispatching', submission: 'dispatching', timedOut: false },
    { state: 'dispatching', submission: 'unknown', timedOut: true },
    { state: 'unknown', submission: 'unknown', timedOut: true },
    { state: 'running', submission: 'accepted', timedOut: false },
    { state: 'succeeded', submission: 'accepted', timedOut: false },
    { state: 'failed', submission: 'not_submitted', timedOut: false },
    { state: 'failed', submission: 'accepted', timedOut: false },
    { state: 'canceled', submission: 'not_submitted', timedOut: false },
  ])('preserves $state/$submission and observation timeout without another POST', async ({ state, submission, timedOut }) => {
    const body = { ...receipt(state, submission), observation_timed_out: timedOut }
    const f = await fixture(() => response(body))
    expect(await f.queue.read(QUEUE, REQUEST, freshSignal())).toMatchObject({ queueId: QUEUE, state, submissionState: submission,
      observationTimedOut: timedOut, gatewayTaskId: 'task_1234567890abcdefghijklmnopqrstuv' })
    expect(f.calls.map(call => call.method)).toEqual(['GET', 'GET'])
  })

  it.each([
    { schema_version: 2 }, { accepted: false }, { object: 'video' }, { cancelable: 'true' },
    { observation_timed_out: 'false' }, { recovery: { method: 'POST', path: `/v1/video/queue/${QUEUE}` } },
    { recovery: { method: 'GET', path: 'https://evil.example/private' } },
    { recovery: { method: 'GET', path: `/v1/video/queue/${QUEUE}`, token: 'private' } },
    { unexpected: 'private' },
  ])('refuses a malformed outer queue receipt without following its route %j', async (patch) => {
    const f = await fixture(() => response({ ...receipt(), ...patch }))
    await expect(f.queue.read(QUEUE, REQUEST, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_RESPONSE_INVALID', queueId: QUEUE })
    expect(f.calls.map(call => call.path)).toEqual(['/harness/api/status', `/harness/v1/video/queue/${QUEUE}`])
  })

  it.each([
    { id: 'vq_unrelated' }, { operation_id: 'other-original-operation' }, { model: 'another-model' }, { count: 3 },
    { duration_seconds: 15 }, { task_id: 'https://evil.example/task' }, { task_id: 'sk-private-key' },
    { state: 'failed', submission_state: 'unknown' }, { state: 'running', submission_state: 'not_submitted' },
    { state: 'queued', submission_state: 'accepted' }, { state: 'completed' }, { created_at: -1 }, { updated_at: 0 },
    { prompt: 'private content should never be in receipt' },
  ])('rejects conflicting original task facts %j', async (patch) => {
    const current = receipt()
    const f = await fixture(() => response({ ...current, data: { ...current.data, ...patch } }))
    await expect(f.queue.read(QUEUE, REQUEST, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_RESPONSE_INVALID', queueId: QUEUE })
    expect(f.calls.filter(call => call.method === 'POST')).toEqual([])
  })

  it.each([408, 429, 500, 502, 503, 599])('classifies original queue HTTP%s as observation unavailable without parsing its private error body', async (status) => {
    const f = await fixture(() => new Response('private gateway details are not a task failure', { status }))
    await expect(f.queue.read(QUEUE, REQUEST, freshSignal()))
      .rejects.toMatchObject({ code: 'VIDEO_QUEUE_READ_UNAVAILABLE', queueId: QUEUE })
    expect(f.calls.filter(call => call.method === 'POST')).toEqual([])
  })

  it.each([401, 403, 404, 409])('does not classify original queue HTTP%s as a transient read failure', async (status) => {
    const f = await fixture(() => response({ error: { code: 'private_business_error' } }, status))
    await expect(f.queue.read(QUEUE, REQUEST, freshSignal()))
      .rejects.toMatchObject({ code: 'VIDEO_QUEUE_RESPONSE_INVALID', queueId: QUEUE })
    expect(f.calls.filter(call => call.method === 'POST')).toEqual([])
  })

  it('confirms cancellation only for the original canceled and unsubmitted queue item', async () => {
    const f = await fixture(() => response(receipt('canceled')))
    expect(await f.queue.cancel(QUEUE, REQUEST, freshSignal())).toMatchObject({ state: 'canceled', submissionState: 'not_submitted', cancelable: false })
    expect(f.calls.at(-1)).toMatchObject({ method: 'POST', path: `/harness/v1/video/queue/${QUEUE}/cancel`, body: undefined })
  })

  it('does not claim cancellation, slot release or refund for a dispatch conflict', async () => {
    const f = await fixture(() => response({ error: { code: 'video_queue_already_dispatching' } }, 409))
    const error = await f.queue.cancel(QUEUE, REQUEST, freshSignal()).catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'VIDEO_QUEUE_ALREADY_DISPATCHING', queueId: QUEUE })
    expect(String(error)).toContain('未确认取消')
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('does not infer dispatching from a different or malformed cancel conflict', async () => {
    const f = await fixture(() => response({ error: { code: 'another_conflict' } }, 409))
    await expect(f.queue.cancel(QUEUE, REQUEST, freshSignal()))
      .rejects.toMatchObject({ code: 'VIDEO_QUEUE_RESPONSE_INVALID', queueId: QUEUE })
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it.each([receipt('running', 'accepted'), receipt('failed', 'accepted'), receipt('unknown', 'unknown')])(
    'does not claim a successful cancel from a non-canceled receipt', async (value) => {
      const f = await fixture(() => response(value))
      await expect(f.queue.cancel(QUEUE, REQUEST, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_RESPONSE_INVALID', queueId: QUEUE })
    })
})

it('binds original-ID recovery without enabling new admissions or reading capabilities', async () => {
  const f = transport(call => response(receipt(call.path.endsWith('/cancel') ? 'canceled' : 'queued')))
  const recovery = bindVideoServerQueueRecovery({ origin: 'https://queue.example/harness', timeoutMs: 1000,
    fetch: f.fetch, key: async () => 'recovery-key' })
  expect(Object.keys(recovery).toSorted()).toEqual(['cancel', 'pollIntervalMs', 'read'])
  expect(recovery.pollIntervalMs).toBe(15000)
  expect(await recovery.read(QUEUE, REQUEST, freshSignal())).toMatchObject({ state: 'queued' })
  expect(await recovery.cancel(QUEUE, REQUEST, freshSignal())).toMatchObject({ state: 'canceled' })
  expect(f.calls.map(call => [call.method, call.path])).toEqual([
    ['GET', `/harness/v1/video/queue/${QUEUE}`], ['POST', `/harness/v1/video/queue/${QUEUE}/cancel`],
  ])
})

it('rejects a changed gateway task mapping for an already observed original queue', async () => {
  let reads = 0
  const f = await fixture(() => {
    reads += 1
    const body = receipt()
    return response({ ...body, data: { ...body.data,
      task_id: reads === 1 ? body.data.task_id : 'task_abcdefghijklmnopqrstuv1234567890' } })
  })
  await f.queue.read(QUEUE, REQUEST, freshSignal())
  await expect(f.queue.read(QUEUE, REQUEST, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_RESPONSE_INVALID', queueId: QUEUE })
  expect(f.calls.filter(call => call.method === 'POST')).toEqual([])
})

it('awaits acknowledgement-reader cancellation before settling an aborted submission', async () => {
  const reading = Promise.withResolvers<undefined>()
  const cancelStarted = Promise.withResolvers<undefined>()
  const releaseCancel = Promise.withResolvers<undefined>()
  let pulled = false
  const f = await fixture(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!pulled) { pulled = true; controller.enqueue(new TextEncoder().encode('{')); return }
      reading.resolve(undefined)
    },
    async cancel() { cancelStarted.resolve(undefined); await releaseCancel.promise },
  })))
  const stopped = new AbortController()
  let settled = false
  const running = f.queue.submit(REQUEST, SUBMISSION, stopped.signal)
    .catch((error: unknown) => error).finally(() => { settled = true })
  try {
    await reading.promise
    stopped.abort(new Error('fixture cancellation'))
    await cancelStarted.promise
    expect(settled).toBe(false)
    releaseCancel.resolve(undefined)
    expect(await running).toMatchObject({ code: 'VIDEO_QUEUE_SUBMISSION_UNKNOWN', queueId: QUEUE })
    expect(f.calls.map(call => call.method)).toEqual(['GET', 'POST'])
  } finally { stopped.abort(); releaseCancel.resolve(undefined); await running }
})

it('cancels an oversized acknowledgement body before recovering only the original queue ID', async () => {
  let canceled = false
  const f = await fixture(call => call.method === 'POST'
    ? new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_537)) },
      cancel() { canceled = true },
    })) : response(receipt()))
  expect(await f.queue.submit(REQUEST, SUBMISSION, freshSignal())).toMatchObject({ queueId: QUEUE })
  expect(canceled).toBe(true)
  expect(f.calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET'])
})

it('rejects a UTF-8 request body beyond the advertised byte cap before submitting', async () => {
  const f = await fixture()
  const request = { ...REQUEST, prompt: '画'.repeat(22_000) }
  expect(f.queue.supports(request)).toBe(false)
  await expect(f.queue.submit(request, SUBMISSION, freshSignal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_REQUEST_UNSUPPORTED' })
  expect(f.calls).toHaveLength(1)
})

it('uses a real loopback server for lost ACK, restart GET and original queue cancellation with no repeated create', async () => {
  const calls: Call[] = []
  let canceled = false
  const server = createServer((request, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const call: Call = { path: request.url ?? '/', method: request.method ?? 'GET',
        authorization: request.headers.authorization ?? null, body: Buffer.concat(chunks).toString('utf8') }
      calls.push(call)
      if (call.path === '/harness/api/status') {
        outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ data: { video_queue: CAPABILITY } })); return
      }
      if (call.path === '/harness/v1/video/queue' && call.method === 'POST') {
        expect(JSON.parse(call.body ?? '{}')).toEqual({ schema_version: 1, queue_id: QUEUE, operation_id: ATTEMPT, count: 1, request: REQUEST })
        outgoing.destroy(); return
      }
      if (call.path === `/harness/v1/video/queue/${QUEUE}/cancel`) canceled = true
      outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify(receipt(canceled ? 'canceled' : 'queued')))
    })().catch((error: unknown) => { outgoing.destroy(error instanceof Error ? error : undefined) })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected loopback port')
  const options = { origin: `http://127.0.0.1:${String(address.port)}/harness`, timeoutMs: 1000, key: async () => 'loopback-fixture-key' }
  const first = await discoverVideoServerQueue(options, freshSignal())
  if (first === undefined) throw new Error('Queue required')
  expect(await first.submit(REQUEST, SUBMISSION, freshSignal())).toMatchObject({ state: 'queued', queueId: QUEUE })
  const restarted: VideoServerQueue | undefined = await discoverVideoServerQueue(options, freshSignal())
  if (restarted === undefined) throw new Error('Restored queue required')
  expect(await restarted.read(QUEUE, REQUEST, freshSignal())).toMatchObject({ state: 'queued' })
  expect(await restarted.cancel(QUEUE, REQUEST, freshSignal())).toMatchObject({ state: 'canceled' })
  expect(await restarted.read(QUEUE, REQUEST, freshSignal())).toMatchObject({ state: 'canceled' })
  expect(calls.filter(call => call.path === '/harness/v1/video/queue' && call.method === 'POST')).toHaveLength(1)
  expect(calls.filter(call => call.path.endsWith('/cancel') && call.method === 'POST')).toHaveLength(1)
  expect(calls.filter(call => call.authorization !== null).every(call => call.authorization === 'Bearer loopback-fixture-key')).toBe(true)
})
