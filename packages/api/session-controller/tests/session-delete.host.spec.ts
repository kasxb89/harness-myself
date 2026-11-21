/** Permanent Session deletion over the production AgentLoop and JSONL backend. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionController } from '../src/index.ts'
import { createSessionTestController } from './test-remote.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-api-session-delete-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'text' }), cwd,
  })
  return { ctx, controller, root, cwd }
}

async function create(controller: SessionController, id: string) {
  return (await controller.create({ sessionId: SessionId(id) })).sessionId
}

describe('session.delete', () => {
  it('closes its idle writer then permanently deletes the log, keeping independent files and other Sessions', async () => {
    const { ctx, controller, cwd } = await harness()
    const id = await create(controller, 'delete-owned-idle')
    const other = await create(controller, 'retained-independent')
    const originalAgent = ctx.agents.get(id)!
    await ctx.sessions.flush(originalAgent.session)
    const artifact = join(cwd, 'independent-output.png')
    await writeFile(artifact, 'retained output')
    const removed = vi.fn()
    ctx.on('api-session/removed', removed)
    await expect(controller.delete({ sessionId: id, cwd })).resolves.toEqual({ deleted: true })
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(other)).toBeDefined()
    expect(await readFile(artifact, 'utf8')).toBe('retained output')
    expect(removed).toHaveBeenCalledWith(id)
    await expect(controller.inspect(id)).rejects.toThrow()
  })

  it('rejects a different workspace and active work without stopping it or changing the record', async () => {
    const { ctx, controller, cwd } = await harness()
    const id = await create(controller, 'protected-active')
    const agent = ctx.agents.get(id)!
    await ctx.sessions.flush(agent.session)
    const cancel = vi.spyOn(agent, 'cancel')
    await expect(controller.delete({ sessionId: id, cwd: '/wrong-workspace' }))
      .rejects.toMatchObject({ code: 'session/delete-cwd-conflict' })
    const release = ctx.on('workspace/session-activity', async ({ sessionId }, next) =>
      sessionId === id ? [{ kind: 'job', items: [{ id: 'active-background-video' }] }, ...await next()] : await next())
    await expect(controller.delete({ sessionId: id, cwd })).rejects.toMatchObject({ code: 'session/delete-active' })
    expect(ctx.agents.get(id)).toBe(agent)
    expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
    expect(cancel).not.toHaveBeenCalled()
    release()
    await controller.delete({ sessionId: id, cwd })
  })

  it('owns the idle phase and activation fence while awaiting activity, so new input cannot start a model call', async () => {
    const { ctx, controller, cwd } = await harness()
    const id = await create(controller, 'race-delete')
    const agent = ctx.agents.get(id)!
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      if (sessionId === id) { entered.resolve(undefined); await gate.promise }
      return await next()
    })
    const deletion = controller.delete({ sessionId: id, cwd })
    await entered.promise
    expect(await controller.resolveAgent(id)).toMatchObject({ error: { code: 'session/agent-busy' } })
    await expect(controller.create({ sessionId: id, cwd })).rejects.toMatchObject({ code: 'session/delete-active' })
    // A holder that acquired the Agent before deletion can enqueue, but the
    // maintenance phase holds its wake and disposal never starts that turn.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'late input' }], source: { kind: 'user' } }))
    gate.resolve(undefined)
    await deletion
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
  })

  it('refuses another maintenance owner and a foreign live Agent without deleting or stopping them', async () => {
    const { ctx, controller, cwd } = await harness()
    const id = await create(controller, 'maintenance-owner')
    const agent = ctx.agents.get(id)!
    const gate = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(() => gate.promise)
    await expect(controller.delete({ sessionId: id, cwd })).rejects.toMatchObject({ code: 'session/delete-active' })
    gate.resolve(undefined)
    await maintenance
    const foreign = await ctx.agents.create({ sessionId: SessionId('foreign-owner'), meta: { cwd } })
    await expect(controller.delete({ sessionId: foreign.agent.id, cwd })).rejects.toMatchObject({ code: 'session/delete-unavailable' })
    expect(ctx.agents.get(foreign.agent.id)).toBe(foreign.agent)
    expect(ctx.agents.get(id)).toBe(agent)
  })

  it('leaves a failed storage deletion recoverable and permits explicit retry without creating a Session', async () => {
    const { ctx, controller, cwd } = await harness()
    const id = await create(controller, 'storage-failure')
    await ctx.sessions.flush(ctx.agents.get(id)!.session)
    const removed = vi.fn()
    ctx.on('api-session/removed', removed)
    const remove = vi.spyOn(ctx.sessionPersistence, 'delete').mockRejectedValueOnce(new Error('synthetic disk refusal'))
    await expect(controller.delete({ sessionId: id, cwd })).rejects.toThrow('synthetic disk refusal')
    expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(removed).not.toHaveBeenCalled()
    await controller.delete({ sessionId: id, cwd })
    expect(remove).toHaveBeenCalledTimes(2)
    expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
    expect(removed).toHaveBeenCalledExactlyOnceWith(id)
  })

  it('refuses a real running turn without cancelling it', async () => {
    const { ctx, controller, cwd } = await harness()
    const id = await create(controller, 'running-turn')
    const agent = ctx.agents.get(id)!
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      entered.resolve(undefined)
      await gate.promise
      return await next()
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'synthetic held turn' }], source: { kind: 'user' } }))
    await entered.promise
    const cancel = vi.spyOn(agent, 'cancel')
    try {
      await expect(controller.delete({ sessionId: id, cwd })).rejects.toMatchObject({ code: 'session/delete-active' })
      expect(agent.status).toBe('running')
      expect(cancel).not.toHaveBeenCalled()
      expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
    } finally {
      agent.cancel({ kind: 'user' })
      gate.resolve(undefined)
      await agent.whenIdle()
    }
  })

  it('rejects a model selection whose asynchronous preparation returns after its original Agent was deleted', async () => {
    const { ctx, controller, cwd } = await harness()
    ctx.llm.registerAdapter(['fixture'], new class extends LlmAdapter {
      override listModels() { return Promise.resolve([{ provider: 'fixture', id: 'text', name: 'Text' }]) }
      override async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
    }())
    const id = await create(controller, 'late-selection')
    const oldAgent = ctx.agents.get(id)!
    await ctx.sessions.flush(oldAgent.session)
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const resolve = ctx.llm.resolveCallConfig.bind(ctx.llm)
    vi.spyOn(ctx.llm, 'resolveCallConfig').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await gate.promise
      return resolve(...args)
    })
    const selection = controller.selectModel({ sessionId: id, provider: 'fixture', model: 'text' })
      .then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }))
    await Promise.race([entered.promise, selection.then(() => { throw new Error('selection settled before its preparation gate') })])
    const original = oldAgent.session.snapshotEvents().filter(event => event.type === 'model/selection')
    await controller.delete({ sessionId: id, cwd })
    gate.resolve(undefined)
    expect(await selection).toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    expect(oldAgent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toEqual(original)
    expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
  })

  it('deletes an owned idle Session that never materialized, while an initially unknown id is refused', async () => {
    const { ctx, controller, cwd } = await harness()
    const id = await create(controller, 'unmaterialized-idle')
    await expect(controller.delete({ sessionId: id, cwd })).resolves.toEqual({ deleted: true })
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
    await expect(controller.delete({ sessionId: id, cwd })).rejects.toMatchObject({ code: 'session/not-found' })
  })
})
