import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Tools, { defineContentToolFixture, type ToolExecution, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { explicitVideoWorkCount, humanVideoDurationSeconds, humanVideoModel, humanVideoResolution, parseVideoRequestGrant, registerVideoGenerationIntent, videoGenerationIntentOf, videoModelChoiceCancelled, videoGenerationIntentProjection, videoWorkAllowance } from '../src/video-generation-intent.ts'

describe('explicit video work quantities', () => {
  it.each([
    ['用H3生成一条15秒的视频。', 1], ['15s带货视频', 1],
    ['生成3条', 3], ['做三版', 3], ['三条15秒视频', 3], ['生成3条15秒视频', 3],
    ['在聊天里另外生成3条4秒的H3视频。', 3], ['生成3条4秒的MiniMax-H3视频。', 3],
    ['生成3条10秒视频，字幕写“你好”', 3], ['生成3条10秒视频，不要字幕', 3],
    ['做十二版', 12], ['生成120秒视频，分8个镜头', 1],
    ['使用H3生成15s视频', 1], ['生成3个视频，使用两个模型', 3],
    ['不要生成3条视频', 1], ['生成“3条视频”的例子', 1],
    ['生成3条视频或者2条视频', 1], ['生成3条视频，改成1条视频', 1],
    ['生成3条视频和2条视频', 1], ['3个模型生成15秒视频', 1],
    ['生成999999999999999999999条视频', 1],
  ] as const)('reads only explicit consistent works in %s', (text, count) => {
    expect(explicitVideoWorkCount(text)).toBe(count)
  })

  it.each([
    ['15s带货视频', 1], ['H3 15秒视频', 1], ['三条15秒视频', 3],
    ['来个10s视频', 1], ['来一个10秒视频', 1], ['帮我来个10s视频', 1],
    ['来3个10秒视频', 3], ['再来三条10秒视频', 3], ['来3个十秒视频', 3],
    ['来一个视频', 1], ['来条10秒视频', 1], ['请用H3来个１０ｓ视频', 1],
    ['来个10s视频，分成3段', 1],
    ['在聊天里另外生成一条4秒的H3视频。', 1], ['在聊天里另外生成3条4秒的H3视频。', 3],
    ['请在当前聊天中额外生成3条4秒的MiniMax-H3视频。', 3],
    ['另外生成一条4秒视频。', 1], ['额外生成一条4秒视频。', 1],
    ['生成3条', 3], ['做三版', 3], ['再生成一条15秒的视频。', 1], ['重新做', 1], ['重做这一条', 1],
    ['生成15秒视频，完成后停止', 1], ['不要字幕，生成15秒视频', 1],
    ['继续生成这个视频', 0], ['请继续生成15秒视频', 0], ['继续制作这个视频', 0],
    ['只生成一条视频，不用补拍', 1],
    ['补拍剩余的五段视频', 0], ['补拍剩余五段视频', 0],
    ['不要继续生成这个视频', 0], ['不用补拍视频', 0],
    ['继续', 0], ['继续生成3条', 0], ['补拍剩余五段', 0], ['查看剩余五段视频', 0],
    ['解释如何继续生成视频', 0], ['帮我翻译下面这句话：继续生成15秒视频', 0],
    ['“继续生成这个视频”', 0], ['请继续生成视频的代码', 0], ['补拍视频的脚本', 0],
    ['看看进度', 0], ['为什么这么慢', 0], ['展示已有成片', 0], ['分析这三条', 0],
    ['不要重做', 0], ['给我看看这3条15s视频', 0], ['三条15秒视频哪个好', 0],
    ['三条15秒视频挑最好的', 0], ['停止生成', 0], ['取消整个任务', 0], ['停止', 0],
    ['修改这个文件', 0], ['帮我写代码生成三张图片', 0],
    ['无需生成视频', 0], ['不要帮我重新生成视频', 0], ['告诉我如何生成视频', 0],
    ['帮我写一段如何生成3条视频的说明', 0], ['我没有让你生成视频', 0],
    ['再来一个代码示例', 0], ['重新做这个函数', 0],
    ['别来个10s视频', 0], ['不要再来一个10秒视频', 0], ['来个10秒视频吗？', 0],
    ['查看来个10秒视频的任务', 0], ['查询这个视频状态', 0], ['继续观察10秒视频', 0],
    ['来个10秒视频的提示词', 0], ['来一个生成10s视频的代码', 0], ['来个视频的脚本', 0],
    ['来个视频教程', 0], ['来个10秒视频的提示词给我', 0], ['来个10秒视频的代码怎么写', 0],
    ['生成展示代码的视频', 1], ['解释“来个10s视频”', 0], ['翻译：来个10s视频', 0],
    ['“来个10s视频”', 0], ['来个图片', 0], ['来看看视频', 0],
    ['不要在聊天里另外生成一条4秒的H3视频。', 0], ['别额外生成一条4秒视频。', 0],
    ['在聊天里另外不要生成一条4秒视频。', 0], ['在聊天里查询另外生成的视频。', 0],
    ['在聊天里另外查看已有视频的状态。', 0], ['在聊天里另外生成一条4秒视频的提示词。', 0],
    ['在聊天里，另外生成一条4秒视频的代码。', 0], ['在聊天里如果可以，另外生成一条4秒视频。', 0],
    ['在聊天里假如需要，额外生成3条4秒视频。', 0], ['“在聊天里另外生成一条4秒视频”', 0],
    ['请翻译：在聊天里另外生成一条4秒视频。', 0], ['在聊天里引用“另外生成3条4秒视频”', 0],
    ['在聊天里另外生成一条4秒视频吗？', 0], ['4秒，H3，三条', 0], ['另外三条', 0],
    ['帮我翻译下面这句话：\n生成3条视频', 0], ['给我生成视频的代码', 0],
    ['按此提示词生成15s视频', 1],
    ['使用grok-imagine-video生成一条15秒视频', 1], ['用bt-seedance-2.0制作一条视频', 1],
    ['使用grok-imagine-video生成视频的代码', 0], ['用bt-seedance-2.0生成3条视频的脚本', 0],
    ['Start one MiniMax-H3 project with three four-second clips and two concurrent observations. Reply PROJECT_STARTED and stop; do not read or cancel it yet.', 1],
    ['Create a complete one-shot video plan, correct any specific planning argument diagnosis, then make exactly one explicit synthetic four-second MiniMax-H3 attempt. Report its result and stop.', 1],
    ['I explicitly request a second synthetic MiniMax-H3 attempt for that saved shot. Generate exactly once.', 1],
    ['Show the three existing videos', 0], ['Please check video progress', 0], ['Do not generate another video', 0],
    ['Create three images', 0], ['Make a code example', 0],
  ] as const)('distinguishes a human creation request from observation in %s', (text, count) => {
    expect(videoWorkAllowance(text)).toBe(count)
  })

  it('does not keep regex cursor state between requests', () => {
    expect(Array.from({ length: 4 }, () => videoWorkAllowance('做三版'))).toEqual([3, 3, 3, 3])
  })
})

it.each([
  ['来个10s视频', 10], ['来一个10秒视频', 10], ['生成10秒视频', 10],
  ['在聊天里另外生成一条4秒的H3视频。', 4], ['在聊天里另外生成3条4秒的H3视频。', 4],
  ['请在当前聊天中额外生成3条4秒的MiniMax-H3视频。', 4],
  ['生成3个10秒视频', 10], ['来3个10秒视频', 10], ['来个１０ｓ视频', 10],
  ['生成十秒视频', 10], ['生成两分钟视频', 120], ['生成2min视频', 120],
  ['用sd2.5-720p生成10秒视频', 10], ['使用k2-sd2.5-720p生成10秒视频', 10],
  ['生成0.5分钟视频', 30], ['生成2.5秒视频', 2.5], ['生成1秒钟视频', 1],
  ['生成视频，总时长10秒', 10], ['生成3个视频，每个10秒', 10],
  ['生成3条视频，每条视频10秒', 10], ['来个视频，视频的时长是10秒', 10],
  ['生成120秒视频，分8个镜头，每段15秒', 120],
  ['生成3个10秒视频，每个10秒', 10], ['生成10秒视频，不要15秒', 10],
  ['不要10秒，生成15秒视频', 15], ['生成视频，分3段，每段10秒', undefined],
  ['生成10秒视频和15秒视频', undefined], ['生成视频', undefined],
  ['生成10秒或15秒视频', undefined], ['来个10或15秒视频', undefined],
  ['生成10到15秒视频', undefined], ['生成10-15秒视频', undefined],
  ['生成10秒至15秒视频', undefined], ['生成最多15秒视频', undefined],
  ['来个视频', undefined], ['生成0秒视频', undefined], ['生成-10秒视频', undefined],
  ['生成0秒视频和10秒视频', undefined], ['生成一百二十秒视频', undefined],
  ['生成“10秒视频”', undefined], ['生成视频，字幕写“10秒视频”', undefined],
  ['不要生成10秒视频', undefined], ['来个10秒视频的代码', undefined],
  ['查看10秒视频进度', undefined], ['继续观察10秒视频', undefined],
] as const)('reads only an explicit duration per finished video: %s', (text, duration) => {
  expect(humanVideoDurationSeconds(text)).toBe(duration)
})

const conditionalChatRequests = [
  '在聊天里，如果我确认，另外生成3条4秒的H3视频。',
  '在聊天里，假如我确认，额外生成3条4秒的H3视频。',
  '在聊天里，等我确认，另外生成3条4秒的H3视频。',
  '请在当前聊天中，如果我确认，再生成一条4秒的MiniMax-H3视频。',
  '在聊天里，等我确认后，再生成一条4秒视频。',
  '在聊天里另外生成3条4秒的H3视频，等我确认后再开始生成。',
  '在聊天里另外生成3条4秒的H3视频。等我同意后再生成。',
  '在聊天里另外生成3条4秒的H3视频，等我批准之后再制作。',
  '在聊天里另外生成3条4秒的H3视频。等待我确认以后再开始创作。',
  '在聊天里另外生成3条4秒的H3视频，等我同意后，再继续生成。',
  '在聊天里另外生成3条4秒的H3视频，等我批准后。再开始制作。',
  '在聊天里另外生成3条4秒的H3视频，等我确认再创作。',
  '在聊天里另外生成3条4秒的H3视频，等我确认后才开始生成。',
  '在聊天里，等我同意后，另外生成3条4秒的H3视频。',
  '在聊天里，等待我批准后，再开始制作3条4秒的H3视频。',
] as const

it.each(conditionalChatRequests)('does not authorize a later creation clause behind a human condition: %s', (text) => {
  expect(videoWorkAllowance(text)).toBe(0)
  expect(humanVideoDurationSeconds(text)).toBeUndefined()
  expect(humanVideoModel(text)).toBeUndefined()
})

it.each([
  ['在聊天里，另外生成3条4秒的H3视频。', 3],
  ['在聊天里，我已确认，额外生成3条4秒的H3视频。', 3],
  ['在聊天里，另外生成3条4秒的H3视频，等我确认后再发布。', 3],
  ['在聊天里另外生成3条4秒的H3视频。等我同意后再下载。', 3],
  ['在聊天里另外生成3条4秒的H3视频，等我批准后再展示。', 3],
  ['在聊天里另外生成一条4秒的H3视频，字幕写“等我确认后再开始生成”。', 1],
] as const)('retains an unconditional creation request across clauses: %s', (text, count) => {
  expect(videoWorkAllowance(text)).toBe(count)
  expect(humanVideoDurationSeconds(text)).toBe(4)
})

it.each([
  ['生成768k视频', '768P'], ['用H3生成一条768P视频', '768P'], ['生成2K视频', '2K'],
  ['生成1280×720视频', '1280x720'], ['生成15秒视频', undefined],
  ['生成20K视频', '20K'], ['生成9999P视频', '9999P'],
  ['生成2K视频，不要字幕', '2K'], ['生成2K视频，字幕写“你好”', '2K'], ['不要2K，生成768P视频', '768P'],
  ['生成一条15秒的视频，使用 video-sd25-480p。', undefined], ['使用 k2-sd2.5-720p 生成15秒视频', undefined],
  ['不要2K，生成15秒视频', undefined], ['生成768P或者2K视频', undefined], ['生成“2K”视频', undefined],
  ['看看2K视频进度', undefined],
] as const)('retains only an unambiguous human output tier: %s', (text, resolution) => {
  expect(humanVideoResolution(text)).toBe(resolution)
})

it.each([
  ['生成一条15秒的视频，使用 video-sd25-480p。', 'video-sd25-480p'],
  ['用H3生成15秒视频', 'MiniMax-H3'], ['H3 15秒视频', 'MiniMax-H3'],
  ['Generate a video using video-sd25-480p.', 'video-sd25-480p'],
  ['在聊天里另外生成一条4秒的H3视频。', 'MiniMax-H3'],
  ['请在当前聊天中额外生成3条4秒的MiniMax-H3视频。', 'MiniMax-H3'],
  ['生成15秒视频，不用 video-sd25-480p', undefined], ['生成15秒视频，使用两个模型', undefined],
] as const)('retains only an explicit human model id: %s', (text, model) => {
  expect(humanVideoModel(text)).toBe(model)
})

function sessionFixture() {
  const id = SessionId('intent-chat')
  return Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd: '/workspace' })
}

