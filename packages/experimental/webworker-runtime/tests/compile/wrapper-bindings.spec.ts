/** ESM locals retain their own scope while generated operations use the injected Worker services. */
import { expect, test } from 'vitest'
import { lowerModuleSource } from '../../src/compile/transform.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

function load(source: string, data = 'module.exports = { value: "injected" }') {
  const vfs = new MemoryVfs()
  const result = lowerModuleSource({ filename: '/vfs/main.mjs', source, sourceType: 'module' })
  vfs.seed('/vfs/main.mjs', result.code)
  vfs.seed('/vfs/data.cjs', data)
  const calls: string[] = []
  const loader = new WorkerModuleLoader({ vfs, root: '/vfs', staticModules: {
    'node:module': () => ({ createRequire: (base: string) => { calls.push(base); return loader.createRequire(base) } }),
  } })
  return { exports: loader.requireFrom('/vfs')('./main.mjs') as Record<string, unknown>, result, calls }
}

test('loads ESM const bindings named after every wrapper parameter through the real Worker loader', async () => {
  const source = `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), exports = 'source exports', module = 'source module';
const __filename = 'source filename', __dirname = 'source dirname', __dsh$meta = 'source meta', __als = 'source als';
export { exports, module, __filename, __dirname, __dsh$meta, __als };
export const dependency = require('./data.cjs');
export async function dynamic() { return (await import('./data.cjs')).default }
export default 'default export';`
  const loaded = load(source)
  expect(loaded.exports).toMatchObject({ exports: 'source exports', module: 'source module', __filename: 'source filename',
    __dirname: 'source dirname', __dsh$meta: 'source meta', __als: 'source als', dependency: { value: 'injected' }, default: 'default export' })
  expect(await (loaded.exports.dynamic as () => Promise<unknown>)()).toEqual({ value: 'injected' })
  expect(loaded.calls).toEqual(['file:///vfs/main.mjs'])
  expect(loaded.result.moduleRequests).toEqual(['node:module', './data.cjs'])
})

test('keeps source var hoisting separate from injected wrapper parameters and top-level this undefined', () => {
  const loaded = load(`export const before = [require, exports, module, __filename, __dirname];
var require = 'local require', exports = 'local exports', module = 'local module', __filename = 'local filename', __dirname = 'local dirname';
export const after = [require, exports, module, __filename, __dirname]; export const self = this;`)
  expect(loaded.exports.before).toEqual([undefined, undefined, undefined, undefined, undefined])
  expect(loaded.exports.after).toEqual(['local require', 'local exports', 'local module', 'local filename', 'local dirname'])
  expect(loaded.exports.self).toBeUndefined()
})

test('keeps generated imports reexports and export-all independent of a source require and exports binding', async () => {
  const loaded = load(`import imported from './data.cjs';
const require = () => { throw new Error('source require must not run') }, exports = 'local';
export { value as reexported } from './data.cjs'; export * from './data.cjs'; export * as namespace from './data.cjs';
export const valueFromImport = imported.value; export { exports };
export async function dynamic() { return (await import('./data.cjs')).default.value }`)
  expect(loaded.exports).toMatchObject({ reexported: 'injected', value: 'injected', valueFromImport: 'injected', exports: 'local', namespace: { value: 'injected' } })
  expect(await (loaded.exports.dynamic as () => Promise<unknown>)()).toBe('injected')
})

test('avoids generated alias helper and temporary names already present in source nested scopes', async () => {
  const loaded = load(`import imported from './data.cjs';
const __dsh$require = 'alias', __dsh$exports = 'exports', __dsh$def = 'helper', __dsh$m1 = 'temporary';
export const names = [__dsh$require, __dsh$exports, __dsh$def, __dsh$m1];
export function nested() { const __dsh$ns = 'namespace'; return __dsh$ns }
export async function dynamic() { return (await import('./data.cjs')).default.value }
export default imported.value`)
  expect(loaded.exports.names).toEqual(['alias', 'exports', 'helper', 'temporary'])
  expect((loaded.exports.nested as () => unknown)()).toBe('namespace')
  expect(await (loaded.exports.dynamic as () => Promise<unknown>)()).toBe('injected')
})

test.each(['', '\n'])('preserves a trailing EOF line comment without changing line count: %j', (ending) => {
  const source = `export const value = 42; // source tail${ending}`
  const loaded = load(source)
  expect(loaded.exports.value).toBe(42)
  expect(loaded.result.code.split('\n')).toHaveLength(source.split('\n').length)
})

test('keeps an await suffix at the final expression boundary before a trailing comment', async () => {
  const source = 'export const value = async () => await Promise.resolve(42) // final comment'
  const loaded = load(source)
  expect(await (loaded.exports.value as () => Promise<unknown>)()).toBe(42)
  expect(loaded.result.code.split('\n')).toHaveLength(source.split('\n').length)
})

test('keeps generated module helpers outside source Object and Promise bindings', async () => {
  const loaded = load(`import * as namespace from './data.cjs';
const Object = 'source Object', Promise = 'source Promise'; export { Object, Promise };
export async function dynamic() { return (await import('./data.cjs')).default.value }
export const value = namespace.value`)
  expect(loaded.exports).toMatchObject({ Object: 'source Object', Promise: 'source Promise', value: 'injected' })
  expect(await (loaded.exports.dynamic as () => globalThis.Promise<unknown>)()).toBe('injected')
})

test('keeps CommonJS bodies on their existing wrapper path', () => {
  const source = 'module.exports = "\\033"'
  const result = lowerModuleSource({ filename: '/vfs/main.cjs', source, sourceType: 'script' })
  expect(result.code).toBe(source)
  expect(result.lowered).toBe(false)
})
