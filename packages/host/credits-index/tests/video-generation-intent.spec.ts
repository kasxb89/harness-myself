import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import Tools, { defineContentToolFixture, type ToolExecution, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-tool-jobs'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-user-questions'
import { hasCurrentHumanRequest, humanVideoDurationSeconds, humanVideoModel, humanVideoResolution, parseVideoRequestGrant, registerVideoGenerationIntent, videoGenerationIntentOf, videoModelChoiceCancelled, videoGenerationIntentProjection } from '../src/video-generation-intent.ts'

describe('optional human video parameter hints', () => {
  it.each([
    ['生成一条30s的美剧视频', 30], ['生成3条30秒的美剧视频', 30],
    ['能帮我生成三条30秒视频吗？', 30], ['给我整一条30秒短片', 30],
    ['我要一个30秒海边视频', 30], ['用这张图生成30秒视频', 30],
    ['生成120秒视频，分8个镜头，每段15秒', 120], ['生成一条两分钟竖屏视频', 120],
    ['生成一条30秒视频，台词是为什么世界这么大', 30],
    ['生成30秒视频，不要生成字幕', 30], ['生成4秒视频，参考两条10秒视频', 4],
    ['参考视频时长10秒，生成一条30秒视频', 30],
    ['生成视频，30秒以前的视频作为参考', undefined],
    ['生成视频，参考一条30秒视频、两条15秒视频', undefined],
    ['生成视频，分镜一条30秒视频、两条15秒视频', undefined],
    ['生成视频，标题叫一条30秒视频', undefined],
    ['生成视频，台词是一条30秒视频', undefined],
    ['翻译“生成30秒视频”', undefined], ['生成“30秒视频”', undefined],
    ['生成30秒或60秒视频', undefined], ['生成30秒视频和15秒视频', undefined],
    ['生成30到60秒视频', undefined], ['生成0秒视频', undefined],
    ['生成视频，先不要生成30秒视频', undefined],
  ] as const)('reads optional output duration from %s', (text, seconds) => {
    expect(humanVideoDurationSeconds(text)).toBe(seconds)
  })

  it.each([
    ['生成768k视频', '768P'], ['用H3生成一条768P视频', '768P'], ['生成2K视频', '2K'],
    ['生成1280×720视频', '1280x720'], ['生成15秒视频', undefined],
    ['生成2K视频，不要字幕', '2K'], ['不要2K，生成768P视频', '768P'],
    ['生成768P或者2K视频', undefined], ['生成“2K”视频', undefined],
    ['看看2K视频进度', undefined], ['768P', '768P'],
  ] as const)('reads optional output resolution from %s', (text, resolution) => {
    expect(humanVideoResolution(text)).toBe(resolution)
  })

  it.each([
    ['生成15秒视频，使用 video-sd25-480p。', 'video-sd25-480p'],
    ['用H3生成15秒视频', 'MiniMax-H3'], ['H3 15秒视频', 'MiniMax-H3'],
    ['Generate a video using video-sd25-480p.', 'video-sd25-480p'],
    ['生成15秒视频，不用 video-sd25-480p', undefined], ['使用两个模型', undefined],
    ['使用H3，改用 bt-seedance-2.0', undefined],
  ] as const)('reads only an explicit exact model from %s', (text, model) => {
    expect(humanVideoModel(text)).toBe(model)
  })
})

function sessionFixture(meta: { origin?: 'subagent'; parentSession?: SessionId } = {}) {
  const id = SessionId('intent-chat')
  return Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd: '/workspace', ...meta })
}

function fold(session: Session, inherited = SessionLogOffset(0)) {
  let state: Parameters<typeof videoGenerationIntentProjection.apply>[0]
    = videoGenerationIntentProjection.init(session.header, inherited)
  for (const event of session.snapshotEvents()) state = videoGenerationIntentProjection.apply(state, event)
  return state
}

it('clears active source at a new turn without new human input', () => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成三条视频' }] })
  session.append('user/message', human, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('root-0'), name: 'run_ptc', arguments: '{}' })
  session.append('tool/ptc-dispatch-start', { rootCallId: ToolCallId('root-0'), parentCallId: ToolCallId('root-0'),
    subCallId: ToolCallId('child-0'), name: 'generate_video', arguments: {} })
  const state = fold(session)
  expect(state.requests[0]).toMatchObject({ messageId: human.id, turn: 1 })
  expect(state.activeHumanRevision).toBeUndefined()
  expect(state.calls).toEqual([])
})

