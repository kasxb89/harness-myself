/** Ordinary peer delivery uses real Sessions and durable production Inboxes. */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerSessions, PeerSessionError } from '../src/peer-sessions.ts'
import { ApiSessionAgentController } from '../src/agent.ts'
import { createSessionTestController } from './test-remote.ts'

const signal = new AbortController().signal
const contexts = new Set<Context>()
afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
})

async function bench() {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const archived: SessionId[] = []
  ctx.provide('workspaceRegistry', { archivedSessionIds: archived } as never)
  const controller = createSessionTestController(ctx, { cwd: '/workspace', defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }) })
  const caller = await loop.create(SessionId('sender'), {}, { cwd: '/workspace' })
  const recipient = await loop.create(SessionId('recipient'), {}, { cwd: '/workspace' })
  const send = vi.spyOn(recipient, 'send').mockImplementation((message, target) => { recipient.inbox.append(target, message) })
  const flush = vi.fn()
  ctx.on('session/flush', flush)
  return { ctx, loop, controller, caller, recipient, send, flush, archived }
}

function request(caller: Agent, text = 'Send the requested work to the other chat.', callId = 'call-0'): string {
  const turn = caller.session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
  if (turn > 1) {
    caller.session.append('step/end', { turn: turn - 1, step: 0 })
    caller.session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
  }
  caller.session.append('turn/start', { turn })
  caller.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  caller.session.append('step/start', { turn, step: 0 })
  const called = caller.session.append('tool/call', { turn, step: 0, name: 'session_send_message', callId: ToolCallId(callId), arguments: '{}' })
  return `${called.seq}:${callId}`
}

function sendRequest(recipient: Agent, submissionId: string, message = 'Please review this result.') {
  return { sessionId: recipient.id, submissionId, message, delivery: 'notice' as const }
}

