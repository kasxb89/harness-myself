/** Generation observations stay independent from chat/model work, account renewal and Desktop presence. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { GenerationActivityReporter, type GenerationActivityAccount,
  type GenerationActivityReporterOptions } from '../src/generation-activity.ts'

const epoch = 'private-login-epoch'
const runtime = '01234567-89ab-4cde-8fab-0123456789ab'
const attempt = '11234567-89ab-4cde-8fab-0123456789ab'
const session = brandString<SessionId>('private-chat-session')
const reporters: GenerationActivityReporter[] = []
interface PublishedSnapshot {
  sequence: number
  runtime_session_id: string
  collections: Record<string, string>
  activities: {
    activity_id: string
    kind: string
    work_state: string
    phase: string
    attempt_id?: string
    chat_session_id?: string
    project_id?: string
    outcome?: string
  }[]
  shots: unknown[]
}
function acknowledged(sequence: number): Response {
  return Response.json({ success: true, data: { schema_version: 1, recorded: true, disposition: 'accepted',
    accepted_sequence: sequence, server_time: 1792771702, heartbeat_interval_seconds: 30, workload_timeout_seconds: 90 } })
}
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
}
function task(reporter: GenerationActivityReporter, index: number, stage: 'queued' | 'generating' = 'queued') {
  return reporter.observeTask(epoch, { sessionId: session, operationId: `operation-${index}`, projectId: 'project-one',
    shotId: `shot-${index}`, attemptId: `${String(index + 1).padStart(8, '0')}-89ab-4cde-8fab-0123456789ab`, kind: 'video', stage })
}

afterEach(async () => {
  await Promise.all(reporters.splice(0).map(reporter => reporter.dispose()))
  vi.useRealTimers()
})

function fixture(overrides: Partial<GenerationActivityReporterOptions> = {}) {
  const unavailable = vi.fn()
  const snapshots: PublishedSnapshot[] = []
  const send = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/status')) return Response.json({ success: true, data: { client_activity_workload: {
      schema_version: 1, snapshot_path: '/api/client-activity/workload-snapshot',
      heartbeat_interval_seconds: 30, workload_timeout_seconds: 90,
    } } })
    if (typeof init.body !== 'string') throw new Error('Expected JSON request body')
    const snapshot = JSON.parse(init.body) as PublishedSnapshot
    snapshots.push(snapshot)
    return acknowledged(snapshot.sequence)
  })
  let account: GenerationActivityAccount | undefined = { epoch, token: 'private-access-token', runtimeSessionId: runtime }
  const reporter = new GenerationActivityReporter({
    baseUrl: 'https://relay.example/harness', timeoutMs: 3000, heartbeatMs: 30_000, minReportIntervalMs: 1000,
    account: () => account, unavailable, fetch: send, ...overrides,
  })
  reporters.push(reporter)
  reporter.setRuntimeAvailable(true)
  return { reporter, unavailable, send, snapshots, account: (value: GenerationActivityAccount | undefined) => { account = value } }
}

describe('generation observation ownership', () => {
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid timer interval %s', (heartbeatMs) => {
    expect(() => fixture({ heartbeatMs })).toThrow(RangeError)
  })

  it('never adopts an operation from another login', async () => {
    vi.useFakeTimers()
    const { reporter, send } = fixture()
    const chat = reporter.observeChat('old-login-epoch', session)
    const task = reporter.observeTask('old-login-epoch', {
      sessionId: session, operationId: 'old-operation', kind: 'video', stage: 'generating',
    })
    chat()
    task.update('saving')
    task.end()
    await reporter.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).not.toHaveBeenCalled()
  })

  it('contains credential lookup errors without changing the caller outcome', () => {
    const { reporter, unavailable } = fixture({ account: () => { throw new Error('private account detail') } })
    expect(() => reporter.observeChat(epoch, session)).not.toThrow()
    expect(() => {
      reporter.observeTask(epoch, { sessionId: session, operationId: 'operation', kind: 'image', stage: 'preparing' }).end()
    }).not.toThrow()
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(unavailable).toHaveBeenCalledWith('authorization')
  })

  it('makes stale observer updates inert after disposal', async () => {
    vi.useFakeTimers()
    const { reporter, send } = fixture()
    const chat = reporter.observeChat(epoch, session)
    const task = reporter.observeTask(epoch, {
      sessionId: session, operationId: 'operation', kind: 'video', stage: 'queued',
    })
    await reporter.dispose()
    chat()
    chat()
    task.update('generating')
    task.end()
    task.end()
    reporter.observeChat(epoch, session)()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('complete workload snapshots', () => {
  it('counts one root chat, one real project and eight attempts without adding parents to the task total', async () => {
    fakeClock()
    const { reporter, snapshots, send } = fixture()
    const child = reporter.observeChat(epoch, session)
    const background = reporter.observeChat(epoch, session)
    reporter.observeTask(epoch, { sessionId: session, operationId: 'project-run', projectId: 'project-one', kind: 'video', stage: 'preparing' })
    const tasks = Array.from({ length: 8 }, (_, index) => task(reporter, index, index < 4 ? 'generating' : 'queued'))
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots).toHaveLength(1)
    const first = snapshots[0]
    expect(first?.activities.filter(row => row.kind === 'chat_activity')).toHaveLength(1)
    expect(first?.activities.filter(row => row.kind === 'project_run')).toHaveLength(1)
    expect(first?.activities.filter(row => row.kind === 'storyboard_task')).toHaveLength(8)
    expect(first?.activities.filter(row => row.kind === 'storyboard_task' && row.phase === 'generating')).toHaveLength(4)
    expect(first?.activities.filter(row => row.kind === 'storyboard_task' && row.phase === 'queued')).toHaveLength(4)
    expect(new Set(first?.activities.map(row => row.chat_session_id)).size).toBe(1)
    expect(first?.shots).toEqual([])
    expect(first?.collections).toEqual({ chat_activity: 'collected', project_run: 'collected', storyboard_task: 'collected',
      local_operation: 'not_collected', shots: 'not_collected' })
    expect(JSON.stringify(first)).not.toMatch(/private-|operation-|project-one|shot-/u)
    expect(send.mock.calls[0]?.[1].headers).toEqual({ accept: 'application/json' })
    expect(send.mock.calls[1]?.[0]).toBe('https://relay.example/harness/api/client-activity/workload-snapshot')
    expect(new Headers(send.mock.calls[1]?.[1].headers).get('authorization')).toBe('Bearer private-access-token')
    child()
    background()
    tasks[0]?.update('unknown')
    await vi.advanceTimersByTimeAsync(1000)
    expect(snapshots.at(-1)?.activities.filter(row => row.kind === 'chat_activity' && row.work_state === 'active')).toHaveLength(1)
    expect(snapshots.at(-1)?.activities.filter(row => row.kind === 'storyboard_task' && row.work_state === 'unknown')).toHaveLength(1)
  })

  it('keeps independent media independent and retains terminal tombstones until acknowledgement', async () => {
    fakeClock()
    const { reporter, snapshots } = fixture()
    const lease = reporter.observeTask(epoch, { operationId: 'independent-operation', attemptId: attempt, kind: 'image', stage: 'preparing' })
    lease.update('submitting')
    lease.end('completed')
    lease.end('failed')
    lease.update('generating')
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots[0]?.activities).toMatchObject([{ kind: 'storyboard_task', attempt_id: attempt,
      work_state: 'ended', phase: 'ended', outcome: 'succeeded' }])
    expect(snapshots[0]?.activities[0]).not.toHaveProperty('project_id')
    expect(snapshots[0]?.activities[0]).not.toHaveProperty('chat_session_id')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(snapshots[1]?.activities).toEqual([])
  })

  it('keeps unknown submission separate from active and reuses its original durable attempt on explicit recovery', async () => {
    fakeClock()
    const { reporter, snapshots } = fixture()
    const input = { sessionId: session, operationId: 'operation', attemptId: attempt, kind: 'video' as const, stage: 'submitting' as const }
    reporter.observeTask(epoch, input).end('unknown')
    await vi.advanceTimersByTimeAsync(0)
    const original = snapshots[0]?.activities.find(row => row.kind === 'storyboard_task')
    expect(original).toMatchObject({ work_state: 'unknown', phase: 'unknown', attempt_id: attempt })
    expect(snapshots[0]?.activities.find(row => row.kind === 'chat_activity')).toMatchObject({ work_state: 'unknown' })
    reporter.observeTask(epoch, { ...input, stage: 'generating' })
    await vi.advanceTimersByTimeAsync(1000)
    const resumed = snapshots[1]?.activities.filter(row => row.kind === 'storyboard_task')
    expect(resumed).toHaveLength(2)
    expect(resumed?.find(row => row.activity_id === original?.activity_id)).toMatchObject({ work_state: 'ended', outcome: 'interrupted' })
    const active = resumed?.find(row => row.work_state === 'active')
    expect(active).toMatchObject({ phase: 'generating', attempt_id: attempt })
    expect(active?.activity_id).not.toBe(original?.activity_id)
  })

  it('preserves one observation when duplicate hooks release in different orders', async () => {
    fakeClock()
    const { reporter, snapshots } = fixture()
    const first = task(reporter, 0)
    const second = task(reporter, 0)
    first.end('completed')
    first.end('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots[0]?.activities.filter(row => row.kind === 'storyboard_task' && row.work_state === 'active')).toHaveLength(1)
    second.end('completed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(snapshots[1]?.activities.filter(row => row.kind === 'storyboard_task')).toMatchObject([{ work_state: 'ended' }])
  })

  it('uses stable logical identifiers across independent Host reporters', async () => {
    fakeClock()
    const first = fixture()
    const second = fixture()
    first.reporter.observeChat(epoch, session)
    second.reporter.observeChat(epoch, session)
    task(first.reporter, 0)
    task(second.reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    const one = first.snapshots[0]?.activities.find(row => row.kind === 'storyboard_task')
    const two = second.snapshots[0]?.activities.find(row => row.kind === 'storyboard_task')
    expect(one?.activity_id).not.toBe(two?.activity_id)
    expect(one?.attempt_id).toBe(two?.attempt_id)
    expect(one?.chat_session_id).toBe(two?.chat_session_id)
    expect(one?.project_id).toBe(two?.project_id)
  })
})

describe('publication lifecycle and monotonic scheduling', () => {
  it('preserves observations without usable access or acknowledged presence, then resumes the same epoch', async () => {
    fakeClock()
    const context = fixture()
    context.account({ epoch })
    context.reporter.observeChat(epoch, session)
    task(context.reporter, 0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(context.send).not.toHaveBeenCalled()
    context.account({ epoch, token: 'renewed-access', runtimeSessionId: runtime })
    context.reporter.refresh()
    await vi.advanceTimersByTimeAsync(0)
    const first = context.snapshots[0]
    expect(first?.sequence).toBe(1)
    expect(first?.activities.filter(row => row.work_state === 'active')).toHaveLength(2)
    context.account({ epoch })
    await vi.advanceTimersByTimeAsync(30_000)
    context.account({ epoch, token: 'another-access', runtimeSessionId: runtime })
    context.reporter.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(context.snapshots[1]?.sequence).toBe(2)
    expect(context.snapshots[1]?.activities.map(row => row.activity_id)).toEqual(first?.activities.map(row => row.activity_id))
  })

  it('keeps heartbeats and dirty coalescing on monotonic time after wall-clock rollback', async () => {
    fakeClock()
    const { reporter, snapshots } = fixture()
    const lease = task(reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() - 3_600_000)
    lease.update('generating')
    lease.update('accepted')
    lease.update('queued')
    await vi.advanceTimersByTimeAsync(999)
    expect(snapshots).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]?.sequence).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(snapshots[2]?.sequence).toBe(3)
  })

  it('pauses freshness on runtime uncertainty and resumes without clearing the last real work', async () => {
    fakeClock()
    const { reporter, snapshots } = fixture()
    task(reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    reporter.setRuntimeAvailable(false)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(snapshots).toHaveLength(1)
    reporter.setRuntimeAvailable(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots[1]?.activities.filter(row => row.kind === 'storyboard_task' && row.work_state === 'active')).toHaveLength(1)
  })

  it('never submits to an old API lacking the explicit public capability', async () => {
    fakeClock()
    const send = vi.fn(async () => Response.json({ success: true, data: {} }))
    const { reporter, unavailable } = fixture({ fetch: send })
    reporter.observeChat(epoch, session)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(send).toHaveBeenCalledTimes(4)
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(unavailable).toHaveBeenCalledWith('unsupported')
  })

  it('does not truncate a snapshot after local collection capacity is exhausted', async () => {
    fakeClock()
    const { reporter, send, unavailable } = fixture()
    for (let index = 0; index < 257; index += 1) reporter.observeChat(epoch, brandString<SessionId>(`chat-${index}`))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).not.toHaveBeenCalled()
    expect(unavailable).toHaveBeenCalledWith('capacity')
  })
})

function capability(): Response {
  return Response.json({ success: true, data: { client_activity_workload: {
    schema_version: 1, snapshot_path: '/api/client-activity/workload-snapshot',
    heartbeat_interval_seconds: 30, workload_timeout_seconds: 90,
  } } })
}
function published(init: RequestInit): PublishedSnapshot {
  if (typeof init.body !== 'string') throw new Error('Expected JSON body')
  return JSON.parse(init.body) as PublishedSnapshot
}

describe('bounded serialized transport', () => {
  it('coalesces updates behind one request and publishes the latest state after its acknowledgement', async () => {
    fakeClock()
    const wait = Promise.withResolvers<Response>()
    const posted: PublishedSnapshot[] = []
    const send = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/status')) return capability()
      posted.push(published(init))
      return posted.length === 1 ? await wait.promise : acknowledged(published(init).sequence)
    })
    const { reporter } = fixture({ fetch: send })
    const lease = task(reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    lease.update('generating')
    lease.update('saving')
    await vi.advanceTimersByTimeAsync(2000)
    expect(posted).toHaveLength(1)
    wait.resolve(acknowledged(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(posted).toHaveLength(2)
    expect(posted[1]?.sequence).toBe(2)
    expect(posted[1]?.activities.find(row => row.kind === 'storyboard_task')?.phase).toBe('saving')
  })

  it('retries a lost acknowledgement with identical sequence and payload before the next heartbeat', async () => {
    fakeClock()
    const posted: string[] = []
    const { reporter, unavailable } = fixture({ fetch: async (url, init) => {
      if (url.endsWith('/api/status')) return capability()
      if (typeof init.body !== 'string') throw new Error('Expected JSON')
      posted.push(init.body)
      if (posted.length === 1) throw new TypeError('network interrupted')
      const snapshot = published(init)
      if (posted.length === 2) return Response.json({ success: true, data: { schema_version: 1, recorded: false,
        disposition: 'duplicate', accepted_sequence: snapshot.sequence, server_time: 1792771702,
        heartbeat_interval_seconds: 30, workload_timeout_seconds: 90 } })
      return acknowledged(snapshot.sequence)
    } })
    task(reporter, 0)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(posted).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(posted).toHaveLength(2)
    expect(posted[1]).toBe(posted[0])
    expect(unavailable).toHaveBeenCalledWith('network')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(JSON.parse(posted[2] ?? '{}')).toMatchObject({ sequence: 2 })
  })

  it('does not replay stale active work when it ended during a failed exchange', async () => {
    fakeClock()
    const posted: PublishedSnapshot[] = []
    const { reporter } = fixture({ fetch: async (url, init) => {
      if (url.endsWith('/api/status')) return capability()
      const snapshot = published(init)
      posted.push(snapshot)
      if (posted.length === 1) throw new TypeError('connection lost')
      return acknowledged(snapshot.sequence)
    } })
    const lease = task(reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    lease.end('completed')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(posted.map(value => value.sequence)).toEqual([1, 2])
    expect(posted[1]?.activities.every(row => row.work_state === 'ended')).toBe(true)
    expect(posted[1]?.activities.find(row => row.kind === 'storyboard_task')?.outcome).toBe('succeeded')
  })

  it('isolates account replacement from a late acknowledgement and stale releases', async () => {
    fakeClock()
    const wait = Promise.withResolvers<Response>()
    const posted: { snapshot: PublishedSnapshot; bearer: string | null }[] = []
    const context = fixture({ fetch: async (url, init) => {
      if (url.endsWith('/api/status')) return capability()
      const snapshot = published(init)
      posted.push({ snapshot, bearer: new Headers(init.headers).get('authorization') })
      return posted.length === 1 ? await wait.promise : acknowledged(snapshot.sequence)
    } })
    const release = context.reporter.observeChat(epoch, session)
    task(context.reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    context.account({ epoch: 'second-login', token: 'second-token', runtimeSessionId: '21234567-89ab-4cde-8fab-0123456789ab' })
    context.reporter.invalidate()
    const secondSession = brandString<SessionId>('second-chat')
    context.reporter.observeChat('second-login', secondSession)
    await vi.advanceTimersByTimeAsync(1000)
    release()
    wait.resolve(acknowledged(1))
    await vi.advanceTimersByTimeAsync(1000)
    expect(posted).toHaveLength(2)
    expect(posted[1]?.bearer).toBe('Bearer second-token')
    expect(posted[1]?.snapshot).toMatchObject({ sequence: 1, runtime_session_id: '21234567-89ab-4cde-8fab-0123456789ab' })
    expect(posted[1]?.snapshot.activities).toHaveLength(1)
    expect(posted[1]?.snapshot.activities[0]?.chat_session_id).not.toBe(posted[0]?.snapshot.activities[0]?.chat_session_id)
  })

  it('honors Retry-After without bypassing the cooldown when another update is pending', async () => {
    fakeClock()
    const posted: PublishedSnapshot[] = []
    const { reporter, unavailable } = fixture({ fetch: async (url, init) => {
      if (url.endsWith('/api/status')) return capability()
      const snapshot = published(init)
      posted.push(snapshot)
      return posted.length === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '60' } }) : acknowledged(snapshot.sequence)
    } })
    const lease = task(reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    lease.update('generating')
    reporter.refresh()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(posted).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(posted).toHaveLength(2)
    expect(unavailable).toHaveBeenCalledWith('unavailable')
  })

  it.each([400, 401, 403, 404, 409, 413, 500])('contains HTTP %s without changing a local lease or login', async (status) => {
    fakeClock()
    const requests = vi.fn(async (url: string) => url.endsWith('/api/status') ? capability() : new Response(null, { status }))
    const { reporter, unavailable } = fixture({ fetch: requests })
    const lease = task(reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(() => { lease.update('saving'); lease.end('completed') }).not.toThrow()
    expect(unavailable).toHaveBeenCalledWith(status === 401 || status === 403 ? 'authorization'
      : status === 404 ? 'unsupported' : status === 413 ? 'capacity' : status === 400 || status === 409 ? 'protocol' : 'unavailable')
    if ([400, 409, 413].includes(status)) {
      await vi.advanceTimersByTimeAsync(90_000)
      expect(requests).toHaveBeenCalledTimes(2)
    }
  })

  it('closes a late body after disposal and cannot launch a follow-up report', async () => {
    fakeClock()
    const wait = Promise.withResolvers<Response>()
    const requests = vi.fn(async (url: string) => url.endsWith('/api/status') ? capability() : await wait.promise)
    const { reporter } = fixture({ fetch: requests })
    task(reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    await reporter.dispose()
    const cancel = vi.fn()
    wait.resolve(new Response(new ReadableStream({ cancel })))
    await vi.advanceTimersByTimeAsync(90_000)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(requests).toHaveBeenCalledTimes(2)
  })

  it('rejects a capability path which could send authentication to another destination', async () => {
    fakeClock()
    const requests = vi.fn(async () => Response.json({ success: true, data: { client_activity_workload: {
      schema_version: 1, snapshot_path: 'https://foreign.invalid/collect', heartbeat_interval_seconds: 30, workload_timeout_seconds: 90,
    } } }))
    const { reporter, unavailable } = fixture({ fetch: requests })
    reporter.observeChat(epoch, session)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requests).toHaveBeenCalledTimes(1)
    expect(unavailable).toHaveBeenCalledWith('protocol')
  })

  it('keeps ambiguous acknowledgements from clearing terminal tombstones or asserting fresh zero', async () => {
    fakeClock()
    const posted: PublishedSnapshot[] = []
    const { reporter, unavailable } = fixture({ fetch: async (url, init) => {
      if (url.endsWith('/api/status')) return capability()
      const snapshot = published(init)
      posted.push(snapshot)
      return acknowledged(snapshot.sequence + 1)
    } })
    task(reporter, 0).end('completed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(posted).toHaveLength(1)
    expect(posted[0]?.activities.find(row => row.kind === 'storyboard_task')?.work_state).toBe('ended')
    expect(unavailable).toHaveBeenCalledWith('protocol')
  })
})

describe('legacy media collection coverage', () => {
  it('retains other dimensions while an untracked legacy request has no durable attempt', async () => {
    fakeClock()
    const { reporter, snapshots } = fixture()
    reporter.observeChat(epoch, session)
    const guard = reporter.observeUntrackedMedia(epoch)
    task(reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots[0]?.collections.storyboard_task).toBe('not_collected')
    expect(snapshots[0]?.activities.filter(row => row.kind === 'storyboard_task')).toHaveLength(0)
    expect(snapshots[0]?.activities.filter(row => row.kind === 'chat_activity')).toHaveLength(1)
    guard('completed')
    guard('unknown')
    await vi.advanceTimersByTimeAsync(1000)
    expect(snapshots[1]?.collections.storyboard_task).toBe('collected')
    expect(snapshots[1]?.activities.filter(row => row.kind === 'storyboard_task')).toHaveLength(1)
  })

  it('does not turn an unresolved legacy submission into a measured zero', async () => {
    fakeClock()
    const { reporter, snapshots } = fixture()
    reporter.observeUntrackedMedia(epoch)('unknown')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(snapshots).toHaveLength(3)
    for (const snapshot of snapshots) expect(snapshot.collections.storyboard_task).toBe('not_collected')
  })
})

describe('reporting failure containment', () => {
  it('bounds a transport that ignores cancellation without waiting on model work', async () => {
    fakeClock()
    const wait = Promise.withResolvers<Response>()
    const { reporter, unavailable } = fixture({ timeoutMs: 20, fetch: async url =>
      url.endsWith('/api/status') ? capability() : await wait.promise })
    const lease = task(reporter, 0)
    await vi.advanceTimersByTimeAsync(0)
    await delay(60)
    expect(unavailable).toHaveBeenCalledWith('timeout')
    expect(() => { lease.update('saving'); lease.end('completed') }).not.toThrow()
    await reporter.dispose()
    const cancel = vi.fn()
    wait.resolve(new Response(new ReadableStream({ cancel })))
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('retains completed task tombstones across a failed request and removes only acknowledged records', async () => {
    fakeClock()
    const posted: PublishedSnapshot[] = []
    const { reporter } = fixture({ fetch: async (url, init) => {
      if (url.endsWith('/api/status')) return capability()
      const snapshot = published(init)
      posted.push(snapshot)
      if (posted.length === 1) throw new TypeError('lost acknowledgement')
      return acknowledged(snapshot.sequence)
    } })
    task(reporter, 0).end('completed')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(posted).toHaveLength(2)
    expect(posted[1]).toEqual(posted[0])
    expect(posted[1]?.activities.every(row => row.work_state === 'ended')).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(posted[2]?.activities).toEqual([])
  })

  it('keeps diagnostics failures independent from a synchronous creative caller', () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      const { reporter } = fixture({ account: () => { throw new Error('account unavailable') },
        unavailable: () => { throw new Error('logger unavailable') } })
      expect(() => reporter.observeChat(epoch, session)).not.toThrow()
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('independent'), { code: 'GENERATION_ACTIVITY_REPORTING' })
    } finally { warning.mockRestore() }
  })
})

describe('capability upgrades while creative work is alive', () => {
  it('automatically publishes eight existing attempts after an old server gains capability', async () => {
    fakeClock()
    let supported = false
    const posted: PublishedSnapshot[] = []
    const requests = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/status')) return supported ? capability() : Response.json({ success: true, data: {} })
      const snapshot = published(init)
      posted.push(snapshot)
      return acknowledged(snapshot.sequence)
    })
    const { reporter, unavailable } = fixture({ fetch: requests })
    reporter.observeChat(epoch, session)
    const leases = Array.from({ length: 8 }, (_, index) => task(reporter, index, 'generating'))
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toHaveBeenCalledTimes(1)
    expect(posted).toHaveLength(0)
    leases[0]?.update('saving')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(requests).toHaveBeenCalledTimes(1)
    supported = true
    await vi.advanceTimersByTimeAsync(1)
    expect(requests).toHaveBeenCalledTimes(3)
    expect(posted).toHaveLength(1)
    expect(posted[0]?.sequence).toBe(1)
    expect(posted[0]?.activities.filter(row => row.kind === 'storyboard_task')).toHaveLength(8)
    expect(posted[0]?.activities.filter(row => row.kind === 'chat_activity')).toHaveLength(1)
    expect(posted[0]?.activities.filter(row => row.kind === 'storyboard_task' && row.phase === 'saving')).toHaveLength(1)
    expect(unavailable).toHaveBeenCalledTimes(1)
  })

  it('keeps live measurements available after many completed operations against an unsupported server', async () => {
    fakeClock()
    let supported = false
    const posted: PublishedSnapshot[] = []
    const { reporter, unavailable } = fixture({ fetch: async (url, init) => {
      if (url.endsWith('/api/status')) return supported ? capability() : Response.json({ success: true, data: {} })
      const snapshot = published(init)
      posted.push(snapshot)
      return acknowledged(snapshot.sequence)
    } })
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 300; index += 1) reporter.observeChat(epoch, brandString<SessionId>(`temporary-${index}`))()
    reporter.observeChat(epoch, session)
    supported = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(unavailable).not.toHaveBeenCalledWith('capacity')
    expect(posted[0]?.activities).toHaveLength(1)
    expect(posted[0]?.activities[0]).toMatchObject({ kind: 'chat_activity', work_state: 'active' })
  })

  it('does not acknowledge omitted task tombstones while legacy task collection is unavailable', async () => {
    fakeClock()
    const { reporter, snapshots } = fixture()
    task(reporter, 0).end('completed')
    const release = reporter.observeUntrackedMedia(epoch)
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots[0]?.activities.filter(row => row.kind === 'storyboard_task')).toHaveLength(0)
    release('failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(snapshots[1]?.activities.filter(row => row.kind === 'storyboard_task')).toMatchObject([{ work_state: 'ended', outcome: 'succeeded' }])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(snapshots[2]?.activities.filter(row => row.kind === 'storyboard_task')).toHaveLength(0)
  })
})

describe('credential and server-time cooldown ownership', () => {
  it('does not carry a previous account rate limit into the next login', async () => {
    fakeClock()
    const posted: PublishedSnapshot[] = []
    const context = fixture({ fetch: async (url, init) => {
      if (url.endsWith('/api/status')) return capability()
      const snapshot = published(init)
      posted.push(snapshot)
      return posted.length === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '120' } }) : acknowledged(snapshot.sequence)
    } })
    context.reporter.observeChat(epoch, session)
    await vi.advanceTimersByTimeAsync(0)
    context.account({ epoch: 'another-account', token: 'another-token', runtimeSessionId: '21234567-89ab-4cde-8fab-0123456789ab' })
    context.reporter.invalidate()
    context.reporter.observeChat('another-account', session)
    await vi.advanceTimersByTimeAsync(0)
    expect(posted).toHaveLength(2)
    expect(posted[1]).toMatchObject({ sequence: 1, runtime_session_id: '21234567-89ab-4cde-8fab-0123456789ab' })
  })

  it('honors an absolute Retry-After using server Date while the client wall clock is wrong', async () => {
    fakeClock()
    vi.setSystemTime(Date.parse('2020-01-01T00:00:00Z'))
    const posted: PublishedSnapshot[] = []
    const { reporter } = fixture({ fetch: async (url, init) => {
      if (url.endsWith('/api/status')) return capability()
      const snapshot = published(init)
      posted.push(snapshot)
      return posted.length === 1 ? new Response(null, { status: 429, headers: {
        date: 'Sat, 24 Oct 2026 00:00:00 GMT', 'retry-after': 'Sat, 24 Oct 2026 00:01:00 GMT',
      } }) : acknowledged(snapshot.sequence)
    } })
    task(reporter, 0)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(posted).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(posted).toHaveLength(2)
  })
})
