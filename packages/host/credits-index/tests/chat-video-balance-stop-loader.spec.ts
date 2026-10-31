import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import LocalFS from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { CreativeError, CreativeStore } from '../src/creative-store.ts'
import { readVideoProject } from '../src/video-project.ts'
import { registerVideoProjectTools } from '../src/video-project-tools.ts'
import { registerVideoGenerationIntent } from '../src/video-generation-intent.ts'
import { VideoWorkStore } from '../src/video-work-store.ts'
import { VideoSubmissionRejection } from '../src/video-submission-result.ts'
import type { VideoProjectOptions, VideoProjectProvider } from '../src/video-project-types.ts'
import { captureChatVideoBalanceStop } from '../src/chat-video-balance-stop.ts'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { redactSessionSnapshotIds, normalizeSessionSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import { eventLines, toHeaderLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'

const scope = 'a'.repeat(64)
const prompt = { prompt: '海边日落', total_duration_seconds: 5 }
const resources: { ctx: Context; directory: string }[] = []

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    try { await resource.ctx.fiber.dispose() }
    finally { await rm(resource.directory, { recursive: true, force: true }) }
  }
})

/** The PTC binding substrate is scripted; dispatch, attribution, scheduling and the Agent remain real. */
class BindingRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  async run(request: PtcRunSpec) {
    const generate = request.bindings[0]?.functions.generate_video_project
    if (generate === undefined) throw new Error('Missing real video binding')
    await generate(prompt)
    await generate(prompt)
    return { logs: [] }
  }
}

async function boot(script: StreamChunk[][], ptc = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-video-balance-loader-'))
  const ctx = new Context()
  resources.push({ ctx, directory })
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const adapter = new MockAdapter(script)
  let rejectedCode: string | undefined = 'INSUFFICIENT_BALANCE'
  let rejectInJob = false
  let preflights = 0
  let submissions = 0
  let preflightGate: (() => Promise<void>) | undefined
  const provider: VideoProjectProvider = {
    identity: { accountId: '7', sessionFingerprint: 'fixture-login' },
    assertCurrent: async () => {},
    model: async () => ({ id: 'MiniMax-H3', durations: [5] }),
    build: async (_input, model, brief, durationSeconds) => ({ model, prompt: brief, durationSeconds }),
    submit: async () => {
      submissions++
      if (rejectInJob) throw new VideoSubmissionRejection('INSUFFICIENT_BALANCE', '余额不足，请充值', 'not_submitted')
      return { taskId: `accepted-${String(submissions)}` }
    },
    check: async () => ({ status: 'running' }),
    download: async () => { throw new Error('A running task must not be downloaded') },
  }
  const options: VideoProjectOptions = {
    stateDirectory: join(directory, 'projects'), outputDirectory: 'artifacts/videos',
    maxTotalSeconds: 120, maxSegments: 12, pollIntervalMs: 10, taskTimeoutMs: 5_000,
    acquireProvider: async () => provider, accountScope: () => scope,
    editor: () => ({ preflight: async () => {}, probe: async () => ({ durationSeconds: 5 }),
      compose: async () => { throw new Error('A running task must not be composed') } }),
    chatModelChoice: async (input) => {
      preflights++
      await preflightGate?.()
      if (rejectedCode !== undefined) throw new CreativeError(rejectedCode, 400, rejectedCode === 'INSUFFICIENT_BALANCE'
        ? '余额不足，请充值' : '参数需要调整')
      return { input }
    },
  }
  const creative = new CreativeStore({ directory: join(directory, 'creative'), current: async () => provider.identity,
    video: (id, owner) => readVideoProject(options, id, owner.sessionId, owner.workspaceRoot, owner) })
  options.creative = creative
  options.videoWorks = new VideoWorkStore({ directory: join(directory, 'works'), current: async () => provider.identity })
  const Fixture = { name: 'balance-fixture', inject: ['llm', 'tools', 'sessionProjections'], apply(inner: Context) {
    inner.effect(() => inner.llm.registerAdapter(['fixture'], adapter))
    registerVideoGenerationIntent(inner)
    registerVideoProjectTools(inner, options)
    inner.tools.register(defineTool({
      name: 'balance_receipt_fixture', description: 'Supply a normalized unknown submission receipt', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' },
        submission_state: { type: 'string' }, task_id: { type: 'string' }, request_id: { type: 'string' },
        task_ids: { type: 'array', items: { type: 'string' } }, project_id: { type: 'string' }, job_id: { type: 'string' },
        clip_paths: { type: 'array', items: { type: 'string' } },
        actionRequired: { type: 'object', additionalProperties: false, properties: {
          code: { type: 'string', required: true }, scope: { type: 'string' },
        } },
      } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(_args, exec) {
        return captureChatVideoBalanceStop(exec, scope).result({ status: 'unknown', code: 'INSUFFICIENT_BALANCE',
          message: '余额不足，请充值；原提交结果尚未确认，请查询原任务。', submission_state: 'unknown',
          task_id: 'original-task', request_id: 'original-request', task_ids: ['original-task'],
          project_id: 'original-project', job_id: 'original-job', clip_paths: ['artifacts/saved.mp4'] })
      },
    }))
  } }
  const modules = new Map<string, unknown>([
    ['sessions', SessionStore], ['projections', SessionProjections], ['agents', AgentRegistry], ['llm', LlmRuntime],
    ['system-prompt', SystemPrompt], ['tools', Tools], ['jobs', LocalJobs], ['job-tools', JobTools],
    ['agent-loop', AgentLoop], ['fixture', Fixture], ['binding-runtime', BindingRuntime],
    ['fs', LocalFS], ['working-directory', WorkingDirectory],
  ])
  const config = join(directory, 'cordis.yml')
  await writeFile(config, ['- name: sessions', '- name: projections', '- name: agents', '- name: llm', '- name: system-prompt',
    '- name: fs', '- name: working-directory',
    '- name: tools', ...ptc ? ['  config:', '    mode: ptc', '- name: binding-runtime'] : [],
    '- name: jobs', '- name: job-tools', '- name: agent-loop', '  config:', '    agents: []', '- name: fixture', '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const create = (id: string) => ctx.agentLoop.create(SessionId(id), { provider: 'fixture', model: 'fixture' }, { cwd: workspace })
  const send = (agent: Agent, text = '生成一个视频') => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  }
  return { ctx, directory, workspace, adapter, create, send, options,
    get preflights() { return preflights }, get submissions() { return submissions },
    allow: () => { rejectedCode = undefined; rejectInJob = false }, unrelated: () => { rejectedCode = 'OTHER_FAILURE' },
    failInJob: () => { rejectedCode = undefined; rejectInJob = true },
    gate: (wait: () => Promise<void>) => { preflightGate = wait },
  }
}

