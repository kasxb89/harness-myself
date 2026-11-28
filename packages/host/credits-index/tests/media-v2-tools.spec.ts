import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { MediaV2Client, MediaV2Error } from '../src/media-v2-client.ts'
import { mediaV2Object } from '../src/media-v2-protocol.ts'
import { registerMediaV2Tools } from '../src/media-v2-tools.ts'
import { registerVideoGenerationIntent } from '../src/video-generation-intent.ts'
import { mediaRequestSelectionProjection } from '../src/media-request-selection.ts'
import type { MediaRequestSelection } from '../src/media-preferences-types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it.each(['legacy', 'native-batch', 'missing-task-batch'] as const)('runs the real model-tool/job registry with %s and sends once', async (variant) => {
  const batchEnabled = variant !== 'legacy', missingTaskBatch = variant === 'missing-task-batch'
  const directory = await mkdtemp(join(tmpdir(), 'media-v2-tools-'))
  const ctx = new Context()
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs)
  const session = Session.create(SessionId('native-media-owner'))
  const agent: Agent = { id: session.id, ctx, session, options: {}, status: 'running',
    inbox: { nextTurn: [], nextStep: [], clear: vi.fn(), append: vi.fn(), prepend: vi.fn(),
      replace: () => false, remove: () => false, splice: () => [] },
    send: vi.fn(), steer: vi.fn(), followup: vi.fn(), inject: vi.fn(), cancel: vi.fn(), whenIdle: async () => {},
    runMaintenance: async work => await work(new AbortController().signal) }
  await ctx.agents.register(agent)
  const id = '92908b6b-6de4-4652-9b72-00d58376a722'
  const batch = { schema_version: 1, requested_output_count: 2, expected_main_output_count: 2, output_duration_seconds: 5,
    total_output_seconds: 10, meter: 'total_output_seconds', admission_unit: 'native_operation', admission_weight: 1,
    partial_policy: 'retain_reservation_until_complete', policy_revision: 'd'.repeat(64) }
  const request = { client_operation_id: id, model: batchEnabled ? 'video-native-batch' : 'image-layers', model_version: 'schema', intent: 'text',
    parameters: { prompt: '原创分层图', controls: { layers: [{ name: 'front', mask: null }] }, ...batchEnabled ? { count: 2, duration: 5 } : {} }, assets: {} }
  const quote = { ...request, quote_id: 'quote-original', request_sha256: 'a'.repeat(64), retail_cny: '0.3',
    expires_at: Math.floor(Date.now() / 1000) + 600, operation_state: 'quoted', ...batchEnabled ? { batch } : {} }
  const task = { id: 'task-original', model: request.model, kind: batchEnabled ? 'video' : 'image', status: 'succeeded', is_final: true,
    ...batchEnabled && !missingTaskBatch ? { batch: { ...batch, received_main_output_count: 2, completeness: 'complete' } } : {},
    created_at: 1, updated_at: 2, artifacts: ['one', 'two'].map((key, order) => ({ key, order, type: batchEnabled ? 'video' : 'image',
      ...batchEnabled ? { role: 'main', output_id: `main-${order + 1}`, output_index: order } : {},
      mime_type: batchEnabled ? 'video/mp4' : 'image/gif', content_url: `/v1/tasks/task-original/artifacts/${key}/content` })) }
  const recursiveSchema = { type: 'object', properties: { prompt: { type: 'string' }, controls: { type: 'object',
    properties: { layers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, mask: { type: 'null' } } } } } } } }
  const audioModel = { id: 'synthetic-audio', display_name: 'Synthetic audio compatibility', kind: 'audio', model_version: 'audio-schema',
    enabled: true, parameters_schema: recursiveSchema, parameter_conditions: { schema_version: 999, '$future-rule': true }, conditions: { control: { when: { mode: ['custom'] }, required: ['lyrics'] } },
    asset_fields: [], intents: [{ id: 'text', label: 'Text', requires_assets: false }], pricing: { display: 'quote required', quote_required: true } }
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 7]), uploadId = '81fb485c-9f4c-490c-a9d7-dced6974d04e'
  const asset = { asset_id: 'ma2-original-image', client_asset_id: uploadId, model: request.model, state: 'ready', media_kind: 'image',
    mime_type: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), expires_at: 2000000000 }
  let submissions = 0, assetReads = 0, uploads = 0
  const account = { owner: 'synthetic-no-credential', fetch: async (path: string, init: RequestInit): Promise<Response> => {
    let data: unknown
    if (path.endsWith('/models')) data = { capabilities: { media_generation_v2: true, quote_required: true, durable_operation_receipt: true, all_artifacts: true, parameter_conditions_v1: true, native_video_batch_v1: true }, models: [{ id: request.model, display_name: 'Layer image', kind: batchEnabled ? 'video' : 'image', model_version: 'schema', enabled: true, parameters_schema: recursiveSchema,
      asset_fields: [{ name: 'images', media_kind: 'image', native_shape: 'multiple', min_items: 0, max_items: 2, mime_types: ['image/png'], constraints: { max_bytes: 5 * 1024 * 1024 } }],
      intents: [{ id: 'text', label: 'Text', requires_assets: false }], pricing: { display: 'quote required', quote_required: true } }, audioModel] }
    else if (path.endsWith('/quotes')) {
      if (typeof init.body !== 'string') throw new Error('Missing original quote JSON')
      expect(JSON.parse(init.body)).toEqual(request); data = quote
    }
    else if (path.endsWith('/assets')) {
      uploads += 1
      const form = await new Request('https://synthetic.invalid/assets', init).formData()
      const file = form.get('file')
      if (!(file instanceof File)) throw new Error('Missing original uploaded file')
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes)
      const receivedId = form.get('client_asset_id')
      if (typeof receivedId !== 'string') throw new Error('Missing original upload identity')
      asset.client_asset_id = receivedId; data = asset
    }
    else if (path.includes('/assets/by-client-id/')) data = asset
    else if (path.endsWith('/tasks')) { submissions += 1; data = { task, replayed: false } }
    else if (path.includes('/operations/')) data = { client_operation_id: id, quote_id: quote.quote_id, state: 'accepted', task }
    else if (path.endsWith('/tasks/task-original')) data = { task }
    else if (path.endsWith('/content')) return new Response(batchEnabled
      ? Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0]) : 'GIF89a original',
    { headers: { 'content-type': batchEnabled ? 'video/mp4' : 'image/gif' } })
    else throw new Error(`Unexpected route ${path} ${init.method}`)
    return new Response(JSON.stringify({ success: true, data }))
  } }
  const client = new MediaV2Client({ baseUrl: 'http://synthetic.invalid', directory, timeoutMs: 1000, creditsPerYuan: 1000,
    output: async () => ({ write: async (filename, bytes) => {
      const path = join(directory, filename); await writeFile(path, bytes); return { path }
    }, publish: async () => { throw new Error('Unused') } }) })
  await ctx.plugin((scope: Context) => {
    registerVideoGenerationIntent(scope)
    scope.inject(['tools', 'jobs'], (owner) => {
      registerMediaV2Tools(owner, { client, pollIntervalMs: 1, taskTimeoutMs: 2000, capture: async () => account,
        readAsset: async (_path, _exec, maximum) => {
          assetReads += 1; expect(maximum).toBe(5 * 1024 * 1024)
          return { filename: 'source.png', mime: 'image/png', bytes }
        } })
    })
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: '按已选模型生成分层图片' }] }), { surfaceOp: 'append' })
  let calls = 0
  const call = async (name: string, args: Record<string, unknown>, turn = 1) => {
    const callId = ToolCallId(`media-runtime-${String(++calls)}`)
    session.append('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) })
    const result = await ctx.tools.execute({ name, arguments: args, callId, agent, signal: new AbortController().signal })
    return result.content.filter(part => part.type === 'text').map(part => part.text).join('')
  }
  const summary = mediaV2Object(JSON.parse(await call('list_media_models_v2', {})))
  expect(summary.details_included).toBe(false)
  expect(JSON.stringify(summary)).not.toContain('parameters_schema')
  const details = mediaV2Object(JSON.parse(await call('list_media_models_v2', { model: request.model })))
  expect(details.details_included).toBe(true)
  expect(JSON.stringify(details)).toContain('parameters_schema')
  expect(mediaV2Object(details.models instanceof Array ? details.models[0] : {}).parameters_schema).toEqual(recursiveSchema)
  const audio = mediaV2Object(JSON.parse(await call('list_media_models_v2', { kind: 'audio', model: audioModel.id })))
  expect(audio.models).toEqual([{ ...audioModel, pricing: { ...audioModel.pricing, credits_per_yuan: 1000 } }])
  expect(mediaV2Object(JSON.parse(await call('quote_media_operation', request))).quote).toMatchObject({ parameters: request.parameters })
  const uploaded = mediaV2Object(JSON.parse(await call('upload_media_asset', { model: request.model, path: 'source.png', field: 'images' })))
  // Read the stable Host-assigned upload identity from the actual result, rather than inventing another attempt.
  const actualAsset = mediaV2Object(uploaded.asset)
  expect(actualAsset.asset_id).toBe(asset.asset_id)
  await call('upload_media_asset', { model: request.model, path: 'source.png', client_asset_id: actualAsset.client_asset_id })
  expect(assetReads).toBe(1); expect(uploads).toBe(1)
  const first = mediaV2Object(JSON.parse(await call('generate_media_operation', { client_operation_id: id })))
  expect(first.status).toBe('background')
  const job = JobId(String(first.job_id))
  expect((await ctx.jobs.wait(job, 2000, agent.id)).status).toBe(missingTaskBatch ? 'failed' : 'completed')
  const output = await call('job_output', { job_id: job })
  if (missingTaskBatch) {
    const recovered = mediaV2Object(JSON.parse(await call('query_media_operation', { client_operation_id: id })))
    expect(recovered.status).toBe('unconfirmed')
    expect(recovered.paths).toBeUndefined()
    expect(mediaV2Object(recovered.task).id).toBe(task.id)
    expect(mediaV2Object(recovered.task).artifacts).toHaveLength(2)
  } else {
    expect(output).toMatch(batchEnabled ? /one-视频-01-[a-f0-9-]{36}\.mp4/u : /one-成图-01-[a-f0-9-]{36}\.gif/u)
    expect(output).toMatch(batchEnabled ? /two-视频-02-[a-f0-9-]{36}\.mp4/u : /two-成图-02-[a-f0-9-]{36}\.gif/u)
    if (batchEnabled) expect(output).toContain('requested_output_count')
  }
  await call('generate_media_operation', { client_operation_id: id })
  await Promise.all(ctx.jobs.list(agent.id).map(view => ctx.jobs.wait(view.id, 2000, agent.id)))
  expect(submissions).toBe(1)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const notice = mediaV2Object(JSON.parse(await call('generate_media_operation', { client_operation_id: id }, 2)))
  expect(notice.code).toBe('invalid_request')
  expect(submissions).toBe(1)
})


