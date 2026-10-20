/** Published marketplace routing keeps canonical catalogs while operator routes survive user preferences. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished, vi } from 'vitest'

const require = createRequire(import.meta.url)
const marketRoot = dirname(require.resolve('dshmarket/package.json'))
const skinRoot = dirname(require.resolve('dsh-skin-market/package.json'))
const proxy = 'https://downloads.example.test/github'

interface MarketRegions {
  validateConfiguredGithubProxy(value: string): string
  useConfiguredGithubProxy(value: string): () => void
  setCustomGithubProxy(value: string | null): void
  routesFor(region: 'global' | 'china', env?: Record<string, string>): {
    githubProxy: string | null
    npmRegistry: string
    githubRoutes: { raw: Array<string | null>; git: Array<string | null>; avatar: Array<string | null> }
  }
  githubProxyManaged(env?: Record<string, string>): boolean
  throughProxy(proxy: string | null, url: string): string
}

interface SkinGithubProxy {
  normalizeGithubProxy(value: string | undefined): string | undefined
  githubResourceUrl(url: string, proxy: string | undefined | null): string
  normalizePreviewPolicy(value?: {
    concurrency?: number
    intervalMs?: number
    timeoutMs?: number
  }): { concurrency: number; intervalMs: number; timeoutMs: number }
}

interface SkinCatalog {
  schemaVersion: number
  generatedAt: string
  skins: Array<{ id: string; screenshots: string[]; install: { target: string; commit: string } }>
}

interface CatalogSnapshot {
  catalog: SkinCatalog
  source: string
  error?: string
}

interface SkinCatalogModule {
  REMOTE_CATALOG_URL: string
  loadCatalog(): SkinCatalog
  CatalogStore: new (directory: string, options?: {
    githubProxy?: string
    remoteUrl?: string
    fetcher: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
  }) => { snapshot(): CatalogSnapshot; refresh(force?: boolean): Promise<CatalogSnapshot> }
}

const regions = await import(pathToFileURL(join(marketRoot, 'lib/regions.js')).href) as MarketRegions
const skinProxy = await import(pathToFileURL(join(skinRoot, 'lib/github-proxy.js')).href) as SkinGithubProxy
const skinCatalog = await import(pathToFileURL(join(skinRoot, 'lib/catalog.js')).href) as SkinCatalogModule
const skinRoutes = await import(pathToFileURL(join(skinRoot, 'lib/routes.js')).href) as Pick<typeof import('dsh-skin-market'), 'mountRoutes'>

it('validates screenshot concurrency and pacing before mounting either public route', () => {
  expect(skinProxy.normalizePreviewPolicy()).toEqual({ concurrency: 2, intervalMs: 1000, timeoutMs: 15000 })
  expect(skinProxy.normalizePreviewPolicy({ concurrency: 6, intervalMs: 0 })).toEqual({ concurrency: 6, intervalMs: 0, timeoutMs: 15000 })
  for (const invalid of [
    { concurrency: 0 }, { concurrency: 7 }, { concurrency: 1.5 },
    { timeoutMs: 999 }, { timeoutMs: 60001 }, { timeoutMs: 1000.5 }, { intervalMs: -1 }, { intervalMs: 5001 }, { intervalMs: Number.NaN },
  ]) expect(() => skinProxy.normalizePreviewPolicy(invalid)).toThrow(/preview/)
})

it('publishes the same validated screenshot policy through the actual catalog and state handlers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yunshu-skin-preview-routes-'))
  const ctx = new Context()
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
  const server = createServer((request, response) => {
    const handler = routes.get(new URL(request.url ?? '/', 'http://localhost').pathname)
    if (handler === undefined) { response.writeHead(404); response.end(); return }
    Promise.resolve(handler(request, response)).catch(() => { response.writeHead(500); response.end() })
  })
  const networkFetch = globalThis.fetch
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (target === `${proxy}/${skinCatalog.REMOTE_CATALOG_URL}`) return Response.json(skinCatalog.loadCatalog())
    throw new Error(`unexpected public request: ${target}`)
  })
  let disposeRoutes: ReturnType<typeof skinRoutes.mountRoutes> | undefined
  onTestFinished(async () => {
    try {
      await disposeRoutes?.()
      await ctx.fiber.dispose()
      server.closeIdleConnections()
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    } finally { fetcher.mockRestore(); rmSync(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(Loader)
  disposeRoutes = skinRoutes.mountRoutes({
    loader: { entries: () => ctx.loader.entries() },
    webServer: { register: (route) => {
      routes.set(route.path, (request, response) => route.handler(request, response))
      return () => { routes.delete(route.path) }
    } },
  }, {
    profile: 'private-preview-test', profileDir: root, githubProxy: proxy,
    previewPolicy: { concurrency: 3, intervalMs: 250, timeoutMs: 5000 },
    runner: async () => { throw new Error('read-only preview routes must not run commands') },
  })
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => { reject(error) }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => { server.off('error', fail); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('private fixture did not bind')
  for (const path of ['catalog', 'state']) {
    const response = await networkFetch(`http://127.0.0.1:${address.port}/dsh-skin-market/${path}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ githubProxy: proxy, previewPolicy: { concurrency: 3, intervalMs: 250, timeoutMs: 5000 } })
  }
  await disposeRoutes()
  disposeRoutes = undefined
  expect(routes.size).toBe(0)
})

it.each([
  '', 'http://downloads.example.test/github', 'https://user:password@downloads.example.test',
  'https://downloads.example.test/path?token=secret', 'https://downloads.example.test/path#fragment',
  ' https://downloads.example.test', 'https://downloads.example.test/a b',
  'https://downloads.example.test/\npath', 'https://downloads.example.test/\\path',
  `https://downloads.example.test/${'a'.repeat(2048)}`,
])('rejects an invalid operator prefix before activating routes: %j', (value) => {
  expect(() => regions.validateConfiguredGithubProxy(value)).toThrow(/githubProxy/)
  expect(() => skinProxy.normalizeGithubProxy(value)).toThrow(/githubProxy/)
})

it('overrides saved global and China routes without changing npm or canonical GitHub values', () => {
  const before = regions.routesFor('global', {})
  regions.setCustomGithubProxy('https://previous.example.test')
  onTestFinished(() => { regions.setCustomGithubProxy(null) })
  const release = regions.useConfiguredGithubProxy(`${proxy}/`)
  onTestFinished(release)
  for (const region of ['global', 'china'] as const) {
    const route = regions.routesFor(region, { DSHM_GITHUB_PROXY: 'https://legacy-env.example.test' })
    expect(route.githubProxy).toBe(proxy)
    expect(route.githubRoutes.raw[0]).toBe(proxy)
    expect(route.githubRoutes.avatar[0]).toBe(proxy)
    expect(route.githubRoutes.git[0]).toBe(proxy)
  }
  expect(regions.githubProxyManaged({})).toBe(true)
  expect(regions.routesFor('global', {}).npmRegistry).toBe(before.npmRegistry)
  const canonical = 'https://raw.githubusercontent.com/owner/repository/0123456/README.md'
  expect(regions.throughProxy(regions.routesFor('global', {}).githubProxy, canonical)).toBe(`${proxy}/${canonical}`)
  release()
  expect(regions.routesFor('global', {}).githubProxy).toBe('https://previous.example.test')
})

it('keeps a newer Loader activation in control when an older market is disposed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yunshu-market-proxy-loader-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { rmSync(root, { recursive: true, force: true }) }
  })
  const file = join(root, 'cordis.json')
  writeFileSync(file, JSON.stringify([
    { id: 'market-first', name: pathToFileURL(join(marketRoot, 'lib/index.js')).href, config: { githubProxy: proxy } },
    { id: 'market-second', name: pathToFileURL(join(marketRoot, 'lib/index.js')).href, config: { githubProxy: `${proxy}/second` } },
  ]))
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const includeId = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  expect(regions.routesFor('global', {}).githubProxy).toBe(`${proxy}/second`)
  await ctx.loader.resolve(`${includeId}:market-first`).fiber?.dispose()
  expect(regions.routesFor('global', {}).githubProxy).toBe(`${proxy}/second`)
  await ctx.fiber.dispose()
  expect(regions.githubProxyManaged({})).toBe(false)
})

it('prefixes known skin resources while leaving unrelated URLs and canonical strings untouched', () => {
  const resources = [
    'https://raw.githubusercontent.com/owner/skin/main/catalog.json',
    'https://avatars.githubusercontent.com/u/123?s=64',
    'https://github.com/owner/skin/raw/main/preview.png',
    'https://kingofsoysauce.github.io/dsh-skin-market/skin-media/v1/manifest.json',
  ]
  for (const canonical of resources) {
    expect(skinProxy.githubResourceUrl(canonical, proxy)).toBe(`${proxy}/${canonical}`)
    expect(skinProxy.githubResourceUrl(canonical, undefined)).toBe(canonical)
  }
  for (const untouched of [
    'https://example.test/preview.png', 'https://not-github.com/preview.png',
    'https://other.github.io/preview.png', 'https://kingofsoysauce.github.io/unrelated/preview.png',
    'http://raw.githubusercontent.com/owner/skin/main/catalog.json',
    'https://secret@raw.githubusercontent.com/owner/skin/main/catalog.json',
    'github:owner/skin#0123456789012345678901234567890123456789',
  ]) expect(skinProxy.githubResourceUrl(untouched, proxy)).toBe(untouched)
})

it('downloads the skin catalog via the prefix and preserves pinned-source rejection and the accepted cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yunshu-skin-proxy-catalog-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const bundled = skinCatalog.loadCatalog()
  const accepted = structuredClone(bundled)
  accepted.generatedAt = new Date(Date.parse(bundled.generatedAt) + 1000).toISOString()
  let remote = accepted
  const calls: Array<{ url: string; signal: boolean }> = []
  const store = new skinCatalog.CatalogStore(root, {
    githubProxy: proxy,
    fetcher: async (url, init) => {
      calls.push({ url, signal: init.signal instanceof AbortSignal })
      return { ok: true, status: 200, json: async () => remote }
    },
  })
  const snapshot = await store.refresh(true)
  expect(calls).toEqual([{ url: `${proxy}/${skinCatalog.REMOTE_CATALOG_URL}`, signal: true }])
  expect(snapshot.source).toBe('remote')
  expect(snapshot.catalog.skins).toEqual(accepted.skins)
  const cachePath = join(root, '.dsh-skin-market/catalog.json')
  const cache = readFileSync(cachePath, 'utf8')
  expect(cache).not.toContain(proxy)
  const invalid = structuredClone(accepted)
  invalid.generatedAt = new Date(Date.parse(accepted.generatedAt) + 1000).toISOString()
  const first = invalid.skins[0]
  if (first === undefined) throw new Error('published skin catalog is empty')
  first.install.target = `${proxy}/https://github.com/attacker/changed-source`
  remote = invalid
  const rejected = await store.refresh(true)
  expect(rejected.error).toMatch(/invalid.*(target|skin entry)/)
  expect(rejected.catalog).toEqual(snapshot.catalog)
  expect(readFileSync(cachePath, 'utf8')).toBe(cache)
})
