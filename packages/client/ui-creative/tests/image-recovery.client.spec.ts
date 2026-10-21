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
const payload = (projects = [retained], accountId = 'account-a') => ({ accountId, projects })
const controllers: CreativeController[] = []
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose()
  vi.unstubAllGlobals(); vi.useRealTimers()
})

describe('original image query transport', () => {
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
})