async function planToolFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'media-v2-plan-tools-')), ctx = new Context()
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry); await ctx.plugin(LocalJobRegistry); await ctx.plugin(ToolJobs)
  const makeAgent = async (name: string) => {
    const id = SessionId(name), session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0,
      isSeeded: false, cwd: directory })
    const agent: Agent = { id, ctx, session, options: {}, status: 'running',
      inbox: { nextTurn: [], nextStep: [], clear: vi.fn(), append: vi.fn(), prepend: vi.fn(),
        replace: () => false, remove: () => false, splice: () => [] },
      send: vi.fn(), steer: vi.fn(), followup: vi.fn(), inject: vi.fn(), cancel: vi.fn(), whenIdle: async () => {},
      runMaintenance: async work => await work(new AbortController().signal) }
    await ctx.agents.register(agent)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: '按计划完成两份独立作品' }] }), { surfaceOp: 'append' })
    return agent
  }
  const agent = await makeAgent('original-plan-chat'), otherAgent = await makeAgent('other-plan-chat')
  const requests = new Map<string, Record<string, unknown>>(), calls: { method: string; path: string; body?: unknown }[] = []
  let currentOwner = 'original-account', allowPlan = true, loseSubmit = false, turn = 1
  const account = { owner: currentOwner, fetch: async (path: string, init: RequestInit) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method ?? 'GET', path, ...body === undefined ? {} : { body } })
    const makeQuote = (request: Record<string, unknown>) => ({ ...request, quote_id: 'quote-' + String(request.client_operation_id),
      request_sha256: 'a'.repeat(64), retail_cny: '0.30', expires_at: Math.floor(Date.now() / 1000) + 600, operation_state: 'quoted' })
    const makeTask = (id: string) => ({ id: 'task-' + id, model: 'model-original', kind: 'image', status: 'succeeded', is_final: true,
      created_at: 1, updated_at: 2, artifacts: ['first', 'second'].map((key, order) => ({ key, order, type: 'image', mime_type: 'image/gif', content_url: `/v1/tasks/task-${id}/artifacts/${key}/content` })) })
    let data: unknown
    if (path.endsWith('/models')) data = { capabilities: { media_generation_v2: true, quote_required: true,
      durable_operation_receipt: true, all_artifacts: true }, models: [] }
    else if (path.endsWith('/quotes')) {
      const request = mediaV2Object(body); requests.set(String(request.client_operation_id), request); data = makeQuote(request)
    } else if (path.endsWith('/tasks')) {
      if (loseSubmit) { loseSubmit = false; throw new Error('Lost reply after original acceptance') }
      data = { task: makeTask(String(mediaV2Object(body).client_operation_id)), replayed: false }
    }
    else if (path.includes('/operations/')) {
      const id = path.split('/').at(-1)!, request = requests.get(id)
      if (request === undefined) throw new Error('Missing original request')
      data = { client_operation_id: id, quote_id: 'quote-' + id, state: 'accepted', task: makeTask(id) }
    } else if (path.includes('/artifacts/')) return new Response('GIF89a exact synthetic original', { headers: { 'content-type': 'image/gif' } })
    else if (path.includes('/tasks/task-')) data = { task: makeTask(path.split('/').at(-1)!.slice(5)) }
    else throw new Error('Unexpected synthetic path ' + path)
    return new Response(JSON.stringify({ success: true, data }))
  } }
  const client = new MediaV2Client({ baseUrl: 'http://synthetic.invalid', directory, timeoutMs: 1000, creditsPerYuan: 1000,
    output: async () => ({ write: async (filename, bytes) => {
      const path = join(directory, filename); await writeFile(path, bytes); return { path }
    },
    publish: async () => { throw new Error('Unused') } }) })
  await ctx.plugin((scope: Context) => {
    registerVideoGenerationIntent(scope)
    scope.inject(['tools', 'jobs'], (owner) => { registerMediaV2Tools(owner, { client, pollIntervalMs: 1, taskTimeoutMs: 2000,
      capture: async () => ({ ...account, owner: currentOwner }), readAsset: async () => { throw new Error('No upload permitted') },
      resolvePlan: async (exec, planId, target, accountOwner) => {
        if (!allowPlan || accountOwner !== currentOwner || exec.agent?.id !== agent.id || planId !== 'plan-original'
          || target.shotIds?.some(id => !['shot-1', 'shot-2'].includes(id)) || target.assetId !== undefined && target.assetId !== 'asset-1') {
          throw new MediaV2Error('plan_access_denied', 'Cannot use this plan in the current scope', 403)
        }
        return { planId, sessionId: agent.id, workspaceRoot: directory, ...target }
      } }) })
  })
  let callCount = 0
  const call = async (name: string, args: Record<string, unknown>, caller = agent) => {
    const callId = ToolCallId('plan-call-' + String(++callCount))
    caller.session.append('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) })
    const response = await ctx.tools.execute({ name, arguments: args, callId, agent: caller, signal: new AbortController().signal })
    return mediaV2Object(JSON.parse(response.content.filter(part => part.type === 'text').map(part => part.text).join('')))
  }
  const input = { model: 'model-original', model_version: 'v1', intent: 'text', parameters: { prompt: 'Original exact plan work' }, assets: {} }
  return { ctx, agent, otherAgent, directory, calls, client, account, input, call,
    denyPlan: () => { allowPlan = false }, changeAccount: () => { currentOwner = 'changed-account' },
    workspaceAgent: (): Agent => ({ ...agent, session: Session.create(agent.id, agent.session.snapshotEvents(),
      { ...agent.session.header, cwd: join(directory, 'another-workspace') }) }),
    loseNextSubmit: () => { loseSubmit = true },
    nextHuman: () => {
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } }); turn += 1
      agent.session.append('turn/start', { turn })
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: '在同一个计划中再制作一份新的独立作品' }] }), { surfaceOp: 'append' })
    } }
}

