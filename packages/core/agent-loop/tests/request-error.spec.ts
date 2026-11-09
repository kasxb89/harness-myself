import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, LlmError  } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function fail(message: string, code: string): () => never {
  return () => {
    throw new LlmError(message, code)
  }
}

describe('agent/request-error', () => {
  it('reassembles a selected model in the same step without claiming or admitting the human message again', async () => {
    const adapter = new MockAdapter([fail('reselect safely', 'SYNTHETIC_ZERO_SEND'), textResponse('ok')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('reassemble-model'), { provider: 'mock', model: 'first' })
      const selected: ModelSelectionRef = { current: { provider: 'mock', model: 'first' }, assembled: undefined }
      installModelSelection(agent.ctx, selected)
      let assemblies = 0
      let preSteps = 0
      ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { assemblies++; return await next() })
      ctx.on('agent/pre-step', async (_payload, next) => { preSteps++; return await next() })
      ctx.on('agent/request-error', async ({ model, hasOutput }) => {
        expect(model).toBe('first')
        expect(hasOutput).toBe(false)
        selected.current = { provider: 'mock', model: 'second' }
        return { kind: 'retry', reassemble: true }
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one human request' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.requests.map(request => request.model)).toEqual(['first', 'second'])
      expect(assemblies).toBe(2)
      expect(preSteps).toBe(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses a reassemble action once any partial content or usage has been delivered', async () => {
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'SYNTHETIC_ZERO_SEND', message: 'not safe after output' } } },
    ], textResponse('unused')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('no-reassemble-after-output'), { provider: 'mock', model: 'first' })
      ctx.on('agent/request-error', async ({ hasOutput }) => {
        expect(hasOutput).toBe(true)
        return { kind: 'retry', reassemble: true }
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one human request' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error' } } })
    } finally { await ctx.fiber.dispose() }
  })

  it('releases a recovery owner when its turn settles so disposal does not cancel a later ordinary turn', async () => {
    const adapter = new MockAdapter([fail('reselect safely', 'SYNTHETIC_ZERO_SEND'), textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('recovery-owner-next-turn'), { provider: 'mock', model: 'first' })
      const owner = new AbortController()
      ctx.on('agent/request-error', async () => ({ kind: 'retry', reassemble: true, signal: owner.signal }))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first request' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      owner.abort()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'independent next turn' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(3)
      const endings = agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
      expect(endings).toEqual(['completed', 'completed'])
    } finally { await ctx.fiber.dispose() }
  })

  it('does not offer middleware failures to request recovery', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-narrow'), { provider: 'mock', model: 'mock' })
    let recoveries = 0
    ctx.on('agent/request', () => {
      throw new LlmError('middleware failed', 'MIDDLEWARE')
    })
    ctx.on('agent/request-error', async () => {
      recoveries += 1
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(recoveries).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })

  it('lets each failed request return a retry action before its turn closes', async () => {
    const adapter = new MockAdapter([
      fail('busy', 'RATE_LIMIT'),
      fail('unavailable', 'SERVICE_UNAVAILABLE'),
      textResponse('ok'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-retry'), { provider: 'mock', model: 'mock' })
    const seen: {
      turn: number
      step: number
      failure: LlmFailure
      retryPolicy: ResolvedRetryPolicy | undefined
    }[] = []
    const statuses: string[] = []
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent) statuses.push(status)
    })
    ctx.on('agent/request-error', async ({ agent: subject, turn, step, failure, retryPolicy }) => {
      expect(subject).toBe(agent)
      seen.push({ turn, step, failure, retryPolicy })
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(seen.map(item => ({
      turn: item.turn,
      step: item.step,
      code: item.failure.code,
    }))).toEqual([
      {
        turn: 1,
        step: 1,
        code: 'RATE_LIMIT',
      },
      {
        turn: 1,
        step: 1,
        code: 'SERVICE_UNAVAILABLE',
      },
    ])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(seen.map(item => item.retryPolicy)).toEqual([
      expect.objectContaining({ mode: 'normal' }),
      expect.objectContaining({ mode: 'normal' }),
    ])
    expect(statuses).toEqual(['running', 'idle'])
    expect(agent.session.snapshotEvents().flatMap(event =>
      event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial'])
  })

  it('lets cancellation win over a retry action', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-cancel'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async ({ agent: subject }) => {
      subject.cancel({ kind: 'user' })
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })

  it('does not retry when the recovery listener fails before returning its action', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-recovery-failed'), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.on('agent/request-error', async () => {
      throw new Error('recovery failed')
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
  })
})
