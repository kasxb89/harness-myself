/** Real Loader, browser-authenticated Host and credential-free public API status reads. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import * as Credits from '../src/index.ts'
import fixtures from './fixtures/announcements-api-contract.json' with { type: 'json' }

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
})

it('projects the actual announcement fixtures, isolates login epochs and contains timeout, redirect and disposal', async () => {
  const calls: { path: string; authorization?: string; cookie?: string }[] = []
  let fixture = fixtures[0]!
  let mode: 'fixture' | '404' | '503' | 'invalid' | 'redirect' | 'held' = 'fixture'
  let entered = Promise.withResolvers<ServerResponse>()
  let closed = Promise.withResolvers<undefined>()
  upstream = createServer((request, response) => {
    calls.push({ path: request.url ?? '', ...request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization },
      ...request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie } })
    if (request.url === '/harness/api/user/auth/logout') { response.end('{}'); return }
    if (request.url !== '/harness/api/status') { response.writeHead(404); response.end(); return }
    if (mode === 'held') {
      response.once('close', () => { closed.resolve(undefined) })
      entered.resolve(response)
      return
    }
    if (mode === 'redirect') { response.writeHead(302, { location: '/harness/forbidden-redirect' }); response.end(); return }
    response.setHeader('content-type', 'application/json')
    if (mode === '404' || mode === '503') { response.writeHead(Number(mode)); response.end('private diagnostic'); return }
    response.end(mode === 'invalid' ? '{broken' : JSON.stringify({ ...fixture.response,
      data: { ...fixture.response.data, unrelated_status_setting: 'not exposed' } }))
  })
  await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('missing announcement receiver')
  root = await mkdtemp(join(tmpdir(), 'dsh-announcements-loader-'))
  const stateDir = join(root, 'credits')
  await mkdir(stateDir)
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({ token: 'private-product-session', expiresAt: '9999-01-01T00:00:00.000Z',
    account: { id: '7', phone: 'fixture' }, upstream: { token: 'private-access-token', refresh: 'private-refresh-cookie',
      expiresAt: '9999-01-01T00:00:00.000Z' } }), { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, ["- name: 'fixture:credentials'", "- name: '@deepseek-ai/dsh-host-webserver'", '  config:', "    host: '127.0.0.1'", '    port: 0',
    "- name: '@deepseek-ai/dsh-client-connection'", "- name: '@deepseek-ai/dsh-system-prompt'", "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-credits-index'", '  config:', `    stateDir: '${stateDir}'`,
    `    newApiBaseUrl: 'http://127.0.0.1:${String(address.port)}/harness'`, '    timeoutMs: 1000', ''].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  let credential: CredentialRecord | undefined
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-credits-index', Credits],
    ['fixture:credentials', { apply(ctx: Context) { ctx.provide('credentials', {
      resolve: async () => undefined, set: async () => {}, unset: async () => {},
      modifyRecord: async (...[_key, modify]: Parameters<CredentialProvider['modifyRecord']>) => {
        credential = await modify(credential) ?? credential
        return credential
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
  const base = `http://127.0.0.1:${String(context.webServer.port)}`
  const login = new URL(context.connection.authenticatedUrl(base))
  const headers: Record<string, string> = {}
  context.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: login.host } }, {
    writeHead(_status, value) { Object.assign(headers, value) }, end() {},
  })
  const cookie = headers['set-cookie']?.split(';')[0]
  if (cookie === undefined) throw new Error('missing browser cookie')
  const read = () => fetch(base + '/credits/api/announcements?url=https://must-not-be-requested.invalid', { headers: { cookie } })
  expect((await fetch(base + '/credits/api/announcements')).status).toBe(401)
  expect((await fetch(base + '/credits/api/announcements', { method: 'POST', headers: { cookie } })).status).toBe(405)
  expect(calls).toHaveLength(0)
  for (const actual of fixtures) {
    fixture = actual
    const response = await read()
    expect(response.headers.get('cache-control')).toBe('no-store')
    const items = actual.response.data.announcements
    expect(await response.json()).toEqual({ ok: true, payload: { enabled: actual.response.data.announcements_enabled,
      items: Array.isArray(items) ? items.map(item => ({ content: item.content, publishDate: item.publishDate,
        ...typeof item.extra === 'string' ? { extra: item.extra } : {} })) : [] } })
  }
  expect(calls.every(call => call.path === '/harness/api/status' && call.authorization === undefined && call.cookie === undefined)).toBe(true)
  for (const [failure, code] of [['404', 'ANNOUNCEMENTS_UNSUPPORTED'], ['503', 'ANNOUNCEMENTS_UNAVAILABLE'],
    ['invalid', 'ANNOUNCEMENTS_INVALID'], ['redirect', 'ANNOUNCEMENTS_NETWORK']] as const) {
    mode = failure
    expect(await (await read()).json()).toEqual({ ok: false, code })
  }
  expect(calls.some(call => call.path.includes('forbidden-redirect') || call.path.includes('/api/notice'))).toBe(false)
  mode = 'held'
  const pending = read()
  const old = await entered.promise
  await fetch(base + '/credits/api/session/logout', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
  old.end(JSON.stringify(fixtures[0]!.response))
  expect(await (await pending).json()).toEqual({ ok: false, code: 'ACCOUNT_CHANGED' })
  entered = Promise.withResolvers<ServerResponse>()
  closed = Promise.withResolvers<undefined>()
  const timedOut = read()
  await entered.promise
  expect(await (await timedOut).json()).toEqual({ ok: false, code: 'ANNOUNCEMENTS_NETWORK' })
  await closed.promise
  entered = Promise.withResolvers<ServerResponse>()
  closed = Promise.withResolvers<undefined>()
  const disposing = read()
  await entered.promise
  const fiber = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-credits-index')?.fiber
  expect(fiber).toBeDefined()
  await fiber?.dispose()
  expect(await (await disposing).json()).toEqual({ ok: false, code: 'ANNOUNCEMENTS_NETWORK' })
  await closed.promise
  expect((await read()).status).toBe(404)
})
