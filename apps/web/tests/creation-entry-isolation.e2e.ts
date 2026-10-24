/** AI Creation submissions and a real chat request retain separate entry identities and duplicate guards. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import {
  captureExpectedWorkspaceSnapshot, captureWorkspaceSnapshot, fixtureContext, formatSystemPromptSnapshot,
  formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds,
  scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'
import { fixtureUserPrompts, normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/creation-entry-isolation', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const PROMPTS = ['用H3生成一条4秒的视频。'] as const
const KEY = 'DSH_CREATION_ENTRY_FIXTURE_KEY'
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
      DSH_PERMISSION_MODE: undefined, [KEY]: 'keyless-creation-entry-fixture',
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


/** Only creation identities declared by the real generate_video result are volatile. */
function tokenizeCreationIdentities(raw: string): string {
  const identities = new Map<string, string>()
  for (const result of toolResults(raw)) {
    for (const key of ['plan_id', 'operation_id'] as const) {
      const value = result[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || !/^(?:cp|op)_[a-f0-9-]{36}$/u.test(value)) throw new Error(`Missing typed ${key}`)
      if (!identities.has(value)) identities.set(value, `{{id:${1001 + identities.size}}}`)
    }
  }
  for (const [value, token] of identities) raw = raw.split(value).join(token)
  return raw
}

function toolResults(raw: string): JsonRow[] {
  return rows(raw).filter(row => row.type === 'tool/result').map((row) => {
    const data = row.data as { message: { content: { type: string; text?: string }[] } }
    const text = data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    return JSON.parse(text) as JsonRow
  })
}

