/** Built balance and usage pages retain confirmed data while read failures remain visible. */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('retains the last balance and usage, honors read cooldowns and rejects empty successful responses', async () => {
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void> } = {}
  onTestFinished(async () => { try { await cleanup.browser?.() } finally { await cleanup.scaffold?.() } })
  const scaffold = await launchWebScaffold({})
  cleanup.scaffold = () => scaffold.close()
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
  const tripwire = watchConsole(page)
  const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, 'credits-read-recovery-'))
  const account = { id: 'credits-read-browser-qa', phone: '+8613800000000' }
  type ReadState = 'success' | 'limited' | 'empty' | 'recovered'
  let balanceState: ReadState = 'success'
  let usageState: ReadState = 'success'
  let summaryReads = 0
  let usageReads = 0
  const unexpected: string[] = []
  const writes: string[] = []
  await page.route('**/credits/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    if (url.pathname === '/credits/api/session') {
      await route.fulfill({ status: 200, json: { ok: true, payload: { signedIn: true, creditsPerYuan: 1000, account } } })
    } else if (url.pathname === '/credits/api/creation/content') {
      const mode = { title: { zh: '', en: '' }, description: { zh: '', en: '' },
        promptPlaceholder: { zh: '', en: '' }, categories: [], templates: [], presets: [] }
      await route.fulfill({ status: 200, json: { ok: true,
        payload: { schemaVersion: 1, revision: 'credits-read-browser-qa', image: mode, video: mode } } })
    } else if (url.pathname === '/credits/api/summary') {
      summaryReads++
      if (balanceState === 'limited') {
        await route.fulfill({ status: 429, headers: { 'Retry-After': '2' }, json: {
          ok: false, code: 'BALANCE_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 2, payload: null,
        } })
      } else {
        await route.fulfill({ status: 200, json: { ok: true, account: { id: account.id },
          payload: balanceState === 'empty' ? null : {
            balance_points: balanceState === 'recovered' ? 25000 : 20000, as_of: new Date().toISOString(),
          } } })
      }
    } else if (url.pathname === '/credits/api/usage') {
      usageReads++
      if (usageState === 'limited') {
        await route.fulfill({ status: 429, headers: { 'Retry-After': '2' }, json: {
          ok: false, code: 'USAGE_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 2, payload: null,
        } })
      } else {
        const start = Number(url.searchParams.get('start'))
        const end = Number(url.searchParams.get('end'))
        await route.fulfill({ status: 200, json: { ok: true, payload: usageState === 'empty' ? null : {
          start, end, asOf: new Date().toISOString(), delayMinutes: 0,
          rows: [{ timestamp: end, model: 'synthetic-chat-model', billingRecords: 1,
            consumedPoints: usageState === 'recovered' ? 50 : 37.5, totalTokens: 10 }],
        } } })
      }
    } else {
      unexpected.push(`${request.method()} ${url.pathname}`)
      await route.fulfill({ status: 404, json: { ok: false, code: 'UNEXPECTED_FIXTURE_READ' } })
    }
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: '余额', exact: true }).click()
  const wallet = page.getByRole('region', { name: '积分余额', exact: true })
  const usage = page.getByRole('region', { name: '使用量统计', exact: true })
  const refreshBalance = wallet.getByRole('button', { name: '刷新', exact: true })
  const refreshUsage = usage.getByRole('button', { name: '刷新统计', exact: true })
  const consumed = usage.getByRole('article', { name: '消费积分', exact: true })
  await wallet.getByText('20,000', { exact: true }).waitFor()
  await expect.poll(() => consumed.innerText()).toMatch(/37\.5\s*积分/u)
  expect(await page.getByRole('button', { name: '退出登录', exact: true }).count()).toBe(1)
  await page.screenshot({ path: join(evidence, 'normal-confirmed-values.png'), animations: 'disabled' })

  balanceState = 'limited'
  usageState = 'limited'
  await refreshBalance.click()
  await page.getByRole('alert').filter({ hasText: '读取过于频繁，请稍后刷新' }).waitFor()
  await refreshUsage.click()
  await usage.getByRole('alert').filter({ hasText: '统计读取过于频繁，请稍后刷新' }).waitFor()
  await expect.poll(() => refreshBalance.isDisabled()).toBe(true)
  await expect.poll(() => refreshUsage.isDisabled()).toBe(true)
  await expect.poll(() => usage.getByRole('button', { name: '重试', exact: true }).isDisabled()).toBe(true)
  await wallet.getByText('显示上次成功读取的余额，当前余额尚未确认', { exact: true }).waitFor()
  await usage.getByText('显示上次成功读取的统计，最新用量尚未确认', { exact: true }).waitFor()
  await wallet.getByText('20,000', { exact: true }).waitFor()
  await expect.poll(() => consumed.innerText()).toMatch(/37\.5\s*积分/u)
  await expect.poll(() => page.getByRole('alert').filter({ hasText: /请等待 [12] 秒后再刷新/u }).count()).toBe(2)
  const cooldownReads = { summary: summaryReads, usage: usageReads }
  for (const button of [refreshBalance, refreshUsage, usage.getByRole('button', { name: '重试', exact: true })]) {
    await button.evaluate((element) => { if (element instanceof HTMLButtonElement) element.click() })
  }
  await page.screenshot({ path: join(evidence, 'rate-limited-last-values.png'), animations: 'disabled' })
  expect({ summary: summaryReads, usage: usageReads }).toEqual(cooldownReads)

  balanceState = 'empty'
  usageState = 'empty'
  await expect.poll(() => refreshBalance.isEnabled(), { timeout: 5000 }).toBe(true)
  await expect.poll(() => refreshUsage.isEnabled(), { timeout: 5000 }).toBe(true)
  await refreshBalance.click()
  await page.getByRole('alert').filter({ hasText: '未取得完整数据，请稍后刷新' }).waitFor()
  await refreshUsage.click()
  await usage.getByRole('alert').filter({ hasText: '使用量读取失败，未取得完整数据，请稍后刷新' }).waitFor()
  expect(summaryReads).toBe(cooldownReads.summary + 1)
  expect(usageReads).toBe(cooldownReads.usage + 1)
  await wallet.getByText('20,000', { exact: true }).waitFor()
  await expect.poll(() => consumed.innerText()).toMatch(/37\.5\s*积分/u)
  await page.screenshot({ path: join(evidence, 'empty-success-is-visible-failure.png'), animations: 'disabled' })

  balanceState = 'recovered'
  usageState = 'recovered'
  await refreshBalance.click()
  await refreshUsage.click()
  await wallet.getByText('25,000', { exact: true }).waitFor()
  await expect.poll(() => consumed.innerText()).toMatch(/50\s*积分/u)
  expect(await page.getByRole('alert').count()).toBe(0)
  expect(await page.getByRole('button', { name: '退出登录', exact: true }).count()).toBe(1)
  expect(writes).toEqual([])
  expect(unexpected).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
  console.info(`Credits read browser evidence: ${evidence}`)
})

