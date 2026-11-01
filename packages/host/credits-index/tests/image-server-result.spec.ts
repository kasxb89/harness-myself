/** Opted-in original server image recovery through actual Go HTTP response fixtures. */
import { describe, expect, it, vi } from 'vitest'
import { executeImageTask } from '../src/image-task.ts'
import type { CreativeImageReceipt } from '../src/creative-types.ts'
import { imageServerTaskId } from '../src/image-server-task.ts'
import { VideoProjectError } from '../src/video-project.ts'
import fixture from './fixtures/retained-image-http-api-contract.json' with { type: 'json' }

const model = 'codebloom-gpt-image-2k', serverId = 'task_codebloom_http_fixture'
const fingerprint = 'a'.repeat(64)
function response(name: string): Response {
  const value = fixture.cases.find(value => value.name === name)?.response
  if (value === undefined || !('body' in value)) throw new Error('Expected JSON fixture')
  return Response.json(value.body, { status: value.status, headers: Object.fromEntries(Object.entries(value.headers).map(([name, values]) => [name, values.join(', ')])) })
}
function truncated(header = serverId): Response {
  return new Response(new ReadableStream({ start(controller) { controller.error(new Error('private lost-body detail')) } }), {
    headers: header === '' ? {} : { 'X-New-Api-Task-Id': header },
  })
}
function options() {
  return { model, route: '/v1/images/generations', backendFingerprint: fingerprint,
    signal: new AbortController().signal, submitTimeoutMs: 1000, taskTimeoutMs: 1000,
    queryTimeoutMs: 100, pollIntervalMs: 1, queryRetryLimit: 0, serverResultRecovery: true,
    submit: vi.fn(async () => response('synchronous_images_success')),
    read: vi.fn(async () => { throw new Error('No legacy reads for server recovery') }),
    readServerTask: vi.fn(async () => response('owner_task_status')),
    readArtifacts: vi.fn(async () => response('owner_artifact_manifest')),
    resolveArtifactUrl: (taskId: string, key: string, url: string): string | undefined =>
      url.startsWith(`https://gateway.example/harness/v1/tasks/${taskId}/artifacts/${key}/content?access=`) ? url : undefined,
    save: vi.fn(async () => '/artifacts/retained.png'), received: vi.fn(async (_receipt: CreativeImageReceipt) => {}),
    receivedResult: vi.fn(async () => {}),
  }
}