it.each([1, 999])('carries selection constraints through exact tool details without schema rewriting: v%s', async (version) => {
  const f = await planToolFixture()
  const selection = version === 1 ? { schema_version: version,
    combinations: [{ parameters: { quality: { allowed_values: ['standard'] } }, required_parameters: ['quality'] }] }
    : { schema_version: version, '$future-selection': { preserve: [true, 'native', null] } }
  const model = { id: 'selection-model', kind: 'image', display_name: 'Selection metadata', model_version: 'selection-version',
    enabled: true, parameters_schema: { type: 'object', properties: { quality: { type: 'string', enum: ['standard', 'high'] } } },
    asset_fields: [], intents: [{ id: 'text', label: 'Text', requires_assets: false }],
    selection_constraints: selection, pricing: { display: 'Quote required', credits_per_yuan: 1250, quote_required: true } }
  const fetch = vi.spyOn(f.account, 'fetch').mockImplementation(async (path, init) => {
    expect(path).toBe('/v1/media-v2/models'); expect(init.method).toBe('GET')
    return Response.json({ success: true, data: { credits_per_yuan: 1250, capabilities: {
      media_generation_v2: true, quote_required: true, durable_operation_receipt: true,
      all_artifacts: true, selection_constraints_v1: true }, models: [model] } })
  })
  const listed = await f.call('list_media_models_v2', { model: model.id })
  expect(listed.status).toBe('listed'); expect(listed.details_included).toBe(true)
  expect(listed.models).toEqual([model])
  expect(listed.capabilities).toMatchObject({ selection_constraints_v1: true })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await f.client.records(f.account)).toEqual([])
})

