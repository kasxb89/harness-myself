import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import LocalFS from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { CreativeStore } from '../src/creative-store.ts'
import { readVideoProject } from '../src/video-project.ts'
import { registerVideoProjectTools } from '../src/video-project-tools.ts'
import { registerVideoGenerationIntent } from '../src/video-generation-intent.ts'
import { VideoWorkStore } from '../src/video-work-store.ts'
import { h3SubmissionQueryRejection, h3SubmissionRejection } from '../src/video-submission-result.ts'
import { createVideoProjectDispatch } from '../src/video-project-dispatch.ts'
import type { VideoProjectOptions, VideoProjectProvider } from '../src/video-project-types.ts'

const resources: { ctx: Context; directory: string }[] = []
afterEach(async () => {
  for (const { ctx, directory } of resources.splice(0).reverse()) {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
})

/** Boot actual orchestration; only the model and external video/editing services are scripted. */
async function boot(transport: 'direct' | 'queue' | 'queue-dispatched') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-recharge-original-work-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const ctx = new Context()
  resources.push({ ctx, directory })
  const script: StreamChunk[][] = [toolCallResponse('start', 'generate_video_project', {
    prompt: '海边日落', total_duration_seconds: 5,
  })]
  const adapter = new MockAdapter(script)
  let funded = false
  const attempts: string[] = []
  const provider: VideoProjectProvider = {
    identity: { accountId: '7', sessionFingerprint: 'original-login' },
    assertCurrent: async () => {},
    model: async () => ({ id: 'MiniMax-H3', durations: [5] }),
    build: async (_input, model, prompt, durationSeconds) => ({ model, prompt, seconds: String(durationSeconds) }),
    submit: async (_request, _signal, submission) => {
      attempts.push(submission?.attemptId ?? 'missing')
      if (!funded) {
        const failure = h3SubmissionRejection('MiniMax-H3', 402, {
          code: 'insufficient_user_quota', submission_code: 'h3_submission_not_sent',
          submission_state: 'not_submitted', upstream_submitted: false, retryable: false,
          resubmittable: true, id: 'unfunded-original', task_id: 'unfunded-original', billing_state: 'not_charged',
        })
        if (failure === undefined) throw new Error('Fixture must have complete validated unsent proof')
        throw failure
      }
      return { taskId: 'funded-attempt' }
    },
    check: async taskId => taskId === 'unfunded-original'
      ? { status: 'failed', code: 'INSUFFICIENT_BALANCE', submissionState: 'not_submitted' }
      : { status: 'succeeded' },
    download: async (_task, _request, destination) => { await writeFile(destination, 'keyless video fixture') },
  }
  if (transport !== 'direct') {
    const items = new Map<string, { operation_id: string; model: string; funded: boolean }>()
    const item = (queueId: string) => {
      const retained = items.get(queueId)
      if (retained === undefined) return Response.json({ error: { code: 'not_found' } }, { status: 404 })
      return Response.json({ schema_version: 1, object: 'video_queue_item', accepted: true,
        data: { id: queueId, operation_id: retained.operation_id, model: retained.model, count: 1, duration_seconds: 5,
          task_id: retained.funded ? 'task_0123456789abcdef0123456789abcdef' : 'task_00000000000000000000000000000000',
          state: retained.funded ? 'succeeded' : 'failed', submission_state: retained.funded ? 'accepted' : 'not_submitted',
          ...retained.funded ? {} : { failure_code: 'insufficient_user_quota', error_code: 'h3_submission_not_sent' }, created_at: 1, updated_at: 2 },
        cancelable: false, observation_timed_out: false, recovery: { method: 'GET', path: `/v1/video/queue/${queueId}` } })
    }
    const dispatch = createVideoProjectDispatch({
      route: async () => '/v1/videos',
      relay: { modelIds: async () => ['MiniMax-H3'],
        submit: async () => { throw new Error('Queue transport cannot fall back to another submission') },
        check: async (taskId) => {
          if (taskId !== 'task_00000000000000000000000000000000') return { status: 'succeeded' }
          const failure = h3SubmissionQueryRejection('MiniMax-H3', 200, { task_id: taskId,
            submission_receipt: { id: taskId, task_id: taskId, submission_code: 'h3_submission_not_sent',
              submission_state: 'not_submitted', upstream_submitted: false, retryable: false,
              resubmittable: true, billing_state: 'not_charged' } }, taskId)
          if (failure === undefined) throw new Error('Canonical task GET requires complete original unsent proof')
          // The real canonical GET may omit the original funding code; the stored queue rejection retains it.
          throw failure
        },
        download: async (_task, destination) => { await writeFile(destination, 'keyless video fixture') } },
      queue: { origin: 'https://queue.invalid/harness', timeoutMs: 1000, key: async () => 'synthetic-key',
        fetch: async (input, init) => {
          const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
          if (path.endsWith('/api/status')) return Response.json({ data: { video_queue: {
            schema_version: 1, enabled: true, create_path: '/v1/video/queue', retrieve_path_template: '/v1/video/queue/:queue_id',
            cancel_path_template: '/v1/video/queue/:queue_id/cancel', max_count_per_item: 1, body_max_bytes: 65536,
            poll_interval_seconds: 15, client_generated_id: true, queued_charge_reserved: false, lost_ack_recovery_method: 'GET',
          } } })
          if (init?.method === 'POST') {
            if (typeof init.body !== 'string') throw new Error('Queue submission requires JSON text')
            const body = JSON.parse(init.body) as { queue_id: string; operation_id: string; request: { model: string } }
            attempts.push(body.operation_id)
            if (!funded && transport === 'queue') return Response.json({ error: { type: 'new_api_error', code: 'insufficient_user_quota', message: 'Insufficient user quota' },
              accepted: false, submission_state: 'not_submitted', retryable: false, resubmittable: true,
              charged: false, reserved: false }, { status: 403 })
            items.set(body.queue_id, { operation_id: body.operation_id, model: body.request.model, funded })
            return item(body.queue_id)
          }
          return item(path.split('/').at(-1) ?? '')
        },
      },
    })
    Object.defineProperties(provider, Object.getOwnPropertyDescriptors(dispatch))
  }
  const options: VideoProjectOptions = {
    stateDirectory: join(directory, 'projects'), outputDirectory: 'artifacts/videos',
    maxTotalSeconds: 120, maxSegments: 12, pollIntervalMs: 1, taskTimeoutMs: 5_000,
    acquireProvider: async () => provider, accountScope: () => 'a'.repeat(64),
    editor: () => ({ preflight: async () => {}, probe: async () => ({ durationSeconds: 5 }),
      compose: async ({ outputPath }) => { await writeFile(outputPath, 'composed video fixture'); return { path: outputPath, durationSeconds: 5 } } }),
    chatModelChoice: async input => ({ input }),
  }
  options.creative = new CreativeStore({ directory: join(directory, 'creative'), current: async () => provider.identity,
    video: (id, owner) => readVideoProject(options, id, owner.sessionId, owner.workspaceRoot, owner) })
  options.videoWorks = new VideoWorkStore({ directory: join(directory, 'works'), current: async () => provider.identity })
  const Fixture = { name: 'recharge-original-work-fixture', inject: ['llm', 'tools', 'sessionProjections'], apply(inner: Context) {
    inner.effect(() => inner.llm.registerAdapter(['fixture'], adapter))
    registerVideoGenerationIntent(inner)
    registerVideoProjectTools(inner, options)
  } }
  const modules = new Map<string, unknown>([
    ['sessions', SessionStore], ['projections', SessionProjections], ['agents', AgentRegistry], ['llm', LlmRuntime],
    ['system-prompt', SystemPrompt], ['tools', Tools], ['jobs', LocalJobs], ['job-tools', JobTools],
    ['agent-loop', AgentLoop], ['fixture', Fixture], ['fs', LocalFS], ['working-directory', WorkingDirectory],
  ])
  const config = join(directory, 'cordis.yml')
  await writeFile(config, ['- name: sessions', '- name: projections', '- name: agents', '- name: llm', '- name: system-prompt',
    '- name: fs', '- name: working-directory', '- name: tools', '- name: jobs', '- name: job-tools',
    '- name: agent-loop', '  config:', '    agents: []', '- name: fixture', '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
    if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
    return modules.get(specifier)
  } } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const agent = await ctx.agentLoop.create(SessionId('recharge-same-chat'), { provider: 'fixture', model: 'fixture' }, { cwd: workspace })
  const send = (text: string): void => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  }
  return { ctx, agent, script, adapter, send, attempts, options, workspace, provider, fund: () => { funded = true } }
}

