/** Native video jobs leave the chat available for independent queued and steering requests. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  captureWorkspaceSnapshot, fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot,
  latestPersistedSessionPaths, normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas,
  redactSessionSnapshotIds, scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'
import { fixtureUserPrompts, normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/video-background-chat', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const PROMPTS = [
  '来个10s视频', '来一个10秒视频', '只读第一条任务的进度一次，不要生成视频', '生成3个10秒视频',
  '只读第一条任务的进度一次，不要生成视频。读取后结束本轮等待。', '再来个10s视频',
  '恢复第一条视频的观察，不要新增生成', '来个10s视频，内容是独立的新画面',
] as const
const KEY = 'DSH_VIDEO_BACKGROUND_FIXTURE_KEY'
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
      DSH_PERMISSION_MODE: undefined, [KEY]: 'keyless-video-background-fixture',
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
    return { stop, remote, cookie, webUrl: new URL(authenticatedUrl).origin, diagnostics: () => output }
  } catch (error) {
    await stop()
    throw error
  }
}


function record(value: unknown): JsonRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as JsonRow
}

function toolResults(raw: string): { name: string; callId: string; text: string }[] {
  const events = rows(raw)
  const names = new Map(events.filter(row => row.type === 'tool/call').map((row) => {
    const data = record(row.data)
    return [data.callId, String(data.name)]
  }))
  return events.filter(row => row.type === 'tool/result').map((row) => {
    const message = record(record(row.data).message)
    const content = message.content as { type: string; text?: string }[]
    return { name: names.get(message.toolCallId) ?? '', callId: String(message.toolCallId),
      text: content.filter(block => block.type === 'text').map(block => block.text).join('') }
  })
}

function firstProject(body: unknown): JsonRow {
  const messages = record(body).messages as { content: { type: string; tool_use_id?: string; content?: unknown }[] }[]
  const result = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === 'background-start-1')
  if (result === undefined) throw new Error('Expected the retained first background project result')
  const text = typeof result.content === 'string' ? result.content
    : (result.content as { type: string; text?: string }[]).filter(block => block.type === 'text').map(block => block.text).join('')
  return record(JSON.parse(text))
}

function normalizeOutput(raw: string): string {
  const identities = new Map<string, string>()
  for (const result of toolResults(raw)) {
    if (!['generate_video_project', 'resume_video_project'].includes(result.name)) continue
    const value = record(JSON.parse(result.text))
    for (const [key, prefix] of [['project_id', 'vp_'], ['plan_id', 'cp_']] as const) {
      const id = value[key]
      if (key === 'plan_id' && id === undefined) continue
      if (typeof id !== 'string' || !id.startsWith(prefix) || !/^[a-z]{2}_[a-f0-9-]{36}$/u.test(id)) throw new Error(`Invalid ${key}`)
      if (!identities.has(id)) identities.set(id, `{{id:${String(1001 + identities.size)}}}`)
    }
  }
  for (const [id, token] of identities) raw = raw.split(id).join(token)
  const events = rows(raw)
  const reads = new Set(events.filter(row => row.type === 'tool/call' && record(row.data).name === 'job_output')
    .map(row => record(row.data).callId))
  for (const row of events) {
    if (row.type !== 'tool/result') continue
    const message = record(record(row.data).message)
    if (!reads.has(message.toolCallId)) continue
    for (const block of message.content as { type: string; text?: string }[]) {
      if (block.type === 'text' && block.text !== undefined) {
        block.text = block.text.replace(/(分镜 [1-9]\d*\/[1-9]\d* (?:排队中|生成中)，已等待 )\d+( 秒)/gu, '$1{{elapsedSeconds}}$2')
      }
    }
  }
  return events.map(row => JSON.stringify(row)).join('\n') + '\n'
}

it.skipIf(!runtimeAvailable)('records independent native video requests while original jobs remain running (requires prepared DSH_VIDEO_TEST_RUNTIME_ROOT)', async (test) => {
  if (runtimeRoot === undefined) throw new Error('Provide the existing prepared FFmpeg runtime')
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This authored loopback scenario is captured only in refresh mode')
  const firstRecording = !existsSync(FIXTURE)
  if (firstRecording && mode !== 'refresh') throw new Error('Create this authored fixture with DSH_SNAPSHOT=refresh')
  const script = firstRecording ? undefined : deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
  if (!firstRecording) expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-background-chat-'))
  const cleanup: { host?: () => Promise<void>; fixture?: () => Promise<void>; release?: () => void } = {}
  test.onTestFinished(async () => {
    cleanup.release?.()
    try { await cleanup.host?.() }
    finally {
      try { await cleanup.fixture?.() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const workspace = join(root, 'workspace'), persistence = join(root, 'sessions'), credits = join(root, 'credits')
  await Promise.all([mkdir(workspace), mkdir(persistence)])
  const posts: JsonRow[] = [], queries: string[] = [], modelRequests: unknown[] = [], errors: string[] = []
  let heldRead: number | undefined
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body: unknown = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      response.setHeader('content-type', 'application/json')
      const answer = (data: object): void => { response.end(JSON.stringify({ success: true, data })) }
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500_000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: 'background-challenge', delivery_status: 'accepted',
          expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=background-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'background-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-background-relay', relay_key_id: 9, session: { sid: 'background-login', current: true },
          user: { id: 7, username: 'background-user', quota: 500_000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'background-user', group: 'product', quota: 500_000 }); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-background-relay')
        response.end(JSON.stringify({ data: [{ id: 'MiniMax-H3', object: 'model', supported_endpoint_types: ['openai-video'] }] })); return
      }
      if (path === '/harness/api/pricing') {
        answer([{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'], parameters: {
          'x-client-concurrency': { schema: 1, atomic_admission: true, max_parallelism: 10, model: 'MiniMax-H3',
            scope: 'shared_account_pool', reservation: false },
        } }]); return
      }
      if (path === '/harness/v1/video/generations' && request.method === 'POST') {
        expect(request.headers.authorization).toBe('Bearer sk-background-relay')
        const value = record(body)
        expect(value).toMatchObject({ duration: 10, seconds: 10 })
        expect(posts.some(post => post.prompt === value.prompt), 'no original operation may be submitted twice').toBe(false)
        posts.push(value)
        if (posts.length > 7) throw new Error('Unexpected new paid work')
        response.end(JSON.stringify({ code: 'success', data: { task_id: `background-task-${String(posts.length)}` } })); return
      }
      if (/^\/harness\/v1\/tasks\/background-task-[1-7]$/u.test(path) && request.method === 'GET') {
        expect(request.headers.authorization).toBe('Bearer sk-background-relay')
        queries.push(path)
        response.end(JSON.stringify({ code: 'success', data: { status: 'IN_PROGRESS' } })); return
      }
      if (path === '/v1/messages') {
        expect(request.headers['x-api-key']).toBe('keyless-video-background-fixture')
        modelRequests.push(body)
        const attempt = modelRequests.length
        let tools: { id: string; name: string; args: JsonRow }[] = []
        const generate = (id: number) => ({ id: `background-start-${String(id)}`, name: 'generate_video_project',
          args: { model: 'MiniMax-H3', prompt: `Independent synthetic background frame ${String(id)}` } })
        if (script === undefined) {
          if (attempt === 1 || attempt === 2 || attempt === 6 || attempt === 8) tools = [generate(attempt === 8 ? 7 : attempt)]
          if (attempt === 3 || attempt === 5) tools = [{ id: `background-read-${String(attempt)}`, name: 'job_output',
            args: { job_id: firstProject(body).job_id, wait: true, timeout_ms: 600000 } }]
          if (attempt === 4) tools = [generate(3), generate(4), generate(5)]
          if (attempt === 7) tools = [{ id: 'background-resume', name: 'resume_video_project', args: { project_id: firstProject(body).project_id } }]
        } else {
          const entry = script[attempt - 1]
          if (entry?.kind !== 'chunks') throw new Error('Expected a recorded native tool call')
          tools = entry.chunks.flatMap((chunk) => {
            if (chunk.type !== 'block-end' || chunk.block.type !== 'tool-call') return []
            const args = record(JSON.parse(chunk.block.arguments))
            if (typeof args.project_id === 'string' && /^\{\{id:[1-9]\d*\}\}$/u.test(args.project_id)) {
              args.project_id = firstProject(body).project_id
            }
            return [{ id: chunk.block.id, name: chunk.block.name, args }]
          })
        }
        if (tools.length === 0 || attempt > 8) throw new Error(`Unexpected model continuation ${String(attempt)}`)
        if (attempt === 3 || attempt === 5) {
          heldRead = attempt
          await new Promise<void>((resolve) => { cleanup.release = resolve })
          delete cleanup.release
          heldRead = undefined
        }
        response.setHeader('content-type', 'text/event-stream')
        const events: object[] = [{ type: 'message_start', message: { id: `background-message-${String(attempt)}`, type: 'message',
          role: 'assistant', model: 'synthetic', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }]
        for (const [index, tool] of tools.entries()) events.push(
          { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } },
          { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } },
          { type: 'content_block_stop', index },
        )
        events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } },
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
  const overlay = join(root, 'video-background.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' } },
    { id: 'session-persistence-jsonl', config: { root: persistence, compression: 'none' } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'product-extensions', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'computer-use', disabled: true }, { id: 'computer-use-cua-driver-native', disabled: true },
    { id: 'credits-index', config: { newApiBaseUrl: `${origin}/harness`, baseUrl: '', bridgeBaseUrl: '', creditsPerYuan: 1000,
      stateDir: credits, videoRuntimeRoot: runtimeRoot, videoProjectConcurrency: 4,
      videoProjectPollIntervalMs: 60000, videoProjectTaskTimeoutMs: 3600000, videoEditTimeoutMs: 60000 } },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'llm-deepseek', disabled: false, config: { apiKeyEnv: KEY, baseURL: origin, reasoningEffort: 'off', thinking: 'disabled',
      models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000, inputModalities: ['text'] }] } },
  ]))
  let host = await startWeb(root, workspace, overlay)
  const webOrigins = [host.webUrl]
  cleanup.host = async () => { await host.stop() }
  const post = async (path: string, args: object) => {
    const response = await fetch(new URL(path, host.webUrl), { method: 'POST', headers: { 'content-type': 'application/json', cookie: host.cookie },
      body: JSON.stringify(args), signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`)
    return record(await response.json())
  }
  expect(await post('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'background-challenge' })).toMatchObject({ ok: true })
  expect(await post('/credits/api/session/verify', { challengeId: 'background-challenge', code: '123456', idempotencyKey: 'background-login' }))
    .toMatchObject({ ok: true })
  const { sessionId } = await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })
  let lastRaw = ''
  test.onTestFailed(() => {
    console.error(JSON.stringify({ posts, queries, errors, modelRequests: modelRequests.length, host: host.diagnostics(),
      events: lastRaw === '' ? [] : rows(lastRaw).filter(row => ['assistant/message', 'assistant/attempt', 'tool/result', 'turn/end'].includes(String(row.type))) }, null, 2))
  })
  const prompt = async (index: number, delivery: 'queue' | 'steer' = 'queue') => {
    await host.remote('session/prompt', { request: { requestId: `background-human-${String(index + 1)}`, sessionId, mode: delivery,
      clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: PROMPTS[index] }] } })
  }
  const turns = async () => {
    try {
      lastRaw = await storedSession(persistence, sessionId)
      return rows(lastRaw).filter(row => row.type === 'turn/end').length
    }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT'
        || error instanceof Error && error.message.startsWith('No persisted Session')) return 0
      throw error
    }
  }
  for (const index of [0, 1]) {
    await prompt(index)
    await expect.poll(turns, { timeout: 30000 }).toBe(index + 1)
    await expect.poll(() => queries.includes(`/harness/v1/tasks/background-task-${String(index + 1)}`), { timeout: 10000 }).toBe(true)
    expect(posts).toHaveLength(index + 1)
  }
  await prompt(2)
  await expect.poll(() => heldRead, { timeout: 10000 }).toBe(3)
  await prompt(3, 'queue')
  cleanup.release?.()
  await expect.poll(turns, { timeout: 30000 }).toBe(4)
  await expect.poll(() => posts.length, { timeout: 10000 }).toBe(5)
  expect(queries.filter(path => path.endsWith('-1'))).toHaveLength(1)
  await prompt(4)
  await expect.poll(() => heldRead, { timeout: 10000 }).toBe(5)
  await prompt(5, 'steer')
  cleanup.release?.()
  await expect.poll(turns, { timeout: 30000 }).toBe(5)
  await expect.poll(() => posts.length, { timeout: 10000 }).toBe(6)
  await expect.poll(() => new Set(queries).size, { timeout: 10000 }).toBe(6)
  const beforeRestart = await storedSession(persistence, sessionId)
  const original = record(JSON.parse(toolResults(beforeRestart)[0]!.text))
  const projectId = original.project_id, planId = original.plan_id
  if (typeof projectId !== 'string' || typeof planId !== 'string') throw new Error('Expected retained project identities')
  const manifestPath = join(credits, 'video-projects', projectId, 'manifest.json')
  const originalSegment = record((record(JSON.parse(await readFile(manifestPath, 'utf8'))).segments as unknown[])[0])
  expect(originalSegment).toMatchObject({ taskId: 'background-task-1', status: 'running' })
  expect(originalSegment.attemptId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
  await host.stop()
  const legacyPath = join(credits, 'creative-projects', planId, 'project.json')
  const legacy = record(JSON.parse(await readFile(legacyPath, 'utf8')))
  const operations = legacy.operations as JsonRow[]
  expect(operations).toHaveLength(1)
  expect(operations[0]).toHaveProperty('requestGrant')
  delete operations[0]!.requestGrant
  await writeFile(legacyPath, JSON.stringify(legacy))
  host = await startWeb(root, workspace, overlay)
  webOrigins.push(host.webUrl)
  await host.remote('session/create', { request: { sessionId, cwd: workspace } })
  await prompt(6)
  await expect.poll(turns, { timeout: 30000 }).toBe(6)
  await expect.poll(() => queries.filter(path => path.endsWith('-1')).length, { timeout: 10000 }).toBe(2)
  expect(posts).toHaveLength(6)
  await prompt(7)
  await expect.poll(turns, { timeout: 30000 }).toBe(7)
  await expect.poll(() => posts.length, { timeout: 10000 }).toBe(7)
  await expect.poll(() => new Set(queries).size, { timeout: 10000 }).toBe(7)
  const raw = await storedSession(persistence, sessionId)
  const finalSegment = record((record(JSON.parse(await readFile(manifestPath, 'utf8'))).segments as unknown[])[0])
  expect(finalSegment).toMatchObject({ taskId: originalSegment.taskId, attemptId: originalSegment.attemptId, status: 'running' })
  const originalHuman = rows(raw).find(row => row.type === 'user/message' && record(record(row.data).source).kind === 'user')
  const retainedOperation = (record(JSON.parse(await readFile(legacyPath, 'utf8'))).operations as JsonRow[])[0]!
  if (retainedOperation.requestGrant !== undefined) {
    expect(record(retainedOperation.requestGrant).messageId).toBe(record(originalHuman!.data).id)
  }
  const output = toolResults(raw)
  expect(output.map(result => result.name)).toEqual([
    'generate_video_project', 'generate_video_project', 'job_output',
    'generate_video_project', 'generate_video_project', 'generate_video_project',
    'job_output', 'generate_video_project', 'resume_video_project', 'generate_video_project',
  ])
  for (const result of output.filter(result => result.name === 'job_output')) {
    expect(result.text).toContain('[status: running')
  }
  expect(output.find(result => result.callId === 'background-read-3')?.text).toContain('background-task-1')
  const starts = output.filter(result => result.name === 'generate_video_project').map(result => record(JSON.parse(result.text)))
  expect(starts).toHaveLength(7)
  expect(new Set(starts.map(value => value.project_id)).size).toBe(7)
  for (const value of starts) expect(value).toMatchObject({ status: 'background', plan_seconds: [10] })
  expect(modelRequests).toHaveLength(8)
  expect(errors).toEqual([])
  await host.stop()
  const projectOrder = new Map(starts.map((value, index) => [`artifacts/videos/${String(value.project_id)}`, `artifacts/videos/project-${String(index + 1)}`]))
  const actualWorkspace = (await captureWorkspaceSnapshot(workspace))
    .map(entry => ({ ...entry, path: projectOrder.get(entry.path) ?? entry.path }))
    .toSorted((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  const expectedWorkspace = (await captureWorkspaceSnapshot(join(SNAPSHOT_DIR, 'workspace.expected'))).map((entry) => {
    expect(entry).toMatchObject({ kind: 'text', content: '' })
    expect(entry.path).toMatch(/^artifacts\/videos\/project-[1-7]\/\.empty$/u)
    return { path: entry.path.slice(0, -'/.empty'.length), kind: 'empty-directory' as const }
  })
  expect(actualWorkspace).toEqual(expectedWorkspace)
  const normalizedRaw = normalizeOutput(normalizeWebSessionVolatiles(raw))
  const canonicalStarts = Object.fromEntries(toolResults(normalizedRaw)
    .filter(result => result.name === 'generate_video_project')
    .map(result => [result.callId, record(JSON.parse(result.text))]))
  const capturedResults = join(REPO_ROOT, '.artifacts/web-session-headers/video-background-chat')
  await mkdir(capturedResults, { recursive: true })
  await writeFile(join(capturedResults, 'tool-results.expected.json'), JSON.stringify(canonicalStarts, null, 2) + '\n')
  const context = { sessionIds: [sessionId], cwd: workspace }
  const prompts = normalizedSystemPrompts(normalizedRaw, context)
    .map((value) => {
      let normalized = value.split(REPO_ROOT).join('{{sourceRoot}}')
      for (const origin of webOrigins) normalized = normalized.split(origin).join('{{webUrl}}')
      return normalized
    })
  const schemas = normalizedToolSchemas(normalizedRaw, context)
  const promptSidecar = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
  const schemaSidecar = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
  if (firstRecording) {
    await writeFile(FIXTURE, redactSessionSnapshotIds([scrubSessionSnapshot(tokenizeSessionFixtureCwd(normalizedRaw))])[0]!)
  }
  if (firstRecording || mode === 'refresh') {
    await writeFile(join(SNAPSHOT_DIR, 'system-prompt.expected.md'), promptSidecar)
    await writeFile(join(SNAPSHOT_DIR, 'tool-schemas.expected.json'), schemaSidecar)
  }
  const expected = await readFile(FIXTURE, 'utf8')
  // The immutable recording remains the replay input. This exact output
  // golden records the later remaining-work contract without changing it.
  const expectedStarts = record(JSON.parse(await readFile(join(SNAPSHOT_DIR, 'tool-results.expected.json'), 'utf8')))
  expect(Object.keys(expectedStarts)).toEqual(Array.from({ length: 7 }, (_value, index) => `background-start-${index + 1}`))
  expect(Object.values(expectedStarts).map(value => record(value).remaining_works)).toEqual([0, 0, 2, 1, 0, 0, 0])
  expect(canonicalStarts).toEqual(expectedStarts)
  const expectedRows = rows(expected)
  const replaced: string[] = []
  for (const row of expectedRows) {
    if (row.type !== 'tool/result') continue
    const message = record(record(row.data).message)
    const callId = String(message.toolCallId)
    const replacement = expectedStarts[callId]
    if (replacement === undefined) continue
    message.content = [{ type: 'text', text: JSON.stringify(replacement) }]
    replaced.push(callId)
  }
  expect(replaced).toEqual(Object.keys(expectedStarts))
  const expectedOutput = expectedRows.map(row => JSON.stringify(row)).join('\n') + '\n'
  expect(normalizeSessionSnapshots([normalizedRaw], context)[0])
    .toBe(normalizeSessionSnapshots([expectedOutput], fixtureContext(expected))[0])
  expect(promptSidecar).toBe(await readFile(join(SNAPSHOT_DIR, 'system-prompt.expected.md'), 'utf8'))
  expect(schemaSidecar).toBe(await readFile(join(SNAPSHOT_DIR, 'tool-schemas.expected.json'), 'utf8'))
})