it.each(['普通的新请求，按上下文处理', '再来两个海边版本', '好的开始吧', '30秒，H3，768P'])(
  'captures every real message as a new source independently of video grammar: %s', (text) => {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    const first = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一条10秒视频' }] })
    session.append('user/message', first, { surfaceOp: 'append' })
    const next = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    const nextEvent = session.append('user/message', next, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn: 1, step: 2, callId: ToolCallId('next-source'), name: 'generate_video', arguments: '{}' })
    const state = fold(session)
    expect(state.requests.map(request => request.messageId)).toEqual([first.id, next.id])
    expect(state.requests.at(-1)).toMatchObject({ messageId: next.id, sourceSeq: nextEvent.seq, turn: 1 })
    expect(state.requests.at(-1)).not.toHaveProperty('maxWorks')
    expect(state.activeHumanRevision).toEqual({ messageId: next.id, seq: nextEvent.seq })
    expect(state.calls.at(-1)).toMatchObject({ messageId: next.id, rootCallSeq: call.seq })
  },
)

it('keeps inherited session history inactive while accepting a fresh human in an ordinary fork', () => {
  const session = sessionFixture({ parentSession: SessionId('fork-parent') })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成旧视频' }] }),
    { surfaceOp: 'append' })
  const inherited = SessionLogOffset(session.snapshotEvents().length)
  session.append('turn/start', { turn: 2 })
  session.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('inherited-call'), name: 'generate_video', arguments: '{}' })
  expect(fold(session, inherited).calls).toEqual([])
  const fresh = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '新作品' }] })
  session.append('user/message', fresh, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 2, step: 2, callId: ToolCallId('fresh-call'), name: 'generate_video', arguments: '{}' })
  expect(fold(session, inherited).calls.map(call => call.messageId)).toEqual([fresh.id])
})

it('does not promote a delegated subagent user-shaped message into a human source', () => {
  const session = sessionFixture({ origin: 'subagent', parentSession: SessionId('human-parent') })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一条视频' }] }),
    { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('child-call'), name: 'generate_video', arguments: '{}' })
  expect(fold(session).requests).toEqual([])
  expect(fold(session).calls).toEqual([])
  expect(fold(session).activeHumanRevision).toBeUndefined()
})

it.each(['agent-message', 'tool-jobs'] as const)('clears the active human revision when %s arrives in the same turn', (kind) => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '按上下文制作视频' }] })
  const event = session.append('user/message', human, { surfaceOp: 'append' })
  expect(fold(session).activeHumanRevision).toEqual({ messageId: human.id, seq: event.seq })
  session.append('user/message', createUserMessage({
    source: kind === 'agent-message' ? { kind, form: 'relay', senderSessionId: SessionId('other-chat') }
      : { kind, form: 'notice', summary: 'A background job settled.' },
    content: [{ type: 'text', text: '总共改为三条' }],
  }), { surfaceOp: 'append' })
  expect(fold(session).activeHumanRevision).toBeUndefined()
})

it('keeps the real human revision across internal context metadata', () => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '制作视频' }] })
  const event = session.append('user/message', human, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'notice', summary: 'Internal runtime metadata.' },
    content: [{ type: 'text', text: 'Internal runtime metadata.' }] }), { surfaceOp: 'append' })
  expect(fold(session).activeHumanRevision).toEqual({ messageId: human.id, seq: event.seq })
})

it.each(['missing', 'ambiguous'] as const)('does not mint a revision from a %s pending-question identity', (kind) => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '制作视频' }] })
  session.append('user/message', human, { surfaceOp: 'append' })
  if (kind === 'ambiguous') {
    for (const step of [1, 2]) {
      const call = session.append('tool/call', { turn: 1, step, callId: ToolCallId('same-question'), name: 'ask_user_question', arguments: '{}' })
      session.append('tool/result', { turn: 1, step, message: createToolResultMessage({ callId: ToolCallId('same-question'), isError: false,
        content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: 'same-question' }) }] }) },
      { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({
    source: { kind: 'user-question-reply', callId: ToolCallId('same-question'), outcome: 'answered' },
    content: [{ type: 'text', text: '总共三条' }],
  }), { surfaceOp: 'append' })
  expect(fold(session).activeHumanRevision).toBeUndefined()
})

