import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { prepareDevelopmentApp } from '../scripts/development-app.ts'

const commands = vi.hoisted((): { unregisterError?: Error; registerError?: Error } => ({}))
beforeEach(() => { commands.unregisterError = undefined; commands.registerError = undefined; vi.clearAllMocks() })

vi.mock('node:child_process', async (original) => {
  const module = await original<typeof import('node:child_process')>()
  const { cpSync } = await import('node:fs')
  return { ...module, execFileSync: vi.fn((file: string, args: readonly string[]) => {
    if (file.endsWith('/lsregister') && args[0] === '-u' && commands.unregisterError !== undefined) throw commands.unregisterError
    if (file.endsWith('/lsregister') && args[0] === '-f' && commands.registerError !== undefined) throw commands.registerError
    if (file === '/usr/bin/ditto') cpSync(args[0]!, args[1]!, { recursive: true })
    return Buffer.alloc(0)
  }) }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zhishu-development-brand-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const electron = join(root, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  mkdirSync(join(root, 'Electron.app', 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(root, 'Electron.app', 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(root, 'Electron.app', 'Contents', 'Info.plist'), '<plist/>')
  mkdirSync(join(root, 'resources'))
  writeFileSync(join(root, 'resources', 'icon-macos.icns'), 'first icon')
  const previous = join(root, 'Harness Dev.app')
  mkdirSync(join(previous, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(previous, 'Contents', 'Resources', 'dsh-development.json'), '{}')
  const options = { electron, appRoot: root, directory: root, home: join(root, 'home'), userData: join(root, 'user-data'),
    primaryRuntimeDirectory: join(root, 'runtime', 'primary-runtime'), mainPort: 9229, rendererPort: 9222, hostPort: 9230,
    openDevtools: '0' }
  return { root, previous, options }
}

it('brands the development bundle, preserves old data and refreshes when the icon or runtime changes', () => {
  const { root, previous, options } = fixture()
  const executable = prepareDevelopmentApp(options)
  expect(executable).toBe(join(root, '智澍科技.app', 'Contents', 'MacOS', 'HarnessDev'))
  expect(readFileSync(join(root, '智澍科技.app', 'Contents', 'Resources', 'Zhishu.icns'), 'utf8')).toBe('first icon')
  expect(execFileSync).toHaveBeenCalledWith('/usr/bin/plutil', expect.arrayContaining(['CFBundleDisplayName', '"智澍科技"']))
  expect(execFileSync).toHaveBeenCalledWith('/usr/bin/plutil', expect.arrayContaining(['CFBundleIconFile', '"Zhishu.icns"']))
  const copies = () => vi.mocked(execFileSync).mock.calls.filter(call => call[0] === '/usr/bin/ditto').length
  expect(copies()).toBe(1)
  prepareDevelopmentApp(options)
  expect(copies()).toBe(1)
  writeFileSync(join(root, 'resources', 'icon-macos.icns'), 'new icon')
  prepareDevelopmentApp(options)
  expect(copies()).toBe(2)
  expect(readFileSync(join(root, '智澍科技.app', 'Contents', 'Resources', 'Zhishu.icns'), 'utf8')).toBe('new icon')
  prepareDevelopmentApp({ ...options, primaryRuntimeDirectory: join(root, 'another-runtime', 'primary-runtime') })
  expect(copies()).toBe(3)
  expect(readFileSync(executable, 'utf8')).toContain('another-runtime')
  expect(readFileSync(join(previous, 'Contents', 'Resources', 'dsh-development.json'), 'utf8')).toBe('{}')
  expect(execFileSync).toHaveBeenCalledWith(expect.stringContaining('lsregister'), ['-u', previous])
})


it.each(['stdout', 'stderr'] as const)('launches the new bundle when obsolete registration is absent: %s', (channel) => {
  const { root, previous, options } = fixture()
  commands.unregisterError = Object.assign(new Error('Command failed: lsregister'), {
    status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    [channel]: Buffer.from(`failed to scan ${previous}: -10814\n from spotlight\n`),
  })
  const executable = prepareDevelopmentApp(options)
  expect(readFileSync(executable, 'utf8')).toContain('DSH_DESKTOP_DEV_APP')
  expect(execFileSync).toHaveBeenCalledWith(expect.stringContaining('lsregister'), ['-f', join(root, '智澍科技.app')])
  expect(readFileSync(join(previous, 'Contents', 'Resources', 'dsh-development.json'), 'utf8')).toBe('{}')
})

it.each([
  { name: 'another Launch Services error', status: 1, diagnostic: '-600' },
  { name: 'a different process failure', status: 127, diagnostic: '-10814' },
  { name: 'additional diagnostic failure', status: 1, diagnostic: '-10814\n from spotlight\npermission denied' },
])('preserves fatal obsolete unregistration errors: $name', ({ status, diagnostic }) => {
  const { previous, options } = fixture()
  const failure = Object.assign(new Error('lsregister failed'), {
    status, stdout: Buffer.from(`failed to scan ${previous}: ${diagnostic}\n from spotlight\n`), stderr: Buffer.alloc(0),
  })
  commands.unregisterError = failure
  expect(() => prepareDevelopmentApp(options)).toThrow(failure)
  expect(readFileSync(join(previous, 'Contents', 'Resources', 'dsh-development.json'), 'utf8')).toBe('{}')
})

it('still rejects a missing registration error when registering the current bundle', () => {
  const { root, options } = fixture()
  const failure = Object.assign(new Error('lsregister failed'), { status: 1,
    stdout: Buffer.from(`failed to scan ${join(root, '智澍科技.app')}: -10814\n from spotlight\n`), stderr: Buffer.alloc(0) })
  commands.registerError = failure
  expect(() => prepareDevelopmentApp(options)).toThrow(failure)
  expect(execFileSync).not.toHaveBeenCalledWith(expect.stringContaining('lsregister'), ['-u', join(root, 'Harness Dev.app')])
})