it('binds separate shot operations and returns the original plan and every saved output without a retry', async () => {
  const f = await planToolFixture()
  const one = await f.call('quote_media_operation', { ...f.input, plan_id: 'plan-original', shot_ids: ['shot-1'] })
  const two = await f.call('quote_media_operation', { ...f.input, plan_id: 'plan-original', shot_ids: ['shot-2'] })
  expect(one.origin).toEqual({ planId: 'plan-original', sessionId: f.agent.id, workspaceRoot: f.directory, shotIds: ['shot-1'] })
  expect(two.client_operation_id).not.toBe(one.client_operation_id)
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(2)
  const same = await f.call('quote_media_operation', { ...f.input, plan_id: 'plan-original', shot_ids: ['shot-1'] })
  expect(same.client_operation_id).toBe(one.client_operation_id)
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(2)
  const recovered = await f.call('query_media_operation', { client_operation_id: one.client_operation_id })
  expect(recovered.origin).toEqual(one.origin)
  expect(recovered.paths).toHaveLength(2)
  const retained = (await f.client.records({ owner: f.account.owner }))
    .find(item => item.request.client_operation_id === one.client_operation_id)
  expect(retained?.saved).toHaveLength(2)
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(2)
  expect(JSON.stringify(f.calls)).not.toContain('plan_id')
  expect(JSON.stringify(f.calls)).not.toContain('planId')
})

