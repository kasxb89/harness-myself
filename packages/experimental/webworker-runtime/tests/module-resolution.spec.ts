/** Nearest installed package identity and strict exports remain inside the image. */
import { expect, it } from 'vitest'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'
import { MemoryVfs } from '../src/storage/memory.ts'

it('locks scoped requests to the nearest manifest and never falls back after export refusal', () => {
  const vfs = new MemoryVfs()
  for (const [directory, value, extra] of [
    ['/dsh/node_modules/@scope/codec', 'global', true],
    ['/dsh/node_modules/outer/node_modules/@scope/codec', 'nested', false],
  ] as const) {
    vfs.seedDirectory(directory)
    vfs.writeFileSync(`${directory}/package.json`, JSON.stringify({ exports: extra
      ? { '.': './index.cjs', './secret': './index.cjs' } : { '.': './index.cjs' } }))
    vfs.writeFileSync(`${directory}/index.cjs`, `module.exports = '${value}'`)
  }
  const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: {} })
  const require = loader.requireFrom('/dsh/node_modules/outer/lib')
  expect(require('@scope/codec')).toBe('nested')
  expect(() => require('@scope/codec/secret')).toThrow('does not export')
  expect(require.resolve.paths('@scope/codec')).toEqual([
    '/dsh/node_modules/outer/lib/node_modules', '/dsh/node_modules/outer/node_modules', '/dsh/node_modules',
  ])
  expect(() => loader.resolve('@scope/codec', '/dsh-other')).toThrow('outside image root')
})

it('supports the public slash root while keeping lookup inside it', () => {
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/node_modules/codec')
  vfs.writeFileSync('/node_modules/codec/package.json', '{"main":"index.cjs"}')
  vfs.writeFileSync('/node_modules/codec/index.cjs', 'module.exports = 7')
  const require = new WorkerModuleLoader({ vfs, root: '/', staticModules: {} }).requireFrom('/work')
  expect(require('codec')).toBe(7)
  expect(require.resolve.paths('codec')).toEqual(['/work/node_modules', '/node_modules'])
})
