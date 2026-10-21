/** Static Page libraries do not become implicit Worker entrypoints. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, type TestContext } from 'vitest'
import { WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader.ts'
import { inflateImage } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/image-gzip.ts'
import { loadVfsImage } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { DEFAULT_ROOT, packVfsImage } from '../src/pack.ts'
import { staticPagePackages } from '../src/repository.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const SUBJECT = '@deepseek-ai/dsh-client-store'
const storeDirectory = fileURLToPath(new URL('../../../client/store/', import.meta.url))

/** Materialize the real store manifest beside a tiny Host and its unused Cordis peer. */
function fixture(test: TestContext, hostSource = 'export const value = 42') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-store-image-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const directory = join(root, 'store')
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), readFileSync(join(storeDirectory, 'package.json')))
  symlinkSync(join(storeDirectory, 'node_modules'), join(directory, 'node_modules'), 'junction')
  writeFileSync(join(directory, 'lib/index.js'), `
    import { createStore } from 'zustand/vanilla'
    import { subscribeWithSelector } from 'zustand/middleware'
    import { shallow } from 'zustand/shallow'
    import { produce, freeze } from 'immer'
    export const engine = { createStore, subscribeWithSelector, shallow, produce, freeze }
  `)
  const workspaces = new Map([[SUBJECT, directory]])
  for (const [name, source] of [
    ['@deepseek-ai/cordis', 'export const value = 1'],
    ['@deepseek-ai/dsh-image-store-host', hostSource],
  ]) {
    const target = join(root, name.split('/').at(-1)!)
    mkdirSync(join(target, 'lib'), { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({
      name, type: 'module', files: ['lib'], exports: { '.': './lib/index.js' },
      ...(name.endsWith('store-host') ? { dependencies: { [SUBJECT]: '*' } } : {}),
    }))
    writeFileSync(join(target, 'lib/index.js'), source)
    workspaces.set(name, target)
  }
  return {
    config: "- id: host\n  name: '@deepseek-ai/dsh-image-store-host'\n",
    profile: 'store-dependency-check', workspaces, resolveFrom: root, entries: [],
  }
}

it('keeps the static Page engine out of automatic Worker roots while the Host remains executable', async (test) => {
  const pagePackages = await staticPagePackages(repoRoot)
  expect(pagePackages.has(SUBJECT)).toBe(true)
  const packed = packVfsImage({ ...fixture(test), pagePackages })
  expect(packed.missing).toEqual([])
  expect(Object.keys(packed.files)).not.toContain(`node_modules/${SUBJECT}/lib/index.js`)
  expect(packed.packages.has('zustand')).toBe(false)
  expect(packed.packages.has('immer')).toBe(false)
  const vfs = loadVfsImage(await inflateImage(packed.image, 'the Host without static Page roots'), DEFAULT_ROOT)
  const loader = new WorkerModuleLoader({ vfs, root: DEFAULT_ROOT, staticModules: {} })
  expect(loader.requireFrom(`${DEFAULT_ROOT}/workspace`)('@deepseek-ai/dsh-image-store-host')).toEqual({ value: 42 })
  expect(loader.usage().modules).toBe(1)
})

it('still refuses all four missing dependencies when Host code explicitly imports the Page engine', (test) => {
  const options = fixture(test, `export { engine } from '${SUBJECT}'`)
  expect(() => packVfsImage({ ...options, pagePackages: new Set([SUBJECT]) }))
    .toThrow(/4 unresolvable module request\(s\)/)
  for (const specifier of ['zustand/vanilla', 'zustand/middleware', 'zustand/shallow', 'immer']) {
    expect(() => packVfsImage({ ...options, pagePackages: new Set([SUBJECT]) })).toThrow(`"${specifier}"`)
  }
})

it('still refuses a Page engine explicitly requested by the Worker assembly', (test) => {
  expect(() => packVfsImage({ ...fixture(test), pagePackages: new Set([SUBJECT]), entries: [SUBJECT] }))
    .toThrow(/4 unresolvable module request\(s\)/)
})

it('refuses mounting a static Page library as a Worker plugin row', (test) => {
  expect(() => packVfsImage({ ...fixture(test), config: `- name: '${SUBJECT}'\n`, pagePackages: new Set([SUBJECT]) }))
    .toThrow(`static Page package ${SUBJECT} cannot be a Worker plugin row`)
})
