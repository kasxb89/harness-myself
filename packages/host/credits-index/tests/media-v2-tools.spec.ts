import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { MediaV2Client } from '../src/media-v2-client.ts'
import { mediaV2Object } from '../src/media-v2-protocol.ts'
import { registerMediaV2Tools } from '../src/media-v2-tools.ts'
import { registerVideoGenerationIntent } from '../src/video-generation-intent.ts'

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