function fold(session: Session) {
  let state: Parameters<typeof videoGenerationIntentProjection.apply>[0]
    = videoGenerationIntentProjection.init(session.header, SessionLogOffset(0))
  for (const event of session.snapshotEvents()) state = videoGenerationIntentProjection.apply(state, event)
  return state
}

it('records the actual native execution turn and gives PTC children only the original root turn', () => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成三条视频' }] })
  session.append('user/message', human, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const root = session.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('root-0'), name: 'run_ptc', arguments: '{}' })
  session.append('tool/ptc-dispatch-start', { rootCallId: ToolCallId('root-0'), parentCallId: ToolCallId('root-0'),
    subCallId: ToolCallId('child-0'), name: 'generate_video', arguments: {} })
  const state = fold(session)
  expect(state.requests[0]).toMatchObject({ messageId: human.id, turn: 1 })
  expect(state.calls).toEqual([
    { callId: 'root-0', messageId: human.id, name: 'run_ptc', rootCallSeq: root.seq, turn: 2, native: true },
    { callId: 'child-0', messageId: human.id, name: 'generate_video', rootCallSeq: root.seq, turn: 2, pending: true },
  ])
  expect(fold(session)).toEqual(state)
})

it('keeps one human allowance through tools and attributes a later real human in the same turn', () => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const first = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '15s带货视频' }] })
  session.append('user/message', first, { surfaceOp: 'append' })
  const callId = ToolCallId('video-first')
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'generate_video', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: JSON.stringify({ status: 'succeeded', operation_id: 'op_original' }) }], isError: false }) },
  { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('user/message', createUserMessage({ source: { kind: 'system-prompt', form: 'instructions' },
    content: [{ type: 'text', text: '生成3条视频' }] }), { surfaceOp: 'append' })
  const read = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '给我看看这3条15s视频' }] })
  session.append('user/message', read, { surfaceOp: 'append' })
  const state = fold(session)
  expect(state.requests.map(request => [request.messageId, request.maxWorks])).toEqual([[first.id, 1], [read.id, 0]])
  expect(state.evidence).toEqual([{ callId, messageId: first.id, operationId: 'op_original', rootCallSeq: call.seq }])
  expect(fold(session)).toEqual(state)
})

