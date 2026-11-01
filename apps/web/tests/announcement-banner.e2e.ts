/** Actual public feed fixtures traverse the built Host and the root carousel in the shipped profile. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import enabled from '../../../packages/host/credits-index/tests/fixtures/announcement-banner-api/feed-banner-enabled.json' with { type: 'json' }
import updated from '../../../packages/host/credits-index/tests/fixtures/announcement-banner-api/feed-banner-updated.json' with { type: 'json' }
import disabled from '../../../packages/host/credits-index/tests/fixtures/announcement-banner-api/feed-banner-disabled.json' with { type: 'json' }
import masterDisabled from '../../../packages/host/credits-index/tests/fixtures/announcement-banner-api/feed-master-disabled.json' with { type: 'json' }
import empty from '../../../packages/host/credits-index/tests/fixtures/announcement-banner-api/top-enabled-empty.json' with { type: 'json' }
import status from '../../../packages/host/credits-index/tests/fixtures/announcement-banner-api/status.json' with { type: 'json' }
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

async function geometry(page: Page) {
  return page.evaluate(() => {
    const top = document.querySelector('[data-shell-top]')!, banner = document.querySelector('[aria-label="顶部公告"]')
    const rect = (node: Element) => {
      const box = node.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, height: box.height }
    }
    return { top: rect(top), banner: banner === null ? null : rect(banner),
      main: rect(document.querySelector('[data-slot="main"]')!.parentElement!),
      sidebar: rect(document.querySelector('[data-slot="sidebar"]')!.parentElement!),
      pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight }
  })
}

it('rotates published announcements, remembers an explicit close and preserves desktop chrome and the legacy entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-top-banner-browser-'))
  const cleanup: { scaffold?: () => Promise<void>; browser?: () => Promise<void>; upstream?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() } finally {
      try { await cleanup.scaffold?.() } finally {
        try { await cleanup.upstream?.() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const requests: { path: string; method: string; credentials: boolean }[] = [], forbidden: string[] = []
  let mode: 'enabled' | 'updated' | 'disabled' | 'masterDisabled' | 'empty' | 'old' = 'enabled'
  const feeds = { enabled, updated, disabled, masterDisabled, empty }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requests.push({ path, method: request.method ?? 'GET', credentials: request.headers.authorization !== undefined || request.headers.cookie !== undefined })
    response.setHeader('content-type', 'application/json')
    if (request.method !== 'GET') forbidden.push(path)
    if (path === '/harness/api/client-announcements') {
      if (mode === 'old') { response.statusCode = 404; response.end('{}'); return }
      response.end(JSON.stringify(feeds[mode])); return
    }
    if (path === '/harness/api/status') { response.end(JSON.stringify(status)); return }
    if (path === '/harness/v1/models') { response.end(JSON.stringify({ data: [], object: 'list' })); return }
    if (path === '/harness/api/pricing') { response.end(JSON.stringify({ success: true, data: [] })); return }
    if (/chat\/completions|images\/generations|videos|recharge|payment/u.test(path)) forbidden.push(path)
    response.statusCode = 404; response.end(JSON.stringify({ success: false }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.upstream = () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) }); server.closeAllConnections()
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected loopback feed')
  const patch = join(root, 'banner.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'credits-index', config: { newApiBaseUrl: `http://127.0.0.1:${String(address.port)}/harness`,
      baseUrl: '', bridgeBaseUrl: '', stateDir: join(root, 'credits') } },
    ...['dsh-market', 'dsh-skin-market'].map(id => ({ id, disabled: true })),
  ]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: patch })
  cleanup.scaffold = () => scaffold.close()
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
  const tripwire = watchConsole(page)
  const base = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(base, { recursive: true })
  const evidence = await mkdtemp(join(base, 'announcement-banner-'))
  const snapshots: unknown[] = []
  const banner = page.getByRole('region', { name: '顶部公告', exact: true })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await banner.waitFor({ timeout: 15_000 })
  await page.mouse.move(900, 700)
  const initial = await banner.textContent()
  await expect.poll(() => banner.textContent(), { timeout: 10_000 }).not.toBe(initial)
  await banner.getByRole('button', { name: '上一条公告', exact: true }).click()
  const normal = await geometry(page)
  expect(normal.main.top).toBe(normal.top.bottom)
  expect(normal.sidebar.top).toBe(normal.top.bottom)
  expect(normal.pageHeight).toBe(normal.viewportHeight)
  snapshots.push({ state: 'published', ...normal })
  await page.screenshot({ path: join(evidence, 'top-banner-light.png'), animations: 'disabled' })
  await banner.getByRole('button', { name: '关闭顶部公告', exact: true }).click()
  await banner.waitFor({ state: 'detached' })
  expect((await geometry(page)).top.height).toBe(0)
  await page.getByRole('button', { name: '余额', exact: true }).click()
  expect(await banner.count()).toBe(0)
  const unchangedRead = page.waitForResponse(response => new URL(response.url()).pathname === '/credits/api/announcement-banner')
  await page.reload({ waitUntil: 'load' }); await unchangedRead
  expect(await banner.count()).toBe(0)
  mode = 'updated'
  await page.reload({ waitUntil: 'load' })
  await banner.waitFor()
  const revised = updated.data.announcements[0]!
  await banner.getByRole('button', { name: new RegExp(revised.title, 'u') }).first().click()
  const detail = page.getByRole('dialog', { name: revised.title, exact: true })
  await detail.getByRole('paragraph').filter({ hasText: revised.content }).first().waitFor()
  expect(await detail.locator('script,img,iframe').count()).toBe(0)
  await detail.getByRole('button', { name: '关闭', exact: true }).last().click()
  for (const [theme, width] of [['dark', 1440], ['light', 580]] as const) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 900 })
    const result = await geometry(page)
    expect(result.pageWidth).toBe(result.viewportWidth)
    snapshots.push({ state: `${theme}-${String(width)}`, ...result })
    await page.screenshot({ path: join(evidence, `top-banner-${theme}-${String(width)}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  for (const platform of ['windows', 'darwin', 'fullscreen'] as const) {
    await page.evaluate((value) => {
      document.documentElement.removeAttribute('data-platform')
      document.documentElement.toggleAttribute('data-windows-titlebar', value === 'windows')
      document.documentElement.toggleAttribute('data-fullscreen', value === 'fullscreen')
      if (value !== 'windows') document.documentElement.setAttribute('data-platform', 'darwin')
      document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
    }, platform)
    const result = await geometry(page)
    expect(result.main.top).toBe(result.top.bottom)
    expect(result.banner?.top).toBe(platform === 'windows' ? 40 : platform === 'darwin' ? 48 : 0)
    expect(await banner.getByRole('button', { name: '关闭顶部公告', exact: true })
      .evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
    snapshots.push({ state: platform, ...result })
  }
  await page.evaluate(() => { document.documentElement.removeAttribute('data-fullscreen') })
  await banner.getByRole('button', { name: '关闭顶部公告', exact: true }).click()
  await banner.waitFor({ state: 'detached' })
  expect((await geometry(page)).top.height).toBe(0)
  await page.screenshot({ path: join(evidence, 'mac-closed-no-gap.png'), animations: 'disabled' })
  const second = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
  const secondTripwire = watchConsole(second)
  for (const next of ['empty', 'enabled', 'disabled', 'masterDisabled', 'old'] as const) {
    mode = next
    const read = second.waitForResponse(response => new URL(response.url()).pathname === '/credits/api/announcement-banner')
    await second.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }); await read
    const top = second.getByRole('region', { name: '顶部公告', exact: true })
    if (next === 'enabled') await top.waitFor()
    else await expect.poll(() => top.count()).toBe(0)
    if (next !== 'enabled') expect((await geometry(second)).top.height).toBe(0)
    snapshots.push({ state: next, ...await geometry(second) })
  }
  await second.getByRole('button', { name: '公告', exact: true }).click()
  await second.getByRole('dialog', { name: '公告', exact: true }).waitFor()
  expect(forbidden).toEqual([])
  expect(requests.filter(request => request.path.endsWith('/api/client-announcements')).every(request => !request.credentials)).toBe(true)
  expect(tripwire.pageErrors).toEqual([]); expect(secondTripwire.pageErrors).toEqual([])
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify({ actualBuiltHostAndClient: true,
    source: 'Actual API public response fixtures replayed by an isolated loopback service double; desktop chrome attributes simulated',
    requests, forbidden, snapshots, errors: [...tripwire.pageErrors, ...secondTripwire.pageErrors],
  }, null, 2) + '\n')
}, 120_000)
