/** Configured packages resolve through the complete declared dependency closure. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { WorkerModuleLoader } from '../../webworker-runtime/src/module-system/module-loader.ts'
import { inflateImage } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/image-gzip.ts'
import { loadVfsImage } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { DEFAULT_ROOT, packVfsImage, type PackOptions } from '../src/pack.ts'

const PLUGIN = '@fixture/bundle-plugin'
const BUNDLE = '@fixture/selected-bundle'
const UNRELATED = '@fixture/unrelated-bundle'
const MISSING = '@fixture/missing-dependency'

function fixture(
  test: TestContext,
  installed = true,
  extraDependencies: Record<string, string> = {},
): { options: PackOptions; pluginManifest: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-materialization-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const selected = join(root, 'selected')
  const unrelated = join(root, 'unrelated')
  const writePackage = (
    directory: string, name: string, version: string, source: string,
    dependencies: Record<string, string> = {},
  ): void => {
    mkdirSync(join(directory, 'lib'), { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name, version, type: 'module', files: ['lib'], exports: { '.': './lib/index.js' }, dependencies,
    }))
    writeFileSync(join(directory, 'lib/index.js'), source)
  }
  writePackage(unrelated, UNRELATED, '1.0.0', 'export const unrelated = true')
  writePackage(join(unrelated, 'node_modules', PLUGIN), PLUGIN, '1.0.0', "export const value = 'unrelated-v1'")
  writePackage(selected, BUNDLE, '2.0.0', installed
    ? `export { value } from '${PLUGIN}'`
    : 'export const value = null', { [PLUGIN]: '2.0.0', ...extraDependencies })
  const pluginDirectory = join(selected, 'node_modules', PLUGIN)
  if (installed) writePackage(pluginDirectory, PLUGIN, '2.0.0', "export const value = 'selected-v2'")
  return {
    options: {
      config: `- name: '${PLUGIN}'\n- name: '${BUNDLE}'\n`,
      profile: 'materialization-check', resolveFrom: root, entries: [],
      workspaces: new Map([[UNRELATED, unrelated], [BUNDLE, selected]]),
    },
    pluginManifest: join(pluginDirectory, 'package.json'),
  }
}

it('loads a configured plugin from its declaring bundle when the plugin appears first', async (test) => {
  const { options } = fixture(test)
  const result = packVfsImage(options)
  expect(result.missing).toEqual([])
  expect(result.packages.has(UNRELATED)).toBe(false)
  const manifest = result.files[`node_modules/${PLUGIN}/package.json`]
  expect(manifest).toBeDefined()
  expect(JSON.parse(new TextDecoder().decode(manifest))).toMatchObject({ version: '2.0.0' })
  const vfs = loadVfsImage(await inflateImage(result.image, 'the selected bundle dependency'), DEFAULT_ROOT)
  const loader = new WorkerModuleLoader({ vfs, root: DEFAULT_ROOT, staticModules: {} })
  expect(loader.requireFrom(`${DEFAULT_ROOT}/workspace`)(PLUGIN)).toEqual({ value: 'selected-v2' })
})

it('reports a missing plugin even when an unrelated bundle has another version', (test) => {
  const result = packVfsImage(fixture(test, false).options)
  expect(result.missing).toEqual([
    `${PLUGIN} (from .)`,
    `${PLUGIN} (from selected)`,
  ])
  expect(result.packages.has(PLUGIN)).toBe(false)
  expect(result.packages.has(UNRELATED)).toBe(false)
})

it('retains a separate missing dependency after resolving the configured plugin', (test) => {
  const result = packVfsImage(fixture(test, true, { [MISSING]: '1.0.0' }).options)
  expect(result.packages.has(PLUGIN)).toBe(true)
  expect(result.missing).toEqual([`${MISSING} (from selected)`])
})

it('propagates an invalid manifest reached through the declaring bundle', (test) => {
  const { options, pluginManifest } = fixture(test)
  writeFileSync(pluginManifest, '{')
  expect(() => packVfsImage(options)).toThrow(SyntaxError)
})


/** Two importer-specific versions, each with a different transitive binding. */
function versionFixture(test: TestContext): { options: PackOptions; firstEntry: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-versions-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const write = (name: string, directory: string, source: string, dependencies: string[], extra = false): void => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name, version: extra ? '2.0.0' : '1.0.0', type: extra ? 'module' : 'commonjs',
      exports: extra ? { '.': './index.js', './decode': './decode.js' } : { '.': './index.js' },
      dependencies: Object.fromEntries(dependencies.map(dependency => [dependency, '*'])),
    }))
    writeFileSync(join(directory, 'index.js'), source)
    if (extra) writeFileSync(join(directory, 'decode.js'), "export default 'version-two-decoder'")
  }
  const a = join(root, 'a'); const b = join(root, 'b')
  const one = join(root, 'codec-one'); const two = join(root, 'codec-two')
  const helperOne = join(root, 'helper-one'); const helperTwo = join(root, 'helper-two')
  write('first', a, "module.exports = require('codec')", ['codec'])
  write('second', b, "module.exports = { codec: require('codec'), decoded: require('codec/decode').default }", ['codec'])
  write('codec', one, "const legacyOctal = 010; exports.version = 'one'; exports.helper = require('helper').value", ['helper'])
  write('codec', two, "import helperModule from 'helper'; export const version = 'two'; export const helper = helperModule.value; export const back = () => helperModule.parent()", ['helper'], true)
  write('helper', helperOne, "exports.value = 'helper-one'", [])
  write('helper', helperTwo, "exports.value = 'helper-two'; exports.parent = () => require('codec').version", ['codec'])
  for (const [consumer, name, target] of [
    [a, 'codec', one], [b, 'codec', two], [one, 'helper', helperOne],
    [two, 'helper', helperTwo], [helperTwo, 'codec', two],
  ] as const) {
    mkdirSync(join(consumer, 'node_modules'), { recursive: true })
    symlinkSync(target, join(consumer, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
  }
  return {
    options: { config: '- name: first\n- name: second\n', profile: 'version-bindings',
      resolveFrom: root, entries: [], workspaces: new Map([['first', a], ['second', b]]) },
    firstEntry: join(a, 'index.js'),
  }
}

it('keeps conflicting versions, strict subpaths, transitives and a cycle at the actual importer', async (test) => {
  const { options } = versionFixture(test)
  const result = packVfsImage(options)
  expect(result.missing).toEqual([])
  expect(result.workspacePackages).toBe(2)
  expect(result.packages.has('node_modules/second/node_modules/codec')).toBe(true)
  const vfs = loadVfsImage(await inflateImage(result.image, 'two installed dependency versions'), DEFAULT_ROOT)
  const require = new WorkerModuleLoader({ vfs, root: DEFAULT_ROOT, staticModules: {} }).requireFrom(`${DEFAULT_ROOT}/workspace`)
  expect(require('first')).toMatchObject({ version: 'one', helper: 'helper-one' })
  const second = require('second') as { codec: { version: string; helper: string; back(): string }; decoded: string }
  expect(second).toMatchObject({ codec: { version: 'two', helper: 'helper-two' }, decoded: 'version-two-decoder' })
  expect(second.codec.back()).toBe('two')
  expect(() => require('codec/decode')).toThrow('does not export')
})

it('still rejects a subpath absent from its own version despite another exported version', async (test) => {
  const { options, firstEntry } = versionFixture(test)
  writeFileSync(firstEntry, "module.exports = require('codec/decode')")
  const result = packVfsImage(options)
  const vfs = loadVfsImage(await inflateImage(result.image, 'strict nearest exports'), DEFAULT_ROOT)
  const require = new WorkerModuleLoader({ vfs, root: DEFAULT_ROOT, staticModules: {} }).requireFrom(`${DEFAULT_ROOT}/workspace`)
  expect(() => require('first')).toThrow('does not export')
})