it('validates optional private grants without accepting malformed or unknown fields', () => {
  expect(parseVideoRequestGrant(undefined)).toBeUndefined()
  const grant = { schema: 1, messageId: 'human-1', sourceSeq: 1, maxWorks: 3, turn: 1, callId: 'call-1', rootCallId: 'call-1' }
  expect(parseVideoRequestGrant(grant)).toEqual(grant)
  expect(parseVideoRequestGrant({ ...grant, rootCallSeq: 0 })).toEqual({ ...grant, rootCallSeq: 0 })
  expect(parseVideoRequestGrant({ ...grant, rootCallSeq: undefined })).toEqual(grant)
  for (const value of [{ ...grant, maxWorks: 0 }, { ...grant, sourceSeq: -1 }, { ...grant, maxWorks: 1.5 },
    { ...grant, model_count: 3 }, { ...grant, requestedResolution: '2K' }, { ...grant, requestedModel: 'model-1' },
    { ...grant, cancelled: true }, { ...grant, requestedDurationSeconds: 10 },
    { ...grant, rootCallSeq: -1 }, { ...grant, rootCallSeq: 1.5 }]) {
    expect(parseVideoRequestGrant(value)).toBeNull()
  }
})

it('revokes a cancelled model choice for both video tools until a new real human generation request', () => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一条768k视频' }] })
  const originalEvent = session.append('user/message', original, { surfaceOp: 'append' })
  const callId = ToolCallId('cancelled-model-choice')
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'generate_video_project', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: JSON.stringify({ status: 'failed', code: 'USER_CANCELLED' }) }], isError: false }) },
  { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const nextCall = session.append('tool/call', { turn: 1, step: 2,
    callId: ToolCallId('model-attempted-h3-fallback'), name: 'generate_video', arguments: '{}' })
  const cancelled = fold(session)
  expect(cancelled.requests).toEqual([{ messageId: original.id, sourceSeq: originalEvent.seq,
    maxWorks: 0, turn: 1, requestedResolution: '768P', cancelled: true }])
  expect(cancelled.calls.find(value => value.callId === nextCall.data.callId)?.messageId).toBe(original.id)
  expect(fold(session)).toEqual(cancelled)
  const followup = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '再生成一条视频' }] })
  session.append('user/message', followup, { surfaceOp: 'append' })
  expect(fold(session).requests.at(-1)).toMatchObject({ messageId: followup.id, maxWorks: 1 })
  expect(fold(session).requests.at(-1)).not.toHaveProperty('cancelled')
})

