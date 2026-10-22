/** Manifest-declared Page artifacts survive packaging without Worker lowering or directory-wide retention. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { packVfsImage, type PackOptions } from '../src/pack.ts'

const page = "exports.render = async () => await Promise.resolve('page');\n"
const chunk = "exports.lazy = () => import('page-only-module');\n"
const prefix = 'node_modules/skin-fixture/'

function fixture(test: TestContext, target: unknown = './client/client.js', clientMetadata = true, missing = false): PackOptions {
  const root = mkdtempSync(join(tmpdir(), 'dsh-page-export-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const files = {
    'package.json': JSON.stringify({ name: 'skin-fixture', type: 'module', exports: { '.': './lib/index.js', './client': target },
      ...clientMetadata ? { dsh: { client: { inject: [] } } } : {} }),
    'lib/index.js': 'export const name = "skin-fixture"',
    'client/client.js': page,
    'client/client.lazy.js': chunk,
    'client/server.js': 'throw new Error("not a Page chunk")',
    'other/client.lazy.js': 'throw new Error("different directory")',
  }
  for (const [relative, source] of Object.entries(files)) {
    if (missing && relative === 'client/client.js') continue
    const path = join(root, 'node_modules/skin-fixture', relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  return { config: '- name: skin-fixture\n', profile: 'client-assets', entries: [], workspaces: new Map(), resolveFrom: root }
}

it.for(['./client/client.js', { types: './types/client.d.ts', default: './client/client.js' }])(
  'keeps a declared client entry and supported sibling chunks as Page bytes %j', (target, test) => {
    const result = packVfsImage(fixture(test, target))
    expect([...result.pageBundles].sort()).toEqual([`${prefix}client/client.js`, `${prefix}client/client.lazy.js`])
    for (const [path, source] of [['client/client.js', page], ['client/client.lazy.js', chunk]] as const) {
      const packed = new TextDecoder().decode(result.files[prefix + path])
      expect(packed.slice(0, packed.indexOf('//# sourceURL='))).toBe(source + '\n')
      expect(packed).not.toContain('__als')
    }
    expect(result.files[`${prefix}client/server.js`]).toBeUndefined()
    expect(result.files[`${prefix}other/client.lazy.js`]).toBeUndefined()
    expect(result.transform.visited).toBe(1)
  },
)

it('does not preserve a non-conventional client path without client metadata', (test) => {
  const result = packVfsImage(fixture(test, './client/client.js', false))
  expect(result.pageBundles).toEqual([])
  expect(result.files[`${prefix}client/client.js`]).toBeUndefined()
})

it('fails when a declared Page bundle is missing instead of silently pruning it', (test) => {
  expect(() => packVfsImage(fixture(test, './client/client.js', true, true))).toThrow('missing ./client bundle')
})

it('rejects a Page export outside its package instead of retaining another package file', (test) => {
  expect(() => packVfsImage(fixture(test, './../other/client.js'))).toThrow('invalid ./client export')
})
