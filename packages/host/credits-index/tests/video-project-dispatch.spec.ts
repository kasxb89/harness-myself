/** Verify the project boundary between durable server admission and original-ID legacy recovery. */
import { describe, expect, it, vi } from 'vitest'
import { createVideoProjectDispatch } from '../src/video-project-dispatch.ts'
import type { VideoProjectAttemptId } from '../src/video-project.ts'
import type { VideoProjectRequest, VideoProjectSubmission } from '../src/video-project-types.ts'
import type { VideoProjectRelay } from '../src/video-project-provider.ts'

const attempt = '11111111-1111-4111-8111-111111111111'
const queueId = `vq_${attempt}`
const gatewayId = 'task_0123456789abcdef0123456789abcdef'
const request: VideoProjectRequest = { model: 'MiniMax-H3', prompt: 'A quiet mountain valley', seconds: '10' }
const submission: VideoProjectSubmission = { attemptId: attempt as VideoProjectAttemptId, durationSeconds: 10, count: 1 }
const capability = {
  schema_version: 1, enabled: true, create_path: '/v1/video/queue',
  retrieve_path_template: '/v1/video/queue/:queue_id', cancel_path_template: '/v1/video/queue/:queue_id/cancel',
  max_count_per_item: 1, body_max_bytes: 65536, poll_interval_seconds: 15, client_generated_id: true,
  queued_charge_reserved: false, lost_ack_recovery_method: 'GET',
}
const signal = (): AbortSignal => new AbortController().signal
function receipt(state = 'queued', submissionState = 'not_submitted', timedOut = false) {
  return { schema_version: 1, object: 'video_queue_item', accepted: true,
    data: { id: queueId, operation_id: attempt, model: request.model, count: 1, duration_seconds: 10,
      task_id: gatewayId, state, submission_state: submissionState, created_at: 1, updated_at: 2 },
    cancelable: state === 'queued', observation_timed_out: timedOut,
    recovery: { method: 'GET', path: `/v1/video/queue/${queueId}` } }
}
function response(body: unknown, status = 200) { return Response.json(body, { status }) }
interface Call { path: string; method: string; body: string | undefined; clientSource: string | null }
function fixture(handler?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    const call = { path: new URL(url).pathname, method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined, clientSource: new Headers(init?.headers).get('x-yunshu-client') }
    calls.push(call)
    return handler === undefined ? response(call.path.endsWith('/api/status') ? { data: { video_queue: capability } } : receipt()) : handler(call)
  }
  const relay = {
    modelIds: vi.fn<VideoProjectRelay['modelIds']>(async () => []),
    submit: vi.fn<VideoProjectRelay['submit']>(async () => ({ taskId: 'legacy-task' })),
    check: vi.fn<VideoProjectRelay['check']>(async () => ({ status: 'running' })),
    download: vi.fn<VideoProjectRelay['download']>(async () => { /* Download target belongs to the caller. */ }),
  }
  const route = vi.fn(async () => '/v1/videos')
  const dispatch = createVideoProjectDispatch({ relay, route,
    queue: { origin: 'https://queue.example/harness', timeoutMs: 1000, key: async () => 'synthetic-user-key', clientSource: 'desktop', fetch } })
  return { dispatch, relay, route, calls }
}