it.each([{ shot_ids: ['shot-1'] }, { plan_id: 'plan-original', shot_ids: [], asset_id: 'asset-1' },
  { plan_id: 'plan-original', shot_ids: ['shot-1', 'shot-1'] }, { plan_id: 'plan-original', shot_ids: ['missing-shot'] },
  { plan_id: 'missing-plan', asset_id: 'asset-1' }])('rejects invalid or unowned target before a quote POST: %j', async (target) => {
  const f = await planToolFixture()
  const result = await f.call('quote_media_operation', { ...f.input, ...target })
  expect(result.status).toBe('unconfirmed')
  expect(f.calls).toEqual([])
  expect(await f.client.records(f.account)).toEqual([])
})

it.each(['chat', 'account', 'workspace'] as const)('prevents a linked query and generation from changed %s scope before any I/O', async (scope) => {
  const f = await planToolFixture()
  const original = await f.call('quote_media_operation', { ...f.input, plan_id: 'plan-original', asset_id: 'asset-1' })
  if (scope === 'account') f.changeAccount()
  const before = f.calls.length, caller = scope === 'chat' ? f.otherAgent : scope === 'workspace' ? f.workspaceAgent() : f.agent
  for (const name of ['generate_media_operation', 'query_media_operation']) {
    const rejected = await f.call(name, { client_operation_id: original.client_operation_id }, caller)
    expect(rejected.status).toBe('unconfirmed')
  }
  expect(f.calls).toHaveLength(before)
  expect((await f.client.records(f.account))[0]?.origin).toEqual(original.origin)
})


