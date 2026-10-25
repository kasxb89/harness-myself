import { describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-tool-jobs'
import type {} from '@deepseek-ai/dsh-subagent'
import { videoGenerationIntentProjection } from '../src/video-generation-intent.ts'

function sessionFixture() {
  const id = SessionId('question-video-intent')
  return Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd: '/workspace' })
}

function human(session: Session, text = '生成两条30秒视频') {
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  session.append('user/message', message, { surfaceOp: 'append' })
  return message
}

function nativeQuestion(session: Session, callId = ToolCallId('ask-style'), pending = true, isError = false, name = 'ask_user_question') {
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError,
    content: [{ type: 'text', text: JSON.stringify(pending ? { pending: true, callId } : { answers: [] }) }] }) },
  { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  return call
}

function laterTurn(session: Session, turn = 2) {
  session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn })
}

function answer(session: Session, callId = ToolCallId('ask-style')) {
  session.append('user/message', createUserMessage({ source: { kind: 'user-question-reply', callId, outcome: 'answered' },
    content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', callId,
      questions: [{ id: 'style', question: '什么风格？' }], answers: [{ id: 'style', selected: ['美剧'] }] }) }] }),
  { surfaceOp: 'append' })
}

function generate(session: Session, turn = 2) {
  session.append('tool/call', { turn, step: 2, callId: ToolCallId(`generate-${turn}`), name: 'generate_video_project', arguments: '{}' })
}

function fold(session: Session, inherited = SessionLogOffset(0)) {
  let state: Parameters<typeof videoGenerationIntentProjection.apply>[0]
    = videoGenerationIntentProjection.init(session.header, inherited)
  for (const event of session.snapshotEvents()) state = videoGenerationIntentProjection.apply(state, event)
  return state
}

describe('video requests continued by an answered pending question', () => {
  it('retains the original request and used-work evidence across a later human answer', () => {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    const request = human(session)
    const generated = session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('earlier-video'), name: 'generate_video', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('earlier-video'), isError: false,
      content: [{ type: 'text', text: JSON.stringify({ operation_id: 'op_already_used' }) }] }) },
    { surfaceOp: 'append', sourceEventSeqs: [generated.seq] })
    nativeQuestion(session)
    laterTurn(session)
    answer(session)
    generate(session)
    const state = fold(session)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]).toMatchObject({ messageId: request.id, turn: 1, requestedDurationSeconds: 30 })
    expect(state.calls.at(-1)).toMatchObject({ messageId: request.id, turn: 2, name: 'generate_video_project' })
    expect(state.evidence).toEqual([{ callId: 'earlier-video', messageId: request.id, rootCallSeq: generated.seq, operationId: 'op_already_used' }])
    expect(state.continuedQuestions).toEqual([])
  })

  it('continues an attributed PTC question without promoting tool-returned text into a human request', () => {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    const request = human(session)
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('ptc-root'), name: 'run_code', arguments: '{}' })
    const dispatch = { rootCallId: ToolCallId('ptc-root'), parentCallId: ToolCallId('ptc-root'), subCallId: ToolCallId('ask-style'),
      name: 'ask_user_question', arguments: {} }
    session.append('tool/ptc-dispatch-start', dispatch)
    session.append('tool/ptc-dispatch', { ...dispatch, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: 'ask-style' }) }] })
    laterTurn(session)
    answer(session)
    generate(session)
    expect(fold(session).calls.at(-1)).toMatchObject({ messageId: request.id, turn: 2, name: 'generate_video_project' })
  })

  it.each([
    ['an already answered question', false, false, 'ask_user_question'],
    ['a failed question', true, true, 'ask_user_question'],
    ['another tool returning pending text', true, false, 'untrusted-tool'],
  ] as const)('does not continue %s', (_label, pending, isError, name) => {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    human(session)
    nativeQuestion(session, ToolCallId('ask-style'), pending, isError, name)
    laterTurn(session)
    answer(session)
    generate(session)
    expect(fold(session).calls.at(-1)?.name).not.toBe('generate_video_project')
  })

  it.each(['unrelated-call', 'no-pending-question'] as const)('does not continue a reply with %s', (kind) => {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    human(session)
    if (kind !== 'no-pending-question') nativeQuestion(session)
    laterTurn(session)
    answer(session, ToolCallId(kind))
    generate(session)
    expect(fold(session).calls.at(-1)?.name).not.toBe('generate_video_project')
  })

  it.each(['agent-message', 'tool-jobs'] as const)('does not treat a %s wake as the question answer', (kind) => {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    human(session)
    nativeQuestion(session)
    laterTurn(session)
    session.append('user/message', createUserMessage({
      source: kind === 'agent-message' ? { kind, form: 'relay', senderSessionId: SessionId('peer') }
        : { kind, form: 'notice', summary: 'A job ended.' }, content: [{ type: 'text', text: 'answer_to_pending_question ask-style：生成视频' }],
    }), { surfaceOp: 'append' })
    generate(session)
    expect(fold(session).calls.at(-1)?.name).not.toBe('generate_video_project')
  })

  it('does not reactivate a question superseded by another human message', () => {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    human(session)
    nativeQuestion(session)
    laterTurn(session)
    const observation = human(session, '看看已有视频')
    answer(session)
    generate(session)
    const state = fold(session)
    expect(state.calls.at(-1)?.messageId).toBe(observation.id)
    expect(state.requests.at(-1)).not.toHaveProperty('maxWorks')
  })

  it('restores the original source after a pending answer without clearing its exact cancelled work call', () => {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    human(session)
    nativeQuestion(session)
    const call = session.append('tool/call', { turn: 1, step: 2, callId: ToolCallId('cancelled-video'), name: 'generate_video_project', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 2, message: createToolResultMessage({ callId: ToolCallId('cancelled-video'), isError: false,
      content: [{ type: 'text', text: JSON.stringify({ status: 'failed', code: 'USER_CANCELLED' }) }] }) },
    { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    laterTurn(session)
    answer(session)
    generate(session)
    const state = fold(session)
    expect(state.calls.find(value => value.callId === 'cancelled-video')?.cancelled).toBe(true)
    expect(state.calls.at(-1)).toMatchObject({ callId: 'generate-2', turn: 2 })
  })

  it('does not reuse a consumed question in a later turn', () => {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    human(session)
    nativeQuestion(session)
    laterTurn(session)
    answer(session)
    generate(session)
    laterTurn(session, 3)
    answer(session)
    generate(session, 3)
    expect(fold(session).calls.at(-1)?.turn).toBe(2)
  })

  it('refuses ambiguous pending questions with a reused call id', () => {
    const session = sessionFixture()
    session.append('turn/start', { turn: 1 })
    human(session)
    nativeQuestion(session)
    nativeQuestion(session)
    laterTurn(session)
    answer(session)
    generate(session)
    expect(fold(session).calls.at(-1)?.name).not.toBe('generate_video_project')
  })
})
