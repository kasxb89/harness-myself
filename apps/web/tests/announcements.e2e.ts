/** Built sidebar announcements use the connected Host and safely retain readable text after a failed refresh. */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('opens announcements directly below update checks and follows backend enablement without rendering HTML', async () => {
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void> } = {}
  onTestFinished(async () => { try { await cleanup.browser?.() } finally { await cleanup.scaffold?.() } })
  const scaffold = await launchWebScaffold({})
  cleanup.scaffold = () => scaffold.close()
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
  await page.addInitScript(() => {
    Object.assign(window, { dshDesktop: { protocolVersion: 1, updates: {
      status: async () => ({ phase: 'idle' }), check: async () => {}, open: async () => {},
      subscribe: () => () => {},
    } } })
  })
  const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, 'announcements-'))
  const tripwire = watchConsole(page)
  let state: 'published' | 'network' | 'disabled' = 'published'
  let reads = 0
  const content = '视频创作功能更新\n<img src=x onerror=alert(1)>\n请按需选择生成规格'
  await page.route('**/credits/api/announcements', async (route) => {
    reads++
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(state === 'network' ? { ok: false, code: 'ANNOUNCEMENTS_NETWORK' } : {
        ok: true, payload: { enabled: state !== 'disabled', items: state === 'disabled' ? [] : [
          { content, publishDate: '2026-10-23T09:00:00+08:00', extra: '云枢团队' },
        ] },
      }) })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const action = page.getByRole('button', { name: '公告', exact: true })
  await action.waitFor()
  expect(reads).toBe(0)
  const update = await page.getByRole('button', { name: '检查更新', exact: true }).boundingBox()
  const announcement = await action.boundingBox()
  const mobile = await page.getByRole('button', { name: '手机', exact: true }).boundingBox()
  expect(update).not.toBeNull()
  expect(announcement).not.toBeNull()
  expect(mobile).not.toBeNull()
  expect(update!.y + update!.height).toBeLessThanOrEqual(announcement!.y)
  expect(announcement!.y + announcement!.height).toBeLessThanOrEqual(mobile!.y)
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
  await action.hover()
  const tooltip = page.getByRole('tooltip', { name: '公告', exact: true })
  await expect.poll(() => tooltip.evaluateAll(elements => elements.map(element => getComputedStyle(element).opacity))).toEqual(['1'])
  const tooltipBox = await tooltip.boundingBox()
  expect(tooltipBox).not.toBeNull()
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0)
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(1440)
  await page.screenshot({ path: join(evidence, 'collapsed-entry.png'), animations: 'disabled' })
  await action.click()
  const dialog = page.getByRole('dialog', { name: '公告', exact: true })
  await dialog.getByText(content, { exact: true }).waitFor()
  expect(await dialog.locator('img').count()).toBe(0)
  expect(reads).toBe(1)
  for (const [theme, width] of [['dark', 1440], ['light', 580]] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width, height: 900 })
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: join(evidence, `${theme}-${width}.png`), animations: 'disabled' })
  }
  state = 'network'
  await dialog.getByRole('button', { name: '刷新', exact: true }).click()
  await dialog.getByRole('button', { name: '重试', exact: true }).waitFor()
  await dialog.getByText('公告未能加载，请检查网络连接后重试', { exact: true }).waitFor()
  expect(await dialog.getByText(content, { exact: true }).count()).toBe(1)
  state = 'disabled'
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await dialog.getByText('暂无公告', { exact: true }).waitFor()
  expect(await dialog.getByText(content, { exact: true }).count()).toBe(0)
  await page.keyboard.press('Escape')
  await expect.poll(() => dialog.count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  console.info(`Announcements browser evidence: ${evidence}`)
})
