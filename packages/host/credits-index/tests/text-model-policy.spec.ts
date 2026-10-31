import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage, ReasoningEffortId, ToolCallId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import LocalFS from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { redactSessionSnapshotIds, normalizeSessionSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import { eventLines, toHeaderLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { registerProductTextModelPolicy } from '../src/text-model-policy.ts'

const capabilities = { tools: false, vision: false, reasoning: false, stream: true, maxInputTokens: 32_000 }
const resources: { ctx: Context; directory: string }[] = []
afterEach(async () => {
  for (const { ctx, directory } of resources.splice(0).reverse()) {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
})

class DeclaredAdapter extends MockAdapter {
  gate?: (model: string) => Promise<void>
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.gate?.(model)
    return { provider, id: model, name: model, context: { contextWindow: 1_000_000 },
      maxOutputTokens: 8192, defaultMaxTokens: 8192,
      ...model === 'full' ? {} : { textCapabilities: { ...capabilities,
        ...model === 'file-tools' ? { tools: true } : {},
        ...model === 'vision-only' ? { vision: true } : {},
        ...model === 'no-stream' ? { stream: false } : {} } } }
  }
}

class BindingRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  calls = 0
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1000 }
  }
  async run(_request: PtcRunSpec) { this.calls += 1; return { logs: [] } }
}

async function boot(script: StreamChunk[][], options: { ptc?: boolean; suppressed?: boolean; complete?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-text-model-policy-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const ctx = new Context()
  resources.push({ ctx, directory })
  const adapter = new DeclaredAdapter(script)
  let revision = 0
  let bodies = 0
  const Provider = { name: 'declared-model-fixture', inject: ['llm', 'tools', 'systemPrompt'], apply(inner: Context) {
    inner.effect(() => inner.llm.registerAdapter(['fixture'], adapter))
    inner.tools.register(defineTool({ name: 'danger', description: 'Owned deterministic fixture operation', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { bodies += 1; return 'ran' },
    }))
    if (options.complete) inner.systemPrompt.section({ name: 'fixture:complete', order: 0, complete: true, text: 'A complete deployment prompt.' })
  } }
  const Policy = { name: 'declared-model-policy', apply(inner: Context) { registerProductTextModelPolicy(inner, { revision: () => revision }) } }
  const modules = new Map<string, unknown>([
    ['sessions', SessionStore], ['projections', SessionProjections], ['agents', AgentRegistry], ['llm', LlmRuntime],
    ['system-prompt', SystemPrompt], ['tools', Tools], ['agent-loop', AgentLoop], ['provider', Provider], ['policy', Policy],
    ['binding-runtime', BindingRuntime], ['fs', LocalFS], ['working-directory', WorkingDirectory],
  ])
  const config = join(directory, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { name: 'sessions' }, { name: 'projections' }, { name: 'agents' }, { name: 'llm' },
    { name: 'system-prompt', config: { includeRuntimeContext: !options.suppressed } },
    { name: 'fs' }, { name: 'working-directory' },
    { name: 'tools', config: { mode: options.ptc ? 'ptc' : 'native' } },
    ...options.ptc ? [{ name: 'binding-runtime' }] : [],
    { name: 'agent-loop', config: { agents: [] } }, { name: 'provider' }, { name: 'policy' },
  ]))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
    if (!modules.has(specifier)) throw new Error(`Unexpected policy fixture module ${specifier}`)
    return modules.get(specifier)
  } } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const create = (id: string, model = 'plain') => ctx.agentLoop.create(SessionId(id), { provider: 'fixture', model }, { cwd: workspace })
  const send = (agent: Agent, text = '介绍一下海边日落') => { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })) }
  return { ctx, directory, workspace, adapter, create, send, Policy,
    bump: () => { revision += 1 }, get bodies() { return bodies },
  }
}

function selection(agent: Agent, model = 'plain'): ModelSelectionRef {
  const ref: ModelSelectionRef = { current: { provider: 'fixture', model }, assembled: undefined }
  installModelSelection(agent.ctx, ref)
  return ref
}
function outcomeCode(agent: Agent): string | undefined {
  const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
  return end?.type === 'turn/end' && end.data.reason.kind === 'error' ? end.data.reason.error.code : undefined
}
function noticeCount(agent: Agent): number {
  const snapshot = agent.session.deriveMessages().findLast(message => message.role === 'user' && message.source.kind === 'runtime-context')
  return snapshot?.content.filter(block => block.type === 'text' && block.text.includes('This model supports text conversation only.')).length ?? 0
}
function serializedSession(agent: Agent): string {
  return JSON.stringify(toHeaderLine(agent.session.header)) + '\n' + eventLines(agent.session.snapshotEvents())
}
function normalizedSession(raw: string, cwd: string): string {
  const typed = redactSessionSnapshotIds([raw])[0]
  if (typed === undefined) throw new Error('Missing recorded policy Session')
  return normalizeSessionSnapshot(typed, { sessionIds: [], cwd }, { identityMode: 'preserve' })
}

