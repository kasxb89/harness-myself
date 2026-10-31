import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Credits from '../src/index.ts'
import { redactSessionSnapshotIds, normalizeSessionSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import { eventLines, toHeaderLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

const plain = 'declared-text-model'
const legacy = 'undeclared-chat-model'
const reference = credentialRef('TEXT_MODEL_SYNTHETIC_RELAY')
const declaration = { tools: false, vision: false, reasoning: false, stream: true, max_input_tokens: 32_000 }
const resources: { ctx: Context; directory: string; server?: Server }[] = []
afterEach(async () => {
  for (const { ctx, directory, server } of resources.splice(0).reverse()) {
    try { await ctx.fiber.dispose() }
    finally {
      if (server?.listening) await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
        server.closeAllConnections()
      })
      await rm(directory, { recursive: true, force: true })
    }
  }
})
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected fixture JSON')
  return value as Record<string, unknown>
}
async function boot(options: { declaration?: Record<string, unknown>; toolRound?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-text-policy-product-'))
  const ctx = new Context()
  const resource: { ctx: Context; directory: string; server?: Server } = { ctx, directory }
  resources.push(resource)
  const state = join(directory, 'credits')
  await mkdir(state)
  const calls: Record<string, unknown>[] = []
  const models = [
    { id: plain, kind: 'text', context_window: 1_000_000, max_output_tokens: 8192,
      parameters: { 'x-text-capabilities': options.declaration ?? declaration } },
    { id: legacy, kind: 'text', context_window: 262_144, max_output_tokens: 8192 },
  ]
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const payload = chunks.length === 0 ? {} : object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown) => response.end(JSON.stringify({ success: true, data }))
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500000, usd_exchange_rate: 7.3 }); return }
      if (path === '/harness/api/user/self') { answer({ id: 7, username: 'fixture', role: 1, group: 'default', quota: 1000000000 }); return }
      if (path === '/harness/api/pricing') { answer(models.map(({ id, ...model }) => ({ model_name: id, ...model }))); return }
      if (path === '/harness/v1/models') {
        expect(request.headers.authorization).toBe('Bearer sk-local-text-policy')
        response.end(JSON.stringify({ data: models })); return
      }
      if (path === '/harness/api/client-activity/heartbeat') { answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 30, online_timeout_seconds: 90 }); return }
      if (path === '/harness/v1/chat/completions') {
        expect(request.headers.authorization).toBe('Bearer sk-local-text-policy')
        calls.push(payload)
        response.setHeader('content-type', 'text/event-stream')
        const base = { id: `local-text-${calls.length}`, object: 'chat.completion.chunk', created: 1700000000, model: payload.model }
        if (options.toolRound && calls.length === 1) {
          response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant',
            tool_calls: [{ index: 0, id: 'verified-echo-call', type: 'function', function: { name: 'capability_echo', arguments: '{}' } }] }, finish_reason: null }] }) + '\n\n')
          response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n')
          response.end('data: [DONE]\n\n'); return
        }

        response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '这是一段正常的文本回答。' }, finish_reason: null }] }) + '\n\n')
        response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 } }) + '\n\n')
        response.end('data: [DONE]\n\n'); return
      }
      response.writeHead(404); response.end('{}')
    })().catch(() => response.destroy())
  })
  resource.server = server
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected fixture loopback listener')
  const api = `http://127.0.0.1:${address.port}/harness`
  const expiresAt = new Date(Date.now() + 900_000).toISOString()
  await writeFile(join(state, 'session.json'), JSON.stringify({ token: randomBytes(32).toString('hex'),
    backendBaseUrl: api, expiresAt, account: { id: '7', phone: 'local-text-policy' },
    upstream: { token: 'local-access', expiresAt }, relay: { key: 'sk-local-text-policy' } }), { mode: 0o600 })
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-projection', SessionProjections], ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop], ['@deepseek-ai/dsh-llm-pi-ai', PiAi], ['@deepseek-ai/dsh-credits-index', Credits],
  ])
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', loadCache: new Map(), async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
    if (!modules.has(specifier)) throw new Error('Unexpected product text-policy module')
    return modules.get(specifier)
  } } as NonNullable<typeof ctx.loader.internal>
  const config = join(directory, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } }, { name: '@deepseek-ai/dsh-tools' }, { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(directory, 'credentials.yaml'), dshHome: directory, watch: false } },
    { name: '@deepseek-ai/dsh-llm' }, { name: '@deepseek-ai/dsh-session' }, { name: '@deepseek-ai/dsh-session-projection' }, { name: '@deepseek-ai/dsh-agent' }, { name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
    { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'yunshu-local': { api: 'openai-completions', baseURL: api + '/v1', apiKeyEnv: reference,
      models: models.map(({ id }) => ({ id })) } } } },
    { name: '@deepseek-ai/dsh-credits-index', config: { stateDir: state, newApiBaseUrl: api, relayTokenEnv: reference,
      accountReadMinIntervalMs: 0, accountReadFailureCooldownMs: 1, mediaCatalogCacheTtlMs: 0 } },
  ]))
  await profileComposition(ctx, directory, config)
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  await ctx.harnessAccount.refreshModels(api + '/v1')
  const create = (id: string, model = plain, maxTokens?: number) => ctx.agentLoop.create(SessionId(id), {
    provider: 'yunshu-local', model, ...maxTokens === undefined ? {} : { maxTokens },
  })
  const send = (agent: Agent, text: string) => { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })) }
  return { ctx, calls, create, send, directory }
}

