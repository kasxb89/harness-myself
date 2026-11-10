/** Accepted submission identity survives the claim-to-user-message gap of the shipping loop. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'

it('acknowledges a claimed submission after a controller rebuild and still admits a different identity', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const requests: GenerateOptions[] = []
  ctx.llm.registerAdapter(['fixture'], new class extends LlmAdapter {
    override async listModels() { return [{ provider: 'fixture', id: 'text', name: 'Text' }] }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(request)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }())
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'text' }), cwd: '/tmp',
  })
  const sessionId = SessionId('claimed-submission')
  expect(await remote.create({ sessionId, cwd: '/tmp' })).toMatchObject({ ok: true })
  const gate = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  let first = true
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    if (first) { first = false; entered.resolve(undefined); await gate.promise }
    return await next()
  })
  const request: SessionPromptRequest = { sessionId, requestId: 'one' as SessionRequestId,
    mode: 'queue', content: [{ type: 'text', text: 'first request' }] }
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Expected the real loop Agent')
  try {
    expect(await remote.prompt(request)).toMatchObject({ ok: true })
    await entered.promise
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
    const rebuilt = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), '/tmp')
    await expect(rebuilt.prompt(request)).resolves.toEqual({ accepted: true })
    expect(await remote.prompt(request)).toMatchObject({ ok: true })
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(await remote.prompt({ ...request, requestId: 'two' as SessionRequestId,
      content: [{ type: 'text', text: 'independent request' }] })).toMatchObject({ ok: true })
    expect(agent.inbox.nextTurn).toHaveLength(1)
    gate.resolve(undefined)
    await agent.whenIdle()
    expect(requests).toHaveLength(2)
    const humans = agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
      ? [event.data.source] : [])
    expect(humans).toMatchObject([{ rpcId: 'one' }, { rpcId: 'two' }])
  } finally {
    gate.resolve(undefined)
    await agent.whenIdle()
  }
})