it('captures the actual late human reply revision without changing its original work source', async () => {
  const { ctx, session, agent } = await executionFixture()
  session.append('turn/start', { turn: 1 })
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '先准备一条视频' }] })
  const originalEvent = session.append('user/message', original, { surfaceOp: 'append' })
  const question = session.append('tool/call', { turn: 1, step: 1,
    callId: ToolCallId('ask-quantity'), name: 'ask_user_question', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('ask-quantity'), isError: false,
      content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: 'ask-quantity' }) }] }) },
  { surfaceOp: 'append', sourceEventSeqs: [question.seq] })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const reply = createUserMessage({
    source: { kind: 'user-question-reply', callId: ToolCallId('ask-quantity'), outcome: 'answered' },
    content: [{ type: 'text', text: '总共三条' }],
  })
  const replyEvent = session.append('user/message', reply, { surfaceOp: 'append' })
  expect(fold(session).activeHumanRevision).toEqual({ messageId: reply.id, seq: replyEvent.seq })
  session.append('tool/call', { turn: 2, step: 1,
    callId: ToolCallId('append-after-answer'), name: 'append_video_works', arguments: '{}' })
  let observed: ReturnType<typeof videoGenerationIntentOf>
  ctx.tools.register(defineContentToolFixture({ name: 'append_video_works', description: 'Capture the exact quantity answer.', parameters: {},
    async execute(_args, exec) {
      session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: '另一个独立的新请求' }] }), { surfaceOp: 'append' })
      observed = videoGenerationIntentOf(exec)
      return []
    } }))
  await ctx.tools.execute({ signal: new AbortController().signal, agent, callId: ToolCallId('append-after-answer'),
    name: 'append_video_works', arguments: {} })
  expect(observed?.grant).toMatchObject({ messageId: original.id, sourceSeq: originalEvent.seq, turn: 1 })
  expect(observed?.humanRevision).toEqual({ messageId: reply.id, seq: replyEvent.seq })
})

it('reads current private sources and validates optional positive legacy limits without emitting them', () => {
  expect(parseVideoRequestGrant(undefined)).toBeUndefined()
  const source = { schema: 1, messageId: 'human-1', sourceSeq: 1, turn: 1, callId: 'call-1', rootCallId: 'call-1' }
  expect(parseVideoRequestGrant(source)).toEqual(source)
  expect(parseVideoRequestGrant({ ...source, maxWorks: undefined })).toEqual(source)
  expect(parseVideoRequestGrant({ ...source, maxWorks: 3 })).toEqual({ ...source, maxWorks: 3 })
  expect(parseVideoRequestGrant({ ...source, rootCallSeq: 0 })).toEqual({ ...source, rootCallSeq: 0 })
  for (const value of [{ ...source, maxWorks: 0 }, { ...source, sourceSeq: -1 }, { ...source, maxWorks: 1.5 },
    { ...source, model_count: 3 }, { ...source, requestedResolution: '2K' }, { ...source, requestedModel: 'model-1' },
    { ...source, cancelled: true }, { ...source, requestedDurationSeconds: 10 },
    { ...source, humanRevision: { messageId: 'reply', seq: 2 } },
    { ...source, rootCallSeq: -1 }, { ...source, rootCallSeq: 1.5 }]) {
    expect(parseVideoRequestGrant(value)).toBeNull()
  }
})

it('marks only the exact cancelled selection call without cancelling sibling works or later human sources', () => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成两条768P视频' }] })
  session.append('user/message', original, { surfaceOp: 'append' })
  const callId = ToolCallId('cancelled-choice')
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'generate_video_project', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: JSON.stringify({ status: 'failed', code: 'USER_CANCELLED' }) }], isError: false }) },
  { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('tool/call', { turn: 1, step: 2, callId: ToolCallId('sibling'), name: 'generate_video', arguments: '{}' })
  const state = fold(session)
  expect(state.requests[0]).not.toHaveProperty('cancelled')
  expect(state.calls.map(value => [value.callId, value.cancelled])).toEqual([['cancelled-choice', true], ['sibling', undefined]])
  const next = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '再生成一条视频' }] })
  session.append('user/message', next, { surfaceOp: 'append' })
  expect(fold(session).requests.at(-1)).toMatchObject({ messageId: next.id })
})

const executionContexts = new Set<Context>()
afterEach(async () => {
  await Promise.all([...executionContexts].map(ctx => ctx.fiber.dispose()))
  executionContexts.clear()
})

