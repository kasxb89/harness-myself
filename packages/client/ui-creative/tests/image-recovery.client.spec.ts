import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { readCreativeProjects, recoverCreativeImage, type ReadCreativeProjects } from '../src/client/api.ts'
import { CreativeController } from '../src/client/controller.ts'
import { project } from './fixtures.ts'

const SESSION = 'session-a' as SessionId
const receipt = { route: '/toapis-image/submit', model: 'image-model', phase: 'accepted' as const,
  taskId: 'original-task', requestId: 'original-request', backendFingerprint: 'a'.repeat(64) }
const task = { id: 'op_original', status: 'unknown' as const, shotIds: ['s1'], completedShots: 0, totalShots: 1,
  outputs: [], imageReceipt: receipt, canQuery: true }
const retained = project({ kind: 'image', status: 'unknown', tasks: [task],
  shots: project().shots.map(shot => ({ ...shot, status: 'unknown' })) })
const videoReceipt = { ...receipt, route: '/blackrx/v1/videos', model: 'sora-2' }
const videoTask = { id: 'op_video', status: 'unknown' as const, shotIds: ['s1'], completedShots: 0, totalShots: 1,
  outputs: [], videoReceipt, canQuery: true }
const retainedVideo = project({ kind: 'video', status: 'unknown', tasks: [videoTask],
  shots: project().shots.map(shot => ({ ...shot, status: 'unknown' })) })
const payload = (projects = [retained], accountId = 'account-a') => ({ accountId, projects })
const controllers: CreativeController[] = []
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose()
  vi.unstubAllGlobals(); vi.useRealTimers()
})

