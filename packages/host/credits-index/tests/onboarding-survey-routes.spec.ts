/** Actual API questionnaire fixtures pass through the real Loader and current-login Host route. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
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
import pending from './fixtures/onboarding-survey-api/pending.json' with { type: 'json' }
import deferred from './fixtures/onboarding-survey-api/deferred.json' with { type: 'json' }
import submitted from './fixtures/onboarding-survey-api/submitted.json' with { type: 'json' }
import ineligible from './fixtures/onboarding-survey-api/not-eligible.json' with { type: 'json' }
import conflict from './fixtures/onboarding-survey-api/different-answer-conflict.json' with { type: 'json' }
import configuredPending from './fixtures/onboarding-survey-api-v2/pending.json' with { type: 'json' }
import configuredDeferred from './fixtures/onboarding-survey-api-v2/deferred.json' with { type: 'json' }
import configuredSubmitted from './fixtures/onboarding-survey-api-v2/submitted.json' with { type: 'json' }
import configuredIneligible from './fixtures/onboarding-survey-api-v2/not-eligible.json' with { type: 'json' }
import changedPending from './fixtures/onboarding-survey-api-v2/config-changed-pending.json' with { type: 'json' }
import legacySubmitted from './fixtures/onboarding-survey-api-v2/legacy-submitted.json' with { type: 'json' }
import staleConfiguration from './fixtures/onboarding-survey-api-v2/stale-config.json' with { type: 'json' }

const resources: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })

async function boot(schema: 1 | 2 = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-survey-host-'))
  resources.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const calls: { method: string; path: string; authorization?: string; cookie?: string; body: unknown }[] = []
  let mode: 'fixture' | 'ineligible' | '503' | '429' | '404' | 'invalid' | 'redirect' | 'network' | 'held' | 'config-changed' = 'fixture'
  let state: object = schema === 2 ? configuredPending : pending
  let entered = Promise.withResolvers<ServerResponse>()
  let closed = Promise.withResolvers<undefined>()
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const text = Buffer.concat(chunks).toString('utf8')
      const body: unknown = text === '' ? undefined : JSON.parse(text)
      const path = request.url ?? ''
      calls.push({ method: request.method ?? 'GET', path, body,
        ...request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization },
        ...request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie } })
      if (path === '/harness/api/user/auth/logout') { response.end('{}'); return }
      if (mode === 'held') {
        response.once('close', () => { closed.resolve(undefined) })
        entered.resolve(response); return
      }
      if (mode === 'network') { response.destroy(); return }
      if (mode === 'redirect') { response.writeHead(302, { location: '/forbidden-redirect' }); response.end(); return }
      if (mode === '404' || mode === '429' || mode === '503') {
        response.writeHead(Number(mode), { 'retry-after': '3' }); response.end('private diagnostic'); return
      }
      response.setHeader('content-type', 'application/json')
      if (mode === 'invalid') { response.end(JSON.stringify({ success: true, data: {} })); return }
      if (mode === 'ineligible') { response.end(JSON.stringify(schema === 2 ? configuredIneligible : ineligible)); return }
      if (mode === 'config-changed' && request.method === 'POST') {
        response.writeHead(409); response.end(JSON.stringify(staleConfiguration)); return
      }
      if (path === '/harness/api/user/onboarding-survey/defer') state = schema === 2 ? configuredDeferred : deferred
      else if (path === '/harness/api/user/onboarding-survey' && request.method === 'POST') {
        if (state === submitted && text.includes('different')) {
          response.writeHead(409); response.end(JSON.stringify(conflict)); return
        }
        state = schema === 2 ? configuredSubmitted : submitted
      }
      response.end(JSON.stringify(state))
    })().catch(() => { response.destroy() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  resources.push(async () => { await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
  }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing questionnaire fixture receiver')
  const stateDir = join(directory, 'credits')
  await mkdir(stateDir)
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({ token: 'private-product-session', expiresAt: '9999-01-01T00:00:00.000Z',
    account: { id: '7', phone: 'fixture' }, upstream: { token: 'private-access-token', refresh: 'private-refresh-cookie',
      expiresAt: '9999-01-01T00:00:00.000Z' } }), { mode: 0o600 })
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, ["- name: 'fixture:credentials'", "- name: '@deepseek-ai/dsh-host-webserver'", '  config:',
    "    host: '127.0.0.1'", '    port: 0', "- name: '@deepseek-ai/dsh-client-connection'", "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'", "- name: '@deepseek-ai/dsh-credits-index'", '  config:', `    stateDir: '${stateDir}'`,
    `    newApiBaseUrl: 'http://127.0.0.1:${String(address.port)}/harness'`, '    timeoutMs: 1000', ''].join('\n'))
  const context = new Context()
  resources.push(async () => { await context.fiber.dispose() })
  context.baseUrl = pathToFileURL(directory).href + '/'
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
  const read = (signal?: AbortSignal) => fetch(base + '/credits/api/onboarding-survey', { headers: { cookie }, ...signal === undefined ? {} : { signal } })
  const post = (body: object, defer = false) => fetch(base + '/credits/api/onboarding-survey' + (defer ? '/defer' : ''), {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const hold = () => { mode = 'held'; entered = Promise.withResolvers<ServerResponse>(); closed = Promise.withResolvers<undefined>() }
  return { context, base, cookie, read, post, calls, hold,
    setMode: (value: typeof mode) => { mode = value }, setSurvey: (value: object) => { state = value },
    entered: () => entered.promise, closed: () => closed.promise }
}

it('binds current-user survey reads and explicit writes to the observed owner without changing the login', async () => {
  const f = await boot()
  expect((await fetch(f.base + '/credits/api/onboarding-survey')).status).toBe(401)
  expect((await fetch(f.base + '/credits/api/onboarding-survey', { method: 'PUT', headers: { cookie: f.cookie } })).status).toBe(405)
  expect(f.calls).toHaveLength(0)
  const first = await (await f.read()).json() as { accountOwner: string; payload: unknown }
  expect(first).toMatchObject({ account: { id: '7' }, payload: pending.data })
  expect(f.calls[0]).toMatchObject({ method: 'GET', path: '/harness/api/user/onboarding-survey?schema_version=2' })
  expect(first.accountOwner).toMatch(/^[a-f0-9]{64}$/u)
  const guard = { expected_account_id: '7', expected_account_owner: first.accountOwner }
  const identity = { schema_version: 1, survey_id: 'product-use-v1' }
  const before = f.calls.length
  expect(await (await f.post({ ...identity, ...guard, expected_account_id: 'another-user' })).json()).toMatchObject({ code: 'ACCOUNT_CHANGED' })
  expect(await (await f.post({ ...identity, ...guard, selected_option_ids: ['coding'], user_id: 'victim' })).json())
    .toMatchObject({ code: 'SURVEY_INVALID_REQUEST' })
  expect(await (await f.post({ ...identity, ...guard, selected_option_ids: [] })).json()).toMatchObject({ code: 'SURVEY_INVALID_REQUEST' })
  expect(f.calls).toHaveLength(before)
  expect(await (await f.post({ ...identity, ...guard }, true)).json()).toMatchObject({ payload: deferred.data })
  expect(f.calls.at(-1)?.body).toEqual(identity)
  const answer = { ...identity, selected_option_ids: ['coding', 'daily_qa'], notes: '  测试资料与办公\r\n第二行  ' }
  expect(await (await f.post({ ...answer, ...guard })).json()).toMatchObject({ payload: submitted.data })
  expect(f.calls.at(-1)?.body).toEqual({ ...identity, selected_option_ids: ['daily_qa', 'coding'], notes: submitted.data.notes })
  expect(await (await f.post({ ...answer, ...guard })).json()).toMatchObject({ payload: submitted.data })
  expect(await (await f.post({ ...answer, ...guard, notes: 'different' })).json()).toMatchObject({ code: 'SURVEY_ALREADY_SUBMITTED', httpStatus: 409 })
  expect(f.calls.every(call => call.path.startsWith('/harness/api/user/onboarding-survey')
    && call.authorization === 'Bearer private-access-token' && call.cookie === undefined)).toBe(true)
  f.setMode('ineligible')
  expect(await (await f.read()).json()).toMatchObject({ payload: ineligible.data })
  for (const [mode, code] of [['404', 'SURVEY_UNSUPPORTED'], ['503', 'SURVEY_UNAVAILABLE'], ['429', 'SURVEY_RATE_LIMITED'],
    ['invalid', 'SURVEY_INVALID_RESPONSE'], ['network', 'SURVEY_NETWORK_ERROR'], ['redirect', 'SURVEY_NETWORK_ERROR']] as const) {
    f.setMode(mode)
    const result: unknown = await (await f.read()).json()
    expect(result).toMatchObject({ ok: false, code })
    expect(JSON.stringify(result)).not.toMatch(/private|Bearer/u)
  }
  const session = await (await fetch(f.base + '/credits/api/session', { headers: { cookie: f.cookie } })).json() as { payload?: { signedIn?: boolean } }
  expect(session.payload?.signedIn).toBe(true)
  expect(f.calls.some(call => /forbidden-redirect|recharge|generations/u.test(call.path))).toBe(false)
})

it('carries configured IDs and revisions through the real Host without automatically replaying a stale answer', async () => {
  const f = await boot(2)
  const first = await (await f.read()).json() as { accountOwner: string; payload: unknown }
  expect(first).toMatchObject({ payload: configuredPending.data })
  expect(f.calls[0]?.path).toBe('/harness/api/user/onboarding-survey?schema_version=2')
  const guard = { expected_account_id: '7', expected_account_owner: first.accountOwner }
  const identity = { schema_version: 2, survey_id: 'product-use-v1' }
  const firstAnswer = { ...identity, config_revision: configuredPending.data.config_revision,
    selected_option_ids: ['code_debugging', 'daily_qa'], notes: '保留我的备注' }
  const beforeInvalid = f.calls.length
  expect(await (await f.post({ ...identity, ...guard, selected_option_ids: ['daily_qa'] })).json())
    .toMatchObject({ code: 'SURVEY_INVALID_REQUEST' })
  expect(f.calls).toHaveLength(beforeInvalid)
  f.setSurvey(changedPending)
  f.setMode('config-changed')
  const stale = await (await f.post({ ...firstAnswer, ...guard })).json() as object
  expect(stale).toMatchObject({ ok: false, code: 'SURVEY_CONFIG_CHANGED', httpStatus: 409 })
  expect(stale).not.toHaveProperty('payload')
  expect(f.calls).toHaveLength(beforeInvalid + 1)
  expect(f.calls.at(-1)?.body).toEqual(firstAnswer)
  expect(await (await f.read()).json()).toMatchObject({ payload: changedPending.data })
  expect(changedPending.data.options.map(option => option.id)).not.toContain('code_debugging')
  expect(changedPending.data.options.map(option => option.id)).toContain('custom_research')
  expect(changedPending.data.options.find(option => option.id === 'daily_qa')?.label)
    .not.toBe(configuredPending.data.options.find(option => option.id === 'daily_qa')?.label)
  f.setMode('fixture')
  const nextAnswer = { ...identity, config_revision: changedPending.data.config_revision,
    selected_option_ids: ['custom_research', 'daily_qa'], notes: '保留我的备注' }
  expect(await (await f.post({ ...nextAnswer, ...guard })).json()).toMatchObject({ payload: configuredSubmitted.data })
  expect(f.calls.at(-1)?.body).toEqual(nextAnswer)
  expect(await (await f.read()).json()).toMatchObject({ payload: configuredSubmitted.data })
  expect(configuredSubmitted.data.config_revision).not.toBe(configuredDeferred.data.config_revision)
  expect(configuredSubmitted.data.options.map(option => option.id)).toContain('daily_qa')
  expect(configuredDeferred.data.options.map(option => option.id)).not.toContain('daily_qa')
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(2)
  expect(f.calls.every(call => call.authorization === 'Bearer private-access-token' && call.cookie === undefined)).toBe(true)
})

it('keeps schema-two deferral revision-free and reads the actual legacy submitted snapshot', async () => {
  const f = await boot(2)
  const first = await (await f.read()).json() as { accountOwner: string }
  const identity = { schema_version: 2, survey_id: 'product-use-v1' }
  const guard = { expected_account_id: '7', expected_account_owner: first.accountOwner }
  expect(await (await f.post({ ...identity, ...guard }, true)).json()).toMatchObject({ payload: configuredDeferred.data })
  expect(f.calls.at(-1)?.body).toEqual(identity)
  f.setSurvey(legacySubmitted)
  expect(await (await f.read()).json()).toMatchObject({ payload: legacySubmitted.data })
  expect(legacySubmitted.data.selected_option_ids).toEqual(['coding'])
  expect(legacySubmitted.data.options).toHaveLength(9)
  f.setMode('ineligible')
  expect(await (await f.read()).json()).toMatchObject({ payload: configuredIneligible.data })
})

it('retains a complete configured sixty-four-choice response through both Host response bounds', async () => {
  const f = await boot(2)
  const data = { ...configuredPending.data, max_selections: 64,
    options: Array.from({ length: 64 }, (_unused, index) => ({ id: `a${String(index).padStart(47, '0')}`,
      label: '🌱'.repeat(80), label_en: '🌱'.repeat(160) })) }
  const response = { success: true, data }
  expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(64 * 1024)
  f.setSurvey(response)
  expect(await (await f.read()).json()).toMatchObject({ ok: true, payload: data })
  expect(f.calls).toHaveLength(1)
})

it('cancels survey reads on timeout, peer disconnect and plugin disposal without retrying a mutation', async () => {
  const f = await boot()
  f.hold()
  const timeout = f.read()
  await f.entered()
  expect(await (await timeout).json()).toMatchObject({ code: 'SURVEY_TIMEOUT' })
  await f.closed()
  f.hold()
  const abort = new AbortController()
  const disconnected = f.read(abort.signal)
  await f.entered(); abort.abort()
  await expect(disconnected).rejects.toThrow()
  await f.closed()
  f.hold()
  const disposing = f.read()
  await f.entered()
  const fiber = [...f.context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-credits-index')?.fiber
  expect(fiber).toBeDefined()
  await fiber?.dispose()
  expect(await (await disposing).json()).toMatchObject({ code: 'SURVEY_NETWORK_ERROR' })
  await f.closed()
  expect((await f.read()).status).toBe(404)
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
})

it('drops a late questionnaire response after logout rather than displaying another login\'s answers', async () => {
  const f = await boot()
  f.hold()
  const old = f.read()
  const held = await f.entered()
  await fetch(f.base + '/credits/api/session/logout', { method: 'POST', headers: { cookie: f.cookie, origin: f.base,
    'content-type': 'application/json' }, body: '{}' })
  held.end(JSON.stringify(submitted))
  expect(await (await old).json()).toMatchObject({ code: 'ACCOUNT_CHANGED' })
  expect(await (await f.read()).json()).toMatchObject({ code: 'SURVEY_AUTH_REQUIRED' })
})