async function executionFixture(register = true, meta: Parameters<typeof sessionFixture>[0] = {}) {
  const ctx = new Context()
  executionContexts.add(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(SessionProjections)
  const feature = register ? await ctx.plugin((owner: Context) => { registerVideoGenerationIntent(owner) }) : undefined
  const session = sessionFixture(meta)
  const unsupported = (): never => { throw new Error('fixture inbox is not mutable') }
  const agent: Agent = {
    id: session.header.id, session, ctx, options: {}, status: 'running',
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported,
      replace: unsupported, remove: unsupported, splice: unsupported },
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
  return { ctx, session, agent, feature }
}


it.each(['subagent-header', 'live-parent'] as const)('rejects user-shaped delegated executions identified by %s', async (kind) => {
  const { ctx, session, agent } = await executionFixture(true, kind === 'subagent-header'
    ? { origin: 'subagent', parentSession: SessionId('owner') } : {})
  if (kind === 'live-parent') {
    await ctx.plugin(AgentRegistry)
    const parentId = SessionId('runtime-owner')
    const parentSession = Session.create(parentId, [], { version: SESSION_FORMAT_VERSION, id: parentId,
      createdAt: 0, isSeeded: false, cwd: '/workspace' })
    const parent: Agent = { ...agent, id: parentId, session: parentSession }
    ctx.effect(() => ctx.agents.enter(parent, undefined))
    ctx.effect(() => ctx.agents.enter(agent, parent))
    expect(agent.session.header.parentSession).toBeUndefined()
    expect(ctx.agents.isOwnedBy(agent.id, parent)).toBe(true)
  }
  const observed: (ReturnType<typeof videoGenerationIntentOf> | boolean)[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Inspect delegated ownership.', parameters: {},
    async execute(_args, exec) { observed.push(videoGenerationIntentOf(exec), hasCurrentHumanRequest(exec)); return [] } }))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成视频' }] }),
    { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('delegated-video'), name: 'generate_video', arguments: '{}' })
  await ctx.tools.execute({ agent, name: 'generate_video', callId: ToolCallId('delegated-video'),
    arguments: {}, signal: new AbortController().signal })
  expect(observed).toEqual([undefined, false])
})


it.each([false, true])('uses live ownership rather than fork lineage alone to classify a child=%s', async (child) => {
  const parentId = SessionId('owner')
  const { ctx, session, agent } = await executionFixture(true, { parentSession: parentId })
  await ctx.plugin(AgentRegistry)
  const parentSession = Session.create(parentId, [], { version: SESSION_FORMAT_VERSION, id: parentId,
    createdAt: 0, isSeeded: false, cwd: '/workspace' })
  const parent: Agent = { ...agent, id: parentId, session: parentSession }
  ctx.effect(() => ctx.agents.enter(parent, undefined))
  ctx.effect(() => ctx.agents.enter(agent, child ? parent : undefined))
  const observed: boolean[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Inspect live ownership.', parameters: {},
    async execute(_args, exec) { observed.push(hasCurrentHumanRequest(exec)); return [] } }))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '新作品' }] }),
    { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('ownership'), name: 'generate_video', arguments: '{}' })
  await ctx.tools.execute({ agent, name: 'generate_video', callId: ToolCallId('ownership'),
    arguments: {}, signal: new AbortController().signal })
  expect(observed).toEqual([!child])
})

it('does not let a delegated execution borrow an opaque human PTC parent token', async () => {
  const { ctx, session, agent } = await executionFixture()
  await ctx.plugin(AgentRegistry)
  const childId = SessionId('delegated-child')
  const childSession = Session.create(childId, [], { version: SESSION_FORMAT_VERSION, id: childId,
    createdAt: 0, isSeeded: false, cwd: '/workspace' })
  const delegated: Agent = { ...agent, id: childId, session: childSession }
  ctx.effect(() => ctx.agents.enter(agent, undefined))
  ctx.effect(() => ctx.agents.enter(delegated, agent))
  expect(ctx.agents.isOwnedBy(delegated.id, agent)).toBe(true)
  const observed: boolean[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Inspect borrowed parent.', parameters: {},
    async execute(_args, exec) { observed.push(hasCurrentHumanRequest(exec)); return [] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'video-composite', description: 'Dispatch with a delegated agent.', parameters: {},
    async execute(_args, exec) {
      expect(hasCurrentHumanRequest(exec)).toBe(true)
      await ctx.tools.execute({ agent: delegated, signal: exec.signal, callId: ToolCallId('borrowed-child'),
        rootCallId: exec.rootCallId, parent: exec.token, name: 'generate_video', arguments: {} })
      return []
    } }))
  session.append('turn/start', { turn: 1 })
  childSession.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一条视频' }] })
  session.append('user/message', human, { surfaceOp: 'append' })
  childSession.append('user/message', human, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('human-parent'), name: 'video-composite', arguments: '{}' })
  await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('human-parent'),
    name: 'video-composite', arguments: {} })
  expect(observed).toEqual([false])
})

