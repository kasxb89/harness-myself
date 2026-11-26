/** Keyless recorded model experience through Loader, AgentLoop and the native media tools. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { normalizeSessionLog, normalizeSessionSnapshot, redactSessionSnapshotIds } from '@deepseek-ai/dsh-session-snapshot'
import { eventLines, toHeaderLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MediaV2Client, type MediaV2Account } from '../src/media-v2-client.ts'
import { mediaV2Object } from '../src/media-v2-protocol.ts'
import { registerMediaV2Tools } from '../src/media-v2-tools.ts'
import actualGo from './fixtures/media-v2-native-go-catalog.json' with { type: 'json' }

const modelId = 'ycapi-seedance-2-5'
const humanText = '查看媒体目录，再完整读取 Seedance 2.5 的原生参数与素材限制；只查看，不上传或生成。'
const resources: { ctx: Context; directory: string }[] = []
afterEach(async () => {
  for (const { ctx, directory } of resources.splice(0).reverse()) {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
})

async function boot(script: StreamChunk[][]) {
  const directory = await mkdtemp(join(tmpdir(), 'media-v2-native-loader-')), workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const ctx = new Context(), adapter = new MockAdapter(script)
  resources.push({ ctx, directory })
  const calls: { path: string; method: string }[] = []
  const account: MediaV2Account = { owner: 'keyless-synthetic-owner', async fetch(path, init) {
    calls.push({ path, method: init.method ?? 'GET' })
    if (path !== '/v1/media-v2/models' || init.method !== 'GET') throw new Error('This recorded scenario permits only a free catalog GET')
    return Response.json(actualGo)
  } }
  const client = new MediaV2Client({ baseUrl: 'https://synthetic.invalid', directory: join(directory, 'receipts'),
    timeoutMs: 1000, creditsPerYuan: 1000 })
  const NativeFixture = { name: 'native-media-fixture', inject: ['llm', 'tools'], apply(inner: Context) {
    inner.effect(() => inner.llm.registerAdapter(['fixture'], adapter))
    registerMediaV2Tools(inner, { client, pollIntervalMs: 1000, taskTimeoutMs: 1000, capture: async () => account,
      readAsset: async () => { throw new Error('A catalog-only model turn cannot read a file') } })
  } }
  const modules = new Map<string, unknown>([
    ['sessions', SessionStore], ['projections', SessionProjections], ['agents', AgentRegistry], ['llm', LlmRuntime],
    ['system-prompt', SystemPrompt], ['tools', Tools], ['agent-loop', AgentLoop], ['native-media-fixture', NativeFixture],
  ])
  const config = join(directory, 'cordis.yml')
  await writeFile(config, ['- name: sessions', '- name: projections', '- name: agents', '- name: llm', '- name: system-prompt',
    '- name: tools', '- name: agent-loop', '  config:', '    agents: []', '- name: native-media-fixture', '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
    if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
    return modules.get(specifier)
  } } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const agent = await ctx.agentLoop.create(SessionId('native-media-recorded'), { provider: 'fixture', model: 'fixture' }, { cwd: workspace })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: humanText }] }))
  await agent.whenIdle()
  return { directory, workspace, agent, adapter, calls }
}
function serializedSession(agent: Agent): string {
  return JSON.stringify(toHeaderLine(agent.session.header)) + '\n' + eventLines(agent.session.snapshotEvents())
}
/** Keep standard clock/path/id normalization while pinning these changed, actually captured tool schemas. */
function recordedSession(raw: string, cwd: string): string {
  const typed = redactSessionSnapshotIds([raw])[0]
  if (typed === undefined) throw new Error('Missing recorded Session')
  const context = { sessionIds: [], cwd }, options = { identityMode: 'preserve' as const }
  const headers = parseSessionLog(normalizeSessionLog(typed, context, options))
    .filter(event => event.type === 'request/header').map(event => event.data.header.tools)
  let cursor = 0
  return normalizeSessionSnapshot(typed, context, options).split('\n').map((line) => {
    if (line === '') return line
    const row = mediaV2Object(JSON.parse(line))
    if (row.type === 'request/header') mediaV2Object(mediaV2Object(row.data).header).tools = headers[cursor++]
    return JSON.stringify(row)
  }).join('\n')
}
function toolMessages(session: Session) {
  return session.deriveMessages().flatMap(message => message.role === 'tool' ? [{ content: message.content, isError: message.isError }] : [])
}

