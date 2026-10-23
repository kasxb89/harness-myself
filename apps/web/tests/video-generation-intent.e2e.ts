/** A real Session cannot turn one human video request into extra billable versions. */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  captureExpectedWorkspaceSnapshot, captureWorkspaceSnapshot, fixtureContext,
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds,
  scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'
import { fixtureUserPrompts, normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/video-generation-intent', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const HEADER_DIR = fileURLToPath(new URL('../../../snapshots/web/h3-submission-outcomes', import.meta.url))
const PROMPTS = ['用H3生成一条15秒的视频。', '再生成一条15秒的视频。'] as const
const MEDIA_SEED = fileURLToPath(new URL('./fixtures/video-generation-intent/provider-red-15s.mp4', import.meta.url))
const runtimeRoot = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const ffprobe = runtimeRoot === undefined ? undefined : join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const runtimeAvailable = runtimeRoot !== undefined && ['ffmpeg', 'ffprobe'].every(tool =>
  existsSync(join(runtimeRoot, 'bin', process.platform === 'win32' ? `${tool}.exe` : tool)))
const KEY = 'DSH_VIDEO_INTENT_FIXTURE_KEY'
const REPLAY_MODULE = pathToFileURL(createRequire(join(REPO_ROOT, 'apps/cli/package.json'))
  .resolve('@deepseek-ai/dsh-llm-replay')).href

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
      DSH_PERMISSION_MODE: undefined, [KEY]: 'keyless-video-intent-fixture',
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

function toolResults(raw: string): { name: string; text: string; message: JsonRow; error: unknown }[] {
  const events = rows(raw)
  const names = new Map(events.filter(row => row.type === 'tool/call').map((row) => {
    const data = record(row.data)
    return [data.callId, String(data.name)]
  }))
  return events.filter(row => row.type === 'tool/result').map((row) => {
    const data = record(row.data)
    const message = record(data.message)
    const content = message.content as { type: string; text?: string }[]
    return { name: names.get(message.toolCallId) ?? '', message, error: data.error,
      text: content.filter(block => block.type === 'text').map(block => block.text).join('') }
  })
}

/** Only typed creation IDs actually returned by successful tools are volatile. */
function tokenizeCreationIdentities(raw: string): string {
  const identities = new Map<string, string>()
  for (const result of toolResults(raw)) {
    if (result.message.isError === true) continue
    const value = record(JSON.parse(result.text))
    for (const [key, prefix] of [['plan_id', 'cp_'], ['operation_id', 'op_']] as const) {
      const id = value[key]
      if (id === undefined) continue
      if (typeof id !== 'string' || !id.startsWith(prefix) || !/^[a-z]{2}_[a-f0-9-]{36}$/u.test(id)) throw new Error(`Invalid typed ${key}`)
      if (!identities.has(id)) identities.set(id, `{{id:${String(1001 + identities.size)}}}`)
    }
  }
  for (const [value, token] of identities) raw = raw.split(value).join(token)
  return raw
}

function modelToolResult(body: unknown, callId: string): string {
  const messages = record(body).messages as { content: { type: string; tool_use_id?: string; content?: unknown }[] }[]
  const result = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === callId)
  if (result === undefined) throw new Error(`The real model request has no ${callId} result`)
  return typeof result.content === 'string' ? result.content
    : (result.content as { type: string; text?: string }[]).filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Normalize only successful tool-returned media paths, including their exact JSON-escaped spelling. */
function normalizeIntentOutput(raw: string): string {
  const media = toolResults(raw).filter(result => result.name === 'generate_video' && result.message.isError !== true)
    .map(result => record(JSON.parse(result.text))).filter(value => value.status === 'succeeded')
  if (media.length !== 2) throw new Error('Expected two real successful media results')
  const paths = media.map((value) => {
    if (typeof value.path !== 'string' || !isAbsolute(value.path)) throw new Error('Expected a real saved media path')
    return value.path
  })
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value
      for (const [index, path] of paths.entries()) {
        const token = `{{artifactPath:${String(index + 1)}}}`
        text = text.split(JSON.stringify(path).slice(1, -1)).join(token).split(path).join(token)
      }
      return text
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    return value
  }
  return tokenizeCreationIdentities(rows(raw).map(row => JSON.stringify(replace(row))).join('\n') + '\n')
}

