/** A real model-price card gates chat video generation through the shipped Web CLI Session. */
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
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import h3Quote from './fixtures/video-model-choice/websession-baseline-h3.json' with { type: 'json' }
import targetQuote from './fixtures/video-model-choice/websession-target-sd25.json' with { type: 'json' }
import h3Contract from '../../../packages/host/credits-index/tests/fixtures/h3-response-contract-v2.json' with { type: 'json' }
import {
  assertFinalWorkspaceSnapshot, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  normalizeWebSessionVolatiles, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/video-model-choice', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const HEADER_DIR = fileURLToPath(new URL('../../../snapshots/web/h3-submission-outcomes', import.meta.url))
const PROMPTS = [
  'Generate one 15-second video',
  'Generate one 15-second video using video-sd25-480p',
  'Generate one more 15-second video using video-sd25-480p',
] as const
const KEY = 'DSH_VIDEO_MODEL_CHOICE_FIXTURE_KEY'
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
      DSH_PERMISSION_MODE: undefined, [KEY]: 'keyless-video-model-choice-fixture',
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

const TARGET = 'video-sd25-480p'
const UI_EXPECTED = fileURLToPath(new URL('./expected/video-model-choice/card.expected.md', import.meta.url))
const CURRENT_HEADER_CAPTURE = join(REPO_ROOT, '.artifacts', 'video-model-choice-current-header')

// Approved true Session script: seven actual model continuations across three human turns.
const TOOLS = new Map<number, { id: string; name: string; args: object }>([
  [1, { id: 'choice-default', name: 'generate_video', args: {
    duration_seconds: 15, resolution: '2K', prompt: 'A synthetic red circle remains still',
  } }],
  [3, { id: 'choice-cancel', name: 'generate_video', args: {
    model: TARGET, duration_seconds: 15, resolution: '1280x720', prompt: 'A synthetic blue circle remains still',
  } }],
  [4, { id: 'choice-cancelled-fallback', name: 'generate_video', args: {
    model: 'MiniMax-H3', duration_seconds: 15, prompt: 'A model-invented fallback after cancellation',
  } }],
  [6, { id: 'choice-target', name: 'generate_video', args: {
    model: TARGET, duration_seconds: 15, resolution: '1280x720', prompt: 'A synthetic blue circle remains still',
  } }],
])

it('records default H3 768P and a real price-informed model choice, cancellation and explicit new request', async (test) => {
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This authored scenario captures only its loopback fixture in refresh mode')
  const firstRecording = !existsSync(FIXTURE)
  if (firstRecording && mode !== 'refresh') throw new Error('Create this authored fixture with DSH_SNAPSHOT=refresh')
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-model-choice-'))
  const cleanup: {
    inspect?: () => Promise<void>
    browser?: () => Promise<void>
    host?: () => Promise<void>
    fixture?: () => Promise<void>
  } = {}
  test.onTestFinished(async () => {
    try { await cleanup.inspect?.() }
    finally {
      try { await cleanup.browser?.() }
      finally {
        try { await cleanup.host?.() }
        finally {
          try { await cleanup.fixture?.() }
          finally { await rm(root, { recursive: true, force: true }) }
        }
      }
    }
  })
  const workspace = join(root, 'workspace'), persistence = join(root, 'sessions')
  await Promise.all([mkdir(workspace), mkdir(persistence)])
  const posts: { path: string; body: JsonRow }[] = [], queries: string[] = [], quotes: unknown[] = []
  const clientReports: unknown[] = []
  const modelRequests: unknown[] = [], errors: string[] = []
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
        answer({ challenge_id: 'model-choice-challenge', delivery_status: 'accepted',
          expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=model-choice-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'model-choice-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-model-choice-relay', relay_key_id: 9, session: { sid: 'model-choice-login', current: true },
          user: { id: 7, username: 'model-choice-user', quota: 5_000_000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'model-choice-user', group: 'product', quota: 5_000_000 }); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-model-choice-relay')
        response.end(JSON.stringify({ data: [
          { id: 'deepseek-v4-flash', object: 'model', supported_endpoint_types: ['openai'] },
          { id: TARGET, object: 'model', supported_endpoint_types: ['openai-video'] },
          { id: 'MiniMax-H3', object: 'model', supported_endpoint_types: ['openai-video'] },
        ] })); return
      }
      if (path === '/harness/api/pricing') {
        // Catalog order deliberately places the quoted alternative before the H3 chat default.
        answer([
          { model_name: TARGET, supported_endpoint_types: ['openai-video'], parameters: { type: 'object', properties: {
            resolution: { type: 'string', default: '1280x720', enum: ['1280x720', '720x1280', '1792x1024', '1024x1792'] },
            seconds: { type: 'integer', default: 30, minimum: 15, maximum: 30, enum: Array.from({ length: 16 }, (_, index) => index + 15) },
          } } },
          { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] },
        ]); return
      }
      if (path === '/harness/api/log/self') { answer({ page: 1, page_size: 100, total: 0, items: [] }); return }
      if (path === '/harness/api/client-errors' && request.method === 'POST') {
        expect(request.headers.authorization).toBe('Bearer model-choice-access')
        expect(body).toEqual({ tool: 'generate_video', code: 'TASK_FAILED', stage: 'query', model: TARGET })
        clientReports.push(body)
        answer({ received_at: Math.floor(Date.now() / 1000), source: 'client' }); return
      }
      if (path === '/harness/api/creation/content') {
        answer({ schemaVersion: 1, revision: 'model-choice-fixture', image: { templates: [] }, video: { templates: [] },
          guide: { title: '', body: '' } }); return
      }
      if (path === '/harness/api/user/auth/logout') { answer(null); return }
      if (path === '/harness/v1/video/quote' && request.method === 'POST') {
        expect(request.headers.authorization).toBe('Bearer sk-model-choice-relay')
        quotes.push(body)
        const sample = record(body).model === 'MiniMax-H3' ? h3Quote : targetQuote
        expect(body).toEqual(sample.request)
        const ttl = sample.response.expires_at - sample.response.created_at
        expect(ttl).toBe(60)
        // The owned actual API sample is short-lived. Translate only its server clock fields.
        const createdAt = Math.floor(Date.now() / 1000)
        response.writeHead(sample.http_status)
        response.end(JSON.stringify({ ...sample.response, created_at: createdAt, expires_at: createdAt + ttl })); return
      }
      if (path === '/harness/v1/video/generations' && request.method === 'POST') {
        expect(request.headers.authorization).toBe('Bearer sk-model-choice-relay')
        const value = record(body)
        posts.push({ path, body: value })
        expect(posts).toHaveLength(1)
        expect(value).toMatchObject({ model: 'MiniMax-H3', seconds: 15, duration: 15,
          resolution: '768P', size: '768P', metadata: { resolution: '768P' } })
        expect(JSON.stringify(value)).not.toContain('2K')
        response.writeHead(h3Contract.capacity.http_status); response.end(JSON.stringify(h3Contract.capacity.body)); return
      }
      if (path === '/harness/v1/videos' && request.method === 'POST') {
        expect(request.headers.authorization).toBe('Bearer sk-model-choice-relay')
        const value = record(body)
        posts.push({ path, body: value })
        expect(posts).toHaveLength(2)
        expect(value).toEqual({ model: TARGET, prompt: 'A synthetic blue circle remains still', seconds: 15,
          size: '1280x720', gen_type: 'text_to_video', n: 1 })
        response.end(JSON.stringify({ id: 'model-choice-original-target', status: 'queued' })); return
      }
      if (path === '/harness/v1/videos/model-choice-original-target' && request.method === 'GET') {
        expect(request.headers.authorization).toBe('Bearer sk-model-choice-relay')
        queries.push(path)
        response.end(JSON.stringify({ id: 'model-choice-original-target', status: 'failed',
          error: { message: 'Synthetic non-H3 provider terminal failure' } })); return
      }
      if (path === '/v1/messages') {
        if (!firstRecording) throw new Error('Readonly replay must not contact the external model fixture')
        expect(request.headers['x-api-key']).toBe('keyless-video-model-choice-fixture')
        modelRequests.push(body)
        const attempt = modelRequests.length, tool = TOOLS.get(attempt)
        if (attempt < 1 || attempt > 7) throw new Error('Unexpected model continuation')
        response.setHeader('content-type', 'text/event-stream')
        const events: object[] = [{ type: 'message_start', message: { id: `choice-message-${String(attempt)}`, type: 'message',
          role: 'assistant', model: 'synthetic', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }]
        if (tool !== undefined) events.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } },
        )
        else events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Observed result retained. No additional generation is authorized.' } })
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
  const overlay = join(root, 'video-model-choice.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' } },
    { id: 'session-persistence-jsonl', config: { root: persistence, compression: 'none' } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'product-extensions', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'computer-use', disabled: true }, { id: 'computer-use-cua-driver-native', disabled: true },
    { id: 'ui-creative', disabled: true }, { id: 'dsh-market', disabled: true }, { id: 'dsh-skin-market', disabled: true },
    { id: 'workspace-controller', config: { documentsDirectory: join(root, 'documents') } },
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
  await host.remote('workspace/create', { request: { path: workspace } })
  const post = async (path: string, args: object) => {
    const response = await fetch(new URL(path, host.webUrl), { method: 'POST', headers: { 'content-type': 'application/json', cookie: host.cookie },
      body: JSON.stringify(args), signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`)
    return record(await response.json())
  }
  expect(await post('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'model-choice-challenge' })).toMatchObject({ ok: true })
  expect(await post('/credits/api/session/verify', { challengeId: 'model-choice-challenge', code: '123456', idempotencyKey: 'model-choice-login' }))
    .toMatchObject({ ok: true })
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await newEnglishPage(browser)
  const [cookieName, ...cookieValue] = host.cookie.split('=')
  if (cookieName === undefined) throw new Error('Expected the real Host authentication cookie')
  await page.context().addCookies([{ name: cookieName, value: cookieValue.join('='), url: host.webUrl, httpOnly: true, sameSite: 'Lax' }])
  const tripwire = watchConsole(page)
  const browserPrompts: unknown[] = []
  const promptReplies: unknown[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/session/prompt') browserPrompts.push(request.postDataJSON())
  })
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/session/prompt') {
      void response.json().then((value) => { promptReplies.push(value) }).catch((error: unknown) => { promptReplies.push(String(error)) })
    }
  })
  cleanup.inspect = async () => {
    if (page.isClosed()) return
    await mkdir(CURRENT_HEADER_CAPTURE, { recursive: true })
    await page.screenshot({ path: join(CURRENT_HEADER_CAPTURE, 'failure.png'), animations: 'disabled' })
    const summaries = []
    const paths = (await readdir(persistence, { recursive: true })).map(path => join(persistence, path))
    for (const path of latestPersistedSessionPaths(paths)) {
      const events = rows(await readFile(path, 'utf8'))
      summaries.push({ header: events[0], types: events.map(row => row.type),
        errors: events.filter(row => /error|fail/u.test(String(row.type))),
        headers: events.filter(row => row.type === 'request/update').map(row => record(row.data).config) })
    }
    await writeFile(join(CURRENT_HEADER_CAPTURE, 'failure.json'), JSON.stringify({
      errors, posts, queries, quotes, browserPrompts, promptReplies, summaries,
      modelCalls: modelRequests.length, pageErrors: tripwire.pageErrors,
      visible: await page.locator('body').innerText(),
    }, null, 2) + '\n')
  }
  const blockedBrowserRequests: string[] = []
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === host.webUrl || url.protocol === 'data:' || url.protocol === 'blob:') { await route.continue(); return }
    blockedBrowserRequests.push(url.href)
    await route.abort('blockedbyclient')
  })
  await page.goto(host.webUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.locator('[data-composer-input][contenteditable="true"]').last().waitFor({ timeout: 15_000 })
  if (!firstRecording) expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
  let sessionId: string | undefined, firstCard: string | undefined
  const expectedPosts = [1, 1, 2]
  for (const [index, prompt] of PROMPTS.entries()) {
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.click()
    await expect.poll(() => composer.evaluate(element => element === document.activeElement)).toBe(true)
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }))
    await writeComposerDraft(page, composer, prompt)
    await expect.poll(() => composer.innerText(), { timeout: 10_000 }).toBe(prompt)
    await composer.press('Enter')
    await expect.poll(() => browserPrompts.length, { timeout: 10_000 }).toBe(index + 1)
    const sent = record(record(record(record(browserPrompts[index]).payload).args).request)
    expect(sent.content).toEqual([{ type: 'text', text: prompt }])
    await expect.poll(() => page.locator('[data-conversation-session]').getAttribute('data-conversation-session'), { timeout: 10_000 }).not.toBeNull()
    sessionId = await page.locator('[data-conversation-session]').getAttribute('data-conversation-session') ?? undefined
    if (sessionId === undefined) throw new Error('Expected the actual composer-created Session ID')
    if (index > 0) {
      const card = page.locator('[data-question-key]')
      await card.waitFor({ state: 'visible', timeout: 30_000 })
      expect(posts).toHaveLength(1)
      await card.getByText('视频型号与价格', { exact: true }).waitFor()
      expect(await card.getByRole('radio').count()).toBe(3)
      await card.getByRole('radio', { name: '保留 H3 768P（约 ¥4.20）', exact: true }).waitFor()
      await card.getByRole('radio', { name: '使用 video-sd25-480p（约 ¥10.50）', exact: true }).waitFor()
      await card.getByRole('radio', { name: '取消本次生成', exact: true }).waitFor()
      const actualCard = await captureStableAria(page, '[data-question-key]', workspace)
      if (firstCard === undefined) {
        firstCard = actualCard
        await mkdir(join(UI_EXPECTED, '..'), { recursive: true })
        await compareOrRefreshGolden(UI_EXPECTED, actualCard, mode)
        if (firstRecording) {
          await mkdir(CURRENT_HEADER_CAPTURE, { recursive: true })
          await page.screenshot({ path: join(CURRENT_HEADER_CAPTURE, 'choice-card.png'), animations: 'disabled' })
        }
      } else expect(actualCard).toBe(firstCard)
      await card.getByRole('radio', { name: index === 1 ? '取消本次生成' : '使用 video-sd25-480p（约 ¥10.50）', exact: true }).click()
      await card.getByRole('button', { name: 'Submit', exact: true }).click()
      await card.waitFor({ state: 'detached', timeout: 10_000 })
    }
    await expect.poll(async () => {
      try { return rows(await storedSession(persistence, sessionId!)).filter(row => row.type === 'turn/end').length }
      catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT'
          || error instanceof Error && error.message.startsWith('No persisted Session')) return 0
        throw error
      }
    }, { timeout: 30_000 }).toBe(index + 1)
    expect(posts).toHaveLength(expectedPosts[index]!)
  }
  if (sessionId === undefined) throw new Error('No actual Session was created')
  const raw = await storedSession(persistence, sessionId)
  const results = toolResults(raw)
  expect(results.map(result => result.name)).toEqual(Array.from({ length: 4 }, () => 'generate_video'))
  const values = results.map(result => record(JSON.parse(result.text)))
  expect(values).toMatchObject([
    { status: 'failed', model: 'MiniMax-H3', code: 'H3_ACCOUNT_CAPACITY_EXHAUSTED' },
    { status: 'failed', code: 'USER_CANCELLED' },
    { status: 'failed', code: 'USER_CANCELLED' },
    { status: 'failed', model: TARGET, code: 'TASK_FAILED', task_id: 'model-choice-original-target' },
  ])
  expect(posts).toHaveLength(2)
  expect(quotes.length).toBeGreaterThanOrEqual(4)
  expect(queries).toEqual(['/harness/v1/videos/model-choice-original-target'])
  await expect.poll(() => clientReports.length, { timeout: 10_000 }).toBe(1)
  expect(modelRequests).toHaveLength(firstRecording ? 7 : 0)
  if (firstRecording) {
    expect(modelToolResult(modelRequests[4], 'choice-cancel')).toContain('USER_CANCELLED')
    expect(modelToolResult(modelRequests[4], 'choice-cancelled-fallback')).toContain('USER_CANCELLED')
  }
  expect(errors).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
  expect(blockedBrowserRequests).toEqual([])
  await mkdir(CURRENT_HEADER_CAPTURE, { recursive: true })
  await writeFile(join(CURRENT_HEADER_CAPTURE, `observations-${process.env.DSH_EXAMPLE_MODE ?? 'src'}-${mode}.json`), JSON.stringify({
    humanTurns: PROMPTS.length, actualModelCalls: modelRequests.length, toolResults: values,
    generationSubmissions: posts, quoteRequests: quotes, originalTaskQueries: queries, clientReports,
    blockedBrowserRequests, pageErrors: tripwire.pageErrors,
  }, null, 2) + '\n')
  await browser.close()
  await host.stop()
  await assertFinalWorkspaceSnapshot(SNAPSHOT_DIR, workspace)
  const normalizedRaw = tokenizeCreationIdentities(normalizeWebSessionVolatiles(raw))
  const context = { sessionIds: [sessionId], cwd: workspace }
  const prompts = normalizedSystemPrompts(normalizedRaw, context)
    .map(prompt => prompt.split(REPO_ROOT).join('{{sourceRoot}}').split(host.webUrl).join('{{webUrl}}'))
  const schemas = normalizedToolSchemas(normalizedRaw, context)
  const promptSidecar = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
  const schemaSidecar = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
  await Promise.all([
    writeFile(join(CURRENT_HEADER_CAPTURE, 'system-prompt.expected.md'), promptSidecar),
    writeFile(join(CURRENT_HEADER_CAPTURE, 'tool-schemas.expected.json'), schemaSidecar),
  ])
  if (firstRecording) {
    await writeFile(FIXTURE, redactSessionSnapshotIds([scrubSessionSnapshot(tokenizeSessionFixtureCwd(normalizedRaw))])[0]!)
  }
  const expected = await readFile(FIXTURE, 'utf8')
  expect(normalizeSessionSnapshots([normalizedRaw], context)[0]).toBe(normalizeSessionSnapshots([expected], fixtureContext(expected))[0])
  expect(promptSidecar).toBe(await readFile(join(HEADER_DIR, 'system-prompt.expected.md'), 'utf8'))
  expect(schemaSidecar).toBe(await readFile(join(HEADER_DIR, 'tool-schemas.expected.json'), 'utf8'))
}, 120_000)