function batchResponse(firstName = 'generate_video_project', firstArgs: object = prompt): StreamChunk[] {
  const first = toolCallResponse('one', firstName, firstArgs).filter(chunk => chunk.type !== 'finish' && chunk.type !== 'usage')
  const second = toolCallResponse('two', 'generate_video_project', prompt).map(chunk => 'index' in chunk ? { ...chunk, index: 1 } : chunk)
  return [...first, ...second]
}

/** Serialize the real Agent's committed Session, including its embedded model stream. */
function serializedSession(agent: Agent): string {
  return JSON.stringify(toHeaderLine(agent.session.header)) + '\n' + eventLines(agent.session.snapshotEvents())
}

/** Normalize clocks, paths and typed identities, retaining failure text and recovery coordinates. */
function recordedSession(raw: string, workspace: string): string {
  const typed = redactSessionSnapshotIds([raw])[0]
  if (typed === undefined) throw new Error('Missing captured Session')
  return normalizeSessionSnapshot(typed, { sessionIds: [], cwd: workspace }, { identityMode: 'preserve' })
}

describe('balance failure through Loader, Agent, video tools and jobs', () => {
  it('concludes the exact failed submission once without another model request', async () => {
    const f = await boot([toolCallResponse('one', 'generate_video_project', prompt)])
    const agent = await f.create('one')
    f.send(agent)
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.preflights).toBe(1)
    expect(f.submissions).toBe(0)
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.meta).toEqual({ actionRequired: { code: 'INSUFFICIENT_BALANCE', scope } })
    const content = result?.type === 'tool/result' ? result.data.message.content[0] : undefined
    const value: unknown = content?.type === 'text' ? JSON.parse(content.text) : undefined
    expect(value).toMatchObject({ status: 'failed', code: 'INSUFFICIENT_BALANCE', message: '余额不足，请充值',
      actionRequired: { code: 'INSUFFICIENT_BALANCE', scope } })
    expect(value).toHaveProperty('work_id', expect.stringMatching(/^vw_/u))
    expect(value).toHaveProperty('work_request_id', expect.stringMatching(/^vr_/u))
  })

  it('stops a second call in the same batch before another preflight or upstream submission', async () => {
    const f = await boot([batchResponse()])
    const agent = await f.create('batch')
    f.send(agent)
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.preflights).toBe(1)
    expect(f.submissions).toBe(0)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    expect(results.every(event => event.type === 'tool/result' && JSON.stringify(event.data.message.content).includes('INSUFFICIENT_BALANCE'))).toBe(true)
    expect(results[0]?.type === 'tool/result' && results[0].data.message.content)
      .toEqual(results[1]?.type === 'tool/result' && results[1].data.message.content)
  })

  it('propagates the same-submission stop through real PTC nested dispatches', async () => {
    const f = await boot([toolCallResponse('ptc', 'run_code', { description: 'Repeat the same video submission', code: 'scripted double invocation' })], true)
    const agent = await f.create('ptc')
    f.send(agent)
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.preflights).toBe(1)
    expect(f.submissions).toBe(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')).toHaveLength(2)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
  })

  it('preserves an unknown original receipt when another video entry observes the same blocked submission', async () => {
    const f = await boot([batchResponse('balance_receipt_fixture', {})])
    const agent = await f.create('retained-receipt')
    f.send(agent)
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.preflights).toBe(0)
    expect(f.submissions).toBe(0)
    const results: unknown[] = []
    for (const event of agent.session.snapshotEvents()) {
      if (event.type !== 'tool/result') continue
      for (const block of event.data.message.content) {
        if (block.type !== 'text') continue
        const value: unknown = JSON.parse(block.text)
        results.push(value)
      }
    }
    expect(results).toHaveLength(2)
    expect(results[1]).toEqual(results[0])
    expect(results[1]).toMatchObject({ status: 'unknown', submission_state: 'unknown',
      task_id: 'original-task', request_id: 'original-request', task_ids: ['original-task'],
      project_id: 'original-project', job_id: 'original-job', clip_paths: ['artifacts/saved.mp4'],
      actionRequired: { code: 'INSUFFICIENT_BALANCE', scope } })
  })

  it('replays the selected recorded Session and persists the same failure without an extra model continuation', async () => {
    const selected = await readFile(new URL('./expected/chat-video-balance-stop/session.v4.jsonl', import.meta.url), 'utf8')
    const events = parseSessionLog(selected)
    const human = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (human?.type !== 'user/message') throw new Error('Recorded Session has no human input')
    const script = deriveReplayScript(events).map((entry) => {
      if (entry.kind !== 'chunks') throw new Error('Expected a complete recorded model stream')
      return entry.chunks
    })
    expect(script).toHaveLength(1)
    const f = await boot(script)
    const agent = await f.create('recorded-balance-replay')
    f.send(agent, human.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.preflights).toBe(0)
    expect(f.submissions).toBe(0)
    const actualFile = join(f.directory, 'captured-session.v4.jsonl')
    await writeFile(actualFile, serializedSession(agent))
    const saved = await readFile(actualFile, 'utf8')
    const restoredEvents = parseSessionLog(saved)
    const restored = Session.create(SessionId('saved-balance-session'), restoredEvents)
    const expected = Session.create(SessionId('selected-balance-session'), events)
    const modelResults = (session: Session) => session.deriveMessages().flatMap(message => message.role === 'tool'
      ? [{ content: message.content, isError: message.isError }] : [])
    expect(modelResults(restored)).toEqual(modelResults(expected))
    expect(deriveReplayScript(restoredEvents)).toHaveLength(1)
    expect(recordedSession(saved, f.workspace)).toBe(selected)
  })

  it('runs already queued independent human input without cancelling or parking it', async () => {
    const f = await boot([toolCallResponse('first', 'generate_video_project', prompt), textResponse('独立回答')])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    f.gate(async () => { entered.resolve(undefined); await release.promise })
    const agent = await f.create('queued')
    try {
      f.send(agent)
      await entered.promise
      f.send(agent, '介绍一下海边日落')
    } finally { release.resolve(undefined) }
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(2)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event =>
      event.type === 'turn/end' ? event.data.reason.kind : '')).toEqual(['completed', 'completed'])
  })

  it('allows a new real request after funding is restored and leaves another chat independent', async () => {
    const f = await boot([toolCallResponse('first', 'generate_video_project', prompt),
      toolCallResponse('new', 'generate_video_project', prompt), toolCallResponse('other', 'generate_video_project', prompt)])
    const agent = await f.create('funding')
    f.send(agent)
    await agent.whenIdle()
    f.allow()
    f.send(agent, '充值好了，再生成一个视频')
    await agent.whenIdle()
    await vi.waitFor(() => { expect(f.submissions).toBe(1) })
    const other = await f.create('other-chat')
    f.send(other)
    await other.whenIdle()
    await vi.waitFor(() => { expect(f.submissions).toBe(2) })
    expect(f.preflights).toBe(3)
    expect(f.adapter.requests).toHaveLength(3)
  })

  it('retains a background funding failure without an automatic wake and concludes a read without newer human input', async () => {
    const f = await boot([toolCallResponse('start', 'generate_video_project', prompt),
      toolCallResponse('read', 'job_output', { job_id: 'video-project-1', wait: true })])
    f.failInJob()
    const agent = await f.create('background')
    f.send(agent)
    await agent.whenIdle()
    await vi.waitFor(() => { expect(f.ctx.jobs.list(agent.id)[0]).toMatchObject({ status: 'failed',
      actionRequired: { code: 'INSUFFICIENT_BALANCE', scope } }) })
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.inbox.nextStep).toHaveLength(0)
    agent.followup(createUserMessage({ source: { kind: 'tool-jobs', form: 'notice', summary: 'Read original task' },
      content: [{ type: 'text', text: '查看原任务' }] }))
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(2)
    expect(f.submissions).toBe(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)).toMatchObject({
      data: { meta: { jobId: 'video-project-1', actionRequired: { code: 'INSUFFICIENT_BALANCE', scope } } },
    })
  })

  it('lets queued independent human input read an old failed job and then generate its new work', async () => {
    const f = await boot([toolCallResponse('old', 'generate_video_project', prompt),
      toolCallResponse('read-old', 'job_output', { job_id: 'video-project-1' }),
      toolCallResponse('new', 'generate_video_project', prompt)])
    f.failInJob()
    const failed = Promise.withResolvers<undefined>()
    f.ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'settled' && event.job.actionRequired !== undefined) failed.resolve(undefined)
    })
    f.ctx.on('agent/pre-step', async ({ messages }, next) => {
      if (messages.some(message => message.source.kind === 'user' && message.content.some(block =>
        block.type === 'text' && block.text === '充值后先查旧任务，再生成新视频'))) {
        await failed.promise
        f.allow()
      }
      return next()
    })
    const agent = await f.create('queued-read-old')
    f.send(agent)
    f.send(agent, '充值后先查旧任务，再生成新视频')
    await agent.whenIdle()
    await vi.waitFor(() => { expect(f.submissions).toBe(2) })
    expect(f.adapter.requests).toHaveLength(3)
    expect(f.preflights).toBe(2)
    expect(f.ctx.jobs.list(agent.id).map(job => job.status)).toEqual(['failed', 'running'])
    expect(agent.inbox.nextTurn).toHaveLength(0)
    const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const original = users[0]
    expect(f.ctx.jobs.list(agent.id)[0]?.actionRequired?.requestSeq).toBe(original?.seq)
    expect(users).toHaveLength(2)
    const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
    expect(ends.map(event => event.type === 'turn/end' ? event.data.reason.kind : '')).toEqual(['completed', 'completed'])
  })

  it('does not stop model recovery for unrelated structured tool failures', async () => {
    const f = await boot([toolCallResponse('one', 'generate_video_project', prompt), textResponse('调整参数')])
    f.unrelated()
    const agent = await f.create('unrelated')
    f.send(agent)
    await agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(2)
    expect(f.submissions).toBe(0)
    expect(agent.session.snapshotEvents().find(event => event.type === 'tool/result')).toMatchObject({ data: { meta: {} } })
  })
})