it('reports cancellation only on the exact execution call while allowing sibling calls to retain their source', async () => {
  const { ctx, session, agent } = await executionFixture()
  const observed: boolean[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Inspect exact selection cancellation.', parameters: {},
    async execute(_args, exec) {
      observed.push(videoModelChoiceCancelled(exec))
      if (exec.callId === 'cancel-this') {
        const event = session.snapshotEvents().findLast(event => event.type === 'tool/call' && event.data.callId === exec.callId)
        if (event === undefined) throw new Error('Expected the logged call')
        session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: exec.callId,
          content: [{ type: 'text', text: JSON.stringify({ status: 'failed', code: 'USER_CANCELLED' }) }], isError: false }) },
        { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
        observed.push(videoModelChoiceCancelled(exec))
      }
      expect(hasCurrentHumanRequest(exec)).toBe(true)
      return []
    } }))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成两条视频' }] }),
    { surfaceOp: 'append' })
  for (const callId of [ToolCallId('cancel-this'), ToolCallId('next-work')]) {
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'generate_video', arguments: '{}' })
    await ctx.tools.execute({ agent, name: 'generate_video', callId, arguments: {}, signal: new AbortController().signal })
  }
  expect(observed).toEqual([false, true, false])
})

it.each([false, true])('keeps reused provider call ids independent with oneHuman=%s through the real tool pipeline', async (oneHuman) => {
  const { ctx, session, agent } = await executionFixture()
  const observed: ReturnType<typeof videoGenerationIntentOf>[] = []
  const executions: ToolRunContext[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Capture native attribution.', parameters: {},
    async execute(_args, exec) { executions.push(exec); observed.push(videoGenerationIntentOf(exec)); return [] } }))
  session.append('turn/start', { turn: 1 })
  const a = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: oneHuman ? '生成3条4秒的H3视频' : '生成一条4秒的H3视频' }] })
  session.append('user/message', a, { surfaceOp: 'append' })
  const expectedOwners = [a.id]
  const roots: number[] = []
  for (let index = 0; index < 3; index++) {
    if (index > 0 && !oneHuman) {
      session.append('turn/end', { turn: index, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: index + 1 })
      const b = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '另外生成一条4秒的H3视频' }] })
      session.append('user/message', b, { surfaceOp: 'append' })
      expectedOwners.push(b.id)
    }
    const turn = oneHuman ? 1 : index + 1
    const event = session.append('tool/call', { turn, step: index + 1, callId: ToolCallId('call-0'), name: 'generate_video', arguments: '{}' })
    roots.push(event.seq)
    const result = await ctx.tools.execute({ signal: new AbortController().signal, agent, callId: ToolCallId('call-0'), name: 'generate_video', arguments: {} })
    expect(result.isError).toBe(false)
    session.append('tool/result', { turn, step: index + 1, message: createToolResultMessage({ callId: ToolCallId('call-0'), content: [], isError: false }) },
      { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
  }
  expect(observed.map(intent => intent?.grant.messageId)).toEqual(oneHuman ? [a.id, a.id, a.id] : expectedOwners)
  expect(observed.map(intent => intent?.grant.rootCallSeq)).toEqual(roots)
  expect(new Set(roots).size).toBe(3)
  for (const exec of executions) expect(videoGenerationIntentOf(exec)).toBeUndefined()
})

it('does not infer trusted intent when the execution capture was never registered', async () => {
  const { ctx, session, agent } = await executionFixture(false)
  ctx.sessionProjections.register(videoGenerationIntentProjection)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一条视频' }] }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-0'), name: 'generate_video', arguments: '{}' })
  let intent: ReturnType<typeof videoGenerationIntentOf>
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Inspect missing capture.', parameters: {},
    async execute(_args, exec) { intent = videoGenerationIntentOf(exec); return [] } }))
  await ctx.tools.execute({ signal: new AbortController().signal, agent, callId: ToolCallId('call-0'), name: 'generate_video', arguments: {} })
  expect(intent).toBeUndefined()
})

it.each(['生成一张图片。', '生成一条视频，并先画人物参考图。'])('attributes image tool executions to a human independently of video allowance: %s', async (text) => {
  const { ctx, session, agent } = await executionFixture()
  const observed: boolean[] = []
  let captured: ToolExecution | undefined
  ctx.tools.register(defineContentToolFixture({ name: 'generate_image', description: 'Observe human attribution.', parameters: {},
    async execute(_args, exec) { captured = exec; observed.push(hasCurrentHumanRequest(exec)); return [] } }))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('image-human'), name: 'generate_image', arguments: '{}' })
  await ctx.tools.execute({ agent, name: 'generate_image', callId: ToolCallId('image-human'), arguments: {}, signal: new AbortController().signal })
  expect(observed).toEqual([true])
  expect(fold(session).requests[0]).not.toHaveProperty('maxWorks')
  if (captured === undefined) throw new Error('Expected captured image execution')
  expect(hasCurrentHumanRequest(captured)).toBe(false)
})

