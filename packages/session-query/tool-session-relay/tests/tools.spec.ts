import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PeerSessionError, type PeerSessionSendRequest, type PeerSessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import * as Relay from '../src/index.ts'

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot() {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-relay-loader-'))
  ctx = new Context()
  const context = ctx
  const sent: Array<{ caller: Agent; request: PeerSessionSendRequest }> = []
  const confirmations: string[] = []
  let crossWorkspace = false
  let approve = true
  let unconfirmed = false
  let afterAcceptance: (() => void) | undefined
  const target: PeerSessionSummary = { sessionId: SessionId('recipient'), title: 'Video work', cwd: '/other', running: true }
  const seen = new Set<string>()
  const rootCalls = new Map<string, number>()
  context.provide('sessionController', {
    peerToolCallSeq: (_caller: Agent, callId: string) => rootCalls.get(callId),
    listPeerSessions: async () => ({ items: [target], nextOffset: 1 }),
    readPeerSession: async () => ({ session: target, messages: [{ seq: 4, role: 'user',
      text: 'Visible history', sourceKind: 'user', truncated: false }], nextBeforeSeq: 4 }),
    confirmPeerSession: async (_caller: Agent, _id: SessionId, action: string,
      confirm: (target: PeerSessionSummary, signal: AbortSignal) => Promise<boolean>, signal: AbortSignal) => {
      if (!crossWorkspace) return undefined
      confirmations.push(action)
      if (!await confirm(target, signal)) throw new Error('declined')
      return undefined
    },
    sendPeerMessage: async (caller: Agent, request: PeerSessionSendRequest) => {
      sent.push({ caller, request })
      afterAcceptance?.()
      if (unconfirmed) {
        const messageId = MessageId(`session-relay-${'a'.repeat(64)}`)
        throw new PeerSessionError(
          `Delivery may already have reached Session ${request.sessionId}; durable confirmation failed for message ${messageId}. `
            + 'Do not automatically resend or create another submission. Ask the human to inspect the target chat and its queued messages before deciding what to do.',
          'PEER_DELIVERY_UNCONFIRMED', messageId,
        )
      }
      const duplicate = seen.has(request.submissionId)
      seen.add(request.submissionId)
      return { status: 'accepted', sessionId: request.sessionId, messageId: `receipt-${seen.size}`, delivery: request.delivery, duplicate }
    },
  } as never)
  context.provide('userQuestions', {
    ask: async () => ({ answers: [{ id: 'cross-workspace-chat', selected: [approve ? '允许发送' : '取消'] }] }),
  } as never)
  const modules = new Map<string, unknown>([['prompt', SystemPrompt], ['tools', Tools], ['relay', Relay]])
  await context.plugin(Loader)
  context.loader.internal = {
    version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
      return modules.get(specifier)
    },
  } as NonNullable<typeof context.loader.internal>
  await writeFile(join(root, 'cordis.yml'), '- name: prompt\n- name: tools\n- name: relay\n')
  const include = await import('@deepseek-ai/cordis-plugin-include')
  context.loader.builtins.include = include.default
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
  await context.loader.await()
  const session = Session.create(SessionId('caller'), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId('caller'), createdAt: 0, cwd: '/workspace', isSeeded: false,
  })
  const unavailable = (): never => { throw new Error('Fixture inbox is immutable') }
  const agent: Agent = {
    id: session.id, session, ctx: context, options: {}, status: 'running',
    inbox: { nextTurn: [], nextStep: [], clear: unavailable, append: unavailable, prepend: unavailable,
      replace: unavailable, remove: unavailable, splice: unavailable },
    send: unavailable, followup: unavailable, steer: unavailable, inject: unavailable, cancel: unavailable,
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Send this update to recipient.' }],
    source: { kind: 'user' } }), { surfaceOp: 'append' })
  let step = 0
  function log(name: string, args: unknown, callId = ToolCallId('call-0')) {
    const event = session.append('tool/call', { turn: 1, step: ++step, callId, name, arguments: JSON.stringify(args) })
    rootCalls.set(callId, event.seq)
    return callId
  }
  const call = (name: string, args: unknown, callId = log(name, args)) => context.tools.execute({
    callId, name, arguments: args, agent, signal: new AbortController().signal,
  })
  return { context, agent, sent, confirmations, call, log,
    setCross: (value: boolean) => { crossWorkspace = value }, setApprove: (value: boolean) => { approve = value },
    setUnconfirmed: () => { unconfirmed = true }, setAfterAcceptance: (callback: () => void) => { afterAcceptance = callback } }
}