describe('ordinary peer Session operations', () => {
  it('captures a real current human tool event while leaving unrelated or stale executions untouched', async () => {
    const { controller, caller, recipient, archived } = await bench()
    expect(controller.peerToolCallSeq(caller, ToolCallId('call-0'))).toBeUndefined()
    const first = request(caller)
    expect(controller.peerToolCallSeq(caller, ToolCallId('call-0'))).toBe(Number(first.split(':')[0]))
    expect(controller.peerToolCallSeq({ ...caller }, ToolCallId('call-0'))).toBeUndefined()
    expect(controller.peerToolCallSeq(recipient, ToolCallId('call-0'))).toBeUndefined()
    const second = request(caller)
    expect(controller.peerToolCallSeq(caller, ToolCallId('call-0'))).toBe(Number(second.split(':')[0]))
    archived.push(caller.id)
    expect(controller.peerToolCallSeq(caller, ToolCallId('call-0'))).toBeUndefined()
  })

  it('lists and pages only ordinary unarchived peers in the same workspace without activation', async () => {
    const { ctx, loop, controller, caller, recipient, archived } = await bench()
    const other = await loop.create(SessionId('other-workspace'), {}, { cwd: '/other' })
    const hidden = await loop.create(SessionId('archived'), {}, { cwd: '/workspace' })
    archived.push(hidden.id)
    ctx.sessions.create(SessionId('child'), { meta: { cwd: '/workspace', origin: 'subagent', parentSession: caller.id } })
    ctx.sessions.create(SessionId('second'), { meta: { cwd: '/workspace' } })
    const resume = vi.spyOn(ctx.agents, 'resume')
    const first = await controller.listPeerSessions(caller, { limit: 1 }, signal)
    expect(first.items).toHaveLength(1)
    expect(first.nextOffset).toBe(1)
    if (first.nextOffset === undefined) throw new Error('Expected the next peer page offset')
    const second = await controller.listPeerSessions(caller, { offset: first.nextOffset, limit: 1 }, signal)
    expect(new Set([...first.items, ...second.items].map(item => item.sessionId))).toEqual(new Set([recipient.id, SessionId('second')]))
    expect(second.nextOffset).toBeUndefined()
    expect(first.items.some(item => item.sessionId === other.id)).toBe(false)
    expect(resume).not.toHaveBeenCalled()
  })

  it('returns bounded text history pages with seqs and excludes hidden tool and reasoning content', async () => {
    const { controller, caller, recipient } = await bench()
    recipient.session.append('turn/start', { turn: 1 })
    recipient.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    recipient.session.append('assistant/message', { turn: 1, step: 0, message: createAssistantMessage({
      content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'second' }], source: { provider: 'fixture', model: 'fixture' },
    }), stream: [] }, { surfaceOp: 'append' })
    recipient.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'third' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const last = await controller.readPeerSession(caller, { sessionId: recipient.id, limit: 2 }, signal)
    expect(last.messages.map(item => item.text)).toEqual(['second', 'third'])
    expect(JSON.stringify(last)).not.toContain('private reasoning')
    if (last.nextBeforeSeq === undefined) throw new Error('Expected the previous history page cursor')
    const previous = await controller.readPeerSession(caller, { sessionId: recipient.id, beforeSeq: last.nextBeforeSeq }, signal)
    expect(previous.messages.map(item => item.text)).toEqual(['first'])
    expect(previous.nextBeforeSeq).toBeUndefined()
  })

  it('pages only human, relayed agent and model conversation text while hiding time, runtime and skill context', async () => {
    const { ctx, controller, caller, recipient } = await bench()
    recipient.session.append('turn/start', { turn: 1 })
    const human = recipient.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Visible human request' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    recipient.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'PRIVATE clock: 2026-10-25T02:00:00Z' }],
      source: { kind: 'time-context', form: 'snapshot', sections: [] },
    }), { surfaceOp: 'append' })
    recipient.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'PRIVATE runtime paths and settings' }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
    }), { surfaceOp: 'append' })
    recipient.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'PRIVATE skill instructions' }],
      source: { kind: 'skill-invocation', name: 'fixture-skill', form: 'instructions' },
    }), { surfaceOp: 'append' })
    recipient.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'PRIVATE system context' }], source: { kind: 'system-prompt' },
    }), { surfaceOp: 'append' })
    const relay = recipient.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Visible relayed update' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: caller.id },
    }), { surfaceOp: 'append' })
    const assistant = recipient.session.append('assistant/message', { turn: 1, step: 0, message: createAssistantMessage({
      content: [{ type: 'text', text: 'Visible model answer' }], source: { provider: 'fixture', model: 'fixture' },
    }), stream: [] }, { surfaceOp: 'append' })
    const resume = vi.spyOn(ctx.agents, 'resume')
    const latest = await controller.readPeerSession(caller, { sessionId: recipient.id, limit: 2 }, signal)
    expect(latest.messages).toMatchObject([
      { seq: relay.seq, role: 'user', text: 'Visible relayed update', sourceKind: 'agent-message', senderSessionId: caller.id },
      { seq: assistant.seq, role: 'assistant', text: 'Visible model answer', sourceKind: 'model' },
    ])
    expect(latest.nextBeforeSeq).toBe(relay.seq)
    if (latest.nextBeforeSeq === undefined) throw new Error('Expected the previous conversation page')
    const older = await controller.readPeerSession(caller, { sessionId: recipient.id, beforeSeq: latest.nextBeforeSeq, limit: 2 }, signal)
    expect(older.messages).toMatchObject([{ seq: human.seq, text: 'Visible human request', sourceKind: 'user' }])
    expect(older.messages).toHaveLength(1)
    expect(older.nextBeforeSeq).toBeUndefined()
    expect(JSON.stringify([latest, older])).not.toContain('PRIVATE')
    expect(resume).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent replays and preserves actual sender attribution without waking notices', async () => {
    const { controller, caller, recipient, send } = await bench()
    const submissionId = request(caller)
    const values = await Promise.all(Array.from({ length: 4 }, () =>
      controller.sendPeerMessage(caller, sendRequest(recipient, submissionId), signal)))
    expect(new Set(values.map(value => value.messageId)).size).toBe(1)
    expect(values.filter(value => !value.duplicate)).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toBe('next-turn')
    expect(send.mock.calls[0]?.[2]).toBe(false)
    expect(recipient.inbox.nextTurn[0]?.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: caller.id })
    expect(values[0]).toMatchObject({ status: 'accepted', delivery: 'notice' })
  })

  it('accepts identical text in a new human request even when raw provider call ids repeat', async () => {
    const { controller, caller, recipient, send } = await bench()
    const first = await controller.sendPeerMessage(caller, sendRequest(recipient, request(caller)), signal)
    const second = await controller.sendPeerMessage(caller, sendRequest(recipient, request(caller)), signal)
    expect(second.messageId).not.toBe(first.messageId)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('keeps accepted-removal evidence and deduplicates after the provider instance is recreated', async () => {
    const { ctx, controller, caller, recipient, send } = await bench()
    const submissionId = request(caller)
    const first = await controller.sendPeerMessage(caller, sendRequest(recipient, submissionId), signal)
    recipient.inbox.remove(first.messageId)
    const restarted = new PeerSessions(ctx, new ApiSessionAgentController(ctx), {
      maxListItems: 50, maxReadMessages: 30, maxResultBytes: 32768, maxMessageBytes: 16384,
    })
    const replayed = await restarted.send(caller, sendRequest(recipient, submissionId), signal)
    expect(replayed).toMatchObject({ duplicate: true, messageId: first.messageId })
    expect(send).toHaveBeenCalledTimes(1)
    expect(recipient.inbox.nextTurn).toHaveLength(0)
  })

  it('queues waking input while acknowledging only inbox acceptance', async () => {
    const { controller, caller, recipient, send } = await bench()
    const value = await controller.sendPeerMessage(caller, { ...sendRequest(recipient, request(caller)), delivery: 'queue' }, signal)
    expect(send.mock.calls[0]?.[2]).toBe(true)
    expect(value.status).toBe('accepted')
    expect(value).not.toHaveProperty('processed')
  })

  it('requires current human input and rejects automatic agent-to-agent reply chains', async () => {
    const { controller, caller, recipient, send } = await bench()
    const submissionId = request(caller)
    caller.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Send back a reply.' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: recipient.id } }), { surfaceOp: 'append' })
    const called = caller.session.append('tool/call', { turn: 1, step: 0, name: 'session_send_message', callId: ToolCallId('reply'), arguments: '{}' })
    await expect(controller.sendPeerMessage(caller, sendRequest(recipient, `${called.seq}:reply`), signal)).rejects.toMatchObject({ code: 'PEER_HUMAN_REQUEST_REQUIRED' })
    await expect(controller.sendPeerMessage({ ...caller }, sendRequest(recipient, submissionId), signal))
      .rejects.toMatchObject({ code: 'PEER_CALLER_NOT_LIVE' })
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects self, archived, missing and delegated targets before inbox acceptance', async () => {
    const { ctx, controller, caller, recipient, archived, send } = await bench()
    const submissionId = request(caller)
    await expect(controller.sendPeerMessage(caller, sendRequest(caller, submissionId), signal)).rejects.toMatchObject({ code: 'PEER_SELF_MESSAGE' })
    archived.push(recipient.id)
    await expect(controller.sendPeerMessage(caller, sendRequest(recipient, submissionId), signal)).rejects.toMatchObject({ code: 'PEER_SESSION_ARCHIVED' })
    archived.length = 0
    await expect(controller.sendPeerMessage(caller, { ...sendRequest(recipient, submissionId), sessionId: SessionId('missing') }, signal))
      .rejects.toMatchObject({ code: 'PEER_SESSION_NOT_FOUND' })
    ctx.sessions.create(SessionId('child'), { meta: { cwd: '/workspace', origin: 'subagent', parentSession: caller.id } })
    await expect(controller.sendPeerMessage(caller, { ...sendRequest(recipient, submissionId), sessionId: SessionId('child') }, signal))
      .rejects.toMatchObject({ code: 'PEER_SUBAGENT_TARGET' })
    expect(send).not.toHaveBeenCalled()
  })

  it('binds human confirmation to the exact caller, target, action and human request', async () => {
    const { ctx, loop, controller, caller, recipient } = await bench()
    const elsewhere = await loop.create(SessionId('elsewhere'), {}, { cwd: '/other' })
    vi.spyOn(elsewhere, 'send').mockImplementation((message, target) => { elsewhere.inbox.append(target, message) })
    const submissionId = request(caller)
    await expect(controller.sendPeerMessage(caller, sendRequest(elsewhere, submissionId), signal)).rejects.toMatchObject({ code: 'PEER_TARGET_CONFIRMATION_REQUIRED' })
    const answer = vi.fn(async () => true)
    expect(await controller.confirmPeerSession(caller, recipient.id, 'send', answer, signal)).toBeUndefined()
    expect(answer).not.toHaveBeenCalled()
    const confirmation = await controller.confirmPeerSession(caller, elsewhere.id, 'send', answer, signal)
    expect(answer).toHaveBeenCalledOnce()
    if (confirmation === undefined) throw new Error('Expected cross-workspace send consent')
    await expect(controller.readPeerSession(caller, { sessionId: elsewhere.id, confirmation }, signal)).rejects.toMatchObject({ code: 'PEER_TARGET_CONFIRMATION_REQUIRED' })
    await expect(controller.sendPeerMessage(caller, { ...sendRequest(elsewhere, submissionId), confirmation }, signal)).resolves.toMatchObject({ status: 'accepted' })
    const second = request(caller)
    await expect(controller.sendPeerMessage(caller, { ...sendRequest(elsewhere, second), confirmation }, signal)).rejects.toMatchObject({ code: 'PEER_TARGET_CONFIRMATION_REQUIRED' })
    const declined = vi.fn(async () => false)
    await expect(controller.confirmPeerSession(caller, elsewhere.id, 'read', declined, signal)).rejects.toMatchObject({ code: 'PEER_CONFIRMATION_DECLINED' })
    const readConfirmation = await controller.confirmPeerSession(caller, elsewhere.id, 'read', async () => true, signal)
    if (readConfirmation === undefined) throw new Error('Expected cross-workspace read consent')
    await expect(controller.readPeerSession(caller, { sessionId: elsewhere.id, confirmation: readConfirmation }, signal)).resolves.toHaveProperty('messages')
    expect(ctx.agents.get(elsewhere.id)).toBe(elsewhere)
  })

  it('reports unknown durability with an exact message identity and safely checkpoints a replay', async () => {
    const { controller, caller, recipient, flush, send } = await bench()
    const submissionId = request(caller)
    flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk unavailable'))
    let failure: PeerSessionError | undefined
    try { await controller.sendPeerMessage(caller, sendRequest(recipient, submissionId), signal) } catch (error) {
      if (!(error instanceof PeerSessionError)) throw error
      failure = error
    }
    expect(failure?.code).toBe('PEER_DELIVERY_UNCONFIRMED')
    expect(typeof failure?.messageId).toBe('string')
    if (failure?.messageId === undefined) throw new Error('Expected an unconfirmed delivery receipt')
    expect(failure.message).toContain(failure.messageId)
    expect(failure.message).toContain(recipient.id)
    expect(failure.message).not.toMatch(/query or repeat/iu)
    const recovered = await controller.sendPeerMessage(caller, sendRequest(recipient, submissionId), signal)
    expect(recovered).toMatchObject({ duplicate: true, messageId: failure?.messageId })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation and rejects invalid or oversized complete messages before sending', async () => {
    const { controller, caller, recipient, send } = await bench()
    const submissionId = request(caller)
    await expect(controller.sendPeerMessage(caller, sendRequest(recipient, submissionId), AbortSignal.abort())).rejects.toBeDefined()
    await expect(controller.sendPeerMessage(caller, sendRequest(recipient, submissionId, '中'.repeat(20000)), signal)).rejects.toMatchObject({ code: 'PEER_MESSAGE_TOO_LARGE' })
    await expect(controller.sendPeerMessage(caller, sendRequest(recipient, 'not-a-durable-call'), signal)).rejects.toMatchObject({ code: 'PEER_INVALID_REQUEST' })
    await expect(controller.readPeerSession(caller, { sessionId: recipient.id, limit: 0 }, signal)).rejects.toMatchObject({ code: 'PEER_INVALID_REQUEST' })
    expect(send).not.toHaveBeenCalled()
  })

  it('preserves an explicit writer-held failure and accepts no message', async () => {
    const { ctx, caller, recipient, send } = await bench()
    const owner = new ApiSessionAgentController(ctx)
    vi.spyOn(owner, 'resolveAgent').mockResolvedValue({ error: new RemoteError('session/writer-held', 'fixture lock', { sessionId: recipient.id }) })
    const peers = new PeerSessions(ctx, owner, { maxListItems: 50, maxReadMessages: 30, maxResultBytes: 32768, maxMessageBytes: 16384 })
    await expect(peers.send(caller, sendRequest(recipient, request(caller)), signal)).rejects.toMatchObject({ code: 'PEER_SESSION_WRITER_HELD' })
    expect(send).not.toHaveBeenCalled()
  })

  it('bounds complete multibyte history results and visibly marks a truncated message', async () => {
    const { ctx, caller, recipient } = await bench()
    recipient.session.append('turn/start', { turn: 1 })
    recipient.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '🌲中文'.repeat(500) }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    const peers = new PeerSessions(ctx, new ApiSessionAgentController(ctx), {
      maxListItems: 50, maxReadMessages: 30, maxResultBytes: 1024, maxMessageBytes: 16384,
    })
    const page = await peers.read(caller, { sessionId: recipient.id }, signal)
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(1024)
    expect(page.messages[0]?.truncated).toBe(true)
    expect(page.messages[0]?.text).not.toContain('\uFFFD')
  })

  it('cancels at the pre-admission durability barrier without inserting a message', async () => {
    const { controller, caller, recipient, flush, send } = await bench()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const abort = new AbortController()
    flush.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
    const pending = controller.sendPeerMessage(caller, sendRequest(recipient, request(caller)), abort.signal)
    const settled = pending.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await entered.promise
      abort.abort()
      release.resolve(undefined)
      expect(await settled).toHaveProperty('error')
      expect(send).not.toHaveBeenCalled()
      expect(recipient.inbox.nextTurn).toHaveLength(0)
    } finally { release.resolve(undefined); await settled }
  })

  it('aborts and joins a pending human confirmation before its feature unloads', async () => {
    const { ctx, loop, caller } = await bench()
    request(caller)
    const recipient = await loop.create(SessionId('confirm-target'), {}, { cwd: '/other' })
    const entered = Promise.withResolvers<undefined>()
    let peers: PeerSessions | undefined
    const feature = await ctx.plugin({
      name: 'peer-confirmation-feature',
      inject: ['sessionProjections', 'typert', 'agents', 'workspaceRegistry', 'sessionQuery', 'sessions'],
      apply(owner: Context) {
        peers = new PeerSessions(owner, new ApiSessionAgentController(owner), {
          maxListItems: 50, maxReadMessages: 30, maxResultBytes: 32768, maxMessageBytes: 16384,
        })
      },
    })
    if (peers === undefined) throw new Error('Peer service was not mounted')
    const pending = peers.confirm(caller, recipient.id, 'send', (_target, active) => new Promise<boolean>((_resolve, reject) => {
      active.addEventListener('abort', () => { reject(new Error('Fixture confirmation aborted', { cause: active.reason })) }, { once: true })
      entered.resolve(undefined)
    }), signal)
    const settled = pending.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await entered.promise
      await feature.dispose()
      expect(await settled).toHaveProperty('error')
      await expect(peers.list(caller, {}, signal)).rejects.toMatchObject({ code: 'PEER_SERVICE_DISPOSED' })
    } finally { await feature.dispose(); await settled }
  })
})