it.each(['agent-message', 'tool-jobs'] as const)('does not grant image calls the old human ownership in a new %s turn', async (kind) => {
  const { ctx, session, agent } = await executionFixture()
  const observed: boolean[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'generate_image', description: 'Observe human ownership.', parameters: {},
    async execute(_args, exec) { observed.push(hasCurrentHumanRequest(exec)); return [] } }))
  const call = () => ctx.tools.execute({ agent, name: 'generate_image', callId: ToolCallId('call-0'), arguments: {}, signal: new AbortController().signal })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一张图片' }] }), { surfaceOp: 'append' })
  const first = session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-0'), name: 'generate_image', arguments: '{}' })
  await call()
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('call-0'), content: [], isError: false }) },
    { surfaceOp: 'append', sourceEventSeqs: [first.seq] })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({
    source: kind === 'agent-message' ? { kind, form: 'relay', senderSessionId: SessionId('peer') }
      : { kind, form: 'notice', summary: 'A job ended.' },
    content: [{ type: 'text', text: '生成一张图片' }],
  }), { surfaceOp: 'append' })
  await call()
  session.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('call-0'), name: 'generate_image', arguments: '{}' })
  await call()
  expect(observed).toEqual([true, false, false])
})

it('carries image ownership through the opaque PTC parent without requiring a video allowance', async () => {
  const { ctx, session, agent } = await executionFixture()
  const observed: boolean[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'generate_image', description: 'Observe image PTC ownership.', parameters: {},
    async execute(_args, exec) {
      observed.push(hasCurrentHumanRequest(exec))
      expect(videoGenerationIntentOf(exec)?.grant).not.toHaveProperty('maxWorks')
      return []
    } }))
  ctx.tools.register(defineContentToolFixture({ name: 'image-composite', description: 'Dispatch image child.', parameters: {},
    async execute(_args, exec) {
      const subCallId = ToolCallId('image-child')
      const data = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId, name: 'generate_image', arguments: {} }
      session.append('tool/ptc-dispatch-start', data)
      const result = await ctx.tools.execute({ agent, signal: exec.signal, callId: subCallId, rootCallId: exec.rootCallId,
        parent: exec.token, name: 'generate_image', arguments: {} })
      session.append('tool/ptc-dispatch', { ...data, isError: result.isError, content: result.content })
      return []
    } }))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '画一张图片' }] }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('image-parent'), name: 'image-composite', arguments: '{}' })
  await ctx.tools.execute({ agent, signal: new AbortController().signal, callId: ToolCallId('image-parent'), name: 'image-composite', arguments: {} })
  expect(observed).toEqual([true])
})

it.each(['agent-message', 'tool-jobs'] as const)('does not reuse unused human quota in a new %s turn with a repeated raw call id', async (kind) => {
  const { ctx, session, agent } = await executionFixture()
  const observed: ReturnType<typeof videoGenerationIntentOf>[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Observe the request authorization.', parameters: {},
    async execute(_args, exec) { observed.push(videoGenerationIntentOf(exec)); return [] } }))
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成3条10秒视频' }] })
  session.append('user/message', human, { surfaceOp: 'append' })
  const first = session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-0'), name: 'generate_video', arguments: '{}' })
  await ctx.tools.execute({ signal: new AbortController().signal, agent, callId: ToolCallId('call-0'), name: 'generate_video', arguments: {} })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('call-0'), content: [], isError: false }) },
    { surfaceOp: 'append', sourceEventSeqs: [first.seq] })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({
    source: kind === 'agent-message'
      ? { kind, form: 'relay', senderSessionId: SessionId('peer-session') }
      : { kind, form: 'notice', summary: 'An existing job completed.' },
    content: [{ type: 'text', text: '生成3条10秒视频' }],
  }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('call-0'), name: 'generate_video', arguments: '{}' })
  await ctx.tools.execute({ signal: new AbortController().signal, agent, callId: ToolCallId('call-0'), name: 'generate_video', arguments: {} })
  expect(observed[0]?.grant).toMatchObject({ messageId: human.id, turn: 1 })
  expect(observed[1]).toBeUndefined()
  expect(fold(session).calls).toHaveLength(1)
})

it('does not attribute new native calls after a foreign notice or relay in the same turn', () => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成3条视频' }] })
  session.append('user/message', human, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('first'), name: 'generate_video', arguments: '{}' })
  session.append('user/message', createUserMessage({ source: { kind: 'tool-jobs', form: 'notice', summary: 'Existing work completed.' },
    content: [{ type: 'text', text: 'Unrelated job notification.' }] }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 2, callId: ToolCallId('second'), name: 'generate_video', arguments: '{}' })
  session.append('user/message', createUserMessage({ source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('peer') },
    content: [{ type: 'text', text: 'Unrelated peer context.' }] }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 3, callId: ToolCallId('third'), name: 'generate_video', arguments: '{}' })
  expect(fold(session).calls.map(call => call.messageId)).toEqual([human.id])
})

