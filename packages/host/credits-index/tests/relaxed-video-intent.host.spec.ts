/** Natural video requests retain one human allowance through ordinary chat follow-ups. */
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
  humanVideoDurationSeconds, registerVideoGenerationIntent,
  videoGenerationIntentOf, videoWorkAllowance, type VideoGenerationIntent,
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

describe('ordinary video creation language', () => {
  it.each([
    ['能帮我生成一条30秒视频吗', 1, 30],
    ['可以帮我生成一条30秒视频吗？', 1, 30],
    ['能帮我生成三条30秒视频吗？', 3, 30],
    ['可以帮我生成3条30秒的美剧视频吗？', 3, 30],
    ['给我整一条30秒短片', 1, 30],
    ['给我整三条30秒短片', 3, 30],
    ['我要一条30秒的美剧视频', 1, 30],
    ['把这张图做成一条30秒视频', 1, 30],
    ['生成一条30秒视频，台词是“为什么世界这么大”', 1, 30],
    ['生成一条30秒视频，台词是为什么世界这么大', 1, 30],
    ['生成一条30秒视频，台词是“不要生成焦虑”', 1, 30],
    ['生成一条30秒视频，片名叫“怎么了”', 1, 30],
    ['生成一条30秒视频，不要生成字幕', 1, 30],
  ] as const)('accepts %s as %s finished works', (text, works, duration) => {
    expect(videoWorkAllowance(text)).toBe(works)
    expect(humanVideoDurationSeconds(text)).toBe(duration)
  })

  it.each([
    '能生成视频吗？', '你支持生成30秒视频吗？', '生成的视频怎么还没好？',
    '进度怎么样', '看看视频生成状态', '取消生成', '不要生成视频',
    '帮我写视频生成代码', '怎么生成30秒视频？', '生成视频的脚本，别真正生成',
    '翻译“给我整一条30秒视频”', '生成视频的提示词',
  ])('does not start paid work from %s', (text) => {
    expect(videoWorkAllowance(text)).toBe(0)
    expect(humanVideoDurationSeconds(text)).toBeUndefined()
  })
})