it.each([
  ['来个10s视频', 1, 10], ['来一个10秒视频', 1, 10], ['生成3个10秒视频', 3, 10],
  ['生成120秒视频，分8个镜头，每段15秒', 1, 120],
  ['在聊天里另外生成一条4秒的H3视频。', 1, 4], ['在聊天里另外生成3条4秒的H3视频。', 3, 4],
] as const)('folds real human quantity and duration independently: %s', (text, count, duration) => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  session.append('user/message', human, { surfaceOp: 'append' })
  const modelCall = session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('duration-call'),
    name: 'generate_video_project', arguments: JSON.stringify({ total_duration_seconds: 30, shot_count: 3 }) })
  session.append('user/message', createUserMessage({ source: { kind: 'system-prompt', form: 'instructions' },
    content: [{ type: 'text', text: '生成9个60秒视频' }] }), { surfaceOp: 'append' })
  const first = fold(session)
  expect(first.requests).toHaveLength(1)
  expect(first.requests[0]).toMatchObject({ messageId: human.id, maxWorks: count, requestedDurationSeconds: duration })
  expect(first.calls).toEqual([{ callId: modelCall.data.callId, messageId: human.id, name: 'generate_video_project',
    rootCallSeq: modelCall.seq, turn: 1, native: true }])
  expect(fold(session)).toEqual(first)
  const observation = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续观察进度' }] })
  session.append('user/message', observation, { surfaceOp: 'append' })
  expect(fold(session).requests.at(-1)).toMatchObject({ messageId: observation.id, maxWorks: 0 })
  expect(fold(session).requests.at(-1)).not.toHaveProperty('requestedDurationSeconds')
})

