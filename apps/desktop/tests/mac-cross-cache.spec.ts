import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { macCrossRuntimeKey, recordMacCrossRuntime, reuseMacCrossRuntime, seedMacCrossDependencyCache, verifyMacCrossShellVersions } from '../scripts/mac-cross-cache.ts'
import { prepareDesktopDependencyCache } from '../scripts/desktop-dependency-cache.ts'
import { writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'
import { materializeMacShellPlan } from '../scripts/mac-cross-shell.ts'

it('materializes a hoisted dependency plan without following cyclic pnpm package links', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'mac-cross-shell-cycle-'))
  try {
    const source = join(temporary, 'source')
    const output = join(temporary, 'output')
    mkdirSync(source)
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'shell', version: '1.0.0', dependencies: { example: '1.0.0' } }))
    const modules = ['example', 'other'].map(name => ({ name, version: '1.0.0', dir: join(source, 'node_modules', name) }))
    for (const module of modules) {
      mkdirSync(join(module.dir, 'node_modules'), { recursive: true })
      writeFileSync(join(module.dir, 'package.json'), JSON.stringify({ name: module.name, version: module.version, files: ['index.js', 'lib/', '!lib/ignored.js'], dependencies: { [module.name === 'example' ? 'other' : 'example']: '1.0.0' } }))
      writeFileSync(join(module.dir, 'index.js'), `export const name = '${module.name}'`)
      mkdirSync(join(module.dir, 'lib'))
      writeFileSync(join(module.dir, 'lib/included.js'), 'export const included = true')
      writeFileSync(join(module.dir, 'lib/ignored.js'), 'export const omitted = true')
      writeFileSync(join(module.dir, '.env'), 'private fixture')
    }
    symlinkSync(modules[1]!.dir, join(modules[0]!.dir, 'node_modules/other'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(modules[0]!.dir, join(modules[1]!.dir, 'node_modules/example'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(materializeMacShellPlan(source, output, modules)).toEqual({ packages: 3, requiredEdges: 3 })
    expect(existsSync(join(output, 'node_modules/example/index.js'))).toBe(true)
    expect(existsSync(join(output, 'node_modules/example/lib/included.js'))).toBe(true)
    expect(existsSync(join(output, 'node_modules/example/lib/ignored.js'))).toBe(false)
    expect(existsSync(join(output, 'node_modules/example/.env'))).toBe(false)
    expect(existsSync(join(output, 'node_modules/example/node_modules/other'))).toBe(false)
    writeFileSync(join(modules[0]!.dir, 'lib/foreign.node'), Buffer.from('MZ fixture'))
    expect(() => materializeMacShellPlan(source, join(temporary, 'rejected'), modules)).toThrow('requires a Darwin preparation')
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

it('rejects missing or changed required shell dependencies after materializing pnpm links', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'mac-cross-shell-'))
  try {
    const source = join(temporary, 'source')
    const shell = join(temporary, 'shell')
    for (const root of [source, shell]) {
      mkdirSync(join(root, 'node_modules/example'), { recursive: true })
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'shell', version: '1.0.0', dependencies: { example: '^1.0.0' } }))
      writeFileSync(join(root, 'node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1.0.0' }))
    }
    expect(verifyMacCrossShellVersions(shell, source)).toEqual({ packages: 2, requiredEdges: 1 })
    writeFileSync(join(shell, 'node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1.1.0' }))
    expect(() => verifyMacCrossShellVersions(shell, source)).toThrow('version changed')
    rmSync(join(shell, 'node_modules/example'), { recursive: true })
    expect(() => verifyMacCrossShellVersions(shell, source)).toThrow('missing required')
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