describe('ordinary follow-ups through the production AgentLoop', () => {
  it.each(['好的开始吧', '按刚才方案继续', '开始生成吧', '继续生成这个视频'])(
    'retains the original single-work source for %s', async (followup) => {
      const f = await harness()
      const original = await f.send('生成一条30秒的美剧视频')
      await f.send(followup, true)
      expect(f.captured).toHaveLength(1)
      expect(f.captured[0]).toMatchObject({
        grant: { messageId: original.id, sourceSeq: f.sourceSeq(original.id), maxWorks: 1, turn: 1 },
        requestedDurationSeconds: 30,
      })
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    },
  )

  it('adds duration and quality parameters to the original allowance without creating more works', async () => {
    const f = await harness()
    const original = await f.send('生成一条视频')
    await f.send('竖屏，30秒', true)
    await f.send('改成2K，改用 bt-seedance-2.0', true)
    expect(f.captured).toHaveLength(2)
    for (const intent of f.captured) {
      expect(intent?.grant).toMatchObject({ messageId: original.id, sourceSeq: f.sourceSeq(original.id), maxWorks: 1, turn: 1 })
      expect(intent?.requestedDurationSeconds).toBe(30)
    }
    expect(f.captured[1]).toMatchObject({ requestedResolution: '2K', requestedModel: 'bt-seedance-2.0' })
  })

  it('keeps the original explicit three-work allowance across ordinary confirmation', async () => {
    const f = await harness()
    const original = await f.send('能帮我生成三条30秒视频吗？')
    await f.send('好的开始吧', true)
    expect(f.captured[0]).toMatchObject({
      grant: { messageId: original.id, sourceSeq: f.sourceSeq(original.id), maxWorks: 3 }, requestedDurationSeconds: 30,
    })
  })

  it.each(['再来一条30秒视频', '重新生成一条30秒视频'])(
    'gives an explicit new request its own human source: %s', async (text) => {
      const f = await harness()
      const original = await f.send('生成一条30秒视频')
      const next = await f.send(text, true)
      expect(f.captured[0]?.grant).toMatchObject({ messageId: next.id, sourceSeq: f.sourceSeq(next.id), maxWorks: 1, turn: 2 })
      expect(f.captured[0]?.grant.messageId).not.toBe(original.id)
    },
  )

  it.each([
    '取消生成', '不要生成视频', '帮我写一封邮件', '我只想聊天', '换个话题',
    '风格不对暂时别生成', '风格说明不用生成视频', '字幕别做了先不生成',
    '台词是你好，先不要生成', '故事讲述不要生成焦虑，取消生成',
    '帮我查一下快递进度', '服务器状态正常吗', '明天去北京多久',
  ])(
    'does not reactivate an earlier request after %s', async (text) => {
      const f = await harness()
      await f.send('生成一条30秒视频')
      await f.send(text)
      await f.send('好的开始吧', true)
      expect(f.captured).toEqual([undefined])
    },
  )

  it.each(['好的开始吧', '按刚才方案继续', '竖屏，30秒'])(
    'requires an earlier human creation request before %s', async (text) => {
      const f = await harness()
      await f.send('先介绍一下你有哪些视频功能')
      await f.send(text, true)
      expect(f.captured).toEqual([undefined])
    },
  )

  it.each(['agent-message', 'tool-jobs'] as const)(
    'does not let %s confirm or parameterize an earlier human request', async (source) => {
      const f = await harness()
      await f.send('生成一条30秒视频')
      await f.send('好的开始吧，改成3条视频', true, source === 'agent-message'
        ? { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('another-chat') }
        : { kind: 'tool-jobs', form: 'notice', summary: 'An earlier task completed' })
      expect(f.captured).toEqual([undefined])
    },
  )

  it('does not turn a progress question into another video submission', async () => {
    const f = await harness()
    await f.send('生成一条30秒视频')
    await f.send('进度怎么样，生成的视频怎么还没好？', true)
    expect(f.captured).toEqual([undefined])
  })

  it.each(['改成H3', '模型为H3', '改成bt-seedance-2.0'])(
    'uses the requested model from %s without losing the earlier work', async (text) => {
      const f = await harness()
      const original = await f.send('生成一条30秒视频')
      await f.send(text, true)
      expect(f.captured[0]).toMatchObject({
        grant: { messageId: original.id, maxWorks: 1 },
        requestedDurationSeconds: 30,
        requestedModel: text.includes('bt-seedance') ? 'bt-seedance-2.0' : 'MiniMax-H3',
      })
    },
  )

  it.each(['进度怎么样', '还要等多久', '还得多久', '多久能好', '什么时候完成', '现在怎么样了'])(
    'continues after the progress query %s without authorizing the query itself', async (query) => {
      const f = await harness()
      const original = await f.send('生成一条30秒视频')
      await f.send(query, true)
      await f.send('好的开始吧', true)
      expect(f.captured).toHaveLength(2)
      expect(f.captured[0]).toBeUndefined()
      expect(f.captured[1]).toMatchObject({
        grant: { messageId: original.id, sourceSeq: f.sourceSeq(original.id), maxWorks: 1, turn: 1 },
        requestedDurationSeconds: 30,
      })
    },
  )

  it('changes the total finished-work quantity while retaining the original human source', async () => {
    const f = await harness()
    const original = await f.send('生成一条30秒视频')
    await f.send('改成3条成片', true)
    expect(f.captured[0]).toMatchObject({
      grant: { messageId: original.id, sourceSeq: f.sourceSeq(original.id), maxWorks: 3, turn: 1 },
      requestedDurationSeconds: 30,
    })
  })

  it('keeps three shots inside the original single-work allowance', async () => {
    const f = await harness()
    const original = await f.send('生成一条30秒视频')
    await f.send('分成3个镜头，每段10秒', true)
    expect(f.captured[0]).toMatchObject({
      grant: { messageId: original.id, sourceSeq: f.sourceSeq(original.id), maxWorks: 1, turn: 1 },
      requestedDurationSeconds: 30,
    })
  })

  it('does not carry the original allowance into a confirmation in another chat', async () => {
    const f = await harness()
    await f.send('生成一条30秒视频')
    const other = await f.ctx.agentLoop.create(SessionId('another-natural-video-chat'), {
      provider: 'natural-video-script', model: 'script',
    })
    await f.send('好的开始吧', true, { kind: 'user' }, other)
    expect(f.captured).toEqual([undefined])
  })
})
