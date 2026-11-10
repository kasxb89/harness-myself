/** Overseas phone UI uses a separately supplied real Go fixture; the Session owner uses an explicit keyless text adapter. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  captureExpectedWorkspaceSnapshot, captureWorkspaceSnapshot, fixtureContext, formatSystemPromptSnapshot,
  formatToolSchemasSnapshot, latestPersistedSessionPaths, normalizeSessionSnapshots, normalizedSystemPrompts,
  normalizedToolSchemas, redactSessionSnapshotIds, scrubSessionSnapshot, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'
import { z } from 'zod'
import disabledBannerFeed from '../../../packages/host/credits-index/tests/fixtures/announcement-banner-api/feed-banner-disabled.json' with { type: 'json' }
import noSurvey from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api/not-eligible.json' with { type: 'json' }
import { startProfileWeb } from './profile-process.ts'
import { fixtureUserPrompts, normalizeWebSessionVolatiles, watchConsole, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

const DIRECTORY = fileURLToPath(new URL('../../../snapshots/web/overseas-phone-login', import.meta.url))
const FIXTURE = join(DIRECTORY, 'session.v4.jsonl')
const PROMPT = '你好'
const REPLY = '你好！国际手机号登录后的聊天已就绪。'
const PROVIDER = 'overseas-phone-keyless'
const MODEL = 'overseas-phone-hello'
const livePath = process.env.DSH_OVERSEAS_PHONE_UI_PRIVATE
const evidence = process.env.DSH_OVERSEAS_PHONE_EVIDENCE_DIRECTORY
const liveSchema = z.object({ base_url: z.url(), grants: z.array(z.object({
  country: z.enum(['MY', 'JP', 'US']), phone: z.string().regex(/^\+[1-9]\d{6,14}$/u), code: z.string().regex(/^(?:\d{6}|\d{16})$/u),
})).length(3) })
type Row = Record<string, unknown>
function object(value: unknown): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected object')
  return value as Row
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array')
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string')
  return value
}
function events(raw: string): Row[] { return raw.trimEnd().split('\n').map(line => object(JSON.parse(line))) }
async function storedSession(directory: string, id: string): Promise<string | undefined> {
  const paths = (await readdir(directory, { recursive: true })).map(path => join(directory, path))
  for (const path of latestPersistedSessionPaths(paths)) {
    const raw = await readFile(path, 'utf8')
    if (events(raw)[0]?.id === id) return raw
  }
  return undefined
}
async function saveForm(page: Page, label: string): Promise<void> {
  if (evidence === undefined) return
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.screenshot({ path: join(evidence, `${label}-${String(width)}.png`), animations: 'disabled',
      mask: [page.getByRole('textbox', { name: '验证码', exact: true }), page.getByRole('textbox', { name: '安全验证码或备用码', exact: true })] })
    await writeFile(join(evidence, `${label}-${String(width)}.aria.txt`), await page.getByRole('region', { name: '手机号登录', exact: true }).ariaSnapshot())
  }
  await page.setViewportSize({ width: 1280, height: 1000 })
}

it('records a real shipped-profile hello Session independently of private phone credentials', async (test) => {
  const mode = webSnapshotMode()
  if (mode === 'record') throw new Error('Use official refresh for this authored owner')
  if (!existsSync(FIXTURE) && mode !== 'refresh') throw new Error('First capture requires DSH_SNAPSHOT=refresh')
  const recorded = mode === 'refresh' ? undefined : await readFile(FIXTURE, 'utf8')
  const replay = recorded === undefined ? undefined : deriveReplayScript(parseSessionLog(recorded))
  if (recorded !== undefined) expect(fixtureUserPrompts(recorded)).toEqual([PROMPT])
  const live = livePath === undefined ? undefined : liveSchema.parse(JSON.parse(await readFile(livePath, 'utf8')))
  if (live !== undefined) {
    const url = new URL(live.base_url)
    expect(url.protocol).toBe('http:'); expect(url.hostname).toBe('127.0.0.1')
    expect(url.username + url.password + url.search + url.hash).toBe('')
    expect(new Set(live.grants.map(grant => grant.country))).toEqual(new Set(['MY', 'JP', 'US']))
  }
  const grants = live?.grants ?? [
    { country: 'MY', phone: '+60123450991', code: '0123456789012345' },
    { country: 'JP', phone: '+819012345991', code: '0123456789012345' },
    { country: 'US', phone: '+12025550191', code: '0123456789012345' },
  ]
  if (evidence !== undefined) await mkdir(evidence, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-overseas-phone-')))
  const workspace = join(root, 'workspace'), persistence = join(root, 'sessions'), credits = join(root, 'credits')
  await Promise.all([workspace, persistence].map(path => mkdir(path)))
  let stopHost: (() => Promise<void>) | undefined, closeBrowser: (() => Promise<void>) | undefined
  test.onTestFinished(async () => {
    try { await closeBrowser?.() }
    finally { try { await stopHost?.() } finally { await rm(root, { recursive: true, force: true }) } }
  })
  let textPosts = 0
  const errors: string[] = []
  const syntheticAuthPosts: { path: string; contractVersion: unknown }[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (live === undefined && path !== '/v1/chat/completions') {
        response.setHeader('content-type', 'application/json')
        const answer = (value: unknown): void => { response.end(JSON.stringify({ success: true, data: value })) }
        if (path === '/api/user/phone/challenge') {
          const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          expect(body.phone_e164).toBe(grants.at(-1)?.phone)
          expect(body.idempotency_key).toEqual(expect.any(String))
          syntheticAuthPosts.push({ path, contractVersion: body.contract_version })
          answer({ challenge_id: 'synthetic-overseas-challenge', delivery_status: 'accepted',
            expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
        }
        if (path === '/api/user/phone/login') {
          const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          expect(body.phone_e164).toBe(grants.at(-1)?.phone); expect(body.code).toBe('0123456789012345')
          expect(body.challenge_id).toBe('synthetic-overseas-challenge'); expect(body.contract_version).toBe(2)
          expect(body.idempotency_key).toEqual(expect.any(String))
          syntheticAuthPosts.push({ path, contractVersion: body.contract_version })
          response.setHeader('set-cookie', 'new_api_refresh=synthetic-overseas-refresh; HttpOnly; Path=/api/user/auth')
          answer({ access_token: 'synthetic-overseas-access', access_expires_at: Math.floor(Date.now() / 1000) + 3600,
            relay_key: 'sk-synthetic-overseas-relay', relay_key_id: 991, session: { sid: 'synthetic-overseas-session', current: true },
            user: { id: 991, username: 'synthetic-overseas-user', quota: 0 } }); return
        }
        if (path === '/api/user/self') { answer({ id: 991, username: 'synthetic-overseas-user', group: 'default', quota: 0 }); return }
        if (path === '/v1/models') { response.end(JSON.stringify({ object: 'list', data: [] })); return }
        if (path === '/api/pricing') { answer([]); return }
        if (path === '/api/status') { answer({}); return }
        if (path === '/api/client-announcements') { response.end(JSON.stringify(disabledBannerFeed)); return }
        if (path === '/api/user/onboarding-survey') { response.end(JSON.stringify(noSurvey)); return }
        if (path === '/api/client-activity/heartbeat') { answer({ heartbeat_interval_seconds: 60 }); return }
        if (path === '/api/client-activity/workload-snapshot') { answer({ accepted: true }); return }
        if (path === '/api/log/self') { answer({ page: 1, page_size: 100, total: 0, items: [] }); return }
        if (path === '/api/creation/content') {
          answer({ schemaVersion: 1, revision: 'overseas-keyless', image: { templates: [] }, video: { templates: [] }, guide: { title: '', body: '' } }); return
        }
      }
      if (path !== '/v1/chat/completions' || request.method !== 'POST') {
        response.statusCode = 404; response.end('{}'); return
      }
      textPosts++
      expect(textPosts).toBe(1)
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      expect(body.model).toBe(MODEL)
      const step = replay?.[0]
      if (step !== undefined && step.kind !== 'chunks') throw new Error('Expected recorded text step')
      const prose = step?.kind === 'chunks' ? step.chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text'
        ? [chunk.block.text] : []).join('') : REPLY
      response.setHeader('content-type', 'text/event-stream')
      response.end([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: prose }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}`,
        'data: [DONE]', ''].join('\n\n'))
    })().catch((error: unknown) => { errors.push(String(error)); response.destroy() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  test.onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      server.closeAllConnections()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected owned loopback text adapter')
  const textOrigin = `http://127.0.0.1:${String(address.port)}`
  const overlay = join(root, 'overseas.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: live?.base_url ?? textOrigin, baseUrl: '', bridgeBaseUrl: '', stateDir: credits } },
    { id: 'agent-default-model', config: { provider: PROVIDER, model: MODEL, followPolicy: false } },
    { id: 'llm-deepseek', disabled: true }, { id: 'llm-pi-ai', disabled: false },
    { id: 'session-persistence-jsonl', config: { root: persistence, compression: 'none' } },
    { id: 'session-title-llm', disabled: true }, { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'product-extensions', disabled: true }, { id: 'agent-instructions', disabled: true },
    { id: 'computer-use', disabled: true }, { id: 'computer-use-cua-driver-native', disabled: true },
  ]))
  const host = await startProfileWeb(root, workspace, overlay, { DSH_OVERSEAS_PHONE_TEXT_KEY: 'sk-keyless-overseas-text-only' },
    [join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')])
  stopHost = () => host.stop()
  const settings = object(await host.remote('settings/describe', {}))
  const namespace = array(settings.namespaces).map(object).find(row => row.ns === 'llm-pi-ai')
  if (namespace === undefined) throw new Error('Expected mutable provider settings')
  const providerProfiles = object(object(namespace.value).providers)
  await host.remote('settings/update', { ns: 'llm-pi-ai', patch: { providers: {
    ...providerProfiles, [PROVIDER]: { displayName: '海外登录独立回放文本', api: 'openai-completions', baseURL: `${textOrigin}/v1`,
      apiKeyEnv: 'DSH_OVERSEAS_PHONE_TEXT_KEY', models: [{ id: MODEL, name: MODEL, contextWindow: 131072, maxTokens: 512, input: ['text'] }] },
  } } })
  await host.remote('workspace/create', { request: { path: workspace } })
  const browser = await chromium.launch(); closeBrowser = () => browser.close()
  const context = await browser.newContext({ locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 1000 } })
  const delimiter = host.cookie.indexOf('=')
  await context.addCookies([{ name: host.cookie.slice(0, delimiter), value: host.cookie.slice(delimiter + 1), url: host.webUrl }])
  const page = await context.newPage(), consoleState = watchConsole(page)
  let activeSession: string | undefined, raw = ''
  let submitReady: Row | undefined, promptSubmissions = 0
  const promptResponses: { status: number; ok: unknown; code: unknown }[] = []
  const phoneResponses: { route: string; status: number; ok: unknown; code: unknown }[] = []
  page.on('response', (response) => {
    const route = new URL(response.url()).pathname
    if (route === '/api/session/prompt') {
      void response.json().then((value: unknown) => {
        const result = object(object(value).result)
        const failure = result.ok === false ? object(result.error) : undefined
        promptResponses.push({ status: response.status(), ok: result.ok, code: failure?.code })
      }).catch(() => {})
      return
    }
    if (!['/credits/api/session/challenge', '/credits/api/session/verify'].includes(route)) return
    void response.json().then((value: unknown) => {
      const body = object(value)
      phoneResponses.push({ route, status: response.status(), ok: body.ok, code: body.code })
    }).catch(() => {})
  })
  const phonePosts: { route: string; phoneHash?: string; keyHash: string }[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path === '/api/session/prompt') {
      promptSubmissions++
      const payload = object(object(object(request.postDataJSON()).payload).args)
      activeSession = text(object(payload.request).sessionId)
    }
    if (!['/credits/api/session/challenge', '/credits/api/session/verify'].includes(path) || request.method() !== 'POST') return
    const body = object(request.postDataJSON())
    phonePosts.push({ route: path, ...typeof body.phone === 'string' ? { phoneHash: createHash('sha256').update(body.phone).digest('hex') } : {},
      keyHash: createHash('sha256').update(text(body.idempotencyKey)).digest('hex') })
  })
  try {
    await page.goto(host.webUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.locator('[data-composer-input]').last().waitFor()
    {
      await page.getByRole('button', { name: '余额', exact: true }).click()
      const form = page.getByRole('region', { name: '手机号登录', exact: true })
      await form.waitFor()
      const country = form.getByRole('combobox', { name: '国际区号', exact: true })
      expect(await country.inputValue()).toBe('+86')
      await country.selectOption('+60')
      await form.getByRole('textbox', { name: '手机号', exact: true }).fill('0123')
      expect(await form.getByRole('button', { name: '准备登录', exact: true }).isDisabled()).toBe(true)
      expect(phonePosts).toEqual([])
      for (const grant of grants) {
        const prefix = grant.country === 'MY' ? '+60' : grant.country === 'JP' ? '+81' : '+1'
        await country.selectOption(prefix)
        await form.getByRole('textbox', { name: '手机号', exact: true }).fill(grant.phone)
        expect(await country.inputValue()).toBe(prefix)
        expect(phonePosts).toEqual([])
        await saveForm(page, `selected-${grant.country}`)
      }
      const finalGrant = grants.at(-1)
      if (finalGrant === undefined) throw new Error('Expected final independent manual grant')
      await form.getByRole('button', { name: '准备登录', exact: true }).click()
      await form.getByRole('status').filter({ hasText: '登录请求已就绪，请输入已有登录码；首次使用请联系运营微信领取固定码' }).waitFor()
      expect(await form.getByText('验证码已发送', { exact: true }).count()).toBe(0)
      expect(phonePosts.filter(post => post.route.endsWith('/challenge'))).toHaveLength(1)
      await saveForm(page, 'accepted-US')
      await form.getByRole('textbox', { name: '验证码', exact: true }).fill(finalGrant.code)
      await form.getByRole('button', { name: '登录', exact: true }).click()
      await expect.poll(async () => {
        const response = await fetch(new URL('/credits/api/session', host.webUrl), { headers: { cookie: host.cookie } })
        return object(object(await response.json()).payload).signedIn
      }, { timeout: 15000 }).toBe(true)
      const saved = object(JSON.parse(await readFile(join(credits, 'session.json'), 'utf8')))
      expect(text(object(saved.upstream).token).length).toBeGreaterThan(0)
      expect(text(object(saved.upstream).refresh).length).toBeGreaterThan(0)
      expect(phonePosts.filter(post => post.route.endsWith('/verify'))).toHaveLength(1)
      await expect.poll(() => form.count(), { timeout: 10000 }).toBe(0)
      await page.getByRole('button', { name: '聊天', exact: true }).click()
    }
    // Account sign-in may publish adapters; use the same public catalog as the model selector before submitting.
    const catalog = object(await host.remote('session/modelCatalog', {}))
    const providerGroup = array(catalog.groups).map(object).find(group => group.id === PROVIDER)
    expect(array(catalog.routableProviders)).toContain(PROVIDER)
    expect(catalog.default).toMatchObject({ provider: PROVIDER, model: MODEL })
    if (providerGroup === undefined) throw new Error('The independent keyless provider is not ready after sign-in')
    expect(array(providerGroup.models).map(object).map(model => model.id)).toContain(MODEL)
    submitReady = { provider: providerGroup.id, model: MODEL, default: catalog.default, routable: true }
    if (evidence !== undefined) await writeFile(join(evidence, 'submit-ready.json'), JSON.stringify(submitReady, null, 2) + '\n')
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill(recorded === undefined ? PROMPT : fixtureUserPrompts(recorded)[0]!)
    const send = page.getByRole('button', { name: '发送消息', exact: true })
    expect(await send.isEnabled()).toBe(true)
    await send.click()
    await expect.poll(async () => {
      if (activeSession === undefined) return false
      const saved = await storedSession(persistence, activeSession)
      if (saved !== undefined) raw = saved
      return saved !== undefined && events(saved).some(row => row.type === 'turn/end')
    }, { timeout: 30000 }).toBe(true)
    expect(textPosts).toBe(1); expect(errors).toEqual([]); expect(consoleState.pageErrors).toEqual([])
    expect(promptSubmissions).toBe(1)
    expect(promptResponses).toHaveLength(1)
    expect(promptResponses[0]).toMatchObject({ status: 200, ok: true })
    if (live === undefined) expect(syntheticAuthPosts).toEqual([
      { path: '/api/user/phone/challenge', contractVersion: 2 },
      { path: '/api/user/phone/login', contractVersion: 2 },
    ])
    if (activeSession === undefined) throw new Error('Expected actual persisted Session')
    const secretValues = grants.map(grant => grant.code)
    const visit = (value: unknown): void => {
      if (typeof value === 'string') expect(secretValues.includes(value)).toBe(false)
      else if (Array.isArray(value)) for (const item of value) visit(item)
      else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) visit(item)
    }
    for (const event of events(raw)) visit(event)
    await browser.close(); closeBrowser = undefined
    await host.stop(); stopHost = undefined
    expect(await captureWorkspaceSnapshot(workspace)).toEqual(await captureExpectedWorkspaceSnapshot(join(DIRECTORY, 'workspace.expected')))
    const normalized = normalizeWebSessionVolatiles(raw)
    const snapshotContext = { sessionIds: [activeSession], cwd: workspace }
    const prompts = normalizedSystemPrompts(normalized, snapshotContext)
      .map(value => value.split(REPO_ROOT).join('{{sourceRoot}}').split(host.webUrl).join('{{webUrl}}'))
    const schemas = normalizedToolSchemas(normalized, snapshotContext)
    const promptSidecar = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
    const schemaSidecar = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
    if (mode === 'refresh') {
      await writeFile(FIXTURE, redactSessionSnapshotIds([scrubSessionSnapshot(tokenizeSessionFixtureCwd(normalized))])[0]!)
      await writeFile(join(DIRECTORY, 'system-prompt.expected.md'), promptSidecar)
      await writeFile(join(DIRECTORY, 'tool-schemas.expected.json'), schemaSidecar)
    }
    const expected = await readFile(FIXTURE, 'utf8')
    expect(normalizeSessionSnapshots([normalized], snapshotContext)[0])
      .toBe(normalizeSessionSnapshots([expected], fixtureContext(expected))[0])
    expect(promptSidecar).toBe(await readFile(join(DIRECTORY, 'system-prompt.expected.md'), 'utf8'))
    expect(schemaSidecar).toBe(await readFile(join(DIRECTORY, 'tool-schemas.expected.json'), 'utf8'))
    if (evidence !== undefined) await writeFile(join(evidence, 'result.json'), JSON.stringify({
      mode, realGoPhoneAuthentication: live !== undefined, countries: grants.map(grant => grant.country),
      authTransport: live === undefined ? 'explicit synthetic Node HTTP DTO; not Go reexecution' : 'actual isolated Go HTTP',
      syntheticAuthPosts, phonePosts, phoneResponses, promptResponses, promptSubmissions, submitReady, textPosts,
      textProvider: 'independent keyless Node SSE; not Go model execution',
      productionAccess: false, paidCalls: 0, workspaceComplete: true,
      sessionSha: createHash('sha256').update(expected).digest('hex'),
    }, null, 2) + '\n')
  } catch (error) {
    if (evidence !== undefined) {
      // Output is private: Host diagnostics can contain account credentials after a failed exchange.
      await writeFile(join(evidence, 'host-private.log'), host.output(), { mode: 0o600 })
      await writeFile(join(evidence, 'failure-counters.json'), JSON.stringify({
        textPosts, phonePosts, phoneResponses, promptResponses, promptSubmissions, submitReady, errors,
      }, null, 2) + '\n')
      if (!page.isClosed()) await page.screenshot({ path: join(evidence, 'failure.png'),
        mask: [page.getByRole('textbox', { name: '验证码', exact: true }), page.getByRole('textbox', { name: '安全验证码或备用码', exact: true })] })
    }
    throw error
  }
})
