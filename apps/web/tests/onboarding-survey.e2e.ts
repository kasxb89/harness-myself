/** Real phone and survey Host paths share actual authenticated API response fixtures. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import pending from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api/pending.json' with { type: 'json' }
import deferred from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api/deferred.json' with { type: 'json' }
import submitted from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api/submitted.json' with { type: 'json' }
import notEligible from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api/not-eligible.json' with { type: 'json' }
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('offers only a newly enrolled phone user a dismissible survey, submits choices once and keeps old users unaffected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-registration-survey-browser-'))
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void>; upstream?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() } finally {
      try { await cleanup.scaffold?.() } finally {
        try { await cleanup.upstream?.() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const requests: { method: string; path: string; account: number }[] = []
  const answers: unknown[] = [], forbidden: string[] = []
  let account = 0, phoneLogins = 0, defers = 0
  let state: 'pending' | 'deferred' | 'submitted' = 'pending'
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      requests.push({ method: request.method ?? 'GET', path, account })
      response.setHeader('content-type', 'application/json')
      const answer = (data: unknown): void => { response.end(JSON.stringify({ success: true, data })) }
      if (path === '/harness/api/status') { answer({ quota_per_unit: 500_000, usd_exchange_rate: 6.7138 }); return }
      if (path === '/harness/v1/models') { response.end(JSON.stringify({ data: [], object: 'list' })); return }
      if (path === '/harness/api/pricing') { answer([]); return }
      if (path === '/harness/api/user/phone/challenge') {
        answer({ challenge_id: 'synthetic-survey-challenge', delivery_status: 'accepted',
          expires_at: Math.floor(Date.now() / 1000) + 300, resend_after_seconds: 60, expires_in_minutes: 5 }); return
      }
      if (path === '/harness/api/user/phone/login') {
        phoneLogins++
        account = phoneLogins === 1 ? 7 : 8
        response.setHeader('set-cookie', 'new_api_refresh=synthetic-survey-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: `synthetic-survey-access-${String(account)}`, access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: `sk-synthetic-survey-relay-${String(account)}`, relay_key_id: account,
          user: { id: account, username: `survey-fixture-${String(account)}`, group: 'product', quota: 500_000 } }); return
      }
      if (path === '/harness/api/user/self') {
        answer({ id: account, username: `survey-fixture-${String(account)}`, group: 'product', quota: 500_000, used_quota: 0 }); return
      }
      if (path === '/harness/api/user/onboarding-survey' && request.method === 'GET') {
        response.end(JSON.stringify(account !== 7 ? notEligible : state === 'pending' ? pending : state === 'deferred' ? deferred : submitted)); return
      }
      if (path === '/harness/api/user/onboarding-survey/defer' && request.method === 'POST') {
        defers++
        if (state !== 'submitted') state = 'deferred'
        response.end(JSON.stringify(state === 'submitted' ? submitted : deferred)); return
      }
      if (path === '/harness/api/user/onboarding-survey' && request.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        answers.push(body)
        state = 'submitted'
        response.end(JSON.stringify(submitted)); return
      }
      if (path === '/harness/api/user/auth/logout') { answer(null); return }
      if (path === '/harness/api/client-activity/heartbeat') {
        answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 60 }); return
      }
      if (path === '/harness/api/log/self') { answer({ total: 0, items: [] }); return }
      if (/recharge|payment|chat\/completions|images\/generations|videos|audio\/speech/u.test(path)) forbidden.push(path)
      response.statusCode = 404
      response.end(JSON.stringify({ success: false }))
    })().catch(() => { response.destroy() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.upstream = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Survey fixture must bind loopback')
  const overlay = join(root, 'survey.patch.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: `http://127.0.0.1:${String(address.port)}/harness`,
      baseUrl: '', bridgeBaseUrl: '', stateDir: join(root, 'credits') } },
    ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  cleanup.scaffold = () => scaffold.close()
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
  const tripwire = watchConsole(page)
  const evidenceBase = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceBase, { recursive: true })
  const evidence = await mkdtemp(join(evidenceBase, 'onboarding-survey-'))
  const dialog = page.getByRole('dialog', { name: '你准备用云枢做什么？', exact: true })
  const login = async (phone: string): Promise<void> => {
    await page.getByRole('button', { name: '余额', exact: true }).click()
    await page.getByRole('textbox', { name: '手机号', exact: true }).fill(phone)
    await page.getByRole('button', { name: '发送验证码', exact: true }).click()
    await page.getByRole('textbox', { name: '验证码', exact: true }).fill('123456')
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await login('13800001111')
  await dialog.waitFor({ timeout: 15_000 })
  expect(await dialog.getByRole('checkbox').count()).toBe(9)
  expect(await dialog.getByRole('button', { name: '提交问卷', exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('checkbox', { name: '日常问答', exact: true }).check()
  await dialog.getByRole('checkbox', { name: '编程开发', exact: true }).check()
  await dialog.getByRole('textbox', { name: '补充说明（选填）', exact: true }).fill(submitted.data.notes)
  await page.screenshot({ path: join(evidence, 'new-phone-light.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: '稍后填写', exact: true }).last().click()
  await dialog.waitFor({ state: 'hidden' })
  await expect.poll(() => defers).toBe(1)
  const afterDefer = page.waitForResponse(response => new URL(response.url()).pathname === '/credits/api/onboarding-survey')
  await page.reload({ waitUntil: 'load' })
  await afterDefer
  expect(await dialog.count()).toBe(0)
  await page.getByRole('button', { name: '余额', exact: true }).click()
  await page.getByRole('button', { name: '填写使用场景问卷', exact: true }).click()
  await dialog.waitFor()
  await dialog.getByRole('checkbox', { name: '日常问答', exact: true }).check()
  await dialog.getByRole('checkbox', { name: '编程开发', exact: true }).check()
  await dialog.getByRole('textbox', { name: '补充说明（选填）', exact: true }).fill(submitted.data.notes)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(evidence, 'deferred-manual-dark.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 580, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(evidence, 'survey-narrow.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: '提交问卷', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  expect(answers).toEqual([{ schema_version: 1, survey_id: 'product-use-v1',
    selected_option_ids: submitted.data.selected_option_ids, notes: submitted.data.notes }])
  const afterSubmit = page.waitForResponse(response => new URL(response.url()).pathname === '/credits/api/onboarding-survey')
  await page.reload({ waitUntil: 'load' })
  await afterSubmit
  expect(await dialog.count()).toBe(0)
  await page.getByRole('button', { name: '余额', exact: true }).click()
  expect(await page.getByRole('button', { name: '填写使用场景问卷', exact: true }).count()).toBe(0)
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('region', { name: '手机号登录', exact: true }).waitFor()
  const oldUserRead = page.waitForResponse(response => new URL(response.url()).pathname === '/credits/api/onboarding-survey')
  await login('13800002222')
  await oldUserRead
  expect(await dialog.count()).toBe(0)
  expect(answers).toHaveLength(1)
  expect(phoneLogins).toBe(2)
  expect(forbidden).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify({ realBuiltHostAndClient: true,
    apiResponses: 'Authenticated API HTTP fixtures, served by a loopback external-service double',
    requests, answers, phoneLogins, defers, forbidden, pageErrors: tripwire.pageErrors,
  }, null, 2) + '\n')
}, 120_000)
