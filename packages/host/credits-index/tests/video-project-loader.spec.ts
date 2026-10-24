import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Skills from '@deepseek-ai/dsh-skill'
import Tools from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Artifacts from '@deepseek-ai/dsh-artifacts-index'
import * as Credits from '../src/index.ts'
import { registerVideoProjectTools } from '../src/video-project-tools.ts'
import type { VideoProjectInput, VideoProjectOptions, VideoProjectProvider } from '../src/video-project-types.ts'
import type { VideoEditor } from '../src/video-edit.ts'
import { CreativeStore } from '../src/creative-store.ts'
import { registerCreativeTools } from '../src/creative-tools.ts'
import { readVideoProject } from '../src/video-project.ts'
import { registerVideoGenerationIntent } from '../src/video-generation-intent.ts'

let context: Context | undefined
let directory: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function boot(production = false, workspaceIncludesState = false, managedOutput = false,
  humanText = '生成一个完整视频，按所选模型的实际时长生成分镜并合成。') {
  directory = await mkdtemp(join(tmpdir(), 'dsh-video-tools-loader-'))
  const workspace = workspaceIncludesState ? directory : join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  const requests: number[] = []
  const inputs: VideoProjectInput[] = []
  const composedPaths: string[] = []
  let pending = false
  let unknownSubmission = false
  const provider: VideoProjectProvider = {
    identity: { accountId: '7', sessionFingerprint: 'login-hash' }, assertCurrent: async () => {},
    model: async () => ({ id: 'MiniMax-H3', durations: [5, 10, 15] }),
    build: async (input, model, prompt, durationSeconds) => {
      inputs.push(input)
      return { model, prompt, durationSeconds,
        ...input.referenceImages === undefined ? {} : { referenceImages: [...input.referenceImages] } }
    },
    submit: async (request) => { requests.push(Number(request.durationSeconds)); if (unknownSubmission) throw new Error('unknown fixture acceptance'); return { taskId: `task-${String(requests.length)}` } },
    check: async () => ({ status: pending ? 'running' : 'succeeded' }),
    download: async (taskId, _request, destination) => {
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, String(requests[Number(taskId.slice(5)) - 1]))
    },
  }
  const editor: VideoEditor = {
    preflight: async () => {}, probe: async path => ({ durationSeconds: Number(await readFile(path, 'utf8')) }),
    compose: async (request) => {
      composedPaths.push(request.outputPath)
      const lengths = await Promise.all(request.clips.map(async clip => (clip.endSeconds ?? Number(await readFile(clip.path, 'utf8'))) - (clip.startSeconds ?? 0)))
      const durationSeconds = request.totalDurationSeconds ?? lengths.reduce((sum, value) => sum + value, 0)
      await mkdir(dirname(request.outputPath), { recursive: true })
      await writeFile(request.outputPath, String(durationSeconds))
      return { path: request.outputPath, durationSeconds }
    },
  }
  const options: VideoProjectOptions = {
    stateDirectory: join(directory, 'state'), outputDirectory: 'artifacts/videos', maxTotalSeconds: 300, maxSegments: 32,
    pollIntervalMs: 1, taskTimeoutMs: 5000, acquireProvider: async () => provider, editor: () => editor,
    get publication() { return managedOutput ? context?.get('artifactStorage') : undefined },
  }
  const creative = new CreativeStore({ directory: join(directory, 'creative'), current: async () => provider.identity,
    video: (id, owner) => readVideoProject(options, id, owner.sessionId, owner.workspaceRoot, owner) })
  options.creative = creative
  const VideoFixture = { name: 'video-fixture', inject: ['tools'], apply: (ctx: Context) => {
    registerVideoGenerationIntent(ctx)
    registerCreativeTools(ctx, creative, async () => provider.identity)
    registerVideoProjectTools(ctx, options)
  } }
  const modules = new Map<string, unknown>([
    ['system-prompt', SystemPrompt], ['skills', Skills], ['tools', Tools], ['agents', AgentRegistry], ['jobs', LocalJobs], ['job-tools', JobTools],
    ['video-fixture', VideoFixture], ['credits', Credits], ['webserver', WebServer], ['artifacts', Artifacts],
    ['session-projections', SessionProjectionRegistry],
  ])
  const path = join(directory, 'cordis.yml')
  await writeFile(path, [
    '- name: system-prompt', '- name: tools', '- name: agents', '- name: jobs', '- name: job-tools', '- name: session-projections',
    ...production ? ['- name: skills'] : [],
    ...production || managedOutput ? ['- name: webserver', '  config:', "    host: '127.0.0.1'", '    port: 0'] : [],
    ...managedOutput ? ['- name: artifacts', '  config:', `    defaultOutputDirectory: '${join(directory, 'selected-output')}'`, `    stateDirectory: '${join(directory, 'artifact-settings')}'`] : [],
    ...production ? ['- name: credits', '  config:', `    stateDir: '${join(directory, 'credits')}'`] : ['- name: video-fixture'], '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(directory).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (!modules.has(specifier)) throw new Error(`unexpected fixture import: ${specifier}`)
      return modules.get(specifier)
    },
  } as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const sessionId = SessionId('chat-video')
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false, cwd: workspace,
  })
  const unsupported = (): never => { throw new Error('fixture Inbox is not mutable') }
  const agent: Agent = {
    id: sessionId, session, ctx: context, options: {}, status: 'running',
    inbox: {
      nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported,
      replace: unsupported, remove: unsupported, splice: unsupported,
    },
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
  await context.agents.register(agent)
  const ctx = context
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: humanText }] }), { surfaceOp: 'append' })
  let callIndex = 0
  let turn = 1
  const call = async (name: string, args: unknown, signal = new AbortController().signal, callerAgent = agent) => {
    const step = ++callIndex
    const callId = ToolCallId(`video-${String(step)}`)
    const logged = callerAgent.session.append('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) ?? 'null' })
    const result = await ctx.tools.execute({ callId, name, arguments: args, agent: callerAgent, signal })
    callerAgent.session.append('tool/result', { turn, step, message: createToolResultMessage({ callId,
      content: result.content, isError: result.isError }) }, { surfaceOp: 'append', sourceEventSeqs: [logged.seq] })
    return result
  }
  return {
    ctx, agent, call, requests, inputs, composedPaths, workspace, stateDirectory: options.stateDirectory,
    creative, options, provider, editor,
    setPending: (value: boolean) => { pending = value },
    setUnknown: (value = true) => { unknownSubmission = value },
    nextHuman: (text: string) => {
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      turn += 1
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    },
    nextNotice: (source: 'agent-message' | 'tool-jobs') => {
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      turn += 1
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        source: source === 'agent-message'
          ? { kind: source, form: 'relay', senderSessionId: SessionId('other-chat') }
          : { kind: source, form: 'notice', summary: 'Existing job completed.' },
        content: [{ type: 'text', text: '生成三条10秒视频' }],
      }), { surfaceOp: 'append' })
    },
  }
}

/** Read canonical success without asking model clients to parse prose. */
function json(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected canonical object')
  return value as Record<string, unknown>
}

