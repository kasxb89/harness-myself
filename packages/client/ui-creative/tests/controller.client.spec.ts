import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreativeReadResult, ReadCreativeProjects } from '../src/client/api.ts'
import { CreativeController } from '../src/client/controller.ts'
import { project } from './fixtures.ts'

const A = 'session-a' as SessionId
const B = 'session-b' as SessionId
const owners: CreativeController[] = []
const pendingReads: { resolve: (value: CreativeReadResult) => void }[] = []
afterEach(async () => {
  for (const read of pendingReads.splice(0)) read.resolve({ ok: false, code: 'unavailable' })
  for (const owner of owners.splice(0)) await owner.dispose()
  vi.useRealTimers()
})

function success(status: 'running' | 'completed' = 'running', accountId = 'account-a'): CreativeReadResult {
  const data = project({ status })
  return { ok: true, payload: { accountId, projects: [{ ...data, shots: data.shots.map(shot => ({ ...shot, status })) }] } }
}
function deferred() {
  let resolve!: (value: CreativeReadResult) => void
  const promise = new Promise<CreativeReadResult>((done) => { resolve = done })
  pendingReads.push({ resolve })
  return { promise, resolve }
}
function owner(read: ReadCreativeProjects) {
  const reveal = vi.fn(() => true)
  const controller = new CreativeController(read, { pollIntervalMs: 2000, reveal })
  owners.push(controller)
  return { controller, reveal }
}
function call(name = 'generate_image', id = 'media-call'): SessionEvent<'tool/call'> {
  return { type: 'tool/call', seq: 1 as SessionEvent['seq'], time: 1,
    data: { turn: 1, step: 1, callId: id as SessionEvent<'tool/call'>['data']['callId'], name, arguments: '{}' } }
}
function result(start: SessionEvent<'tool/call'>): SessionEvent<'tool/result'> {
  return { type: 'tool/result', seq: 2 as SessionEvent['seq'], time: 2, surfaceOp: 'append', data: { turn: 1, step: 1, message: {
    id: 'result-message' as SessionEvent<'tool/result'>['data']['message']['id'], role: 'tool', content: [],
    source: { kind: 'tool', callId: start.data.callId }, toolCallId: start.data.callId,
  } } }
}
const TURN_END: SessionEvent<'turn/end'> = {
  type: 'turn/end', seq: 3 as SessionEvent['seq'], time: 3, data: { turn: 1, reason: { kind: 'completed' } },
}

