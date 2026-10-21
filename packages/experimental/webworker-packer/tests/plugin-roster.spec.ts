/** Configured third-party plugins remain executable after the image reachability sweep. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader.ts'
import { MemoryVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { DEFAULT_ROOT, packVfsImage, type PackOptions } from '../src/pack.ts'

function fixture(test: TestContext, plugin: string, missingEntry = false): PackOptions {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-plugin-entry-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const packageName = plugin.startsWith('@') ? plugin.split('/').slice(0, 2).join('/') : plugin.split('/')[0] ?? plugin
  const directory = join(root, 'node_modules', packageName)
  const files = {
    'package.json': JSON.stringify({ name: packageName, type: 'module',
      exports: { '.': './lib/index.js', './host': './lib/host.js' } }),
    'lib/index.js': "export { value } from './shared.js'",
    'lib/host.js': "export { value } from './shared.js'",
    'lib/shared.js': "export const value = 'configured-plugin'",
    'lib/unused.js': "throw new Error('unreachable')",
  }
  for (const [relative, source] of Object.entries(files)) {
    if (missingEntry && relative === 'lib/index.js') continue
    const path = join(directory, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  return {
    config: `- name: 'cordis:group'\n  config:\n    - name: '${plugin}'\n`,
    profile: 'plugin-entry-check', resolveFrom: root, entries: [], workspaces: new Map(),
  }
}

it.for(['plain-plugin', '@fixture/scoped-plugin', 'plain-plugin/host'])(
  'loads the composed third-party entry %s and prunes unrelated JavaScript', (plugin, test) => {
    const result = packVfsImage(fixture(test, plugin))
    expect(result.missing).toEqual([])
    expect(result.roster).toEqual([plugin.startsWith('@') ? plugin : 'plain-plugin'])
    const vfs = new MemoryVfs()
    for (const [path, bytes] of Object.entries(result.files)) {
      if (!path.endsWith('/')) vfs.seed(`${DEFAULT_ROOT}/${path}`, bytes)
    }
    const loader = new WorkerModuleLoader({ vfs, root: DEFAULT_ROOT, staticModules: {} })
    expect(loader.requireFrom(DEFAULT_ROOT)(plugin)).toEqual({ value: 'configured-plugin' })
    expect(Object.keys(result.files).some(path => path.endsWith('/lib/unused.js'))).toBe(false)
    if (plugin.endsWith('/host')) {
      expect(Object.keys(result.files).some(path => path.endsWith('/lib/index.js'))).toBe(false)
    }
  },
)

it('rejects a configured plugin whose published entry is absent', (test) => {
  expect(() => packVfsImage(fixture(test, 'plain-plugin', true))).toThrow('composed plugin plain-plugin')
})
