/** Temporary local invalidation failures preserve an unknown login and native recovery. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as fileSystem from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { connectDesktopWelcome } from '../../../../apps/desktop/src/welcome-backend.ts'
import * as Credits from '../src/index.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-read-storage-'))
  const context = new Context()
  const upstreamCalls: string[] = []
  const source = createServer((request, response) => {
    upstreamCalls.push(request.url ?? '/')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ success: true, data: { quota_per_unit: 500_000, usd_exchange_rate: 7.3 } }))
  })
  onTestFinished(async () => {
    await context.fiber.dispose()
    source.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      source.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
  const address = source.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture upstream did not listen')
  const api = `http://127.0.0.1:${String(address.port)}/harness`
  const stateDir = join(root, 'credits')
  await mkdir(stateDir)
  const file = join(stateDir, 'session.json')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-system-prompt' }, { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-credits-index', config: { stateDir, newApiBaseUrl: api, timeoutMs: 20, refreshRetryBaseDelayMs: 1 } },
  ]))
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-credits-index', Credits],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    },
  } as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  const base = `http://127.0.0.1:${String(context.webServer.port)}`
  const native = await connectDesktopWelcome(base + '/?token=fixture', async (input, init) => {
    if (new URL(input).pathname === '/credits/api/session') return await fetch(input)
    if (init?.method !== 'POST') return new Response('fixture')
    if (typeof init.body !== 'string') throw new Error('Expected a native RPC JSON body')
    const request = JSON.parse(init.body) as { rpcId: string }
    return Response.json({ type: 'server-response', rpcId: request.rpcId,
      result: { ok: true, value: { namespaces: [{ ns: 'locale', value: {} }] } } })
  })
  onTestFinished(() => { native.dispose() })
  return { context, api, file, base, native, upstreamCalls }
}

it.each(['expired', 'different-backend'] as const)('keeps %s login recoverable during local writer contention without exposing or using its credentials', async (mode) => {
  const app = await fixture()
  const saved = JSON.stringify({ token: 'fixture-local-login', backendBaseUrl: mode === 'expired' ? app.api : 'https://different.invalid/harness',
    expiresAt: mode === 'expired' ? '2000-01-01T00:00:00Z' : '9999-01-01T00:00:00Z',
    account: { id: '7', phone: '***0000' }, upstream: { token: 'fixture-management-access', expiresAt: '9999-01-01T00:00:00Z' },
    relay: { key: 'sk-fixture-relay' } })
  await writeFile(app.file, saved)
  // The actual cross-Host lock remains owned until both HTTP and native observations settle.
  await withFileLock(app.file, async () => {
    const response = await fetch(app.base + '/credits/api/session')
    const body: unknown = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: false, code: 'ACCOUNT_UNAVAILABLE', signedIn: true, liveness: 'unknown',
      failure: { reason: 'storage', stage: 'account-read' },
      payload: { signedIn: true, liveness: 'unknown', failure: { reason: 'storage', stage: 'account-read' } } })
    expect(JSON.stringify(body)).not.toMatch(/fixture-local-login|fixture-management-access|sk-fixture-relay|\.lock|EACCES|EBUSY/)
    expect(await app.native.read()).toMatchObject({ loggedIn: false, sessionIssue: 'storage' })
    await expect(app.context.harnessAccount.resolveRelayKey(app.api + '/v1')).rejects.toMatchObject({ name: 'SessionInvalidationUnavailableError' })
    expect(await readFile(app.file, 'utf8')).toBe(saved)
  })
  // The same explicit read can clear the invalid login after the writer releases it.
  expect(await app.native.read()).toEqual({ loggedIn: false, hasApiKey: false, writable: false, localePreference: null })
  expect(JSON.parse(await readFile(app.file, 'utf8'))).toEqual({})
  expect(app.upstreamCalls.every(path => !/\/v1\/|\/user\/auth\/refresh/.test(path))).toBe(true)
})

it('contains a failed atomic invalidation write, retains the old document, and clears it only after storage recovers', async () => {
  const app = await fixture()
  const saved = JSON.stringify({ token: 'fixture-local-login', backendBaseUrl: app.api,
    expiresAt: '2000-01-01T00:00:00Z', account: { id: '7', phone: '***0000' },
    upstream: { token: 'fixture-management-access', expiresAt: '9999-01-01T00:00:00Z' } })
  await writeFile(app.file, saved)
  const publish = vi.mocked(fileSystem.rename)
  const rename = publish.getMockImplementation()
  if (rename === undefined) throw new Error('Expected the real filesystem implementation')
  publish.mockImplementation(async (source, destination) => {
    if (destination === app.file) throw Object.assign(new Error('private filesystem detail'), { code: 'EACCES' })
    await rename(source, destination)
  })
  onTestFinished(() => { publish.mockImplementation(rename) })
  try {
    expect(await app.native.read()).toMatchObject({ loggedIn: false, sessionIssue: 'storage' })
    await expect(app.context.harnessAccount.resolveRelayKey(app.api + '/v1')).rejects.toMatchObject({ name: 'SessionInvalidationUnavailableError' })
    expect(await readFile(app.file, 'utf8')).toBe(saved)
  } finally { publish.mockImplementation(rename) }
  expect(await app.native.read()).toEqual({ loggedIn: false, hasApiKey: false, writable: false, localePreference: null })
  expect(JSON.parse(await readFile(app.file, 'utf8'))).toEqual({})
  expect(app.upstreamCalls.every(path => !/\/v1\/|\/user\/auth\/refresh/.test(path))).toBe(true)
})
