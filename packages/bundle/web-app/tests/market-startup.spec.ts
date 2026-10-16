/** Marketplace Host import and effect lifecycle through the shipped Web group. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { apply } from '../src/startup.ts'

const extensionIds = [
  'dsh-market', 'dsh-skin-market', 'find-dsh-plugin', 'xmanrui-dsh-im',
  'univer', 'ipollowork-video-studio', 'dream-skin',
]

afterEach(() => {
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/** Mount the shipped group with observable substitutes for external plugin implementations. */
async function bootExtensions(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-startup-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const observed: { imports: string[]; active: string[]; released: string[]; exits: number[] } = {
    imports: [], active: [], released: [], exits: [],
  }
  Object.assign(globalThis, { __marketStartupObserved: observed, __marketStartupApply: apply })
  const patches = ['../../base/cordis.patch.yml', '../cordis.patch.yml'].flatMap(path =>
    loadOverlayPatches('market-startup', fileURLToPath(new URL(path, import.meta.url))))
  const rows = applyEntryPatches([], patches, (message) => { throw new Error(message) })
  const group = rows.find(row => row.id === 'product-extensions')
  if (group === undefined) throw new Error('Web bundle has no product extensions group')
  const extensions = group.config as EntryOptions[]
  expect(extensions.map(row => row.id)).toEqual(extensionIds)
  for (const row of extensions) {
    const file = join(dir, `${row.id}.mjs`)
    writeFileSync(file, `
globalThis.__marketStartupObserved.imports.push(${JSON.stringify(row.id)})
export function apply(ctx) {
  ctx.effect(() => {
    const id = ctx.fiber.entry.id
    globalThis.__marketStartupObserved.active.push(id)
    return () => { globalThis.__marketStartupObserved.released.push(id) }
  })
}
`)
    row.name = pathToFileURL(file).href
  }
  const provider = join(dir, 'provider.mjs')
  writeFileSync(provider, `
export const name = 'web-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__marketStartupApply(ctx)
`)
  const config = join(dir, 'cordis.json')
  writeFileSync(config, JSON.stringify([group, { id: 'web-startup', name: pathToFileURL(provider).href }]))
  const output = { write: () => true }
  internals.stdout = output
  internals.stderr = output
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  provideCmdline(ctx, { args, exit: (code) => { observed.exits.push(code) } })
  const includeId = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  return { ctx, observed, includeId }
}

it.each([
  { args: ['--help'], code: 0 },
  { args: ['--port', 'invalid'], code: 1 },
])('skips marketplace Host imports for $args', async ({ args, code }) => {
  const { observed } = await bootExtensions(args)
  expect(observed.exits).toEqual([code])
  expect(observed.imports).toEqual([])
  expect(observed.active).toEqual([])
})

it('activates every marketplace Host with its existing id after accepting Web arguments and releases its effects', async () => {
  const { ctx, observed, includeId } = await bootExtensions(['--no-open'])
  expect(observed.exits).toEqual([])
  expect(observed.imports.toSorted()).toEqual(extensionIds.toSorted())
  const ids = extensionIds.map(id => `${includeId}:${id}`).toSorted()
  expect(observed.active.toSorted()).toEqual(ids)
  for (const id of extensionIds) expect(ctx.loader.resolve(`${includeId}:${id}`).options.id).toBe(id)
  await ctx.fiber.dispose()
  expect(observed.released.toSorted()).toEqual(ids)
})
