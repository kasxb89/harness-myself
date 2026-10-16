/** A keyless 40-second project through the production relay, local sandbox and real media editor. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import Tools from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { expect, it, vi } from 'vitest'
import * as Credits from '../src/index.ts'

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly body: Record<string, unknown> | undefined
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string')
  return value
}

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  })
}

const runtimeRoot = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const ffmpeg = runtimeRoot === undefined ? undefined : join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobe = runtimeRoot === undefined ? undefined : join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const available = ffmpeg !== undefined && ffprobe !== undefined && existsSync(ffmpeg) && existsSync(ffprobe)

it.skipIf(!available)('generates 15 + 15 + 10 seconds with the signed-in key and actually downloads, edits and verifies a 40-second MP4', async ({ onTestFinished }) => {
  if (runtimeRoot === undefined || ffmpeg === undefined || ffprobe === undefined) throw new Error('Set DSH_VIDEO_TEST_RUNTIME_ROOT to a prepared native runtime')
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-real-compose-')))
  const ctx = new Context()
  const source = createServer()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally {
      try { await close(source) } finally { await rm(directory, { recursive: true, force: true }) }
    }
  })
  const workspace = join(directory, 'workspace')
  const fixtureMedia = join(directory, 'provider-fixtures')
  const stateDir = join(directory, 'credits')
  await Promise.all([workspace, fixtureMedia, stateDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const lengths = [15, 15, 10]
  const colors = ['red', 'green', 'blue']
  const sources: { path: string; bytes: Buffer; hash: string; duration: number }[] = []
  for (const [index, duration] of lengths.entries()) {
    const path = join(fixtureMedia, `source-${String(index + 1)}.mp4`)
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi',
      '-i', `color=c=${colors[index]!}:s=160x120:r=10:d=${String(duration)}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path],
    { timeout: 30_000 })
    const bytes = await readFile(path)
    sources.push({ path, bytes, hash: digest(bytes), duration })
  }

  const calls: RecordedRequest[] = []
  const taskSources = new Map<string, (typeof sources)[number]>()
  source.on('request', (request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body = chunks.length === 0 ? undefined : object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      calls.push({ path, method: request.method ?? 'GET', authorization: request.headers.authorization, body })
      response.setHeader('content-type', 'application/json')
      if (path === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'MiniMax-H3', supported_endpoint_types: ['video-generation'] }] }))
      } else if (path === '/api/pricing') {
        response.end(JSON.stringify({ data: [{ model_name: 'MiniMax-H3', supported_endpoint_types: ['video-generation'],
          billing_usage_schema: { seconds: { type: 'number' } }, billing_usage_examples: [5, 10, 15].map(seconds => ({ facts: { seconds } })) }] }))
      } else if (path === '/v1/video/generations' && request.method === 'POST') {
        const index = calls.filter(call => call.method === 'POST').length - 1
        const media = sources[index]
        if (media === undefined || body?.duration !== media.duration || body.seconds !== media.duration) {
          response.writeHead(400)
          response.end(JSON.stringify({ error: 'Unexpected fixture duration or duplicate submission' }))
          return
        }
        const taskId = `fixture-task-${String(index + 1)}`
        taskSources.set(taskId, media)
        response.end(JSON.stringify({ code: 'success', data: { task_id: taskId, status: 'NOT_START' } }))
      } else {
        const match = /^\/v1\/(?:video\/generations|videos)\/(fixture-task-\d+)(\/content)?$/u.exec(path)
        const media = match?.[1] === undefined ? undefined : taskSources.get(match[1])
        if (media === undefined) { response.writeHead(404); response.end(); return }
        if (match?.[2] === '/content') {
          response.setHeader('content-type', 'video/mp4')
          response.setHeader('content-length', media.bytes.byteLength)
          response.end(media.bytes)
        } else response.end(JSON.stringify({ code: 'success', data: { task_id: match?.[1], status: 'SUCCESS' } }))
      }
    })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : undefined) })
  })
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
  const address = source.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a local provider port')
  await writeFile(join(stateDir, 'newapi-key'), 'fixture-deployment-key', { mode: 0o600 })
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    token: 'fixture-product-session', expiresAt: '9999-01-01T00:00:00.000Z',
    account: { id: '7', phone: '+8613800000000' }, upstream: { token: 'fixture-user-token' },
    relay: { key: 'fixture-signed-in-account-key' },
  }), { mode: 0o600 })
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    '- name: system-prompt', '- name: tools', '- name: agents', '- name: jobs', '- name: job-tools',
    '- name: session-projections', '- name: fs', '  config:', `    cwd: '${workspace}'`,
    '- name: subprocess', '- name: sandbox-policy', '  config:', "    mode: 'workspace-write'", `    workspaceRoot: '${workspace}'`,
    '- name: sandbox', '- name: working-directory', '  config:', `    defaultDirectory: '${workspace}'`,
    '- name: webserver', '  config:', "    host: '127.0.0.1'", '    port: 0', '- name: credits', '  config:',
    `    stateDir: '${stateDir}'`, `    newApiBaseUrl: 'http://127.0.0.1:${String(address.port)}'`,
    `    videoRuntimeRoot: '${runtimeRoot}'`, '    timeoutMs: 5000', '    videoProjectPollIntervalMs: 1',
    '    videoProjectTaskTimeoutMs: 30000', '    videoEditTimeoutMs: 60000', '    videoEditFps: 10', '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['system-prompt', SystemPrompt], ['tools', Tools], ['agents', AgentRegistry], ['jobs', LocalJobs], ['job-tools', JobTools],
    ['session-projections', SessionProjectionRegistry], ['fs', LocalFileSystem], ['subprocess', LocalSubprocessRuntime],
    ['sandbox-policy', SandboxPolicyService], ['sandbox', LocalSandbox], ['working-directory', WorkingDirectory],
    ['credits', Credits], ['webserver', WebServer],
  ])
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture import: ${specifier}`)
      return modules.get(specifier)
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const sessionId = SessionId('chat-real-video')
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false, cwd: workspace,
  })
  const unsupported = (): never => { throw new Error('Fixture Inbox is not mutable') }
  const agent: Agent = {
    id: sessionId, session, ctx, options: {}, status: 'running',
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported,
      replace: unsupported, remove: unsupported, splice: unsupported },
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
  }
  await ctx.agents.register(agent)
  const wrongReference = join(workspace, 'video-in-image-slot.mp4')
  await writeFile(wrongReference, sources[0]!.bytes)
  const invalid = await ctx.tools.execute({ callId: ToolCallId('real-video-invalid-reference'), name: 'generate_video_project',
    arguments: { prompt: '参考这个画面制作短片', total_duration_seconds: 40, frame_images: [wrongReference] },
    agent, signal: new AbortController().signal })
  expect(object(invalid.value)).toMatchObject({ status: 'failed', code: 'VIDEO_REFERENCE_INVALID' })
  expect(calls.filter(call => call.method === 'POST')).toEqual([])
  expect(ctx.jobs.list(agent.id)).toEqual([])
  const result = await ctx.tools.execute({ callId: ToolCallId('real-video-40'), name: 'generate_video_project',
    arguments: { prompt: '制作一个40秒的产品短片，三个镜头分别展示红色、绿色和蓝色背景，自动剪辑成片。', total_duration_seconds: 40 },
    agent, signal: new AbortController().signal })
  expect(result.isError).toBe(false)
  const started = object(result.value)
  expect(started, JSON.stringify(started)).toMatchObject({ status: 'background', plan_seconds: [15, 15, 10] })
  const jobId = JobId(string(started.job_id))
  const activeContext = ctx
  await vi.waitFor(() => {
    expect(['completed', 'failed', 'killed']).toContain(activeContext.jobs.get(jobId, agent.id).status)
  }, { timeout: 60_000, interval: 20 })
  const outcome = ctx.jobs.read(jobId, agent.id)
  expect({ status: ctx.jobs.get(jobId, agent.id).status, result: outcome.result }).toMatchObject({ status: 'completed' })
  const completed = object(JSON.parse(outcome.result ?? '{}'))
  expect(completed).toMatchObject({ status: 'succeeded', duration_seconds: 40 })
  const finalPath = string(completed.final_path)
  expect((await stat(finalPath)).isFile()).toBe(true)
  const metadata = object(JSON.parse(execFileSync(ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', finalPath],
    { encoding: 'utf8', timeout: 30_000 })))
  expect(Number(object(metadata.format).duration)).toBeCloseTo(40, 1)
  expect(metadata.streams).toEqual(expect.arrayContaining([{ codec_type: 'video', width: 160, height: 120 }, { codec_type: 'audio' }]))
  const postCalls = calls.filter(call => call.method === 'POST')
  expect(postCalls.map(call => [call.path, call.body?.duration, call.body?.seconds])).toEqual([
    ['/v1/video/generations', 15, 15], ['/v1/video/generations', 15, 15], ['/v1/video/generations', 10, 10],
  ])
  expect(calls.filter(call => call.method === 'GET' && call.path.includes('fixture-task-')).map(call => call.path)).toEqual([
    '/v1/video/generations/fixture-task-1', '/v1/videos/fixture-task-1/content',
    '/v1/video/generations/fixture-task-2', '/v1/videos/fixture-task-2/content',
    '/v1/video/generations/fixture-task-3', '/v1/videos/fixture-task-3/content',
  ])
  expect(calls.filter(call => call.path.startsWith('/v1/')).every(call => call.authorization === 'Bearer fixture-signed-in-account-key')).toBe(true)
  const manifestPath = join(stateDir, 'video-projects', string(started.project_id), 'manifest.json')
  const manifest = object(JSON.parse(await readFile(manifestPath, 'utf8')))
  expect(manifest).toMatchObject({ status: 'completed', finalPath, finalDurationSeconds: 40, identity: { accountId: '7' } })
  const segments: unknown[] = Array.isArray(manifest.segments) ? manifest.segments : []
  expect(segments.map(value => ({ index: object(value).index, status: object(value).status, taskId: object(value).taskId })))
    .toEqual([1, 2, 3].map(index => ({ index, status: 'saved', taskId: `fixture-task-${String(index)}` })))
  expect(segments).toHaveLength(3)
  for (const [index, value] of segments.entries()) {
    const clip = object(value)
    const sourceClip = sources[index]
    if (sourceClip === undefined) throw new Error('Expected one source per generated clip')
    expect(digest(await readFile(sourceClip.path))).toBe(sourceClip.hash)
    expect(digest(await readFile(string(clip.path)))).toBe(sourceClip.hash)
  }
  expect(JSON.stringify(manifest))
    .not.toMatch(/fixture-signed-in-account-key|fixture-deployment-key|fixture-product-session|fixture-user-token/u)
}, 90_000)
