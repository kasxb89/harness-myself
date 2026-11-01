/** The installed market owns its viewport and pagination inside the real settings shell. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const preview = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

it('scrolls the actual skin gallery, appends more cards and keeps detail scrolling separate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-skin-scroll-'))
  const cleanup: { browser?: () => Promise<void>; scaffold?: () => Promise<void> } = {}
  const originalFetch = globalThis.fetch
  const externalReads: string[] = []
  const mutations: string[] = []
  // The package's bundled 301-entry catalog is deterministic and needs no provider access.
  vi.stubEnv('DSH_SKIN_MARKET_LOCAL_CATALOG', '1')
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') return originalFetch(input, init)
    externalReads.push(url.href)
    if (url.hostname === 'registry.npmjs.org' && url.pathname === '/dsh-skin-market') return Response.json({
      'dist-tags': { latest: '0.1.57' }, versions: { '0.1.57': {
        version: '0.1.57', gitHead: 'a'.repeat(40), dist: { tarball: 'https://registry.npmjs.org/dsh-skin-market/-/dsh-skin-market-0.1.57.tgz' },
      } },
    })
    return Response.json({ error: 'External network disabled in skin layout fixture' }, { status: 503 })
  })
  onTestFinished(async () => {
    try { await cleanup.browser?.() } finally {
      try { await cleanup.scaffold?.() } finally {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
  const overlay = join(directory, 'skin-scroll.patch.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'dsh-market', disabled: true },
    { id: 'dsh-skin-market', disabled: false },
    { id: 'credits-index', config: { newApiBaseUrl: 'http://127.0.0.1:9/harness', stateDir: join(directory, 'credits') } },
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  cleanup.scaffold = () => scaffold.close()
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1100 }, colorScheme: 'light' })
  const tripwire = watchConsole(page)
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === new URL(scaffold.baseUrl).origin) {
      if (request.method() !== 'GET' && url.pathname.startsWith('/dsh-skin-market/')) mutations.push(url.pathname)
      await route.continue()
    } else if (request.resourceType() === 'image') await route.fulfill({ contentType: 'image/png', body: preview })
    else await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  const evidenceBase = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(evidenceBase, { recursive: true })
  const evidence = await mkdtemp(join(evidenceBase, 'skin-market-scroll-'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '皮肤市场', exact: true }).click()
  const market = settings.locator('[data-dsh-skin-market]')
  const discovery = market.getByRole('region', { name: '发现更多', exact: true })
  await expect.poll(() => discovery.getByRole('article').count()).toBe(20)
  const home = discovery.locator('..')
  const geometry = () => home.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight, top: element.scrollTop }))
  const initial = await geometry()
  expect(initial.height).toBeGreaterThan(100)
  expect(initial.content).toBeGreaterThan(initial.height)
  const bounds = await home.boundingBox()
  if (bounds === null) throw new Error('The gallery must have a visible scroll viewport')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(120, bounds.height / 2))
  await page.mouse.wheel(0, 700)
  await expect.poll(async () => (await geometry()).top).toBeGreaterThan(0)
  const afterWheel = await geometry()
  const countAfterWheel = await discovery.getByRole('article').count()
  await home.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => discovery.getByRole('article').count()).toBeGreaterThanOrEqual(40)
  const afterAppend = await geometry()
  const countAfterAppend = await discovery.getByRole('article').count()
  await writeFile(join(evidence, 'scroll-geometry.json'), JSON.stringify({ initial, afterWheel, afterAppend,
    initialCardCount: 20, countAfterWheel, countAfterAppend }, null, 2) + '\n')
  await page.screenshot({ path: join(evidence, 'light-after-pagination.png'), animations: 'disabled' })
  await home.evaluate((element) => { element.scrollTop = 0 })
  const homeBeforeDetail = (await geometry()).top
  await discovery.getByRole('article').first().getByRole('button', { name: /界面预览$/u }).click()
  const detailDialog = page.getByRole('dialog', { name: '皮肤详情', exact: true })
  await detailDialog.waitFor()
  const detail = detailDialog.getByRole('main', { name: '皮肤详情内容', exact: true })
  await expect.poll(() => detail.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  const detailBounds = await detail.boundingBox()
  if (detailBounds === null) throw new Error('The original detail pane must be visible')
  await page.mouse.move(detailBounds.x + detailBounds.width / 2, detailBounds.y + detailBounds.height / 2)
  await page.mouse.wheel(0, 600)
  await expect.poll(() => detail.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await detailDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await detailDialog.waitFor({ state: 'hidden' })
  expect((await geometry()).top).toBe(homeBeforeDetail)
  for (const [theme, width] of [['dark', 1440], ['light', 580]] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width, height: 1100 })
    const box = await home.boundingBox()
    if (box === null) throw new Error('The gallery must remain visible after resizing')
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(100, box.height / 2))
    await page.mouse.wheel(0, 500)
    await expect.poll(async () => (await geometry()).top).toBeGreaterThan(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(evidence, `${theme}-${String(width)}.png`), animations: 'disabled' })
  }
  expect(mutations).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify({ initial, afterWheel, afterAppend, countAfterWheel, countAfterAppend,
    externalReads, mutations, pageErrors: tripwire.pageErrors, catalog: 'Installed dsh-skin-market@0.1.57 bundled catalog',
  }, null, 2) + '\n')
}, 120_000)