describe('declared text policy through the complete credits Host and actual Pi transport', () => {
  it('synchronizes the ordinary API declaration and sends a normal first text request with zero tools', async () => {
    const f = await boot()
    const metadata = await f.ctx.llm.resolveModelInfo('yunshu-local', plain)
    expect(metadata.textCapabilities).toEqual({ tools: false, vision: false, reasoning: false, stream: true, maxInputTokens: 32_000 })
    const agent = await f.create('product-plain')
    f.send(agent, '请用文字介绍海边日落。')
    await agent.whenIdle()
    expect(f.calls).toHaveLength(1)
    const request = f.calls[0]!
    expect(request.model).toBe(plain)
    expect(request.max_tokens).toBe(8192)
    expect(request.tools ?? []).toEqual([])
    expect(request.reasoning_effort).toBeUndefined()
    expect(JSON.stringify(request.messages)).toContain('This gateway currently permits text conversation only;')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('Gateway input ceiling: 32000 tokens.')
  })

  it('keeps a smaller explicit output budget and restores normal tools after switching to an undeclared model', async () => {
    const f = await boot()
    const agent = await f.create('product-switch', plain, 2048)
    const ref: ModelSelectionRef = { current: { provider: 'yunshu-local', model: plain }, assembled: undefined }
    installModelSelection(agent.ctx, ref)
    f.send(agent, '先进行纯文本交流。'); await agent.whenIdle()
    ref.current = { provider: 'yunshu-local', model: legacy }
    f.send(agent, '继续交流。'); await agent.whenIdle()
    expect(f.calls).toHaveLength(2)
    expect(f.calls.map(request => request.max_tokens)).toEqual([2048, 2048])
    expect(f.calls[0]!.tools ?? []).toHaveLength(0)
    const tools = f.calls[1]!.tools
    expect(Array.isArray(tools) ? tools.length : 0).toBeGreaterThan(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(2)
  })
})


describe('version2 positive capability through actual product composition', () => {
  const wire = { schema_version: 2, revision: 'local-verified-v2', checked_at: '2026-10-31T00:00:00Z',
    tools: true, vision: true, reasoning: true, stream: true, max_input_tokens: 32000,
    verification: { tools: 'supported', vision: 'supported', reasoning: 'supported' }, input_modalities: ['text', 'image'],
    tools_config: { protocol: 'openai-chat', roundtrip_verified: true, verified_tool_choices: ['auto'], parallel_calls: 'unverified' },
    vision_config: { verified_transports: ['data_url'], verified_mime_types: ['image/png'], billing: 'input_tokens' },
    reasoning_mode: 'configurable', reasoning_controls: { type: 'object', properties: { enable_thinking: { type: 'boolean', default: true } }, additionalProperties: false },
    reasoning_omit_behavior: 'provider_default', operational_status: 'available' }
  it('executes a real echoed tool call, retains matching result and sends the next model turn with explicit off', async () => {
    const f = await boot({ declaration: wire, toolRound: true })
    let executions = 0
    f.ctx.effect(() => f.ctx.tools.register(defineTool({ name: 'capability_echo', description: 'Return the deterministic capability probe nonce.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
      async execute() { executions += 1; return 'echo-result-unique-7391' },
    })))
    const agent = await f.ctx.agentLoop.create(SessionId('v2-actual-tool-round'), { provider: 'yunshu-local', model: plain,
      reasoningEffort: ReasoningEffortId('off'), maxTokens: 2048 })
    f.send(agent, 'Call capability_echo once and report its result.')
    await agent.whenIdle()
    expect(executions).toBe(1)
    expect(f.calls).toHaveLength(2)
    for (const request of f.calls) {
      expect(request.enable_thinking).toBe(false)
      expect(request.reasoning_effort).toBeUndefined()
      expect(request.max_tokens).toBe(2048)
      expect(Array.isArray(request.tools) && request.tools.length > 0).toBe(true)
    }
    expect(JSON.stringify(f.calls[1]?.messages)).toContain('verified-echo-call')
    expect(JSON.stringify(f.calls[1]?.messages)).toContain('echo-result-unique-7391')
    expect(agent.session.deriveMessages().some(message => message.role === 'tool')).toBe(true)
  })
  it('blocks only images during a localized outage while actual Agent tools and file handles still complete', async () => {
    const f = await boot({ declaration: { ...wire, vision: false, input_modalities: ['text'],
      verification: { ...wire.verification, vision: 'unverified' }, vision_config: { ...wire.vision_config,
        operational_status: 'temporarily_unavailable', operational_reason: 'Temporary image outage.' } }, toolRound: true })
    const blocked = await f.create('v2-local-image-outage')
    const image = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect this image.' },
      { type: 'image', attachment: { attachmentId: AttachmentId('c'.repeat(64)), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }] })
    blocked.followup(image)
    await blocked.whenIdle()
    expect(f.calls).toHaveLength(0)
    const end = blocked.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind === 'error' ? end.data.reason.error.code : undefined)
      .toBe('MODEL_CAPABILITY_INPUT_UNAVAILABLE')
    expect(image.content.some(block => block.type === 'image')).toBe(true)
    let executions = 0
    f.ctx.effect(() => f.ctx.tools.register(defineTool({ name: 'capability_echo', description: 'Echo the local file-handle probe.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
      async execute() { executions += 1; return 'local-file-handle-echo-9182' },
    })))
    const allowed = await f.create('v2-local-image-outage-tools')
    allowed.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use capability_echo with the attached file handle.' },
      { type: 'file', attachment: { attachmentId: AttachmentId('b'.repeat(64)), name: 'notes.txt', bytes: 12 } }] }))
    await allowed.whenIdle()
    expect(executions).toBe(1)
    expect(f.calls).toHaveLength(2)
    expect(JSON.stringify(f.calls[0]?.messages)).toContain('notes.txt')
    expect(JSON.stringify(f.calls[1]?.messages)).toContain('local-file-handle-echo-9182')
    expect(JSON.stringify(f.calls[0]?.messages)).toContain('Image input is temporarily unavailable')
    const metadata = await f.ctx.llm.resolveModelInfo('yunshu-local', plain)
    expect(metadata.textCapabilities).toMatchObject({ tools: true, vision: false, operationalStatus: 'available', verification: { vision: 'unverified' } })
    const destination = new URL('./expected/text-model-capabilities-v2-image-outage/', import.meta.url)
    for (const [name, agent] of [['blocked', blocked], ['file-tool-completed', allowed]] as const) {
      const raw = JSON.stringify(toHeaderLine(agent.session.header)) + '\n' + eventLines(agent.session.snapshotEvents())
      const redacted = redactSessionSnapshotIds([raw])[0]
      if (redacted === undefined) throw new Error('Missing actual Agent snapshot')
      const normalized = normalizeSessionSnapshot(redacted, { sessionIds: [], cwd: f.directory }, { identityMode: 'preserve' })
      const path = new URL(name + '.session.v4.jsonl', destination)
      if (process.env.DSH_SNAPSHOT === 'record') { await mkdir(destination, { recursive: true }); await writeFile(path, normalized) }
      expect(normalized).toBe(await readFile(path, 'utf8'))
    }
  })
  it('keeps unverified features eligible and Auto omitted even when the schema declares a provider default', async () => {
    const f = await boot({ declaration: { ...wire, tools: false,
      verification: { tools: 'unverified', vision: 'unverified', reasoning: 'unverified' } } })
    const agent = await f.create('v2-unverified-auto')
    f.send(agent, 'Use ordinary text and preserve default reasoning behavior.')
    await agent.whenIdle()
    expect(f.calls).toHaveLength(1)
    expect(Array.isArray(f.calls[0]?.tools) && f.calls[0].tools.length > 0).toBe(true)
    expect(f.calls[0]).not.toHaveProperty('enable_thinking')
    expect(f.calls[0]).not.toHaveProperty('reasoning_effort')
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('verification: unverified')
    expect(JSON.stringify(f.calls[0]?.messages)).not.toContain('This gateway currently permits text conversation only;')
  })
})
