/** Actual API httptest responses to the unchanged client serializer body; no provider or paid network calls. */
import { describe, expect, it } from 'vitest'
import { bindVideoServerQueueRecovery, discoverVideoServerQueue } from '../src/video-server-queue.ts'
import type { VideoProjectAttemptId } from '../src/video-project.ts'
import create from './fixtures/server-video-queue-api/client-queue-create-request.json' with { type: 'json' }
import ack from './fixtures/server-video-queue-api/API-queue-ack.json' with { type: 'json' }
import original from './fixtures/server-video-queue-api/API-queue-get.json' with { type: 'json' }
import canceled from './fixtures/server-video-queue-api/API-queue-cancel.json' with { type: 'json' }
import canceledGet from './fixtures/server-video-queue-api/API-queue-canceled-get.json' with { type: 'json' }

const signal = (): AbortSignal => new AbortController().signal
const capability = { schema_version: 1, enabled: true, create_path: '/v1/video/queue',
  retrieve_path_template: '/v1/video/queue/:queue_id', cancel_path_template: '/v1/video/queue/:queue_id/cancel',
  max_count_per_item: 1, body_max_bytes: 65536, poll_interval_seconds: 15, client_generated_id: true,
  queued_charge_reserved: false, lost_ack_recovery_method: 'GET' }

describe('actual API queue response interoperability', () => {
  it.each([false, true])('consumes the real acknowledgement or original GET after lost ACK=%s', async (lost) => {
    const calls: { path: string; method: string }[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      const path = new URL(url).pathname
      calls.push({ path, method: init?.method ?? 'GET' })
      if (path === '/harness/api/status') return Response.json({ data: { video_queue: capability } })
      if (init?.method === 'POST') {
        expect(typeof init.body === 'string' ? JSON.parse(init.body) : undefined).toEqual(create)
        if (lost) throw new Error('synthetic acknowledgement loss after real fixture acceptance')
        return Response.json(ack, { status: 202 })
      }
      return Response.json(original)
    }
    const queue = await discoverVideoServerQueue({ origin: 'https://synthetic.example/harness', timeoutMs: 1000,
      key: async () => 'synthetic-user-key', fetch }, signal())
    if (queue === undefined) throw new Error('Explicit queue schema is required')
    expect(await queue.submit(create.request, { attemptId: create.operation_id as VideoProjectAttemptId,
      durationSeconds: 10, count: 1 }, signal())).toMatchObject({ queueId: create.queue_id,
      gatewayTaskId: ack.data.task_id, state: 'queued', submissionState: 'not_submitted', cancelable: true })
    expect(calls.filter(call => call.method === 'POST')).toEqual([{ path: '/harness/v1/video/queue', method: 'POST' }])
    expect(calls.filter(call => call.method === 'GET').map(call => call.path)).toEqual([
      '/harness/api/status', ...lost ? [`/harness/v1/video/queue/${create.queue_id}`] : [],
    ])
  })

  it('recovers and cancels the actual original item across client rebinding without new capability discovery', async () => {
    const calls: string[] = []
    const options = { origin: 'https://synthetic.example/harness', timeoutMs: 1000, key: async () => 'synthetic-user-key',
      fetch: (async (input, init) => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        const path = new URL(url).pathname
        calls.push(`${init?.method ?? 'GET'} ${path}`)
        return Response.json(init?.method === 'POST' ? canceled : calls.length > 2 ? canceledGet : original)
      }) satisfies typeof globalThis.fetch }
    const first = bindVideoServerQueueRecovery(options)
    expect(await first.read(create.queue_id, create.request, signal())).toMatchObject({ state: 'queued', gatewayTaskId: ack.data.task_id })
    const restarted = bindVideoServerQueueRecovery(options)
    expect(await restarted.cancel(create.queue_id, create.request, signal())).toMatchObject({ state: 'canceled', submissionState: 'not_submitted' })
    expect(await restarted.read(create.queue_id, create.request, signal())).toMatchObject({ state: 'canceled', gatewayTaskId: ack.data.task_id })
    expect(calls).toEqual([`GET /harness/v1/video/queue/${create.queue_id}`,
      `POST /harness/v1/video/queue/${create.queue_id}/cancel`, `GET /harness/v1/video/queue/${create.queue_id}`])
  })
})
