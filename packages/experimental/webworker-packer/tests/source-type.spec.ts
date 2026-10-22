/** Packed files use their Node extension and nearest package scope, without retrying another parser goal. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader.ts'
import { MemoryVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { DEFAULT_ROOT, packVfsImage } from '../src/pack.ts'

const SUBJECT = '@fixture/source-type'
const legacy = 'module.exports = "\\033[40m"\n'

function fixture(test: TestContext, entry: string, type?: string, nestedType?: string, source = legacy) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-source-type-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(dirname(join(root, entry)), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: SUBJECT, type, files: ['lib'], exports: { '.': `./${entry}` },
  }))
  writeFileSync(join(root, entry), source)
  if (nestedType !== undefined) writeFileSync(join(root, 'lib/package.json'), JSON.stringify({ type: nestedType }))
  return {
    root,
    options: {
      config: `- name: '${SUBJECT}'\n`, profile: 'source-type-check', entries: [],
      workspaces: new Map([[SUBJECT, root]]), resolveFrom: root,
    },
  }
}

it.for([
  ['lib/index.js', undefined, undefined],
  ['lib/index.js', 'commonjs', undefined],
  ['lib/index.cjs', 'module', undefined],
  ['lib/index.js', 'module', 'commonjs'],
] as const)('retains CommonJS legacy escapes under scope %j', ([entry, type, nestedType], test) => {
  const { root, options } = fixture(test, entry, type, nestedType)
  const packed = packVfsImage(options)
  const vfs = new MemoryVfs()
  for (const [path, bytes] of Object.entries(packed.files)) {
    if (!path.endsWith('/')) vfs.seed(`${DEFAULT_ROOT}/${path}`, bytes)
  }
  const loader = new WorkerModuleLoader({ vfs, root: DEFAULT_ROOT, staticModules: {} })
  const actual = loader.requireFrom(DEFAULT_ROOT)(SUBJECT)
  const expected: unknown = createRequire(import.meta.url)(join(root, entry))
  expect(actual).toBe('\x1b[40m')
  expect(actual).toBe(expected)
})

it.for([
  ['lib/index.js', 'module', undefined],
  ['lib/index.mjs', 'commonjs', undefined],
  ['lib/index.js', 'commonjs', 'module'],
] as const)('refuses legacy escapes in ESM scope %j', ([entry, type, nestedType], test) => {
  const { root, options } = fixture(test, entry, type, nestedType)
  expect(() => packVfsImage(options)).toThrow('Octal literal in strict mode')
  expect(() => { createRequire(import.meta.url)(join(root, entry)) }).toThrow()
})

it('honors an explicit strict directive inside CommonJS', (test) => {
  const { options } = fixture(test, 'lib/index.js', 'commonjs', undefined, '"use strict";\n' + legacy)
  expect(() => packVfsImage(options)).toThrow('Octal literal in strict mode')
})

it('refuses ESM syntax in explicitly CommonJS files without changing parser goals', (test) => {
  const { options } = fixture(test, 'lib/index.cjs', 'module', undefined, 'export const value = 1')
  expect(() => packVfsImage(options)).toThrow('parse failed')
})