it.each(conditionalChatRequests)('keeps a real conditional human message at zero grant through a model generation call: %s', (text) => {
  const session = sessionFixture()
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  session.append('user/message', human, { surfaceOp: 'append' })
  const conditionalCall = session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('conditional-video-attempt'),
    name: 'generate_video_project', arguments: JSON.stringify({ total_duration_seconds: 4, works_count: 3, model: 'MiniMax-H3' }) })
  const state = fold(session)
  expect(state.requests).toHaveLength(1)
  expect(state.requests[0]).toMatchObject({ messageId: human.id, maxWorks: 0 })
  expect(state.requests[0]).not.toHaveProperty('requestedDurationSeconds')
  expect(state.requests[0]).not.toHaveProperty('requestedModel')
  expect(state.calls).toEqual([{ callId: 'conditional-video-attempt', messageId: human.id, name: 'generate_video_project',
    rootCallSeq: conditionalCall.seq, turn: 1, native: true }])
  expect(fold(session)).toEqual(state)
})

const recoveryRequests = [
  '继续生成这个视频', '请继续制作这个视频', '在聊天里继续生成4秒的H3视频。',
  '恢复这个视频的生成任务', '接着生成上一个视频', '补拍剩余的五段视频',
  '生成剩余的五段视频', '制作剩下的三段视频', '创作未完成的两段视频',
  '生成这个视频剩余的分镜', '在聊天里生成上一个视频剩下的片段',
  '继续生成这个视频，生成剩余片段', '查看上一个视频任务的状态',
  '恢复原任务，继续制作剩余的视频', '4秒，H3，768P', '就用H3，四秒', '是的，继续',
] as const