it.each([
  { kind: 'system-prompt' }, { kind: 'ptc-mode' },
  { kind: 'model-selection', form: 'notice', summary: 'The model changed.' },
  { kind: 'user-approval', form: 'notice', summary: 'The approval mode changed.' },
] as const)('preserves a current human through $kind metadata without minting a new source', (source) => {
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一条视频' }] })
  for (const hasHuman of [false, true]) {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    if (hasHuman) session.append('user/message', human, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ source,
      content: [{ type: 'text', text: 'Internal metadata does not create another human request.' }] }), { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('after-metadata'), name: 'generate_video', arguments: '{}' })
    expect(fold(session).calls.map(call => call.messageId)).toEqual(hasHuman ? [human.id] : [])
    expect(fold(session).requests.map(request => request.messageId)).toEqual(hasHuman ? [human.id] : [])
  }
})

it('pairs late reused-id results by exact source event and cancels only the owning call', () => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const humans = ['生成一条4秒的H3视频', '另外生成一条10秒的H3视频'].map(text =>
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  const calls = humans.map((human, index) => {
    session.append('user/message', human, { surfaceOp: 'append' })
    return session.append('tool/call', { turn: 1, step: index + 1, callId: ToolCallId('call-0'), name: 'generate_video', arguments: '{}' })
  })
  const a = calls[0]!
  const b = calls[1]!
  session.append('tool/result', { turn: 1, step: 2, message: createToolResultMessage({ callId: ToolCallId('call-0'),
    content: [{ type: 'text', text: JSON.stringify({ operation_id: 'op_b' }) }], isError: false }) },
  { surfaceOp: 'append', sourceEventSeqs: [b.seq] })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('call-0'),
    content: [{ type: 'text', text: JSON.stringify({ status: 'failed', code: 'USER_CANCELLED' }) }], isError: false }) },
  { surfaceOp: 'append', sourceEventSeqs: [a.seq] })
  const state = fold(session)
  expect(state.requests.map(request => request.messageId)).toEqual(humans.map(human => human.id))
  expect(state.calls.map(call => [call.rootCallSeq, call.cancelled])).toEqual([[a.seq, true], [b.seq, undefined]])
  expect(state.evidence).toEqual([{ callId: 'call-0', rootCallSeq: b.seq, messageId: humans[1]!.id, operationId: 'op_b' }])
  expect(fold(session)).toEqual(state)
})

it.each(['deny', 'throw'] as const)('cleans execution capture after a pre-execute %s without skipping downstream policy', async (kind) => {
  const { ctx, session, agent } = await executionFixture()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一条视频' }] }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-0'), name: 'generate_video', arguments: '{}' })
  let execution: ToolExecution | undefined
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Must be denied before execution.', parameters: {},
    async execute() { throw new Error('denied tool must not execute') } }))
  ctx.on('tools/pre-execute', async (exec) => {
    execution = exec
    expect(videoGenerationIntentOf(exec)?.grant).toBeDefined()
    expect(videoGenerationIntentOf(exec)?.grant).not.toHaveProperty('maxWorks')
    if (kind === 'throw') throw new Error('expected fixture policy failure')
    return { kind: 'deny', reason: 'fixture denied' }
  })
  const result = await ctx.tools.execute({ signal: new AbortController().signal, agent, callId: ToolCallId('call-0'), name: 'generate_video', arguments: {} })
  expect(result.isError).toBe(true)
  expect(execution).toBeDefined()
  if (execution !== undefined) expect(videoGenerationIntentOf(execution)).toBeUndefined()
})

it('captures before an awaited policy and removes pending ownership when its feature unloads', async () => {
  const { ctx, session, agent, feature } = await executionFixture()
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一条视频' }] })
  const humanEvent = session.append('user/message', human, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-0'), name: 'generate_video', arguments: '{}' })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let execution: ToolExecution | undefined
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Inspect a captured invocation.', parameters: {},
    async execute(_args, exec) { expect(videoGenerationIntentOf(exec)).toBeUndefined(); return [] } }))
  ctx.on('tools/pre-execute', async (exec, next) => {
    execution = exec
    entered.resolve(undefined)
    await release.promise
    return next()
  })
  const pending = ctx.tools.execute({ signal: new AbortController().signal, agent, callId: ToolCallId('call-0'), name: 'generate_video', arguments: {} })
  try {
    await entered.promise
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '另外生成3条视频' }] }), { surfaceOp: 'append' })
    expect(execution).toBeDefined()
    if (execution !== undefined) {
      expect(videoGenerationIntentOf(execution)?.grant).toMatchObject({ messageId: human.id, rootCallSeq: call.seq })
      expect(videoGenerationIntentOf(execution)?.humanRevision).toEqual({ messageId: human.id, seq: humanEvent.seq })
      expect(videoModelChoiceCancelled(execution)).toBe(false)
      await feature?.dispose()
      expect(videoGenerationIntentOf(execution)).toBeUndefined()
      expect(videoModelChoiceCancelled(execution)).toBe(false)
    }
  } finally { release.resolve(undefined); await pending }
})

