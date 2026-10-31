import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Credits from '../src/index.ts'
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
async function boot() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-text-policy-product-'))
  const ctx = new Context()
  const resource: { ctx: Context; directory: string; server?: Server } = { ctx, directory }
  resources.push(resource)
  const state = join(directory, 'credits')
  await mkdir(state)
  const calls: Record<string, unknown>[] = []
  const models = [
    { id: plain, kind: 'text', context_window: 1_000_000, max_output_tokens: 8192,
      parameters: { 'x-text-capabilities': declaration } },
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
  return { ctx, calls, create, send }
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
    expect(JSON.stringify(request.messages)).toContain('This model supports text conversation only.')
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