it.each(recoveryRequests)('does not grant a new submission for recovery or clarification: %s', (text) => {
  expect(videoWorkAllowance(text)).toBe(0)
  expect(humanVideoDurationSeconds(text)).toBeUndefined()
  expect(humanVideoModel(text)).toBeUndefined()
  expect(humanVideoResolution(text)).toBeUndefined()
})

it.each([
  ['另外生成一个4秒的H3视频', 1, 4], ['再生成3条4秒的H3视频', 3, 4],
  ['重新生成3条4秒的H3视频', 3, 4], ['新做一条4秒的H3视频', 1, 4],
  ['请新做3条4秒的H3视频', 3, 4], ['再来一条', 1, undefined],
  ['重新生成这个视频剩余的分镜', 1, undefined], ['另外生成剩余的3条视频', 3, undefined],
  ['再生成这个视频剩下的片段', 1, undefined],
  ['另外生成', 1, undefined], ['再生成', 1, undefined], ['重新生成', 1, undefined], ['新做', 1, undefined],
  ['生成一个人物继续奔跑的视频', 1, undefined], ['生成一个人物恢复色彩的视频', 1, undefined],
  ['生成4秒的视频，人物继续奔跑', 1, 4],
] as const)('keeps explicit new submissions separate from video content descriptions: %s', (text, count, duration) => {
  expect(videoWorkAllowance(text)).toBe(count)
  expect(humanVideoDurationSeconds(text)).toBe(duration)
})