it('retains plan-level ownership while distinct work keys and later human requests remain independent', async () => {
  const f = await planToolFixture(), target = { plan_id: 'plan-original' }
  const first = await f.call('quote_media_operation', { ...f.input, ...target })
  const second = await f.call('quote_media_operation', { ...f.input, ...target, work_key: 'separate-original-work' })
  f.nextHuman()
  const third = await f.call('quote_media_operation', { ...f.input, ...target })
  expect(new Set([first.client_operation_id, second.client_operation_id, third.client_operation_id]).size).toBe(3)
  expect([first, second, third].map(row => row.origin)).toEqual(Array.from({ length: 3 }, () => ({
    planId: 'plan-original', sessionId: f.agent.id, workspaceRoot: f.directory,
  })))
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(3)
})

it('keeps an explicit tool price reconfirmation local and requires the original operation ID', async () => {
  const f = await planToolFixture(), quote = vi.spyOn(f.client, 'quote')
  const refused = await f.call('quote_media_operation', { ...f.input, reconfirm_price: true })
  expect(refused.status).toBe('unconfirmed'); expect(quote).not.toHaveBeenCalled(); expect(f.calls).toEqual([])
  const first = await f.call('quote_media_operation', f.input)
  const second = await f.call('quote_media_operation', { ...f.input, client_operation_id: first.client_operation_id, reconfirm_price: true })
  expect(second.client_operation_id).toBe(first.client_operation_id)
  expect(quote.mock.calls.at(-1)?.[4]).toEqual({ reconfirmPrice: true })
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  expect(JSON.stringify(f.calls)).not.toContain('reconfirm_price')
})

