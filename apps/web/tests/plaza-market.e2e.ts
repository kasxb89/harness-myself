/** The real profile market keeps its controls and sole scroll viewport inside the Plaza frame. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'
import { assertReadableText } from './readable-text.ts'

it('keeps the real market responsive and searchable without provider mutations', async () => {
  const artifacts = fileURLToPath(new URL('../../../.artifacts/', import.meta.url))
  await mkdir(artifacts, { recursive: true })
  const evidence = await mkdtemp(join(artifacts, 'plaza-market-'))
  const directory = await mkdtemp(join(tmpdir(), 'yunshu-plaza-review-'))
  const cleanup: { browser?: () => Promise<void>; scaffold?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await cleanup.browser?.() } finally {
      try { await cleanup.scaffold?.() } finally { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) }
    }
  })
  const packageRoot = fileURLToPath(new URL('../../../packages/bundle/web-app/node_modules/', import.meta.url))
  const names = ['dshmarket', 'dsh-skin-market', 'dsh-univer-office', 'deepseek-ivideo', '@xmanrui/dsh-im', 'dsh-find-plugin']
  const plugins = await Promise.all(names.map(async (name) => {
    const manifest = JSON.parse(await readFile(join(packageRoot, name, 'package.json'), 'utf8')) as {
      version: string
      description: string
      repository: { url: string }
    }
    const url = manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
    return { name, npm: name, owner: new URL(url).pathname.split('/')[1], url, version: manifest.version,
      description: { en: manifest.description }, category: 'product-integrations' }
  }))
  const registry = { updated: '2026-11-18', count: plugins.length,
    categories: { 'product-integrations': { zh: '产品已接入插件 · 只读验收样本', en: 'Product integrations · read-only review fixtures' } }, plugins }
  const externalReads: string[] = []
  const writesBlocked: string[] = []
  const reads: string[] = []
  const pages: unknown[] = []
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return originalFetch(input, init)
    externalReads.push(url.origin + url.pathname)
    return Response.json({ error: 'External reads are disabled in this isolated UI review' }, { status: 503 })
  })
  const overlay = join(directory, 'plaza.patch.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'ui-credits', disabled: true }, { id: 'ui-creative', disabled: true },
    { id: 'dsh-market', disabled: false }, { id: 'dsh-skin-market', disabled: true },
  ]))
  const scaffold = await launchWebScaffold({ profile: { hmr: false, packages: [] }, extraOverlayPath: overlay })
  cleanup.scaffold = () => scaffold.close()
  const browser = await chromium.launch()
  cleanup.browser = () => browser.close()
  for (const [scheme, width] of [['light', 1440], ['dark', 1440], ['light', 620], ['dark', 620]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: scheme, locale: ZH_BROWSER_LOCALE })
    try {
      const page = await context.newPage()
      const tripwire = watchConsole(page)
      await page.route('**/*', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.origin !== new URL(scaffold.baseUrl).origin) {
          await route.fulfill({ status: 404, body: '' })
          return
        }
        if (!url.pathname.startsWith('/dsh-market/')) { await route.continue(); return }
        if (request.method() === 'POST' && url.pathname === '/dsh-market/discovery-compatibility') {
          reads.push('FIXTURE POST ' + url.pathname)
          await route.fulfill({ json: { hostVersion: '0.2.1-alpha.2', plugins: {} } })
          return
        }
        if (request.method() !== 'GET') {
          writesBlocked.push(request.method() + ' ' + url.pathname)
          await route.fulfill({ status: 403, json: { error: 'Mutations are disabled in this read-only UI review' } })
          return
        }
        reads.push('GET ' + url.pathname)
        const response = url.pathname === '/dsh-market/registry' ? { registry, hostVersion: '0.2.1-alpha.2' }
          : url.pathname === '/dsh-market/installed' ? { installed: {}, live: [], disabled: [], favorites: [], groups: {}, groupOrder: [] }
            : url.pathname === '/dsh-market/updates' ? { updates: {} }
              : url.pathname === '/dsh-market/status' ? { version: '1.66.20', pnpm: true, busy: false, active: false,
                runningAgents: [], restart: false, restartReachable: false, boot: 'read-only-plaza-review', githubRoutes: { raw: [null], avatar: [null] } }
                : {}
        await route.fulfill({ json: response })
      })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: '广场', exact: true }).click()
      const frame = page.getByRole('region', { name: '广场', exact: true })
      await frame.waitFor({ state: 'visible' })
      const market = page.locator('[data-dsh-market-root]')
      await market.waitFor({ state: 'visible', timeout: 30_000 })
      await expect.poll(() => market.textContent()).toContain('dsh-univer-office')
      const search = market.getByRole('textbox', { name: /搜索插件/u })
      await search.fill('dsh-univer-office')
      await expect.poll(() => market.textContent()).not.toContain('dsh-find-plugin')
      await market.getByRole('button', { name: '清除搜索', exact: true }).click()
      expect(await search.inputValue()).toBe('')
      await assertReadableText(search, '::placeholder')
      const skin = plugins.find(plugin => plugin.name === 'dsh-skin-market')
      if (skin === undefined) throw new Error('The bundled skin-market fixture must exist')
      await assertReadableText(market.getByText(skin.description.en, { exact: true }))
      expect(await market.getByText('发现可在云枢中使用的社区插件', { exact: true }).count()).toBe(1)
      await expect.poll(() => market.textContent()).toContain('dsh-find-plugin')
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => { resolve() })
          })
        })
      })
      await page.screenshot({ path: join(evidence, `${scheme}-${width}.png`), animations: 'disabled' })
      const geometry = await market.evaluate(element => ({
        root: { x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y,
          width: element.clientWidth, height: element.clientHeight, scrollHeight: element.scrollHeight },
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
          viewportWidth: innerWidth, viewportHeight: innerHeight },
        scrollOwners: [element, ...element.querySelectorAll('*')].filter((item) => {
          const style = getComputedStyle(item)
          return /auto|scroll/.test(style.overflowY) && item.scrollHeight > item.clientHeight
        }).map(item => ({ tag: item.tagName, className: item.getAttribute('class') ?? '',
          clientHeight: item.clientHeight, scrollHeight: item.scrollHeight })),
      }))
      expect(geometry.root.width).toBeLessThanOrEqual(1120)
      expect(geometry.root.y).toBeGreaterThanOrEqual(28)
      expect(geometry.document.width).toBeLessThanOrEqual(width)
      expect(geometry.scrollOwners.length).toBeLessThanOrEqual(1)
      if (width === 620) {
        expect(geometry.scrollOwners).toHaveLength(1)
        const scrolled = await market.evaluate((element) => {
          const scroller = [...element.querySelectorAll('*')].find(item =>
            /auto|scroll/.test(getComputedStyle(item).overflowY) && item.scrollHeight > item.clientHeight)
          if (scroller === undefined) throw new Error('Expected the provider list to own overflow')
          scroller.scrollTop = scroller.scrollHeight
          return scroller.scrollTop
        })
        expect(scrolled).toBeGreaterThan(0)
        expect(await frame.evaluate(element => element.scrollTop)).toBe(0)
        expect(await page.evaluate(() => scrollY)).toBe(0)
      }
      // Exercise Desktop clearance in this isolated DOM without changing a user setting.
      if (scheme === 'light' && width === 1440) {
        await page.evaluate(() => { document.documentElement.dataset['platform'] = 'darwin' })
        await frame.evaluate((element) => { (element as HTMLElement).style.setProperty('--dsh-frame-top-clearance', '28px') })
        expect(await frame.evaluate(element => getComputedStyle(element).paddingTop)).toBe('44px')
      }
      pages.push({ scheme, width, geometry, pageErrors: tripwire.pageErrors, warnings: tripwire.warnings })
      await writeFile(join(evidence, `${scheme}-${width}.aria.txt`), await page.locator('body').ariaSnapshot())
      expect(tripwire.pageErrors).toEqual([])
    } finally { await context.close() }
  }
  expect(writesBlocked).toEqual([])
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify({
    fixtureOnly: true, provider: 'Actual bundled dshmarket@1.66.20',
    catalogBasis: 'Six actual package names, versions, repository URLs and descriptions read from installed product dependency manifests; no fabricated download counts or official logos.',
    rendering: 'Real provider inside the Plaza frame; external avatar requests blocked so the provider renders its own fallback.',
    writesBlocked, reads, externalReads, pages,
  }, null, 2))
}, 180_000)