it.each([1, 2] as const)('retains message ownership while independent requests overlap in turn %s', (secondTurn) => {
  for (const nextRequest of ['另外生成一条10秒的H3视频', '另外生成3条10秒的H3视频'] as const) {
    for (const followup of ['查看视频状态', '继续生成这个视频', '生成剩余的五段视频', '10秒，H3，768P'] as const) {
      const session = sessionFixture()
      session.append('turn/start', { turn: 1 })
      const a = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一条4秒的H3视频' }] })
      const aEvent = session.append('user/message', a, { surfaceOp: 'append' })
      const aCallId = ToolCallId('independent-a')
      const aCall = session.append('tool/call', { turn: 1, step: 1, callId: aCallId,
        name: 'generate_video_project', arguments: '{}' })
      if (secondTurn === 2) {
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        session.append('turn/start', { turn: 2 })
      }
      const b = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: nextRequest }] })
      const bEvent = session.append('user/message', b, { surfaceOp: 'append' })
      const bCallId = ToolCallId('independent-b')
      const bCall = session.append('tool/call', { turn: secondTurn, step: 2, callId: bCallId,
        name: 'generate_video', arguments: JSON.stringify({ works_count: 99, total_duration_seconds: 30 }) })
      session.append('tool/result', { turn: secondTurn, step: 2, message: createToolResultMessage({ callId: bCallId,
        content: [{ type: 'text', text: JSON.stringify({ status: 'background', operation_id: 'op_independent_b' }) }], isError: false }) },
      { surfaceOp: 'append', sourceEventSeqs: [bCall.seq] })
      const c = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: followup }] })
      session.append('user/message', c, { surfaceOp: 'append' })
      const cCall = session.append('tool/call', { turn: secondTurn, step: 3, callId: ToolCallId('followup-no-new-work'),
        name: 'generate_video_project', arguments: JSON.stringify({ works_count: 99, total_duration_seconds: 30 }) })
      session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: aCallId,
        content: [{ type: 'text', text: JSON.stringify({ status: 'background', operation_id: 'op_independent_a' }) }], isError: false }) },
      { surfaceOp: 'append', sourceEventSeqs: [aCall.seq] })
      const state = fold(session)
      expect(state.requests).toMatchObject([
        { messageId: a.id, sourceSeq: aEvent.seq, turn: 1, maxWorks: 1, requestedDurationSeconds: 4, requestedModel: 'MiniMax-H3' },
        { messageId: b.id, sourceSeq: bEvent.seq, turn: secondTurn, maxWorks: nextRequest.includes('3条') ? 3 : 1,
          requestedDurationSeconds: 10, requestedModel: 'MiniMax-H3' },
        { messageId: c.id, turn: secondTurn, maxWorks: 0 },
      ])
      expect(state.requests[2]).not.toHaveProperty('requestedDurationSeconds')
      expect(state.requests[2]).not.toHaveProperty('requestedModel')
      expect(state.calls).toEqual([
        { callId: aCallId, messageId: a.id, name: 'generate_video_project', rootCallSeq: aCall.seq, turn: 1, native: true },
        { callId: bCallId, messageId: b.id, name: 'generate_video', rootCallSeq: bCall.seq, turn: secondTurn, native: true },
        { callId: 'followup-no-new-work', messageId: c.id, name: 'generate_video_project',
          rootCallSeq: cCall.seq, turn: secondTurn, native: true },
      ])
      expect(state.evidence).toEqual([
        { callId: bCallId, messageId: b.id, operationId: 'op_independent_b', rootCallSeq: bCall.seq },
        { callId: aCallId, messageId: a.id, operationId: 'op_independent_a', rootCallSeq: aCall.seq },
      ])
      expect(fold(session)).toEqual(state)
    }
  }
})

it.each([
  ['生成3条10秒视频，字幕写“你好”', 3], ['生成3条10秒视频，不要字幕', 3],
  ['不要生成3条10秒视频', 0], ['生成3条还是2条10秒视频', 1],
] as const)('preserves completed-video counts around unrelated output parameters through native grants: %s', async (text, count) => {
  const { ctx, session, agent } = await executionFixture()
  session.append('turn/start', { turn: 1 })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  session.append('user/message', human, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('parameter-count'), name: 'generate_video', arguments: '{}' })
  let observed: ReturnType<typeof videoGenerationIntentOf>
  ctx.tools.register(defineContentToolFixture({ name: 'generate_video', description: 'Capture human count.', parameters: {},
    async execute(_args, exec) { observed = videoGenerationIntentOf(exec); return [] } }))
  await ctx.tools.execute({ signal: new AbortController().signal, agent, callId: ToolCallId('parameter-count'), name: 'generate_video', arguments: {} })
  if (count === 0) expect(observed).toBeUndefined()
  else expect(observed?.grant).toMatchObject({ messageId: human.id, maxWorks: count })
  if (count === 3) expect(observed?.requestedDurationSeconds).toBe(10)
})