it('refreshes a changed shared login before retrying usage or creating one explicitly confirmed top-up', async () => {
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void> } = {}
  onTestFinished(async () => { try { await cleanup.browser?.() } finally { await cleanup.scaffold?.() } })
  const scaffold = await launchWebScaffold({})
  cleanup.scaffold = () => scaffold.close()
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
  const tripwire = watchConsole(page)
  const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, 'credits-owner-recovery-'))
  const accounts = [
    { account: { id: 'owner-a', phone: '+8613800000001' }, owner: 'a'.repeat(64), points: 11000, consumed: 11 },
    { account: { id: 'owner-b', phone: '+8613800000002' }, owner: 'b'.repeat(64), points: 22000, consumed: 22 },
    { account: { id: 'owner-c', phone: '+8613800000003' }, owner: 'c'.repeat(64), points: 33000, consumed: 33 },
  ] as const
  let current: typeof accounts[number] = accounts[0]
  let sessionReads = 0
  let usageReads = 0
  const creates: unknown[] = []
  const unexpected: string[] = []
  await page.route('**/credits/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/credits/api/session' && request.method() === 'GET') {
      sessionReads++
      await route.fulfill({ status: 200, json: { ok: true, payload: { signedIn: true,
        creditsPerYuan: 1000, account: current.account, accountOwner: current.owner } } })
    } else if (url.pathname === '/credits/api/creation/content' && request.method() === 'GET') {
      const mode = { title: { zh: '', en: '' }, description: { zh: '', en: '' },
        promptPlaceholder: { zh: '', en: '' }, categories: [], templates: [], presets: [] }
      await route.fulfill({ status: 200, json: { ok: true,
        payload: { schemaVersion: 1, revision: 'credits-owner-browser-qa', image: mode, video: mode } } })
    } else if (url.pathname === '/credits/api/summary' && request.method() === 'GET') {
      await route.fulfill({ status: 200, json: { ok: true, account: current.account, accountOwner: current.owner,
        payload: { balance_points: current.points } } })
    } else if (url.pathname === '/credits/api/usage' && request.method() === 'GET') {
      usageReads++
      const start = Number(url.searchParams.get('start'))
      const end = Number(url.searchParams.get('end'))
      await route.fulfill({ status: 200, json: { ok: true, account: current.account, accountOwner: current.owner,
        payload: { start, end, asOf: new Date().toISOString(), delayMinutes: 0,
          rows: [{ timestamp: end, model: `model-${current.account.id}`, billingRecords: 1,
            consumedPoints: current.consumed, totalTokens: 10 }] } } })
    } else if (url.pathname === '/credits/api/recharge/wechat' && request.method() === 'POST') {
      creates.push(request.postDataJSON())
      await route.fulfill({ status: 200, json: { ok: true, account: current.account, accountOwner: current.owner,
        payload: { outTradeNo: 'local-owner-c-order', amount: 30, points: 30000,
          expiresAt: Math.floor(Date.now() / 1000) + 300, qrCodeDataUrl: null } } })
    } else if (url.pathname === '/credits/api/recharge/wechat/order' && request.method() === 'GET') {
      expect(url.searchParams.get('expected_account_id')).toBe(accounts[2].account.id)
      expect(url.searchParams.get('expected_account_owner')).toBe(accounts[2].owner)
      await route.fulfill({ status: 200, json: { ok: true, account: current.account, accountOwner: current.owner,
        payload: { status: 'expired', points: 30000 } } })
    } else {
      unexpected.push(`${request.method()} ${url.pathname}`)
      await route.fulfill({ status: 400, json: { ok: false, code: 'UNEXPECTED_FIXTURE_REQUEST' } })
    }
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: '余额', exact: true }).click()
  const wallet = page.getByRole('region', { name: '积分余额', exact: true })
  const usage = page.getByRole('region', { name: '使用量统计', exact: true })
  const consumed = usage.getByRole('article', { name: '消费积分', exact: true })
  await wallet.getByText('11,000', { exact: true }).waitFor()
  await expect.poll(() => consumed.innerText()).toMatch(/11\s*积分/u)

  // Another window changes the Host's shared login while this page still displays A.
  current = accounts[1]
  const sessionBeforeRetry = sessionReads
  await usage.getByRole('button', { name: '刷新统计', exact: true }).click()
  await usage.getByRole('alert').filter({ hasText: '登录账号已变化' }).waitFor()
  expect(sessionReads).toBe(sessionBeforeRetry)
  await expect.poll(() => consumed.innerText()).toMatch(/11\s*积分/u)
  const usageBeforeRetry = usageReads
  await usage.getByRole('button', { name: '重试', exact: true }).click()
  await wallet.getByText('22,000', { exact: true }).waitFor()
  await expect.poll(() => consumed.innerText()).toMatch(/22\s*积分/u)
  expect(sessionReads).toBeGreaterThan(sessionBeforeRetry)
  expect(usageReads).toBeGreaterThan(usageBeforeRetry)
  expect(await wallet.getByText('11,000', { exact: true }).count()).toBe(0)
  expect(await usage.getByRole('alert').count()).toBe(0)
  await page.screenshot({ path: join(evidence, 'usage-retry-adopts-shared-login-b.png'), animations: 'disabled' })

  await page.getByRole('button', { name: '充值', exact: true }).click()
  await page.getByText(`充值账号：${accounts[1].account.phone}`, { exact: true }).waitFor()
  await page.getByRole('button', { name: '30 元', exact: true }).click()
  // A different shared login is discovered by the preflight; it must not inherit B's confirmation.
  current = accounts[2]
  await page.getByRole('button', { name: '确认支付', exact: true }).click()
  await page.getByText(`充值账号：${accounts[2].account.phone}`, { exact: true }).waitFor()
  await expect.poll(() => page.getByRole('button', { name: '确认支付', exact: true }).isEnabled()).toBe(true)
  expect(creates).toEqual([])
  expect(await page.getByText('local-owner-c-order', { exact: true }).count()).toBe(0)
  await page.screenshot({ path: join(evidence, 'top-up-preflight-switches-without-order.png'), animations: 'disabled' })

  await page.getByRole('button', { name: '确认支付', exact: true }).click()
  await page.getByText('local-owner-c-order', { exact: true }).waitFor()
  await page.getByText('订单结束：订单已过期（—）', { exact: true }).waitFor()
  expect(creates).toEqual([{ amount: 30, expected_account_id: accounts[2].account.id,
    expected_account_owner: accounts[2].owner }])
  expect(unexpected).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
  await page.screenshot({ path: join(evidence, 'one-explicit-current-owner-order.png'), animations: 'disabled' })
  console.info(`Credits owner browser evidence: ${evidence}`)
})
