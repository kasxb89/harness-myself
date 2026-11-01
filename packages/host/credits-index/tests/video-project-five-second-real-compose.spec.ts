/** Current catalog and synthetic five-only contracts through the real relay, admission and FFmpeg. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import Tools from '@deepseek-ai/dsh-tools'
import UserQuestions, { type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Credits from '../src/index.ts'
import { catalogFromPricing } from '../src/media.ts'
import { MediaPreferencesStore, mediaPreferencesScope } from '../src/media-preferences.ts'
import pricing from './fixtures/official-price-comparison-api.json' with { type: 'json' }

interface RequestRecord { method: string; path: string; body?: Record<string, unknown>; startedAt: number }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('Expected text'); return value }
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
  })
}
const runtimeRoot = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const ffmpeg = runtimeRoot === undefined ? undefined : join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobe = runtimeRoot === undefined ? undefined : join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const available = ffmpeg !== undefined && ffprobe !== undefined && existsSync(ffmpeg) && existsSync(ffprobe)
const cases = [
  { name: 'actual-catalog-five-second-preference', fiveOnly: false, ceiling: undefined, localCeiling: undefined, expectedPeak: 4, totalSeconds: 20 },
  { name: 'synthetic-five-only-contract-ceiling-two', fiveOnly: true, ceiling: 2, localCeiling: undefined, expectedPeak: 2, totalSeconds: 20 },
  { name: 'actual-catalog-twenty-slot-pool', fiveOnly: false, ceiling: 20, localCeiling: undefined, expectedPeak: 20, totalSeconds: 120 },
  { name: 'actual-catalog-twenty-slot-pool-local-six', fiveOnly: false, ceiling: 20, localCeiling: 6, expectedPeak: 6, totalSeconds: 120 },
] as const

it.skipIf(!available).each(cases)('$name generates $totalSeconds seconds under its declared concurrency and joins one work', async ({ name, fiveOnly, ceiling, localCeiling, expectedPeak, totalSeconds }) => {
  if (runtimeRoot === undefined || ffmpeg === undefined || ffprobe === undefined) throw new Error('Set the prepared native FFmpeg runtime')
  const planSeconds = Array.from({ length: totalSeconds / 5 }, () => 5)
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-five-second-compose-')))
  const ctx = new Context(), source = createServer()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally {
      try { await close(source) } finally { await rm(directory, { recursive: true, force: true }) }
    }
  })
  const workspace = join(directory, 'workspace'), stateDir = join(directory, 'credits'), fixtureDir = join(directory, 'fixtures')
  await Promise.all([workspace, stateDir, fixtureDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const modelId = 'ycapi-grok-imagine-video'
  const actualRow = pricing.data.find(row => row.model_name === modelId)
  if (actualRow === undefined) throw new Error('Approved API fixture requires Grok Imagine 1.0')
  const row = object(JSON.parse(JSON.stringify(actualRow)))
  const parameters = object(row.parameters)
  if (fiveOnly) {
    const combinations = parameters.oneOf
    if (!Array.isArray(combinations)) throw new Error('Expected complete specifications')
    parameters.oneOf = combinations.filter(value => object(object(object(value).properties).seconds).enum instanceof Array
      && (object(object(object(value).properties).seconds).enum as unknown[]).includes(5))
    row.retail_price_rows = (row.retail_price_rows as unknown[]).filter(value => String(object(object(value).params).duration) === '5')
  }
  if (ceiling !== undefined) parameters['x-client-concurrency'] = { schema: 1, atomic_admission: true,
    max_parallelism: ceiling, model: modelId, scope: 'shared_account_pool', reservation: false }
  const catalog = catalogFromPricing([row], 'default')
  const model = catalog[0]
  if (model?.kind !== 'video') throw new Error('Video capability was not projected')
  const samples = new Map<number, { path: string; bytes: Buffer; hash: string }[]>()
  for (const duration of [5]) {
    const list = []
    for (const [index, color] of ['red', 'green', 'blue', 'yellow'].entries()) {
      const path = join(fixtureDir, `${String(duration)}-${String(index)}.mp4`)
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
        `color=c=${color}:s=160x120:r=10:d=${String(duration)}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path], { timeout: 30_000 })
      const bytes = await readFile(path); list.push({ path, bytes, hash: digest(bytes) })
    }
    samples.set(duration, list)
  }
  const calls: RequestRecord[] = [], questions: AskUserQuestionItem[][] = []
  const tasks = new Map<string, { media: { path: string; bytes: Buffer; hash: string }; readyAt: number }>()
  const inFlight = new Set<string>(); let peakInFlight = 0
  source.on('request', (request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
    const body = chunks.length ? object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : undefined
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    calls.push({ method: request.method ?? 'GET', path, ...body === undefined ? {} : { body }, startedAt: Date.now() })
    const answer = (value: unknown): void => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)) }
    if (path === '/api/status') { answer({ success: true, data: {} }); return }
    if (path === '/api/user/self') { answer({ success: true, data: { id: 7, group: 'default', quota: 1000000 } }); return }
    if (path === '/v1/models') { answer({ data: [{ id: modelId, kind: 'video', supported_endpoint_types: ['openai'] }] }); return }
    if (path === '/api/pricing') { answer({ success: true, data: [row] }); return }
    if (path === '/v1/video/quote') {
      const segments = body?.segments
      if (!Array.isArray(segments)) throw new Error('Expected complete quote segments')
      const now = Math.floor(Date.now() / 1000)
      answer({ object: 'video.quote', schema_version: 1, quote_id: 'synthetic-five-sec-quote', account_binding: 'synthetic-account-binding',
        model: modelId, works_count: body?.works_count,
        segments: segments.map(value => ({ ...object(value), usage: {}, quota: 1000, estimated_amount: '0.01' })),
        one_work_quota: 1000 * segments.length, total_quota: 1000 * segments.length,
        currency: 'CNY', quota_per_usd: 500000, usd_exchange_rate: 7,
        estimated_one_work: (segments.length / 100).toFixed(2), estimated_total: (segments.length / 100).toFixed(2),
        pricing_revision: 'synthetic-stable-price', created_at: now, expires_at: now + 60,
        estimate_only: true, charged: false, submitted: false, reserved: false }); return
    }
    if (path === '/v1/videos' && request.method === 'POST') {
      const duration = Number(body?.seconds), index = tasks.size
      const availableSamples = samples.get(duration)
      const media = availableSamples?.[index % availableSamples.length]
      if (body?.model !== modelId || media === undefined || request.headers.authorization !== 'Bearer sk-fixture-five-seconds') {
        response.statusCode = 400; answer({ error: 'Unsupported native model, duration or account' }); return
      }
      const taskId = `five-sec-task-${String(index + 1)}`
      tasks.set(taskId, { media, readyAt: Date.now() + 250 }); inFlight.add(taskId); peakInFlight = Math.max(peakInFlight, inFlight.size)
      answer({ id: taskId, status: 'queued' }); return
    }
    const match = /^\/v1\/(?:videos|tasks)\/(five-sec-task-\d+)(\/content)?$/u.exec(path)
    const task = match?.[1] === undefined ? undefined : tasks.get(match[1])
    if (task !== undefined) {
      if (match?.[2] === '/content') { response.setHeader('content-type', 'video/mp4'); response.end(task.media.bytes); return }
      if (tasks.size < expectedPeak || Date.now() < task.readyAt) { answer({ id: match?.[1], status: 'in_progress' }); return }
      inFlight.delete(match?.[1] ?? ''); answer({ id: match?.[1], status: 'completed' }); return
    }
    response.statusCode = 404; answer({ error: { code: 'not_found' } })
  })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : undefined) }) })
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
  const address = source.address(); if (address === null || typeof address === 'string') throw new Error('Expected loopback origin')
  const origin = `http://127.0.0.1:${String(address.port)}`
  await writeFile(join(stateDir, 'newapi-key'), 'fixture-deployment-key', { mode: 0o600 })
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({ token: 'fixture-five-sec-session', backendBaseUrl: origin,
    expiresAt: '9999-01-01T00:00:00.000Z', account: { id: '7', phone: '+8613800000000' },
    upstream: { token: 'fixture-user-token' }, relay: { key: 'sk-fixture-five-seconds' } }), { mode: 0o600 })
  const owner = digest(JSON.stringify([origin, origin, '7', 'fixture-five-sec-session']))
  const store = new MediaPreferencesStore(join(stateDir, 'media-preferences')), scope = mediaPreferencesScope(origin, '7')
  const initial = await store.read(scope)
  const saved = await store.save(scope, owner, { schema_version: 1, expected_account_owner: owner, expected_revision: initial.revision,
    image: null, video: { model: modelId, parameters: { seconds: 5, resolution: '480p', ratio: '16:9' } } },
  [{ ...model, kind: 'video', params: model.params }], async () => {})
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    '- name: system-prompt', '- name: tools', '- name: agents', '- name: jobs', '- name: job-tools', '- name: questions',
    '- name: session-projections', '- name: fs', '  config:', `    cwd: '${workspace}'`,
    '- name: subprocess', '- name: sandbox-policy', '  config:', "    mode: 'workspace-write'", `    workspaceRoot: '${workspace}'`,
    '- name: sandbox', '- name: working-directory', '  config:', `    defaultDirectory: '${workspace}'`,
    '- name: webserver', '  config:', "    host: '127.0.0.1'", '    port: 0', '- name: credits', '  config:',
    `    stateDir: '${stateDir}'`, `    newApiBaseUrl: '${origin}'`, `    videoRuntimeRoot: '${runtimeRoot}'`, '    timeoutMs: 5000',
    ...localCeiling === undefined ? [] : [`    videoProjectConcurrency: ${String(localCeiling)}`],
    '    videoProjectPollIntervalMs: 10', '    videoProjectTaskTimeoutMs: 30000', '    videoEditTimeoutMs: 60000', '    videoEditFps: 10', '',
  ].join('\n'))
  const modules = new Map<string, unknown>([
    ['system-prompt', SystemPrompt], ['tools', Tools], ['agents', AgentRegistry], ['jobs', LocalJobs], ['job-tools', JobTools],
    ['questions', UserQuestions], ['session-projections', SessionProjectionRegistry], ['fs', LocalFileSystem], ['subprocess', LocalSubprocessRuntime],
    ['sandbox-policy', SandboxPolicyService], ['sandbox', LocalSandbox], ['working-directory', WorkingDirectory], ['credits', Credits], ['webserver', WebServer],
  ])
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
    if (!modules.has(specifier)) throw new Error(`Unexpected fixture import: ${specifier}`); return modules.get(specifier)
  } } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const sessionId = SessionId(`five-seconds-${name}`), session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false, cwd: workspace,
  })
  const unsupported = (): never => { throw new Error('Fixture inbox is immutable') }
  const agent: Agent = { id: sessionId, session, ctx, options: {}, status: 'running',
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported,
      replace: unsupported, remove: unsupported, splice: unsupported },
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal) }
  await ctx.agents.register(agent)
  ctx.on('user-questions/request', async (request) => {
    questions.push(request.questions)
    expect(calls.filter(call => call.method === 'POST' && call.path === '/v1/videos')).toHaveLength(0)
    const choice = request.questions[0]?.options?.find(option => option.label.startsWith('使用 '))
    if (choice === undefined) throw new Error('Expected quoted native model choice')
    return { answers: [{ id: 'video-model-price-choice', selected: [choice.label] }] }
  })
  session.append('turn/start', { turn: 1 })
  const requestId = brandString<SessionRequestId>(`request-${name}`)
  const human = createUserMessage({ source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: `生成一条${String(totalSeconds)}秒的风景视频。` }] })
  await ctx.waterfall('session/prompt-admission', { agent, requestId, message: human,
    inputContext: { credits_media_preferences: { scope, revision: saved.revision, accountOwner: owner } } }, async () => {})
  session.append('user/message', human, { surfaceOp: 'append' })
  const execute = async (name: string, args: object, step: number) => {
    const callId = ToolCallId(`five-second-call-${String(step)}`)
    const logged = session.append('tool/call', { turn: 1, step, callId, name, arguments: JSON.stringify(args) })
    const result = await ctx.tools.execute({ callId, name, arguments: args, agent, signal: new AbortController().signal })
    session.append('tool/result', { turn: 1, step, message: createToolResultMessage({ callId, content: result.content, isError: result.isError }) },
      { surfaceOp: 'append', sourceEventSeqs: [logged.seq] }); return result
  }
  const start = await execute('generate_video_project', { prompt: '风景随季节变化，镜头自然衔接', total_duration_seconds: totalSeconds }, 1)
  expect(start.isError, JSON.stringify(start.value)).toBe(false)
  const started = object(start.value)
  expect(started, JSON.stringify(started)).toMatchObject({ status: 'background', plan_seconds: planSeconds })
  const jobId = JobId(text(started.job_id))
  await vi.waitFor(() => { expect(['completed', 'failed', 'killed']).toContain(ctx.jobs.get(jobId, agent.id).status) }, { timeout: 60_000, interval: 20 })
  expect(ctx.jobs.get(jobId, agent.id).status).toBe('completed')
  const collected = await execute('job_output', { job_id: jobId }, 2)
  const finalLine = text(object(collected.value).text).split('\n').filter(line => line.startsWith('{')).at(-1)
  if (finalLine === undefined) throw new Error('Expected terminal output')
  const completed = object(JSON.parse(finalLine)), finalPath = text(completed.final_path)
  expect(completed).toMatchObject({ status: 'succeeded', duration_seconds: totalSeconds })
  expect((await stat(finalPath)).isFile()).toBe(true)
  const probe = object(JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', finalPath], { encoding: 'utf8', timeout: 30_000 })))
  expect(Number(object(probe.format).duration)).toBeCloseTo(totalSeconds, 1)
  const posts = calls.filter(call => call.method === 'POST' && call.path === '/v1/videos')
  expect(posts).toHaveLength(planSeconds.length); expect(posts.map(call => call.body?.seconds)).toEqual(planSeconds)
  const quoteRequests = calls.filter(call => call.method === 'POST' && call.path === '/v1/video/quote')
  expect(quoteRequests.length).toBeGreaterThan(0)
  const quoteSummaries = quoteRequests.map((call) => {
    expect(call.body).toMatchObject({ model: modelId, works_count: 1 })
    const segments = call.body?.segments
    if (!Array.isArray(segments)) throw new Error('Expected quoted segments')
    expect(segments).toHaveLength(planSeconds.length)
    return segments.map((value) => {
      const parameters = object(object(value).parameters)
      expect(parameters.seconds).toBe(5)
      if (parameters.duration !== undefined) expect(Number(parameters.duration)).toBe(5)
      return { seconds: parameters.seconds, duration: parameters.duration ?? null }
    })
  })
  for (const call of posts) if (call.body?.duration !== undefined) expect(Number(call.body.duration)).toBe(5)
  expect(questions).toHaveLength(1); expect(peakInFlight).toBe(expectedPeak)
  const manifest = object(JSON.parse(await readFile(join(stateDir, 'video-projects', text(started.project_id), 'manifest.json'), 'utf8')))
  const segments = manifest.segments
  if (!Array.isArray(segments)) throw new Error('Expected durable project segments')
  expect(segments).toHaveLength(planSeconds.length)
  const clipHashes = []
  for (const value of segments) {
    const segment = object(value), path = text(segment.path), bytes = await readFile(path)
    expect(segment).toMatchObject({ status: 'saved', durationSeconds: 5 }); clipHashes.push(digest(bytes))
    expect([...samples.get(5)!.values()].some(sample => sample.hash === digest(bytes))).toBe(true)
  }
  const creation = object(JSON.parse(await readFile(join(stateDir, 'creative-projects', text(started.plan_id), 'project.json'), 'utf8')))
  if (!Array.isArray(creation.operations)) throw new Error('Expected one finished-work operation')
  expect(creation.operations).toHaveLength(1)
  const finishedWork = object(creation.operations[0])
  expect(finishedWork.videoProjectId).toBe(started.project_id)
  expect(finishedWork.outputs).toHaveLength(planSeconds.length + 1)
  expect(started).toMatchObject({ pending_work_ids: [], remaining_works: 0 })
  const selection = ctx.sessionProjections.stateOf(session, 'mediaRequestSelections')?.selections[requestId]
  expect(selection).toMatchObject({ requestId, state: 'selected', video: saved.video })
  if (process.env.DSH_MEDIA_AUDIT_OUTPUT_DIR !== undefined) {
    const out = join(process.env.DSH_MEDIA_AUDIT_OUTPUT_DIR, name); await mkdir(out, { recursive: true })
    await copyFile(finalPath, join(out, `final-${String(totalSeconds)}s.mp4`))
    for (const [index, value] of segments.entries()) await copyFile(text(object(value).path), join(out, `clip-${String(index + 1)}-5s.mp4`))
    await writeFile(join(out, 'evidence.json'), JSON.stringify({ scope: fiveOnly ? 'Synthetic restricted five-only capability, not an actual deployed model' : 'Unmodified actual public model and specification fixture; synthetic provider/account',
      savedPreference: saved.video, selection, started, posts, quoteSummaries, peakInFlight, ceiling: ceiling ?? 'local default4', localCeiling, totalSeconds, probe, finalHash: digest(await readFile(finalPath)),
      clipHashes, finishedWorkOperationCount: creation.operations.length, publishedOutputCount: planSeconds.length + 1, questions, calls, nativeRuntime: runtimeRoot, finalFilename: basename(finalPath), realUpstreamCalls: 0, paidCalls: 0 }, null, 2) + '\n')
  }
}, 90_000)
