import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

it('runs the real model-tool/job registry, sends once, and job_output returns every saved original', async () => {
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
  const request = { client_operation_id: id, model: 'image-layers', model_version: 'schema', intent: 'text',
    parameters: { prompt: '原创分层图' }, assets: {} }
  const quote = { ...request, quote_id: 'quote-original', request_sha256: 'a'.repeat(64), retail_cny: '0.3',
    expires_at: Math.floor(Date.now() / 1000) + 600, operation_state: 'quoted' }
  const task = { id: 'task-original', model: request.model, kind: 'image', status: 'succeeded', is_final: true,
    created_at: 1, updated_at: 2, artifacts: ['one', 'two'].map((key, order) => ({ key, order, type: 'image',
      mime_type: 'image/gif', content_url: `/v1/tasks/task-original/artifacts/${key}/content` })) }
  let submissions = 0
  const account = { owner: 'synthetic-no-credential', fetch: async (path: string, init: RequestInit): Promise<Response> => {
    let data: unknown
    if (path.endsWith('/models')) data = { capabilities: { media_generation_v2: true, quote_required: true, durable_operation_receipt: true, all_artifacts: true }, models: [{ id: request.model, display_name: 'Layer image', kind: 'image', model_version: 'schema', enabled: true, parameters_schema: { properties: { prompt: { type: 'string' } } }, asset_fields: [], intents: [{ id: 'text', label: 'Text', requires_assets: false }], pricing: { display: 'quote required', quote_required: true } }] }
    else if (path.endsWith('/quotes')) data = quote
    else if (path.endsWith('/tasks')) { submissions += 1; data = { task, replayed: false } }
    else if (path.includes('/operations/')) data = { client_operation_id: id, quote_id: quote.quote_id, state: 'accepted', task }
    else if (path.endsWith('/tasks/task-original')) data = { task }
    else if (path.endsWith('/content')) return new Response('GIF89a original', { headers: { 'content-type': 'image/gif' } })
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
        readAsset: async () => { throw new Error('Unused') } })
    })
  })
  await client.quote(account, request, new AbortController().signal)
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
  const first = mediaV2Object(JSON.parse(await call('generate_media_operation', { client_operation_id: id })))
  expect(first.status).toBe('background')
  const job = JobId(String(first.job_id))
  expect((await ctx.jobs.wait(job, 2000, agent.id)).status).toBe('completed')
  const output = await call('job_output', { job_id: job })
  expect(output).toMatch(/one-成图-01-[a-f0-9-]{36}\.gif/u)
  expect(output).toMatch(/two-成图-02-[a-f0-9-]{36}\.gif/u)
  await call('generate_media_operation', { client_operation_id: id })
  await Promise.all(ctx.jobs.list(agent.id).map(view => ctx.jobs.wait(view.id, 2000, agent.id)))
  expect(submissions).toBe(1)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const notice = mediaV2Object(JSON.parse(await call('generate_media_operation', { client_operation_id: id }, 2)))
  expect(notice.code).toBe('invalid_request')
  expect(submissions).toBe(1)
})
