/** Actual H3 failed tool results are recorded from the shipped Web CLI and replayed keylessly. */
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
  fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds,
  scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'
import h3ResponseContract from '../../../packages/host/credits-index/tests/fixtures/h3-response-contract-v2.json' with { type: 'json' }
import { fixtureUserPrompts, normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/h3-submission-outcomes', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const PROMPTS = [
  'Generate one synthetic four-second MiniMax-H3 video exactly once. Report the observed result and stop.',
  'I explicitly request another synthetic four-second MiniMax-H3 video. Generate exactly once, report the observed result, and stop.',
] as const
const KEY = 'DSH_H3_SUBMISSION_FIXTURE_KEY'
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
      DSH_PERMISSION_MODE: undefined, [KEY]: 'keyless-h3-fixture',
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

it('records two explicit H3 attempts with confirmed capacity and refunded-auth failures without automatic resubmission', async (test) => {
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This authored scenario records only its loopback fixture in refresh mode')
  const firstRecording = !existsSync(FIXTURE)
  if (firstRecording && mode !== 'refresh') throw new Error('Create this authored fixture with DSH_SNAPSHOT=refresh')
  const root = await mkdtemp(join(tmpdir(), 'dsh-h3-submission-outcomes-'))
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
  const envelopes = [h3ResponseContract.capacity, h3ResponseContract.confirmed_auth_rejection]
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
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-h3-synthetic-relay')
        response.end(JSON.stringify({ data: [{ id: 'MiniMax-H3', object: 'model', supported_endpoint_types: ['openai-video'] }] })); return
      }
      if (path === '/harness/api/pricing') { answer([{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]); return }
      if (path === '/harness/v1/video/generations') {
        expect(request.headers.authorization).toBe('Bearer sk-h3-synthetic-relay')
        const envelope = envelopes[posts.length]
        posts.push(body)
        if (envelope === undefined) throw new Error('Unexpected automatic video resubmission')
        for (const [name, value] of Object.entries('headers' in envelope ? envelope.headers : {})) if (value !== null) response.setHeader(name, value)
        response.setHeader('X-Oneapi-Request-Id', `h3-fixture-request-${posts.length}`)
        response.writeHead(envelope.http_status)
        response.end(JSON.stringify(envelope.body)); return
      }
      if (path === '/v1/messages') {
        if (!firstRecording) throw new Error('Readonly replay must not contact the external model fixture')
        expect(request.headers['x-api-key']).toBe('keyless-h3-fixture')
        modelRequests.push(body)
        const attempt = modelRequests.length
        if (attempt > 4) throw new Error('Unexpected model continuation')
        response.setHeader('content-type', 'text/event-stream')
        const events: object[] = [{ type: 'message_start', message: { id: `h3-message-${attempt}`, type: 'message', role: 'assistant',
          model: 'synthetic', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }]
        if (attempt % 2 === 1) {
          events.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `h3-call-${attempt}`,
            name: 'generate_video', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta',
            partial_json: JSON.stringify({ model: 'MiniMax-H3', prompt: 'A synthetic four-second clip', duration_seconds: 4 }) } })
        } else {
          events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Observed tool result recorded. No automatic resubmission.' } })
        }
        events.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta',
          delta: { stop_reason: attempt % 2 === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' })
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
    return await response.json() as { ok: boolean }
  }
  expect(await post('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'h3-challenge' })).toMatchObject({ ok: true })
  const signedIn = await post('/credits/api/session/verify', {
    challengeId: 'h3-synthetic-challenge', code: '123456', idempotencyKey: 'h3-login',
  })
  expect(signedIn.ok, JSON.stringify(signedIn)).toBe(true)
  const { sessionId } = await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })
  if (!firstRecording) expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
  for (const [index, prompt] of PROMPTS.entries()) {
    expect(posts).toHaveLength(index)
    await host.remote('session/prompt', { request: { requestId: `h3-explicit-intent-${index + 1}`, sessionId, mode: 'queue',
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
  await host.stop()
  const raw = await storedSession(persistence, sessionId)
  const results = toolResults(raw)
  expect(results).toMatchObject([
    { status: 'failed', submission_state: 'failed', code: 'H3_ACCOUNT_CAPACITY_EXHAUSTED', task_id: '', request_id: 'h3-fixture-request-1' },
    { status: 'failed', submission_state: 'failed', code: 'H3_UPSTREAM_AUTH_REJECTED', task_id: 'task_fixture', request_id: 'h3-fixture-request-2' },
  ])
  expect(results[0]?.message).toMatch(/未.*(?:提交|扣费)|未扣费/u)
  expect(results[1]?.message).toMatch(/退款/u)
  expect(paths.filter(path => path.startsWith('/harness/v1/video/generations/') || path.startsWith('/harness/v1/tasks/'))).toEqual([])
  expect(modelRequests).toHaveLength(firstRecording ? 4 : 0)
  if (firstRecording) {
    expect(JSON.stringify(modelRequests[1])).toContain('H3_ACCOUNT_CAPACITY_EXHAUSTED')
    expect(JSON.stringify(modelRequests[3])).toContain('H3_UPSTREAM_AUTH_REJECTED')
    expect(JSON.stringify(modelRequests[3])).toContain('task_fixture')
  }
  expect(errors).toEqual([])
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
