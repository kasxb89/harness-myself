/** Partial H3 delivery through the production credits Loader, relay, worker and local editor. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { eventLines, toHeaderLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { normalizeSessionSnapshot, redactSessionSnapshotIds } from '@deepseek-ai/dsh-session-snapshot'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import Tools from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { expect, it, onTestFailed, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Credits from '../src/index.ts'

const runtimeRoot = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const ffmpeg = runtimeRoot === undefined ? undefined : join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobe = runtimeRoot === undefined ? undefined : join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const available = ffmpeg !== undefined && ffprobe !== undefined && existsSync(ffmpeg) && existsSync(ffprobe)
const successfulTask = 'task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const refusedTask = 'task_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const human = '使用MiniMax-H3生成一条10秒视频，分成两个5秒镜头。'
const initialArgs = { prompt: '一只茶杯从红色背景过渡到蓝色背景', total_duration_seconds: 10,
  shot_durations_seconds: [5, 5], model: 'MiniMax-H3', resolution: '768P' }

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('Expected text'); return value }
const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  })
}

it.skipIf(!available)('preserves the original successful H3 clip when a peer task is proven not submitted, through recorded chat and job_output',
  { timeout: 60_000 }, async ({ onTestFinished }) => {
    if (runtimeRoot === undefined || ffmpeg === undefined || ffprobe === undefined) throw new Error('Set the prepared native FFmpeg runtime')
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mixed-balance-delivery-')))
    const workspace = join(directory, 'workspace'), stateDir = join(workspace, '.synthetic-credits')
    const ctx = new Context(), source = createServer()
    let unobserve = () => {}
    onTestFinished(async () => {
      unobserve()
      try { await ctx.fiber.dispose() }
      finally { try { await close(source) } finally { await rm(directory, { recursive: true, force: true }) } }
    })
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const originalPath = join(directory, 'original-provider.mp4')
    execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=10:d=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', originalPath], { timeout: 30_000 })
    const originalBytes = await readFile(originalPath)
    const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
    let submitted = 0, resolveAccepted!: () => void, resolveRejected!: () => void
    const acceptedObserved = new Promise<void>((resolve) => { resolveAccepted = resolve })
    const rejectedObserved = new Promise<void>((resolve) => { resolveRejected = resolve })
    source.on('request', (request, response) => { void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body = chunks.length === 0 ? undefined : object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      calls.push({ method: request.method ?? 'GET', path, ...body === undefined ? {} : { body } })
      const answer = (value: unknown): void => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)) }
      if (path === '/api/status') { answer({ success: true, data: {} }); return }
      if (path === '/api/user/self') { answer({ success: true, data: { id: 7, group: 'default', quota: 1000000 } }); return }
      if (path === '/v1/models') { answer({ data: [{ id: 'MiniMax-H3', supported_endpoint_types: ['video-generation'] }] }); return }
      if (path === '/api/pricing') {
        answer({ success: true, data: [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['video-generation'],
          billing_usage_schema: { seconds: { type: 'number' } }, billing_usage_examples: [5, 10, 15].map(seconds => ({ facts: { seconds } })) }] }); return
      }
      if (path === '/v1/video/generations' && request.method === 'POST') {
        if (request.headers.authorization !== 'Bearer synthetic-relay-key' || ++submitted > 2) throw new Error('Unexpected generation or credential')
        const index = /当前分镜 ([12])\/2/u.exec(String(body?.prompt))?.[1]
        if (index === undefined) throw new Error('Expected the real per-shot request')
        // A persisted, polling first task exists before the second response arrives.
        if (index === '2') await acceptedObserved
        answer({ task_id: index === '1' ? successfulTask : refusedTask, status: 'IN_PROGRESS' }); return
      }
      if (path === '/v1/tasks/' + refusedTask) {
        // Faithful canonical GET: no failure_code/code that would reveal insufficient_user_quota.
        answer({ task_id: refusedTask, model: 'MiniMax-H3', platform: 'hailuo', status: 'FAILURE', progress: '100%',
          fail_reason: 'Insufficient account balance or subscription quota to submit this task',
          submission_receipt: { id: refusedTask, task_id: refusedTask, submission_code: 'h3_submission_not_sent',
            submission_state: 'not_submitted', billing_state: 'not_charged', upstream_submitted: false,
            retryable: false, resubmittable: true, recovery: { method: 'GET', path: '/v1/tasks/' + refusedTask } } }); return
      }
      if (path === '/v1/tasks/' + successfulTask) {
        resolveAccepted()
        // Hold the first accepted task until the worker has observed the peer rejection.
        await rejectedObserved
        answer({ task_id: successfulTask, model: 'MiniMax-H3', platform: 'hailuo', status: 'SUCCESS', progress: '100%' }); return
      }
      if (path === '/v1/videos/' + successfulTask + '/content') {
        response.setHeader('content-type', 'video/mp4'); response.setHeader('content-length', originalBytes.length)
        response.end(originalBytes); return
      }
      response.statusCode = 404; answer({ error: { code: 'synthetic_not_found' } })
    })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : undefined) }) })
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
    const address = source.address(); if (address === null || typeof address === 'string') throw new Error('Expected loopback port')
    const origin = `http://127.0.0.1:${String(address.port)}`
    await writeFile(join(stateDir, 'newapi-key'), 'synthetic-deployment-key', { mode: 0o600 })
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({ token: 'synthetic-product-session', backendBaseUrl: origin,
      expiresAt: '9999-01-01T00:00:00.000Z', account: { id: '7', phone: '+8613800000000' },
      upstream: { token: 'synthetic-user-token' }, relay: { key: 'synthetic-relay-key' } }), { mode: 0o600 })
    const selected = new URL('./expected/mixed-balance-delivery/session.v4.jsonl', import.meta.url)
    const recording = process.env.DSH_SNAPSHOT === 'record'
    const script: StreamChunk[][] = recording
      ? [toolCallResponse('create-original-project', 'generate_video_project', initialArgs)]
      : deriveReplayScript(parseSessionLog(await readFile(selected, 'utf8'))).map((entry) => {
        if (entry.kind !== 'chunks') throw new Error('Expected a recorded model stream')
        return entry.chunks
      })
    const adapter = new MockAdapter(script)
    const ModelFixture = { name: 'mixed-model-fixture', inject: ['llm'], apply(inner: Context) {
      inner.effect(() => inner.llm.registerAdapter(['fixture'], adapter))
    } }
    const config = join(directory, 'cordis.yml')
    await writeFile(config, [
      '- name: llm', '- name: sessions', '- name: session-projections', '- name: system-prompt', '- name: tools', '- name: agents',
      '- name: jobs', '- name: job-tools', '  config:', '    completionDelivery: quiet', '- name: fs', '  config:', `    cwd: '${workspace}'`,
      '- name: subprocess', '- name: sandbox-policy', '  config:', '    mode: danger-full-access', `    workspaceRoot: '${workspace}'`,
      '- name: sandbox', '- name: working-directory', '  config:', `    defaultDirectory: '${workspace}'`,
      '- name: webserver', '  config:', '    host: 127.0.0.1', '    port: 0', '- name: credits', '  config:',
      `    stateDir: '${stateDir}'`, `    newApiBaseUrl: '${origin}'`, `    videoRuntimeRoot: '${runtimeRoot}'`,
      '    timeoutMs: 5000', '    videoProjectConcurrency: 2', '    videoProjectPollIntervalMs: 10',
      '    videoProjectTaskTimeoutMs: 30000', '    videoEditTimeoutMs: 30000', '    videoEditFps: 10',
      '- name: agent-loop', '  config:', '    agents: []', '- name: model-fixture', '',
    ].join('\n'))
    const modules = new Map<string, unknown>([
      ['llm', LlmRuntime], ['sessions', SessionStore], ['session-projections', SessionProjections], ['system-prompt', SystemPrompt],
      ['tools', Tools], ['agents', AgentRegistry], ['jobs', LocalJobs], ['job-tools', JobTools], ['fs', LocalFileSystem],
      ['subprocess', LocalSubprocessRuntime], ['sandbox-policy', SandboxPolicyService], ['sandbox', LocalSandbox],
      ['working-directory', WorkingDirectory], ['webserver', WebServer], ['credits', Credits], ['agent-loop', AgentLoop], ['model-fixture', ModelFixture],
    ])
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    ctx.loader.internal = { version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    } } as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }); await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    unobserve = ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'progress' && event.job.progress?.includes('分镜 2/2 失败')) resolveRejected()
    })
    const agent = await ctx.agentLoop.create(SessionId('mixed-balance-chat'), { provider: 'fixture', model: 'fixture' }, { cwd: workspace })
    onTestFailed(async () => {
      const audit = join(process.cwd(), '.artifacts', 'uid277-mixed-balance-loader')
      await mkdir(audit, { recursive: true })
      await writeFile(join(audit, `failure-${String(Date.now())}.json`), JSON.stringify({ calls, submitted,
        modelRequests: adapter.requests.length, remainingScript: script.length, agentStatus: agent.status,
        events: agent.session.snapshotEvents() }, null, 2) + '\n')
    })
    const send = async (value: string, expectedCallId: string): Promise<void> => {
      const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] })
      let stop = () => {}
      const admitted = new Promise<void>((resolve) => { stop = ctx.on('session/event', (session, event) => {
        if (session !== agent.session || event.type !== 'agent/inbox/spliced'
          || !event.data.inserted.some(item => item.id === message.id)) return
        stop(); resolve()
      }) })
      agent.followup(message)
      await admitted
      await vi.waitFor(() => {
        expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result'
          && event.data.message.toolCallId === expectedCallId)).toBe(true)
      })
      await agent.whenIdle()
    }
    await send(human, 'create-original-project')
    await agent.whenIdle()
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    const block = result?.type === 'tool/result' ? result.data.message.content[0] : undefined
    if (block?.type !== 'text') throw new Error('Missing actual generation result')
    const started = object(JSON.parse(block.text)), projectId = text(started.project_id), jobId = JobId(text(started.job_id))
    await vi.waitFor(() => { expect(ctx.jobs.get(jobId, agent.id).status).toBe('failed') }, { timeout: 30_000 })
    const terminalChunk = ctx.jobs.readAt(jobId, 0, agent.id).chunks.findLast(chunk => chunk.text.trim().startsWith('{'))
    if (terminalChunk === undefined) throw new Error('Missing non-consuming terminal job output')
    const output = object(JSON.parse(terminalChunk.text))
    expect(output).toMatchObject({ status: 'failed', code: 'H3_SUBMISSION_NOT_SENT', task_ids: [successfulTask, refusedTask] })
    if (!Array.isArray(output.clip_paths) || output.clip_paths.length !== 1) throw new Error('The original successful clip must be delivered')
    const savedPath = text(output.clip_paths[0])
    expect(hash(await readFile(savedPath))).toBe(hash(originalBytes))
    const metadata = object(JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', savedPath], { encoding: 'utf8' })))
    expect(Number(object(metadata.format).duration)).toBeCloseTo(5, 1)
    const manifest = object(JSON.parse(await readFile(join(stateDir, 'video-projects', projectId, 'manifest.json'), 'utf8')))
    expect(manifest.origin).toMatchObject({ sessionId: agent.id, turn: 1, toolCallId: 'create-original-project' })
    expect(manifest.segments).toMatchObject([{ status: 'saved', taskId: successfulTask }, { status: 'failed', taskId: refusedTask }])
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(2)
    expect(calls.filter(call => call.path === '/v1/videos/' + successfulTask + '/content')).toHaveLength(1)
    if (recording) script.push(toolCallResponse('collect-original-job', 'job_output', { job_id: jobId }), textResponse('已保存成功片段；未发送的分镜保留原失败原因。'))
    await send('只读取刚才原任务的结果，不要重新生成。', 'collect-original-job')
    const collected = agent.session.snapshotEvents().find(event => event.type === 'tool/result'
      && event.data.message.toolCallId === 'collect-original-job')
    expect(collected?.type === 'tool/result' && JSON.stringify(collected.data.message.content)).toContain('H3_SUBMISSION_NOT_SENT')
    expect(collected?.type === 'tool/result' && JSON.stringify(collected.data.message.content)).toContain(basename(savedPath))
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(2)
    const persisted = JSON.stringify(toHeaderLine(agent.session.header)) + '\n' + eventLines(agent.session.snapshotEvents())
    const typed = redactSessionSnapshotIds([persisted])[0]
    if (typed === undefined) throw new Error('Missing captured Session')
    // These values come from this original operation, not a blanket UUID/body scrub.
    // Keep equal identities equal in the returned JSON, progress line and saved path.
    const clipName = basename(savedPath), clipNameParts = /^(.*)-[0-9a-f-]{36}\.mp4$/u.exec(clipName)
    if (clipNameParts?.[1] === undefined) throw new Error('Expected the generated clip filename')
    const generatedIdentities: [string, string][] = [
      [workspace, '{{cwd}}'], [projectId, '{{videoProject:1}}'],
      [text(started.plan_id), '{{creationPlan:1}}'], [text(started.work_id), '{{videoWork:1}}'],
      [text(started.work_request_id), '{{videoWorkRequest:1}}'], [text(started.operation_id), '{{mediaOperation:1}}'],
      [clipName, clipNameParts[1] + '-{{videoClip:1}}.mp4'],
    ]
    generatedIdentities.sort(([left], [right]) => right.length - left.length)
    let normalized = normalizeSessionSnapshot(typed, { sessionIds: [], cwd: workspace }, { identityMode: 'preserve' })
    for (const [identity, token] of generatedIdentities) {
      normalized = normalized.replaceAll(identity, token)
    }
    if (recording) { await mkdir(new URL('./expected/mixed-balance-delivery/', import.meta.url), { recursive: true }); await writeFile(selected, normalized) }
    else expect(normalized).toBe(await readFile(selected, 'utf8'))
    expect(parseSessionLog(normalized).filter(event => event.type === 'tool/call').map(event => event.data.name))
      .toEqual(['generate_video_project', 'job_output'])
  })