describe('declared text capabilities through the real Loader and Agent policy', () => {
  it.each([false, true])('starts with no advertised or executable native/PTC tools (ptc=%s)', async (ptc) => {
    const f = await boot([textResponse('这是纯文本回答。')], { ptc })
    const agent = await f.create('pure-first')
    let scopedBodies = 0
    agent.ctx.tools.register(defineTool({ name: 'scoped_danger', description: 'Scoped fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { scopedBodies += 1; return 'scoped ran' },
    }))
    f.send(agent, '请生成一个视频')
    await agent.whenIdle()
    expect(outcomeCode(agent)).toBeUndefined()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.adapter.requests[0]!.tools ?? []).toEqual([])
    expect(JSON.stringify(f.adapter.requests[0]!.messages)).toContain('This model supports text conversation only.')
    expect(noticeCount(agent)).toBe(1)
    expect(JSON.stringify(f.adapter.requests[0]!.messages)).toContain('32000')
    const assembly = await f.ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(assembly.sections.map(section => section.name)).not.toContain('tools:sdk')
    expect(assembly.sections.map(section => section.name)).not.toContain('tools:ptc-only')
    const name = ptc ? 'run_code' : 'scoped_danger'
    const result = await f.ctx.tools.execute({ agent, callId: ToolCallId('forced'), name,
      arguments: ptc ? { code: 'await tools.danger({})' } : {}, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('当前模型不支持工具执行')
    expect(f.bodies).toBe(0)
    expect(scopedBodies).toBe(0)
  })

  it('records capability guidance even with a complete prompt and optional runtime contexts disabled', async () => {
    const f = await boot([textResponse('可以正常回答文字问题。')], { complete: true, suppressed: true })
    const agent = await f.create('complete')
    f.send(agent)
    await agent.whenIdle()
    expect(noticeCount(agent)).toBe(1)
    expect(JSON.stringify(f.adapter.requests[0]!.messages)).toContain('A complete deployment prompt.')
    expect(f.adapter.requests[0]!.tools ?? []).toHaveLength(0)
  })

  it('keeps undeclared models unchanged and switches both directions on the next assembly', async () => {
    const f = await boot([textResponse('纯文本一'), textResponse('完整模型'), textResponse('纯文本二')])
    const agent = await f.create('switch')
    const ref = selection(agent)
    f.send(agent); await agent.whenIdle()
    ref.current = { provider: 'fixture', model: 'full' }
    f.send(agent); await agent.whenIdle()
    ref.current = { provider: 'fixture', model: 'plain' }
    f.send(agent); await agent.whenIdle()
    expect(f.adapter.requests.map(request => request.model)).toEqual(['plain', 'full', 'plain'])
    expect(f.adapter.requests.map(request => request.tools?.length ?? 0)).toEqual([0, 1, 0])
    expect(noticeCount(agent)).toBe(1)
  })

  it('keeps different chats and standalone tool operations independent from a text-only chat', async () => {
    const f = await boot([textResponse('第一条回复'), textResponse('第二条回复')])
    const pure = await f.create('parallel-pure')
    const full = await f.create('parallel-full', 'full')
    f.send(pure); f.send(full)
    await Promise.all([pure.whenIdle(), full.whenIdle()])
    expect(f.adapter.requests.find(request => request.model === 'plain')?.tools ?? []).toHaveLength(0)
    expect(f.adapter.requests.find(request => request.model === 'full')?.tools).toHaveLength(1)
    const invoke = (agent?: Agent) => f.ctx.tools.execute({ ...agent === undefined ? {} : { agent },
      callId: ToolCallId('independent'), name: 'danger', arguments: {}, signal: new AbortController().signal })
    expect((await invoke(pure)).isError).toBe(true)
    expect((await invoke(full)).isError).not.toBe(true)
    expect((await invoke()).isError).not.toBe(true)
    expect(f.bodies).toBe(2)
  })

  it('keeps the selected snapshot when a model switch occurs during asynchronous capability resolution', async () => {
    const f = await boot([textResponse('纯文本快照'), textResponse('下一步完整模型')])
    const agent = await f.create('assembly-race')
    const ref = selection(agent)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let gated = false
    f.adapter.gate = async (model) => {
      if (model !== 'plain' || gated) return
      gated = true; entered.resolve(undefined); await release.promise
    }
    f.send(agent)
    try { await entered.promise; ref.current = { provider: 'fixture', model: 'full' } }
    finally { release.resolve(undefined) }
    await agent.whenIdle()
    f.send(agent); await agent.whenIdle()
    expect(f.adapter.requests.map(request => [request.model, request.tools?.length ?? 0])).toEqual([['plain', 0], ['full', 1]])
  })

  it.each(['route', 'account'] as const)('does not dispatch when the captured %s changes before request admission', async (change) => {
    const f = await boot([textResponse('must not be sent')])
    const agent = await f.create('stale')
    selection(agent)
    agent.ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      if (change === 'account') f.bump()
      return change === 'route' ? { ...config, model: 'full' } : config
    }, { prepend: true })
    f.send(agent); await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(0)
    expect(outcomeCode(agent)).toBe('MODEL_CAPABILITIES_CHANGED')
  })

  it('retains complete tool history on an incompatible switch and can continue after switching back', async () => {
    const f = await boot([toolCallResponse('call', 'danger', {}), textResponse('工具已完成'), textResponse('可以继续')])
    const agent = await f.create('history', 'full')
    const ref = selection(agent, 'full')
    f.send(agent); await agent.whenIdle()
    const original = agent.session.snapshotEvents()
    expect(f.bodies).toBe(1)
    expect(agent.session.deriveMessages().some(message => message.role === 'tool')).toBe(true)
    ref.current = { provider: 'fixture', model: 'plain' }
    f.send(agent); await agent.whenIdle()
    expect(outcomeCode(agent)).toBe('MODEL_CAPABILITY_HISTORY_UNSUPPORTED')
    expect(f.adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().slice(0, original.length)).toEqual(original)
    ref.current = { provider: 'fixture', model: 'full' }
    f.send(agent); await agent.whenIdle()
    expect(outcomeCode(agent)).toBeUndefined()
    expect(f.adapter.requests).toHaveLength(3)
  })

  it('checks active history rather than old tool records replaced by an explicit summary', async () => {
    const f = await boot([toolCallResponse('call', 'danger', {}), textResponse('工具已完成'), textResponse('读取摘要后回答')])
    const agent = await f.create('compacted', 'full')
    const ref = selection(agent, 'full')
    f.send(agent); await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const user = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const last = events.findLast(event => event.type === 'assistant/message')
    if (user?.type !== 'user/message' || last?.type !== 'assistant/message') throw new Error('Expected complete original conversation')
    const nodes = agent.session.surface.nodes.filter(seq => seq >= user.seq && seq <= last.seq)
    agent.session.append('user/message', { ...user.data, content: [{ type: 'text', text: '已完成的操作摘要：海边日落。' }] },
      { surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: last.seq }, sourceEventSeqs: nodes })
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(true)
    expect(agent.session.deriveMessages().some(message => message.role === 'tool')).toBe(false)
    ref.current = { provider: 'fixture', model: 'plain' }
    f.send(agent); await agent.whenIdle()
    expect(outcomeCode(agent)).toBeUndefined()
    expect(f.adapter.requests).toHaveLength(3)
  })

  it('denies unsupported stream and explicit reasoning before model dispatch', async () => {
    const f = await boot([textResponse('must not send')])
    const noStream = await f.create('stream', 'no-stream')
    f.send(noStream); await noStream.whenIdle()
    expect(outcomeCode(noStream)).toBe('MODEL_CAPABILITY_STREAM_UNSUPPORTED')
    const reasoning = await f.ctx.agentLoop.create(SessionId('reasoning'), { provider: 'fixture', model: 'plain', reasoningEffort: ReasoningEffortId('high') }, { cwd: f.workspace })
    f.send(reasoning); await reasoning.whenIdle()
    expect(outcomeCode(reasoning)).toBe('MODEL_CAPABILITY_REASONING_UNSUPPORTED')
    expect(f.adapter.requests).toHaveLength(0)
  })

  it('keeps a new binary attachment out of a declared text-only request without sending it', async () => {
    const f = await boot([textResponse('must not send')])
    const agent = await f.create('file-input')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'text', text: '查看这份文件' },
      { type: 'file', attachment: { attachmentId: AttachmentId('a'.repeat(64)), name: 'notes.txt', bytes: 10 } },
    ] }))
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(0)
    expect(outcomeCode(agent)).toBe('MODEL_CAPABILITY_INPUT_UNSUPPORTED')
  })

  it.each(['file-tools', 'vision-only'])('uses file-tool support independently from vision for %s', async (model) => {
    const f = await boot([textResponse('文件按工具句柄提供。')])
    const agent = await f.create('mixed-file-' + model, model)
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'text', text: '查看这份文本文件' },
      { type: 'file', attachment: { attachmentId: AttachmentId('b'.repeat(64)), name: 'notes.txt', bytes: 10 } },
    ] }))
    await agent.whenIdle()
    if (model === 'file-tools') {
      expect(f.adapter.requests).toHaveLength(1)
      expect(f.adapter.requests[0]!.messages.every(message => message.content.every(block => block.type !== 'file'))).toBe(true)
      expect(outcomeCode(agent)).not.toBe('MODEL_CAPABILITY_INPUT_UNSUPPORTED')
    } else {
      expect(f.adapter.requests).toHaveLength(0)
      expect(outcomeCode(agent)).toBe('MODEL_CAPABILITY_INPUT_UNSUPPORTED')
    }
  })

  it('invalidates an unsubmitted assembly when the account changes during metadata resolution', async () => {
    const f = await boot([textResponse('must not send')])
    const agent = await f.create('metadata-account-race')
    let changed = false
    f.adapter.gate = async () => { if (!changed) { changed = true; f.bump() } }
    f.send(agent); await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(0)
    expect(outcomeCode(agent)).toBe('MODEL_CAPABILITIES_CHANGED')
  })

  it('unwinds and reapplies its guards without retaining a duplicate required notice', async () => {
    const f = await boot([textResponse('第一次'), textResponse('重新挂载')])
    const agent = await f.create('hmr')
    f.send(agent); await agent.whenIdle()
    const before = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context').length
    const entry = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'policy')
    if (entry?.fiber === undefined) throw new Error('Expected loaded policy owner')
    await entry.fiber.dispose()
    const permitted = await f.ctx.tools.execute({ agent, callId: ToolCallId('without-policy'), name: 'danger', arguments: {}, signal: new AbortController().signal })
    expect(permitted.isError).not.toBe(true)
    expect(f.bodies).toBe(1)
    await f.ctx.plugin(f.Policy)
    f.send(agent); await agent.whenIdle()
    expect(f.adapter.requests[1]!.tools ?? []).toHaveLength(0)
    expect(noticeCount(agent)).toBe(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')).toHaveLength(before)
  })

  it('replays a recorded native plain/full model switch with the same committed capability guidance', async () => {
    const path = new URL('./expected/text-model-capabilities/session.v4.jsonl', import.meta.url)
    const run = async (script: StreamChunk[][]) => {
      const f = await boot(script)
      const agent = await f.create('record-text-capabilities')
      const ref = selection(agent)
      f.send(agent, '用文字介绍海边日落'); await agent.whenIdle()
      ref.current = { provider: 'fixture', model: 'full' }
      f.send(agent, '继续描述四季的变化'); await agent.whenIdle()
      expect(f.adapter.requests.map(request => request.tools?.length ?? 0)).toEqual([0, 1])
      return { f, agent }
    }
    if (process.env.DSH_SNAPSHOT === 'record') {
      const { f, agent } = await run([textResponse('夕阳将海面染成金色。'), textResponse('四季让山谷呈现不同的色彩。')])
      await mkdir(new URL('./expected/text-model-capabilities/', import.meta.url), { recursive: true })
      await writeFile(path, normalizedSession(serializedSession(agent), f.workspace))
    }
    const expected = await readFile(path, 'utf8')
    const events = parseSessionLog(expected)
    const script = deriveReplayScript(events).map((entry) => {
      if (entry.kind !== 'chunks') throw new Error('Expected recorded model stream')
      return entry.chunks
    })
    expect(script).toHaveLength(2)
    const { f, agent } = await run(script)
    const serialized = serializedSession(agent)
    await writeFile(join(f.directory, 'session.v4.jsonl'), serialized)
    const restored = Session.create(SessionId('restored-text-capabilities'), parseSessionLog(await readFile(join(f.directory, 'session.v4.jsonl'), 'utf8')))
    expect(restored.deriveMessages().filter(message => message.role === 'assistant')).toHaveLength(2)
    expect(normalizedSession(serialized, f.workspace)).toBe(expected)
  })
})
