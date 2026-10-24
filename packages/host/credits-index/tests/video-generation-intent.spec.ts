import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { explicitVideoWorkCount, humanVideoDurationSeconds, humanVideoModel, humanVideoResolution, parseVideoRequestGrant, videoGenerationIntentProjection, videoWorkAllowance } from '../src/video-generation-intent.ts'

describe('explicit video work quantities', () => {
  it.each([
    ['用H3生成一条15秒的视频。', 1], ['15s带货视频', 1],
    ['生成3条', 3], ['做三版', 3], ['三条15秒视频', 3], ['生成3条15秒视频', 3],
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
    ['生成3条', 3], ['做三版', 3], ['再生成一条15秒的视频。', 1], ['重新做', 1], ['重做这一条', 1],
    ['生成15秒视频，完成后停止', 1], ['不要字幕，生成15秒视频', 1],
    ['继续生成这个视频', 1], ['请继续生成15秒视频', 1], ['继续制作这个视频', 1],
    ['只生成一条视频，不用补拍', 1],
    ['补拍剩余的五段视频', 1], ['补拍剩余五段视频', 1],
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
  expect(state.evidence).toEqual([{ callId, messageId: first.id, operationId: 'op_original' }])
  expect(fold(session)).toEqual(state)
})

it('validates optional private grants without accepting malformed or unknown fields', () => {
  expect(parseVideoRequestGrant(undefined)).toBeUndefined()
  const grant = { schema: 1, messageId: 'human-1', sourceSeq: 1, maxWorks: 3, turn: 1, callId: 'call-1', rootCallId: 'call-1' }
  expect(parseVideoRequestGrant(grant)).toEqual(grant)
  for (const value of [{ ...grant, maxWorks: 0 }, { ...grant, sourceSeq: -1 }, { ...grant, maxWorks: 1.5 },
    { ...grant, model_count: 3 }, { ...grant, requestedResolution: '2K' }, { ...grant, requestedModel: 'model-1' },
    { ...grant, cancelled: true }, { ...grant, requestedDurationSeconds: 10 }]) {
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
  expect(first.calls).toEqual([{ callId: modelCall.data.callId, messageId: human.id, name: 'generate_video_project' }])
  expect(fold(session)).toEqual(first)
  const observation = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续观察进度' }] })
  session.append('user/message', observation, { surfaceOp: 'append' })
  expect(fold(session).requests.at(-1)).toMatchObject({ messageId: observation.id, maxWorks: 0 })
  expect(fold(session).requests.at(-1)).not.toHaveProperty('requestedDurationSeconds')
})
