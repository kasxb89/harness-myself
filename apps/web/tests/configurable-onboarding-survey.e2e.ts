/** Real phone and survey Host paths share actual authenticated API response fixtures. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import pending from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api-v2/pending.json' with { type: 'json' }
import changed from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api-v2/config-changed-pending.json' with { type: 'json' }
import stale from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api-v2/stale-config.json' with { type: 'json' }
import submitted from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api-v2/submitted.json' with { type: 'json' }
import notEligible from '../../../packages/host/credits-index/tests/fixtures/onboarding-survey-api-v2/not-eligible.json' with { type: 'json' }
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('renders the configurable questionnaire through real Host routes and reconciles an admin change without losing drafts or repeating submissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-configurable-survey-browser-'))
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void>; upstream?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() } finally {
      try { await cleanup.scaffold?.() } finally {
        try { await cleanup.upstream?.() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const boundaryPending = { ...pending, data: { ...pending.data, config_revision: 'f'.repeat(64),
    options: pending.data.options.map(option => option.id === 'other'
      ? { ...option, label: 'A'.repeat(80), label_en: 'W'.repeat(160) } : option) } }
  const requests: { method: string; path: string; account: number }[] = []
  const answers: unknown[] = [], forbidden: string[] = []
  let account = 0, phoneLogins = 0, changedConfiguration = false
  let state: 'pending' | 'submitted' = 'pending'
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
        account = phoneLogins === 1 ? 7 : phoneLogins === 2 ? 8 : 9
        response.setHeader('set-cookie', 'new_api_refresh=synthetic-survey-refresh; HttpOnly; Path=/harness/api/user/auth')
        answer({ access_token: `synthetic-survey-access-${String(account)}`, access_expires_at: Math.floor(Date.now() / 1000) + 900,
          relay_key: `sk-synthetic-survey-relay-${String(account)}`, relay_key_id: account,
          user: { id: account, username: `survey-fixture-${String(account)}`, group: 'product', quota: 500_000 } }); return
      }
      if (path === '/harness/api/user/self') {
        answer({ id: account, username: `survey-fixture-${String(account)}`, group: 'product', quota: 500_000, used_quota: 0 }); return
      }
      if (path === '/harness/api/user/onboarding-survey' && request.method === 'GET') {
        response.end(JSON.stringify(account === 9 ? boundaryPending : account !== 7 ? notEligible : state === 'submitted' ? submitted : changedConfiguration ? changed : pending)); return
      }
      if (path === '/harness/api/user/onboarding-survey' && request.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        answers.push(body)
        if (!changedConfiguration) {
          changedConfiguration = true
          response.statusCode = 409
          response.end(JSON.stringify(stale)); return
        }
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
  const evidence = await mkdtemp(join(evidenceBase, 'configurable-onboarding-survey-'))
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
  expect(await dialog.getByText('勾选常用场景，帮助您更好使用产品；也可以稍后填写', { exact: true }).count()).toBe(1)
  expect(await dialog.getByRole('checkbox').count()).toBe(pending.data.options.length)
  expect(await dialog.getByRole('button', { name: '提交问卷', exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('checkbox', { name: '日常问答', exact: true }).check()
  await dialog.getByRole('checkbox', { name: '代码排错', exact: true }).check()
  await dialog.getByRole('textbox', { name: '补充说明（选填）', exact: true }).fill(submitted.data.notes)
  await page.screenshot({ path: join(evidence, 'new-phone-light.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: '提交问卷', exact: true }).click()
  await dialog.getByText('使用场景已更新，请核对保留的选择和备注后重新提交', { exact: true }).waitFor()
  expect(answers).toHaveLength(1)
  const reviewSubmit = dialog.getByRole('button', { name: '核对后提交', exact: true })
  expect(await reviewSubmit.isDisabled()).toBe(true)
  expect(await dialog.getByRole('textbox', { name: '补充说明（选填）', exact: true }).inputValue()).toBe(submitted.data.notes)
  expect(await dialog.getByRole('checkbox', { name: '日常交流与问答', exact: true }).isChecked()).toBe(true)
  expect(await dialog.getByRole('checkbox', { name: '代码排错', exact: true }).isChecked()).toBe(true)
  await page.screenshot({ path: join(evidence, 'configuration-change-draft.png'), animations: 'disabled' })
  await dialog.getByRole('checkbox', { name: '代码排错', exact: true }).click()
  await expect.poll(() => dialog.getByRole('checkbox', { name: '代码排错', exact: true }).count()).toBe(0)
  await dialog.getByRole('checkbox', { name: '专属资料整理', exact: true }).check()
  expect(await reviewSubmit.isEnabled()).toBe(true)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(evidence, 'configured-options-dark.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 580, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(evidence, 'survey-narrow.png'), animations: 'disabled' })
  expect(answers).toHaveLength(1)
  await reviewSubmit.click()
  await dialog.waitFor({ state: 'hidden' })
  expect(answers).toEqual([{ schema_version: 2, survey_id: 'product-use-v1', config_revision: pending.data.config_revision,
    selected_option_ids: ['daily_qa', 'code_debugging'], notes: submitted.data.notes },
  { schema_version: 2, survey_id: 'product-use-v1', config_revision: changed.data.config_revision,
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
  expect(answers).toHaveLength(2)
  expect(phoneLogins).toBe(2)
  // Start the independent label-boundary check from a fresh wallet view.
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: '余额', exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('region', { name: '手机号登录', exact: true }).waitFor()
  await login('13800003333')
  await dialog.waitFor()
  const longChoice = dialog.getByRole('checkbox', { name: 'A'.repeat(80), exact: true })
  await longChoice.scrollIntoViewIfNeeded()
  const geometry = await longChoice.evaluate((node) => {
    const content = node.closest('fieldset')?.parentElement
    return content === null || content === undefined ? null : { width: content.clientWidth, scrollWidth: content.scrollWidth }
  })
  expect(geometry).not.toBeNull()
  expect(geometry?.scrollWidth).toBeLessThanOrEqual(geometry?.width ?? 0)
  await page.screenshot({ path: join(evidence, 'long-label-narrow.png'), animations: 'disabled' })
  expect(phoneLogins).toBe(3)
  expect(answers).toHaveLength(2)
  expect(forbidden).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify({ realBuiltHostAndClient: true,
    apiResponses: 'Authenticated API HTTP fixtures served by a loopback double; final third-account long-label boundary derived explicitly from pending with a synthetic revision',
    requests, answers, phoneLogins, changedConfiguration, forbidden, pageErrors: tripwire.pageErrors,
  }, null, 2) + '\n')
}, 120_000)