describe('creative read ownership', () => {
  it('waits for an authoritative account, opens real projects only once, and retains data on read failure', async () => {
    const read = vi.fn<ReadCreativeProjects>().mockResolvedValue(success())
    const { controller, reveal } = owner(read)
    const source = controller.source(A)
    expect(controller.source(A)).toBe(source)
    controller.select(A)
    await controller.refresh(A)
    expect(read).not.toHaveBeenCalled()
    controller.accountChanged('account-a')
    await read.mock.results[0]!.value
    expect(source.getSnapshot().projects).toHaveLength(1)
    expect(reveal).toHaveBeenCalledExactlyOnceWith(A)
    await controller.refresh(A)
    expect(reveal).toHaveBeenCalledOnce()
    read.mockResolvedValueOnce({ ok: false, code: 'unavailable' })
    await controller.refresh(A)
    expect(source.getSnapshot()).toMatchObject({ phase: 'failed', failure: 'unavailable', projects: [expect.any(Object)] })
  })

  it('keeps an earlier conversation response out of the new conversation after an overlapping selection', async () => {
    const first = deferred()
    const second = deferred()
    const read = vi.fn<ReadCreativeProjects>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { controller, reveal } = owner(read)
    controller.accountChanged('account-a')
    controller.select(A)
    const signalA = read.mock.calls[0]![1]
    controller.select(B)
    expect(signalA.aborted).toBe(true)
    second.resolve(success('completed'))
    await second.promise
    expect(controller.source(B).getSnapshot().projects[0]?.status).toBe('completed')
    first.resolve(success())
    await first.promise
    expect(controller.source(A).getSnapshot().projects).toEqual([])
    expect(reveal).toHaveBeenCalledExactlyOnceWith(B)
  })

  it('clears immediately at logout and rejects late results even after signing back into the same account', async () => {
    const first = deferred()
    const second = deferred()
    const read = vi.fn<ReadCreativeProjects>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { controller, reveal } = owner(read)
    controller.accountChanged('account-a')
    controller.select(A)
    controller.accountChanged(null)
    expect(read.mock.calls[0]![1].aborted).toBe(true)
    expect(controller.source(A).getSnapshot()).toMatchObject({ phase: 'signed-out', projects: [] })
    controller.accountChanged('account-a')
    first.resolve(success())
    await first.promise
    expect(controller.source(A).getSnapshot().projects).toEqual([])
    second.resolve(success('completed'))
    await second.promise
    expect(controller.source(A).getSnapshot().projects[0]?.status).toBe('completed')
    expect(reveal).toHaveBeenCalledOnce()
  })

  it('polls only visible active projects and stops on hide, page background and completion', async () => {
    vi.useFakeTimers()
    const read = vi.fn<ReadCreativeProjects>().mockResolvedValue(success())
    const { controller } = owner(read)
    controller.accountChanged('account-a')
    controller.select(A)
    await read.mock.results[0]!.value
    await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledOnce()
    const visibility = new AbortController()
    const release = controller.watch(A, true, visibility.signal)
    await read.mock.results[1]!.value
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(3)
    release()
    await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledTimes(3)
    controller.watch(A, true, visibility.signal)
    await read.mock.results[3]!.value
    controller.setForeground(false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledTimes(4)
    read.mockResolvedValue(success('completed'))
    controller.setForeground(true)
    await read.mock.results[4]!.value
    await vi.advanceTimersByTimeAsync(8000)
    expect(read).toHaveBeenCalledTimes(5)
    visibility.abort()
  })

  it('coalesces overlapping invalidations and awaits a noncooperative read on disposal without publishing it', async () => {
    const first = deferred()
    const second = deferred()
    const read = vi.fn<ReadCreativeProjects>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { controller, reveal } = owner(read)
    controller.accountChanged('account-a')
    controller.select(A)
    void controller.refresh(A)
    void controller.refresh(A)
    expect(read).toHaveBeenCalledOnce()
    first.resolve(success())
    await first.promise
    expect(read).toHaveBeenCalledTimes(2)
    const before = controller.source(A).getSnapshot().projects
    let disposed = false
    const closing = controller.dispose().then(() => { disposed = true })
    expect(read.mock.calls[1]![1].aborted).toBe(true)
    expect(disposed).toBe(false)
    second.resolve(success('completed'))
    await closing
    expect(disposed).toBe(true)
    expect(controller.source(A).getSnapshot().projects).toBe(before)
    expect(reveal).toHaveBeenCalledOnce()
  })

  it('clears every session after a Host account mismatch or 401 without accepting another account’s media', async () => {
    const read = vi.fn<ReadCreativeProjects>().mockResolvedValueOnce(success()).mockResolvedValueOnce(success('completed', 'account-b'))
    const { controller } = owner(read)
    controller.accountChanged('account-a'); controller.select(A)
    await read.mock.results[0]!.value
    await controller.refresh(A)
    expect(controller.source(A).getSnapshot()).toMatchObject({ phase: 'signed-out', projects: [] })
    read.mockResolvedValueOnce({ ok: false, code: 'signed-out' })
    controller.accountChanged('account-a')
    await read.mock.results[2]!.value
    expect(controller.source(A).getSnapshot().phase).toBe('signed-out')
    await controller.refresh(A)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('supervises real material generation separately from completed shots and stops after its receipt completes', async () => {
    vi.useFakeTimers()
    const data = project({ status: 'completed', shots: [] })
    const material = { ...data.assets[0]!, status: 'running' as const }
    const read = vi.fn<ReadCreativeProjects>().mockResolvedValue({ ok: true, payload: { accountId: 'account-a',
      projects: [{ ...data, assets: [material] }] } })
    const { controller } = owner(read)
    controller.accountChanged('account-a'); controller.select(A)
    await read.mock.results[0]!.value
    const visible = new AbortController()
    controller.watch(A, true, visible.signal)
    await read.mock.results[1]!.value
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(3)
    read.mockResolvedValue({ ok: true, payload: { accountId: 'account-a',
      projects: [{ ...data, assets: [{ ...material, status: 'completed' }] }] } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledTimes(4)
    visible.abort()
  })

  it('finds the first real legacy image project after a tool-call read races its durable registration', async () => {
    vi.useFakeTimers()
    const empty: CreativeReadResult = { ok: true, payload: { accountId: 'account-a', projects: [] } }
    const raced = deferred()
    const read = vi.fn<ReadCreativeProjects>().mockResolvedValueOnce(empty).mockReturnValueOnce(raced.promise)
      .mockResolvedValueOnce(success())
    const { controller, reveal } = owner(read)
    controller.accountChanged('account-a'); controller.select(A)
    await read.mock.results[0]!.value
    controller.observe(A, call())
    expect(read).toHaveBeenCalledTimes(2)
    raced.resolve(empty)
    await raced.promise
    expect(controller.source(A).getSnapshot().projects).toEqual([])
    expect(reveal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1999)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(3)
    expect(controller.source(A).getSnapshot().projects[0]?.status).toBe('running')
    expect(reveal).toHaveBeenCalledExactlyOnceWith(A)
  })

  it.each(['update_creation_plan', 'generate_image', 'generate_video', 'generate_video_project'])(
    'stops empty supervision after the matching %s result', async (name) => {
      vi.useFakeTimers()
      const empty: CreativeReadResult = { ok: true, payload: { accountId: 'account-a', projects: [] } }
      const read = vi.fn<ReadCreativeProjects>().mockResolvedValue(empty)
      const { controller, reveal } = owner(read)
      controller.accountChanged('account-a'); controller.select(A)
      await read.mock.results[0]!.value
      const started = call(name)
      controller.observe(A, started)
      await read.mock.results[1]!.value
      await vi.advanceTimersByTimeAsync(2000)
      expect(read).toHaveBeenCalledTimes(3)
      controller.observe(A, result(started))
      await read.mock.results[3]!.value
      await vi.advanceTimersByTimeAsync(6000)
      expect(read).toHaveBeenCalledTimes(4)
      expect(reveal).not.toHaveBeenCalled()
    },
  )

  it('tracks concurrent media call IDs and ignores unrelated calls and another conversation', async () => {
    vi.useFakeTimers()
    const empty: CreativeReadResult = { ok: true, payload: { accountId: 'account-a', projects: [] } }
    const read = vi.fn<ReadCreativeProjects>().mockResolvedValue(empty)
    const { controller } = owner(read)
    controller.accountChanged('account-a'); controller.select(A)
    await read.mock.results[0]!.value
    controller.observe(A, call('shell'))
    controller.observe(B, call())
    await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledOnce()
    const first = call('generate_image', 'first')
    const second = call('generate_video', 'second')
    controller.observe(A, first)
    await read.mock.results[1]!.value
    controller.observe(A, second)
    await read.mock.results[2]!.value
    controller.observe(A, result(first))
    await read.mock.results[3]!.value
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(5)
    controller.observe(A, TURN_END)
    await read.mock.results[5]!.value
    await vi.advanceTimersByTimeAsync(6000)
    expect(read).toHaveBeenCalledTimes(6)
  })

  it.each(['account', 'selection', 'dispose'] as const)('clears empty pending calls on %s lifetime changes', async (change) => {
    vi.useFakeTimers()
    const empty: CreativeReadResult = { ok: true, payload: { accountId: 'account-a', projects: [] } }
    const read = vi.fn<ReadCreativeProjects>().mockResolvedValue(empty)
    const { controller } = owner(read)
    controller.accountChanged('account-a'); controller.select(A)
    await read.mock.results[0]!.value
    controller.observe(A, call())
    await read.mock.results[1]!.value
    if (change === 'account') {
      controller.accountChanged(null); controller.accountChanged('account-a')
      await read.mock.results[2]!.value
    } else if (change === 'selection') {
      controller.select(undefined); controller.select(A)
      await read.mock.results[2]!.value
    } else await controller.dispose()
    const count = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(8000)
    expect(read).toHaveBeenCalledTimes(count)
  })

  it('honors a manually closed empty tab during a pending media call', async () => {
    vi.useFakeTimers()
    const empty: CreativeReadResult = { ok: true, payload: { accountId: 'account-a', projects: [] } }
    const read = vi.fn<ReadCreativeProjects>().mockResolvedValue(empty)
    const { controller, reveal } = owner(read)
    controller.accountChanged('account-a'); controller.select(A)
    await read.mock.results[0]!.value
    const visible = new AbortController()
    const close = controller.watch(A, true, visible.signal)
    await read.mock.results[1]!.value
    controller.observe(A, call())
    await read.mock.results[2]!.value
    close()
    await vi.advanceTimersByTimeAsync(6000)
    expect(read).toHaveBeenCalledTimes(3)
    read.mockResolvedValueOnce(success('completed'))
    controller.observe(A, TURN_END)
    await read.mock.results[3]!.value
    expect(controller.source(A).getSnapshot().projects).toHaveLength(1)
    expect(reveal).not.toHaveBeenCalled()
  })
})
