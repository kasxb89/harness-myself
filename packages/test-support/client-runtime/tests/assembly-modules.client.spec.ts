// @vitest-environment jsdom
/**
 * In-process module arrival: dynamic `/client` imports resolve through the
 * repository path aliases, provided rows replace them, the bootstrap row is the
 * static namespace, and the resulting module system serves the vendored Loader
 * without ever loading a bundle.
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import { parseBootManifest } from '@deepseek-ai/dsh-client-modules/client'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import * as uiRenderer from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as typertRegistry from '@deepseek-ai/dsh-typert-registry/client'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ClientRoster } from '../src/assembly/roster.ts'
import { MODULES_PACKAGE, createInProcessModules, loadPluginModules, readBundleRegistration } from '../src/assembly/modules.ts'

const RENDERER = '@deepseek-ai/dsh-client-ui-renderer'
const TYPERT = '@deepseek-ai/dsh-typert-registry'
const BRAND = '@deepseek-ai/dsh-client-ui-brand-official'
const MISSING = '@deepseek-ai/dsh-client-does-not-exist'

const row = (name: string, immediately = false) => ({ name, inject: [], immediately })

function graph(names: readonly string[]): WebBootGraph {
  return {
    rev: 'local',
    entries: names.map(id => ({ id, url: `plugins/${id}/client.js`, rev: 'local' })),
    batches: [{ phase: 'application', url: 'plugins/all.js', rev: 'local', entries: [...names] }],
  }
}

describe('loadPluginModules', () => {
  it('imports real rows dynamically, takes provided rows from the plan, and pins the bootstrap row', async () => {
    const provided = { apply: () => {} }
    const roster = ClientRoster.of([row(TYPERT), row(MODULES_PACKAGE), row(BRAND), row(RENDERER)])
    const modules = await loadPluginModules({ roster, provide: { [BRAND]: provided } })
    expect([...modules.keys()]).toEqual([TYPERT, MODULES_PACKAGE, BRAND, RENDERER])
    expect(modules.get(TYPERT)).toBe(typertRegistry)
    expect(modules.get(RENDERER)).toBe(uiRenderer)
    expect(modules.get(MODULES_PACKAGE)).toBe(modulesClient)
    expect(modules.get(BRAND)).toBe(provided)
  })

  it('prefixes the package name when a /client import fails', async () => {
    const roster = ClientRoster.of([row(MISSING)])
    await expect(loadPluginModules({ roster })).rejects.toThrow(
      new RegExp(`^client-test-runtime: cannot import ${MISSING}/client: .+`),
    )
  })

  it('refuses a provided bootstrap row', async () => {
    const roster = ClientRoster.of([row(MODULES_PACKAGE)])
    await expect(loadPluginModules({ roster, provide: { [MODULES_PACKAGE]: { apply: () => {} } } }))
      .rejects.toThrow(`${MODULES_PACKAGE} is the bootstrap module and cannot be provided`)
  })
})

describe('createInProcessModules', () => {
  it('serves import() and prefetch() from registered factories and never loads a bundle', async () => {
    const roster = ClientRoster.of([row(MODULES_PACKAGE, true), row(TYPERT, true), row(RENDERER)])
    const modules = await loadPluginModules({ roster })
    const system = createInProcessModules(graph(roster.rows.map(r => r.name)), modules)

    await expect(system.prefetch(TYPERT)).resolves.toBeUndefined()
    await expect(system.prefetch(RENDERER)).resolves.toBeUndefined()
    await expect(system.prefetch(MODULES_PACKAGE)).resolves.toBeUndefined()
    expect(system.loadCache.has(TYPERT)).toBe(false)
    expect(system.loadCache.has(RENDERER)).toBe(false)
    await expect(system.import(RENDERER, '', {})).resolves.toBe(uiRenderer)
    await expect(system.import(`${TYPERT}/client`, '', {})).resolves.toBe(typertRegistry)
    await expect(system.import(MODULES_PACKAGE, '', {})).resolves.toBe(modulesClient)
    expect(system.loadCache.get(TYPERT)?.exports).toBe(typertRegistry)
    expect(system.loadCache.get(RENDERER)?.exports).toBe(uiRenderer)
    await expect(system.import('@deepseek-ai/dsh-client-unknown', '', {})).rejects.toThrow('cannot resolve')
  })

  it('rejects loudly instead of fetching when a graph row has no loaded module', async () => {
    const system = createInProcessModules(graph(['ghost']), new Map())
    // The module system retries the batch once and then tries the row's one-resource URL; every attempt is refused.
    const first: unknown = await system.prefetch('ghost').then(() => undefined, (error: unknown) => error)
    if (!(first instanceof Error)) throw new Error('prefetch resolved')
    expect(first.message).toContain('in-process modules never load bundles (plugins/all.js)')
    expect(first.message).toContain('in-process modules never load bundles (plugins/ghost/client.js)')
    await expect(system.import('ghost', '', {})).rejects.toThrow('in-process modules never load bundles (plugins/ghost/client.js)')
  })

  it('exposes the graph parsed by the production validator as its manifest', () => {
    const raw = graph(['a', 'b'])
    expect(createInProcessModules(raw, new Map()).manifest).toEqual(parseBootManifest(raw))
    expect(() => createInProcessModules({ ...raw, batches: [] }, new Map())).toThrow('belongs to no initial-load batch')
  })

  it('boots the vendored Loader over the in-process table with every entry active', async () => {
    const roster = ClientRoster.of([row(TYPERT, true), row(RENDERER, true), row(MODULES_PACKAGE, true)])
    const modules = await loadPluginModules({ roster })
    const system = createInProcessModules(graph(roster.rows.map(r => r.name)), modules)
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Loader)
    ctx.loader.internal = system as never
    await Promise.all(roster.rows.map(r => ctx.loader.create({ name: r.name })))
    await ctx.loader.await()
    expect(ctx.get('typert')).toBeDefined()
    expect(ctx.get('slots')).toBeDefined()
    expect(ctx.get('modules')).toBe(system)
    expect([...ctx.loader.entries()].every(entry => entry.fiber !== undefined)).toBe(true)
  })
})

describe('published client bundles', () => {
  const filename = '/published/client.js'

  it('restores the page facade and materializes a real registration with the platform seed', async () => {
    const previous = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__')
    const registration = readBundleRegistration('published', `
      window.__ModuleLoader__.load({
        id: 'published',
        factory: require => ({ apply(ctx) { ctx.provide('publishedReact', require('react')) } }),
      })
    `, filename)
    expect(Object.getOwnPropertyDescriptor(window, '__ModuleLoader__')).toEqual(previous)
    const system = createInProcessModules(graph(['published']), new Map([['published', registration]]))
    expect(system.loadCache.has('published')).toBe(false)
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Loader)
    ctx.loader.internal = system as never
    await ctx.loader.create({ name: 'published' })
    await ctx.loader.await()
    expect(ctx.get('publishedReact')).toBeDefined()
  })

  it.each([
    "throw new Error('script failed')",
    "window.__ModuleLoader__.load({ id: 'different', factory: () => ({}) })",
    "window.__ModuleLoader__.load({ id: 'published', chunk: 'extra.js', factory: () => ({}) })",
    'window.__ModuleLoader__.create({})',
    `window.__ModuleLoader__.load({ id: 'published', factory: () => ({}) });
     window.__ModuleLoader__.load({ id: 'published', factory: () => ({}) })`,
  ])('restores an existing facade after an invalid bundle: %s', (source) => {
    const previous = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__')
    const marker = Object.freeze({ marker: true })
    Object.defineProperty(window, '__ModuleLoader__', { configurable: true, value: marker })
    try {
      expect(() => readBundleRegistration('published', source, filename)).toThrow()
      expect(Object.getOwnPropertyDescriptor(window, '__ModuleLoader__')?.value).toBe(marker)
    } finally {
      if (previous === undefined) Reflect.deleteProperty(window, '__ModuleLoader__')
      else Object.defineProperty(window, '__ModuleLoader__', previous)
    }
  })

  it('isolates repeated classic-script declarations from the global scope', async () => {
    const source = `
      const publishedBundleLexicalProbe = 'local'
      var publishedBundleVariableProbe = 'local'
      window.__ModuleLoader__.load({
        id: 'published',
        factory: () => ({ value: publishedBundleLexicalProbe + publishedBundleVariableProbe }),
      })
    `
    for (let attempt = 0; attempt < 2; attempt++) {
      const registration = readBundleRegistration('published', source, filename)
      const system = createInProcessModules(graph(['published']), new Map([['published', registration]]))
      await expect(system.import('published', '', {})).resolves.toEqual({ value: 'locallocal' })
      expect(Object.hasOwn(globalThis, 'publishedBundleVariableProbe')).toBe(false)
      expect(Object.hasOwn(window, 'publishedBundleVariableProbe')).toBe(false)
    }
  })

  it('propagates missing platform modules through the production factory loader', async () => {
    const registration = readBundleRegistration('published', `
      window.__ModuleLoader__.load({ id: 'published', factory: require => require('missing-platform-module') })
    `, filename)
    const system = createInProcessModules(graph(['published']), new Map([['published', registration]]))
    await expect(system.import('published', '', {})).rejects.toThrow('missed the module table')
  })
})