describe('original image query transport', () => {
  it.each(['submitting', 'completed'] as const)(
    'accepts owner-projected %s save-only recovery without inventing a provider task id or sending source data', async (phase) => {
      const original = { id: 'op_saved_result', status: 'unknown' as const, shotIds: ['s1'], completedShots: 0, totalShots: 1,
        outputs: [], imageReceipt: { route: receipt.route, model: receipt.model, phase,
          requestId: receipt.requestId, backendFingerprint: receipt.backendFingerprint }, canQuery: true, recovery: 'image-result' as const }
      const data = project({ kind: 'image', status: 'unknown', tasks: [original] })
      const wire = payload([data])
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, payload: wire }, { status: 202 }))
      vi.stubGlobal('fetch', fetcher)
      expect(await readCreativeProjects(SESSION, new AbortController().signal)).toEqual({ ok: true, payload: wire })
      const signal = new AbortController().signal
      expect(await recoverCreativeImage({ sessionId: SESSION, projectId: data.id, operationId: original.id }, signal))
        .toEqual({ ok: true, payload: wire })
      expect(fetcher).toHaveBeenLastCalledWith('/credits/api/creative/image/recover', expect.objectContaining({
        method: 'POST', signal, body: JSON.stringify({ session_id: SESSION, project_id: data.id, operation_id: original.id }),
      }))
      expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/task_id|prompt|b64_json|imageResultRef|signature=/u)
      expect(original.imageReceipt).not.toHaveProperty('taskId')
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    { recovery: 'invented-mode' },
    { recovery: 'image-result', imageReceipt: undefined },
    { recovery: 'image-result', imageReceipt: { ...receipt, phase: 'submitting' } },
    { recovery: 'image-result', imageReceipt: { ...receipt, taskId: undefined } },
    { recovery: 'image-result', imageReceipt: undefined, videoReceipt },
    { recovery: 'image-result', videoReceipt },
    { recovery: undefined },
  ])('rejects an unproven or inconsistent no-task-id save action: %j', async (change) => {
    const noTask = { route: receipt.route, model: receipt.model, phase: 'submitting', requestId: receipt.requestId,
      backendFingerprint: receipt.backendFingerprint }
    const original = { ...task, imageReceipt: noTask, canQuery: true, ...change }
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true,
      payload: { accountId: 'account-a', projects: [{ ...retained, tasks: [original] }] } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await readCreativeProjects(SESSION, new AbortController().signal)).toEqual({ ok: false, code: 'invalid' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each(['image', 'video'] as const)('retains the exact generating origin on the %s receipt', async (kind) => {
    const origin = { sessionId: SESSION, turn: 3, eventSeq: 21, toolCallId: 'call_origin' }
    const original = kind === 'image' ? { ...task, imageReceipt: { ...receipt, origin } }
      : { ...videoTask, videoReceipt: { ...videoReceipt, origin } }
    const data = { ...retained, kind, tasks: [original] }
    const wire = { accountId: 'account-a', projects: [data] }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, payload: wire })))
    expect(await readCreativeProjects(SESSION, new AbortController().signal)).toEqual({ ok: true, payload: wire })
  })

  it.each([
    'malformed',
    { sessionId: 'another-session', turn: 3 },
    { sessionId: SESSION, turn: -1 },
    { sessionId: SESSION, turn: 3, eventSeq: 1.5 },
    { sessionId: SESSION, turn: 3, toolCallId: 7 },
  ])('rejects malformed or cross-conversation generating origins in a receipt', async (origin) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true,
      payload: { accountId: 'account-a', projects: [{ ...retainedVideo,
        tasks: [{ ...videoTask, videoReceipt: { ...videoReceipt, origin } }] }] } })))
    expect(await readCreativeProjects(SESSION, new AbortController().signal)).toEqual({ ok: false, code: 'invalid' })
  })

  it('sends only retained coordinates to recovery and accepts its 202 listing without generation or retry', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, payload: payload() }, { status: 202 }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await recoverCreativeImage({ sessionId: SESSION, projectId: retained.id, operationId: task.id }, signal))
      .toEqual({ ok: true, payload: payload() })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/credits/api/creative/image/recover', expect.objectContaining({
      method: 'POST', signal, credentials: 'same-origin', cache: 'no-store',
      body: JSON.stringify({ session_id: SESSION, project_id: retained.id, operation_id: task.id }),
    }))
  })

  it.each([
    { imageReceipt: { ...receipt, phase: ['accepted'] } },
    { imageReceipt: { ...receipt, taskId: undefined } },
    { imageReceipt: { ...receipt, requestId: 'sk-private-credential' } },
    { imageReceipt: { ...receipt, route: '/a/../submit' } },
    { imageReceipt: { ...receipt, backendFingerprint: 'private-location' } },
    { imageReceipt: undefined, canQuery: true }, { canQuery: 'yes' },
  ])('rejects malformed or credential-like query receipts at the wire parser', async (change) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true,
      payload: { accountId: 'account-a', projects: [{ ...retained, tasks: [{ ...task, ...change }] }] } })))
    expect(await readCreativeProjects(SESSION, new AbortController().signal)).toEqual({ ok: false, code: 'invalid' })
  })

  it('contains rejection, sign-out, malformed ownership and transport errors without a second attempt', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: true, payload: payload([{ ...retained, sessionId: 'another-session' }]) }, { status: 202 }))
      .mockRejectedValueOnce(new Error('private transport error'))
    vi.stubGlobal('fetch', fetcher)
    const request = { sessionId: SESSION, projectId: retained.id, operationId: task.id }
    const signal = new AbortController().signal
    for (const code of ['rejected', 'signed-out', 'invalid', 'unavailable']) {
      expect(await recoverCreativeImage(request, signal)).toEqual({ ok: false, code })
    }
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('queries video through the same owner-validated admission protocol without generating', async () => {
    const accepted = { ...retainedVideo, tasks: [{ ...videoTask, status: 'running' as const, canQuery: false }] }
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, payload: payload([accepted]) }, { status: 202 }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await recoverCreativeImage({ sessionId: SESSION, projectId: retainedVideo.id, operationId: videoTask.id, kind: 'video' }, signal))
      .toEqual({ ok: true, payload: payload([accepted]) })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/credits/api/creative/video/recover', expect.objectContaining({
      method: 'POST', signal, credentials: 'same-origin', cache: 'no-store',
      body: JSON.stringify({ session_id: SESSION, project_id: retainedVideo.id, operation_id: videoTask.id }),
    }))
  })

  it.each([
    { videoReceipt: { ...videoReceipt, taskId: undefined } },
    { videoReceipt: { ...videoReceipt, phase: ['accepted'] } },
    { videoReceipt: { ...videoReceipt, requestId: 'sk-private-credential' } },
    { videoReceipt: { ...videoReceipt, route: 'https://private.example/task' } },
    { videoReceipt: { ...videoReceipt, route: '/blackrx/../videos' } },
    { videoReceipt: { ...videoReceipt, backendFingerprint: 'private-origin' } },
    { videoReceipt: { ...videoReceipt, phase: 'submitting', taskId: undefined } },
    { videoReceipt: undefined },
    { imageReceipt: receipt },
    { imageReceipt: receipt, canQuery: false },
  ])('rejects unsafe, ambiguous or unqueryable video receipts in the project listing', async (change) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true,
      payload: { accountId: 'account-a', projects: [{ ...retainedVideo, tasks: [{ ...videoTask, ...change }] }] } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await readCreativeProjects(SESSION, new AbortController().signal)).toEqual({ ok: false, code: 'invalid' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a video admission without an owned listing and discards mismatched Session data', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, admitted: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, payload: payload([{ ...retainedVideo, sessionId: 'other-session' }]) }, { status: 202 }))
    vi.stubGlobal('fetch', fetcher)
    const request = { sessionId: SESSION, projectId: retainedVideo.id, operationId: videoTask.id, kind: 'video' as const }
    for (let index = 0; index < 2; index++) {
      expect(await recoverCreativeImage(request, new AbortController().signal)).toEqual({ ok: false, code: 'invalid' })
    }
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/credits/api/creative/video/recover', '/credits/api/creative/video/recover',
    ])
  })
})

