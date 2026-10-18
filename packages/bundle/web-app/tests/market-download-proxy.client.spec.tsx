// @vitest-environment jsdom
/** Published skin UI waits for operator routing before requesting GitHub previews. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { cleanup, render, waitFor } from '@testing-library/react'
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

// The external client factory consumes its published React modules; the bundle owns no React component source.
const React = await import(pathToFileURL(require.resolve('react')).href) as ReactFactory
const ReactDOM = await import(pathToFileURL(require.resolve('react-dom')).href) as Record<string, unknown>
const JSXRuntime = await import(pathToFileURL(require.resolve('react/jsx-runtime')).href) as Record<string, unknown>

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
      return Response.json({ githubProxy: proxy, skins: [{ ...skin, githubStars: skin.starsSnapshot, recommendations: [] }] })
    }
    if (url === '/dsh-skin-market/state') {
      await configured
      return Response.json({ githubProxy: proxy, skins: [], operations: [] })
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
