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
import { ToolCallId } from '@deepseek-ai/dsh-llm'
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

let context: Context | undefined
let directory: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function boot(production = false, workspaceIncludesState = false, managedOutput = false) {
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
    model: async () => ({ id: 'fixture-video', durations: [5, 10, 15] }),
    build: async (input, model, prompt, durationSeconds) => { inputs.push(input); return { model, prompt, durationSeconds } },
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
    registerCreativeTools(ctx, creative, async () => provider.identity)
    registerVideoProjectTools(ctx, options)
  } }
  const modules = new Map<string, unknown>([
    ['system-prompt', SystemPrompt], ['skills', Skills], ['tools', Tools], ['agents', AgentRegistry], ['jobs', LocalJobs], ['job-tools', JobTools],
    ['video-fixture', VideoFixture], ['credits', Credits], ['webserver', WebServer], ['artifacts', Artifacts],
  ])
  const path = join(directory, 'cordis.yml')
  await writeFile(path, [
    '- name: system-prompt', '- name: tools', '- name: agents', '- name: jobs', '- name: job-tools',
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
  let callIndex = 0
  const call = (name: string, args: unknown, signal = new AbortController().signal) => ctx.tools.execute({ callId: ToolCallId(`video-${String(++callIndex)}`), name, arguments: args, agent, signal })
  return {
    ctx, agent, call, requests, inputs, composedPaths, workspace, stateDirectory: options.stateDirectory, creative,
    setPending: (value: boolean) => { pending = value },
    setUnknown: () => { unknownSubmission = true },
  }
}

/** Read canonical success without asking model clients to parse prose. */
function json(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected canonical object')
  return value as Record<string, unknown>
}

describe('video tools through Loader, real tool registry and jobs runtime', () => {
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
    ], outputs: [{ kind: 'video', previewUnavailable: true }] })
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
    expect(fixture.requests).toEqual([15, 15, 10])
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
    expect(fixture.inputs).toEqual([{ prompt: 'A speaks Mandarin', totalDurationSeconds: 5, audio: true, referenceAudios: ['voice.wav', 'ma_voice'] }])
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
    const status = await fixture.call('video_project_status', { project_id: value.project_id })
    const canonical = json(status.value)
    expect(canonical.status).toBe('completed')
    expect(await readFile(String(canonical.final_path), 'utf8')).toBe('40')
    const tool = fixture.ctx.tools.get('generate_video_project')!
    expect(tool.presentCall?.({ prompt: '制作一个茶杯广告', total_duration_seconds: 40 })).toMatchSnapshot()
    expect(tool.presentCall?.({ invalid: true })).toBeUndefined()
    expect(tool.presentResult?.({ prompt: '制作一个茶杯广告', total_duration_seconds: 40 }, { content: [], isError: false })).toEqual({ card: 'generic', title: '视频项目', content: [] })
  })

  it('keeps a published job alive when the completed tool call signal later aborts, and job_kill stops it', async () => {
    const fixture = await boot()
    fixture.setPending(true)
    const abort = new AbortController()
    const result = await fixture.call('generate_video_project', { prompt: '一个茶杯', total_duration_seconds: 40 }, abort.signal)
    const jobId = JobId(String(json(result.value).job_id))
    abort.abort()
    await vi.waitFor(() =>{  expect(fixture.requests.length).toBe(1) })
    expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).status).toBe('running')
    const killed = await fixture.call('job_kill', { job_id: jobId })
    expect(killed.isError).toBe(false)
    await vi.waitFor(() =>{  expect(fixture.ctx.jobs.get(jobId, fixture.agent.id).status).toBe('killed') })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.ctx.jobs.read(jobId, fixture.agent.id).result).toContain('可能继续运行并计费')
  })

  it('unregisters every contribution and cancels owned work when the Loader entry is disposed', async () => {
    const fixture = await boot()
    fixture.setPending(true)
    const result = await fixture.call('generate_video_project', { prompt: '一个茶杯', total_duration_seconds: 40 })
    const jobId = JobId(String(json(result.value).job_id))
    await vi.waitFor(() =>{  expect(fixture.requests.length).toBe(1) })
    const entry = [...fixture.ctx.loader.entries()].find(item => item.options.name === 'video-fixture')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    for (const name of ['generate_video_project', 'video_project_status', 'resume_video_project', 'edit_video']) expect(fixture.ctx.tools.get(name)).toBeUndefined()
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
    await vi.waitFor(() =>{  expect(fixture.requests.length).toBe(1) })
    const duplicate = await fixture.call('resume_video_project', { project_id: value.project_id })
    expect(json(duplicate.value)).toMatchObject({ status: 'failed', code: 'PROJECT_ALREADY_RUNNING' })
    expect(fixture.requests).toHaveLength(1)
    fixture.ctx.jobs.kill(JobId(String(value.job_id)), fixture.agent.id)
  })

  it('registers the same production tool schemas from the shipped credits apply path', async () => {
    const fixture = await boot(true)
    const skill = await fixture.ctx.skills.get('yunshu-video-director')
    expect(skill).toMatchObject({ source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } })
    expect(skill?.content).toContain('For a simple short clip or a user-supplied finished prompt, call generate_video directly.')
    for (const name of ['generate_video', 'generate_video_project', 'video_project_status', 'resume_video_project', 'edit_video']) expect(fixture.ctx.tools.get(name)).toBeDefined()
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