it('reuses only an intact runtime for its exact input key, version and target CPU', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mac-cross-cache-'))
  try {
    const dsh = join(root, 'dsh')
    const descriptor = runtimeFixture(dsh)
    writeDesktopRuntime(dsh, descriptor.release, descriptor.sharedPackages.map(pkg => pkg.name), { platform: 'darwin', arch: 'arm64' })
    await recordMacCrossRuntime(root, 'verified-inputs', '1.0.0', 'arm64')
    expect(await reuseMacCrossRuntime(root, 'verified-inputs', '1.0.0', 'arm64')).toBe(true)
    expect(await reuseMacCrossRuntime(root, 'changed-source', '1.0.0', 'arm64')).toBe(false)
    expect(await reuseMacCrossRuntime(root, 'verified-inputs', '2.0.0', 'arm64')).toBe(false)
    expect(await reuseMacCrossRuntime(root, 'verified-inputs', '1.0.0', 'x64')).toBe(false)
    const file = join(dsh, 'node_modules/@deepseek-ai/dsh/index.js')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nexport const tampered = true\n`)
    expect(await reuseMacCrossRuntime(root, 'verified-inputs', '1.0.0', 'arm64')).toBe(false)
    await expect(recordMacCrossRuntime(root, 'new-key', '1.0.0', 'arm64')).rejects.toThrow('integrity')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('seeds content bytes and independent indexes while excluding project and filesystem links', () => {
  const root = mkdtempSync(join(tmpdir(), 'mac-cross-store-'))
  try {
    const options = { root, target: 'mac-x64' as const, nodeVersion: '24.21.0', pnpmVersion: '11.28.5',
      environment: { DSH_DESKTOP_DEPENDENCY_CACHE_DIR: join(root, 'target-caches') } }
    const target = prepareDesktopDependencyCache(options.environment, options.target, options)
    const store = join(root, 'cache/pnpm/store/v11')
    const files = join(store, 'files/ab')
    const indexes = join(store, 'index')
    mkdirSync(files, { recursive: true })
    mkdirSync(indexes)
    mkdirSync(join(store, 'projects'))
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'private'), 'outside cache')
    writeFileSync(join(files, 'content'), 'immutable bytes')
    writeFileSync(join(indexes, 'package.json'), 'index one')
    symlinkSync(outside, join(store, 'projects/old-project'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(join(outside, 'private'), join(files, 'external'))
    const result = seedMacCrossDependencyCache(options)
    expect(result.linked).toBe(1)
    expect(result.skippedLinks).toBe(1)
    expect(readFileSync(join(target.store, 'v11/files/ab/content'), 'utf8')).toBe('immutable bytes')
    expect(existsSync(join(target.store, 'v11/projects'))).toBe(false)
    expect(existsSync(join(target.store, 'v11/files/ab/external'))).toBe(false)
    writeFileSync(join(indexes, 'package.json'), 'index two')
    expect(readFileSync(join(target.store, 'v11/index/package.json'), 'utf8')).toBe('index one')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('invalidates materialization for producer changes, CPU, Node metadata and native bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'mac-cross-inputs-'))
  try {
    execFileSync('git', ['init', '-q', root])
    const scripts = join(root, 'apps/desktop/scripts')
    mkdirSync(scripts, { recursive: true })
    const producer = join(scripts, 'prepare-dsh.ts')
    const assembly = join(scripts, 'package-mac-cross.ts')
    const versions = join(root, 'versions.json')
    const native = join(root, 'system.node')
    writeFileSync(producer, 'producer one')
    writeFileSync(assembly, 'app assembly one')
    writeFileSync(versions, '{"node":"24.21.0"}')
    writeFileSync(native, 'native one')
    const options = { repository: root, git: 'git', cohortKey: 'production one', target: 'mac-arm64' as const,
      versions, native, environment: {} }
    const initial = macCrossRuntimeKey(options)
    writeFileSync(assembly, 'app assembly two')
    expect(macCrossRuntimeKey(options)).toBe(initial)
    expect(macCrossRuntimeKey({ ...options, target: 'mac-x64' })).not.toBe(initial)
    expect(macCrossRuntimeKey({ ...options, cohortKey: 'production two' })).not.toBe(initial)
    writeFileSync(producer, 'producer two')
    expect(macCrossRuntimeKey(options)).not.toBe(initial)
    writeFileSync(producer, 'producer one')
    writeFileSync(native, 'native two')
    expect(macCrossRuntimeKey(options)).not.toBe(initial)
    writeFileSync(native, 'native one')
    writeFileSync(versions, '{"node":"24.22.0"}')
    expect(macCrossRuntimeKey(options)).not.toBe(initial)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
