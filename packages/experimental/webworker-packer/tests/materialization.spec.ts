/** Configured packages resolve through the complete declared dependency closure. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader.ts'
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
