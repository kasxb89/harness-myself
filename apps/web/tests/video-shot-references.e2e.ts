/** Shot-bound reference video and audio inputs plus terminal job output are recorded through the shipped Web CLI. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  captureWorkspaceSnapshot, fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds,
  scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'
import { fixtureUserPrompts, normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/video-shot-references', import.meta.url))
const HEADER_DIR = fileURLToPath(new URL('../../../snapshots/web/h3-submission-outcomes', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const PROMPTS = [
  'Generate one eight-second MiniMax-H3 video as two four-second shots. First save a complete plan. Bind reference-one.mp4 and voice-one.wav only to shot one, reference-two.mp4 and voice-two.wav only to shot two, then start that exact plan. Reply PROJECT_STARTED and stop; do not read or cancel it yet.',
  'Read the started project live output once, stop its local job, read its final output, then reply OBSERVATION_STOPPED. Do not generate another project or clip.',
] as const
const SHOT_PROMPTS = ['SCENE_REFERENCE_ONE', 'SCENE_REFERENCE_TWO'] as const
const KEY = 'DSH_VIDEO_REFERENCES_FIXTURE_KEY'
const REPLAY_MODULE = pathToFileURL(createRequire(join(REPO_ROOT, 'apps/cli/package.json'))
  .resolve('@deepseek-ai/dsh-llm-replay')).href
const runtimeRoot = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const runtimeAvailable = runtimeRoot !== undefined && ['ffmpeg', 'ffprobe'].every(tool =>
  existsSync(join(runtimeRoot, 'bin', process.platform === 'win32' ? `${tool}.exe` : tool)))

type JsonRow = Record<string, unknown>
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

function rows(raw: string): JsonRow[] {
  return raw.trimEnd().split('\n').map(line => JSON.parse(line) as JsonRow)
}

async function storedSession(root: string, id: string): Promise<string> {
  const paths = (await readdir(root, { recursive: true })).map(path => join(root, path))
  for (const path of latestPersistedSessionPaths(paths)) {
    const raw = await readFile(path, 'utf8')
    if (rows(raw)[0]?.id === id) return raw
  }
  throw new Error(`No persisted Session ${id}`)
}

async function startWeb(root: string, workspace: string, overlay: string) {
  const launch = resolveExampleLaunch({
    srcBin: join(REPO_ROOT, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm',
    tsconfigPath: join(REPO_ROOT, 'tsconfig.json'),
    configArgs: ['--profile', 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    env: {
      DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
      DSH_BUNDLED_SKILL_DIR: join(root, 'bundled-skills'), DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: undefined, [KEY]: 'keyless-video-references-fixture',
    },
  })
  const child = spawn(launch.command, launch.args, {
    cwd: workspace, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + String(chunk)).slice(-40_000) })
  const completion = new Promise<void>((resolve, reject) => {
    child.once('close', () => { resolve() })
    child.once('error', reject)
  })
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    let forced = false
    const timer = setTimeout(() => { forced = true; child.kill('SIGKILL') }, 10_000)
    timer.unref()
    try { await completion } finally { clearTimeout(timer) }
    if (forced) throw new Error('The owned Web process did not stop after SIGTERM')
  }
  try {
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(output)
      return /dsh web: (http:\/\/\S+)/u.exec(output)?.[1]
    }, { timeout: 60_000 }).toBeDefined()
    const authenticatedUrl = /dsh web: (http:\/\/\S+)/u.exec(output)?.[1]
    if (authenticatedUrl === undefined) throw new Error('Web startup supplied no authenticated URL')
    const exchange = await fetch(authenticatedUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('Web startup supplied no authentication cookie')
    const remote = async <T>(endpoint: string, args: Readonly<Record<string, unknown>>): Promise<T> => {
      const response = await fetch(new URL(`/api/${endpoint}`, authenticatedUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}: ${await response.text()}`)
      const { result } = await response.json() as { result: RpcResult<T> }
      if (!result.ok) throw new Error(`${endpoint}: ${result.error.code}: ${result.error.message}`)
      return result.value
    }
    return { stop, remote, cookie, webUrl: new URL(authenticatedUrl).origin }
  } catch (error) {
    await stop()
    throw error
  }
}



function record(value: unknown): JsonRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as JsonRow
}

function results(raw: string): { name: string; text: string }[] {
  const events = rows(raw)
  const names = new Map(events.filter(row => row.type === 'tool/call').map((row) => {
    const data = record(row.data)
    return [data.callId, String(data.name)]
  }))
  return events.filter(row => row.type === 'tool/result').map((row) => {
    const message = record(record(row.data).message)
    const content = message.content as { type: string; text?: string }[]
    return { name: names.get(message.toolCallId) ?? '', text: content.filter(block => block.type === 'text').map(block => block.text).join('') }
  })
}

/** Tokenize only returned creation IDs and elapsed fields owned by this scenario's job_output. */
function normalizeProjectOutput(raw: string): string {
  const started = results(raw).find(result => result.name === 'generate_video_project')
  if (started === undefined) throw new Error('Expected the actual background project result')
  const value = record(JSON.parse(started.text))
  let ordinal = 1001
  for (const [key, prefix] of [['project_id', 'vp_'], ['plan_id', 'cp_']] as const) {
    const id = value[key]
    if (key === 'plan_id' && id === undefined) continue
    if (typeof id !== 'string' || !id.startsWith(prefix) || !/^[a-z]{2}_[a-f0-9-]{36}$/u.test(id)) throw new Error(`Invalid typed ${key}`)
    raw = raw.split(id).join(`{{id:${String(ordinal++)}}}`)
  }
  const events = rows(raw)
  const jobReads = new Set(events.filter(row => row.type === 'tool/call' && record(row.data).name === 'job_output')
    .map(row => record(row.data).callId))
  for (const row of events) {
    if (row.type !== 'tool/result') continue
    const message = record(record(row.data).message)
    if (!jobReads.has(message.toolCallId)) continue
    for (const block of message.content as { type: string; text?: string }[]) {
      if (block.type === 'text' && block.text !== undefined) {
        block.text = block.text.replace(/(分镜 [1-9]\d*\/[1-9]\d* (?:排队中|生成中)，已等待 )\d+( 秒)/gu, '$1{{elapsedSeconds}}$2')
      }
    }
  }
  return events.map(row => JSON.stringify(row)).join('\n') + '\n'
}

