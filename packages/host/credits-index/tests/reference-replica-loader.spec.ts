/** Fresh Loader/Agent replay and model-visible request projections for the reference workflow. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage, type GenerateOptions, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { normalizeSessionLog, normalizeSessionSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import { eventLines, toHeaderLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { CreativeError, CreativeStore } from '../src/creative-store.ts'
import { creativeOwner, registerCreativeTools } from '../src/creative-tools.ts'
import { registerVideoProjectTools } from '../src/video-project-tools.ts'
import { registerCreationWorkflows } from '../src/creation-workflows.ts'
import type { VideoEditor } from '../src/video-edit.ts'
import { mediaV2Object } from '../src/media-v2-protocol.ts'
import { MediaV2Client, type MediaV2Account } from '../src/media-v2-client.ts'
import { registerMediaV2Tools } from '../src/media-v2-tools.ts'

const humanText = '只分析爆款对标视频 reference.mp4 和商品图 product.png，做动作迁移复刻方案并保存计划，先不要上传、报价或生成；默认一条，保持商品身份，不加字幕。'
const finalText = '方案已保存。已观察：商品源图与0、2、3.75秒的抽样画面。推断：可考虑以商品图作主体、原视频作动作参考。未知：完整动作、声音与口型；没有听过音频。后续确认后读取精确V2型号和素材角色再报价，本次没有上传、报价或生成。'
const resources: { ctx: Context; directory: string }[] = []
afterEach(async () => {
  for (const { ctx, directory } of resources.splice(0).reverse()) {
    try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

class VisionAdapter extends MockAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...await super.resolveModel(provider, model), inputModalities: ['text', 'image'] }
  }
}

const plan = { kind: 'video', title: '商品动作迁移复刻',
  brief: '仅分析；默认一条；商品身份保持，不加字幕。已观察源图及0/2/3.75秒抽样帧；动作中段、音频和口型未知。确认后读取精确V2模型schema与角色，使用主体图+原视频动作迁移，不能用抽帧文生视频冒充。',
  assets: [{ id: 'product', name: '商品源图', kind: 'image', role: 'subject', source_path_or_asset_id: 'product.png', description: '保持商品身份' },
    { id: 'reference', name: '爆款对标视频', kind: 'video', role: 'motion-reference', source_path_or_asset_id: 'reference.mp4', description: '动作源；抽样不代表完整动作已核实' }],
  shots: [{ id: 'replica', order: 1, title: '动作迁移方案', duration_seconds: 4,
    prompt: '源图商品身份保持，动作来自原视频，精确角色待V2型号schema核对；音频/口型未知；不加字幕。', asset_ids: ['product', 'reference'] }] }

function analysisScript() {
  return [
    toolCallResponse('reference-skill', 'skill', { name: 'yunshu-reference-replica' }),
    toolCallResponse('reference-inspection', 'inspect_reference_video', { path: 'reference.mp4' }),
    toolCallResponse('product-read', 'read_image', { file_path: 'product.png' }),
    ...[0, 1, 2].map(index => toolCallResponse(`frame-read-${String(index)}`, 'read_image',
      { file_path: `.yunshu-creative/reference-inspections/sample-${String(index)}.jpg` })),
    toolCallResponse('reference-plan', 'update_creation_plan', plan), textResponse(finalText),
  ]
}

const nativeModel = { id: 'synthetic-motion-replica', display_name: 'Synthetic image and video motion transfer',
  kind: 'video', enabled: true, model_version: 'synthetic-motion-schema',
  parameters_schema: { type: 'object', required: ['prompt', 'seconds'], additionalProperties: false,
    properties: { prompt: { type: 'string' }, seconds: { type: 'integer', enum: [4] } } }, conditions: {},
  asset_fields: [{ name: 'subject_image', media_kind: 'image', native_shape: 'single', min_items: 1, max_items: 1,
    mime_types: ['image/png'], constraints: { max_bytes: 1024 * 1024 } },
  { name: 'motion_video', media_kind: 'video', native_shape: 'single', min_items: 1, max_items: 1,
    mime_types: ['video/mp4'], constraints: { max_bytes: 1024 * 1024 } }],
  intents: [{ id: 'reference', label: 'Motion transfer', requires_assets: true }],
  pricing: { display: 'synthetic quote only', quote_required: true } }

async function boot(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'reference-replica-loader-'))), workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const ctx = new Context(), adapter = new VisionAdapter(script)
  resources.push({ ctx, directory })
  // Stable synthetic extraction is the recording boundary; reference-video-inspection.spec exercises real FFmpeg separately.
  const product = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#d13222' } }).png().toBuffer()
  const frame = await sharp(product).jpeg().toBuffer()
  await writeFile(join(workspace, 'product.png'), product)
  await writeFile(join(workspace, 'reference.mp4'), 'synthetic-reference-bytes')
  const preview: VideoEditor = { preflight: async () => { throw new Error('Analysis cannot encode a video') },
    probe: async () => ({ durationSeconds: 4 }), preview: async (_path, outputDirectory) => {
      await mkdir(outputDirectory, { recursive: true })
      const frames = [0, 2, 3.75].map((timeSeconds, index) => ({ path: join(outputDirectory, `sample-${String(index)}.jpg`), timeSeconds }))
      for (const item of frames) await writeFile(item.path, frame)
      return frames
    }, compose: async () => { throw new Error('Analysis cannot compose a video') } }
  const identity = { accountId: 'synthetic-reference-owner', sessionFingerprint: 'synthetic-login' }
  const creative = new CreativeStore({ directory: join(directory, 'plans'), current: async () => identity,
    video: async () => { throw new Error('This reference/V2 scenario has no legacy video project') } })
  let supplierCalls = 0
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = []
  const journalBeforeQuote: unknown[] = []
  let nativeReadFailure = false, submitted = false
  let quote: Record<string, unknown> | undefined
  const task = { id: 'synthetic-original-task', model: nativeModel.id, kind: 'video', status: 'succeeded',
    is_final: true, created_at: 1, updated_at: 2, artifacts: [{ key: 'final', order: 0, type: 'video', mime_type: 'video/mp4',
      content_url: '/v1/tasks/synthetic-original-task/artifacts/final/content' }] }
  const outputBytes = Buffer.from('0000ftypisom synthetic original output')
  const account: MediaV2Account = { owner: `${identity.accountId}:${identity.sessionFingerprint}`, async fetch(path, init) {
    const body = typeof init.body === 'string' ? mediaV2Object(JSON.parse(init.body)) : undefined
    calls.push({ path, method: init.method ?? 'GET', ...body === undefined ? {} : { body } })
    let data: unknown
    if (path.endsWith('/models')) data = { capabilities: { media_generation_v2: true, quote_required: true,
      durable_operation_receipt: true, all_artifacts: true }, models: [nativeModel] }
    else if (path.endsWith('/assets')) {
      const form = await new Request('https://synthetic.invalid/assets', init).formData(), file = form.get('file')
      if (!(file instanceof File)) throw new Error('Expected original synthetic upload')
      const bytes = Buffer.from(await file.arrayBuffer()), image = file.type === 'image/png'
      data = { asset_id: image ? 'ma2-subject' : 'ma2-motion', client_asset_id: form.get('client_asset_id'), model: nativeModel.id,
        state: 'ready', media_kind: image ? 'image' : 'video', mime_type: file.type, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), expires_at: 2000000000 }
    } else if (path.endsWith('/quotes')) {
      if (body === undefined) throw new Error('Expected exact original quote')
      journalBeforeQuote.push(await client.record(account, String(body.client_operation_id)))
      quote = { ...body, quote_id: 'synthetic-original-quote', request_sha256: 'a'.repeat(64), retail_cny: '0.20',
        expires_at: 2000000000, operation_state: 'quoted' }
      data = quote
    } else if (path.endsWith('/tasks') && init.method === 'POST') {
      submitted = true
      throw new Error('Synthetic lost acknowledgement after possible acceptance')
    } else if (path.includes('/operations/')) {
      if (quote === undefined) throw new Error('No original quote')
      data = submitted
        ? { client_operation_id: quote.client_operation_id, quote_id: quote.quote_id, state: 'accepted', task }
        : { client_operation_id: quote.client_operation_id, quote_id: quote.quote_id, state: 'quoted', quote }
    } else if (path.endsWith('/tasks/synthetic-original-task')) data = { task }
    else if (path.endsWith('/artifacts/final/content')) return new Response(outputBytes, { headers: { 'content-type': 'video/mp4' } })
    else throw new Error(`Unexpected synthetic request ${path}`)
    return Response.json({ success: true, data })
  } }
  const client = new MediaV2Client({ baseUrl: 'https://synthetic.invalid', directory: join(directory, 'native-receipts'),
    timeoutMs: 1000, creditsPerYuan: 1000, output: async () => ({ async write(filename, bytes) {
      const path = join(workspace, filename); await writeFile(path, bytes); return { path }
    }, publish: async () => { throw new Error('Not used by this native receipt scenario') } }) })
  const Fixture = { name: 'reference-fixture', inject: ['llm', 'tools'], apply(owner: Context) {
    owner.effect(() => owner.llm.registerAdapter(['fixture'], adapter))
    registerCreationWorkflows(owner)
    registerCreativeTools(owner, creative, async () => identity, async (planOwner, planId) => {
      if (nativeReadFailure) throw new Error('Synthetic local receipt storage unavailable')
      return (await client.records(account)).filter(record => record.origin?.planId === planId
        && record.origin.sessionId === planOwner.sessionId && record.origin.workspaceRoot === planOwner.workspaceRoot)
    })
    registerVideoProjectTools(owner, { stateDirectory: join(directory, 'private'), outputDirectory: 'artifacts',
      maxTotalSeconds: 300, maxSegments: 32, pollIntervalMs: 1000, taskTimeoutMs: 1000, editor: () => preview,
      acquireProvider: async () => { supplierCalls++; throw new Error('Analysis cannot call a supplier') } })
    registerMediaV2Tools(owner, { client, pollIntervalMs: 1, taskTimeoutMs: 1000, capture: async () => account,
      resolvePlan: async (exec, planId, target, accountOwner) => {
        if (accountOwner !== `${identity.accountId}:${identity.sessionFingerprint}`) throw new Error('Unexpected captured account')
        const caller = creativeOwner(exec, identity), saved = await creative.plan(caller, planId)
        if (target.shotIds?.some(id => !saved.shots.some(shot => shot.id === id))
          || target.assetId !== undefined && !saved.assets.some(asset => asset.id === target.assetId)) {
          throw new CreativeError('CREATIVE_SHOT_MISMATCH', 400, '素材或镜头不属于此计划。')
        }
        return { planId, sessionId: caller.sessionId, workspaceRoot: caller.workspaceRoot, ...target }
      },
      readAsset: async (path) => {
        if (!['product.png', 'reference.mp4'].includes(path)) throw new Error('Only the selected synthetic workspace references are authorized')
        return { filename: path, mime: path.endsWith('.png') ? 'image/png' : 'video/mp4', bytes: await readFile(join(workspace, path)) }
      } })
  } }
  const modules = new Map<string, unknown>([
    ['sessions', SessionStore], ['projections', SessionProjections], ['agents', AgentRegistry], ['llm', LlmRuntime],
    ['system-prompt', SystemPrompt], ['tools', Tools], ['agent-loop', AgentLoop], ['skills', Skills],
    ['tool-skill', ToolSkill], ['tool-fs', ToolFs], ['fs', FileSystem], ['attachments', Attachments],
    ['working-directory', WorkingDirectory], ['reference-fixture', Fixture],
    ['jobs', LocalJobs], ['job-tools', JobTools],
  ])
  const config = join(directory, 'cordis.yml')
  await writeFile(config, ['- name: sessions', '- name: projections', '- name: agents', '- name: llm', '- name: system-prompt',
    '- name: tools', '- name: fs', '  config:', `    cwd: '${workspace}'`, '- name: attachments', '  config:',
    `    dshHome: '${join(directory, 'home')}'`, '- name: working-directory', '  config:', `    defaultDirectory: '${workspace}'`,
    '- name: skills', '- name: tool-skill', '- name: tool-fs', '- name: jobs', '- name: job-tools', '  config:',
    '    completionDelivery: quiet', '- name: agent-loop', '  config:', '    agents: []',
    '- name: reference-fixture', '',
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
  const agent = await ctx.agentLoop.create(SessionId('reference-replica-recorded'), { provider: 'fixture', model: 'fixture' }, { cwd: workspace })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: humanText }] }))
  await agent.whenIdle()
  function result(id: string): Record<string, unknown> {
    const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result' && event.data.message.toolCallId === id)
    const text = result?.type === 'tool/result' ? result.data.message.content.find(block => block.type === 'text') : undefined
    if (text?.type !== 'text') throw new Error(`Expected result ${id}`)
    return mediaV2Object(JSON.parse(text.text))
  }
  return { ctx, directory, workspace, agent, adapter, creative, result, calls, client, account, outputBytes, journalBeforeQuote,
    setNativeReadFailure: () => { nativeReadFailure = true },
    supplierCalls: () => supplierCalls }
}
function serializedSession(agent: Agent): string {
  return JSON.stringify(toHeaderLine(agent.session.header)) + '\n' + eventLines(agent.session.snapshotEvents())
}
function recordedSession(raw: string, cwd: string): string {
  const context = { sessionIds: ['reference-replica-recorded'], cwd }
  const headers = parseSessionLog(normalizeSessionLog(raw, context))
    .filter(event => event.type === 'request/header').map(event => event.data.header.tools)
  let cursor = 0
  return normalizeSessionSnapshot(raw, context).split('\n').map((line) => {
    if (line === '') return line
    const row = mediaV2Object(JSON.parse(line))
    if (row.type === 'request/header') mediaV2Object(mediaV2Object(row.data).header).tools = headers[cursor++]
    return JSON.stringify(row)
  }).join('\n')
}
function modelRequestProjection(requests: readonly GenerateOptions[], cwd: string): string {
  const projection = { schema: 1, projection: 'Model-visible requests only; never replay input or a persisted Session generation',
    requests: requests.map((request, index) => ({ request: index + 1,
      header: { provider: request.provider, model: request.model, system: request.system,
        reasoningEffort: request.reasoningEffort, temperature: request.temperature,
        maxTokens: request.maxTokens, stop: request.stop },
      tools: request.tools, messages: request.messages })) }
  const normalized: unknown = JSON.parse(normalizeSessionLog(JSON.stringify(projection), { sessionIds: [], cwd }))
  return JSON.stringify(normalized, null, 2) + '\n'
}

it('independently replays a fresh in-memory analysis and pins its model-visible requests without generation', async () => {
  const captured = await boot(analysisScript()), originalSession = serializedSession(captured.agent)
  const events = parseSessionLog(originalSession)
  const script = deriveReplayScript(events).map((entry) => {
    if (entry.kind !== 'chunks') throw new Error('Expected recorded model chunks')
    return entry.chunks
  })
  const f = await boot(script)
  expect(captured.adapter.requests).toHaveLength(8)
  expect(captured.supplierCalls()).toBe(0)
  expect(captured.calls).toEqual([])
  expect(f.adapter.requests).toHaveLength(8)
  const results = f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(7)
  expect(results.every(event => event.data.message.isError !== true)).toBe(true)
  expect(results.flatMap(event => event.data.message.content.filter(block => block.type === 'image'))).toHaveLength(4)
  const planEvent = results.find(event => event.data.message.toolCallId === 'reference-plan')
  const text = planEvent?.data.message.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('Expected saved plan result')
  const saved = mediaV2Object(JSON.parse(text.text))
  expect(saved.status).toBe('saved')
  if (typeof saved.plan_id !== 'string') throw new Error('Expected an actual plan identity')
  const durable = await f.creative.plan({ accountId: 'synthetic-reference-owner', sessionFingerprint: 'synthetic-login',
    sessionId: f.agent.id, workspaceRoot: f.workspace }, saved.plan_id)
  expect(durable.assets.map(asset => [asset.id, asset.role, asset.sourcePathOrAssetId])).toEqual([
    ['product', 'subject', 'product.png'], ['reference', 'motion-reference', 'reference.mp4'],
  ])
  const record = mediaV2Object(JSON.parse(await readFile(join(f.directory, 'plans', saved.plan_id, 'project.json'), 'utf8')))
  expect(record.operations).toEqual([])
  expect(f.supplierCalls()).toBe(0)
  expect(f.calls).toEqual([])
  expect(await readFile(join(f.workspace, 'reference.mp4'), 'utf8')).toBe('synthetic-reference-bytes')
  const savedSession = serializedSession(f.agent)
  expect(recordedSession(savedSession, f.workspace)).toBe(recordedSession(originalSession, captured.workspace))
  const visible = modelRequestProjection(captured.adapter.requests, captured.workspace)
  expect(modelRequestProjection(f.adapter.requests, f.workspace)).toBe(visible)
  await expect(visible).toMatchFileSnapshot('./expected/reference-replica-model-visible.json')
  const restored = Session.create(SessionId('restored-reference'), parseSessionLog(savedSession))
  expect(restored.deriveMessages().filter(message => message.role === 'tool')).toHaveLength(7)
  expect(f.adapter.requests[1]?.messages.some(message => JSON.stringify(message).includes('只调用query_media_operation查询并保存原client_operation_id'))).toBe(true)
})

it('confirms the retained plan, binds image/video roles and saves the same V2 operation after one lost task acknowledgement', async () => {
  const script: ConstructorParameters<typeof MockAdapter>[0] = analysisScript(), f = await boot(script)
  const planId = f.result('reference-plan').plan_id
  script.push(
    toolCallResponse('original-plan', 'get_creation_plan', { plan_id: planId }),
    toolCallResponse('motion-schema', 'list_media_models_v2', { model: nativeModel.id }),
    toolCallResponse('subject-upload', 'upload_media_asset', { model: nativeModel.id, path: 'product.png', field: 'subject_image' }),
    toolCallResponse('motion-upload', 'upload_media_asset', { model: nativeModel.id, path: 'reference.mp4', field: 'motion_video' }),
    () => toolCallResponse('motion-quote', 'quote_media_operation', { plan_id: planId, shot_ids: ['replica'],
      model: nativeModel.id, model_version: nativeModel.model_version,
      intent: 'reference', parameters: { prompt: plan.shots[0]!.prompt, seconds: 4 }, assets: {
        subject_image: [mediaV2Object(f.result('subject-upload').asset).asset_id],
        motion_video: [mediaV2Object(f.result('motion-upload').asset).asset_id],
      } }),
    toolCallResponse('quoted-plan', 'get_creation_plan', { plan_id: planId }),
    () => toolCallResponse('motion-generate', 'generate_media_operation', { client_operation_id: f.result('motion-quote').client_operation_id }),
    () => toolCallResponse('motion-progress', 'job_output', { job_id: f.result('motion-generate').job_id, wait: true }),
    () => toolCallResponse('motion-recover', 'query_media_operation', { client_operation_id: f.result('motion-quote').client_operation_id }),
    toolCallResponse('delivered-plan', 'get_creation_plan', { plan_id: planId }),
    textResponse('已查询原操作并保存原视频；未另建作品或重复提交。声音与完整动作效果仍需实际验收。'),
  )
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text:
    `确认按原方案生成一条，模型用${nativeModel.id}，4秒，商品图作主体，原视频作动作参考。` }] }))
  await f.agent.whenIdle()
  expect(f.result('original-plan')).toMatchObject({ status: 'succeeded', plan_id: planId })
  expect(f.result('quoted-plan')).toMatchObject({ status: 'succeeded', plan_id: planId, native_operations: [
    { client_operation_id: f.result('motion-quote').client_operation_id, model_version: nativeModel.model_version, shot_ids: ['replica'],
      parameters: { prompt: plan.shots[0]!.prompt, seconds: 4 }, quote: { retail_cny: '0.20', credits: 200 }, paths: [] },
  ] })
  expect(f.result('motion-quote')).toMatchObject({ status: 'quoted', model: nativeModel.id })
  const id = String(f.result('motion-quote').client_operation_id)
  expect(f.result('motion-generate')).toMatchObject({ status: 'background', client_operation_id: id })
  expect(f.result('motion-recover')).toMatchObject({ status: 'succeeded', client_operation_id: id, model: nativeModel.id,
    task: { id: 'synthetic-original-task' } })
  const retained = await f.client.query(f.account, id, new AbortController().signal)
  expect(retained?.request.assets).toEqual({ subject_image: ['ma2-subject'], motion_video: ['ma2-motion'] })
  expect(retained?.saved).toHaveLength(1)
  if (retained?.saved?.[0] === undefined) throw new Error('Expected saved original output')
  expect((await readFile(retained.saved[0].path)).equals(f.outputBytes)).toBe(true)
  expect(f.calls.filter(call => call.path.endsWith('/assets') && call.method === 'POST')).toHaveLength(2)
  expect(f.calls.filter(call => call.path.endsWith('/quotes') && call.method === 'POST')).toHaveLength(1)
  expect(f.calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(1)
  expect(f.calls.filter(call => call.path.includes('/operations/')).every(call => call.path.endsWith(id) && call.method === 'GET')).toBe(true)
  const originalBytes = await readFile(join(f.directory, 'plans', String(planId), 'project.json'), 'utf8')
  const original = mediaV2Object(JSON.parse(originalBytes))
  expect(original.brief).toBe(plan.brief)
  expect(original.brief).not.toContain(id)
  expect(f.journalBeforeQuote).toMatchObject([{ origin: { planId, shotIds: ['replica'],
    sessionId: f.agent.id, workspaceRoot: f.workspace }, request: { client_operation_id: id } }])
  const actualQuote = f.calls.find(call => call.path.endsWith('/quotes'))?.body
  expect(actualQuote).not.toHaveProperty('origin'); expect(actualQuote).not.toHaveProperty('plan_id')
  expect(actualQuote).not.toHaveProperty('shot_ids')
  expect(f.result('delivered-plan')).toMatchObject({ native_operations: [{ client_operation_id: id,
    task: { id: 'synthetic-original-task', status: 'succeeded', complete: true }, paths: [retained.saved[0].path] }] })
  const restarted = new MediaV2Client({ baseUrl: 'https://synthetic.invalid', directory: join(f.directory, 'native-receipts'),
    timeoutMs: 1000, creditsPerYuan: 1000 })
  expect((await restarted.records({ owner: f.account.owner }))[0]).toMatchObject({
    origin: { planId, shotIds: ['replica'], sessionId: f.agent.id, workspaceRoot: f.workspace },
    request: { client_operation_id: id }, saved: [{ path: retained.saved[0].path }],
  })
  script.push(
    () => toolCallResponse('new-work-quote', 'quote_media_operation', { plan_id: planId, shot_ids: ['replica'],
      model: nativeModel.id, model_version: nativeModel.model_version, intent: 'reference',
      parameters: { prompt: plan.shots[0]!.prompt, seconds: 4 }, assets: retained.request.assets }),
    toolCallResponse('both-plan-works', 'get_creation_plan', { plan_id: planId }),
    textResponse('同一计划的新作品已单独报价，原任务和产物仍保留；本次没有提交第二次生成。'),
  )
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '按同一方案另外做一条独立作品，先报价。' }] }))
  await f.agent.whenIdle()
  const second = f.result('new-work-quote').client_operation_id
  expect(second).not.toBe(id)
  expect(mediaV2Object(f.result('both-plan-works')).native_operations).toHaveLength(2)
  expect(mediaV2Object(f.result('both-plan-works')).native_operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ client_operation_id: second, state: 'quoted', paths: [] }),
    expect.objectContaining({ client_operation_id: id, paths: [retained.saved[0].path] }),
  ]))
  expect(f.calls.filter(call => call.path.endsWith('/quotes') && call.method === 'POST')).toHaveLength(2)
  expect(f.calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(1)
  f.setNativeReadFailure()
  script.push(toolCallResponse('receipt-read-unavailable', 'get_creation_plan', { plan_id: planId }), textResponse('计划保留，原回执读取失败只查原编号。'))
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '读取原计划状态。' }] }))
  await f.agent.whenIdle()
  expect(f.result('receipt-read-unavailable')).toMatchObject({ status: 'succeeded', plan_id: planId,
    native_operations_unavailable: true, plan: { brief: plan.brief } })
  expect(f.result('receipt-read-unavailable')).not.toHaveProperty('native_operations')
  expect(f.calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(1)
  expect(await readFile(join(f.directory, 'plans', String(planId), 'project.json'), 'utf8')).toBe(originalBytes)
  expect(original.shots).toHaveLength(1)
  expect(f.supplierCalls()).toBe(0)
})
