import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent, type AgentStatus } from '@deepseek-ai/dsh-agent'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import type { JobKind, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { attachGenerationActivityRuntime, type GenerationActivityRuntime } from '../src/generation-activity-runtime.ts'

const owned: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(owned.splice(0).map(ctx => ctx.fiber.dispose()))
})

function makeAgent(ctx: Context, name: string, status: AgentStatus = 'idle', lineage?: SessionId) {
  const id = SessionId(name)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false,
    ...lineage === undefined ? {} : { parentSession: lineage } })
  const unsupported = (): never => { throw new Error('Fixture Inbox is not mutable') }
  let state = status
  const agent: Agent = {
    id, session, ctx, options: {}, get status() { return state },
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported,
      replace: unsupported, remove: unsupported, splice: unsupported },
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
  }
  return { agent, setStatus(value: AgentStatus) { state = value; agentEvents(ctx, agent).emit('agent/status', { status: value }) } }
}

async function fixture(options: { lateServices?: boolean; beforeAttach?: (ctx: Context) => Promise<void> } = {}) {
  const ctx = new Context()
  owned.push(ctx)
  if (!options.lateServices) await ctx.plugin(AgentRegistry)
  await options.beforeAttach?.(ctx)
  let epoch: string | undefined = 'login-a'
  let lookupThrows = false
  let available = false
  const setRuntimeAvailable = vi.fn((value: boolean) => { available = value })
  const active = new Map<symbol, { epoch: string; id: SessionId }>()
  const releases: (() => void)[] = []
  const observeChat = vi.fn((captured: string, id: SessionId) => {
    const token = Symbol()
    active.set(token, { epoch: captured, id })
    const release = vi.fn(() => { active.delete(token) })
    releases.push(release)
    return release
  })
  let runtime: GenerationActivityRuntime | undefined
  const fiber = await ctx.plugin((scope) => {
    const reporter = { observeChat, setRuntimeAvailable }
    runtime = attachGenerationActivityRuntime(scope, reporter, () => {
      if (lookupThrows) throw new Error('Account lookup unavailable')
      return epoch
    })
  })
  if (runtime === undefined) throw new Error('Runtime did not attach')
  const attached = runtime
  const refresh = (): void => { attached.refresh() }
  return { ctx, fiber, active, observeChat, releases, refresh, setRuntimeAvailable, isAvailable: () => available,
    rootSessionId: (id: SessionId) => attached.rootSessionId(id),
    setEpoch(value: string | undefined) { epoch = value; refresh() },
    failLookup(value: boolean) { lookupThrows = value; refresh() },
    async register(value: ReturnType<typeof makeAgent>, parent?: Agent) {
      const detach = ctx.agents.enter(value.agent, parent)
      ctx.effect(() => detach, 'fixture Agent')
      await ctx.agents.announce(value.agent, 'startup')
      return detach
    },
    async jobs() {
      const fiber = await ctx.plugin(LocalJobs)
      ctx.jobs.attachController('generation-runtime-fixture')
      return fiber
    },
    start(kind: JobKind, owner?: Agent) {
      const outcome = Promise.withResolvers<JobOutcome>()
      const id = ctx.jobs.start({ kind, label: 'Private fixture work', ...owner === undefined ? {} : { owner: owner.id },
        run: () => ({ cancel: () => { outcome.resolve({ status: 'killed' }) }, done: outcome.promise }) })
      return { id, async finish() { outcome.resolve({ status: 'completed' }); await ctx.jobs.wait(id, 1_000, owner?.id) } }
    },
  }
}

