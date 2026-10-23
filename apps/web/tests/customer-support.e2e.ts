/** Built support access uses current settings and keeps QR actions usable in the narrow rail. */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('opens the current support QR and handles refresh, image failure and disabled settings without retaining an old code', async () => {
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void>; imageServer?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() }
    finally { try { await cleanup.scaffold?.() } finally { await cleanup.imageServer?.() } }
  })
  const scaffold = await launchWebScaffold({})
  cleanup.scaffold = () => scaffold.close()
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
  await page.addInitScript(() => {
    Object.assign(window, { dshDesktop: { protocolVersion: 1, updates: {
      status: async () => ({ phase: 'idle' }), check: async () => {}, open: async () => {}, subscribe: () => () => {},
    } } })
  })
  const evidenceRoot = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = await mkdtemp(join(evidenceRoot, 'customer-support-'))
  const qr = await readFile(new URL('./fixtures/customer-support-qr.png', import.meta.url))
  const tripwire = watchConsole(page)
  let state: 'published' | 'network' | 'disabled' | 'long-title' | 'literal-text' = 'published'
  let imageFails = false
  let reads = 0
  const imageHeaders: IncomingHttpHeaders[] = []
  const literalTitle = '<img src=x onerror=alert(1)>'
  const assetPath = `/api/creation/assets/cc_${createHash('sha256').update(qr).digest('hex')}`
  const imageServer = createServer((request, response) => {
    if (request.url !== assetPath) { response.writeHead(404).end(); return }
    imageHeaders.push(request.headers)
    response.writeHead(imageFails ? 503 : 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    response.end(imageFails ? undefined : qr)
  })
  cleanup.imageServer = () => new Promise<void>((resolve, reject) => {
    imageServer.close((error) => { if (error) reject(error); else resolve() })
    imageServer.closeAllConnections()
  })
  await new Promise<void>((resolve, reject) => { imageServer.once('error', reject); imageServer.listen(0, '127.0.0.1', resolve) })
  const address = imageServer.address()
  if (address === null || typeof address === 'string') throw new Error('Support image fixture did not bind TCP')
  const qrUrl = `http://127.0.0.1:${String(address.port)}${assetPath}`
  await page.route('**/credits/api/customer-support', async (route) => {
    reads++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state === 'network'
      ? { ok: false, code: 'CUSTOMER_SUPPORT_NETWORK' }
      : { ok: true, payload: { enabled: state !== 'disabled', qrCodeUrl: state === 'disabled' ? '' : qrUrl,
        title: state === 'long-title' ? 'W'.repeat(64) : state === 'literal-text' ? literalTitle : '云枢客服',
        description: '扫描二维码联系客服',
      } }) })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const action = page.getByRole('button', { name: '客服', exact: true })
  await action.waitFor()
  expect(reads).toBe(0)
  const announcement = await page.getByRole('button', { name: '公告', exact: true }).boundingBox()
  const support = await action.boundingBox()
  const mobile = await page.getByRole('button', { name: '手机', exact: true }).boundingBox()
  expect(announcement).not.toBeNull()
  expect(support).not.toBeNull()
  expect(mobile).not.toBeNull()
  expect(announcement!.y + announcement!.height).toBeLessThanOrEqual(support!.y)
  expect(support!.y + support!.height).toBeLessThanOrEqual(mobile!.y)
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
  await action.hover()
  const tooltip = page.getByRole('tooltip', { name: '客服', exact: true })
  await expect.poll(() => tooltip.evaluateAll(elements => elements.map(element => getComputedStyle(element).opacity))).toEqual(['1'])
  await page.screenshot({ path: join(evidence, 'collapsed-entry.png'), animations: 'disabled' })
  await action.click()
  const dialog = page.getByRole('dialog')
  const image = dialog.getByRole('img', { name: '客服二维码', exact: true })
  const loadedImages = () => image.evaluateAll(elements => elements.map(element =>
    element instanceof HTMLImageElement && element.naturalWidth > 0))
  await expect.poll(loadedImages)
    .toEqual([true])
  expect(reads).toBe(1)
  expect(await image.getAttribute('referrerpolicy')).toBe('no-referrer')
  for (const [theme, width] of [['dark', 1440], ['light', 360]] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width, height: 800 })
    const box = await dialog.boundingBox()
    const imageBox = await image.boundingBox()
    expect(box).not.toBeNull()
    expect(imageBox).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    expect(imageBox!.x).toBeGreaterThanOrEqual(box!.x)
    expect(imageBox!.x + imageBox!.width).toBeLessThanOrEqual(box!.x + box!.width)
    await page.screenshot({ path: join(evidence, `${theme}-${String(width)}.png`), animations: 'disabled' })
  }
  state = 'long-title'
  await dialog.getByRole('button', { name: '刷新', exact: true }).click()
  await dialog.getByRole('heading', { name: 'W'.repeat(64), exact: true }).waitFor()
  const close = dialog.getByRole('button', { name: '关闭', exact: true })
  const closeBox = await close.boundingBox()
  expect(closeBox).not.toBeNull()
  expect(closeBox!.x).toBeGreaterThanOrEqual(0)
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(360)
  await page.screenshot({ path: join(evidence, 'long-title-360.png'), animations: 'disabled' })
  await close.click()
  await expect.poll(() => dialog.count()).toBe(0)
  await expect.poll(() => action.evaluate(element => document.activeElement === element)).toBe(true)
  state = 'disabled'
  await action.click()
  await dialog.getByText('暂未配置客服二维码，请稍后再试', { exact: true }).waitFor()
  expect(await image.count()).toBe(0)
  state = 'network'
  await dialog.getByRole('button', { name: '刷新', exact: true }).click()
  await dialog.getByText('客服信息未能加载，请检查网络连接后重试', { exact: true }).waitFor()
  expect(await image.count()).toBe(0)
  state = 'published'
  imageFails = true
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await dialog.getByText('二维码图片未能加载，请检查网络连接后重试', { exact: true }).waitFor()
  imageFails = false
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await expect.poll(loadedImages)
    .toEqual([true])
  state = 'literal-text'
  await dialog.getByRole('button', { name: '刷新', exact: true }).click()
  await dialog.getByRole('heading', { name: literalTitle, exact: true }).waitFor()
  expect(await dialog.locator('img').count()).toBe(1)
  await page.keyboard.press('Escape')
  await expect.poll(() => dialog.count()).toBe(0)
  expect(imageHeaders.length).toBeGreaterThan(0)
  expect(imageHeaders.map(headers => ({ hasReferer: headers.referer !== undefined,
    hasAuthorization: headers.authorization !== undefined }))).toEqual(imageHeaders.map(() => ({
    hasReferer: false, hasAuthorization: false,
  })))
  expect(tripwire.pageErrors).toEqual([])
  console.info(`Customer support browser evidence: ${evidence}`)
})