const executionContexts = new Set<Context>()
afterEach(async () => {
  await Promise.all([...executionContexts].map(ctx => ctx.fiber.dispose()))
  executionContexts.clear()
})

async function executionFixture(register = true) {
  const ctx = new Context()
  executionContexts.add(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(SessionProjections)
  const feature = register ? await ctx.plugin((owner: Context) => { registerVideoGenerationIntent(owner) }) : undefined
  const session = sessionFixture()
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

it('pairs late reused-id results by exact source event and cancels only the owning request', () => {
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
  expect(state.requests.map(request => [request.messageId, request.maxWorks])).toEqual([[humans[0]!.id, 0], [humans[1]!.id, 1]])
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
    expect(videoGenerationIntentOf(exec)?.grant.maxWorks).toBe(1)
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
  session.append('user/message', human, { surfaceOp: 'append' })
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
      expect(videoGenerationIntentOf(execution)?.grant).toMatchObject({ messageId: human.id, rootCallSeq: call.seq, maxWorks: 1 })
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
  for (const turn of [1, 2]) {
    session.append('turn/start', { turn })
    const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '另外生成两条视频' }] })
    session.append('user/message', human, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn, step: 1, callId: ToolCallId('call-0'), name: 'video-composite', arguments: '{}' })
    const result = await ctx.tools.execute({ signal: new AbortController().signal, agent, callId: ToolCallId('call-0'), name: 'video-composite', arguments: {} })
    expect(result.isError).toBe(false)
    expected.push({ messageId: human.id, rootCallSeq: call.seq }, { messageId: human.id, rootCallSeq: call.seq })
    session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: ToolCallId('call-0'), content: [], isError: false }) },
      { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  expect(observed.map(intent => ({ messageId: intent?.grant.messageId, rootCallSeq: intent?.grant.rootCallSeq }))).toEqual(expected)
  expect(observed.map(intent => intent?.grant.callId)).toEqual(['call-0:ptc:1', 'call-0:ptc:2', 'call-0:ptc:1', 'call-0:ptc:2'])
  expect(fold(session).evidence.map(evidence => ({ messageId: evidence.messageId, rootCallSeq: evidence.rootCallSeq }))).toEqual(expected)
  for (const exec of nestedExecutions) expect(videoGenerationIntentOf(exec)).toBeUndefined()
})

it.each([
  ['生成两个海边视频', 2, 2, undefined],
  ['生成3条不同风格的10秒视频', 3, 3, 10],
  ['分别生成海边、森林两个视频', 2, 2, undefined],
  ['分别生成海边、森林两个10秒视频', 2, 2, 10],
  ['生成一个有两个人物的视频', 1, 1, undefined],
  ['生成两个人物的视频', 1, 1, undefined],
  ['生成3个商品展示的视频', 1, 1, undefined],
  ['生成3个模型演示的视频', 1, 1, undefined],
  ['生成3个镜头的视频', 1, 1, undefined],
  ['生成3条分镜视频', 1, 1, undefined],
  ['生成3个片段的视频', 1, 1, undefined],
  ['生成视频，分3段，每段10秒', 1, 1, undefined],
  ['生成视频，分3镜头', 1, 1, undefined],
  ['三个模型生成15s视频', 1, 0, undefined],
  ['分别生成海边、森林的视频', 1, 1, undefined],
  ['不要分别生成两个海边视频', 1, 0, undefined],
  ['分别生成两个海边视频的代码', 2, 0, undefined],
] as const)('counts bounded completed-video modifiers without counting subjects or clips: %s', (text, count, allowance, duration) => {
  expect(explicitVideoWorkCount(text)).toBe(count)
  expect(videoWorkAllowance(text)).toBe(allowance)
  expect(humanVideoDurationSeconds(text)).toBe(duration)
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
