/** Independent human requests on one plan survive an earlier unknown submission and honor an explicit three-work request. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  captureWorkspaceSnapshot, fixtureContext, formatSystemPromptSnapshot,
  formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds,
  scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { expect, it } from 'vitest'
import { fixtureUserPrompts, normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'
import { startProfileWeb } from './profile-process.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/independent-generation-requests', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const PROMPTS = ['用H3生成一个10秒视频。', '再生成一条10秒视频。', '再生成3个10秒视频，768P、9:16。'] as const
const runtimeRoot = process.env.DSH_VIDEO_TEST_RUNTIME_ROOT
const runtimeAvailable = runtimeRoot !== undefined && ['ffmpeg', 'ffprobe'].every(tool =>
  existsSync(join(runtimeRoot, 'bin', process.platform === 'win32' ? `${tool}.exe` : tool)))
const KEY = 'DSH_CREATION_ENTRY_FIXTURE_KEY'


type JsonRow = Record<string, unknown>

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




/** Only typed creation identities declared by actual tool results are volatile. */
function tokenizeCreationIdentities(raw: string): string {
  const identities = new Map<string, string>()
  for (const result of toolResults(raw)) {
    for (const key of ['plan_id', 'operation_id', 'project_id'] as const) {
      const value = result[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || !/^(?:cp|op|vp)_[a-f0-9-]{36}$/u.test(value)) throw new Error(`Missing typed ${key}`)
      if (!identities.has(value)) identities.set(value, `{{id:${1001 + identities.size}}}`)
    }
  }
  for (const [value, token] of identities) raw = raw.split(value).join(token)
  return raw
}

function toolResults(raw: string): JsonRow[] {
  const events = rows(raw)
  const reads = new Set(events.filter(row => row.type === 'tool/call' && (row.data as JsonRow).name === 'job_output')
    .map(row => (row.data as JsonRow).callId))
  return events.filter(row => row.type === 'tool/result').flatMap((row) => {
    const data = row.data as { message: { toolCallId: string; content: { type: string; text?: string }[] } }
    if (reads.has(data.message.toolCallId)) return []
    const text = data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    return [JSON.parse(text) as JsonRow]
  })
}