describe('Generation activity runtime roots', () => {
  it('includes already-running Agents in the initial synchronous snapshot', async () => {
    const f = await fixture({ beforeAttach: async (ctx) => {
      const root = makeAgent(ctx, 'existing', 'running')
      const detach = ctx.agents.enter(root.agent, undefined)
      ctx.effect(() => detach, 'existing fixture Agent')
      await ctx.agents.announce(root.agent, 'startup')
    } })
    expect([...f.active.values()]).toEqual([{ epoch: 'login-a', id: SessionId('existing') }])
  })

  it('counts a runtime root once across its running child tree and ignores durable fork lineage', async () => {
    const f = await fixture()
    const root = makeAgent(f.ctx, 'root', 'idle', SessionId('historical-parent'))
    const child = makeAgent(f.ctx, 'child', 'running')
    const grandchild = makeAgent(f.ctx, 'grandchild', 'running')
    await f.register(root)
    await f.register(child, root.agent)
    await f.register(grandchild, child.agent)
    expect(f.rootSessionId(child.agent.id)).toBe(root.agent.session.id)
    expect(f.rootSessionId(grandchild.agent.id)).toBe(root.agent.session.id)
    expect(f.rootSessionId(root.agent.id)).toBe(root.agent.session.id)
    expect(f.rootSessionId(SessionId('not-loaded'))).toBeUndefined()
    expect([...f.active.values()]).toEqual([{ epoch: 'login-a', id: root.agent.id }])
    root.setStatus('running')
    child.setStatus('idle')
    grandchild.setStatus('idle')
    expect(f.observeChat).toHaveBeenCalledTimes(1)
    root.setStatus('idle')
    expect(f.active.size).toBe(0)
    grandchild.setStatus('running')
    expect([...f.active.values()]).toEqual([{ epoch: 'login-a', id: root.agent.id }])
  })

  it('keeps idle root chats busy only for their owned media jobs, with one snapshot per live owner', async () => {
    const f = await fixture()
    const root = makeAgent(f.ctx, 'root')
    const child = makeAgent(f.ctx, 'child')
    const other = makeAgent(f.ctx, 'other')
    await f.register(root)
    await f.register(child, root.agent)
    await f.register(other)
    await f.jobs()
    const list = vi.spyOn(f.ctx.jobs, 'list')
    const media = f.start('video-project', child.agent)
    const edit = f.start('video-edit', root.agent)
    f.start('bash', other.agent)
    f.start('video-project')
    expect([...f.active.values()]).toEqual([{ epoch: 'login-a', id: root.agent.id }])
    expect(new Set(list.mock.calls.map(([owner]) => owner))).toEqual(new Set([root.agent.id, child.agent.id, other.agent.id]))
    expect(list).not.toHaveBeenCalledWith()
    root.setStatus('running')
    await media.finish()
    await edit.finish()
    expect(f.active.size).toBe(1)
    root.setStatus('idle')
    expect(f.active.size).toBe(0)
  })

  it('follows optional service arrival, jobs replacement and plugin disposal', async () => {
    const f = await fixture({ lateServices: true })
    expect(f.rootSessionId(SessionId('not-loaded'))).toBeUndefined()
    await f.ctx.plugin(AgentRegistry)
    const root = makeAgent(f.ctx, 'root', 'running')
    await f.register(root)
    await vi.waitFor(() => { expect(f.active.size).toBe(1) })
    root.setStatus('idle')
    const jobsFiber = await f.jobs()
    const media = f.start('video-project', root.agent)
    await vi.waitFor(() => { expect(f.active.size).toBe(1) })
    await media.finish()
    expect(f.active.size).toBe(0)
    await jobsFiber.dispose()
    expect(f.active.size).toBe(0)
    await f.jobs()
    const second = f.start('video-project', root.agent)
    expect(f.active.size).toBe(1)
    await second.finish()
    root.setStatus('running')
    await f.fiber.dispose()
    expect(f.rootSessionId(root.agent.id)).toBeUndefined()
    expect(f.active.size).toBe(0)
    const observed = f.observeChat.mock.calls.length
    root.setStatus('idle')
    root.setStatus('running')
    f.refresh()
    expect(f.observeChat).toHaveBeenCalledTimes(observed)
  })

  it('isolates a replacement Agent from old status events and an old same-id media job', async () => {
    const f = await fixture()
    await f.jobs()
    const old = makeAgent(f.ctx, 'reused', 'running')
    const detach = await f.register(old)
    const media = f.start('video-project', old.agent)
    expect(f.active.size).toBe(1)
    detach()
    const replacement = makeAgent(f.ctx, 'reused')
    await f.register(replacement)
    expect(f.active.size).toBe(0)
    old.setStatus('running')
    f.refresh()
    expect(f.active.size).toBe(0)
    await media.finish()
    expect(f.active.size).toBe(0)
    replacement.setStatus('running')
    expect(f.active.size).toBe(1)
    expect(f.observeChat).toHaveBeenLastCalledWith('login-a', replacement.agent.session.id)
  })

  it('retains exact job ownership while signed out and counts stopping work until it settles', async () => {
    const f = await fixture()
    await f.jobs()
    f.setEpoch(undefined)
    const old = makeAgent(f.ctx, 'reused')
    const detach = await f.register(old)
    const oldMedia = f.start('video-project', old.agent)
    detach()
    const replacement = makeAgent(f.ctx, 'reused')
    await f.register(replacement)
    f.setEpoch('login-b')
    expect(f.active.size).toBe(0)
    await oldMedia.finish()
    const currentMedia = f.start('video-project', replacement.agent)
    expect(f.active.size).toBe(1)
    f.ctx.jobs.kill(currentMedia.id, replacement.agent.id)
    expect(f.ctx.jobs.get(currentMedia.id, replacement.agent.id).status).toBe('stopping')
    expect(f.active.size).toBe(1)
    await f.ctx.jobs.wait(currentMedia.id, 1_000, replacement.agent.id)
    expect(f.active.size).toBe(0)
  })

  it('releases the prior epoch, resnapshots live roots on login change and ignores late release functions', async () => {
    const f = await fixture()
    const root = makeAgent(f.ctx, 'root', 'running')
    await f.register(root)
    const oldRelease = f.releases[0]
    f.setEpoch(undefined)
    expect(f.active.size).toBe(0)
    f.setEpoch('login-b')
    expect([...f.active.values()]).toEqual([{ epoch: 'login-b', id: root.agent.id }])
    oldRelease?.()
    expect(f.active.size).toBe(1)
    f.refresh()
    expect(f.observeChat).toHaveBeenCalledTimes(2)
  })

  it.each(['list', 'roots'] as const)('preserves known chats and pauses freshness when %s fails until a complete snapshot recovers', async (method) => {
    const f = await fixture()
    const root = makeAgent(f.ctx, 'root', 'running')
    await f.register(root)
    const release = f.releases[0]
    const failure = vi.spyOn(f.ctx.agents, method).mockImplementation(() => { throw new Error('Snapshot unavailable') })
    expect(() => { f.refresh() }).not.toThrow()
    expect(f.active.size).toBe(1)
    expect(release).not.toHaveBeenCalled()
    expect(f.isAvailable()).toBe(false)
    expect(f.rootSessionId(root.agent.id)).toBeUndefined()
    root.setStatus('idle')
    expect(f.active.size).toBe(1)
    failure.mockRestore()
    expect(f.rootSessionId(root.agent.id)).toBe(root.agent.session.id)
    expect(f.isAvailable()).toBe(false)
    f.refresh()
    expect(f.active.size).toBe(0)
    expect(release).toHaveBeenCalledTimes(1)
    expect(f.isAvailable()).toBe(true)
  })

  it('contains observer and account-lookup failures without vetoing Agent creation or status notifications', async () => {
    const f = await fixture()
    vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => { throw new Error('Logger unavailable') })
    f.observeChat.mockImplementationOnce(() => { throw new Error('Reporter unavailable') })
    const root = makeAgent(f.ctx, 'root', 'running')
    await expect(f.register(root)).resolves.toBeTypeOf('function')
    expect(f.active.size).toBe(0)
    expect(f.isAvailable()).toBe(false)
    expect(() => { root.setStatus('running') }).not.toThrow()
    expect(f.active.size).toBe(1)
    expect(f.isAvailable()).toBe(true)
    expect(() => { f.failLookup(true) }).not.toThrow()
    expect(f.active.size).toBe(1)
    expect(f.isAvailable()).toBe(false)
    f.failLookup(false)
    expect(f.active.size).toBe(1)
    expect(f.isAvailable()).toBe(true)
    vi.spyOn(f.ctx.agents, 'get').mockImplementationOnce(() => { throw new Error('Registry unavailable') })
    expect(() => { root.setStatus('idle') }).not.toThrow()
    expect(f.active.size).toBe(1)
    expect(f.isAvailable()).toBe(false)
    f.refresh()
    expect(f.active.size).toBe(0)
    expect(f.isAvailable()).toBe(true)
  })
})