it('inherits the parent token for nested PTC dispatches even after another human arrives and across reused roots', async () => {
  const { ctx, session, agent } = await executionFixture()
  const observed: ReturnType<typeof videoGenerationIntentOf>[] = []
  const nestedExecutions: ToolExecution[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Capture nested ownership.', parameters: {},
    async execute(_args, exec) { nestedExecutions.push(exec); observed.push(videoGenerationIntentOf(exec)); return [] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'video-composite', description: 'Dispatch two native children with PTC identity.', parameters: {},
    async execute(_args, exec) {
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '查看视频状态' }] }), { surfaceOp: 'append' })
      for (const index of [1, 2]) {
        const subCallId = ToolCallId(`call-0:ptc:${index}`)
        const data = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId, name: 'generate_video', arguments: {} }
        session.append('tool/ptc-dispatch-start', data)
        const result = await ctx.tools.execute({ signal: exec.signal, agent, callId: subCallId,
          rootCallId: exec.rootCallId, parent: exec.token, name: 'generate_video', arguments: {} })
        session.append('tool/ptc-dispatch', { ...data, isError: result.isError,
          content: [{ type: 'text', text: JSON.stringify({ operation_id: `op_nested_${observed.length}` }) }] })
      }
      return []
    } }))
  const expected: { messageId: string; rootCallSeq: number }[] = []
  const revisions: { messageId: string; seq: number }[] = []
  for (const turn of [1, 2]) {
    session.append('turn/start', { turn })
    const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '另外生成两条视频' }] })
    const humanEvent = session.append('user/message', human, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn, step: 1, callId: ToolCallId('call-0'), name: 'video-composite', arguments: '{}' })
    const result = await ctx.tools.execute({ signal: new AbortController().signal, agent, callId: ToolCallId('call-0'), name: 'video-composite', arguments: {} })
    expect(result.isError).toBe(false)
    expected.push({ messageId: human.id, rootCallSeq: call.seq }, { messageId: human.id, rootCallSeq: call.seq })
    revisions.push({ messageId: human.id, seq: humanEvent.seq }, { messageId: human.id, seq: humanEvent.seq })
    session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: ToolCallId('call-0'), content: [], isError: false }) },
      { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  expect(observed.map(intent => ({ messageId: intent?.grant.messageId, rootCallSeq: intent?.grant.rootCallSeq }))).toEqual(expected)
  expect(observed.map(intent => intent?.humanRevision)).toEqual(revisions)
  expect(observed.map(intent => intent?.grant.callId)).toEqual(['call-0:ptc:1', 'call-0:ptc:2', 'call-0:ptc:1', 'call-0:ptc:2'])
  expect(fold(session).evidence.map(evidence => ({ messageId: evidence.messageId, rootCallSeq: evidence.rootCallSeq }))).toEqual(expected)
  for (const exec of nestedExecutions) expect(videoGenerationIntentOf(exec)).toBeUndefined()
})

it.each([false, true])('binds a late PTC result to its unique start and refuses ambiguous pending identities=%s', (ambiguous) => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const roots: number[] = []
  const owners: string[] = []
  const dispatch = { rootCallId: ToolCallId('call-0'), parentCallId: ToolCallId('call-0'), subCallId: ToolCallId('call-0:ptc:1'),
    name: 'generate_video', arguments: {} }
  for (const index of [0, 1]) {
    const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '另外生成一条视频' }] })
    session.append('user/message', human, { surfaceOp: 'append' })
    const root = session.append('tool/call', { turn: 1, step: index + 1, callId: ToolCallId('call-0'), name: 'run_code', arguments: '{}' })
    roots.push(root.seq)
    owners.push(human.id)
    if (index === 0 || ambiguous) session.append('tool/ptc-dispatch-start', dispatch)
  }
  session.append('tool/ptc-dispatch', { ...dispatch, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ operation_id: 'op_late_child' }) }] })
  const state = fold(session)
  expect(state.evidence).toEqual(ambiguous ? []
    : [{ callId: dispatch.subCallId, messageId: owners[0], rootCallSeq: roots[0], operationId: 'op_late_child' }])
  expect(fold(session)).toEqual(state)
})
