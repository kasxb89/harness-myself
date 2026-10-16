/**
 * In-process module arrival: import source rows through their `/client` aliases,
 * capture installed bundles' published factories, and register both on the
 * production `ClientModuleSystem` before boot. Loader imports and stage-one
 * prefetches use that table without fetching bundles.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/modules
 */
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import { createClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import type { ClientBundleRegistration, ClientModuleLoader, ClientModuleLoaderTarget, DshWindow, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import { getStaticModules } from '@deepseek-ai/dsh-client-web/src/seed.ts'
import type { PublishedStyleLease } from './published-styles.ts'
import type { AssemblyPlan, ClientPluginModule } from './roster.ts'

/** The bootstrap row: always this process's static namespace, never a dynamic import or a `provide` replacement. */
export const MODULES_PACKAGE = '@deepseek-ai/dsh-client-modules'

/** A source namespace or a published classic-script bundle factory. */
export type ClientPluginArrival = ClientPluginModule | ClientBundleRegistration

const localRequire = createRequire(import.meta.url)
const bundleRequire = createRequire(localRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
const workspacePackages = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * Resolve each roster row to its source namespace or published factory.
 * `plan.provide[name]` replaces ordinary rows; workspace imports use Vitest's
 * source aliases, and external packages resolve from the product bundle.
 * The bootstrap row retains its statically imported namespace.
 * @param plan - validated plan.
 * @param styles - optional lifetime owner for styles inserted by published bundles.
 * @returns package name → module, in roster order.
 * @throws {Error} when an import fails (the package name prefixes the original message) or the bootstrap row is provided.
 */
export async function loadPluginModules(
  plan: AssemblyPlan,
  styles?: PublishedStyleLease,
): Promise<ReadonlyMap<string, ClientPluginArrival>> {
  const modules = new Map<string, ClientPluginArrival>()
  for (const { name } of plan.roster.rows) {
    const provided = plan.provide?.[name]
    if (name === MODULES_PACKAGE) {
      if (provided !== undefined) {
        throw new Error(`client-test-runtime: ${MODULES_PACKAGE} is the bootstrap module and cannot be provided`)
      }
      modules.set(name, modulesClient)
      continue
    }
    modules.set(name, provided ?? await importClient(name, styles))
  }
  return modules
}

async function importClient(name: string, styles?: PublishedStyleLease): Promise<ClientPluginArrival> {
  try {
    let manifest: string | undefined
    try {
      manifest = realpathSync(bundleRequire.resolve(`${name}/package.json`))
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)
        || (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED')) throw error
    }
    const path = manifest === undefined ? undefined : relative(workspacePackages, manifest)
    if (path === undefined || (!path.startsWith(`..${sep}`) && !path.startsWith(sep))) {
      return await import(/* @vite-ignore */ `${name}/client`) as ClientPluginModule
    }
    const clientFile = bundleRequire.resolve(`${name}/client`)
    const source = readFileSync(clientFile, 'utf8')
    if (!/\bwindow\.__ModuleLoader__\.load\s*\(/u.test(source)) {
      return await import(/* @vite-ignore */ pathToFileURL(clientFile).href) as ClientPluginModule
    }
    return readBundleRegistration(name, source, clientFile, styles)
  } catch (error) {
    throw new Error(`client-test-runtime: cannot import ${name}/client: ${String(error)}`, { cause: error })
  }
}

function isBundleExecutor(value: unknown): value is (target: Window) => void {
  return typeof value === 'function'
}

/**
 * Execute one published script with a temporary registration facade; its factory stays lazy.
 * @param name - expected package registration id.
 * @param source - installed client bundle JavaScript.
 * @param filename - bundle path used in execution diagnostics.
 * @param styles - optional lifetime owner for script-level plugin styles.
 * @returns the package's unmaterialized factory.
 */
export function readBundleRegistration(
  name: string,
  source: string,
  filename: string,
  styles?: PublishedStyleLease,
): ClientBundleRegistration {
  if (typeof window === 'undefined') throw new Error('published client bundles require jsdom')
  const target: Window & DshWindow = window
  const previous = Object.getOwnPropertyDescriptor(target, '__ModuleLoader__')
  const registrations: ClientBundleRegistration[] = []
  const facade: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue: registrations,
    load: (registration) => { registrations.push(registration) },
    create: () => { throw new Error('client-test-runtime: a plugin bundle cannot bootstrap the module system') },
  }
  Object.defineProperty(target, '__ModuleLoader__', { configurable: true, value: facade })
  try {
    // Keep classic-script declarations local while giving factories the real page facade.
    const execute: unknown = new Script(`(function (window) {\n${source}\n})`, { filename }).runInThisContext()
    if (!isBundleExecutor(execute)) throw new Error('client-test-runtime: invalid published bundle executor')
    if (styles === undefined) execute(window)
    else styles.capture(name, () => { execute(window) })
  } finally {
    if (previous === undefined) Reflect.deleteProperty(target, '__ModuleLoader__')
    else Object.defineProperty(target, '__ModuleLoader__', previous)
  }
  const registration = registrations[0]
  if (registrations.length !== 1 || registration?.id !== name || registration.chunk !== undefined) {
    throw new Error(`client-test-runtime: ${name}/client must register exactly its own package factory`)
  }
  return registration
}

/**
 * Build the production module system over source namespaces and published
 * factories. The bootstrap row uses `bootstrapModule`; the real platform seed
 * supplies shared React and UI dependencies to published factories. Missing
 * factories reject through `loadBundle` without fetching.
 * @param graph - raw boot graph from `graphFromRoster`; `createClientModuleSystem` parses it.
 * @param modules - loaded plugin modules keyed by package name.
 * @param styles - optional lifetime owner for styles inserted while factories materialize.
 * @returns module system to install as `loader.internal`; its `manifest` is the parsed graph.
 */
export function createInProcessModules(
  graph: WebBootGraph,
  modules: ReadonlyMap<string, ClientPluginArrival>,
  styles?: PublishedStyleLease,
): ClientModuleLoader {
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue: [],
    /* v8 ignore next -- construction replaces this sink before draining the prefilled queue. */
    load: () => { throw new Error('client-test-runtime: module facade is not initialized') },
    create: options => createClientModuleSystem(target, { id: MODULES_PACKAGE, exports: modulesClient }, options),
  }
  for (const [id, namespace] of modules) {
    if (id === MODULES_PACKAGE) continue
    target.pendingQueue.push('factory' in namespace
      ? { ...namespace, factory: require => styles === undefined
        ? namespace.factory(require)
        : styles.capture(id, () => namespace.factory(require)) }
      : { id, factory: () => namespace as unknown as Record<string, unknown> })
  }
  return target.create({
    boot: graph,
    staticModules: getStaticModules(),
    loadBundle: url => Promise.reject(new Error(`client-test-runtime: in-process modules never load bundles (${url})`)),
  })
}