it.skipIf(!runtimeAvailable)('records independent same-plan requests and three native works across separate model steps (requires prepared DSH_VIDEO_TEST_RUNTIME_ROOT)', async (test) => {
  if (runtimeRoot === undefined) throw new Error('Provide the existing prepared native video runtime')
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This authored scenario records only its loopback fixture in refresh mode')
  const firstRecording = !existsSync(FIXTURE)
  if (firstRecording && mode !== 'refresh') throw new Error('Create this authored fixture with DSH_SNAPSHOT=refresh')
  const script = firstRecording ? undefined : deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
  const root = await mkdtemp(join(tmpdir(), 'dsh-independent-generation-requests-'))
  const cleanup: { host?: () => Promise<void>; fixture?: () => Promise<void>; release?: () => void } = {}
  test.onTestFinished(async () => {
    cleanup.release?.()
    try { await cleanup.host?.() }
    finally {
      try { await cleanup.fixture?.() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const workspace = join(root, 'workspace')
  const persistence = join(root, 'sessions')
  await Promise.all([mkdir(workspace), mkdir(persistence)])
  const posts: JsonRow[] = []
  const modelRequests: unknown[] = []
  const errors: string[] = []
  const paths: string[] = []
  const credits = join(root, 'credits')
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
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected video fields')
        const value = body as JsonRow
        expect(value).toMatchObject({ duration: 10, seconds: 10 })
        expect(posts.some(post => post.prompt === value.prompt)).toBe(false)
        posts.push(value)
        if (posts.length > 5) throw new Error('Independent human requests authorize exactly five works')
        response.end(posts.length === 1 ? '{}' : JSON.stringify({ code: 'success', data: { task_id: `independent-task-${String(posts.length)}` } })); return
      }
      if (/^\/harness\/v1\/tasks\/independent-task-[2-5]$/u.test(path)) {
        if (path.endsWith('-3')) {
          await new Promise<void>((resolve) => { cleanup.release = resolve })
          delete cleanup.release
        }
        response.end(JSON.stringify({ code: 'success', data: { status: 'IN_PROGRESS' } })); return
      }
      if (path === '/v1/messages') {
        expect(request.headers['x-api-key']).toBe('keyless-creation-entry-fixture')
        modelRequests.push(body)
        const attempt = modelRequests.length
        if (attempt > 8) throw new Error('Unexpected model continuation')
        const resultTextOf = (callId: string): string => {
          type ModelMessage = { content: { type: string; tool_use_id?: string; content?: string | { text?: string }[] }[] }
          const messages = (body as { messages: ModelMessage[] }).messages
          const found = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
            .findLast(block => block.type === 'tool_result' && block.tool_use_id === callId)
          if (found === undefined) throw new Error(`Expected original ${callId} result`)
          const text = typeof found.content === 'string' ? found.content : found.content?.map(block => block.text ?? '').join('')
          if (text === undefined) throw new Error('Expected tool result text')
          return text
        }
        const resultOf = (callId: string): JsonRow => JSON.parse(resultTextOf(callId)) as JsonRow
        if (attempt === 6) await expect.poll(() => cleanup.release !== undefined, { timeout: 10_000 }).toBe(true)
        if (attempt === 7) {
          expect(resultTextOf('read-middle')).toContain('[status: running')
          expect(resultTextOf('read-middle')).toContain('independent-task-3')
          expect(cleanup.release).toBeDefined()
          cleanup.release?.()
        }
        let tool: { id: string; name: string; args: JsonRow } | undefined
        if (attempt === 3) {
          expect(resultOf('call-0')).toMatchObject({ remaining_works: 0 })
        } else if (script === undefined) {
          tool = attempt === 1 ? { id: 'independent-plan', name: 'update_creation_plan', args: {
            kind: 'video', title: 'Shared video content', brief: 'One ten-second synthetic shot', characters: [], assets: [],
            shots: [{ id: 'same-shot', order: 1, title: 'Independent work', duration_seconds: 10, prompt: 'Synthetic landscape' }],
          } } : attempt === 6 ? { id: 'read-middle', name: 'job_output', args: {
            job_id: resultOf('call-0').job_id, wait: true, timeout_ms: 600000,
          } } : { id: 'call-0', name: 'generate_video_project', args: {
            plan_id: resultOf('independent-plan').plan_id, shot_ids: ['same-shot'], total_duration_seconds: 10,
            model: 'MiniMax-H3', prompt: `Independent human-requested work ${String(attempt - 1)}`,
            ...attempt < 5 ? {} : { resolution: '768P', ratio: '9:16' },
          } }
        } else {
          const step = script[attempt - 1]
          if (step?.kind !== 'chunks') throw new Error('Expected one recorded model tool step')
          const calls = step.chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [])
          if (calls.length !== 1) throw new Error('Each model step must arrange exactly one work')
          const call = calls[0]!
          const args = JSON.parse(call.arguments) as JsonRow
          if (typeof args.plan_id === 'string') args.plan_id = resultOf('independent-plan').plan_id
          if (call.name === 'job_output') args.job_id = resultOf('call-0').job_id
          tool = { id: call.id, name: call.name, args }
        }
        if (attempt === 7 || attempt === 8) expect(resultOf('call-0'))
          .toMatchObject({ status: 'background', remaining_works: 9 - attempt })
        response.setHeader('content-type', 'text/event-stream')
        const events: object[] = [{ type: 'message_start', message: { id: `independent-message-${String(attempt)}`, type: 'message', role: 'assistant',
          model: 'synthetic', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
        ...tool === undefined ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '原提交结果未知，保留原项目，不重新提交。新的独立生成要求可以另行安排。' } },
        ] : [
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } },
        ],
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta',
          delta: { stop_reason: tool === undefined ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]
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
      creditsPerYuan: 1000, stateDir: credits, videoRuntimeRoot: runtimeRoot,
      videoProjectPollIntervalMs: 60000, videoProjectTaskTimeoutMs: 3600000 } },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'llm-deepseek', disabled: false, config: { apiKeyEnv: KEY, baseURL: origin,
      reasoningEffort: 'off', thinking: 'disabled', models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000, inputModalities: ['text'] }] } },

  ]))
  const host = await startProfileWeb(root, workspace, overlay, { [KEY]: 'keyless-creation-entry-fixture' })
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
  let raw = ''
  const turns = async () => {
    try { raw = await storedSession(persistence, sessionId); return rows(raw).filter(row => row.type === 'turn/end').length }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT'
        || error instanceof Error && error.message.startsWith('No persisted Session')) return 0
      throw error
    }
  }
  test.onTestFailed(() => { console.error(JSON.stringify({ errors, posts, modelRequests: modelRequests.length, events: raw === '' ? [] : rows(raw).filter(row => ['tool/result', 'turn/end'].includes(String(row.type))) }, null, 2)) })
  let firstManifest: string | undefined
  let originalAttemptId: unknown
  for (const [index, prompt] of PROMPTS.entries()) {
    await host.remote('session/prompt', { request: { requestId: `independent-human-${String(index + 1)}`, sessionId, mode: 'queue',
      clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: prompt }] } })
    await expect.poll(turns, { timeout: 30_000 }).toBe(index + 2)
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(index === 2 ? 5 : index + 1)
    const values = toolResults(raw)
    if (index === 0) {
      const project = values[1]?.project_id
      if (typeof project !== 'string') throw new Error('Expected retained first project id')
      firstManifest = join(credits, 'video-projects', project, 'manifest.json')
      await expect.poll(async () => JSON.parse(await readFile(firstManifest!, 'utf8')) as JsonRow, { timeout: 10_000 })
        .toMatchObject({ status: 'failed', failureCode: 'SUBMISSION_UNKNOWN' })
      const saved = JSON.parse(await readFile(firstManifest, 'utf8')) as { segments: JsonRow[] }
      originalAttemptId = saved.segments[0]?.attemptId
    }
  }
  const results = toolResults(raw)
  expect(results).toMatchObject([{ status: 'saved' },
    { status: 'background', remaining_works: 0 }, { status: 'background', remaining_works: 0 },
    { status: 'background', remaining_works: 2 }, { status: 'background', remaining_works: 1 }, { status: 'background', remaining_works: 0 }])
  expect(new Set(results.slice(1).map(value => value.project_id)).size).toBe(5)
  expect(new Set(results.map(value => value.plan_id)).size).toBe(1)
  expect(rows(raw).filter(row => row.type === 'step/start')).toHaveLength(8)
  const generations = rows(raw).filter(row => row.type === 'tool/call'
    && (row.data as JsonRow).name === 'generate_video_project')
  expect(generations.map(row => (row.data as JsonRow).callId)).toEqual(Array.from({ length: 5 }, () => 'call-0'))
  expect(new Set(generations.map(row => row.seq)).size).toBe(5)
  expect(rows(raw).filter(row => row.type === 'tool/call' && (row.data as JsonRow).name === 'job_output'))
    .toMatchObject([{ data: { turn: 4, step: 2 } }])
  expect(rows(raw).filter(row => row.type === 'tool/call').map((row) => {
    const data = row.data as JsonRow
    return [data.turn, data.step]
  })).toEqual([[1, 1], [1, 2], [3, 1], [4, 1], [4, 2], [4, 3], [4, 4]])
  expect(posts.slice(2)).toMatchObject(Array.from({ length: 3 }, () => ({ resolution: '768P', aspect_ratio: '9:16' })))
  if (firstManifest === undefined) throw new Error('Expected original unknown manifest')
  const original = JSON.parse(await readFile(firstManifest, 'utf8')) as { segments: JsonRow[] }
  expect(original.segments).toMatchObject([{ status: 'unknown' }])
  expect(original.segments[0]?.attemptId).toMatch(/^[a-f0-9-]{36}$/u)
  expect(original.segments[0]?.attemptId).toBe(originalAttemptId)
  expect(original.segments[0]?.taskId).toBeUndefined()
  expect(posts).toHaveLength(5)
  expect(modelRequests).toHaveLength(8)
  expect(paths.filter(path => path.startsWith('/harness/v1/tasks/independent-task-1'))).toEqual([])
  expect(errors).toEqual([])
  for (const [index, result] of results.slice(2).entries()) {
    if (typeof result.project_id !== 'string') throw new Error('Expected a known independent project')
    const manifest = join(credits, 'video-projects', result.project_id, 'manifest.json')
    await expect.poll(async () => JSON.parse(await readFile(manifest, 'utf8')) as JsonRow, { timeout: 10_000 })
      .toMatchObject({ segments: [{ taskId: `independent-task-${String(index + 2)}`, status: 'running' }] })
  }
  await host.stop()
  const projectOrder = new Map(results.slice(1).map((result, index) =>
    [`artifacts/videos/${String(result.project_id)}`, `artifacts/videos/project-${String(index + 1)}`]))
  const actualWorkspace = (await captureWorkspaceSnapshot(workspace))
    .map(entry => ({ ...entry, path: projectOrder.get(entry.path) ?? entry.path }))
    .toSorted((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  const expectedWorkspace = (await captureWorkspaceSnapshot(join(SNAPSHOT_DIR, 'workspace.expected'))).map((entry) => {
    expect(entry).toMatchObject({ kind: 'text', content: '' })
    expect(entry.path).toMatch(/^artifacts\/videos\/project-[1-5]\/\.empty$/u)
    return { path: entry.path.slice(0, -'/.empty'.length), kind: 'empty-directory' as const }
  })
  expect(actualWorkspace).toEqual(expectedWorkspace)
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