const plan = { kind: 'video', title: 'First requested video', brief: 'One15-second synthetic red shot',
  characters: [], assets: [], shots: [{ id: 'intent-shot', order: 1, title: 'Single requested shot', duration_seconds: 15,
    prompt: 'A synthetic red frame remains still' }] }

it.skipIf(!runtimeAvailable)('records one shared video allowance per human request across revised plans and both generation tools (requires prepared DSH_VIDEO_TEST_RUNTIME_ROOT)', async (test) => {
  if (runtimeRoot === undefined || ffprobe === undefined) throw new Error('Provide the existing prepared native video runtime')
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This authored scenario captures only its loopback fixture in refresh mode')
  const firstRecording = !existsSync(FIXTURE)
  if (firstRecording && mode !== 'refresh') throw new Error('Create this authored fixture with DSH_SNAPSHOT=refresh')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-generation-intent-')))
  const cleanup: { host?: () => Promise<void>; fixture?: () => Promise<void> } = {}
  test.onTestFinished(async () => {
    try { await cleanup.host?.() }
    finally {
      try { await cleanup.fixture?.() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const workspace = join(root, 'workspace')
  const persistence = join(root, 'sessions')
  await Promise.all([mkdir(workspace), mkdir(persistence)])
  const video = await readFile(MEDIA_SEED)
  const posts: unknown[] = [], queries: string[] = [], downloads: string[] = [], modelRequests: unknown[] = [], errors: string[] = []
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
        answer({ challenge_id: 'intent-challenge', delivery_status: 'accepted',
          expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=intent-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'intent-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-intent-relay', relay_key_id: 9, session: { sid: 'intent-login', current: true },
          user: { id: 7, username: 'intent-user', quota: 500_000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'intent-user', group: 'product', quota: 500_000 }); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-intent-relay')
        response.end(JSON.stringify({ data: [{ id: 'MiniMax-H3', object: 'model', supported_endpoint_types: ['openai-video'] }] })); return
      }
      if (path === '/harness/api/pricing') { answer([{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]); return }
      if (path === '/harness/v1/video/generations' && request.method === 'POST') {
        expect(request.headers.authorization).toBe('Bearer sk-intent-relay')
        posts.push(body)
        if (posts.length > 2) throw new Error('One human request cannot authorize a model-invented extra version')
        expect(record(body)).toMatchObject({ duration: 15, seconds: 15 })
        response.end(JSON.stringify({ code: 'success', data: { task_id: `intent-task-${String(posts.length)}` } })); return
      }
      if (/^\/harness\/v1\/tasks\/intent-task-[12]$/u.test(path) && request.method === 'GET') {
        expect(request.headers.authorization).toBe('Bearer sk-intent-relay')
        queries.push(path)
        response.end(JSON.stringify({ task_id: path.split('/').at(-1), status: 'SUCCESS' })); return
      }
      if (/^\/harness\/v1\/videos\/intent-task-[12]\/content$/u.test(path) && request.method === 'GET') {
        expect(request.headers.authorization).toBe('Bearer sk-intent-relay')
        downloads.push(path)
        response.setHeader('content-type', 'video/mp4'); response.setHeader('content-length', video.length); response.end(video); return
      }
      if (path === '/v1/messages') {
        if (!firstRecording) throw new Error('Readonly replay must not contact the external model fixture')
        expect(request.headers['x-api-key']).toBe('keyless-video-intent-fixture')
        modelRequests.push(body)
        const attempt = modelRequests.length
        let tool: { id: string; name: string; args: object } | undefined
        const planId = (): string => {
          const value = record(JSON.parse(modelToolResult(body, 'intent-plan-v1'))).plan_id
          if (typeof value !== 'string') throw new Error('Expected the actual saved plan ID')
          return value
        }
        if (attempt === 1) tool = { id: 'intent-plan-v1', name: 'update_creation_plan', args: plan }
        if ([2, 6, 8].includes(attempt)) tool = { id: `intent-generate-${String(attempt)}`, name: 'generate_video', args: {
          model: 'MiniMax-H3', plan_id: planId(), shot_id: 'intent-shot', duration_seconds: 15, prompt: 'A synthetic red frame remains still',
        } }
        if (attempt === 3) tool = { id: 'intent-read-plan', name: 'get_creation_plan', args: { plan_id: planId() } }
        if (attempt === 4) {
          const value = record(JSON.parse(modelToolResult(body, 'intent-read-plan')))
          tool = { id: 'intent-plan-v2', name: 'update_creation_plan', args: {
            ...record(value.plan), plan_id: planId(), title: 'Model-invented version two',
          } }
        }
        if (attempt === 5) tool = { id: 'intent-project-extra', name: 'generate_video_project', args: {
          model: 'MiniMax-H3', plan_id: planId(), shot_ids: ['intent-shot'], total_duration_seconds: 15,
          prompt: 'A synthetic revised version which the user did not request',
        } }
        if (attempt < 1 || attempt > 9) throw new Error('Unexpected model continuation')
        response.setHeader('content-type', 'text/event-stream')
        const events: object[] = [{ type: 'message_start', message: { id: `intent-message-${String(attempt)}`, type: 'message',
          role: 'assistant', model: 'synthetic', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }]
        if (tool !== undefined) events.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } },
        )
        else events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Observed result retained. No unrequested version is authorized.' } })
        events.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta',
          delta: { stop_reason: tool === undefined ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' })
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
    const first = record(JSON.parse(toolResults(recorded)[0]!.text))
    const token = first.plan_id
    if (typeof token !== 'string' || !/^\{\{id:[1-9]\d*\}\}$/u.test(token)) throw new Error('Expected the recorded typed plan ID')
    const binding = '{{fromRequest:"plan_id":"(cp_[a-f0-9-]{36})"}}'
    const script = JSON.stringify(deriveReplayScript(parseSessionLog(recorded))).replaceAll(token, JSON.stringify(binding).slice(1, -1))
    replayOverride = join(root, 'intent-replay.json')
    await writeFile(replayOverride, script)
  }
  const overlay = join(root, 'video-intent.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' } },
    { id: 'session-persistence-jsonl', config: { root: persistence, compression: 'none' } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'product-extensions', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'computer-use', disabled: true }, { id: 'computer-use-cua-driver-native', disabled: true },
    { id: 'credits-index', config: { newApiBaseUrl: `${origin}/harness`, baseUrl: '', bridgeBaseUrl: '',
      creditsPerYuan: 1000, stateDir: join(root, 'credits'), videoRuntimeRoot: runtimeRoot, videoEditFps: 10 } },
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
      body: JSON.stringify(args), signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`)
    return record(await response.json())
  }
  expect(await post('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'intent-challenge' })).toMatchObject({ ok: true })
  expect(await post('/credits/api/session/verify', { challengeId: 'intent-challenge', code: '123456', idempotencyKey: 'intent-login' }))
    .toMatchObject({ ok: true })
  const { sessionId } = await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })
  if (!firstRecording) expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
  for (const [index, prompt] of PROMPTS.entries()) {
    expect(posts).toHaveLength(index)
    await host.remote('session/prompt', { request: { requestId: `video-intent-human-${String(index + 1)}`, sessionId, mode: 'queue',
      clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: prompt }] } })
    await expect.poll(async () => {
      try { return rows(await storedSession(persistence, sessionId)).filter(row => row.type === 'turn/end').length }
      catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT'
          || error instanceof Error && error.message.startsWith('No persisted Session')) return 0
        throw error
      }
    }, { timeout: 30_000 }).toBe(index + 1)
    expect(posts).toHaveLength(index + 1)
  }
  const raw = await storedSession(persistence, sessionId)
  const results = toolResults(raw)
  expect(results.map(result => result.name)).toEqual([
    'update_creation_plan', 'generate_video', 'get_creation_plan', 'update_creation_plan',
    'generate_video_project', 'generate_video', 'generate_video',
  ])
  const values = results.map(result => record(JSON.parse(result.text)))
  expect(values).toMatchObject([
    { status: 'saved' }, { status: 'succeeded' }, { status: 'succeeded', plan: { title: plan.title } }, { status: 'saved' },
    { status: 'failed', code: 'CREATIVE_VIDEO_COUNT_LIMIT' }, { status: 'failed', code: 'CREATIVE_VIDEO_COUNT_LIMIT' },
    { status: 'succeeded' },
  ])
  expect(values[3]?.plan_id).toBe(values[0]?.plan_id)
  const successes = [values[1]!, values[6]!]
  expect(successes[0]?.operation_id).not.toBe(successes[1]?.operation_id)
  const outputPaths: string[] = []
  for (const value of successes) {
    if (typeof value.path !== 'string' || typeof value.operation_id !== 'string') throw new Error('Expected actual successful saved media')
    expect(value.path.startsWith(root + sep), 'generated media stays in this test\'s private output root').toBe(true)
    outputPaths.push(value.path)
    const bytes = await readFile(value.path)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(video).digest('hex'))
    const metadata = record(JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height',
      '-of', 'json', value.path], { encoding: 'utf8', timeout: 30_000 })))
    expect(Number(record(metadata.format).duration)).toBeCloseTo(15, 1)
    expect(metadata.streams).toContainEqual({ codec_type: 'video', width: 160, height: 120 })
  }
  expect(new Set(outputPaths).size).toBe(2)
  expect(queries).toEqual(['/harness/v1/tasks/intent-task-1', '/harness/v1/tasks/intent-task-2'])
  expect(downloads).toEqual(['/harness/v1/videos/intent-task-1/content', '/harness/v1/videos/intent-task-2/content'])
  expect(posts).toHaveLength(2)
  expect(modelRequests).toHaveLength(firstRecording ? 9 : 0)
  if (firstRecording) {
    expect(modelToolResult(modelRequests[5], 'intent-project-extra')).toContain('CREATIVE_VIDEO_COUNT_LIMIT')
    expect(modelToolResult(modelRequests[6], 'intent-generate-6')).toContain('CREATIVE_VIDEO_COUNT_LIMIT')
  }
  expect(errors).toEqual([])
  await host.stop()
  const operations = new Map(successes.map((value, index) => [value.operation_id, `operation-${String(index + 1)}`]))
  const frameDirectories = new Map<unknown, string>()
  const actualWorkspace = (await captureWorkspaceSnapshot(workspace)).map((entry) => {
    const match = /^\.yunshu-creative\/previews\/(op_[a-f0-9-]{36})\/(frames-[A-Za-z0-9]{6})\/(frame-[0-2]\.jpg)$/u.exec(entry.path)
    const operation = match?.[1], directory = match?.[2], frame = match?.[3]
    if (operation === undefined || directory === undefined || frame === undefined || !operations.has(operation)) return entry
    const previous = frameDirectories.get(operation)
    if (previous !== undefined) expect(directory).toBe(previous)
    frameDirectories.set(operation, directory)
    return { ...entry, path: `.yunshu-creative/previews/${operations.get(operation)!}/frames/${frame}` }
  }).toSorted((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  expect(frameDirectories.size).toBe(2)
  expect(actualWorkspace, 'complete independent preview workspace oracle')
    .toEqual(await captureExpectedWorkspaceSnapshot(join(SNAPSHOT_DIR, 'workspace.expected')))
  const normalizedRaw = normalizeIntentOutput(normalizeWebSessionVolatiles(raw))
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