it.each(['direct', 'queue', 'queue-dispatched'] as const)('continues the original %s work after explicit recharge retry in the same chat with a distinct submission attempt', async (transport) => {
  const f = await boot(transport)
  f.send('生成一个5秒海边视频')
  await f.agent.whenIdle()
  await vi.waitFor(() => { expect(f.ctx.jobs.list(f.agent.id)[0]?.detail).toBe('INSUFFICIENT_BALANCE') })
  expect(f.ctx.jobs.list(f.agent.id)[0]).toMatchObject({ status: 'failed',
    actionRequired: { code: 'INSUFFICIENT_BALANCE' } })
  const event = f.agent.session.snapshotEvents().find(entry => entry.type === 'tool/result')
  const content = event?.type === 'tool/result' ? event.data.message.content[0] : undefined
  if (content?.type !== 'text') throw new Error('Missing actual tool result')
  const started = JSON.parse(content.text) as { project_id: string; work_id: string; operation_id: string }
  const original = await readVideoProject(f.options, started.project_id, f.agent.session.id, f.workspace, f.provider.identity)
  expect(original.segments[0]).toMatchObject({ status: 'failed' })
  if (transport === 'direct') expect(original.segments[0]?.taskId).toBe('unfunded-original')
  expect(f.attempts).toHaveLength(1)
  f.fund()
  // Payment itself must neither wake the Agent nor submit paid work.
  await f.agent.whenIdle()
  expect(f.attempts).toHaveLength(1)
  f.script.push(toolCallResponse('old-status', 'job_output', { job_id: 'video-project-1' }),
    toolCallResponse('continue-original', 'resume_video_project', { project_id: started.project_id }), textResponse('已继续原作品'))
  f.send('已经充值，继续刚才这一个作品，不要另做一个')
  await f.agent.whenIdle()
  await vi.waitFor(() => { expect(f.ctx.jobs.list(f.agent.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'completed' }),
  ])) })
  const completed = await readVideoProject(f.options, started.project_id, f.agent.session.id, f.workspace, f.provider.identity)
  expect(completed.id).toBe(original.id)
  expect(completed.status).toBe('completed')
  expect(completed.segments[0]?.taskId).toBe(transport === 'direct' ? 'funded-attempt' : `vq_${f.attempts[1] ?? ''}`)
  expect(f.attempts).toHaveLength(2)
  expect(new Set(f.attempts).size).toBe(2)
  expect(f.attempts).not.toContain('missing')
  expect(await readFile(completed.finalPath ?? '', 'utf8')).toBe('composed video fixture')
  const results = f.agent.session.snapshotEvents().filter(entry => entry.type === 'tool/result')
  expect(results.some(entry => JSON.stringify(entry.data.message.content).includes(started.project_id))).toBe(true)
  expect(f.adapter.requests).toHaveLength(4)
})