it('records an independent chat video after AI Creation uncertainty while refusing another version from the same human request', async (test) => {
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This authored scenario records only its loopback fixture in refresh mode')
  const firstRecording = !existsSync(FIXTURE)
  if (firstRecording && mode !== 'refresh') throw new Error('Create this authored fixture with DSH_SNAPSHOT=refresh')
  const root = await mkdtemp(join(tmpdir(), 'dsh-creation-entry-isolation-'))
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
  const posts: unknown[] = []
  const modelRequests: unknown[] = []
  const errors: string[] = []
  const paths: string[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body: unknown = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      paths.push(path)
      response.setHeader('content-type', 'application/json')
      const answer = (data: object | null): void => { response.end(JSON.stringify({ success: true, data })) }
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500_000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: 'h3-synthetic-challenge', delivery_status: 'accepted',
          expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=h3-synthetic-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'h3-synthetic-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-h3-synthetic-relay', relay_key_id: 9, session: { sid: 'h3-synthetic-login', current: true },
          user: { id: 7, username: 'h3-synthetic-user', quota: 500_000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'h3-synthetic-user', group: 'product', quota: 500_000 }); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/api/client-errors') { answer({ accepted: true }); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-h3-synthetic-relay')
        response.end(JSON.stringify({ data: [{ id: 'MiniMax-H3', object: 'model', supported_endpoint_types: ['openai-video'] }] })); return
      }
      if (path === '/harness/api/pricing') { answer([{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]); return }
      if (path === '/harness/v1/video/generations') {
        expect(request.headers.authorization).toBe('Bearer sk-h3-synthetic-relay')
        posts.push(body)
        if (posts.length > 2) throw new Error('A duplicate entry request must not make another provider POST')
        response.end('{}'); return
      }
      if (path === '/v1/messages') {
        if (!firstRecording) throw new Error('Readonly replay must not contact the external model fixture')
        expect(request.headers['x-api-key']).toBe('keyless-creation-entry-fixture')
        modelRequests.push(body)
        const attempt = modelRequests.length
        if (attempt > 3) throw new Error('Unexpected model continuation')
        response.setHeader('content-type', 'text/event-stream')
        const events: object[] = [{ type: 'message_start', message: { id: `h3-message-${attempt}`, type: 'message', role: 'assistant',
          model: 'synthetic', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }]
        if (attempt < 3) {
          events.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `h3-call-${attempt}`,
            name: 'generate_video', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta',
            partial_json: JSON.stringify({ model: 'MiniMax-H3', prompt: 'An independent chat clip', duration_seconds: 4 }) } })
        } else {
          events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '原任务结果尚未确认；聊天中的新请求只提交了一次。' } })
        }
        events.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta',
          delta: { stop_reason: attempt < 3 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' })
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
  const overlay = join(root, 'h3-submission.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' } },
    { id: 'session-persistence-jsonl', config: { root: persistence, compression: 'none' } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'product-extensions', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'computer-use', disabled: true }, { id: 'computer-use-cua-driver-native', disabled: true },
    { id: 'credits-index', config: { newApiBaseUrl: `${origin}/harness`, baseUrl: '', bridgeBaseUrl: '',
      creditsPerYuan: 1000, stateDir: join(root, 'credits') } },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'llm-deepseek', disabled: !firstRecording, config: { apiKeyEnv: KEY, baseURL: origin,
      reasoningEffort: 'off', thinking: 'disabled', models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000, inputModalities: ['text'] }] } },
    ...firstRecording ? [] : [{ insert: [{ id: 'llm-replay', name: REPLAY_MODULE, config: { file: FIXTURE,
      providers: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000,
        inputModalities: ['text'], defaultMaxTokens: 256_000, reasoningEfforts: ['off'], defaultReasoningEffort: 'off' }] }] } }] }],
  ]))
  const host = await startWeb(root, workspace, overlay)
  cleanup.host = () => host.stop()
  const post = async (path: string, args: object) => {
    const response = await fetch(new URL(path, host.webUrl), { method: 'POST', headers: { 'content-type': 'application/json', cookie: host.cookie },
      body: JSON.stringify(args), signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`)
    return await response.json() as JsonRow
  }
  expect(await post('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'h3-challenge' })).toMatchObject({ ok: true })
  const signedIn = await post('/credits/api/session/verify', {
    challengeId: 'h3-synthetic-challenge', code: '123456', idempotencyKey: 'h3-login',
  })
  expect(signedIn.ok, JSON.stringify(signedIn)).toBe(true)
  const { sessionId } = await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })
  if (!firstRecording) expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
  const panelBody = { session_id: sessionId, account_id: '7', model: 'MiniMax-H3', durationSeconds: 4,
    prompt: 'An independent AI Creation clip' }
  const panel = await post('/credits/api/video/tasks?source=newapi-generate', panelBody)
  expect(panel).toMatchObject({ ok: false, code: 'NO_TASK_ID', submission_state: 'unknown' })
  expect(posts).toHaveLength(1)
  await host.remote('session/prompt', { request: { requestId: 'creation-entry-human-1', sessionId, mode: 'queue',
    clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: PROMPTS[0] }] } })
  await expect.poll(async () => {
    try { return rows(await storedSession(persistence, sessionId)).filter(row => row.type === 'turn/end').length }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT'
        || error instanceof Error && error.message.startsWith('No persisted Session')) return 0
      throw error
    }
  }, { timeout: 30_000 }).toBe(1)
  const raw = await storedSession(persistence, sessionId)
  const results = toolResults(raw)
  expect(results).toMatchObject([
    { status: 'unknown', code: 'NO_TASK_ID', submission_state: 'unknown' },
    { status: 'failed', code: 'CREATIVE_VIDEO_COUNT_LIMIT' },
  ])
  expect(results[0]?.plan_id).not.toBe(panel.plan_id)
  expect(await post('/credits/api/video/tasks?source=newapi-generate', panelBody))
    .toMatchObject({ ok: false, code: 'CREATIVE_SUBMISSION_UNKNOWN', plan_id: panel.plan_id, operation_id: panel.operation_id })
  const listed = await fetch(new URL(`/credits/api/creative/projects?session_id=${sessionId}`, host.webUrl),
    { headers: { cookie: host.cookie }, signal: AbortSignal.timeout(10_000) })
  const projects = (await listed.json() as {
    payload: { projects: { id: string; tasks: { source: string; status: string }[] }[] }
  }).payload.projects
  expect(projects).toHaveLength(2)
  expect(projects.find(project => project.id === panel.plan_id)?.tasks).toMatchObject([{ source: 'ai-creation', status: 'unknown' }])
  expect(projects.find(project => project.id === results[0]?.plan_id)?.tasks).toMatchObject([{ source: 'chat', status: 'unknown' }])
  expect(posts).toHaveLength(2)
  expect(paths.filter(path => path.startsWith('/harness/v1/tasks/'))).toEqual([])
  expect(modelRequests).toHaveLength(firstRecording ? 3 : 0)
  if (firstRecording) expect(JSON.stringify(modelRequests[2])).toContain('CREATIVE_VIDEO_COUNT_LIMIT')
  expect(errors).toEqual([])
  await host.stop()
  expect(await captureWorkspaceSnapshot(workspace))
    .toEqual(await captureExpectedWorkspaceSnapshot(join(SNAPSHOT_DIR, 'workspace.expected')))
  const normalizedRaw = tokenizeCreationIdentities(normalizeWebSessionVolatiles(raw))
  const context = { sessionIds: [sessionId], cwd: workspace }
  const prompts = normalizedSystemPrompts(normalizedRaw, context).map(prompt => prompt.split(REPO_ROOT).join('{{sourceRoot}}').split(host.webUrl).join('{{webUrl}}'))
  const schemas = normalizedToolSchemas(normalizedRaw, context)
  const promptSidecar = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
  const schemaSidecar = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
  if (firstRecording) {
    await writeFile(FIXTURE, redactSessionSnapshotIds([scrubSessionSnapshot(tokenizeSessionFixtureCwd(normalizedRaw))])[0]!)
  }
  if (mode === 'refresh') await Promise.all([
    writeFile(join(SNAPSHOT_DIR, 'system-prompt.expected.md'), promptSidecar),
    writeFile(join(SNAPSHOT_DIR, 'tool-schemas.expected.json'), schemaSidecar),
  ])
  const expected = await readFile(FIXTURE, 'utf8')
  expect(normalizeSessionSnapshots([normalizedRaw], context)[0]).toBe(normalizeSessionSnapshots([expected], fixtureContext(expected))[0])
  expect(promptSidecar).toBe(await readFile(join(SNAPSHOT_DIR, 'system-prompt.expected.md'), 'utf8'))
  expect(schemaSidecar).toBe(await readFile(join(SNAPSHOT_DIR, 'tool-schemas.expected.json'), 'utf8'))
})