function returnedProject(body: unknown): JsonRow {
  const messages = record(body).messages as { content: { type: string; tool_use_id?: string; content?: unknown }[] }[]
  const result = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === 'video-start')
  if (result === undefined) throw new Error('The model request must include the real project result')
  const content = result.content
  const text = typeof content === 'string' ? content
    : (content as { type: string; text?: string }[]).filter(block => block.type === 'text').map(block => block.text).join('')
  return record(JSON.parse(text))
}

it.skipIf(!runtimeAvailable)('records shot-bound video/audio plan references through real native requests and terminal job_output (requires prepared DSH_VIDEO_TEST_RUNTIME_ROOT)', async (test) => {
  if (runtimeRoot === undefined) throw new Error('Provide the existing prepared FFmpeg/ffprobe runtime')
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This authored scenario captures only its loopback fixture in refresh mode')
  const firstRecording = !existsSync(FIXTURE)
  if (firstRecording && mode !== 'refresh') throw new Error('Create this authored fixture with DSH_SNAPSHOT=refresh')
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-references-session-'))
  const cleanup: { socket?: () => Promise<void>; host?: () => Promise<void>; fixture?: () => Promise<void> } = {}
  test.onTestFinished(async () => {
    try { await cleanup.socket?.() }
    finally {
      try { await cleanup.host?.() }
      finally {
        try { await cleanup.fixture?.() }
        finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const workspace = join(root, 'workspace')
  const persistence = join(root, 'sessions')
  await Promise.all([mkdir(workspace), mkdir(persistence)])
  const referenceFiles = ['reference-one.mp4', 'reference-two.mp4', 'voice-one.wav', 'voice-two.wav']
  for (const file of referenceFiles) await copyFile(join(SNAPSHOT_DIR, 'workspace.expected', file), join(workspace, file))
  const videoReferences = await Promise.all(referenceFiles.slice(0, 2).map(file => readFile(join(workspace, file))))
  const audioReferences = await Promise.all(referenceFiles.slice(2).map(file => readFile(join(workspace, file))))
  const posts: JsonRow[] = []
  const submittedShots = new Set<number>()
  let firstTaskObserved = false
  let releaseSecondSubmission: (() => void) | undefined
  const queries: string[] = []
  const modelRequests: unknown[] = []
  const errors: string[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body: unknown = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      response.setHeader('content-type', 'application/json')
      const answer = (data: object | null): void => { response.end(JSON.stringify({ success: true, data })) }
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500_000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: 'video-references-challenge', delivery_status: 'accepted',
          expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=video-references-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'video-references-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-video-references-relay', relay_key_id: 9, session: { sid: 'video-references-login', current: true },
          user: { id: 7, username: 'video-references-user', quota: 500_000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'video-references-user', group: 'product', quota: 500_000 }); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-video-references-relay')
        response.end(JSON.stringify({ data: [{ id: 'MiniMax-H3', object: 'model', supported_endpoint_types: ['openai'] }] })); return
      }
      if (path === '/harness/api/pricing') {
        answer([{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai'], parameters: {
          'x-client-concurrency': { schema: 1, atomic_admission: true, max_parallelism: 2, model: 'MiniMax-H3',
            scope: 'shared_account_pool', reservation: false },
        } }]); return
      }
      if (path === '/harness/v1/video/generations' && request.method === 'POST') {
        expect(request.headers.authorization).toBe('Bearer sk-video-references-relay')
        const value = record(body)
        const prompt = value.prompt
        const index = SHOT_PROMPTS.findIndex(marker => typeof prompt === 'string' && prompt.includes(marker))
        if (index < 0 || submittedShots.has(index)) throw new Error('Unexpected or repeated clip submission')
        submittedShots.add(index)
        posts.push(value)
        const content = record(value.metadata).content
        expect(content).toEqual([
          { type: 'text', text: prompt },
          { type: 'video_url', role: 'reference_video', video_url: { url: `data:video/mp4;base64,${videoReferences[index]!.toString('base64')}` } },
          { type: 'audio_url', role: 'reference_audio', audio_url: { url: `data:audio/wav;base64,${audioReferences[index]!.toString('base64')}` } },
        ])
        const accepted = (): void => { response.end(JSON.stringify({ code: 'success', data: { task_id: `progress-task-${String(index + 1)}` } })) }
        // The first task's GET proves its retained receipt and submission log precede task two.
        if (index === 1 && !firstTaskObserved) releaseSecondSubmission = accepted
        else accepted()
        return
      }
      if (/^\/harness\/v1\/tasks\/progress-task-[12]$/u.test(path)) {
        expect(request.headers.authorization).toBe('Bearer sk-video-references-relay')
        queries.push(path)
        response.end(JSON.stringify({ code: 'success', data: { status: path.endsWith('-1') ? 'NOT_START' : 'IN_PROGRESS' } }))
        if (path.endsWith('-1')) { firstTaskObserved = true; releaseSecondSubmission?.() }
        return
      }
      if (path === '/v1/messages') {
        if (!firstRecording) throw new Error('Readonly replay must not contact the external model fixture')
        expect(request.headers['x-api-key']).toBe('keyless-video-references-fixture')
        modelRequests.push(body)
        const attempt = modelRequests.length
        let tool: { id: string; name: string; args: object } | undefined
        if (attempt === 1) tool = { id: 'reference-plan', name: 'update_creation_plan', args: {
          kind: 'video', title: 'Two reference-isolated shots', brief: 'One eight-second synthetic reference video',
          assets: referenceFiles.map((source, index) => ({ id: `asset_${String(index + 1)}`, name: source,
            kind: index < 2 ? 'video' : 'audio', source_path_or_asset_id: source })),
          shots: SHOT_PROMPTS.map((prompt, index) => ({ id: `shot_${String(index + 1)}`, order: index + 1,
            title: `Shot ${String(index + 1)}`, prompt, duration_seconds: 4,
            asset_ids: [`asset_${String(index + 1)}`, `asset_${String(index + 3)}`] })),
        } }
        if (attempt === 2) {
          const messages = record(body).messages as { content: { type: string; tool_use_id?: string; content?: unknown }[] }[]
          const result = messages.flatMap(message => message.content).find(block => block.type === 'tool_result' && block.tool_use_id === 'reference-plan')
          if (result === undefined) throw new Error('Expected actual saved plan result')
          const content = result.content
          const raw = typeof content === 'string' ? content : (content as { type: string; text?: string }[])
            .filter(block => block.type === 'text').map(block => block.text).join('')
          const plan = record(JSON.parse(raw))
          if (plan.status !== 'saved' || typeof plan.plan_id !== 'string') throw new Error(`Invalid actual plan result: ${raw}`)
          tool = { id: 'video-start', name: 'generate_video_project', args: {
            plan_id: plan.plan_id, shot_ids: ['shot_1', 'shot_2'], model: 'MiniMax-H3',
            prompt: 'Two independently reference-bound synthetic clips', total_duration_seconds: 8,
          } }
        }
        if (attempt >= 4 && attempt <= 6) {
          const job = returnedProject(body).job_id
          if (typeof job !== 'string') throw new Error('Expected the actual registered job id')
          tool = { id: `video-control-${String(attempt)}`, name: attempt === 5 ? 'job_kill' : 'job_output',
            args: { job_id: job, ...attempt === 6 ? { wait: true, timeout_ms: 10000 } : {} } }
        }
        if (![1, 2, 3, 4, 5, 6, 7].includes(attempt)) throw new Error('Unexpected model continuation')
        response.setHeader('content-type', 'text/event-stream')
        const events: object[] = [{ type: 'message_start', message: { id: `progress-message-${String(attempt)}`, type: 'message',
          role: 'assistant', model: 'synthetic', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }]
        if (tool !== undefined) events.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } },
        )
        else events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: attempt === 3 ? 'PROJECT_STARTED' : 'OBSERVATION_STOPPED' } })
        events.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta',
          delta: { stop_reason: tool === undefined ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' })
        response.end(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('')); return
      }
      errors.push(path)
      response.writeHead(404); response.end('{}')
    })().catch((error: unknown) => { errors.push(String(error)); response.destroy() })
  })
  cleanup.fixture = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a loopback fixture port')
  const origin = `http://127.0.0.1:${String(address.port)}`
  let replayOverride: string | undefined
  if (!firstRecording) {
    const recorded = await readFile(FIXTURE, 'utf8')
    const token = record(JSON.parse(results(recorded)[0]!.text)).plan_id
    if (typeof token !== 'string' || !/^\{\{id:[1-9]\d*\}\}$/u.test(token)) throw new Error('Expected recorded typed plan identity')
    // Bind only the saved-plan relationship in recorded model arguments to this replay's actual tool result.
    const binding = '{{fromRequest:"plan_id":"(cp_[a-f0-9-]{36})"}}'
    const script = JSON.stringify(deriveReplayScript(parseSessionLog(recorded))).replaceAll(token, JSON.stringify(binding).slice(1, -1))
    replayOverride = join(root, 'video-references-replay.json')
    await writeFile(replayOverride, script)
  }
  const overlay = join(root, 'video-references.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' } },
    { id: 'session-persistence-jsonl', config: { root: persistence, compression: 'none' } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'product-extensions', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'computer-use', disabled: true }, { id: 'computer-use-cua-driver-native', disabled: true },
    { id: 'credits-index', config: { newApiBaseUrl: `${origin}/harness`, baseUrl: '', bridgeBaseUrl: '', creditsPerYuan: 1000,
      stateDir: join(root, 'credits'), videoRuntimeRoot: runtimeRoot, videoProjectConcurrency: 2, videoProjectPollIntervalMs: 60000,
      videoProjectTaskTimeoutMs: 120000, videoEditTimeoutMs: 60000 } },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'llm-deepseek', disabled: !firstRecording, config: { apiKeyEnv: KEY, baseURL: origin,
      reasoningEffort: 'off', thinking: 'disabled', models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000, inputModalities: ['text'] }] } },
    ...firstRecording ? [] : [{ insert: [{ id: 'llm-replay', name: REPLAY_MODULE, config: { file: FIXTURE, overrideFile: replayOverride,
      providers: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000,
        inputModalities: ['text'], defaultMaxTokens: 256_000, reasoningEfforts: ['off'], defaultReasoningEffort: 'off' }] }] } }] }],
  ]))
  const host = await startWeb(root, workspace, overlay)
  cleanup.host = () => host.stop()
  const post = async (path: string, args: object) => {
    const response = await fetch(new URL(path, host.webUrl), { method: 'POST', headers: { 'content-type': 'application/json', cookie: host.cookie },
      body: JSON.stringify(args), signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`)
    return record(await response.json())
  }
  expect(await post('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'progress-challenge' })).toMatchObject({ ok: true })
  expect(await post('/credits/api/session/verify', { challengeId: 'video-references-challenge', code: '123456', idempotencyKey: 'progress-login' }))
    .toMatchObject({ ok: true })
  const { sessionId } = await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })
  const socket = new WebSocket(host.webUrl.replace(/^http/u, 'ws') + '/api/remote.mux', { headers: { cookie: host.cookie } })
  const closed = new Promise<void>(resolve => socket.once('close', () => { resolve() }))
  cleanup.socket = async () => {
    socket.close()
    const timer = setTimeout(() => { socket.terminate() }, 2000)
    timer.unref()
    try { await closed } finally { clearTimeout(timer) }
  }
  let observed: JsonRow[] = []
  socket.on('message', (bytes) => {
    try {
      const data = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      const frame = record(JSON.parse(data.toString('utf8')))
      if (frame.type === 'item') {
        const value = record(frame.value)
        if (value.type === 'rows' && Array.isArray(value.jobs)) observed = value.jobs.map(record)
      }
      if (frame.type === 'error') errors.push(JSON.stringify(frame))
    } catch (error) { errors.push(String(error)) }
  })
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  socket.send(JSON.stringify({ type: 'open', streamId: 'video-references-roster', endpoint: 'job/list',
    payload: { args: { request: { sessionId } } } }))
  if (!firstRecording) expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
  for (const [index, prompt] of PROMPTS.entries()) {
    if (index === 1) await expect.poll(() => observed.find(job => job.kind === 'video-project')?.progress, { timeout: 30000 })
      .toMatch(/分镜 1\/2 排队中[\s\S]*分镜 2\/2 生成中/u)
    await host.remote('session/prompt', { request: { requestId: `video-references-intent-${String(index + 1)}`, sessionId, mode: 'queue',
      clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: prompt }] } })
    await expect.poll(async () => {
      try { return rows(await storedSession(persistence, sessionId)).filter(row => row.type === 'turn/end').length }
      catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT'
          || error instanceof Error && error.message.startsWith('No persisted Session')) return 0
        throw error
      }
    }, { timeout: 30000 }).toBe(index + 1)
  }
  await expect.poll(() => observed.find(job => job.kind === 'video-project')?.status, { timeout: 10000 }).toBe('killed')
  expect(observed.find(job => job.kind === 'video-project')?.progress).toBeUndefined()
  const raw = await storedSession(persistence, sessionId)
  const output = results(raw)
  expect(output.map(result => result.name)).toEqual(['update_creation_plan', 'generate_video_project', 'job_output', 'job_kill', 'job_output'])
  expect(output[2]?.text).toMatch(/分镜 1\/2 排队中[\s\S]*分镜 2\/2 生成中/u)
  expect(output[4]?.text).toContain(['视频项目：项目已停止 · 已保存 0/2 段',
    '分镜 1/2 查询已暂停，保留原任务', '分镜 2/2 查询已暂停，保留原任务'].join('\n'))
  expect(output[4]?.text).toContain('progress-task-1')
  expect(output[4]?.text).toContain('progress-task-2')
  expect(posts).toHaveLength(2)
  expect(posts.map(post => SHOT_PROMPTS.findIndex(marker => String(post.prompt).includes(marker))).toSorted()).toEqual([0, 1])
  expect([...new Set(queries)].toSorted()).toEqual([
    '/harness/v1/tasks/progress-task-1', '/harness/v1/tasks/progress-task-2',
  ])
  expect(modelRequests).toHaveLength(firstRecording ? 7 : 0)
  expect(errors).toEqual([])
  await cleanup.socket()
  await host.stop()
  const projectId = record(JSON.parse(output[1]!.text)).project_id
  if (typeof projectId !== 'string' || !/^vp_[a-f0-9-]{36}$/u.test(projectId)) throw new Error('Expected the actual typed project ID')
  const outputPath = `artifacts/videos/${projectId}`
  const stableOutputPath = 'artifacts/videos/{{projectId}}'
  const actualWorkspace = (await captureWorkspaceSnapshot(workspace)).map(entry =>
    entry.path === outputPath ? { ...entry, path: stableOutputPath } : entry)
  // This independent tree keeps only the expected empty project directory in Git.
  const expectedWorkspace = (await captureWorkspaceSnapshot(join(SNAPSHOT_DIR, 'workspace.expected'))).map((entry) => {
    if (entry.path !== `${stableOutputPath}/.empty`) return entry
    expect(entry).toEqual({ path: `${stableOutputPath}/.empty`, kind: 'text', content: '' })
    return { path: stableOutputPath, kind: 'empty-directory' as const }
  })
  expect(actualWorkspace, 'complete final workspace, including the actual project output directory').toEqual(expectedWorkspace)
  const normalizedRaw = normalizeProjectOutput(normalizeWebSessionVolatiles(raw))
  const context = { sessionIds: [sessionId], cwd: workspace }
  const prompts = normalizedSystemPrompts(normalizedRaw, context)
    .map(prompt => prompt.split(REPO_ROOT).join('{{sourceRoot}}').split(host.webUrl).join('{{webUrl}}'))
  const schemas = normalizedToolSchemas(normalizedRaw, context)
  const promptSidecar = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
  const schemaSidecar = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
  if (firstRecording) await writeFile(FIXTURE, redactSessionSnapshotIds([
    scrubSessionSnapshot(tokenizeSessionFixtureCwd(normalizedRaw)),
  ])[0]!)
  const expected = await readFile(FIXTURE, 'utf8')
  expect(normalizeSessionSnapshots([normalizedRaw], context)[0]).toBe(normalizeSessionSnapshots([expected], fixtureContext(expected))[0])
  expect(promptSidecar).toBe(await readFile(join(HEADER_DIR, 'system-prompt.expected.md'), 'utf8'))
  expect(schemaSidecar).toBe(await readFile(join(HEADER_DIR, 'tool-schemas.expected.json'), 'utf8'))
})