it('validates the bound asset before one background submit and retains all saved paths for original queries', async () => {
  const f = await planToolFixture()
  const quoted = await f.call('quote_media_operation', { ...f.input, plan_id: 'plan-original', asset_id: 'asset-1' })
  const started = await f.call('generate_media_operation', { client_operation_id: quoted.client_operation_id })
  expect(started, JSON.stringify(started)).toMatchObject({ status: 'background' })
  expect(started.origin).toEqual(quoted.origin)
  const completed = await f.ctx.jobs.wait(JobId(String(started.job_id)), 2000, f.agent.id)
  expect(completed.status).toBe('completed')
  const actual = mediaV2Object(JSON.parse(f.ctx.jobs.read(JobId(String(started.job_id)), f.agent.id).result ?? '{}'))
  expect(actual.origin).toEqual(quoted.origin)
  expect(actual.paths).toHaveLength(2)
  const recovered = await f.call('query_media_operation', { client_operation_id: quoted.client_operation_id })
  expect(recovered.paths).toEqual(actual.paths)
  expect(f.calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(1)
})


it.each(['selected', 'unavailable'] as const)('returns only safe %s personal media choices from the exact real-human session projection', async (state) => {
  const f = await planToolFixture()
  await f.ctx.plugin((scope: Context) => {
    scope.inject(['sessionProjections'], (owner) => { owner.effect(() => owner.sessionProjections.register(mediaRequestSelectionProjection)) })
  })
  const legacy = await f.call('list_media_models_v2', {})
  expect(legacy.chat_preferences).toBeUndefined()
  const requestId = brandString<SessionRequestId>('preferences-original-rpc')
  const snapshot: MediaRequestSelection = state === 'selected'
    ? { schema_version: 1, requestId, state, scope: 'private-scope-not-for-model', revision: 'private-revision-not-for-model',
      image: { model: 'image-user-selected', parameters: { size: '16:9', quality: 'high', seed: 7 } },
      video: { model: 'MiniMax-H3', parameters: { resolution: '768P', seconds: 15, audio: false } } }
    : { schema_version: 1, requestId, state, code: 'ACCOUNT_CHANGED' }
  f.agent.session.append('media/request-selection', snapshot)
  f.agent.session.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: requestId },
    content: [{ type: 'text', text: '保留我的偏好，先查看可用型号，不要生成' }] }), { surfaceOp: 'append' })
  const listed = await f.call('list_media_models_v2', {})
  expect(listed.chat_preferences).toEqual(snapshot.state === 'selected'
    ? { state: 'selected', image: snapshot.image, video: snapshot.video } : { state: 'unavailable', code: snapshot.code })
  expect(JSON.stringify(listed)).not.toContain('private-scope-not-for-model')
  expect(JSON.stringify(listed)).not.toContain('private-revision-not-for-model')
  expect(JSON.stringify(listed.chat_preferences)).not.toContain('requestId')
  expect(f.calls.map(call => [call.method, call.path])).toEqual([['GET', '/v1/media-v2/models'], ['GET', '/v1/media-v2/models']])
})


it('recovers accepted and unknown original outputs after a plan target is removed, while a new paid submission stays blocked', async () => {
  const fresh = await planToolFixture()
  const quoted = await fresh.call('quote_media_operation', { ...fresh.input, plan_id: 'plan-original', shot_ids: ['shot-1'] })
  fresh.denyPlan()
  expect((await fresh.call('generate_media_operation', { client_operation_id: quoted.client_operation_id })).status).toBe('unconfirmed')
  expect(fresh.calls.some(call => call.path.endsWith('/tasks') && call.method === 'POST')).toBe(false)
  for (const state of ['accepted', 'unknown'] as const) {
    const f = await planToolFixture()
    const original = await f.call('quote_media_operation', { ...f.input, plan_id: 'plan-original', shot_ids: ['shot-1'] })
    const id = String(original.client_operation_id)
    if (state === 'unknown') {
      f.loseNextSubmit()
      await expect(f.client.submit(f.account, id, new AbortController().signal)).rejects.toThrow('Lost reply')
    } else await f.client.submit(f.account, id, new AbortController().signal)
    expect((await f.client.record(f.account, id)).state).toBe(state)
    f.denyPlan()
    const recovered = await f.call('query_media_operation', { client_operation_id: id })
    expect(recovered.status).toBe('succeeded')
    expect(recovered.origin).toEqual(original.origin)
    expect(recovered.paths).toHaveLength(2)
    const background = await f.call('generate_media_operation', { client_operation_id: id })
    expect(background.status).toBe('background')
    const jobId = JobId(String(background.job_id))
    expect((await f.ctx.jobs.wait(jobId, 2000, f.agent.id)).status).toBe('completed')
    expect(mediaV2Object(JSON.parse(f.ctx.jobs.read(jobId, f.agent.id).result ?? '{}')).paths).toEqual(recovered.paths)
    expect(f.calls.filter(call => call.path.endsWith('/tasks') && call.method === 'POST')).toHaveLength(1)
    expect(f.calls.filter(call => call.path.endsWith('/quotes') && call.method === 'POST')).toHaveLength(1)
    expect((await f.client.record(f.account, id)).origin).toEqual(original.origin)
  }
})
