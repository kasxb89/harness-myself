// @vitest-environment jsdom
/** Published skin UI waits for operator routing before requesting GitHub previews. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

afterEach(cleanup)

const require = createRequire(import.meta.url)
const skinRoot = dirname(require.resolve('dsh-skin-market/package.json'))
const proxy = 'https://downloads.example.test/github'

interface ClientCatalog {
  skins: Array<{
    id: string
    screenshots: string[]
    media?: { list: { preview: string } }
    starsSnapshot: number
  }>
}

interface SkinProps {
  t: (key: string) => string
  clientRuntime: { setActive(): Promise<boolean> }
  catalogCache: { read(): Promise<ClientCatalog['skins'] | null>; write(): Promise<void> }
}

interface SkinClient {
  SkinMarketSection: (props: SkinProps) => Parameters<typeof render>[0]
}

interface ReactFactory {
  createElement(component: SkinClient['SkinMarketSection'], props: SkinProps): Parameters<typeof render>[0]
}

interface ObserverFixture {
  observe(target: Element): void
  disconnect(): void
}

type ObserverConstructor = new (callback: (entries: Array<{ isIntersecting: boolean }>) => void) => ObserverFixture

// The external client factory consumes its published React modules; the bundle owns no React component source.
const React = await import(pathToFileURL(require.resolve('react')).href) as ReactFactory
const ReactDOM = await import(pathToFileURL(require.resolve('react-dom')).href) as Record<string, unknown>
const JSXRuntime = await import(pathToFileURL(require.resolve('react/jsx-runtime')).href) as Record<string, unknown>

function publishedClient(fetcher: (url: string, init?: RequestInit) => Promise<Response>, Observer?: ObserverConstructor): SkinClient {
  let client: SkinClient | undefined
  const dependencies: Record<string, unknown> = {
    react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': JSXRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': Primitives,
  }
  runInNewContext(readFileSync(join(skinRoot, 'client/client.js'), 'utf8'), {
    window: {
      location: window.location, history: window.history, localStorage: window.localStorage,
      setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
      addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
      __ModuleLoader__: { load: (registration: { factory(require: (name: string) => unknown): SkinClient }) => {
        client = registration.factory((name) => {
          if (!(name in dependencies)) throw new Error(`unexpected skin client dependency: ${name}`)
          return dependencies[name]
        })
      } },
    },
    document, navigator, URL, URLSearchParams, AbortController, fetch: fetcher, console, Date,
    setTimeout, clearTimeout, IntersectionObserver: Observer,
  })
  if (client === undefined) throw new Error('published skin client did not register')
  return client
}

function previewFixture(count = 1, intervalMs = 0, timeoutMs = 15000) {
  const catalog = JSON.parse(readFileSync(join(skinRoot, 'data/catalog.json'), 'utf8')) as ClientCatalog
  const first = catalog.skins[0]
  if (first === undefined) throw new Error('published skin catalog is empty')
  const skin = { ...first, screenshots: first.screenshots.slice(0, 1), marketScreenshots: [], githubStars: 0, recommendations: [] }
  const skins = Array.from({ length: count }, (_, index) => ({ ...skin, id: `${skin.id}-${index}` }))
  return {
    skin,
    fetcher: async (url: string): Promise<Response> => {
      if (url === '/dsh-skin-market/catalog') return Response.json({ githubProxy: proxy, previewPolicy: { concurrency: 2, intervalMs, timeoutMs }, skins })
      if (url === '/dsh-skin-market/state') return Response.json({ githubProxy: proxy, previewPolicy: { concurrency: 2, intervalMs, timeoutMs }, skins: [], operations: [] })
      if (url === '/dsh-skin-market/market-update') return Response.json({ updateAvailable: false, operation: null })
      if (url.endsWith('/skin-media/v1/manifest.json')) {
        return Response.json(Object.fromEntries(skin.screenshots.map(source => [source, 'fixture-digest'])))
      }
      throw new Error(`unexpected skin request: ${url}`)
    },
    props: {
      t: (key: string) => key, clientRuntime: { setActive: async () => false },
      catalogCache: { read: async () => null, write: async () => {} },
    },
  }
}

it('waits for the preview manifest instead of issuing original-image requests while it is pending', async () => {
  const fixture = previewFixture()
  const manifest = Promise.withResolvers<Response>()
  onTestFinished(() => { manifest.resolve(Response.json({})) })
  let requested = false
  const client = publishedClient(async (url) => {
    if (url.endsWith('/skin-media/v1/manifest.json')) { requested = true; return manifest.promise }
    return fixture.fetcher(url)
  })
  const { container } = render(React.createElement(client.SkinMarketSection, fixture.props))
  await waitFor(() => { expect(requested).toBe(true) })
  expect(container.querySelectorAll('img, link[rel="preload"][as="image"]')).toHaveLength(0)
  await act(async () => { manifest.resolve(Response.json(Object.fromEntries(fixture.skin.screenshots.map(source => [source, 'fixture'])))) })
  await waitFor(() => { expect(container.querySelectorAll('img')).toHaveLength(1) })
  expect(container.querySelector('img')?.getAttribute('src')).toContain('/skin-media/v1/')
})

it('requests only previews that enter the viewport and releases queued work when unmounted', async () => {
  const fixture = previewFixture()
  const observers: Array<{ enter(): void; disconnected: boolean }> = []
  class Observer implements ObserverFixture {
    readonly record: { enter(): void; disconnected: boolean }
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      this.record = { enter: () => { callback([{ isIntersecting: true }]) }, disconnected: false }
      observers.push(this.record)
    }
    observe() {}
    disconnect() { this.record.disconnected = true }
  }
  const client = publishedClient(fixture.fetcher, Observer)
  const { container, unmount } = render(React.createElement(client.SkinMarketSection, fixture.props))
  await waitFor(() => { expect(observers.length).toBeGreaterThan(0) })
  expect(container.querySelectorAll('img, link[rel="preload"][as="image"]')).toHaveLength(0)
  act(() => { observers[0]?.enter() })
  await waitFor(() => { expect(container.querySelectorAll('img')).toHaveLength(1) })
  unmount()
  expect(observers.every(observer => observer.disconnected)).toBe(true)
})

it('bounds simultaneous image loads and releases the next permit on load and error', async () => {
  const fixture = previewFixture(4)
  const client = publishedClient(fixture.fetcher)
  const { container, unmount } = render(React.createElement(client.SkinMarketSection, fixture.props))
  await waitFor(() => { expect(container.querySelectorAll('img')).toHaveLength(2) })
  const initial = [...container.querySelectorAll('img')]
  const first = initial[0]
  const second = initial[1]
  if (first === undefined || second === undefined) throw new Error('initial permits were not granted')
  fireEvent.load(first)
  await waitFor(() => { expect(container.querySelectorAll('img')).toHaveLength(3) })
  fireEvent.error(second)
  await waitFor(() => { expect(container.querySelectorAll('img')).toHaveLength(3) })
  // One completed image remains mounted, two unresolved images hold the only active permits.
  expect(container.querySelectorAll('img[data-loaded="true"]')).toHaveLength(1)
  unmount()
})

it('keeps already loaded previews when a manifest refresh fails or resolves after disposal', async () => {
  const fixture = previewFixture()
  const refresh = Promise.withResolvers<Response>()
  const aborted = Promise.withResolvers<Response>()
  onTestFinished(() => { refresh.resolve(Response.json({})); aborted.resolve(Response.json({})) })
  let manifests = 0
  const client = publishedClient(async (url) => {
    if (url.endsWith('/skin-media/v1/manifest.json')) {
      manifests += 1
      if (manifests === 2) return refresh.promise
      if (manifests === 3) return aborted.promise
    }
    return fixture.fetcher(url)
  })
  const first = render(React.createElement(client.SkinMarketSection, fixture.props))
  await waitFor(() => { expect(first.container.querySelectorAll('img')).toHaveLength(1) })
  const loaded = first.container.querySelector('img')
  if (loaded === null) throw new Error('preview did not render')
  fireEvent.load(loaded)
  const source = loaded.getAttribute('src')
  const second = render(React.createElement(client.SkinMarketSection, fixture.props))
  await waitFor(() => { expect(manifests).toBe(2) })
  expect(first.container.querySelector('img')?.getAttribute('src')).toBe(source)
  await act(async () => { refresh.resolve(new Response('temporary failure', { status: 502 })) })
  expect(first.container.querySelector('img')?.getAttribute('src')).toBe(source)
  second.unmount()
  const third = render(React.createElement(client.SkinMarketSection, fixture.props))
  await waitFor(() => { expect(manifests).toBe(3) })
  third.unmount()
  await act(async () => { aborted.resolve(Response.json({})) })
  expect(first.container.querySelector('img')?.getAttribute('src')).toBe(source)
})

it('spaces image starts using the host policy and cancels the queue timer on unmount', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const fixture = previewFixture(4, 1000)
  const client = publishedClient(fixture.fetcher)
  const { container, unmount } = render(React.createElement(client.SkinMarketSection, fixture.props))
  await act(async () => {})
  expect(container.querySelectorAll('img')).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(999) })
  expect(container.querySelectorAll('img')).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(container.querySelectorAll('img')).toHaveLength(2)
  const first = container.querySelector('img')
  if (first === null) throw new Error('preview did not render')
  fireEvent.load(first)
  await act(async () => { await vi.advanceTimersByTimeAsync(999) })
  expect(container.querySelectorAll('img')).toHaveLength(2)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['fetch', 'json'] as const)('bounds a stalled manifest %s even when it ignores abort and ignores its late result', async (stage) => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const fixture = previewFixture(1, 0, 1000)
  const stalled = Promise.withResolvers<undefined>()
  onTestFinished(() => { stalled.resolve(undefined) })
  let signal: AbortSignal | undefined | null
  const client = publishedClient(async (url, init) => {
    if (url.endsWith('/skin-media/v1/manifest.json')) {
      signal = init?.signal
      if (stage === 'fetch') { await stalled.promise; return Response.json({}) }
      const response = Response.json({})
      response.json = async () => { await stalled.promise; return {} }
      return response
    }
    return fixture.fetcher(url)
  })
  const { container, unmount } = render(React.createElement(client.SkinMarketSection, fixture.props))
  await act(async () => {})
  expect(signal?.aborted).toBe(false)
  expect(container.querySelectorAll('img')).toHaveLength(0)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(signal?.aborted).toBe(true)
  const image = container.querySelector('img')
  if (image === null) throw new Error('bounded manifest fallback did not render')
  const source = image.getAttribute('src')
  expect(source).toContain('/skin-media/v1/')
  fireEvent.load(image)
  await act(async () => { stalled.resolve(undefined) })
  expect(container.querySelector('img')?.getAttribute('src')).toBe(source)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('releases hung image permits at the deadline without automatically retrying failed images', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const fixture = previewFixture(4, 0, 1000)
  const client = publishedClient(fixture.fetcher)
  const { container, unmount } = render(React.createElement(client.SkinMarketSection, fixture.props))
  await act(async () => {})
  expect(container.querySelectorAll('img')).toHaveLength(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(container.querySelectorAll('[data-preview-failed="true"]')).toHaveLength(2)
  expect(container.querySelectorAll('img')).toHaveLength(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(container.querySelectorAll('[data-preview-failed="true"]')).toHaveLength(4)
  expect(container.querySelectorAll('img')).toHaveLength(0)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(container.querySelectorAll('img')).toHaveLength(0)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('distinguishes failed downloads from missing screenshots and retries only on the explicit user action', async () => {
  const fixture = previewFixture()
  const client = publishedClient(fixture.fetcher)
  const { container, getByRole } = render(React.createElement(client.SkinMarketSection, fixture.props))
  await waitFor(() => { expect(container.querySelectorAll('img')).toHaveLength(1) })
  const original = container.querySelector('img')
  if (original === null) throw new Error('preview did not render')
  fireEvent.error(original)
  await waitFor(() => { expect(container.querySelector('img')?.getAttribute('src')).toContain('raw.githubusercontent.com') })
  const fallback = container.querySelector('img')
  if (fallback === null) throw new Error('original screenshot did not render')
  fireEvent.error(fallback)
  await waitFor(() => { expect(container.textContent).toContain('previewLoadFailed') })
  expect(container.querySelectorAll('img')).toHaveLength(0)
  expect(container.querySelectorAll('[data-preview-failed="true"]')).toHaveLength(1)
  expect(container.querySelector('[data-preview-failed="true"]')?.textContent).toMatchInlineSnapshot('"previewLoadFailedpreviewRetryHint"')
  fireEvent.click(getByRole('button', { name: 'retryPreviews' }))
  await waitFor(() => { expect(container.querySelectorAll('img')).toHaveLength(1) })
  expect(container.querySelector('img')?.getAttribute('src')).toContain('/skin-media/v1/')
})

it('loads its manifest and rendered preview URLs through the operator prefix without editing catalog values', async () => {
  const catalog = JSON.parse(readFileSync(join(skinRoot, 'data/catalog.json'), 'utf8')) as ClientCatalog
  const skin = catalog.skins[0]
  if (skin === undefined || skin.media === undefined) throw new Error('published skin fixture has no generated preview')
  const canonical = structuredClone(skin)
  const calls: string[] = []
  let release!: () => void
  const configured = new Promise<void>((resolve) => { release = resolve })
  onTestFinished(release)
  const fetcher = vi.fn(async (url: string) => {
    calls.push(url)
    if (url === '/dsh-skin-market/catalog') {
      await configured
      return Response.json({
        githubProxy: proxy, previewPolicy: { concurrency: 2, intervalMs: 0, timeoutMs: 15000 },
        skins: [{ ...skin, githubStars: skin.starsSnapshot, recommendations: [] }],
      })
    }
    if (url === '/dsh-skin-market/state') {
      await configured
      return Response.json({
        githubProxy: proxy, previewPolicy: { concurrency: 2, intervalMs: 0, timeoutMs: 15000 }, skins: [], operations: [],
      })
    }
    if (url === '/dsh-skin-market/market-update') return Response.json({ updateAvailable: false, operation: null })
    if (url === `${proxy}/https://kingofsoysauce.github.io/dsh-skin-market/skin-media/v1/manifest.json`) {
      return Response.json(Object.fromEntries(skin.screenshots.map(source => [source, 'fixture-digest'])))
    }
    throw new Error(`unexpected skin request: ${url}`)
  })
  let client: SkinClient | undefined
  const dependencies: Record<string, unknown> = {
    react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': JSXRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': Primitives,
  }
  runInNewContext(readFileSync(join(skinRoot, 'client/client.js'), 'utf8'), {
    window: {
      location: window.location, history: window.history, localStorage: window.localStorage,
      setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
      addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
      __ModuleLoader__: { load: (registration: { factory(require: (name: string) => unknown): SkinClient }) => {
        client = registration.factory((name) => {
          if (!(name in dependencies)) throw new Error(`unexpected skin client dependency: ${name}`)
          return dependencies[name]
        })
      } },
    },
    document, navigator, URL, URLSearchParams, AbortController, fetch: fetcher, console,
    setTimeout, clearTimeout,
  })
  if (client === undefined) throw new Error('published skin client did not register')
  const { container } = render(React.createElement(client.SkinMarketSection, {
    t: key => key,
    clientRuntime: { setActive: async () => false },
    catalogCache: { read: async () => [{ ...skin, githubStars: skin.starsSnapshot, recommendations: [] }], write: async () => {} },
  }))
  await waitFor(() => { expect(calls).toContain('/dsh-skin-market/state') })
  expect(container.querySelectorAll('img, link[rel="preload"][as="image"]')).toHaveLength(0)
  expect(calls.filter(url => url.startsWith('https://'))).toEqual([])
  release()
  await waitFor(() => { expect(container.querySelectorAll('img').length).toBeGreaterThan(0) })
  for (const image of container.querySelectorAll('img')) {
    expect(image.getAttribute('src')).toMatch(/^https:\/\/downloads\.example\.test\/github\/https:\/\//)
  }
  expect(calls).toContain(`${proxy}/https://kingofsoysauce.github.io/dsh-skin-market/skin-media/v1/manifest.json`)
  expect(calls.filter(url => url.startsWith('https://'))).toEqual([
    `${proxy}/https://kingofsoysauce.github.io/dsh-skin-market/skin-media/v1/manifest.json`,
  ])
  expect(skin).toEqual(canonical)
})