describe('ordinary chat tools through Loader', () => {
  it('registers bounded structured reads and replayable Chinese tool cards', async () => {
    const { context, call } = await boot()
    expect(context.tools.schemas().map(schema => schema.name)).toEqual(['session_list', 'session_read', 'session_send_message'])
    const listed = await call('session_list', { limit: 1 })
    expect(listed.isError).toBe(false)
    expect(listed.value).toEqual({ items: [{ sessionId: 'recipient', title: 'Video work', cwd: '/other', running: true }], nextOffset: 1 })
    const read = await call('session_read', { session_id: 'recipient', limit: 1 })
    expect(read.value).toMatchObject({ messages: [{ text: 'Visible history', sourceKind: 'user' }], nextBeforeSeq: 4 })
    const send = context.tools.get('session_send_message')
    expect(send?.presentCall?.({ session_id: 'recipient', message: 'Update' })).toMatchObject({
      card: 'generic', title: '向聊天发送消息', rawInput: { session_id: 'recipient', delivery: 'queue' },
    })
    expect(send?.presentResult?.({ session_id: 'recipient', message: 'Update' },
      { content: [], isError: false, meta: { status: 'accepted', delivery: 'queue' } }))
      .toEqual({ card: 'generic', title: '消息已受理，等待目标聊天处理' })
    expect(context.tools.schemas()).toMatchSnapshot()
    const entry = [...context.loader.entries()].find(item => item.options.name === 'relay')
    if (entry?.fiber === undefined) throw new Error('Relay fixture did not load')
    await entry.fiber.dispose()
    expect(context.tools.schemas()).toEqual([])
  })

  it('derives the sender and distinguishes a new same-text call from the original replay', async () => {
    const { agent, sent, call, log } = await boot()
    const args = { session_id: 'recipient', message: 'Same update', sender_session_id: 'forged' }
    const id = log('session_send_message', args)
    const first = await call('session_send_message', args, id)
    const duplicate = await call('session_send_message', args, id)
    const independent = await call('session_send_message', args)
    expect(first.value).toMatchObject({ duplicate: false, delivery: 'queue' })
    expect(duplicate.value).toMatchObject({ duplicate: true })
    expect(independent.value).toMatchObject({ duplicate: false })
    expect(sent.every(item => item.caller === agent)).toBe(true)
    expect(sent.map(item => item.request.submissionId)).toEqual(['3:call-0', '3:call-0', '4:call-0'])
    expect(sent[0]?.request).not.toHaveProperty('sender_session_id')
  })

  it('refuses an unlogged send before reaching the producer', async () => {
    const { context, agent, sent } = await boot()
    const result = await context.tools.execute({ name: 'session_send_message', callId: ToolCallId('unlogged'),
      arguments: { session_id: 'recipient', message: 'Hello' }, agent, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(sent).toEqual([])
  })

  it('preserves an unconfirmed original receipt and target in the visible tool error without resending', async () => {
    const { call, sent, setUnconfirmed, context } = await boot()
    setUnconfirmed()
    const result = await call('session_send_message', { session_id: 'recipient', message: 'Update' })
    expect(result.isError).toBe(true)
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain(`session-relay-${'a'.repeat(64)}`)
    expect(text).toContain('Session recipient')
    expect(text).toContain('may already have reached')
    expect(text).toContain('Do not automatically resend or create another submission')
    expect(text).not.toContain('Query or repeat')
    expect(sent).toHaveLength(1)
    expect(context.tools.get('session_send_message')?.description).toContain('no delivery-status or recovery action')
  })

  it('keeps the accepted receipt visible when cancellation wins after inbox admission', async () => {
    const { context, agent, sent, log, setAfterAcceptance } = await boot()
    const cancellation = new AbortController()
    setAfterAcceptance(() => { cancellation.abort() })
    const args = { session_id: 'recipient', message: 'Accepted before stopping' }
    const result = await context.tools.execute({ name: 'session_send_message', callId: log('session_send_message', args),
      arguments: args, agent, signal: cancellation.signal })
    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ code: 'ABORTED' })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('tool call aborted')
    expect(text).toContain('message receipt-1 was accepted by Session recipient')
    expect(text).toContain('does not withdraw that message')
    expect(text).toContain('Do not automatically resend')
    expect(sent).toHaveLength(1)
  })

  it('retains possible-delivery facts when post-admission cancellation also loses the durability checkpoint', async () => {
    const { context, agent, sent, log, setAfterAcceptance, setUnconfirmed } = await boot()
    const cancellation = new AbortController()
    setUnconfirmed()
    setAfterAcceptance(() => { cancellation.abort() })
    const args = { session_id: 'recipient', message: 'Possibly accepted before stopping' }
    const result = await context.tools.execute({ name: 'session_send_message', callId: log('session_send_message', args),
      arguments: args, agent, signal: cancellation.signal })
    expect(result.isError).toBe(true)
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain(`session-relay-${'a'.repeat(64)}`)
    expect(text).toContain('may already have reached Session recipient')
    expect(text).toContain('Do not automatically resend')
    expect(sent).toHaveLength(1)
  })

  it('captures nested calls through their parent token and keeps child submissions separate', async () => {
    const { context, agent, sent, call } = await boot()
    let parent: ToolExecution | undefined
    context.tools.register(defineTool({
      name: 'relay_transport', parameters: {}, description: 'Fixture composite',
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (_args, exec) => {
        parent = exec
        for (const id of ['child-1', 'child-2']) {
          const result = await context.tools.execute({ name: 'session_send_message', callId: ToolCallId(id), rootCallId: exec.rootCallId,
            parent: exec.token, arguments: { session_id: 'recipient', message: 'Nested update', delivery: 'notice' },
            agent, signal: exec.signal })
          expect(result.isError).toBe(false)
        }
        return 'done'
      },
    }))
    expect((await call('relay_transport', {})).isError).toBe(false)
    expect(sent.map(item => item.request.submissionId)).toEqual(['3:child-1', '3:child-2'])
    if (parent === undefined) throw new Error('Missing composite execution')
    const late = await context.tools.execute({ name: 'session_send_message', callId: ToolCallId('late'), rootCallId: parent.rootCallId,
      parent: parent.token, arguments: { session_id: 'recipient', message: 'Late update' }, agent, signal: parent.signal })
    expect(late.isError).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('only forwards after a Host-owned cross-workspace confirmation and stops on cancellation', async () => {
    const { call, confirmations, sent, setCross, setApprove } = await boot()
    setCross(true)
    setApprove(false)
    expect((await call('session_send_message', { session_id: 'recipient', message: 'Hello' })).isError).toBe(true)
    expect(sent).toEqual([])
    setApprove(true)
    expect((await call('session_send_message', { session_id: 'recipient', message: 'Hello' })).isError).toBe(false)
    expect(confirmations).toEqual(['send', 'send'])
    expect(sent).toHaveLength(1)
  })
})
