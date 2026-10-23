/** Actual creation diagnostics and H3 ledger receipts pass through the shipped Web CLI Session. */
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
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds,
  scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'
import h3ApiContract from '../../../packages/host/credits-index/tests/fixtures/h3-unsent-api-contract.json' with { type: 'json' }
import { assertFinalWorkspaceSnapshot, fixtureUserPrompts, normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/creation-plan-h3-receipts', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const HEADER_DIR = fileURLToPath(new URL('../../../snapshots/web/h3-submission-outcomes', import.meta.url))
const PROMPTS = [
  'Create a complete one-shot video plan, correct any specific planning argument diagnosis, then make exactly one explicit synthetic four-second MiniMax-H3 attempt. Report its result and stop.',
  'I explicitly request a second synthetic four-second MiniMax-H3 attempt for that saved shot. Generate exactly once, report the result, and stop.',
  'I explicitly request a third synthetic four-second MiniMax-H3 attempt for that saved shot. Generate exactly once, retain its original operation receipt, and stop.',
  'Only query the third attempt using its retained plan and operation IDs. Report the original receipt result. Do not generate another task.',
] as const
const KEY = 'DSH_CREATION_RECEIPT_FIXTURE_KEY'
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
      DSH_PERMISSION_MODE: undefined, [KEY]: 'keyless-creation-receipt-fixture',
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

function envelope(name: string) {
  const result = h3ApiContract.fixtures.find(item => item.name === name)
  if (result === undefined) throw new Error(`Missing actual API fixture ${name}`)
  return { ...result, body: record(result.body) }
}

const notCharged = envelope('post_wallet_insufficient_not_charged')
const refunded = envelope('post_build_failure_refunded')
const unknown = envelope('post_unavailable_durable_proof_unknown')
const canonical = envelope('canonical_get_not_charged')
const originalTaskId = unknown.body.task_id
if (typeof originalTaskId !== 'string') throw new Error('Expected the actual unknown platform task ID')
const proof = record(canonical.body.submission_receipt)
// A query scenario must retain one task identity. All other actual API response fields remain exact.
const reconciledBody = { ...canonical.body, task_id: originalTaskId, submission_receipt: {
  ...proof, id: originalTaskId, task_id: originalTaskId,
  recovery: { ...record(proof.recovery), path: `/v1/tasks/${originalTaskId}` },
} }
const plan = { kind: 'video', title: 'Receipt verification plan', brief: 'One synthetic shot', characters: [], assets: [],
  shots: [{ id: 'receipt-shot', order: 1, title: 'Retained shot', duration_seconds: 4, prompt: 'A synthetic four-second clip' }] }

it('records a corrected creation plan and H3 unsent POST receipts followed by original-task GET proof', async (test) => {
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This authored scenario captures only its loopback fixture in refresh mode')
  const firstRecording = !existsSync(FIXTURE)
  if (firstRecording && mode !== 'refresh') throw new Error('Create this authored fixture with DSH_SNAPSHOT=refresh')
  const root = await mkdtemp(join(tmpdir(), 'dsh-creation-h3-receipts-'))
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
  const posts: unknown[] = [], queries: string[] = [], modelRequests: unknown[] = [], errors: string[] = []
  const postEnvelopes = [notCharged, refunded, unknown]
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
        answer({ challenge_id: 'receipt-challenge', delivery_status: 'accepted',
          expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=receipt-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'receipt-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-receipt-relay', relay_key_id: 9, session: { sid: 'receipt-login', current: true },
          user: { id: 7, username: 'receipt-user', quota: 500_000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'receipt-user', group: 'product', quota: 500_000 }); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-receipt-relay')
        response.end(JSON.stringify({ data: [{ id: 'MiniMax-H3', object: 'model', supported_endpoint_types: ['openai-video'] }] })); return
      }
      if (path === '/harness/api/pricing') { answer([{ model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] }]); return }
      if (path === '/harness/v1/video/generations' && request.method === 'POST') {
        expect(request.headers.authorization).toBe('Bearer sk-receipt-relay')
        const reply = postEnvelopes[posts.length]
        posts.push(body)
        if (reply === undefined) throw new Error('Unexpected automatic generation')
        for (const [key, value] of Object.entries(reply.headers)) response.setHeader(key, value)
        response.setHeader('X-Oneapi-Request-Id', `receipt-request-${String(posts.length)}`)
        response.writeHead(reply.http_status); response.end(JSON.stringify(reply.body)); return
      }
      if (path === `/harness/v1/tasks/${originalTaskId}` && request.method === 'GET') {
        expect(request.headers.authorization).toBe('Bearer sk-receipt-relay')
        queries.push(path)
        if (queries.length > 2) throw new Error('Unexpected original-task query')
        // First observation is synthetic HTTP200 UNKNOWN, using the actual unknown body's exact identity.
        // The explicit follow-up consumes the complete actual canonical proof, with only typed ID relationship mapping.
        response.writeHead(200); response.end(JSON.stringify(queries.length === 1 ? unknown.body : reconciledBody)); return
      }
      if (path === '/v1/messages') {
        if (!firstRecording) throw new Error('Readonly replay must not contact the external model fixture')
        expect(request.headers['x-api-key']).toBe('keyless-creation-receipt-fixture')
        modelRequests.push(body)
        const attempt = modelRequests.length
        let tool: { id: string; name: string; args: object } | undefined
        if (attempt === 1) tool = { id: 'plan-missing-title', name: 'update_creation_plan', args: {
          ...plan, shots: [{ id: 'receipt-shot', order: 1, duration_seconds: 4, prompt: 'A synthetic four-second clip' }],
        } }
        if (attempt === 2) {
          expect(modelToolResult(body, 'plan-missing-title')).toContain('shots[0].title')
          tool = { id: 'plan-corrected', name: 'update_creation_plan', args: plan }
        }
        if ([3, 5, 7].includes(attempt)) {
          const saved = record(JSON.parse(modelToolResult(body, 'plan-corrected')))
          if (typeof saved.plan_id !== 'string') throw new Error('Expected the actual saved plan ID')
          tool = { id: `receipt-generate-${String(attempt)}`, name: 'generate_video', args: {
            model: 'MiniMax-H3', plan_id: saved.plan_id, shot_id: 'receipt-shot', prompt: 'A synthetic four-second clip', duration_seconds: 4,
          } }
        }
        if (attempt === 9) {
          const retained = record(JSON.parse(modelToolResult(body, 'receipt-generate-7')))
          if (typeof retained.plan_id !== 'string' || typeof retained.operation_id !== 'string') throw new Error('Expected the actual retained receipt')
          tool = { id: 'receipt-original-query', name: 'query_video_task', args: { plan_id: retained.plan_id, operation_id: retained.operation_id } }
        }
        if (attempt < 1 || attempt > 10) throw new Error('Unexpected model continuation')
        response.setHeader('content-type', 'text/event-stream')
        const events: object[] = [{ type: 'message_start', message: { id: `receipt-message-${String(attempt)}`, type: 'message',
          role: 'assistant', model: 'synthetic', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }]
        if (tool !== undefined) events.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } },
        )
        else events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Observed result retained. No automatic generation.' } })
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
    const values = toolResults(recorded).slice(1).map(result => record(JSON.parse(result.text)))
    let script = JSON.stringify(deriveReplayScript(parseSessionLog(recorded)))
    for (const [token, binding] of [
      [values[0]?.plan_id, '{{fromRequest:"plan_id":"(cp_[a-f0-9-]{36})"}}'],
      [values[3]?.operation_id, '{{fromRequest:"operation_id":"(op_[a-f0-9-]{36})"}}'],
    ]) {
      if (typeof token !== 'string' || !/^\{\{id:[1-9]\d*\}\}$/u.test(token)) throw new Error('Expected a recorded typed creation ID')
      // Existing replay bindings echo actual prior tool results; no model output or tool result is synthesized here.
      script = script.replaceAll(token, JSON.stringify(binding).slice(1, -1))
    }
    replayOverride = join(root, 'creation-receipts-replay.json')
    await writeFile(replayOverride, script)
  }
  const overlay = join(root, 'creation-receipts.patch.json')
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
  expect(await post('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'receipt-challenge' })).toMatchObject({ ok: true })
  expect(await post('/credits/api/session/verify', { challengeId: 'receipt-challenge', code: '123456', idempotencyKey: 'receipt-login' }))
    .toMatchObject({ ok: true })
  const { sessionId } = await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })
  if (!firstRecording) expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
  for (const [index, prompt] of PROMPTS.entries()) {
    expect(posts).toHaveLength(Math.min(index, 3))
    await host.remote('session/prompt', { request: { requestId: `creation-receipt-intent-${String(index + 1)}`, sessionId, mode: 'queue',
      clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: prompt }] } })
    await expect.poll(async () => {
      try { return rows(await storedSession(persistence, sessionId)).filter(row => row.type === 'turn/end').length }
      catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT'
          || error instanceof Error && error.message.startsWith('No persisted Session')) return 0
        throw error
      }
    }, { timeout: 30_000 }).toBe(index + 1)
    expect(posts).toHaveLength(Math.min(index + 1, 3))
  }
  const raw = await storedSession(persistence, sessionId)
  const results = toolResults(raw)
  expect(results.map(result => result.name)).toEqual([
    'update_creation_plan', 'update_creation_plan', 'generate_video', 'generate_video', 'generate_video', 'query_video_task',
  ])
  expect(results[0]?.message.isError).toBe(true)
  expect(results[0]?.error).toMatchObject({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
  expect(results[0]?.text).toContain('shots[0].title')
  const values = results.slice(1).map(result => record(JSON.parse(result.text)))
  expect(values).toMatchObject([
    { status: 'saved' },
    { status: 'failed', submission_state: 'failed', code: notCharged.body.code, task_id: notCharged.body.task_id },
    { status: 'failed', submission_state: 'failed', code: refunded.body.code, task_id: refunded.body.task_id },
    { status: 'pending', task_id: originalTaskId },
    { status: 'failed', code: 'H3_SUBMISSION_NOT_SENT', task_id: originalTaskId },
  ])
  expect(values[1]?.message).toMatch(/未.*(?:发送|扣费)|未扣费/u)
  expect(values[2]?.message).toContain('退款已确认')
  expect(values[4]?.operation_id).toBe(values[3]?.operation_id)
  expect(queries).toEqual(Array.from({ length: 2 }, () => `/harness/v1/tasks/${originalTaskId}`))
  expect(posts).toHaveLength(3)
  expect(modelRequests).toHaveLength(firstRecording ? 10 : 0)
  if (firstRecording) {
    expect(modelToolResult(modelRequests[3], 'receipt-generate-3')).toContain(String(notCharged.body.code))
    expect(modelToolResult(modelRequests[3], 'receipt-generate-3')).toContain(String(notCharged.body.task_id))
    expect(modelToolResult(modelRequests[5], 'receipt-generate-5')).toContain(String(refunded.body.code))
    expect(modelToolResult(modelRequests[5], 'receipt-generate-5')).toContain(String(refunded.body.task_id))
    expect(modelToolResult(modelRequests[9], 'receipt-original-query')).toContain('H3_SUBMISSION_NOT_SENT')
  }
  const response = await fetch(new URL(`/credits/api/creative/projects?session_id=${sessionId}`, host.webUrl), {
    headers: { cookie: host.cookie }, signal: AbortSignal.timeout(10_000),
  })
  expect(response.status).toBe(200)
  const projects = record(record(await response.json()).payload).projects
  expect(projects).toMatchObject([{ id: values[0]?.plan_id, status: 'failed', title: plan.title,
    shots: [{ id: 'receipt-shot', title: 'Retained shot' }], tasks: [
      { status: 'failed', errorCode: notCharged.body.code, canQuery: false, videoReceipt: { taskId: notCharged.body.task_id } },
      { status: 'failed', errorCode: refunded.body.code, canQuery: false, videoReceipt: { taskId: refunded.body.task_id } },
      { status: 'failed', errorCode: 'H3_SUBMISSION_NOT_SENT', canQuery: false, videoReceipt: { taskId: originalTaskId } },
    ] }])
  expect(errors).toEqual([])
  await host.stop()
  await assertFinalWorkspaceSnapshot(SNAPSHOT_DIR, workspace)
  const normalizedRaw = tokenizeCreationIdentities(normalizeWebSessionVolatiles(raw))
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
