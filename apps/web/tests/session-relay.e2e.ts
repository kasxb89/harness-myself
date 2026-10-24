/** Ordinary chats exchange attributed inbox messages through the shipped profile without inheriting human authority. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds,
  scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { startProfileWeb } from './profile-process.ts'
import { REPO_ROOT } from './support.ts'

const SCENARIO = fileURLToPath(new URL('../../../snapshots/web/session-relay', import.meta.url))
const FIXTURES = ['session.v4.jsonl', 'session.1.v4.jsonl'].map(name => join(SCENARIO, name))
const KEY = 'DSH_SESSION_RELAY_FIXTURE_KEY'
type Row = Record<string, unknown>

function rows(raw: string): Row[] { return raw.trimEnd().split('\n').map(line => JSON.parse(line) as Row) }

async function stored(root: string, id: string): Promise<string> {
  const files = latestPersistedSessionPaths((await readdir(root, { recursive: true })).map(path => join(root, path)))
  for (const file of files) {
    const raw = await readFile(file, 'utf8')
    if (rows(raw)[0]?.id === id) return raw
  }
  throw new Error(`No persisted test chat ${id}`)
}

function results(raw: string) {
  return rows(raw).filter(row => row.type === 'tool/result').map((row) => {
    const data = row.data as { message: { toolCallId: string; content: { type: string; text?: string }[]; isError?: boolean } }
    return { callId: data.message.toolCallId, isError: data.message.isError,
      text: data.message.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('') }
  })
}

function relayInsertions(raw: string) {
  return rows(raw).filter(row => row.type === 'agent/inbox/spliced').flatMap(row =>
    (row.data as { inserted: { id: string; source: { kind: string; senderSessionId?: string } }[] }).inserted
      .filter(message => message.source.kind === 'agent-message'))
}

function tokenizeRelayMessages(logs: readonly string[]): string[] {
  const ids = new Map<string, string>()
  for (const raw of logs) for (const result of results(raw)) {
    if (!result.text.startsWith('{')) continue
    const receipt = JSON.parse(result.text) as Row
    if (receipt.status === 'accepted' && typeof receipt.messageId === 'string') {
      if (!/^session-relay-[a-f0-9]{64}$/u.test(receipt.messageId)) throw new Error('Unexpected relay receipt identity')
      if (!ids.has(receipt.messageId)) ids.set(receipt.messageId, `{{message:${1001 + ids.size}}}`)
    }
  }
  return logs.map((raw) => {
    for (const [id, token] of ids) raw = raw.split(id).join(token)
    return raw
  })
}

function modelEvent(tool?: { name: string; args: object }): object[] {
  return [
    { type: 'message_start', message: { id: 'relay-fixture-message', type: 'message', role: 'assistant', model: 'synthetic', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
    ...tool === undefined ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已记录当前聊天的处理结果。' } },
    ] : [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-0', name: tool.name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } },
    ],
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool === undefined ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
}

function recordedEvents(chunks: readonly StreamChunk[], target: string): object[] {
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  if (call?.type !== 'block-end' || call.block.type !== 'tool-call') return modelEvent()
  const args = JSON.parse(call.block.arguments) as Row
  if ('session_id' in args) args.session_id = target
  return modelEvent({ name: call.block.name, args })
}

it('records cold and busy ordinary-chat delivery, independent identical sends, and refusal of agent-authorized replies or paid media', async (test) => {
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('This scenario uses only a controlled loopback model in refresh mode')
  const fresh = !existsSync(FIXTURES[0]!)
  if (fresh && mode !== 'refresh') throw new Error('Create this authored scenario with DSH_SNAPSHOT=refresh')
  const scripts = fresh ? undefined : await Promise.all(FIXTURES.map(async file => deriveReplayScript(parseSessionLog(await readFile(file, 'utf8')))))
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-relay-profile-'))
  const workspace = join(root, 'workspace')
  const persistence = join(root, 'sessions')
  await Promise.all([mkdir(workspace), mkdir(persistence)])
  const cleanup: { stop?: () => Promise<void> } = {}
  let releaseHold: (() => void) | undefined
  const held = new Promise<void>((resolve) => { releaseHold = resolve })
  let holding = false
  let targetId = ''
  let senderId = ''
  let senderStep = 0
  const roleCalls: [number, number] = [0, 0]
  const relaySteps = new Map<number, number>()
  const unexpected: string[] = []
  const imagePosts: string[] = []
  const modelActions: string[] = []
  let observedLogs: string[] = []
  test.onTestFailed(async () => {
    const logs = observedLogs.length > 0 ? observedLogs
      : (await Promise.allSettled([senderId, targetId].filter(Boolean).map(id => stored(persistence, id))))
        .flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const observed = logs.map(raw => rows(raw).filter(row => ['tool/call', 'tool/result', 'turn/end'].includes(String(row.type))))
    console.error(JSON.stringify({ senderStep, holding, roleCalls, modelActions, imagePosts, unexpected, observed }, null, 2))
  })
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (request.method === 'POST' && /\/(?:images|uploads)(?:\/|$)/u.test(path)) imagePosts.push(path)
      const answer = (data: object) => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ success: true, data }))
      }
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500_000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: 'relay-synthetic-challenge', delivery_status: 'accepted', expires_at: Math.floor(Date.now() / 1000) + 300,
          resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        response.setHeader('set-cookie', 'new_api_refresh=relay-synthetic-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: 'relay-synthetic-access', access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: 'sk-relay-synthetic', relay_key_id: 9, session: { sid: 'relay-synthetic-login', current: true },
          user: { id: 7, username: 'relay-synthetic-user', quota: 500_000 } }); return
      }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'relay-synthetic-user', group: 'product', quota: 500_000 }); return }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ heartbeat_interval_seconds: 60 }); return }
      if (path === '/harness/api/client-errors') { answer({ accepted: true }); return }
      if (path !== '/v1/messages' && path !== '/messages') { unexpected.push(path); response.writeHead(404); response.end('{}'); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { role: string; content: { type: string; text?: string }[] }[]
      }
      const userTexts = body.messages.filter(message => message.role === 'user').flatMap(message =>
        message.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []))
      const latest = userTexts.filter(text => ['请把更新', 'Message from Session', 'Notification from Session', '保持任务运行', '准备接收聊天通知']
        .some(marker => text.includes(marker))).at(-1) ?? ''
      const sender = latest.includes('请把更新')
      const role = sender ? 0 : 1
      const scripted = scripts?.[role]?.[roleCalls[role]++]
      let tool: { name: string; args: object } | undefined
      if (sender) {
        const step = senderStep++
        if (step === 0) tool = { name: 'session_list', args: { limit: 1 } }
        else if (step === 1) tool = { name: 'session_read', args: { session_id: targetId, limit: 2 } }
        else if (step === 2 || step === 4) tool = { name: 'session_send_message',
          args: { session_id: targetId, message: '进度更新', delivery: step === 2 ? 'notice' : 'queue' } }
      } else if (/(?:Message|Notification) from Session/u.test(latest)) {
        const count = userTexts.join('\n').match(/(?:Message|Notification) from Session/gu)?.length ?? 0
        const step = relaySteps.get(count) ?? 0
        relaySteps.set(count, step + 1)
        if (step === 0) tool = { name: 'generate_video_project', args: { model: 'MiniMax-H3', prompt: '海边风景', total_duration_seconds: 4 } }
        else if (step === 1) tool = { name: 'generate_image', args: { prompt: '不应由聊天通知授权生成的图片' } }
        else if (step === 2) tool = { name: 'session_send_message', args: { session_id: senderId, message: '自动回信不应投递' } }
      } else if (latest.includes('保持任务运行')) {
        holding = true
        await held
      }
      if (scripts !== undefined && scripted?.kind !== 'chunks') throw new Error(`Missing recorded role ${role} model call`)
      const events = scripted?.kind === 'chunks' ? recordedEvents(scripted.chunks, sender ? targetId : senderId) : modelEvent(tool)
      modelActions.push(`${sender ? 'sender' : 'target'}:${tool?.name ?? 'finish'}`)
      response.setHeader('content-type', 'text/event-stream')
      response.end(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })().catch((error: unknown) => { unexpected.push(String(error)); response.destroy() })
  })
  test.onTestFinished(async () => {
    releaseHold?.()
    try { await cleanup.stop?.() } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
        server.closeAllConnections()
      })
      await rm(root, { recursive: true, force: true })
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing loopback model port')
  const origin = `http://127.0.0.1:${address.port}`
  const overlay = join(root, 'relay.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' } },
    { id: 'session-persistence-jsonl', config: { root: persistence, compression: 'none' } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'product-extensions', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'computer-use', disabled: true }, { id: 'computer-use-cua-driver-native', disabled: true },
    { id: 'credits-index', config: { newApiBaseUrl: `${origin}/harness`, baseUrl: '', bridgeBaseUrl: '', stateDir: join(root, 'credits') } },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'llm-deepseek', disabled: false, config: { apiKeyEnv: KEY, baseURL: origin, reasoningEffort: 'off', thinking: 'disabled',
      models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000, inputModalities: ['text'] }] } },
  ]))
  let host = await startProfileWeb(root, workspace, overlay, { [KEY]: 'keyless-session-relay' })
  const webOrigins = new Set([host.webUrl])
  cleanup.stop = () => host.stop()
  const creditsPost = async (path: string, value: object) => {
    const response = await fetch(new URL(path, host.webUrl), { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: host.cookie }, body: JSON.stringify(value), signal: AbortSignal.timeout(10_000) })
    expect(response.ok).toBe(true)
    return await response.json() as Row
  }
  expect(await creditsPost('/credits/api/session/challenge', { phone: '+8613800000000', idempotencyKey: 'relay-challenge' }))
    .toMatchObject({ ok: true })
  expect(await creditsPost('/credits/api/session/verify', { challengeId: 'relay-synthetic-challenge', code: '123456', idempotencyKey: 'relay-login' }))
    .toMatchObject({ ok: true })
  targetId = (await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })).sessionId
  const prompt = async (id: string, text: string, requestId: string) => host.remote('session/prompt', {
    request: { sessionId: id, requestId, mode: 'queue', clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text }] },
  })
  const turns = async (id: string) => rows(await stored(persistence, id)).filter(row => row.type === 'turn/end').length
  await prompt(targetId, '准备接收聊天通知，同时生成3条4秒海边视频。', 'relay-seed')
  await expect.poll(() => turns(targetId), { timeout: 30_000 }).toBe(1)
  await host.stop()
  host = await startProfileWeb(root, workspace, overlay, { [KEY]: 'keyless-session-relay' })
  webOrigins.add(host.webUrl)
  senderId = (await host.remote<{ sessionId: string }>('session/create', { request: { cwd: workspace } })).sessionId
  const task = `请把更新“进度更新”发送到聊天 ${targetId}。`
  await prompt(senderId, task, 'relay-human-1')
  await expect.poll(() => turns(senderId), { timeout: 30_000 }).toBe(1)
  expect(await turns(targetId)).toBe(1)
  expect(relayInsertions(await stored(persistence, targetId))).toHaveLength(1)
  await prompt(targetId, '保持任务运行，等待我继续。', 'relay-hold')
  await expect.poll(() => holding, { timeout: 30_000 }).toBe(true)
  await prompt(senderId, task, 'relay-human-2')
  await expect.poll(() => turns(senderId), { timeout: 30_000 }).toBe(2)
  const busyRaw = await stored(persistence, targetId)
  expect(relayInsertions(busyRaw)).toHaveLength(2)
  expect(relayInsertions(busyRaw).every(message => message.source.senderSessionId === senderId)).toBe(true)
  expect(new Set(relayInsertions(busyRaw).map(message => message.id)).size).toBe(2)
  releaseHold?.()
  await expect.poll(() => turns(targetId), { timeout: 30_000 }).toBe(4)
  const actual = await Promise.all([stored(persistence, senderId), stored(persistence, targetId)])
  observedLogs = [...actual]
  const sent = results(actual[0]).filter(item => item.text.includes('"status":"accepted"')).map(item => JSON.parse(item.text) as Row)
  expect(sent).toHaveLength(2)
  expect(sent.every(item => item.duplicate === false)).toBe(true)
  const refused = results(actual[1]).filter(item => item.isError === true)
  expect(refused).toHaveLength(2)
  expect(refused.every(item => item.text.includes('human-authorized submission'))).toBe(true)
  const videoDenials = results(actual[1]).filter(item => item.text.includes('CREATIVE_VIDEO_INTENT_UNAVAILABLE'))
  expect(videoDenials).toHaveLength(2)
  expect(videoDenials.map(item => JSON.parse(item.text) as Row)).toMatchObject([
    { status: 'failed', code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' }, { status: 'failed', code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' },
  ])
  const imageDenials = results(actual[1]).filter(item => item.text.includes('CREATIVE_IMAGE_INTENT_UNAVAILABLE'))
  expect(imageDenials.map(item => JSON.parse(item.text) as Row)).toMatchObject([
    { status: 'failed', code: 'CREATIVE_IMAGE_INTENT_UNAVAILABLE' }, { status: 'failed', code: 'CREATIVE_IMAGE_INTENT_UNAVAILABLE' },
  ])
  expect(imagePosts).toEqual([])
  const creativeRecords = join(root, 'credits/creative-projects')
  expect(existsSync(creativeRecords) ? await readdir(creativeRecords, { recursive: true }) : []).toEqual([])
  const sources = rows(actual[0]).filter(row => row.type === 'user/message')
    .map(row => (row.data as { source: { kind: string; rpcId?: string } }).source)
  expect(sources.filter(source => source.kind === 'user').map(source => source.rpcId)).toEqual(['relay-human-1', 'relay-human-2'])
  expect(sources.some(source => source.kind === 'agent-message')).toBe(false)
  expect(unexpected).toEqual([])
  if (scripts !== undefined) expect(roleCalls).toEqual(scripts.map(script => script.length))
  await host.stop()
  const normalizedActual = tokenizeRelayMessages(actual.map(raw => normalizeWebSessionVolatiles(raw)))
  const context = { sessionIds: [senderId, targetId], cwd: workspace }
  const prompts = normalizedActual.flatMap(raw => normalizedSystemPrompts(raw, context))
    .map((text) => {
      let normalized = text.split(REPO_ROOT).join('{{sourceRoot}}')
      for (const origin of webOrigins) normalized = normalized.split(origin).join('{{webUrl}}')
      return normalized
    })
  const schemas = normalizedActual.flatMap(raw => normalizedToolSchemas(raw, context))
  const promptSidecar = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
  const schemaSidecar = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
  if (fresh) {
    const normalized = redactSessionSnapshotIds(normalizedActual.map(raw => scrubSessionSnapshot(tokenizeSessionFixtureCwd(raw))))
    await Promise.all(FIXTURES.map((file, index) => writeFile(file, normalized[index]!)))
  }
  if (mode === 'refresh') await Promise.all([
    writeFile(join(SCENARIO, 'system-prompt.expected.md'), promptSidecar), writeFile(join(SCENARIO, 'tool-schemas.expected.json'), schemaSidecar),
  ])
  const expected = await Promise.all(FIXTURES.map(file => readFile(file, 'utf8')))
  expect(normalizeSessionSnapshots(normalizedActual, context)).toEqual(normalizeSessionSnapshots(expected, fixtureContext(expected[0]!)))
  expect(promptSidecar).toBe(await readFile(join(SCENARIO, 'system-prompt.expected.md'), 'utf8'))
  expect(schemaSidecar).toBe(await readFile(join(SCENARIO, 'tool-schemas.expected.json'), 'utf8'))
})
