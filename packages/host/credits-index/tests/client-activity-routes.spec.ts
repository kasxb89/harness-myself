/** Real Loader, HTTP carrier and browser authentication for content-free account activity. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { CredentialRecord, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Credits from '../src/index.ts'

let context: Context | undefined
let root: string | undefined
let upstream: Server | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (upstream !== undefined) await new Promise<void>((resolve, reject) => {
    upstream?.close((error) => { if (error === undefined) resolve(); else reject(error) })
    upstream?.closeAllConnections()
  })
  upstream = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
})

it('authenticates native activity, isolates login epochs, retains /harness and stops on logout and disposal', async () => {
  const calls: { path: string; authorization?: string; body: Record<string, unknown> }[] = []
  let unavailable = false
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      calls.push({ path: request.url ?? '', ...request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }, body })
      response.setHeader('content-type', 'application/json')
      if (request.url === '/harness/api/user/auth/refresh') return
      if (request.url === '/harness/api/user/phone/login') {
        response.end(JSON.stringify({ success: true, data: { access_token: 'second-access', access_expires_at: 253402300799,
          relay_key: 'sk-second-key', user: { id: 8, phone_e164: '+8613800000001' } } }))
      } else if (unavailable) { response.writeHead(503); response.end('sensitive upstream diagnostic') }
      else response.end(JSON.stringify({ success: true, data: {
        server_time: 123, heartbeat_interval_seconds: 30, online_timeout_seconds: 90,
      } }))
    })().catch(() => { response.destroy() })
  })
  await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('missing activity receiver')
  root = await mkdtemp(join(tmpdir(), 'yunshu-activity-loader-'))
  const stateDir = join(root, 'credits')
  await mkdir(stateDir)
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({ token: 'first-private-login-epoch', expiresAt: '9999-01-01T00:00:00.000Z',
    account: { id: '7', phone: '+8613800000000' }, upstream: { token: 'first-access',
      refresh: 'blocked-refresh', expiresAt: new Date(Date.now() + 90_000).toISOString() } }), { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, ["- name: 'fixture:credentials'", "- name: '@deepseek-ai/dsh-host-webserver'", '  config:', "    host: '127.0.0.1'", '    port: 0',
    "- name: '@deepseek-ai/dsh-client-connection'", "- name: '@deepseek-ai/dsh-system-prompt'", "- name: '@deepseek-ai/dsh-tools'", "- name: '@deepseek-ai/dsh-credits-index'",
    '  config:', `    stateDir: '${stateDir}'`, `    newApiBaseUrl: 'http://127.0.0.1:${String(address.port)}/harness'`, '    timeoutMs: 1000', ''].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  let record: CredentialRecord | undefined
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-credits-index', Credits],
    ['fixture:credentials', { apply(ctx: Context) { ctx.provide('credentials', {
      resolve: async () => undefined, set: async () => {}, unset: async () => {},
      modifyRecord: async (...[_key, modify]: Parameters<CredentialProvider['modifyRecord']>) => {
        record = await modify(record) ?? record
        return record
      },
    }) } }],
  ])
  context.loader.internal = { version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
    if (!modules.has(specifier)) throw new Error(`unexpected module: ${specifier}`)
    return modules.get(specifier)
  } } as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  await expect(context.harnessAccount.refreshModels(`http://127.0.0.1:${String(address.port)}/harness/v1`)).rejects.toThrow()
  const observedNow = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(observedNow + 60_000)
  const base = `http://127.0.0.1:${String(context.webServer.port)}`
  const loginUrl = new URL(context.connection.authenticatedUrl(base))
  const cookieHeaders: Record<string, string> = {}
  context.connection.authorizeIndex({ method: 'GET', url: loginUrl.pathname + loginUrl.search, headers: { host: loginUrl.host } }, {
    writeHead(_status, headers) { Object.assign(cookieHeaders, headers) }, end() {},
  })
  const cookie = cookieHeaders['set-cookie']?.split(';')[0]
  expect(cookie).toBeDefined()
  const sample = { session_id: '01234567-89ab-4cde-8fab-0123456789ab', event: 'start', foreground: true, platform: 'win32', app_version: '1.2.3' }
  const post = (path: string, body: unknown, authenticated = true) => fetch(base + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...authenticated && cookie !== undefined ? { cookie } : {} }, body: JSON.stringify(body) })
  expect((await post('/credits/api/activity', sample, false)).status).toBe(401)
  expect((await post('/credits/api/activity', { ...sample, user_id: 99 })).status).toBe(400)
  expect(calls).toHaveLength(0)
  expect(await (await post('/credits/api/activity', sample)).json()).toEqual({ ok: true })
  expect(await (await post('/credits/api/activity', { ...sample, event: 'heartbeat', foreground: false })).json()).toEqual({ ok: true })
  const firstId = calls[0]!.body.session_id
  expect(firstId).not.toBe(sample.session_id)
  expect(calls[1]?.body.session_id).toBe(firstId)
  expect(calls[0]?.authorization).toBe('Bearer first-access')
  expect(calls.every(call => call.path === '/harness/api/client-activity/heartbeat')).toBe(true)
  expect(calls.some(call => call.path.includes('/auth/refresh'))).toBe(false)
  expect(JSON.stringify(calls.map(call => call.body))).not.toMatch(/private|access|phone|user_id|token/)
  await post('/credits/api/session/logout', {})
  expect(calls[2]?.body).toMatchObject({ session_id: firstId, event: 'stop', foreground: false })
  const afterLogout = calls.length
  expect(await (await post('/credits/api/activity', sample)).json()).toMatchObject({ recorded: false })
  expect(calls).toHaveLength(afterLogout)
  expect(await (await post('/credits/api/session/verify', { challengeId: '+8613800000001', code: '123456', idempotencyKey: 'login' })).json()).toMatchObject({ ok: true })
  await post('/credits/api/activity', sample)
  const secondId = calls.at(-1)?.body.session_id
  expect(secondId).not.toBe(firstId)
  expect(calls.at(-1)?.authorization).toBe('Bearer second-access')
  unavailable = true
  expect(await (await post('/credits/api/activity', sample)).json()).toEqual({ ok: true, recorded: false })
  unavailable = false
  const fiber = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-credits-index')?.fiber
  expect(fiber).toBeDefined()
  await fiber?.dispose()
  expect(calls.at(-1)?.body).toMatchObject({ session_id: secondId, event: 'stop', foreground: false })
  expect((await post('/credits/api/activity', sample)).status).toBe(404)
})
