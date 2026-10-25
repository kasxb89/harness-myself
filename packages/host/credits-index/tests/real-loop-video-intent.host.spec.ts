/** Video request ownership through production loop admission and tool scheduling. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-subagent'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import * as AskUser from '@deepseek-ai/dsh-tool-ask-user'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { CreativeStore } from '../src/creative-store.ts'
import { registerCreativeTools } from '../src/creative-tools.ts'
import { registerVideoProjectTools } from '../src/video-project-tools.ts'
import { registerVideoGenerationIntent, videoGenerationIntentOf, type VideoGenerationIntent } from '../src/video-generation-intent.ts'
import { readVideoProject } from '../src/video-project.ts'
import type { VideoEditor } from '../src/video-edit.ts'
import type { VideoProjectInput, VideoProjectOptions, VideoProjectProvider } from '../src/video-project-types.ts'
import expected from './expected/real-loop-video-intent.json' with { type: 'json' }

type ScriptStep = () => StreamChunk[]

class ScriptAdapter extends LlmAdapter {
  constructor(private readonly script: ScriptStep[]) { super() }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const next = this.script.shift()
    if (next === undefined) throw new Error('Unexpected model request after the scripted final reply')
    yield* next()
  }
}

function toolReply(id: string, name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function finalReply(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '已提交本次作品。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a tool result object')
  return value as Record<string, unknown>
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function boot(mode: 'native' | 'ptc' = 'native') {
  const directory = await mkdtemp(join(tmpdir(), 'yunshu-real-loop-video-'))
  cleanup.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  if (mode === 'ptc') {
    await ctx.plugin(FileSystem)
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox)
    await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: workspace })
    await ctx.plugin(WorkingDirectory)
    await ctx.plugin(NodePtcRuntime)
  }
  await ctx.plugin(Tools, { mode })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobs)
  await ctx.plugin(JobTools, { completionDelivery: 'quiet' })
  await ctx.plugin(UserQuestions)
  await ctx.plugin(AskUser, { mode: 'timed', timeout: 1 })
  const events: SessionEvent[] = []
  ctx.on('session/event', (_session, event) => { events.push(event) })
  const grants: { name: string; intent: VideoGenerationIntent | undefined }[] = []
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'generate_video_project') grants.push({ name: exec.name, intent: videoGenerationIntentOf(exec) })
    return next()
  })
  const requests: number[] = []
  const inputs: VideoProjectInput[] = []
  const identity = { accountId: 'real-loop-user', sessionFingerprint: 'isolated-test-login' }
  let unknown = false
  const provider: VideoProjectProvider = {
    identity, assertCurrent: async () => {},
    model: async () => ({ id: 'MiniMax-H3', durations: [5, 10, 15], defaultDuration: 10 }),
    build: async (input, model, prompt, durationSeconds) => {
      inputs.push(input)
      return { model, prompt, durationSeconds }
    },
    submit: async (request) => {
      requests.push(Number(request.durationSeconds))
      if (unknown) throw new Error('Isolated transport failure after possible upstream acceptance')
      return { taskId: `local-task-${String(requests.length)}` }
    },
    check: async () => ({ status: 'succeeded' }),
    download: async (taskId, _request, destination) => {
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, String(requests[Number(taskId.slice(11)) - 1]))
    },
  }
  const editor: VideoEditor = {
    preflight: async () => {}, probe: async path => ({ durationSeconds: Number(await readFile(path, 'utf8')) }),
    compose: async (request) => {
      const lengths = await Promise.all(request.clips.map(async clip => Number(await readFile(clip.path, 'utf8'))))
      const durationSeconds = request.totalDurationSeconds ?? lengths.reduce((sum, value) => sum + value, 0)
      await mkdir(dirname(request.outputPath), { recursive: true })
      await writeFile(request.outputPath, String(durationSeconds))
      return { path: request.outputPath, durationSeconds }
    },
  }
  const options: VideoProjectOptions = {
    stateDirectory: join(directory, 'projects'), outputDirectory: 'artifacts/videos',
    maxTotalSeconds: 300, maxSegments: 32, pollIntervalMs: 1, taskTimeoutMs: 1000,
    acquireProvider: async () => provider, editor: () => editor,
  }
  const creative = new CreativeStore({ directory: join(directory, 'creative'), current: async () => identity,
    video: (id, owner) => readVideoProject(options, id, owner.sessionId, owner.workspaceRoot, owner) })
  options.creative = creative
  registerVideoGenerationIntent(ctx)
  registerCreativeTools(ctx, creative, async () => identity)
  registerVideoProjectTools(ctx, options)
  await ctx.plugin(AgentLoop, { agents: [] })
  const script: ScriptStep[] = []
  ctx.llm.registerAdapter(['local-script'], new ScriptAdapter(script))
  const agent = await ctx.agentLoop.create(SessionId('real-loop-video'), { provider: 'local-script', model: 'local-script' }, { cwd: workspace })
  function result(callId: string): Record<string, unknown> {
    const event = events.findLast(event => event.type === 'tool/result' && event.data.message.toolCallId === callId)
    if (event?.type !== 'tool/result') throw new Error(`No committed tool result for ${callId}`)
    const block = event.data.message.content.find(block => block.type === 'text')
    if (block?.type !== 'text') throw new Error(`No canonical tool result for ${callId}`)
    return object(JSON.parse(block.text))
  }
  async function send(text: string, source: Parameters<typeof createUserMessage>[0]['source'] = { kind: 'user' }, target: Agent = agent): Promise<void> {
    target.followup(createUserMessage({ source, content: [{ type: 'text', text }] }))
    await target.whenIdle()
  }
  async function settled(callId: string, target: Agent = agent): Promise<void> {
    const id = result(callId).job_id
    if (typeof id !== 'string') throw new Error(`Expected background job for ${callId}`)
    const job = await ctx.jobs.wait(JobId(id), 1000, target.id)
    expect(job.status).not.toBe('running')
    expect(job.status).not.toBe('stopping')
  }
  return { ctx, agent, events, result, settled, human: send, send, script, requests, inputs, grants, creative, options, workspace, identity,
    unknown: (value: boolean) => { unknown = value } }
}

const plan = {
  kind: 'video', title: '美剧短片', brief: '一条30秒的美剧风格视频',
  shots: [
    { id: 'shot_01', order: 1, title: '开场', duration_seconds: 15, prompt: '美剧风格开场，持续十五秒。' },
    { id: 'shot_02', order: 2, title: '结尾', duration_seconds: 15, prompt: '美剧风格结尾，持续十五秒。' },
  ],
}

describe('production AgentLoop human video request ownership', () => {
  it('retains one human request through an unavailable old plan, replacement planning and a two-clip project', async () => {
    const f = await boot()
    f.script.push(
      () => toolReply('old-plan', 'update_creation_plan', { ...plan, plan_id: 'cp_9aafb95b-0000-4000-8000-000000000000' }),
      () => toolReply('new-plan', 'update_creation_plan', plan),
      () => toolReply('new-project', 'generate_video_project', {
        plan_id: f.result('new-plan').plan_id, shot_ids: ['shot_01', 'shot_02'],
        prompt: '生成一条30s的美剧视频', total_duration_seconds: 30,
        shot_durations_seconds: [15, 15], model: 'MiniMax-H3', resolution: '768P',
      }),
      finalReply,
    )
    await f.human('生成一条30s的美剧视频')
    expect(f.result('old-plan')).toMatchObject({ status: 'failed' })
    expect(f.result('new-plan')).toMatchObject({ status: 'saved' })
    expect(f.result('new-project')).toMatchObject({ status: 'background', plan_seconds: [15, 15], remaining_works: 0 })
    await vi.waitFor(() => { expect(f.requests).toEqual([15, 15]) })
    await f.settled('new-project')
    expect(f.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(f.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    const projects = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    expect(projects.flatMap(project => project.tasks)).toHaveLength(1)
    expect(f.inputs.every(input => input.totalDurationSeconds === 30)).toBe(true)
  })

  it('retains the original single-work request when a real late question answer opens a later turn', async () => {
    const f = await boot()
    f.script.push(
      () => toolReply('ask-style', 'ask_user_question', {
        questions: [{ id: 'style', question: '沿用美剧风格吗？', options: [{ label: '是' }] }],
      }),
      finalReply,
    )
    await f.human('生成一条30s的美剧视频')
    expect(f.result('ask-style')).toMatchObject({ pending: true, callId: 'ask-style' })
    f.script.push(
      () => toolReply('answered-plan', 'update_creation_plan', plan),
      () => toolReply('answered-project', 'generate_video_project', {
        plan_id: f.result('answered-plan').plan_id, shot_ids: ['shot_01', 'shot_02'],
        prompt: '一条30秒美剧风格成片。', total_duration_seconds: 30,
        shot_durations_seconds: [15, 15], model: 'MiniMax-H3', resolution: '768P',
      }),
      finalReply,
    )
    expect(f.ctx.userQuestions.answer(f.agent, ToolCallId('ask-style'), {
      answers: [{ id: 'style', selected: ['是'] }],
    })).toBe(true)
    await f.agent.whenIdle()
    expect(f.result('answered-project').code, JSON.stringify(f.result('answered-project'))).toBeUndefined()
    expect(f.result('answered-project')).toMatchObject({ status: 'background', plan_seconds: [15, 15], remaining_works: 0 })
    await vi.waitFor(() => { expect(f.requests).toEqual([15, 15]) })
    await f.settled('answered-project')
    expect(f.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(f.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(f.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user-question-reply')).toHaveLength(1)
    const projects = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    expect(projects.flatMap(project => project.tasks)).toHaveLength(1)
    const grant = f.grants[0]?.intent
    const human = f.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (human?.type !== 'user/message' || grant === undefined) throw new Error('Expected the original human attribution')
    const generation = f.result('answered-project')
    expect({
      question: { pending: f.result('ask-style').pending },
      generation: { status: generation.status, plan_seconds: generation.plan_seconds, remaining_works: generation.remaining_works },
      attribution: { requestSource: human.data.source.kind, sameOriginalMessage: grant.grant.messageId === human.data.id,
        sourceSeqMatches: grant.grant.sourceSeq === human.seq, requestTurn: grant.grant.turn, workCount: grant.grant.maxWorks,
        requestedDurationSeconds: grant.requestedDurationSeconds },
      providerSeconds: f.requests, workCount: projects.flatMap(project => project.tasks).length,
      turnCount: f.events.filter(event => event.type === 'turn/start').length,
    }).toEqual(expected.lateQuestion)
  })

  it.each(['agent-message', 'tool-jobs'] as const)('does not grant paid work to a late answer to a question initiated by %s', async (source) => {
    const f = await boot()
    f.script.push(finalReply)
    await f.human('生成3条15秒视频')
    f.script.push(
      () => toolReply('notice-question', 'ask_user_question', {
        questions: [{ id: 'style', question: '是否沿用风格？', options: [{ label: '是' }] }],
      }),
      finalReply,
    )
    await f.send('生成一条15秒视频', source === 'agent-message'
      ? { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('other-local-chat') }
      : { kind: 'tool-jobs', form: 'notice', summary: 'Existing job finished' })
    f.script.push(() => toolReply('notice-generation', 'generate_video_project', {
      prompt: '来自其他聊天或任务通知的请求', total_duration_seconds: 15,
    }), finalReply)
    expect(f.ctx.userQuestions.answer(f.agent, ToolCallId('notice-question'), {
      answers: [{ id: 'style', selected: ['是'] }],
    })).toBe(true)
    await f.agent.whenIdle()
    expect(f.result('notice-generation')).toMatchObject(expected.noticeDenied)
    expect(f.requests).toEqual([])
    expect(f.inputs).toEqual([])
    expect(await f.creative.projects({ ...f.identity, sessionId: f.agent.id })).toEqual([])
  })

  it('allows a new human work beside an unknown earlier submission and resumes the original without another submit', async () => {
    const f = await boot()
    f.unknown(true)
    f.script.push(() => toolReply('unknown-project', 'generate_video_project', {
      prompt: '第一条独立请求', total_duration_seconds: 15,
    }))
    await f.human('生成一条15秒视频')
    expect(f.result('unknown-project')).toMatchObject({ status: 'background', remaining_works: 0 })
    await f.settled('unknown-project')
    expect(f.requests).toEqual([15])
    f.unknown(false)
    f.script.push(() => toolReply('independent-project', 'generate_video_project', {
      prompt: '第二条独立请求', total_duration_seconds: 15,
    }))
    await f.human('再生成一条15秒视频')
    expect(f.result('independent-project')).toMatchObject({ status: 'background', remaining_works: 0 })
    await f.settled('independent-project')
    expect(f.requests).toEqual([15, 15])
    expect(f.result('independent-project').project_id).not.toBe(f.result('unknown-project').project_id)
    f.script.push(() => toolReply('resume-unknown', 'resume_video_project', {
      project_id: f.result('unknown-project').project_id,
    }), finalReply)
    await f.human('继续查询第一条原任务，不要重新生成')
    expect(f.result('resume-unknown')).toMatchObject({ status: 'background' })
    await f.settled('resume-unknown')
    expect(f.requests).toEqual([15, 15])
  })

  it('carries a late question reply through real run_code subprocess bindings and logs the nested generation', async () => {
    const f = await boot('ptc')
    f.script.push(() => toolReply('ptc-question', 'run_code', {
      description: '询问视频风格',
      code: 'return await tools.ask_user_question({questions:[{id:"style",question:"沿用美剧风格吗？",options:[{label:"是"}]}]});',
    }), finalReply)
    await f.human('生成一条30s的美剧视频')
    const pending = f.result('ptc-question')
    expect(pending.pending).toBe(true)
    if (typeof pending.callId !== 'string') throw new Error('Expected the real nested pending question id')
    const generationArgs = {
      prompt: '一条30秒美剧风格成片。', total_duration_seconds: 30,
      shot_durations_seconds: [15, 15], model: 'MiniMax-H3', resolution: '768P',
    }
    f.script.push(() => toolReply('ptc-generation', 'run_code', {
      description: '创建并生成一条30秒成片',
      code: `const plan=await tools.update_creation_plan(${JSON.stringify(plan)}); return await tools.generate_video_project({...${JSON.stringify(generationArgs)},plan_id:plan.plan_id,shot_ids:["shot_01","shot_02"]});`,
    }), finalReply)
    expect(f.ctx.userQuestions.answer(f.agent, ToolCallId(pending.callId), {
      answers: [{ id: 'style', selected: ['是'] }],
    })).toBe(true)
    await f.agent.whenIdle()
    expect(f.result('ptc-generation')).toMatchObject({ status: 'background', plan_seconds: [15, 15], remaining_works: 0 })
    await f.settled('ptc-generation')
    expect(f.requests).toEqual([15, 15])
    expect(f.events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'generate_video_project')).toBe(true)
  })

  it('starts a real human request in another chat even when the first chat has an unknown submission', async () => {
    const f = await boot()
    f.unknown(true)
    f.script.push(() => toolReply('first-chat-unknown', 'generate_video_project', {
      prompt: '原聊天里结果未知的任务', total_duration_seconds: 15,
    }))
    await f.human('生成一条15秒视频')
    expect(f.result('first-chat-unknown')).toMatchObject({ status: 'background', remaining_works: 0 })
    await f.settled('first-chat-unknown')
    expect(f.requests).toEqual([15])
    const other = await f.ctx.agentLoop.create(SessionId('another-human-chat'), {
      provider: 'local-script', model: 'local-script',
    }, { cwd: f.workspace })
    f.unknown(false)
    f.script.push(() => toolReply('other-chat-project', 'generate_video_project', {
      prompt: '另一聊天中的真人独立请求', total_duration_seconds: 15,
    }))
    await f.send('生成一条15秒视频', { kind: 'user' }, other)
    expect(f.result('other-chat-project')).toMatchObject({ status: 'background', remaining_works: 0 })
    await f.settled('other-chat-project', other)
    expect(f.requests).toEqual([15, 15])
    expect(f.result('other-chat-project').project_id).not.toBe(f.result('first-chat-unknown').project_id)
    const original = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    const independent = await f.creative.projects({ ...f.identity, sessionId: other.id })
    expect(original.flatMap(project => project.tasks)).toHaveLength(1)
    expect(independent.flatMap(project => project.tasks)).toHaveLength(1)
  })
})
