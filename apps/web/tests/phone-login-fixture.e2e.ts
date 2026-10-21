/** Real phone controllers and the built sign-in form share an isolated, explicitly supplied loopback fixture. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Request } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const receiptPath = process.env.DSH_PHONE_FIXTURE_RECEIPT
const receiptSchema = z.object({
  status: z.literal('ready'), base_url: z.url(), expires_at: z.iso.datetime(),
  production_access: z.literal(false), outbound_http: z.literal('blocked'),
  synthetic_code: z.string().regex(/^\d{6}$/), mfa_backup_code: z.string(),
  phones: z.record(z.string(), z.string()),
})
const phoneStatusSchema = z.object({
  mode: z.string(), fake_dispatches: z.number(), sessions: z.number(), relay_tokens: z.number(),
})
const statusSchema = z.object({
  status: z.literal('ready'), outbound_http: z.literal('blocked'), phone_posts: z.number(),
  dropped_success_after_commit: z.boolean(), phones: z.record(z.string(), phoneStatusSchema),
})
const recoverySchema = z.object({ payload: z.object({
  phone: z.string(), challengeId: z.string(), exchangeKey: z.string(),
}) })
const sessionSchema = z.object({ payload: z.object({ signedIn: z.boolean() }) })
const storedSessionSchema = z.object({ upstream: z.object({ token: z.string().min(1), refresh: z.string().min(1) }) })
const postSchema = z.object({ idempotencyKey: z.string().min(32) })
type Fixture = z.infer<typeof receiptSchema>
type Status = z.infer<typeof statusSchema>

describe.skipIf(receiptPath === undefined)('web e2e: real isolated phone controller recovery', () => {
  let fixture: Fixture
  let evidence: string
  let home: string
  let overlay: string
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let consoleState: ReturnType<typeof watchConsole>
  const posts: { route: string; key: string }[] = []
  const blockedExternalRequests: string[] = []
  const results: Record<string, unknown> = {}

  async function status(): Promise<Status> {
    const response = await fetch(`${fixture.base_url}/__fixture/status`, { signal: AbortSignal.timeout(4_000) })
    expect(response.ok).toBe(true)
    return statusSchema.parse(await response.json())
  }

  async function openClient(): Promise<void> {
    scaffold = await launchWebScaffold({ harnessHome: home, extraOverlayPath: overlay })
    if (browser === undefined) browser = await chromium.launch()
    page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
    consoleState = watchConsole(page)
    const origin = new URL(scaffold.baseUrl).origin
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) {
        blockedExternalRequests.push(url.origin)
        await route.abort('blockedbyclient')
        return
      }
      await route.continue()
    })
    page.on('request', (request: Request) => {
      const route = new URL(request.url()).pathname
      if (request.method() !== 'POST' || !['/credits/api/session/challenge', '/credits/api/session/verify'].includes(route)) return
      const body: unknown = request.postDataJSON()
      posts.push({ route, key: postSchema.parse(body).idempotencyKey })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '余额', exact: true }).click()
    await page.getByRole('region', { name: '手机号登录', exact: true }).waitFor()
  }

  async function send(phone: string): Promise<void> {
    expect(fixture.phones[phone]).toBeDefined()
    await page.getByRole('textbox', { name: '手机号', exact: true }).fill(phone.slice(3))
    await page.getByRole('button', { name: '发送验证码', exact: true }).click()
  }

  async function login(): Promise<void> {
    await page.getByRole('textbox', { name: '验证码', exact: true }).fill(fixture.synthetic_code)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }

  async function expectSignedIn(): Promise<void> {
    const active = scaffold
    if (active === undefined) throw new Error('Phone fixture Host is not running')
    await expect.poll(async () => sessionSchema.parse(await (await active.hostFetch('/credits/api/session')).json())
      .payload.signedIn).toBe(true)
    const stored: unknown = JSON.parse(await readFile(join(home, 'credits', 'session.json'), 'utf8'))
    expect(storedSessionSchema.safeParse(stored).success).toBe(true)
    await expect.poll(() => page.getByRole('region', { name: '手机号登录', exact: true }).count()).toBe(0)
  }

  beforeAll(async () => {
    fixture = receiptSchema.parse(JSON.parse(await readFile(receiptPath!, 'utf8')))
    const url = new URL(fixture.base_url)
    expect(url.protocol).toBe('http:')
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.pathname).toBe('/harness')
    expect(url.username + url.password + url.search + url.hash).toBe('')
    expect(Date.parse(fixture.expires_at) > Date.now()).toBe(true)
    await status()
    const root = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
    await mkdir(root, { recursive: true })
    evidence = await mkdtemp(join(root, 'phone-login-fixture-'))
  })

  beforeEach(async () => {
    posts.length = 0
    blockedExternalRequests.length = 0
    home = await mkdtemp(join(tmpdir(), 'dsh-phone-fixture-'))
    overlay = join(home, 'phone.patch.yml')
    await writeFile(overlay, [
      '- id: credits-index', '  config:', `    newApiBaseUrl: ${JSON.stringify(fixture.base_url)}`,
      `    stateDir: ${JSON.stringify(join(home, 'credits'))}`,
      '- id: ui-creative', '  disabled: true', '- id: dsh-market', '  disabled: true',
      '- id: dsh-skin-market', '  disabled: true', '',
    ].join('\n'))
    await openClient()
  })

  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && page !== undefined && !page.isClosed()) {
        const prefix = task.name.slice(0, 40)
        await page.screenshot({ path: join(evidence, `${prefix}-failure.png`), animations: 'disabled' })
        await writeFile(join(evidence, `${prefix}-failure.json`), JSON.stringify({
          visible: await page.locator('body').innerText(), pageErrors: consoleState.pageErrors,
          posts: posts.map(post => ({ route: post.route })), blockedExternalRequests,
        }, null, 2) + '\n')
      }
      expect(blockedExternalRequests).toEqual([])
    }
    finally {
      try { await browser?.close() }
      finally {
        browser = undefined
        try { await scaffold?.close() }
        finally {
          scaffold = undefined
          if (home !== undefined) await rm(home, { recursive: true, force: true })
        }
      }
    }
  })

  afterAll(async () => {
    if (evidence === undefined) return
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ fixture: fixture.base_url,
      productionAccess: false, outboundHTTP: 'blocked', realController: true, realBuiltHostAndClient: true,
      ...results }, null, 2) + '\n')
    console.info(`Phone login fixture evidence: ${evidence}`)
  })

  it('keeps explicit resend available after a definite SMS failure without inventing a cooldown', async () => {
    const phone = '+8613800000101'
    expect((await status()).phones[phone]).toMatchObject({ fake_dispatches: 0, sessions: 0 })
    await send(phone)
    await page.getByRole('alert').filter({ hasText: '短信服务暂不可用，本次未发送。' }).waitFor()
    expect(await page.getByRole('button', { name: '发送验证码', exact: true }).isEnabled()).toBe(true)
    expect(await page.getByRole('button', { name: /后可重发/u }).count()).toBe(0)
    expect(posts.filter(post => post.route.endsWith('/challenge'))).toHaveLength(1)
    const observed = (await status()).phones[phone]
    expect(observed).toMatchObject({ fake_dispatches: 1, sessions: 0 })
    expect(consoleState.pageErrors).toEqual([])
    await page.screenshot({ path: join(evidence, 'not-sent.png'), animations: 'disabled' })
    results.notSent = { ...observed, explicitResendEnabled: true, clientCooldownInvented: false }
  })

  it('accepts a received code after unknown SMS delivery without resending', async () => {
    const phone = '+8613800000102'
    expect((await status()).phones[phone]).toMatchObject({ fake_dispatches: 0, sessions: 0 })
    await send(phone)
    await page.getByRole('alert').filter({ hasText: '短信发送结果尚未确认' }).waitFor()
    expect(await page.getByRole('textbox', { name: '验证码', exact: true }).isEnabled()).toBe(true)
    await page.screenshot({ path: join(evidence, 'unknown-delivery.png'), animations: 'disabled' })
    await login()
    await expectSignedIn()
    const observed = (await status()).phones[phone]
    expect(observed).toMatchObject({ fake_dispatches: 1, sessions: 1, relay_tokens: 1 })
    expect(posts.filter(post => post.route.endsWith('/challenge'))).toHaveLength(1)
    expect(consoleState.pageErrors).toEqual([])
    results.unknownDelivery = { ...observed, receivedCodeAccepted: true, smsResent: false }
  })

  it('recovers a committed login after response loss and Host restart using the original exchange key', async () => {
    const phone = '+8613800000103'
    expect((await status()).phones[phone]).toMatchObject({ fake_dispatches: 0, sessions: 0 })
    await send(phone)
    await page.getByRole('status').filter({ hasText: '验证码已发送' }).waitFor()
    await login()
    await page.getByRole('alert').filter({ hasText: '登录服务暂不可用或结果未确认' }).waitFor()
    const committed = await status()
    expect(committed.dropped_success_after_commit).toBe(true)
    expect(committed.phones[phone]).toMatchObject({ fake_dispatches: 1, sessions: 1, relay_tokens: 1 })
    const verifyPosts = (): typeof posts => posts.filter(post => post.route.endsWith('/verify'))
    expect(verifyPosts()).toHaveLength(1)
    const originalKey = verifyPosts()[0]!.key
    const active = scaffold
    if (active === undefined) throw new Error('Phone fixture Host is not running')
    const recovery = recoverySchema.parse(await (await active.hostFetch('/credits/api/session/phone-recovery')).json())
    expect(recovery.payload.phone).toBe(phone)
    expect(recovery.payload.exchangeKey).toBe(originalKey)
    const statePath = join(home, 'credits', `phone-auth-${createHash('sha256').update(fixture.base_url).digest('hex')}.json`)
    expect((await readFile(statePath, 'utf8')).includes(JSON.stringify(fixture.synthetic_code))).toBe(false)
    await page.screenshot({ path: join(evidence, 'lost-success.png'), animations: 'disabled' })
    expect(consoleState.pageErrors).toEqual([])
    await page.close()
    await active.close()
    scaffold = undefined
    await openClient()
    expect(await page.getByRole('textbox', { name: '手机号', exact: true }).inputValue()).toBe(phone.slice(3))
    expect(await page.getByRole('textbox', { name: '验证码', exact: true }).inputValue()).toBe('')
    expect((await status()).phone_posts).toBe(committed.phone_posts)
    expect(verifyPosts()).toHaveLength(1)
    await login()
    await expectSignedIn()
    expect(verifyPosts()).toHaveLength(2)
    expect(verifyPosts()[1]!.key).toBe(originalKey)
    expect(posts.filter(post => post.route.endsWith('/challenge'))).toHaveLength(1)
    const observed = (await status()).phones[phone]
    expect(observed).toMatchObject({ fake_dispatches: 1, sessions: 1, relay_tokens: 1 })
    expect(consoleState.pageErrors).toEqual([])
    await page.screenshot({ path: join(evidence, 'recovered-success.png'), animations: 'disabled' })
    results.lostSuccess = { ...observed, hostRestarted: true, originalExchangeKeyReused: true,
      recoveryAutomaticallyPosted: false, otpPersisted: false, completeBundleAndRefreshSaved: true }
  })

  it('completes only the declared MFA backup-code check before saving the login bundle', async () => {
    const phone = '+8613800000104'
    expect((await status()).phones[phone]).toMatchObject({ fake_dispatches: 0, sessions: 0 })
    await send(phone)
    await page.getByRole('status').filter({ hasText: '验证码已发送' }).waitFor()
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/credits/api/session/verify')
    await login()
    const verification: unknown = await (await pending).json()
    expect(verification).toMatchObject({ ok: false, code: 'PHONE_LOGIN_VERIFICATION_REQUIRED',
      payload: { verification: { methods: ['2fa'] } } })
    const security = page.getByRole('textbox', { name: '安全验证码或备用码', exact: true })
    await security.waitFor()
    const active = scaffold
    if (active === undefined) throw new Error('Phone fixture Host is not running')
    expect(sessionSchema.parse(await (await active.hostFetch('/credits/api/session')).json()).payload.signedIn).toBe(false)
    await page.screenshot({ path: join(evidence, 'mfa-required.png'), animations: 'disabled' })
    await security.fill(fixture.mfa_backup_code)
    await page.getByRole('button', { name: '完成安全验证', exact: true }).click()
    await expectSignedIn()
    const observed = (await status()).phones[phone]
    expect(observed).toMatchObject({ fake_dispatches: 1, sessions: 1, relay_tokens: 1 })
    expect(consoleState.pageErrors).toEqual([])
    results.mfa = { ...observed, intermediateSignedIn: false, backupCodeAccepted: true }
  })
})