it('records and independently replays the complete native model details with zero upload, generation or fee operations', async () => {
  const file = new URL('./expected/media-v2-native/session.v4.jsonl', import.meta.url)
  if (process.env.DSH_SNAPSHOT === 'record') {
    const captured = await boot([
      toolCallResponse('native-summary', 'list_media_models_v2', {}),
      toolCallResponse('native-detail', 'list_media_models_v2', { model: modelId }),
      textResponse('已读取当前目录及该型号的全部原生参数与素材限制；没有上传、生成或扣费。'),
    ])
    expect(captured.calls).toEqual(Array.from({ length: 2 }, () => ({ path: '/v1/media-v2/models', method: 'GET' })))
    await mkdir(new URL('./expected/media-v2-native/', import.meta.url), { recursive: true })
    await writeFile(file, recordedSession(serializedSession(captured.agent), captured.workspace))
  }
  const selected = await readFile(file, 'utf8'), events = parseSessionLog(selected)
  const script = deriveReplayScript(events).map((entry) => {
    if (entry.kind !== 'chunks') throw new Error('Expected a complete captured model stream')
    return entry.chunks
  })
  expect(script).toHaveLength(3)
  const f = await boot(script)
  expect(f.adapter.requests).toHaveLength(3)
  expect(f.calls).toEqual(Array.from({ length: 2 }, () => ({ path: '/v1/media-v2/models', method: 'GET' })))
  const results = f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(2)
  const values = results.map((event) => {
    const content = event.data.message.content[0]
    if (content?.type !== 'text') throw new Error('Missing complete model-visible tool result')
    return mediaV2Object(JSON.parse(content.text))
  })
  expect(values[0]).toMatchObject({ status: 'listed', details_included: false })
  expect(JSON.stringify(values[0])).not.toContain('parameters_schema')
  const detail = values[1]
  if (detail === undefined || !Array.isArray(detail.models)) throw new Error('Missing native model detail')
  const model = mediaV2Object(detail.models[0]), original = actualGo.data.models.find(item => item.id === modelId)
  if (original === undefined) throw new Error('Missing retained actual Go model')
  expect(model.parameters_schema).toEqual(original.parameters_schema)
  expect(model.asset_fields).toEqual(original.asset_fields)
  expect(model.model_version).toBe(original.model_version)
  expect(JSON.stringify(model)).toContain('max_total_duration_sec')
  expect(JSON.stringify(model)).toContain('x-ycapi-contract')
  const tools = f.adapter.requests[0]?.tools
  expect(tools?.find(tool => tool.name === 'list_media_models_v2')?.parameters).toMatchObject({ properties: { kind: { enum: ['image', 'video', 'audio'] } } })
  expect(tools?.find(tool => tool.name === 'quote_media_operation')?.description).toContain('Preserve recursive structure')
  const recordedHeader = events.find(event => event.type === 'request/header')
  expect(recordedHeader?.type === 'request/header' ? recordedHeader.data.header.tools : undefined).toEqual(tools)
  const actualFile = join(f.directory, 'captured-session.v4.jsonl')
  await writeFile(actualFile, serializedSession(f.agent))
  const saved = await readFile(actualFile, 'utf8'), restoredEvents = parseSessionLog(saved)
  expect(toolMessages(Session.create(SessionId('restored-native'), restoredEvents)))
    .toEqual(toolMessages(Session.create(SessionId('selected-native'), events)))
  expect(deriveReplayScript(restoredEvents)).toHaveLength(3)
  expect(recordedSession(saved, f.workspace)).toBe(selected)
})
