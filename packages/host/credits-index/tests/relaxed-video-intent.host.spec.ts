/** Real chat messages retain independent execution sources while optional video hints follow context. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tool-jobs'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  registerVideoGenerationIntent,
  videoGenerationIntentOf, type VideoGenerationIntent,
} from '../src/video-generation-intent.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

class ScriptAdapter extends LlmAdapter {
  constructor(private readonly script: StreamChunk[][]) { super() }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = this.script.shift()
    if (response === undefined) throw new Error('Unexpected model request after the scripted reply')
    yield* response
  }
}

function finalReply(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '方案已准备好。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AgentRegistry)
  registerVideoGenerationIntent(ctx)
  const captured: (VideoGenerationIntent | undefined)[] = []
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'generate_video', description: 'Observe the original human request without submitting media.', parameters: {},
    async execute(_args, exec) { captured.push(videoGenerationIntentOf(exec)); return [] },
  })))
  await ctx.plugin(AgentLoop, { agents: [] })
  const script: StreamChunk[][] = []
  ctx.llm.registerAdapter(['natural-video-script'], new ScriptAdapter(script))
  const agent = await ctx.agentLoop.create(SessionId('natural-video-chat'), { provider: 'natural-video-script', model: 'script' })
  let call = 0
  async function send(
    text: string, inspect = false,
    source: Parameters<typeof createUserMessage>[0]['source'] = { kind: 'user' },
    target: Agent = agent,
  ) {
    if (inspect) script.push([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId(`inspect-${String(++call)}`), name: 'generate_video', arguments: '{}',
      } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    script.push(finalReply())
    const message = createUserMessage({ source, content: [{ type: 'text', text }] })
    target.followup(message)
    await target.whenIdle()
    expect(script).toEqual([])
    return message
  }
  function sourceSeq(messageId: string): number {
    const event = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === messageId)
    if (event === undefined) throw new Error('Expected the committed human message')
    return event.seq
  }
  return { ctx, agent, captured, send, sourceSeq }
}

describe('human sources through the production AgentLoop', () => {
  it.each([
    '能帮我生成一条30秒视频吗', '可以帮我生成3条30秒的美剧视频吗？',
    '给我整一条30秒短片', '我要一条30秒的美剧视频', '把这张图做成一条30秒视频',
    '生成一条30秒视频，台词是“为什么世界这么大”', '生成一条30秒视频，不要生成字幕',
    '帮我把这张图做成视频', '用这张图生成视频', '再来两个海边版本',
  ])('attributes an actual tool execution without a quantity or intent whitelist: %s', async (text) => {
    const f = await harness()
    const source = await f.send(text, true)
    expect(f.captured[0]?.grant).toMatchObject({ messageId: source.id, sourceSeq: f.sourceSeq(source.id), turn: 1 })
    expect(f.captured[0]?.grant).not.toHaveProperty('maxWorks')
  })

  it.each(['好的开始吧', '按刚才方案继续', '开始生成吧', '继续生成这个视频'])(
    'keeps the latest real source distinct while inheriting optional hints for %s', async (text) => {
      const f = await harness()
      const original = await f.send('生成一条30秒的美剧视频')
      const followup = await f.send(text, true)
      expect(f.captured[0]).toMatchObject({
        grant: { messageId: followup.id, sourceSeq: f.sourceSeq(followup.id), turn: 2 },
        requestedDurationSeconds: 30,
      })
      expect(f.captured[0]?.grant.messageId).not.toBe(original.id)
      expect(f.captured[0]?.grant).not.toHaveProperty('maxWorks')
    },
  )

  it('inherits relevant parameters without merging separate human source identities', async () => {
    const f = await harness()
    const original = await f.send('生成一条视频')
    const parameters = await f.send('竖屏，30秒', true)
    const quality = await f.send('改成2K，改用 bt-seedance-2.0', true)
    expect(f.captured).toHaveLength(2)
    expect(f.captured[0]).toMatchObject({ grant: { messageId: parameters.id }, requestedDurationSeconds: 30 })
    expect(f.captured[1]).toMatchObject({ grant: { messageId: quality.id }, requestedDurationSeconds: 30,
      requestedResolution: '2K', requestedModel: 'bt-seedance-2.0' })
    expect(new Set([original.id, ...f.captured.map(intent => intent?.grant.messageId)]).size).toBe(3)
    for (const intent of f.captured) expect(intent?.grant).not.toHaveProperty('maxWorks')
  })

  it.each(['再来一条30秒视频', '重新生成一条30秒视频', '另外做海边的两个版本'])(
    'keeps a new request independent from an earlier request: %s', async (text) => {
      const f = await harness()
      const original = await f.send('生成一条10秒视频', true)
      const next = await f.send(text, true)
      expect(f.captured.map(intent => intent?.grant.messageId)).toEqual([original.id, next.id])
      expect(f.captured[1]?.grant).toMatchObject({ sourceSeq: f.sourceSeq(next.id), turn: 2 })
    },
  )

  it.each(['agent-message', 'tool-jobs'] as const)(
    'cannot mint a human source from %s even with explicit generation wording', async (source) => {
      const f = await harness()
      await f.send('生成一条30秒视频')
      await f.send('好的开始吧，生成3条视频', true, source === 'agent-message'
        ? { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('another-chat') }
        : { kind: 'tool-jobs', form: 'notice', summary: 'An earlier task completed' })
      expect(f.captured).toEqual([undefined])
    },
  )

  it.each(['改成H3', '模型为H3', '改成bt-seedance-2.0'])(
    'retains an explicit model hint on the actual parameter message: %s', async (text) => {
      const f = await harness()
      await f.send('生成一条30秒视频')
      const parameters = await f.send(text, true)
      expect(f.captured[0]).toMatchObject({
        grant: { messageId: parameters.id }, requestedDurationSeconds: 30,
        requestedModel: text.includes('bt-seedance') ? 'bt-seedance-2.0' : 'MiniMax-H3',
      })
    },
  )

  it('retains the finished duration while treating shot counts only as context hints', async () => {
    const f = await harness()
    await f.send('生成一条30秒视频')
    const segments = await f.send('分成3个镜头，每段10秒', true)
    expect(f.captured[0]).toMatchObject({ grant: { messageId: segments.id }, requestedDurationSeconds: 30 })
    expect(f.captured[0]?.grant).not.toHaveProperty('maxWorks')
  })

  it('captures a fresh human source in another chat without carrying earlier chat hints', async () => {
    const f = await harness()
    await f.send('生成一条30秒视频')
    const other = await f.ctx.agentLoop.create(SessionId('another-natural-video-chat'), {
      provider: 'natural-video-script', model: 'script',
    })
    const next = await f.send('好的开始吧', true, { kind: 'user' }, other)
    expect(f.captured[0]?.grant.messageId).toBe(next.id)
    expect(f.captured[0]?.requestedDurationSeconds).toBeUndefined()
  })
})