describe('original query ownership and read supervision', () => {
  async function start(data = retained) {
    const read = vi.fn<ReadCreativeProjects>().mockResolvedValue({ ok: true, payload: payload([data]) })
    const controller = new CreativeController(read, { pollIntervalMs: 2000, reveal: () => true })
    controllers.push(controller)
    controller.accountChanged('account-a'); controller.select(SESSION)
    await controller.refresh(SESSION)
    await Promise.resolve()
    controller.watch(SESSION, true, new AbortController().signal)
    await controller.refresh(SESSION)
    await Promise.resolve()
    return { controller, read }
  }

  it('publishes the accepted listing, polls active task state and stops after the original result settles', async () => {
    vi.useFakeTimers()
    const { controller, read } = await start()
    const active = { ...retained, tasks: [{ ...task, status: 'running' as const, canQuery: false }] }
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, payload: payload([active]) }, { status: 202 }))
    vi.stubGlobal('fetch', fetcher)
    expect((await controller.recover(SESSION, retained.id, task.id, new AbortController().signal)).ok).toBe(true)
    expect(controller.source(SESSION).getSnapshot()).toMatchObject({ selectedProjectId: retained.id,
      projects: [{ tasks: [{ status: 'running', canQuery: false }] }] })
    read.mockResolvedValue({ ok: true, payload: payload([{ ...retained, status: 'completed',
      tasks: [{ ...task, status: 'completed', canQuery: false }], shots: [] }]) })
    const before = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(before + 1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledTimes(before + 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not query legacy unknown work and discards a late accepted result after sign-out', async () => {
    const { imageReceipt: _receipt, canQuery: _canQuery, ...legacy } = task
    const { controller } = await start({ ...retained, tasks: [task, { ...legacy, id: 'op_legacy' }] })
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    expect(await controller.recover(SESSION, retained.id, 'missing-operation', new AbortController().signal))
      .toEqual({ ok: false, code: 'rejected' })
    expect(await controller.recover(SESSION, retained.id, 'op_legacy', new AbortController().signal))
      .toEqual({ ok: false, code: 'rejected' })
    expect(fetcher).not.toHaveBeenCalled()
    let finish!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = controller.recover(SESSION, retained.id, task.id, new AbortController().signal)
    controller.accountChanged(null)
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    finish(Response.json({ ok: true, payload: payload() }, { status: 202 }))
    expect(await pending).toEqual({ ok: false, code: 'signed-out' })
    expect(controller.source(SESSION).getSnapshot().projects).toEqual([])
  })

  it('keeps late pre-query reads out of accepted task state and suspends polling while hidden', async () => {
    vi.useFakeTimers()
    const { controller, read } = await start()
    let finishRead!: (value: Awaited<ReturnType<ReadCreativeProjects>>) => void
    read.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve }))
    const oldRead = controller.refresh(SESSION)
    const active = { ...retained, tasks: [{ ...task, status: 'running' as const, canQuery: false }] }
    let finishQuery!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => new Promise((resolve) => { finishQuery = resolve })))
    const recovery = controller.recover(SESSION, retained.id, task.id, new AbortController().signal)
    controller.setForeground(false)
    finishQuery(Response.json({ ok: true, payload: payload([active]) }, { status: 202 }))
    expect((await recovery).ok).toBe(true)
    finishRead({ ok: true, payload: payload() })
    await oldRead
    expect(controller.source(SESSION).getSnapshot().projects[0]?.tasks[0]?.canQuery).toBe(false)
    const before = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledTimes(before)
  })

  it.each([
    { data: retainedVideo, original: videoTask, route: 'video' },
    { data: { ...retained, kind: 'video' as const }, original: task, route: 'image' },
  ])('chooses $route recovery from the original task receipt inside a video plan', async ({ data, original, route }) => {
    vi.useFakeTimers()
    const { controller, read } = await start(data)
    const active = { ...data, tasks: [{ ...original, status: 'running' as const, canQuery: false }] }
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, payload: payload([active]) }, { status: 202 }))
    vi.stubGlobal('fetch', fetcher)
    expect((await controller.recover(SESSION, data.id, original.id, new AbortController().signal)).ok).toBe(true)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/credits/api/creative/${route}/recover`, expect.objectContaining({ method: 'POST' }))
    expect(controller.source(SESSION).getSnapshot().projects[0]?.tasks[0])
      .toMatchObject({ id: original.id, status: 'running', canQuery: false })
    read.mockResolvedValue({ ok: true, payload: payload([{ ...data, status: 'completed', shots: [],
      tasks: [{ ...original, status: 'completed', canQuery: false }] }]) })
    const before = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(before + 1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledTimes(before + 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['sign-out', 'Session switch'] as const)('ignores delayed video admission after %s and aborts its request', async (change) => {
    const { controller } = await start(retainedVideo)
    const reply = Promise.withResolvers<Response>()
    const fetcher = vi.fn<typeof fetch>(() => reply.promise)
    vi.stubGlobal('fetch', fetcher)
    const pending = controller.recover(SESSION, retainedVideo.id, videoTask.id, new AbortController().signal)
    if (change === 'sign-out') controller.accountChanged(null)
    else controller.select('other-session' as SessionId)
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    reply.resolve(Response.json({ ok: true, payload: payload([{ ...retainedVideo,
      tasks: [{ ...videoTask, status: 'running', canQuery: false }] }]) }, { status: 202 }))
    expect(await pending).toEqual({ ok: false, code: 'signed-out' })
    expect(controller.source(SESSION).getSnapshot().projects[0]?.tasks[0]?.status).not.toBe('running')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