describe('video project gateway dispatch', () => {
  it('uses the unchanged legacy request only when new queue capability is explicitly absent', async () => {
    const f = fixture(() => response({ data: {} }))
    await f.dispatch.prepareSubmissions([request], signal())
    expect(f.dispatch.submissionMode).toBeUndefined()
    expect(await f.dispatch.submit(request, signal(), submission)).toEqual({ taskId: 'legacy-task' })
    expect(f.relay.submit).toHaveBeenCalledExactlyOnceWith(request, '/v1/videos', expect.any(AbortSignal))
    expect(f.calls.map(call => call.method)).toEqual(['GET'])
  })

  it('selects durable queue admission after every request has been checked', async () => {
    const f = fixture()
    await f.dispatch.prepareSubmissions([request], signal())
    expect(f.dispatch.submissionMode).toBe('queued')
    expect(f.dispatch.pollIntervalMs).toBe(15000)
    expect(await f.dispatch.submit(request, signal(), submission)).toEqual({ taskId: queueId })
    expect(JSON.parse(f.calls[1]?.body ?? '{}')).toEqual({ schema_version: 1, queue_id: queueId,
      operation_id: attempt, count: 1, request })
    expect(f.relay.submit).not.toHaveBeenCalled()
    expect(f.calls.map(call => call.clientSource)).toEqual([null, 'desktop'])
  })

  it('chooses legacy for the entire project before its first POST if one shot has local material', async () => {
    const f = fixture()
    const local: VideoProjectRequest = { ...request, __yunshu_files: [{ data: 'original-snapshot', name: 'ref.png' }] }
    await f.dispatch.prepareSubmissions([request, local], signal())
    expect(f.dispatch.submissionMode).toBeUndefined()
    await f.dispatch.submit(request, signal(), submission)
    await f.dispatch.submit(local, signal(), submission)
    expect(f.relay.submit.mock.calls.map(call => call[0])).toEqual([request, local])
    expect(f.calls.filter(call => call.method === 'POST')).toEqual([])
  })

  it('does not fall back on an invalid capability or before transport preparation', async () => {
    const f = fixture(() => response({ data: { video_queue: { ...capability, create_path: '/elsewhere' } } }))
    await expect(f.dispatch.submit(request, signal(), submission)).rejects.toMatchObject({ code: 'VIDEO_REQUEST_INVALID' })
    await expect(f.dispatch.prepareSubmissions([request], signal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_CAPABILITY_INVALID' })
    expect(f.relay.submit).not.toHaveBeenCalled()
    expect(f.calls.map(call => call.method)).toEqual(['GET'])
  })

  it.each([
    ['queued', 'not_submitted', 'queued'], ['dispatching', 'dispatching', 'queued'],
    ['running', 'accepted', 'running'], ['succeeded', 'accepted', 'succeeded'],
    ['failed', 'not_submitted', 'failed'], ['failed', 'accepted', 'failed'], ['canceled', 'not_submitted', 'failed'],
  ])('reads the original queue %s without discovery or resubmission', async (state, submitted, expected) => {
    const f = fixture(() => response(receipt(state, submitted)))
    expect(await f.dispatch.check(queueId, request, signal())).toMatchObject({ status: expected })
    expect(f.calls.map(call => [call.method, call.path])).toEqual([['GET', `/harness/v1/video/queue/${queueId}`]])
    expect(f.route).not.toHaveBeenCalled()
    expect(f.relay.submit).not.toHaveBeenCalled()
    expect(f.dispatch.pollIntervalMs).toBe(15000)
  })

  it.each([false, true])('keeps an uncertain server dispatch pending when observationTimedOut=%s', async (timedOut) => {
    const f = fixture(() => response(receipt('dispatching', 'unknown', timedOut)))
    await expect(f.dispatch.check(queueId, request, signal())).rejects.toMatchObject({ code: 'VIDEO_READ_UNAVAILABLE', taskId: queueId })
    expect(f.relay.submit).not.toHaveBeenCalled()
  })

  it('reads a retained legacy gateway task even when its old model is absent from the new-work catalog', async () => {
    const f = fixture()
    f.route.mockRejectedValue(new Error('old model is no longer advertised'))
    expect(await f.dispatch.check(gatewayId, { ...request, model: 'retired-model' }, signal())).toEqual({ status: 'running' })
    expect(f.route).not.toHaveBeenCalled()
    expect(f.relay.check).toHaveBeenCalledExactlyOnceWith(gatewayId, '/v1/tasks', expect.any(AbortSignal), 'retired-model')
    expect(f.calls).toEqual([])
  })

  it('retains the legacy route fallback for noncanonical provider task IDs', async () => {
    const f = fixture()
    await f.dispatch.check('task_legacy-provider', request, signal())
    expect(f.route).toHaveBeenCalledExactlyOnceWith(request)
    expect(f.relay.check).toHaveBeenCalledExactlyOnceWith('task_legacy-provider', '/v1/videos', expect.any(AbortSignal), request.model)
  })

  it('downloads only the verified original gateway task through the existing bounded relay', async () => {
    const f = fixture(() => response(receipt('succeeded', 'accepted')))
    await f.dispatch.download(queueId, request, '/owned/clip.mp4', signal())
    expect(f.relay.download).toHaveBeenCalledExactlyOnceWith(gatewayId, '/owned/clip.mp4', expect.any(AbortSignal))
    expect(f.relay.submit).not.toHaveBeenCalled()
  })

  it('recovers a lost ACK using the same queue GET and never a legacy or second create POST', async () => {
    const f = fixture((call) => {
      if (call.path.endsWith('/api/status')) return response({ data: { video_queue: capability } })
      if (call.method === 'POST') throw new Error('synthetic lost ACK')
      return response(receipt())
    })
    await f.dispatch.prepareSubmissions([request], signal())
    expect(await f.dispatch.submit(request, signal(), submission)).toEqual({ taskId: queueId })
    expect(f.calls.map(call => [call.method, call.path])).toEqual([
      ['GET', '/harness/api/status'], ['POST', '/harness/v1/video/queue'], ['GET', `/harness/v1/video/queue/${queueId}`],
    ])
    expect(f.relay.submit).not.toHaveBeenCalled()
  })

  it('retains the deterministic queue ID if neither the ACK nor original GET can be confirmed', async () => {
    const f = fixture(call => call.path.endsWith('/api/status')
      ? response({ data: { video_queue: capability } }) : response({ error: 'synthetic disconnect' }, 503))
    await f.dispatch.prepareSubmissions([request], signal())
    await expect(f.dispatch.submit(request, signal(), submission)).rejects.toMatchObject({ code: 'VIDEO_SUBMIT_UNKNOWN', taskId: queueId })
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(f.relay.submit).not.toHaveBeenCalled()
  })

  it('confirms only an original queue cancellation before dispatch and preserves conflicts', async () => {
    const f = fixture(() => response(receipt('canceled', 'not_submitted')))
    expect(await f.dispatch.cancel(queueId, request, signal())).toEqual({ canceled: true })
    expect(await f.dispatch.cancel(gatewayId, request, signal())).toEqual({ canceled: false })
    expect(f.calls.map(call => call.path)).toEqual([`/harness/v1/video/queue/${queueId}/cancel`])
    const conflict = fixture(() => response({ error: { code: 'video_queue_already_dispatching' } }, 409))
    await expect(conflict.dispatch.cancel(queueId, request, signal())).rejects.toMatchObject({ code: 'VIDEO_QUEUE_ALREADY_DISPATCHING' })
    expect(conflict.relay.submit).not.toHaveBeenCalled()
  })
})