describe('opted-in original server image results', () => {
  it('retains the server header before reading the synchronous result and keeps private local sources', async () => {
    const input = options()
    const result = await executeImageTask(input)
    expect(result).toMatchObject({ submissionState: 'completed', imageReceipt: { serverTaskId: serverId } })
    expect(input.received).toHaveBeenNthCalledWith(2, expect.objectContaining({ phase: 'accepted', serverTaskId: serverId }))
    expect(input.receivedResult).toHaveBeenCalledOnce()
    expect(input.readServerTask).not.toHaveBeenCalled()
    expect(input.readArtifacts).not.toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it('recovers the original retained task after a response body breaks without another generation', async () => {
    const input = { ...options(), submit: vi.fn(async () => truncated()) }
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'completed', serverTaskId: serverId,
      imageReceipt: { serverTaskId: serverId }, paths: ['/artifacts/retained.png'] })
    expect(input.readServerTask).toHaveBeenCalledExactlyOnceWith(serverId, expect.any(AbortSignal))
    expect(input.readArtifacts).toHaveBeenCalledExactlyOnceWith(serverId, expect.any(AbortSignal))
    expect(input.submit).toHaveBeenCalledOnce()
    expect(input.read).not.toHaveBeenCalled()
  })

  it('resumes a serialized original server receipt without requiring a current model opt-in', async () => {
    const input = { ...options(), serverResultRecovery: false,
      resumeReceipt: JSON.parse(JSON.stringify({ route: '/v1/images/generations', model, backendFingerprint: fingerprint,
        phase: 'accepted', serverTaskId: serverId })) as CreativeImageReceipt }
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'completed', serverTaskId: serverId })
    expect(input.submit).not.toHaveBeenCalled()
    expect(input.readServerTask).toHaveBeenCalledOnce()
    expect(input.readArtifacts).toHaveBeenCalledOnce()
  })

  it.each([false, true])('does not recover an undeclared header when opt-in=%s', async (enabled) => {
    const input = { ...options(), serverResultRecovery: enabled, submit: vi.fn(async () => truncated(enabled ? '' : serverId)) }
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'unknown' })
    expect(input.submit).toHaveBeenCalledOnce()
    expect(input.readServerTask).not.toHaveBeenCalled()
    expect(input.readArtifacts).not.toHaveBeenCalled()
  })

  it('retains server identity on cancellation without starting a new read', async () => {
    const controller = new AbortController()
    const input = { ...options(), signal: controller.signal,
      received: vi.fn(async (receipt: CreativeImageReceipt) => { if ('serverTaskId' in receipt) controller.abort() }) }
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', imageReceipt: { serverTaskId: serverId } })
    expect(input.readServerTask).not.toHaveBeenCalled()
    expect(input.readArtifacts).not.toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it.each([404, 429, 503])('keeps the retained task pending on server HTTP%s', async (httpStatus) => {
    const input = { ...options(), submit: vi.fn(async () => truncated()),
      readServerTask: vi.fn(async () => Response.json({ error: 'unavailable' }, { status: httpStatus })) }
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', serverTaskId: serverId })
    expect(input.readArtifacts).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it.each([
    { task_id: 'task_other', artifacts: [] },
    { task_id: serverId, artifacts: [] },
    { task_id: serverId, artifacts: [{ key: 'image-1', type: 'video', content_url: 'https://gateway.example/x' }] },
    { task_id: serverId, artifacts: [{ key: 'image-1', type: 'image', content_url: 'https://another.example/x' }] },
  ])('does not save a mismatched or unavailable manifest %#', async (manifest) => {
    const input = { ...options(), submit: vi.fn(async () => truncated()), readArtifacts: vi.fn(async () => Response.json(manifest)) }
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', serverTaskId: serverId })
    expect(input.save).not.toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it.each(['UNKNOWN', 'FAILURE'])('does not infer settlement from an unproved %s status', async (status) => {
    const input = { ...options(), submit: vi.fn(async () => truncated()),
      readServerTask: vi.fn(async () => Response.json({ model, task_id: serverId, status })) }
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', serverTaskId: serverId })
    expect(input.readArtifacts).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
  })

  it.each([{ task_id: 'task_another', model }, { task_id: serverId, model: 'another-model' }])(
    'rejects a different original task or model %#', async (identity) => {
      const input = { ...options(), submit: vi.fn(async () => truncated()),
        readServerTask: vi.fn(async () => Response.json({ ...identity, status: 'SUCCESS' })) }
      expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', serverTaskId: serverId })
      expect(input.readArtifacts).not.toHaveBeenCalled()
      expect(input.save).not.toHaveBeenCalled()
    },
  )

  it.each(['sk-private', 'task_', 'task_../bad', 'https://other.example/task'])('ignores an unsafe server header %s', async (header) => {
    const input = { ...options(), submit: vi.fn(async () => truncated(header)) }
    const result = await executeImageTask(input)
    expect(result).toMatchObject({ submissionState: 'unknown' })
    expect(result).not.toHaveProperty('serverTaskId')
    expect(input.readServerTask).not.toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledOnce()
  })

  it('keeps a retained task pending when no safe artifact URL resolver is installed', async () => {
    const { resolveArtifactUrl: _resolver, ...base } = options()
    const input = { ...base, submit: vi.fn(async () => truncated()) }
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', serverTaskId: serverId })
    expect(input.readServerTask).not.toHaveBeenCalled()
    expect(input.save).not.toHaveBeenCalled()
  })

  it('preserves an accepted header but cancels the body if durable receipt writing fails', async () => {
    const cancel = vi.fn()
    const input = { ...options(),
      submit: vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'X-New-Api-Task-Id': serverId } })),
      received: vi.fn(async (value: CreativeImageReceipt) => { if (value.serverTaskId !== undefined) throw new Error('disk unavailable') }) }
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'pending', serverTaskId: serverId,
      code: 'IMAGE_RECEIPT_UNAVAILABLE' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(input.readServerTask).not.toHaveBeenCalled()
  })

  it('refreshes expired local URLs through the same retained task and keeps save checkpoints', async () => {
    const id = imageServerTaskId(serverId)
    if (id === undefined) throw new Error('Expected admitted server fixture')
    const receipt: CreativeImageReceipt = { model, route: '/v1/images/generations', phase: 'accepted',
      serverTaskId: id, backendFingerprint: fingerprint }
    const input = { ...options(), resumeReceipt: receipt,
      resumeResult: { receipt, items: [{ url: 'https://expired.example/original' }], saved: [] },
      save: vi.fn(async (value: Record<string, unknown>) => {
        if (value.url === 'https://expired.example/original') throw new VideoProjectError('IMAGE_DOWNLOAD_UNAVAILABLE', 'expired')
        return '/artifacts/refreshed.png'
      }) }
    expect(await executeImageTask(input)).toMatchObject({ submissionState: 'completed', serverTaskId: serverId })
    expect(input.readServerTask).toHaveBeenCalledOnce()
    expect(input.readArtifacts).toHaveBeenCalledOnce()
    expect(input.submit).not.toHaveBeenCalled()
    expect(input.receivedResult).not.toHaveBeenCalled()
    expect(input.save).toHaveBeenCalledTimes(2)
  })
})
