/** Actual API public fixtures pass through the built Host route into the recharge page. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import pricing from '../../../packages/host/credits-index/tests/fixtures/official-price-comparison-api.json' with { type: 'json' }
import models from '../../../packages/host/credits-index/tests/fixtures/official-price-comparison-models-api.json' with { type: 'json' }
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('shows dated same-specification discounts through Host HTTP without creating payment or generation requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recharge-reference-browser-'))
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void>; upstream?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() } finally {
      try { await cleanup.scaffold?.() } finally {
        try { await cleanup.upstream?.() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const requests: { method: string; path: string; privateHeaders: boolean }[] = []
  const forbidden: string[] = []
  let legacy = false
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requests.push({ method: request.method ?? 'GET', path,
      privateHeaders: request.headers.authorization !== undefined || request.headers.cookie !== undefined })
    response.setHeader('content-type', 'application/json')
    const answer = (data: unknown): void => { response.end(JSON.stringify({ success: true, data })) }
    if (path === '/harness/api/pricing') {
      if (!legacy) { response.end(JSON.stringify(pricing)); return }
      const old = JSON.parse(JSON.stringify(pricing)) as { data: { retail_price_rows?: Record<string, unknown>[] }[] }
      for (const model of old.data) for (const row of model.retail_price_rows ?? []) delete row.official_reference
      response.end(JSON.stringify(old)); return
    }
    if (path === '/harness/v1/models') { response.end(JSON.stringify(models)); return }
    if (path === '/harness/api/status') { answer({ quota_per_unit: 500_000, usd_exchange_rate: 6.7138 }); return }
    if (path === '/harness/api/user/self') {
      answer({ id: 7, username: 'comparison-browser', display_name: 'comparison-browser', group: 'default', quota: 500_000 }); return
    }
    if (path === '/harness/api/client-activity/heartbeat') {
      answer({ server_time: Math.floor(Date.now() / 1000), heartbeat_interval_seconds: 60 }); return
    }
    if (path === '/harness/api/log/self') { answer({ total: 0, items: [] }); return }
    if (/recharge|payment|chat\/completions|images\/generations|video|audio\/speech/u.test(path)) forbidden.push(path)
    response.statusCode = 404
    response.end(JSON.stringify({ success: false }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.upstream = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Comparison fixture must bind loopback')
  const state = join(root, 'credits')
  await mkdir(state)
  await writeFile(join(state, 'session.json'), JSON.stringify({ token: 'synthetic-comparison-product-session',
    expiresAt: '9999-01-01T00:00:00.000Z', account: { id: '7', phone: '13800000000' },
    upstream: { token: 'synthetic-comparison-access', refresh: 'synthetic-comparison-refresh', expiresAt: '9999-01-01T00:00:00.000Z' },
  }), { mode: 0o600 })
  const overlay = join(root, 'comparison.patch.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: `http://127.0.0.1:${String(address.port)}/harness`,
      baseUrl: '', bridgeBaseUrl: '', stateDir: state } },
    ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  cleanup.scaffold = () => scaffold.close()
  const payloadResponse = await scaffold.hostFetch('/credits/api/price-comparisons')
  const payload = await payloadResponse.json() as { ok: boolean; payload: { models: { id: string; kind: string; rows: unknown[] }[] } }
  expect(payload.ok).toBe(true)
  expect(payload.payload.models).toHaveLength(43)
  expect(payload.payload.models.reduce((sum, model) => sum + model.rows.length, 0)).toBe(113)
  expect(JSON.stringify(payload)).not.toMatch(/"(?:cost|lane_id|cost_cny|upstream_token)"/u)
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1100 }, colorScheme: 'light' })
  const tripwire = watchConsole(page)
  const evidenceBase = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceBase, { recursive: true })
  const evidence = await mkdtemp(join(evidenceBase, 'recharge-price-comparison-'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: '充值', exact: true }).click()
  const comparison = page.getByRole('region', { name: '模型价格对比', exact: true })
  await comparison.waitFor({ timeout: 15_000 })
  expect(await comparison.innerText()).toContain('默认报价')
  expect(await comparison.innerText()).toContain('实际以提交时报价为准')
  expect(await comparison.innerText()).toContain('折')
  const summaryBounds = await comparison.boundingBox()
  expect(summaryBounds?.width).toBeGreaterThan(950)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('heading', { name: '积分充值', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(evidence, 'light-page.png'), animations: 'disabled' })
  await comparison.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(evidence, 'light-summary.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(evidence, 'dark-summary.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 580, height: 1100 })
  await comparison.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(evidence, 'light-580-summary.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await comparison.getByRole('button', { name: '查看型号与规格', exact: true }).click()
  const category = comparison.getByRole('group', { name: '模型类别', exact: true })
  await category.getByRole('button', { name: '聊天', exact: true }).click()
  const search = comparison.getByRole('textbox', { name: '搜索型号', exact: true })
  const textModel = payload.payload.models.find(model => model.kind === 'text')
  if (textModel === undefined) throw new Error('Actual reference fixture requires a retained chat model')
  await search.fill(textModel.id)
  expect(await comparison.getByRole('article').count()).toBe(1)
  const singleModelBounds = await comparison.getByRole('article').evaluate(element => ({
    width: element.getBoundingClientRect().width,
    available: element.parentElement!.getBoundingClientRect().width,
  }))
  expect(Math.abs(singleModelBounds.available - singleModelBounds.width)).toBeLessThan(2)
  expect(await comparison.innerText()).toContain('输入')
  expect(await comparison.innerText()).toContain('输出')
  expect(await comparison.innerText()).toContain('2026-10-31')
  await comparison.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(evidence, 'light-chat-details.png'), animations: 'disabled' })
  await search.fill('')
  await category.getByRole('button', { name: '视频', exact: true }).click()
  await search.fill('seedance-2-0')
  await expect.poll(() => comparison.getByRole('article').count()).toBeGreaterThan(0)
  expect(await comparison.innerText()).toContain('元 / 秒')
  expect(await comparison.innerText()).toContain('文生视频')
  expect(await comparison.innerText()).toContain('官方参考价按相同分辨率和时长折算')
  expect(await comparison.innerText()).not.toContain('Token公式')
  expect(await comparison.getByRole('article').first().innerText()).not.toContain('ycapi-')
  for (const [theme, width] of [['dark', 1440], ['light', 580]] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width, height: 1100 })
    await comparison.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const links = comparison.getByRole('link', { name: '官方价格依据', exact: true })
    expect(await links.count()).toBeGreaterThan(0)
    expect(await links.first().getAttribute('href')).toMatch(/^https:\/\//u)
    await page.screenshot({ path: join(evidence, `${theme}-${String(width)}-video-details.png`), animations: 'disabled' })
  }
  legacy = true
  const oldRead = page.waitForResponse(response => new URL(response.url()).pathname === '/credits/api/price-comparisons')
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: '充值', exact: true }).click()
  await oldRead
  expect(await page.getByRole('region', { name: '模型价格对比', exact: true }).count()).toBe(0)
  expect(await page.getByRole('heading', { name: '积分充值', exact: true }).count()).toBe(1)
  expect(forbidden).toEqual([])
  expect(requests.filter(request => request.path === '/harness/api/pricing').every(request => !request.privateHeaders)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify({ apiFixture: 'official-price-comparison-api.json',
    clientModelCount: 43, priceRowCount: 113, summaryBounds, singleModelBounds, forbidden, requests, pageErrors: tripwire.pageErrors,
  }, null, 2) + '\n')
}, 120_000)
