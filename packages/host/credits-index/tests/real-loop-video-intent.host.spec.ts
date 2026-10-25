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
import { VideoWorkStore } from '../src/video-work-store.ts'
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
  return toolReplies([{ id, name, args }])
}

function toolReplies(calls: readonly { id: string; name: string; args: object }[]): StreamChunk[] {
  return [
    ...calls.flatMap(({ id, name, args }, index): StreamChunk[] => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    ]),
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

function preparedWorks(value: Record<string, unknown>): { work_id: string; index: number; state: string }[] {
  expect(value.status).toBe('prepared')
  expect(typeof value.work_request_id).toBe('string')
  if (!Array.isArray(value.works)) throw new Error('Expected the concrete prepared work list')
  return value.works.map((value) => {
    const work = object(value)
    if (typeof work.work_id !== 'string' || typeof work.index !== 'number' || typeof work.state !== 'string') {
      throw new Error('Expected a complete prepared work identity')
    }
    return { work_id: work.work_id, index: work.index, state: work.state }
  })
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function boot(mode: 'native' | 'ptc' = 'native', restore?: { directory: string; seed: readonly SessionEvent[] }) {
  const directory = restore?.directory ?? await mkdtemp(join(tmpdir(), 'yunshu-real-loop-video-'))
  if (restore === undefined) cleanup.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
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
    videoWorks: new VideoWorkStore({ directory: join(directory, 'works'), current: async () => identity }),
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
  const agent = restore === undefined
    ? await ctx.agentLoop.create(SessionId('real-loop-video'), { provider: 'local-script', model: 'local-script' }, { cwd: workspace })
    : (await ctx.agents.create({ sessionId: SessionId('real-loop-video'), seed: restore.seed,
      agentOptions: { provider: 'local-script', model: 'local-script' }, meta: { cwd: workspace } })).agent
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
  return { ctx, agent, events, result, settled, human: send, send, script, requests, inputs, grants,
    creative, options, workspace, directory, identity,
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
    expect(grant.grant.maxWorks).toBeUndefined()
    expect({
      question: { pending: f.result('ask-style').pending },
      generation: { status: generation.status, plan_seconds: generation.plan_seconds, remaining_works: generation.remaining_works },
      attribution: { requestSource: human.data.source.kind, sameOriginalMessage: grant.grant.messageId === human.data.id,
        sourceSeqMatches: grant.grant.sourceSeq === human.seq, requestTurn: grant.grant.turn,
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

  it('reuses the explicit unknown work across changed call ids and human follow-ups without another submission', async () => {
    const f = await boot()
    f.unknown(true)
    f.script.push(() => toolReply('continued-unknown', 'generate_video_project', {
      prompt: '已提交但未能确认上游响应的原作品', total_duration_seconds: 15,
    }))
    await f.human('生成一条15秒视频')
    expect(f.result('continued-unknown')).toMatchObject({ status: 'background', remaining_works: 0 })
    await f.settled('continued-unknown')
    const original = f.grants[0]?.intent?.grant
    if (original === undefined) throw new Error('Expected the original human request grant')
    const workId = f.result('continued-unknown').work_id
    expect(typeof workId).toBe('string')
    expect(f.requests).toEqual([15])
    for (const [index, text] of ['好的开始吧', '继续生成这个视频'].entries()) {
      const call = `continued-retry-${String(index)}`
      f.script.push(() => toolReply(call, 'generate_video_project', {
        prompt: '普通确认仍对应同一原作品', total_duration_seconds: 15, work_id: workId,
      }), finalReply)
      await f.human(text)
      expect(f.result(call)).toMatchObject({ status: 'existing', work_id: workId,
        project_id: f.result('continued-unknown').project_id })
      expect(f.grants.at(-1)?.intent?.grant.messageId).not.toBe(original.messageId)
      expect(f.grants.at(-1)?.intent?.grant.maxWorks).toBeUndefined()
      expect(f.requests).toEqual([15])
    }
    f.unknown(false)
    f.script.push(() => toolReply('continued-new-human', 'generate_video_project', {
      prompt: '用户明确追加的独立作品', total_duration_seconds: 15,
    }))
    await f.human('再生成一条15秒视频')
    expect(f.result('continued-new-human')).toMatchObject({ status: 'background', remaining_works: 0 })
    await f.settled('continued-new-human')
    expect(f.grants.at(-1)?.intent?.grant.messageId).not.toBe(original.messageId)
    expect(f.grants.at(-1)?.intent?.grant.sourceSeq).not.toBe(original.sourceSeq)
    expect(f.requests).toEqual([15, 15])
    f.script.push(() => toolReply('continued-resume-original', 'resume_video_project', {
      project_id: f.result('continued-unknown').project_id,
    }), finalReply)
    await f.human('继续查询第一条原任务，不要重新生成')
    expect(f.result('continued-resume-original')).toMatchObject({ status: 'background' })
    await f.settled('continued-resume-original')
    expect(f.requests).toEqual([15, 15])
    const projects = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    expect(projects.flatMap(project => project.tasks)).toHaveLength(2)
  })

  it('prepares three stable work ids and submits each once without enlarging the same source batch', async () => {
    const f = await boot()
    f.script.push(
      () => toolReply('three-works', 'prepare_video_works', { count: 3 }),
      () => toolReply('same-three-works', 'prepare_video_works', { count: 5 }),
      ...[0, 1, 2].map(index => () => toolReply(`prepared-generation-${String(index)}`, 'generate_video_project', {
        work_id: preparedWorks(f.result('three-works'))[index]?.work_id,
        prompt: `三条作品中的第${String(index + 1)}条`, total_duration_seconds: 15,
      })),
    )
    await f.human('这个故事做三个不同版本吧')
    const prepared = preparedWorks(f.result('three-works'))
    const repeated = preparedWorks(f.result('same-three-works'))
    expect(prepared).toHaveLength(3)
    expect(repeated).toEqual(prepared)
    expect(f.result('same-three-works').work_request_id).toBe(f.result('three-works').work_request_id)
    expect(new Set(prepared.map(work => work.work_id)).size).toBe(3)
    for (const [index, work] of prepared.entries()) {
      const call = `prepared-generation-${String(index)}`
      expect(f.result(call)).toMatchObject({ status: 'background', work_id: work.work_id,
        work_request_id: f.result('three-works').work_request_id, remaining_works: 2 - index,
        pending_work_ids: prepared.slice(index + 1).map(work => work.work_id) })
      await f.settled(call)
    }
    expect(f.requests).toEqual([15, 15, 15])
    expect(new Set(prepared.map((_work, index) => f.result(`prepared-generation-${String(index)}`).project_id)).size).toBe(3)
    f.script.push(() => toolReply('prepared-repeat-first', 'generate_video_project', {
      prompt: '复查已有第一条作品', total_duration_seconds: 15, work_id: prepared[0]?.work_id,
    }), finalReply)
    await f.human('第一条继续看原任务')
    expect(f.result('prepared-repeat-first')).toMatchObject({ status: 'existing', work_id: prepared[0]?.work_id,
      project_id: f.result('prepared-generation-0').project_id })
    expect(f.requests).toEqual([15, 15, 15])
    const projects = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    expect(projects.flatMap(project => project.tasks)).toHaveLength(3)
  })

  it('appends two works after a real late quantity answer without restarting the original unknown work', async () => {
    const f = await boot()
    f.unknown(true)
    f.script.push(
      () => toolReply('before-quantity-answer', 'prepare_video_works', {}),
      () => toolReplies([
        { id: 'ask-final-quantity', name: 'ask_user_question', args: {
          questions: [{ id: 'count', question: '这次总共做几条？', options: [{ label: '一条' }, { label: '三条' }] }],
        } },
        { id: 'quantity-original-unknown', name: 'generate_video_project', args: {
          work_id: preparedWorks(f.result('before-quantity-answer'))[0]?.work_id,
          prompt: '已提交的第一条作品', total_duration_seconds: 15,
        } },
      ]),
    )
    await f.human('先准备一条15秒视频，稍后再定作品总数')
    expect(f.result('ask-final-quantity')).toMatchObject({ pending: true })
    expect(f.result('quantity-original-unknown')).toMatchObject({ status: 'background' })
    await f.settled('quantity-original-unknown')
    expect(f.requests).toEqual([15])
    const original = f.result('quantity-original-unknown')
    const originalSource = f.grants[0]?.intent?.grant
    if (originalSource === undefined) throw new Error('Expected the original human source')
    f.unknown(false)
    f.script.push(
      () => toolReply('quantity-append-two', 'append_video_works', { count: 2 }),
      () => toolReply('quantity-repeat-two', 'append_video_works', { count: 2 }),
      () => toolReply('quantity-repeat-three', 'append_video_works', { count: 3 }),
      () => toolReply('quantity-query-original', 'generate_video_project', {
        work_id: original.work_id, prompt: '继续读取第一条原任务', total_duration_seconds: 15,
      }),
      ...[1, 2].map(index => () => toolReply(`quantity-new-${String(index)}`, 'generate_video_project', {
        work_id: preparedWorks(f.result('quantity-append-two'))[index]?.work_id,
        prompt: `追加作品中的第${String(index)}条`, total_duration_seconds: 15,
      })),
    )
    expect(f.ctx.userQuestions.answer(f.agent, ToolCallId('ask-final-quantity'), {
      answers: [{ id: 'count', selected: ['三条'] }],
    })).toBe(true)
    await f.agent.whenIdle()
    const appended = preparedWorks(f.result('quantity-append-two'))
    expect(appended).toHaveLength(3)
    expect(appended[0]?.work_id).toBe(original.work_id)
    expect(new Set(appended.map(work => work.work_id)).size).toBe(3)
    expect(preparedWorks(f.result('quantity-repeat-two'))).toEqual(appended)
    expect(preparedWorks(f.result('quantity-repeat-three'))).toEqual(appended)
    for (const call of ['quantity-append-two', 'quantity-repeat-two', 'quantity-repeat-three']) {
      expect(f.result(call).work_request_id).toBe(original.work_request_id)
      expect(f.result(call).pending_work_ids).toEqual(appended.slice(1).map(work => work.work_id))
    }
    expect(f.result('quantity-query-original')).toMatchObject({ status: 'existing', work_id: original.work_id,
      project_id: original.project_id, operation_id: original.operation_id })
    const reply = f.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user-question-reply')
    if (reply?.type !== 'user/message') throw new Error('Expected the actual committed quantity reply')
    for (const captured of f.grants.slice(1)) {
      expect(captured.intent?.grant).toMatchObject({
        messageId: originalSource.messageId, sourceSeq: originalSource.sourceSeq, turn: originalSource.turn,
      })
      expect(captured.intent?.humanRevision).toEqual({ messageId: reply.data.id, seq: reply.seq })
    }
    for (const index of [1, 2]) {
      const call = `quantity-new-${String(index)}`
      expect(f.result(call)).toMatchObject({ status: 'background', work_id: appended[index]?.work_id,
        work_request_id: original.work_request_id, remaining_works: 2 - index })
      await f.settled(call)
    }
    expect(f.requests).toEqual([15, 15, 15])
    const projects = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    expect(projects.flatMap(project => project.tasks)).toHaveLength(3)
  })

  it('allows a late human answer to use only one of three prepared works without forcing the other two to submit', async () => {
    const f = await boot()
    f.script.push(
      () => toolReply('before-reduced-quantity', 'prepare_video_works', { count: 3 }),
      () => toolReply('ask-reduced-quantity', 'ask_user_question', {
        questions: [{ id: 'count', question: '最终需要几条？', options: [{ label: '只要一条' }, { label: '三条' }] }],
      }),
      finalReply,
    )
    await f.human('先准备三个视频版本')
    expect(f.result('ask-reduced-quantity')).toMatchObject({ pending: true })
    expect(f.requests).toEqual([])
    const prepared = preparedWorks(f.result('before-reduced-quantity'))
    expect(prepared).toHaveLength(3)
    f.script.push(() => toolReply('only-requested-work', 'generate_video_project', {
      work_id: prepared[0]?.work_id, prompt: '用户最终只需要这一条', total_duration_seconds: 15,
    }), finalReply)
    expect(f.ctx.userQuestions.answer(f.agent, ToolCallId('ask-reduced-quantity'), {
      answers: [{ id: 'count', selected: ['只要一条'] }],
    })).toBe(true)
    await f.agent.whenIdle()
    expect(f.result('only-requested-work')).toMatchObject({ status: 'background', work_id: prepared[0]?.work_id,
      remaining_works: 2, pending_work_ids: prepared.slice(1).map(work => work.work_id) })
    await f.settled('only-requested-work')
    expect(f.requests).toEqual([15])
    expect(f.script).toEqual([])
    const projects = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    expect(projects.flatMap(project => project.tasks)).toHaveLength(1)
  })

  it('reuses the default work across calls with different ids in the same model step', async () => {
    const f = await boot()
    f.script.push(() => toolReplies(['parallel-a', 'parallel-b'].map(id => ({
      id, name: 'generate_video_project', args: { prompt: '同一次提交的同一条作品', total_duration_seconds: 15 },
    }))), finalReply)
    await f.human('给我来一段15秒动画')
    const results = ['parallel-a', 'parallel-b'].map(call => ({ call, result: f.result(call) }))
    expect(new Set(results.map(({ result }) => result.work_id)).size).toBe(1)
    expect(new Set(results.map(({ result }) => result.work_request_id)).size).toBe(1)
    expect(results.filter(({ result }) => result.status === 'background')).toHaveLength(1)
    expect(results.filter(({ result }) => result.status === 'existing')).toHaveLength(1)
    const started = results.find(({ result }) => result.status === 'background')
    if (started === undefined) throw new Error('Expected exactly one original background project')
    expect(typeof started.result.work_id).toBe('string')
    await f.settled(started.call)
    expect(f.requests).toEqual([15])
    const projects = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    expect(projects.flatMap(project => project.tasks)).toHaveLength(1)
  })

  it('keeps an unknown default work through a real late question answer even when the model changes its call id', async () => {
    const f = await boot()
    f.unknown(true)
    f.script.push(() => toolReplies([
      { id: 'unknown-pending-question', name: 'ask_user_question', args: {
        questions: [{ id: 'followup', question: '后续继续按这个方案吗？', options: [{ label: '是' }] }],
      } },
      { id: 'unknown-before-answer', name: 'generate_video_project', args: {
        prompt: '等待答复期间已提交的原作品', total_duration_seconds: 15,
      } },
    ]))
    await f.human('给我来一段15秒动画')
    expect(f.result('unknown-pending-question')).toMatchObject({ pending: true })
    expect(f.result('unknown-before-answer')).toMatchObject({ status: 'background' })
    await f.settled('unknown-before-answer')
    expect(f.requests).toEqual([15])
    f.unknown(false)
    f.script.push(() => toolReply('unknown-after-answer', 'generate_video_project', {
      prompt: '答复后读取同一默认作品', total_duration_seconds: 15,
    }), finalReply)
    expect(f.ctx.userQuestions.answer(f.agent, ToolCallId('unknown-pending-question'), {
      answers: [{ id: 'followup', selected: ['是'] }],
    })).toBe(true)
    await f.agent.whenIdle()
    expect(f.result('unknown-after-answer')).toMatchObject({ status: 'existing',
      work_id: f.result('unknown-before-answer').work_id,
      work_request_id: f.result('unknown-before-answer').work_request_id,
      project_id: f.result('unknown-before-answer').project_id,
    })
    expect(f.requests).toEqual([15])
    expect(f.grants.at(-1)?.intent?.grant.messageId).toBe(f.grants[0]?.intent?.grant.messageId)
    const projects = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    expect(projects.flatMap(project => project.tasks)).toHaveLength(1)
  })

  it('defaults preparation to one concrete work and does not enlarge it under a changed call id', async () => {
    const f = await boot()
    f.script.push(
      () => toolReply('default-work', 'prepare_video_works', {}),
      () => toolReply('changed-count', 'prepare_video_works', { count: 3 }),
      finalReply,
    )
    await f.human('那就按这个故事出片吧')
    const prepared = preparedWorks(f.result('default-work'))
    expect(prepared).toHaveLength(1)
    expect(preparedWorks(f.result('changed-count'))).toEqual(prepared)
    expect(f.result('changed-count').work_request_id).toBe(f.result('default-work').work_request_id)
    expect(f.requests).toEqual([])
    expect(await f.creative.projects({ ...f.identity, sessionId: f.agent.id })).toEqual([])
  })

  it('reads the original linked work after rebuilding the real Host services on the retained private state', async () => {
    const first = await boot()
    first.script.push(() => toolReply('before-restart', 'generate_video_project', {
      prompt: '完整保留以便重启查看的原作品', total_duration_seconds: 15,
    }))
    await first.human('给我来一段15秒动画')
    expect(first.result('before-restart')).toMatchObject({ status: 'background' })
    await first.settled('before-restart')
    expect(first.requests).toEqual([15])
    const original = first.result('before-restart')
    const seed = first.agent.session.snapshotEvents()
    await first.ctx.fiber.dispose()
    const restored = await boot('native', { directory: first.directory, seed })
    restored.script.push(() => toolReply('after-restart', 'generate_video_project', {
      prompt: '重启后继续读取原作品', total_duration_seconds: 15, work_id: original.work_id,
    }), finalReply)
    await restored.human('继续看原作品')
    expect(restored.result('after-restart')).toMatchObject({ status: 'existing', work_id: original.work_id,
      work_request_id: original.work_request_id, project_id: original.project_id })
    expect(restored.requests).toEqual([])
    const projects = await restored.creative.projects({ ...restored.identity, sessionId: restored.agent.id })
    expect(projects.flatMap(project => project.tasks)).toHaveLength(1)
  })

  it.each(['给我来一段15秒动画', '那就按这个故事出片吧'])(
    'does not require an NLP creation phrase to create a default work for %s', async (text) => {
      const f = await boot()
      f.script.push(() => toolReply('unrestricted-human', 'generate_video_project', {
        prompt: '按真人上下文生成一条作品', total_duration_seconds: 15,
      }))
      await f.human(text)
      expect(f.result('unrestricted-human')).toMatchObject({ status: 'background', remaining_works: 0 })
      expect(typeof f.result('unrestricted-human').work_id).toBe('string')
      await f.settled('unrestricted-human')
      expect(f.requests).toEqual([15])
    },
  )

  it('creates separate works for two real human requests with the same prompt, saved plan and shots', async () => {
    const f = await boot()
    const args = () => ({
      plan_id: f.result('same-plan').plan_id, shot_ids: ['shot_01'], prompt: '完全相同的作品提示词',
      total_duration_seconds: 15, shot_durations_seconds: [15], model: 'MiniMax-H3', resolution: '768P',
    })
    f.script.push(
      () => toolReply('same-plan', 'update_creation_plan', {
        kind: 'video', title: '同一计划', brief: '允许真人独立发起两次',
        shots: [{ id: 'shot_01', order: 1, title: '同一镜头', duration_seconds: 15, prompt: '完全相同的镜头提示词' }],
      }),
      () => toolReply('same-request-first', 'generate_video_project', args()),
    )
    await f.human('生成一条15秒视频')
    expect(f.result('same-request-first')).toMatchObject({ status: 'background' })
    await f.settled('same-request-first')
    f.script.push(() => toolReply('same-request-second', 'generate_video_project', args()))
    await f.human('生成一条15秒视频')
    expect(f.result('same-request-second')).toMatchObject({ status: 'background' })
    await f.settled('same-request-second')
    expect(f.result('same-request-second').work_id).not.toBe(f.result('same-request-first').work_id)
    expect(f.result('same-request-second').work_request_id).not.toBe(f.result('same-request-first').work_request_id)
    expect(f.result('same-request-second').project_id).not.toBe(f.result('same-request-first').project_id)
    expect(f.requests).toEqual([15, 15])
    const projects = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    expect(projects.flatMap(project => project.tasks)).toHaveLength(2)
  })

  it.each(['agent-message', 'tool-jobs'] as const)(
    'does not prepare new work from a %s notice', async (source) => {
      const f = await boot()
      f.script.push(() => toolReply('notice-prepare', 'prepare_video_works', { count: 3 }), finalReply)
      await f.send('给我来三个视频', source === 'agent-message'
        ? { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('notice-other-chat') }
        : { kind: 'tool-jobs', form: 'notice', summary: 'A background task finished' })
      expect(f.result('notice-prepare')).toMatchObject({ status: 'failed' })
      expect(f.result('notice-prepare').works).toBeUndefined()
      expect(f.requests).toEqual([])
      expect(await f.creative.projects({ ...f.identity, sessionId: f.agent.id })).toEqual([])
    },
  )

  it('does not treat a delegated child user-labelled message as a new human work source', async () => {
    const f = await boot()
    const child = (await f.ctx.agents.create({ sessionId: SessionId('delegated-video-child'), parentAgent: f.agent,
      meta: { cwd: f.workspace, origin: 'subagent', parentSession: f.agent.id },
      agentOptions: { provider: 'local-script', model: 'local-script' } })).agent
    f.script.push(() => toolReply('child-prepare', 'prepare_video_works', { count: 3 }), finalReply)
    await f.send('给我来三个视频', { kind: 'user' }, child)
    expect(f.result('child-prepare')).toMatchObject({ status: 'failed' })
    expect(f.result('child-prepare').works).toBeUndefined()
    expect(f.requests).toEqual([])
    expect(await f.creative.projects({ ...f.identity, sessionId: child.id })).toEqual([])
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
      prompt: '两个聊天各自独立的同一提示词', total_duration_seconds: 15,
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
      prompt: '两个聊天各自独立的同一提示词', total_duration_seconds: 15,
    }))
    await f.send('生成一条15秒视频', { kind: 'user' }, other)
    expect(f.result('other-chat-project')).toMatchObject({ status: 'background', remaining_works: 0 })
    await f.settled('other-chat-project', other)
    expect(f.requests).toEqual([15, 15])
    expect(f.result('other-chat-project').work_id).not.toBe(f.result('first-chat-unknown').work_id)
    expect(f.result('other-chat-project').project_id).not.toBe(f.result('first-chat-unknown').project_id)
    const original = await f.creative.projects({ ...f.identity, sessionId: f.agent.id })
    const independent = await f.creative.projects({ ...f.identity, sessionId: other.id })
    expect(original.flatMap(project => project.tasks)).toHaveLength(1)
    expect(independent.flatMap(project => project.tasks)).toHaveLength(1)
  })
})
