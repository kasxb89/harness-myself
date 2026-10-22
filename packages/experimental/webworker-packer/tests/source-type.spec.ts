/** Explicit extensions, package scopes, and exact ESM entries select one parser goal without retrying. */
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

function fixture(
  test: TestContext, entry: string, type?: string, nestedType?: string, source = legacy,
  manifest: Record<string, unknown> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-source-type-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(dirname(join(root, entry)), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: SUBJECT, type, files: ['lib'], exports: { '.': `./${entry}` }, ...manifest,
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

function load(options: Parameters<typeof packVfsImage>[0]): unknown {
  const packed = packVfsImage(options)
  const vfs = new MemoryVfs()
  for (const [path, bytes] of Object.entries(packed.files)) {
    if (!path.endsWith('/')) vfs.seed(`${DEFAULT_ROOT}/${path}`, bytes)
  }
  const loader = new WorkerModuleLoader({ vfs, root: DEFAULT_ROOT, staticModules: {} })
  return loader.requireFrom(DEFAULT_ROOT)(SUBJECT)
}

it.for([
  ['lib/index.js', undefined, undefined],
  ['lib/index.js', 'commonjs', undefined],
  ['lib/index.cjs', 'module', undefined],
  ['lib/index.js', 'module', 'commonjs'],
] as const)('retains CommonJS legacy escapes under scope %j', ([entry, type, nestedType], test) => {
  const { root, options } = fixture(test, entry, type, nestedType)
  const actual = load(options)
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

it('lowers only the exact declared module entry while retaining its CommonJS neighbours', (test) => {
  const { root, options } = fixture(test, 'lib/browser.js', undefined, undefined,
    "import legacy from './legacy.js'; import cjs from './node.cjs'; export const value = legacy + cjs;", {
      main: './lib/node.cjs', module: './lib/../lib/browser.js',
      exports: { '.': { import: { default: './lib/browser.js' }, require: { default: './lib/node.cjs' } } },
    })
  writeFileSync(join(root, 'lib/legacy.js'), legacy)
  writeFileSync(join(root, 'lib/node.cjs'), 'module.exports = "commonjs"')
  expect(load(options)).toMatchObject({ value: '\x1b[40mcommonjs' })
})

it.for([
  ['lib/index.cjs', undefined, undefined, './lib/index.cjs'],
  ['lib/index.js', 'commonjs', undefined, './lib/index.js'],
  ['lib/index.js', undefined, 'commonjs', './lib/index.js'],
  ['lib/index.js', undefined, '', './lib/index.js'],
  ['lib/index.js', undefined, undefined, './lib/other.js'],
  ['lib/index.js', undefined, undefined, { browser: './lib/index.js' }],
] as const)('does not broaden module declarations past explicit file or scope boundaries %j',
  ([entry, type, nestedType, module], test) => {
    const { options } = fixture(test, entry, type, nestedType, 'export const value = 1', { module })
    expect(() => packVfsImage(options)).toThrow('parse failed')
  })

it('does not infer ESM from an import condition alone', (test) => {
  const { options } = fixture(test, 'lib/index.js', undefined, undefined, legacy, {
    exports: { '.': { import: './lib/index.js' } },
  })
  expect(load(options)).toBe('\x1b[40m')
})

it('stops an outer module entry declaration at a nested scope without type', (test) => {
  const { root, options } = fixture(test, 'lib/index.js', undefined, undefined, 'export const value = 1', {
    module: './lib/index.js',
  })
  writeFileSync(join(root, 'lib/package.json'), '{}')
  expect(() => packVfsImage(options)).toThrow('parse failed')
})