describe('video tools through Loader, real tool registry and jobs runtime', () => {
  it.each(['agent-message', 'tool-jobs'] as const)('refuses a native paid project in a %s-only turn despite unused earlier human quota', async (source) => {
    const f = await boot(false, false, false, '生成3条10秒视频')
    f.nextNotice(source)
    const generated = await f.call('generate_video_project', { prompt: 'Attempted generation from a notification', total_duration_seconds: 10 })
    expect(generated.value).toMatchObject({ status: 'failed', code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' })
    expect(f.requests).toEqual([])
    expect(f.inputs).toEqual([])
    expect(await f.creative.projects({ ...f.provider.identity, sessionId: f.agent.id })).toEqual([])
  })

  it.each(['running', 'unknown'] as const)('starts one independent chat background work beside an AI Creation %s operation', async (state) => {
    const f = await boot(false, false, false, '生成10秒视频')
    f.setPending(true)
    const owner = { ...f.provider.identity, sessionId: f.agent.id, workspaceRoot: f.workspace }
    const panel = await f.creative.begin(owner, { kind: 'video', source: 'ai-creation',
      prompt: 'Independent AI Creation work', shots: [{ prompt: 'Original panel shot', durationSeconds: 10 }] })
    await f.creative.dispatched(panel)
    if (state === 'unknown') {
      await f.creative.finish(panel, { status: 'unknown' })
      f.creative.release(panel)
    }
    try {
      const generated = await f.call('generate_video_project', { prompt: 'New human-requested chat video' })
      expect(generated.value).toMatchObject({ status: 'background', plan_seconds: [10] })
      const value = json(generated.value)
      expect(value.plan_id).not.toBe(panel.projectId)
      await vi.waitFor(() => { expect(f.requests).toEqual([10]) })
      expect((await f.call('generate_video_project', { prompt: 'Unrequested second chat version' })).value)
        .toMatchObject({ status: 'failed', code: 'CREATIVE_VIDEO_COUNT_LIMIT' })
      expect((await f.call('generate_video_project', { plan_id: panel.projectId, shot_ids: ['shot_1'],
        prompt: 'Do not duplicate the exact panel work', total_duration_seconds: 10 })).value)
        .toMatchObject({ status: 'failed', code: 'CREATIVE_VIDEO_COUNT_LIMIT' })
      const retained = await f.creative.projects(owner)
      expect(retained.find(project => project.id === panel.projectId)?.tasks).toMatchObject([{ source: 'ai-creation', status: state }])
      expect(retained.find(project => project.id === value.plan_id)?.tasks).toMatchObject([{ source: 'chat', status: 'running' }])
      expect(f.requests).toEqual([10])
    } finally { f.creative.release(panel) }
  })

  it.each(['running', 'unknown'] as const)('starts an identical new human brief on the same plan while the previous work is %s', async (state) => {
    const f = await boot(false, false, false, '生成10秒视频')
    f.setPending(true)
    f.setUnknown(state === 'unknown')
    const first = await f.call('generate_video_project', { prompt: 'Identical independently requested work' })
    const original = json(first.value)
    expect(original).toMatchObject({ status: 'background', remaining_works: 0 })
    await vi.waitFor(async () => {
      const views = await f.creative.projects({ accountId: '7', sessionId: f.agent.id })
      expect(views[0]?.tasks[0]?.status).toBe(state)
    })
    let taskIds: unknown
    await vi.waitFor(async () => {
      const before = await f.call('video_project_status', { project_id: original.project_id })
      taskIds = json(before.value).task_ids
      expect(taskIds).toEqual(state === 'running' ? ['task-1'] : [])
    })
    f.nextHuman('生成10秒视频')
    f.setUnknown(false)
    const second = await f.call('generate_video_project', { plan_id: original.plan_id,
      shot_ids: ['shot_1'], total_duration_seconds: 10, prompt: 'Identical independently requested work' })
    expect(second.value).toMatchObject({ status: 'background', plan_id: original.plan_id, remaining_works: 0 })
    expect(json(second.value).project_id).not.toBe(original.project_id)
    await vi.waitFor(() => { expect(f.requests).toEqual([10, 10]) })
    expect((await f.call('generate_video_project', { prompt: 'Unrequested duplicate version' })).value)
      .toMatchObject({ status: 'failed', code: 'CREATIVE_VIDEO_COUNT_LIMIT' })
    expect(json((await f.call('video_project_status', { project_id: original.project_id })).value).task_ids).toEqual(taskIds)
    expect(f.requests).toEqual([10, 10])
  })

  it('reads a mode selected after all builds and resumes known IDs without new admission discovery', async () => {
    const f = await boot()
    f.setPending(true)
    f.options.maxConcurrentSegments = 1
    let mode: 'queued' | undefined
    const modes: (typeof mode)[] = []
    Object.defineProperty(f.provider, 'submissionMode', { get() { modes.push(mode); return mode } })
    const prepare = vi.fn(async (requests: readonly object[]) => { expect(requests).toHaveLength(3); mode = 'queued' })
    f.provider.prepareSubmissions = prepare
    const generated = json((await f.call('generate_video_project', { prompt: '三段', total_duration_seconds: 45 })).value)
    await vi.waitFor(() => { expect(f.requests).toEqual([15, 15, 15]) })
    expect(modes.at(-1)).toBe('queued')
    expect(prepare).toHaveBeenCalledOnce()
    const id = JobId(String(generated.job_id))
    f.ctx.jobs.kill(id, f.agent.id)
    await f.ctx.jobs.wait(id, 1000, f.agent.id)
    const read = vi.spyOn(f.provider, 'check')
    mode = undefined
    const modeReads = modes.length
    const resumed = await f.call('resume_video_project', { project_id: generated.project_id })
    expect(resumed.value).toMatchObject({ status: 'background' })
    await vi.waitFor(() => { expect(read).toHaveBeenCalled() })
    expect(prepare).toHaveBeenCalledOnce()
    expect(modes).toHaveLength(modeReads)
    expect(f.requests).toEqual([15, 15, 15])
  })

  it('preserves dynamic scheduling and gateway poll policy through the implicit-duration wrapper', async () => {
    const f = await boot(false, false, false, '做个视频')
    f.setPending(true)
    let mode: 'queued' | undefined
    let minimumPoll = 1
    const modes: (typeof mode)[] = []
    const intervals: number[] = []
    Object.defineProperty(f.provider, 'submissionMode', { get() { modes.push(mode); return mode } })
    Object.defineProperty(f.provider, 'pollIntervalMs', { get() { intervals.push(minimumPoll); return minimumPoll } })
    const prepare = vi.fn(async () => { mode = 'queued'; minimumPoll = 20 })
    f.provider.prepareSubmissions = prepare
    const generated = await f.call('generate_video_project', { prompt: '一个茶杯' })
    expect(generated.value).toMatchObject({ status: 'background' })
    await vi.waitFor(() => { expect(intervals).toContain(20) })
    expect(prepare).toHaveBeenCalledOnce()
    expect(modes.at(-1)).toBe('queued')
    expect(f.requests).toEqual([5])
  })

  it('cancels only original queued ids after the owned local job has stopped', async () => {
    const f = await boot(false, false, false, '生成10秒视频')
    f.setPending(true)
    const queueId = 'vq_11111111-1111-4111-8111-111111111111'
    vi.spyOn(f.provider, 'submit').mockImplementation(async (request) => { f.requests.push(Number(request.durationSeconds)); return { taskId: queueId } })
    const cancel = vi.fn(async (_taskId: string) => ({ canceled: true }))
    f.provider.cancel = cancel
    const generated = json((await f.call('generate_video_project', { prompt: '茶杯' })).value)
    await vi.waitFor(() => { expect(f.requests).toEqual([10]) })
    const jobId = JobId(String(generated.job_id))
    const result = await f.call('cancel_video_project', { project_id: generated.project_id })
    expect(result.value).toMatchObject({ status: 'cancelled', task_ids: [queueId], cancelled_task_ids: [queueId], unconfirmed_task_ids: [] })
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel.mock.calls[0]?.[0]).toBe(queueId)
    await vi.waitFor(() => { expect(f.ctx.jobs.get(jobId, f.agent.id).status).toBe('killed') })
    const retained = await readVideoProject(f.options, String(generated.project_id), f.agent.id, f.workspace, f.provider.identity)
    expect(retained.segments[0]?.taskId).toBe(queueId)
    expect(f.requests).toEqual([10])
  })

  it.each(['dispatching', 'network', 'legacy'] as const)('does not claim provider cancellation or refund after %s', async (state) => {
    const f = await boot(false, false, false, '生成10秒视频')
    f.setPending(true)
    const taskId = state === 'legacy' ? 'task-legacy' : 'vq_22222222-2222-4222-8222-222222222222'
    vi.spyOn(f.provider, 'submit').mockImplementation(async (request) => { f.requests.push(Number(request.durationSeconds)); return { taskId } })
    const cancel = vi.fn(async () => { if (state === 'network') throw new Error('private timeout detail'); return { canceled: false } })
    f.provider.cancel = cancel
    const generated = json((await f.call('generate_video_project', { prompt: '茶杯' })).value)
    await vi.waitFor(() => { expect(f.requests).toEqual([10]) })
    const result = await f.call('cancel_video_project', { project_id: generated.project_id })
    expect(result.value).toMatchObject({ status: 'stopped', code: 'VIDEO_CANCELLATION_UNCONFIRMED',
      task_ids: [taskId], cancelled_task_ids: [], unconfirmed_task_ids: [taskId] })
    expect(json(result.value).message).toContain('可能继续运行并计费')
    expect(JSON.stringify(result.value)).not.toContain('private timeout detail')
    expect(cancel).toHaveBeenCalledTimes(state === 'legacy' ? 0 : 1)
    expect(f.requests).toEqual([10])
  })

  it.each(['account', 'workspace', 'chat'] as const)('rejects %s ownership changes before stopping or canceling the original task', async (scope) => {
    const f = await boot(false, false, false, '生成10秒视频')
    f.setPending(true)
    const cancel = vi.fn(async (_taskId: string) => ({ canceled: true }))
    f.provider.cancel = cancel
    const generated = json((await f.call('generate_video_project', { prompt: '茶杯' })).value)
    await vi.waitFor(() => { expect(f.requests).toEqual([10]) })
    const foreignId = scope === 'chat' ? SessionId('another-chat') : f.agent.id
    const foreignSession = Session.create(foreignId, [], { version: SESSION_FORMAT_VERSION, id: foreignId, createdAt: 0,
      isSeeded: false, cwd: scope === 'workspace' ? join(f.workspace, 'other') : f.workspace })
    const foreign: Agent = { ...f.agent, id: foreignId, session: foreignSession }
    if (scope === 'account') f.options.acquireProvider = async () => ({ ...f.provider, identity: { accountId: 'other', sessionFingerprint: 'other' } })
    const result = await f.call('cancel_video_project', { project_id: generated.project_id }, new AbortController().signal, foreign)
    expect(result.value).toMatchObject({ status: 'failed', code: 'PROJECT_ACCESS_DENIED' })
    expect(cancel).not.toHaveBeenCalled()
    expect(f.ctx.jobs.get(JobId(String(generated.job_id)), f.agent.id).status).toBe('running')
    expect(f.requests).toEqual([10])
  })

  it('joins a late accepted queue id before canceling it and blocks a competing resume', async () => {
    const f = await boot(false, false, false, '生成10秒视频')
    const queueId = 'vq_33333333-3333-4333-8333-333333333333'
    const admission = Promise.withResolvers<{ taskId: string }>()
    vi.spyOn(f.provider, 'submit').mockImplementation(async (request) => { f.requests.push(Number(request.durationSeconds)); return admission.promise })
    const cancel = vi.fn(async (_taskId: string) => ({ canceled: true }))
    f.provider.cancel = cancel
    const generated = json((await f.call('generate_video_project', { prompt: '茶杯' })).value)
    await vi.waitFor(() => { expect(f.requests).toEqual([10]) })
    const jobId = JobId(String(generated.job_id))
    const cancelling = f.call('cancel_video_project', { project_id: generated.project_id })
    try {
      await vi.waitFor(() => { expect(f.ctx.jobs.get(jobId, f.agent.id).status).toBe('stopping') })
      expect(cancel).not.toHaveBeenCalled()
      const resumed = await f.call('resume_video_project', { project_id: generated.project_id })
      expect(resumed.value).toMatchObject({ status: 'failed', code: 'PROJECT_ALREADY_RUNNING' })
      admission.resolve({ taskId: queueId })
      const result = await cancelling
      expect(result.value).toMatchObject({ status: 'cancelled', task_ids: [queueId], cancelled_task_ids: [queueId] })
      expect(cancel.mock.calls[0]?.[0]).toBe(queueId)
      const retained = await readVideoProject(f.options, String(generated.project_id), f.agent.id, f.workspace, f.provider.identity)
      expect(retained.segments[0]?.taskId).toBe(queueId)
      expect(f.requests).toEqual([10])
    } finally { admission.resolve({ taskId: queueId }); await cancelling }
  })

  it('does not restart an earlier resume whose preflight finished after cancellation', async () => {
    const f = await boot(false, false, false, '生成10秒视频')
    f.setPending(true)
    const generated = json((await f.call('generate_video_project', { prompt: '茶杯' })).value)
    await vi.waitFor(() => { expect(f.requests).toEqual([10]) })
    const jobId = JobId(String(generated.job_id))
    f.ctx.jobs.kill(jobId, f.agent.id)
    await f.ctx.jobs.wait(jobId, 1000, f.agent.id)
    const preflight = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    vi.spyOn(f.editor, 'preflight').mockImplementation(async () => { entered.resolve(undefined); await preflight.promise })
    const resume = f.call('resume_video_project', { project_id: generated.project_id })
    try {
      await entered.promise
      const cancelled = await f.call('cancel_video_project', { project_id: generated.project_id })
      expect(cancelled.value).toMatchObject({ status: 'stopped' })
      preflight.resolve(undefined)
      expect((await resume).value).toMatchObject({ status: 'failed', code: 'PROJECT_CANCELLED' })
      expect(f.ctx.jobs.list(f.agent.id)).toHaveLength(1)
      expect(f.requests).toEqual([10])
    } finally { preflight.resolve(undefined); await resume }
  })

  it('binds a ten-second human request and releases the turn while its original job is still running', async () => {
    const f = await boot(false, false, false, '来个10s视频')
    f.setPending(true)
    const answer = await f.call('generate_video_project', { prompt: '茶杯升起热气' })
    expect(answer.isError).toBe(false)
    expect(answer.concludesTurn).toBe(true)
    const value = json(answer.value)
    expect(value.plan_seconds).toEqual([10])
    const id = JobId(String(value.job_id))
    await vi.waitFor(() => { expect(f.requests).toEqual([10]) })
    expect(f.ctx.jobs.get(id, f.agent.id)).toMatchObject({ status: 'running', readMode: 'background' })
    const wait = vi.spyOn(f.ctx.jobs, 'wait')
    const read = await f.call('job_output', { job_id: id, wait: true, timeout_ms: 600_000 })
    expect(wait).not.toHaveBeenCalled()
    expect(read.isError).toBe(false)
    expect(read.concludesTurn).toBe(true)
    expect(json(json(read.value).job).status).toBe('running')
    expect(f.requests).toEqual([10])
  })

  it('rejects a tool duration conflicting with the original human before any submission', async () => {
    const f = await boot(false, false, false, '来一个10秒视频')
    const result = await f.call('generate_video_project', { prompt: '茶杯', total_duration_seconds: 30 })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'failed', code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' })
    expect(result.concludesTurn).toBeUndefined()
    expect(f.requests).toEqual([])
  })

  it('creates three separate ten-second works without treating their duration as a work count', async () => {
    const f = await boot(false, false, false, '来3个10s视频')
    f.setPending(true)
    let planId: string | undefined
    for (let index = 0; index < 3; index += 1) {
      const result = await f.call('generate_video_project', { prompt: `第${String(index + 1)}个茶杯视频`,
        ...planId === undefined ? {} : { plan_id: planId, shot_ids: ['shot_1'], total_duration_seconds: 10 } })
      expect(result.concludesTurn).toBe(index === 2 ? true : undefined)
      expect(result.value).toMatchObject({ status: 'background', plan_seconds: [10], remaining_works: 2 - index })
      const value = json(result.value)
      if (typeof value.plan_id !== 'string') throw new Error('Expected the original plan id')
      if (planId !== undefined) expect(value.plan_id).toBe(planId)
      planId = value.plan_id
      if (index === 0) {
        const replay = await f.ctx.tools.execute({ callId: ToolCallId('video-1'), name: 'generate_video_project',
          arguments: { prompt: '第1个茶杯视频' }, agent: f.agent, signal: new AbortController().signal })
        expect(replay.value).toMatchObject({ status: 'failed', code: 'CREATIVE_VIDEO_SUBMISSION_DUPLICATE' })
      }
      const wait = vi.spyOn(f.ctx.jobs, 'wait')
      const snapshot = await f.call('job_output', { job_id: value.job_id, wait: true, timeout_ms: 600_000 })
      expect(wait).not.toHaveBeenCalled()
      expect(snapshot.concludesTurn).toBe(index === 2 ? true : undefined)
      expect(json(json(snapshot.value).job).status).toBe('running')
      wait.mockRestore()
    }
    await vi.waitFor(() => { expect(f.requests).toEqual([10, 10, 10]) })
    const extra = await f.call('generate_video_project', { prompt: '不应多出的第四个视频' })
    expect(extra.value).toMatchObject({ status: 'failed', code: 'CREATIVE_VIDEO_COUNT_LIMIT' })
    expect(f.requests).toEqual([10, 10, 10])
  })

  it('runs gateway-approved concurrent clips inside one native background project', async () => {
    const f = await boot()
    f.options.maxConcurrentSegments = 2
    f.provider.parallelism = async () => 2
    const release = Promise.withResolvers<undefined>()
    let observing = 0, peak = 0
    vi.spyOn(f.provider, 'check').mockImplementation(async () => {
      observing += 1
      peak = Math.max(peak, observing)
      await release.promise
      observing -= 1
      return { status: 'succeeded' }
    })
    const answer = await f.call('generate_video_project', { prompt: '三段连续镜头', total_duration_seconds: 45 })
    expect(answer.isError).toBe(false)
    const started = json(answer.value)
    expect(started.status).toBe('background')
    const id = JobId(String(started.job_id))
    try {
      await vi.waitFor(() => { expect(observing).toBe(2) })
      expect(f.requests).toEqual([15, 15])
      expect(f.ctx.jobs.get(id, f.agent.id).status).toBe('running')
      release.resolve(undefined)
      await vi.waitFor(() => { expect(f.ctx.jobs.get(id, f.agent.id).status).toBe('completed') })
      expect(peak).toBe(2)
      expect(f.requests).toEqual([15, 15, 15])
      expect(f.composedPaths).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      await vi.waitFor(() => { expect(f.ctx.jobs.get(id, f.agent.id).status).not.toBe('running') })
    }
  }, 15_000)

  it.each([undefined, 10])('starts a simple single-clip request with one real model read and default %s', async (declaredDefault) => {
    const fixture = await boot()
    const model = vi.spyOn(fixture.provider, 'model').mockResolvedValue({ id: 'MiniMax-H3', durations: [5, 10, 15],
      ...declaredDefault === undefined ? {} : { defaultDuration: declaredDefault } })
    const started = await fixture.call('generate_video_project', { prompt: '茶杯升起热气，镜头缓慢推进' })
    expect(started.isError).toBe(false)
    const value = json(started.value)
    expect(value.status).toBe('background')
    const duration = declaredDefault ?? 5
    expect(value.plan_seconds).toEqual([duration])
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(JobId(String(value.job_id)), fixture.agent.id).status).toBe('completed') })
    expect(model).toHaveBeenCalledTimes(1)
    expect(fixture.requests).toEqual([duration])
    expect(fixture.inputs[0]).toMatchObject({ model: 'MiniMax-H3', totalDurationSeconds: duration })
  })

  it('does not silently replace an explicitly selected model in the single-clip shortcut', async () => {
    const fixture = await boot()
    const result = await fixture.call('generate_video_project', { prompt: '茶杯', model: 'exact-requested-model' })
    expect(json(result.value)).toMatchObject({ status: 'failed', code: 'VIDEO_MODEL_UNAVAILABLE' })
    expect(fixture.requests).toEqual([])
  })

  it('refuses an invalid catalog default without silently increasing duration or submitting', async () => {
    const fixture = await boot()
    vi.spyOn(fixture.provider, 'model').mockResolvedValue({ id: 'MiniMax-H3', durations: [15, 30], defaultDuration: 5 })
    const result = await fixture.call('generate_video_project', { prompt: '茶杯升起热气' })
    expect(json(result.value)).toMatchObject({ status: 'failed', code: 'DURATION_MENU_UNAVAILABLE' })
    expect(fixture.requests).toEqual([])
    expect(fixture.ctx.jobs.list(fixture.agent.id)).toEqual([])
  })

  it.each([{ plan_id: 'explicit-plan', shot_ids: ['s1'] }, { shot_prompts: ['镜头一'] }, { shot_durations_seconds: [10] }])('requires explicit duration for retained plans and shot arrays', async (args) => {
    const fixture = await boot()
    if (args.plan_id !== undefined) {
      const plan = json((await fixture.call('update_creation_plan', { kind: 'video', title: '现有计划', brief: '一段视频',
        shots: [{ id: 's1', order: 1, title: '原镜头', prompt: '一段视频' }] })).value)
      args = { ...args, plan_id: String(plan.plan_id) }
    }
    const model = vi.spyOn(fixture.provider, 'model')
    const result = await fixture.call('generate_video_project', { prompt: '按明确分镜生成', ...args })
    expect(json(result.value)).toMatchObject({ status: 'failed', code: 'INVALID_DURATION' })
    expect(model).not.toHaveBeenCalled()
    expect(fixture.requests).toEqual([])
  })

  it('rejects an old saved timeline changed during preflight before submitting or linking generation', async () => {
    const fixture = await boot()
    const owner = { ...fixture.provider.identity, sessionId: fixture.agent.id, workspaceRoot: fixture.workspace }
    const planned = json((await fixture.call('update_creation_plan', {
      kind: 'video', title: '时间轴', brief: '按保存的镜头生成', shots: [
        { id: 'scene', order: 1, title: '旧镜头', duration_seconds: 5, prompt: '旧镜头的场景与动作' },
      ],
    })).value)
    const planId = String(planned.plan_id)
    const before = (await fixture.creative.projects(owner))[0]!
    const preflightEntered = Promise.withResolvers<undefined>()
    const continuePreflight = Promise.withResolvers<undefined>()
    vi.spyOn(fixture.editor, 'preflight').mockImplementationOnce(async () => {
      preflightEntered.resolve(undefined)
      await continuePreflight.promise
    })
    const generation = fixture.call('generate_video_project', {
      plan_id: planId, shot_ids: ['scene'], prompt: '根据保存的镜头生成', total_duration_seconds: 5,
    })
    try {
      await preflightEntered.promise
      await fixture.creative.revise(owner, planId, before.planRevision, {
        kind: 'shot', id: 'scene', patch: { title: '用户已改稿', prompt: '新镜头的场景与动作' },
      })
      continuePreflight.resolve(undefined)
      expect(json((await generation).value)).toMatchObject({ status: 'failed', code: 'CREATIVE_PLAN_STALE' })
      expect(fixture.requests).toEqual([])
      expect(fixture.ctx.jobs.list(fixture.agent.id)).toEqual([])
      const retained = (await fixture.creative.projects(owner))[0]!
      expect(retained).toMatchObject({ shots: [{ title: '用户已改稿', prompt: '新镜头的场景与动作', status: 'planned' }], tasks: [], outputs: [] })
      expect(retained.planRevision).not.toBe(before.planRevision)
    } finally {
      continuePreflight.resolve(undefined)
      await generation
    }
  })

  it('executes saved Chinese shot timing and only each character’s real references through the native workflow', async () => {
    const fixture = await boot()
    const owner = { ...fixture.provider.identity, sessionId: fixture.agent.id, workspaceRoot: fixture.workspace }
    const secondImage = join(fixture.workspace, '第二人物.png')
    await writeFile(secondImage, 'real second reference')
    const created = json((await fixture.call('update_creation_plan', {
      kind: 'video', title: '两人在车站道别', brief: '两个人各自说一句话', style: '动漫',
      characters: [
        { id: 'S1', name: '小雨', appearance: '黑长发', clothing: '红围巾', personality: '安静', voice: '轻柔女声', reference_asset_ids: ['portrait_a'] },
        { id: 'S2', name: '小海', appearance: '短发', clothing: '蓝外套', voice: '低沉男声', reference_asset_ids: ['portrait_b'] },
      ],
      assets: [
        { id: 'portrait_a', name: '小雨立绘', kind: 'image', source_path_or_asset_id: 'ma_original_a' },
        { id: 'portrait_b', name: '小海立绘', kind: 'image', source_path_or_asset_id: secondImage },
        { id: 'not_generated', name: '尚未生成的场景', kind: 'image', source_path_or_asset_id: '' },
      ],
      shots: [
        { id: 'first', order: 1, title: '挥手', duration_seconds: 5, scene: '雨夜站台', camera: '缓慢推近', action: '女孩挥手',
          prompt: '保留红围巾', dialogue: 'S1 1–3秒：“明天见。”', subtitles: '1–3秒：明天见。', character_ids: ['S1'], asset_ids: ['not_generated'] },
        { id: 'second', order: 2, title: '回应', duration_seconds: 10, scene: '站台另一侧', camera: '男孩近景',
          action: '点头', prompt: '保留蓝外套', dialogue: 'S2 2–4秒：“See you.”', subtitles: '2–4秒：See you.', character_ids: ['S2'] },
      ],
    })).value)
    const planId = String(created.plan_id)
    const material = await fixture.creative.begin(owner, { kind: 'image', planId, assetId: 'portrait_a', prompt: '人物立绘', shots: [{ prompt: '人物立绘' }] })
    const generatedPath = join(fixture.workspace, '新人物立绘.png')
    await writeFile(generatedPath, 'actual generated reference')
    await fixture.creative.finish(material, { status: 'completed', kind: 'image', paths: [generatedPath] })
    const generated = (await fixture.creative.projects(owner))[0]?.assets[0]?.outputs?.[0]
    expect(generated).toBeDefined()
    const current = (await fixture.creative.projects(owner))[0]!
    const character = current.characters.find(item => item.id === 'S1')!
    await fixture.creative.revise(owner, planId, current.planRevision, { kind: 'character',
      value: { ...character, referenceAssetIds: [...character.referenceAssetIds, 'portrait_side'] },
      assets: [{ id: 'portrait_side', name: '小雨侧面.png', kind: 'image', role: '', description: '',
        sourcePathOrAssetId: 'ma_uploaded_side' }],
    })
    const resolveReference = vi.fn(async (_owner: unknown, _planId: string, value: string) => value === generated?.id ? 'ma_generated_a' : undefined)
    fixture.options.creativeImageReference = resolveReference
    const started = json((await fixture.call('generate_video_project', {
      plan_id: planId, shot_ids: ['first', 'second'], prompt: '两人在车站道别，按保存的分镜拍摄', total_duration_seconds: 15,
      reference_images: ['ma_shared'],
    })).value)
    expect(started).toMatchObject({ status: 'background', plan_seconds: [5, 10] })
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(JobId(String(started.job_id)), fixture.agent.id).status).toBe('completed') })
    expect(fixture.requests).toEqual([5, 10])
    expect(fixture.inputs.map(input => input.referenceImages)).toEqual([
      ['ma_shared', 'ma_generated_a', 'ma_uploaded_side'], ['ma_shared', secondImage],
    ])
    expect(resolveReference).toHaveBeenCalledWith(owner, planId, generated!.id)
    const retained = await readVideoProject(fixture.options, String(started.project_id), owner.sessionId, owner.workspaceRoot, owner)
    expect(retained.input.shotDurations).toEqual([5, 10])
    expect(retained.input.shotReferenceImages).toEqual([['ma_generated_a', 'ma_uploaded_side'], [secondImage]])
    const [first, second] = retained.segments
    for (const text of ['雨夜站台', '缓慢推近', '女孩挥手', '黑长发', '红围巾', '安静', '轻柔女声', 'S1 1–3秒：“明天见。”', '1–3秒：明天见。']) expect(first?.prompt).toContain(text)
    expect(first?.prompt).not.toContain('小海')
    expect(second?.prompt).toContain('S2 2–4秒：“See you.”')
    expect(second?.prompt).toContain('2–4秒：See you.')
    expect(second?.prompt).not.toContain('小雨')
    expect(first?.request.referenceImages).toEqual(['ma_shared', 'ma_generated_a', 'ma_uploaded_side'])
    expect(second?.request.referenceImages).toEqual(['ma_shared', secondImage])
  })

  it('binds selected plan video and audio assets only to their owning native shot and retains them for recovery', async () => {
    const f = await boot()
    const plan = json((await f.call('update_creation_plan', { kind: 'video', title: '镜头素材', brief: '分别参考各自片段', assets: [
      { id: 'v1', name: '第一段参考视频', kind: 'video', source_path_or_asset_id: 'ma_video1' },
      { id: 'a1', name: '第一段参考音频', kind: 'audio', source_path_or_asset_id: 'ma_audio1' },
      { id: 'v2', name: '第二段参考视频', kind: 'video', source_path_or_asset_id: 'second.mp4' },
      { id: 'a2', name: '第二段参考音频', kind: 'audio', source_path_or_asset_id: 'second.wav' },
      { id: 'unused', name: '未选中的素材', kind: 'video', source_path_or_asset_id: '' },
    ], shots: [
      { id: 'one', order: 1, title: '第一镜', prompt: '第一镜内容', duration_seconds: 5, asset_ids: ['v1', 'a1'] },
      { id: 'two', order: 2, title: '第二镜', prompt: '第二镜内容', duration_seconds: 10, asset_ids: ['v2', 'a2'] },
      { id: 'three', order: 3, title: '未选择镜头', prompt: '不生成', duration_seconds: 5, asset_ids: ['unused'] },
    ] })).value)
    const started = json((await f.call('generate_video_project', { plan_id: plan.plan_id, shot_ids: ['one', 'two'],
      prompt: '按已选择的镜头生成', total_duration_seconds: 15,
      reference_videos: ['ma_sharedvideo'], reference_audios: ['ma_sharedaudio'],
    })).value)
    expect(started).toMatchObject({ status: 'background', plan_seconds: [5, 10] })
    await vi.waitFor(() => { expect(f.ctx.jobs.get(JobId(String(started.job_id)), f.agent.id).status).toBe('completed') })
    expect(f.inputs.map(input => [input.referenceVideos, input.referenceAudios])).toEqual([
      [['ma_sharedvideo', 'ma_video1'], ['ma_sharedaudio', 'ma_audio1']],
      [['ma_sharedvideo', 'second.mp4'], ['ma_sharedaudio', 'second.wav']],
    ])
    const retained = await readVideoProject(f.options, String(started.project_id), f.agent.id, f.workspace, f.provider.identity)
    expect(retained.input).toMatchObject({ shotReferenceVideos: [['ma_video1'], ['second.mp4']],
      shotReferenceAudios: [['ma_audio1'], ['second.wav']] })
    expect(f.requests).toEqual([5, 10])
  })

  it.each(['video', 'audio'])('refuses a selected plan %s material with no actual source before any job or generation', async (kind) => {
    const f = await boot()
    const plan = json((await f.call('update_creation_plan', { kind: 'video', title: '缺少素材', brief: '不要忽略已选择素材',
      assets: [{ id: 'missing', name: '未添加的素材', kind, source_path_or_asset_id: '' }],
      shots: [{ id: 'one', order: 1, title: '原镜头', prompt: '按素材生成', duration_seconds: 5, asset_ids: ['missing'] }],
    })).value)
    expect(json((await f.call('generate_video_project', { plan_id: plan.plan_id, shot_ids: ['one'],
      prompt: '原镜头', total_duration_seconds: 5 })).value)).toMatchObject({ status: 'failed', code: 'CREATIVE_REFERENCE_INVALID' })
    expect(f.requests).toEqual([])
    expect(f.ctx.jobs.list(f.agent.id)).toEqual([])
  })

  it.each([
    { durations: [5, 5], total: 15, ids: ['first', 'second'], code: 'SHOT_DURATION_MISMATCH' },
    { durations: [5, undefined], total: 15, ids: ['first', 'second'], code: 'CREATIVE_SHOT_DURATION_REQUIRED' },
    { durations: [5, 20], total: 25, ids: ['first', 'second'], code: 'SHOT_DURATION_UNSUPPORTED' },
    { durations: [5, 10], total: 15, ids: ['second', 'first'], code: 'CREATIVE_SHOT_MISMATCH' },
  ])('rejects an incompatible saved timeline before submitting %j', async ({ durations, total, ids, code }) => {
    const fixture = await boot()
    const planned = json((await fixture.call('update_creation_plan', {
      kind: 'video', title: '时间轴', brief: '按顺序生成', shots: ['first', 'second'].map((id, index) => ({
        id, order: index + 1, title: id, prompt: '场景', ...durations[index] === undefined ? {} : { duration_seconds: durations[index] },
      })),
    })).value)
    const outcome = json((await fixture.call('generate_video_project', {
      plan_id: planned.plan_id, shot_ids: ids, prompt: '分镜', total_duration_seconds: total,
    })).value)
    expect(outcome).toMatchObject({ status: 'failed', code })
    expect(fixture.requests).toEqual([])
    expect(fixture.ctx.jobs.list(fixture.agent.id)).toEqual([])
  })

  it('keeps explicit shot prompts verbatim while honoring explicitly selected clip durations', async () => {
    const fixture = await boot()
    const started = json((await fixture.call('generate_video_project', {
      prompt: '以明确输入为准', total_duration_seconds: 15, shot_prompts: ['Keep this exact shot.', '保留中文原文。'],
      shot_durations_seconds: [5, 10],
    })).value)
    expect(started).toMatchObject({ status: 'background', plan_seconds: [5, 10] })
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(JobId(String(started.job_id)), fixture.agent.id).status).toBe('completed') })
    expect(fixture.requests).toEqual([5, 10])
    expect(fixture.inputs[0]?.shotPrompts).toEqual(['Keep this exact shot.', '保留中文原文。'])
  })

  it('refuses an unavailable generated reference instead of inventing an uploaded id or using an older source', async () => {
    const fixture = await boot()
    const owner = { ...fixture.provider.identity, sessionId: fixture.agent.id, workspaceRoot: fixture.workspace }
    const id = await fixture.creative.updatePlan(owner, {
      kind: 'video', title: '人物镜头', brief: '人物挥手', style: '动漫', characters: [],
      assets: [{ id: 'portrait', name: '人物图', kind: 'image', role: '身份', description: '固定外貌', sourcePathOrAssetId: 'ma_older' }],
      shots: [{ id: 'scene', order: 1, title: '挥手', durationSeconds: 5, prompt: '人物挥手', scene: '', camera: '', action: '', dialogue: '', subtitles: '', characterIds: [], assetIds: ['portrait'] }],
    })
    const operation = await fixture.creative.begin(owner, { kind: 'image', planId: id, assetId: 'portrait', prompt: '新版人物', shots: [{ prompt: '新版人物' }] })
    const path = join(fixture.workspace, 'new-portrait.png')
    await writeFile(path, 'real generated portrait')
    await fixture.creative.finish(operation, { status: 'completed', kind: 'image', paths: [path] })
    const result = json((await fixture.call('generate_video_project', {
      plan_id: id, shot_ids: ['scene'], prompt: '按新人物拍摄', total_duration_seconds: 5,
    })).value)
    expect(result).toMatchObject({ status: 'failed', code: 'CREATIVE_REFERENCE_INVALID' })
    expect(fixture.requests).toEqual([])
  })

  it('retains minimum-clip planning when the selected saved shots have no explicit timing', async () => {
    const fixture = await boot()
    const planned = json((await fixture.call('update_creation_plan', {
      kind: 'video', title: '简单镜头', brief: '晨光里的茶杯', shots: [{ id: 'cup', order: 1, title: '茶杯', prompt: '光影缓慢移动' }],
    })).value)
    const started = json((await fixture.call('generate_video_project', {
      plan_id: planned.plan_id, shot_ids: ['cup'], prompt: '晨光里的茶杯', total_duration_seconds: 15,
    })).value)
    expect(started).toMatchObject({ status: 'background', plan_seconds: [15] })
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(JobId(String(started.job_id)), fixture.agent.id).status).toBe('completed') })
    expect(fixture.requests).toEqual([15])
    expect(fixture.inputs[0]?.shotDurations).toBeUndefined()
    expect(fixture.inputs[0]?.shotPrompts?.[0]).toContain('光影缓慢移动')
  })

  it('reads a complete structured plan for safe revisions and refuses another chat or an invalid id without generation', async () => {
    const fixture = await boot()
    const created = json((await fixture.call('update_creation_plan', { kind: 'video', title: '剧情', brief: '雨夜站台对白', style: '动漫',
      characters: [{ id: 'S1', name: '小雨', clothing: '红围巾', voice: '轻柔中文女声', reference_asset_ids: ['portrait'] }],
      assets: [{ id: 'portrait', name: '人物参考', kind: 'image', source_path_or_asset_id: '' }],
      shots: [{ id: 'scene', order: 1, title: '道别', duration_seconds: 5, camera: '侧面近景', prompt: '女孩在站台道别',
        dialogue: '1–3秒 S1：“明天见。”', subtitles: '1–3秒 明天见。', character_ids: ['S1'], asset_ids: ['portrait'] }],
    })).value)
    const before = await fixture.creative.projects({ accountId: '7', sessionId: fixture.agent.id })
    const read = json((await fixture.call('get_creation_plan', { plan_id: created.plan_id })).value)
    expect(read).toMatchObject({ status: 'succeeded', plan_id: created.plan_id, plan: { kind: 'video', title: '剧情', style: '动漫',
      characters: [{ id: 'S1', name: '小雨', clothing: '红围巾', voice: '轻柔中文女声', reference_asset_ids: ['portrait'] }],
      assets: [{ id: 'portrait', source_path_or_asset_id: '' }], shots: [{ id: 'scene', duration_seconds: 5,
        camera: '侧面近景', dialogue: '1–3秒 S1：“明天见。”', subtitles: '1–3秒 明天见。', character_ids: ['S1'], asset_ids: ['portrait'] }],
    } })
    expect(await fixture.creative.projects({ accountId: '7', sessionId: fixture.agent.id })).toEqual(before)
    expect(fixture.ctx.tools.schemas().find(tool => tool.name === 'get_creation_plan')).toMatchSnapshot('read-only creation plan tool')
    const otherId = SessionId('other-creation-chat')
    const other: Agent = { ...fixture.agent, id: otherId, session: Session.create(otherId, [], {
      version: SESSION_FORMAT_VERSION, id: otherId, createdAt: 0, isSeeded: false, cwd: fixture.workspace,
    }) }
    await fixture.ctx.agents.register(other)
    const refused = await fixture.ctx.tools.execute({ name: 'get_creation_plan', callId: ToolCallId('other-plan'),
      arguments: { plan_id: created.plan_id }, agent: other, signal: new AbortController().signal })
    expect(json(refused.value)).toMatchObject({ status: 'failed', code: 'CREATIVE_ACCESS_DENIED' })
    expect(json((await fixture.call('get_creation_plan', { plan_id: '../../escape' })).value)).toMatchObject({ status: 'failed', code: 'CREATIVE_INVALID' })
    expect(JSON.stringify(read)).not.toMatch(/sessionFingerprint|workspaceRoot|login-hash|request/u)
    expect(fixture.requests).toEqual([])
  })

  it('links exact planned shots to live and retained manifest facts while optional preview failure preserves the video', async () => {
    const fixture = await boot()
    const planned = json((await fixture.call('update_creation_plan', { kind: 'video', title: '三镜头', brief: '茶杯广告', shots: [1, 2, 3].map(order => ({ id: `shot_${String(order)}`, order, title: `镜头${String(order)}`, prompt: `茶杯角度${String(order)}` })) })).value)
    const args = { plan_id: planned.plan_id, prompt: '茶杯广告', total_duration_seconds: 40, shot_prompts: ['近景', '侧面', '远景'] }
    const mismatch = json((await fixture.call('generate_video_project', { ...args, shot_ids: ['shot_1', 'shot_2'] })).value)
    expect(mismatch).toMatchObject({ status: 'failed', code: 'CREATIVE_SHOT_MISMATCH' })
    expect(fixture.requests).toEqual([])
    const started = json((await fixture.call('generate_video_project', { ...args, shot_ids: ['shot_1', 'shot_2', 'shot_3'] })).value)
    expect(started.plan_id).toBe(planned.plan_id)
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(JobId(String(started.job_id)), fixture.agent.id).status).toBe('completed') })
    const projects = await fixture.creative.projects({ accountId: '7', sessionId: fixture.agent.id })
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ id: planned.plan_id, status: 'completed', shots: [
      { id: 'shot_1', status: 'completed' }, { id: 'shot_2', status: 'completed' }, { id: 'shot_3', status: 'completed' },
    ], outputs: Array.from({ length: 4 }, () => ({ kind: 'video', previewUnavailable: true })) })
    for (const [index, shot] of (projects[0]?.shots ?? []).entries()) expect(shot.outputs[0]?.name).toContain(`clip-00${String(index + 1)}`)
    expect(await fixture.creative.projects({ accountId: '7', sessionId: 'another-chat' })).toEqual([])
    expect(fixture.requests).toEqual([15, 15, 10])
  })

  it('exposes unknown submission outcomes without resubmitting from reads or explicit unsafe resume', async () => {
    const fixture = await boot()
    fixture.setUnknown()
    const started = json((await fixture.call('generate_video_project', { prompt: '茶杯', total_duration_seconds: 20 })).value)
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(JobId(String(started.job_id)), fixture.agent.id).status).toBe('failed') })
    expect((await fixture.creative.projects({ accountId: '7', sessionId: fixture.agent.id }))[0]).toMatchObject({ status: 'unknown', errorCode: 'SUBMISSION_UNKNOWN' })
    const resumed = json((await fixture.call('resume_video_project', { project_id: started.project_id })).value)
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(JobId(String(resumed.job_id)), fixture.agent.id).status).toBe('failed') })
    expect(fixture.requests).toEqual([15])
    expect((await fixture.creative.projects({ accountId: '7', sessionId: fixture.agent.id }))[0]?.status).toBe('unknown')
  })

  it('publishes managed long-video and local-edit results while every composition stays inside the workspace', async () => {
    const fixture = await boot(false, false, true)
    const destination = await fixture.ctx.get('artifactStorage')!.capture(new AbortController().signal)
    const published = vi.spyOn(fixture.options.publication!, 'publish')
    const started = json((await fixture.call('generate_video_project', { prompt: 'A white cup', total_duration_seconds: 40 })).value)
    const projectJob = JobId(String(started.job_id))
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(projectJob, fixture.agent.id).status).toBe('completed') })
    const project = json((await fixture.call('video_project_status', { project_id: started.project_id })).value)
    const projectOutput = json(JSON.parse(fixture.ctx.jobs.read(projectJob, fixture.agent.id).result ?? '{}'))
    expect(projectOutput.final_path).toBe(project.final_path)
    expect(String(project.final_path).startsWith(destination.directory)).toBe(true)
    expect(await readFile(String(project.final_path), 'utf8')).toBe('40')
    const original = join(fixture.workspace, 'existing.mp4')
    await writeFile(original, '9')
    const edited = json((await fixture.call('edit_video', { clips: [{ path: original, start_seconds: 1, end_seconds: 7 }] })).value)
    const editJob = JobId(String(edited.job_id))
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(editJob, fixture.agent.id).status).toBe('completed') })
    const editOutput = json(JSON.parse(fixture.ctx.jobs.read(editJob, fixture.agent.id).result ?? '{}'))
    expect(String(editOutput.final_path).startsWith(destination.directory)).toBe(true)
    expect(await readFile(String(editOutput.final_path), 'utf8')).toBe('6')
    expect(await readFile(original, 'utf8')).toBe('9')
    expect(fixture.composedPaths).toHaveLength(2)
    expect(fixture.composedPaths.every(path => path.startsWith(fixture.workspace))).toBe(true)
    expect(fixture.requests.toSorted()).toEqual([10, 15, 15])
    expect(published.mock.calls.map(([request]) => request.videoRole)).toEqual(['shot', 'shot', 'shot', 'final', 'final'])
  })

  it('keeps model-facing audio references and requested native audio in the saved project input', async () => {
    const fixture = await boot()
    const result = await fixture.call('generate_video_project', {
      prompt: 'A speaks Mandarin', total_duration_seconds: 5, audio: true, reference_audios: ['voice.wav', 'ma_voice'],
    })
    const value = json(result.value)
    expect(value.status).toBe('background')
    const job = JobId(String(value.job_id))
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(job, fixture.agent.id).status).toBe('completed') })
    expect(fixture.inputs).toEqual([{ prompt: 'A speaks Mandarin', totalDurationSeconds: 5, model: 'MiniMax-H3', resolution: '768P',
      audio: true, referenceAudios: ['voice.wav', 'ma_voice'] }])
    const manifest = json(JSON.parse(await readFile(join(fixture.stateDirectory, String(value.project_id), 'manifest.json'), 'utf8')))
    expect(manifest.input).toMatchObject({ audio: true, referenceAudios: ['voice.wav', 'ma_voice'] })
    const status = await fixture.call('video_project_status', { project_id: value.project_id })
    expect(json(status.value).status).toBe('completed')
  })

  it('starts three clips, consumes completion through existing job_output, and exposes pure replayable presenters', async () => {
    const fixture = await boot()
    const result = await fixture.call('generate_video_project', { prompt: '制作一个茶杯广告', total_duration_seconds: 40 })
    expect(result.isError).toBe(false)
    const value = json(result.value)
    expect(value).toMatchObject({ status: 'background', job_id: 'video-project-1', plan_seconds: [15, 15, 10] })
    const jobId = JobId(String(value.job_id))
    await vi.waitFor(() =>{  expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).status).toBe('completed') })
    expect(fixture.requests).toEqual([15, 15, 10])
    const collected = await fixture.call('job_output', { job_id: jobId })
    expect(collected.isError).toBe(false)
    expect(JSON.stringify(collected.content)).toContain('final_path')
    expect(JSON.stringify(collected.content)).toContain('present')
    expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).progress).toBeUndefined()
    for (const index of [1, 2, 3]) expect(JSON.stringify(collected.content)).toContain(`分镜 ${String(index)}/3 已保存`)
    expect(JSON.stringify(collected.content)).toContain('视频项目：视频已完成 · 已保存 3/3 段')
    const status = await fixture.call('video_project_status', { project_id: value.project_id })
    const canonical = json(status.value)
    expect(canonical.status).toBe('completed')
    expect(await readFile(String(canonical.final_path), 'utf8')).toBe('40')
    const tool = fixture.ctx.tools.get('generate_video_project')!
    expect(tool.presentCall?.({ prompt: '制作一个茶杯广告', total_duration_seconds: 40 })).toMatchSnapshot()
    expect(tool.presentCall?.({ invalid: true })).toBeUndefined()
    expect(tool.presentResult?.({ prompt: '制作一个茶杯广告', total_duration_seconds: 40 }, { content: [], isError: false })).toEqual({ card: 'generic', title: '视频项目', content: [] })
  })

  it('exposes both concurrent clip states through real job progress and retains paused rows in terminal job_output', async () => {
    const fixture = await boot()
    fixture.options.maxConcurrentSegments = 2
    fixture.provider.parallelism = async () => 2
    vi.spyOn(fixture.provider, 'check').mockImplementation(async id => ({ status: id === 'task-1' ? 'queued' : 'running' }))
    const value = json((await fixture.call('generate_video_project', { prompt: '三个分镜分别等待与生成', total_duration_seconds: 40 })).value)
    const jobId = JobId(String(value.job_id))
    await vi.waitFor(() => {
      const progress = fixture.ctx.jobs.get(jobId, fixture.agent.id).progress
      expect(progress).toContain('分镜 1/3 排队中')
      expect(progress).toContain('分镜 2/3 生成中')
      expect(progress).toContain('分镜 3/3 尚未提交')
    })
    expect(fixture.requests).toEqual([15, 15])
    await fixture.call('job_kill', { job_id: jobId })
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).status).toBe('killed') })
    expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).progress).toBeUndefined()
    const terminal = await fixture.call('job_output', { job_id: jobId })
    const text = JSON.stringify(terminal.content)
    expect(text).toContain('视频项目：项目已停止 · 已保存 0/3 段')
    expect(text).toContain('分镜 1/3 查询已暂停，保留原任务')
    expect(text).toContain('分镜 2/3 查询已暂停，保留原任务')
    expect(text).toContain('分镜 3/3 尚未提交')
    expect(fixture.requests).toEqual([15, 15])
  })

  it('keeps a published job alive when the completed tool call signal later aborts, and job_kill stops it', async () => {
    const fixture = await boot()
    fixture.setPending(true)
    const abort = new AbortController()
    const result = await fixture.call('generate_video_project', { prompt: '一个茶杯', total_duration_seconds: 40 }, abort.signal)
    const jobId = JobId(String(json(result.value).job_id))
    abort.abort()
    await vi.waitFor(() =>{  expect(fixture.requests.length).toBe(3) })
    expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).status).toBe('running')
    const killed = await fixture.call('job_kill', { job_id: jobId })
    expect(killed.isError).toBe(false)
    await vi.waitFor(() =>{  expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).status).toBe('killed') })
    expect(fixture.requests).toHaveLength(3)
    expect(fixture.ctx.jobs.read(jobId, fixture.agent.id).result).toContain('可能继续运行并计费')
  })

  it('unregisters every contribution and cancels owned work when the Loader entry is disposed', async () => {
    const fixture = await boot()
    fixture.setPending(true)
    const result = await fixture.call('generate_video_project', { prompt: '一个茶杯', total_duration_seconds: 40 })
    const jobId = JobId(String(json(result.value).job_id))
    await vi.waitFor(() =>{  expect(fixture.requests.length).toBe(3) })
    const entry = [...fixture.ctx.loader.entries()].find(item => item.options.name === 'video-fixture')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    for (const name of ['generate_video_project', 'video_project_status', 'resume_video_project', 'cancel_video_project', 'edit_video']) expect(fixture.ctx.tools.get(name)).toBeUndefined()
    expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).status).toBe('killed')
  })

  it('edits existing local clips in the requested order without new paid generation', async () => {
    const fixture = await boot()
    const first = join(fixture.workspace, 'first.mp4')
    const second = join(fixture.workspace, 'second.mp4')
    await writeFile(first, '10')
    await writeFile(second, '8')
    const result = await fixture.call('edit_video', { clips: [{ path: second, start_seconds: 2, end_seconds: 7 }, { path: first, start_seconds: 1, end_seconds: 8 }] })
    const jobId = JobId(String(json(result.value).job_id))
    await vi.waitFor(() =>{  expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).status).toBe('completed') })
    const value = JSON.parse(fixture.ctx.jobs.read(jobId, fixture.agent.id).result ?? '{}') as Record<string, unknown>
    expect(value).toMatchObject({ status: 'succeeded', duration_seconds: 12 })
    expect(await readFile(String(value.final_path), 'utf8')).toBe('12')
    expect(fixture.requests).toEqual([])
    const invalid = await fixture.call('edit_video', { clips: [{ path: first, start_seconds: 5, end_seconds: 2 }] })
    expect(json(invalid.value)).toMatchObject({ status: 'failed', code: 'INVALID_TRIM' })
    expect(fixture.requests).toEqual([])
  })

  it('checks account ownership of relative private-cache paths even when the workspace contains account state', async () => {
    const fixture = await boot(false, true)
    const generated = await fixture.call('generate_video_project', { prompt: '茶杯广告', total_duration_seconds: 40 })
    const generatedValue = json(generated.value)
    const jobId = JobId(String(generatedValue.job_id))
    await vi.waitFor(() => { expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).status).toBe('completed') })
    const manifestPath = join(fixture.stateDirectory, String(generatedValue.project_id), 'manifest.json')
    const manifest = json(JSON.parse(await readFile(manifestPath, 'utf8')))
    const segments = manifest.segments
    if (!Array.isArray(segments)) throw new Error('missing saved segments')
    const clipPath = String(json(segments[0]).path)
    manifest.identity = { accountId: 'another-account', sessionFingerprint: 'other-login' }
    await writeFile(manifestPath, JSON.stringify(manifest))
    const result = await fixture.call('edit_video', { clips: [{ path: relative(fixture.workspace, clipPath) }] })
    expect(json(result.value)).toMatchObject({ status: 'failed', code: 'PROJECT_ACCESS_DENIED' })
    expect(fixture.requests).toHaveLength(3)
  })

  it('refuses a second live run of the same durable project', async () => {
    const fixture = await boot()
    fixture.setPending(true)
    const result = await fixture.call('generate_video_project', { prompt: '茶杯广告', total_duration_seconds: 40 })
    const value = json(result.value)
    await vi.waitFor(() =>{  expect(fixture.requests.length).toBe(3) })
    const duplicate = await fixture.call('resume_video_project', { project_id: value.project_id })
    expect(json(duplicate.value)).toMatchObject({ status: 'failed', code: 'PROJECT_ALREADY_RUNNING' })
    expect(fixture.requests).toHaveLength(3)
    fixture.ctx.jobs.kill(JobId(String(value.job_id)), fixture.agent.id)
  })

  it('registers the same production tool schemas from the shipped credits apply path', async () => {
    const fixture = await boot(true)
    const skill = await fixture.ctx.skills.get('yunshu-video-director')
    expect(skill).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } })
    expect(skill?.content).toContain('For explicit timing or complex plans, call list_video_models once')
    expect(skill?.content).toContain('For every new chat video request, use generate_video_project by default, including a single short clip')
    for (const name of ['generate_video', 'generate_video_project', 'video_project_status', 'resume_video_project', 'cancel_video_project', 'edit_video']) expect(fixture.ctx.tools.get(name)).toBeDefined()
    expect(fixture.ctx.tools.get('generate_video_project')?.description).toContain('40-second')
    expect(fixture.ctx.tools.schemas().find(schema => schema.name === 'generate_video')).toMatchSnapshot('single-clip audio and dialogue contract')
    expect(fixture.ctx.tools.schemas().filter(schema => ['generate_video_project', 'video_project_status', 'resume_video_project', 'edit_video'].includes(schema.name))).toMatchSnapshot()
    const denied = await fixture.call('generate_video_project', { prompt: '茶杯', total_duration_seconds: 40 })
    expect(json(denied.value)).toMatchObject({ status: 'failed' })
    expect(fixture.ctx.jobs.list(fixture.agent.id)).toEqual([])
    const credits = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === 'credits')!
    await credits.fiber!.dispose()
    expect(await fixture.ctx.skills.get('yunshu-video-director')).toBeUndefined()
  })
})
