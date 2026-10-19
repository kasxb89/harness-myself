import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { pnpmInvocation } from '../../../scripts/pnpm-invocation.ts'
import { capture } from '../../../scripts/release/process.ts'
import { removeFixtureSafely } from '../../../scripts/test-fixture-cleanup.ts'
import {
  prepareRuntimeDependencies,
  verifyRuntimeDependencies,
  type PreparedRuntimeDependencies,
} from '../scripts/prepare-runtime-dependencies.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..')
const VIDEO_PACKAGE = 'deepseek-ivideo'
const VIDEO_VERSION = '0.5.0'
const SOURCE_COMMIT = '62ee529e84423ba63e823b23860293a43b6eb03b'
const SOURCE_PIN = `github:Devin-AXIS/deepseek-design#${SOURCE_COMMIT}&path:/packages/deepseek-ivideo`
const MIRROR_PATH = `vendor-plugins/${VIDEO_PACKAGE}-${VIDEO_VERSION}-${SOURCE_COMMIT.slice(0, 8)}.tgz`
const WEB_PACKAGE = '@deepseek-ai/dsh-web-app'
const WEB_VERSION = '0.2.1-alpha.2'
const MIRROR_EDGE = `${WEB_PACKAGE}@${WEB_VERSION}>${VIDEO_PACKAGE}`
const HEIC_OVERRIDE = 'heic-decode@2.1.0>libheif-js'
const HEIC_LIBRARY_VERSION = '1.23.5'
const REVIEWED_BUILDS = { esbuild: true, 'onnxruntime-node@1.23.2': false, 'sharp@0.34.5': false }
const roots: string[] = []

interface WorkspaceSettings {
  overrides: Record<string, string>
  allowBuilds: Record<string, boolean>
  [key: string]: unknown
}

interface RuntimeLock {
  snapshots?: Record<string, { dependencies?: Record<string, string> }>
  packages: Record<string, { version: string; resolution: { integrity: string; tarball: string } }>
}

interface Fixture {
  root: string
  source: string
  project: string
  integrity: string
}

interface ArchiveOptions {
  manifest?: Record<string, unknown>
  licenseText?: string
}

function write(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function hash(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

function workspace(root: string): WorkspaceSettings {
  return yaml.load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as WorkspaceSettings
}

function writeWorkspace(root: string, settings: WorkspaceSettings): void {
  write(join(root, 'pnpm-workspace.yaml'), yaml.dump(settings))
}

function archive(root: string, name: string, manifest: Record<string, unknown>, licenseText = 'Fixture license retained verbatim.\n'): string {
  const staging = join(root, `${name}-payload`)
  write(join(staging, 'package/package.json'), `${JSON.stringify(manifest)}\n`)
  write(join(staging, 'package/LICENSE'), licenseText)
  write(join(staging, 'package/index.js'), 'export const fixture = true;\n')
  const tarball = join(root, `${name}.tgz`)
  capture('tar', ['-czf', basename(tarball), '-C', staging, 'package'], { cwd: root })
  return tarball
}

function fixture(options: ArchiveOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-dependencies-'))
  roots.push(root)
  const source = join(root, 'source')
  const project = join(root, 'project')
  const tarball = archive(root, 'video', {
    name: VIDEO_PACKAGE,
    version: VIDEO_VERSION,
    license: 'SEE LICENSE IN LICENSE',
    type: 'module',
    main: 'index.js',
    ...options.manifest,
  }, options.licenseText)
  const bytes = readFileSync(tarball)
  const integrity = hash(bytes)
  write(join(source, MIRROR_PATH), bytes)
  write(join(source, 'packages/bundle/web-app/package.json'), `${JSON.stringify({
    name: WEB_PACKAGE, version: WEB_VERSION, dependencies: { [VIDEO_PACKAGE]: SOURCE_PIN },
  })}\n`)
  write(join(source, 'vendor-plugins/deepseek-ivideo-0.5.0.files.json'), `${JSON.stringify({
    name: VIDEO_PACKAGE, version: VIDEO_VERSION, sourceCommit: SOURCE_COMMIT, tarball: basename(MIRROR_PATH),
  })}\n`)
  writeWorkspace(source, { overrides: { [MIRROR_EDGE]: `file:./${MIRROR_PATH}`, [HEIC_OVERRIDE]: HEIC_LIBRARY_VERSION }, allowBuilds: { ...REVIEWED_BUILDS } })
  write(join(source, 'pnpm-lock.yaml'), yaml.dump({ packages: {
    [`${VIDEO_PACKAGE}@file:${MIRROR_PATH}`]: { version: VIDEO_VERSION, resolution: { integrity, tarball: `file:${MIRROR_PATH}` } },
  } }))
  writeWorkspace(project, {
    packages: ['.'], nodeLinker: 'isolated', overrides: { unrelated: '1.2.3' }, allowBuilds: { unrelated: false },
  })
  write(join(project, 'package.json'), `${JSON.stringify({ name: 'desktop-runtime-fixture', private: true })}\n`)
  return { root, source, project, integrity }
}

function resolvedLock(plan: PreparedRuntimeDependencies): RuntimeLock {
  return { packages: {
    [`${plan.name}@file:${plan.path}`]: { version: plan.version, resolution: { integrity: plan.integrity, tarball: `file:${plan.path}` } },
  } }
}

function writeLock(project: string, lock: RuntimeLock): void {
  write(join(project, 'pnpm-lock.yaml'), yaml.dump(lock))
}

afterEach(() => {
  for (const root of roots.splice(0)) removeFixtureSafely(root)
})

describe('Desktop runtime dependency preparation', () => {
  it('stages the real reviewed archive without changing its bytes or source metadata', () => {
    const { project } = fixture()
    const sourceWorkspace = readFileSync(join(REPOSITORY_ROOT, 'pnpm-workspace.yaml'))
    const sourceLock = readFileSync(join(REPOSITORY_ROOT, 'pnpm-lock.yaml'))
    const sourceArchive = readFileSync(join(REPOSITORY_ROOT, MIRROR_PATH))

    const plan = prepareRuntimeDependencies(project, REPOSITORY_ROOT)

    expect(plan).toEqual({ name: VIDEO_PACKAGE, version: VIDEO_VERSION, path: MIRROR_PATH, integrity: hash(sourceArchive) })
    expect(readFileSync(join(project, plan.path)).equals(sourceArchive)).toBe(true)
    expect(workspace(project)).toEqual({
      packages: ['.'], nodeLinker: 'isolated',
      overrides: { unrelated: '1.2.3', [MIRROR_EDGE]: `file:./${MIRROR_PATH}`, [HEIC_OVERRIDE]: HEIC_LIBRARY_VERSION },
      allowBuilds: { unrelated: false, ...REVIEWED_BUILDS },
    })
    expect(readFileSync(join(REPOSITORY_ROOT, 'pnpm-workspace.yaml')).equals(sourceWorkspace)).toBe(true)
    expect(readFileSync(join(REPOSITORY_ROOT, 'pnpm-lock.yaml')).equals(sourceLock)).toBe(true)
    expect(readFileSync(join(REPOSITORY_ROOT, MIRROR_PATH)).equals(sourceArchive)).toBe(true)
  })

  it('accepts identical reviewed target decisions and verifies the staged isolated archive', () => {
    const { source, project, integrity } = fixture()
    writeWorkspace(project, {
      ...workspace(project),
      overrides: { unrelated: '1.2.3', [MIRROR_EDGE]: `file:./${MIRROR_PATH}`, [HEIC_OVERRIDE]: HEIC_LIBRARY_VERSION },
      allowBuilds: { unrelated: false, ...REVIEWED_BUILDS },
    })

    const plan = prepareRuntimeDependencies(project, source)
    writeLock(project, resolvedLock(plan))

    expect(plan.integrity).toBe(integrity)
    expect(() => { verifyRuntimeDependencies(project, plan) }).not.toThrow()
    expect(workspace(project)).not.toHaveProperty('blockExoticSubdeps')
    expect(workspace(project)).not.toHaveProperty('dangerouslyAllowAllBuilds')
  })

  it('copies only the reviewed HEIC selector into the generated installation settings', () => {
    const { source, project } = fixture()
    const settings = workspace(source)
    settings.overrides['heic-decode@2.2.0>libheif-js'] = '1.23.6'
    settings.overrides['unrelated-parent>libheif-js'] = '1.23.6'
    writeWorkspace(source, settings)

    prepareRuntimeDependencies(project, source)

    expect(workspace(project).overrides[HEIC_OVERRIDE]).toBe(HEIC_LIBRARY_VERSION)
    expect(workspace(project).overrides).not.toHaveProperty('heic-decode@2.2.0>libheif-js')
    expect(workspace(project).overrides).not.toHaveProperty('unrelated-parent>libheif-js')
  })

  it.each(['missing', 'changed version', 'unsupported parent'] as const)('rejects a %s HEIC pin', (failure) => {
    const { source, project } = fixture()
    const settings = workspace(source)
    if (failure === 'changed version') settings.overrides[HEIC_OVERRIDE] = '1.23.6'
    else {
      Reflect.deleteProperty(settings.overrides, HEIC_OVERRIDE)
      if (failure === 'unsupported parent') settings.overrides['heic-decode@2.2.0>libheif-js'] = HEIC_LIBRARY_VERSION
    }
    writeWorkspace(source, settings)

    expect(() => prepareRuntimeDependencies(project, source)).toThrow('missing reviewed HEIC override')
  })

  it('refuses to stage into the source repository', () => {
    const { source } = fixture()
    expect(() => prepareRuntimeDependencies(source, source)).toThrow(/source workspace/u)
  })

  it.each(['source pin', 'inventory commit', 'inventory filename', 'mirror override'] as const)(
    'rejects a changed reviewed %s', (failure) => {
      const { source, project } = fixture()
      if (failure === 'source pin') {
        write(join(source, 'packages/bundle/web-app/package.json'), JSON.stringify({
          name: WEB_PACKAGE, version: WEB_VERSION, dependencies: { [VIDEO_PACKAGE]: SOURCE_PIN.replace(SOURCE_COMMIT, 'main') },
        }))
      } else if (failure === 'mirror override') {
        writeWorkspace(source, { ...workspace(source), overrides: { [MIRROR_EDGE]: 'deepseek-ivideo@0.5.0' } })
      } else {
        const inventoryPath = join(source, 'vendor-plugins/deepseek-ivideo-0.5.0.files.json')
        const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as Record<string, unknown>
        inventory[failure === 'inventory commit' ? 'sourceCommit' : 'tarball'] = failure === 'inventory commit' ? 'main' : 'other.tgz'
        write(inventoryPath, JSON.stringify(inventory))
      }

      expect(() => prepareRuntimeDependencies(project, source)).toThrow(/desktop dependencies:/u)
    },
  )

  it.each(['archive bytes', 'lock integrity'] as const)('rejects changed %s before unpacking the mirror', (failure) => {
    const { source, project } = fixture()
    if (failure === 'archive bytes') write(join(source, MIRROR_PATH), 'corrupted archive')
    else {
      const lock = yaml.load(readFileSync(join(source, 'pnpm-lock.yaml'), 'utf8')) as RuntimeLock
      lock.packages[`${VIDEO_PACKAGE}@file:${MIRROR_PATH}`]!.resolution.integrity = hash(Buffer.from('different archive'))
      writeLock(source, lock)
    }

    expect(() => prepareRuntimeDependencies(project, source)).toThrow(/integrity differs from the root lockfile/u)
  })

  it.each([
    { label: 'package name', manifest: { name: 'other-video' } },
    { label: 'package version', manifest: { version: '0.5.1' } },
    { label: 'license declaration', manifest: { license: 'MIT' } },
    { label: 'license bytes', licenseText: '' },
  ] satisfies Array<ArchiveOptions & { label: string }>)('rejects changed archive $label after its SHA512 matches', (options) => {
    const { source, project } = fixture(options)

    expect(() => prepareRuntimeDependencies(project, source)).toThrow(/package identity or license/u)
  })

  it.each(Object.keys(REVIEWED_BUILDS))('requires the root build decision for %s', (name) => {
    const { source, project } = fixture()
    const settings = workspace(source)
    Reflect.deleteProperty(settings.allowBuilds, name)
    writeWorkspace(source, settings)

    expect(() => prepareRuntimeDependencies(project, source)).toThrow(/missing reviewed build decision/u)
  })

  it.each(['override', 'HEIC override', 'build decision'] as const)('rejects a conflicting target %s', (failure) => {
    const { source, project } = fixture()
    const settings = workspace(project)
    if (failure === 'override') settings.overrides[MIRROR_EDGE] = 'file:./unrelated.tgz'
    else if (failure === 'HEIC override') settings.overrides[HEIC_OVERRIDE] = '1.23.6'
    else settings.allowBuilds.esbuild = false
    writeWorkspace(project, settings)

    expect(() => prepareRuntimeDependencies(project, source)).toThrow(/conflicting/u)
  })
})

describe('Desktop runtime dependency verification', () => {
  it.each(['reviewed', 'library version', 'decoder identity', 'dependency edge', 'duplicate library'] as const)(
    'verifies the generated HEIC lockfile: %s', (change) => {
      const { source, project } = fixture()
      const plan = prepareRuntimeDependencies(project, source)
      const lock = resolvedLock(plan)
      const resolution = { integrity: 'fixture integrity', tarball: 'fixture tarball' }
      lock.packages['heic-decode@2.1.0'] = { version: '2.1.0', resolution }
      lock.packages['libheif-js@1.23.5'] = { version: HEIC_LIBRARY_VERSION, resolution }
      lock.snapshots = { 'heic-decode@2.1.0': { dependencies: { 'libheif-js': HEIC_LIBRARY_VERSION } } }
      if (change === 'library version') {
        Reflect.deleteProperty(lock.packages, 'libheif-js@1.23.5')
        lock.packages['libheif-js@1.23.6'] = { version: '1.23.6', resolution }
      } else if (change === 'decoder identity') {
        Reflect.deleteProperty(lock.packages, 'heic-decode@2.1.0')
        lock.packages['heic-decode@2.2.0'] = { version: '2.2.0', resolution }
      } else if (change === 'dependency edge') lock.snapshots['heic-decode@2.1.0'] = { dependencies: { 'libheif-js': '1.23.6' } }
      else if (change === 'duplicate library') lock.packages['libheif-js@1.23.6'] = { version: '1.23.6', resolution }
      writeLock(project, lock)

      if (change === 'reviewed') expect(() => { verifyRuntimeDependencies(project, plan) }).not.toThrow()
      else expect(() => { verifyRuntimeDependencies(project, plan) }).toThrow('HEIC decoder did not resolve its reviewed library version')
    },
  )

  it('accepts equivalent relative file specifiers from pnpm lockfiles', () => {
    const { source, project } = fixture()
    const plan = prepareRuntimeDependencies(project, source)
    writeLock(project, { packages: {
      [`${plan.name}@file:./${plan.path}`]: { version: plan.version, resolution: { integrity: plan.integrity, tarball: `file:./${plan.path}` } },
    } })

    expect(() => { verifyRuntimeDependencies(project, plan) }).not.toThrow()
  })

  it.each(['missing', 'registry', 'Git', 'duplicate', 'version', 'resolution', 'hash', 'staged bytes'] as const)(
    'rejects an invalid resolved mirror: %s', (failure) => {
      const { source, project } = fixture()
      const plan = prepareRuntimeDependencies(project, source)
      const lock = resolvedLock(plan)
      const key = `${plan.name}@file:${plan.path}`
      const entry = lock.packages[key]!
      switch (failure) {
        case 'missing': Reflect.deleteProperty(lock.packages, key); break
        case 'registry':
        case 'Git':
          Reflect.deleteProperty(lock.packages, key)
          lock.packages[`${plan.name}@${failure === 'registry' ? plan.version : SOURCE_PIN}`] = entry
          break
        case 'duplicate': lock.packages[`${plan.name}@${plan.version}`] = entry; break
        case 'version': entry.version = '0.5.1'; break
        case 'resolution': entry.resolution.tarball = 'file:vendor-plugins/other.tgz'; break
        case 'hash': entry.resolution.integrity = hash(Buffer.from('different archive')); break
        case 'staged bytes': write(join(project, plan.path), 'changed staged archive'); break
      }
      writeLock(project, lock)

      expect(() => { verifyRuntimeDependencies(project, plan) }).toThrow(/desktop dependencies:/u)
    },
  )

  it('installs an immutable Git-declared subdependency from the staged mirror with offline pnpm and a frozen lockfile', async () => {
    const { root, source, project } = fixture()
    writeWorkspace(project, { ...workspace(project), nodeLinker: 'hoisted' })
    const parent = archive(root, 'web-app', {
      name: WEB_PACKAGE, version: WEB_VERSION, dependencies: { [VIDEO_PACKAGE]: SOURCE_PIN },
    })
    write(join(project, 'web-app.tgz'), readFileSync(parent))
    write(join(project, 'package.json'), JSON.stringify({
      name: 'desktop-runtime-fixture', private: true, dependencies: { [WEB_PACKAGE]: 'file:./web-app.tgz' },
    }))
    const plan = prepareRuntimeDependencies(project, source)
    const config = join(root, 'empty.npmrc')
    write(config, '')
    const guard = join(root, 'offline-guard.cjs')
    write(guard, [
      "const net = require('node:net');",
      "net.Socket.prototype.connect = function () { throw new Error('Runtime dependency fixture attempted network access'); };",
      "const childProcess = require('node:child_process');",
      "for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {",
      '  const original = childProcess[method];',
      '  childProcess[method] = function (command, ...args) {',
      "    if (/(?:^|[\\\\/])git(?:\\.exe|\\.cmd)?$/i.test(String(command))) throw new Error('Runtime dependency fixture attempted Git');",
      '    return original.call(this, command, ...args);',
      '  };',
      '}',
      "require('node:module').syncBuiltinESMExports();",
      '',
    ].join('\n'))
    const run = promisify(execFile)
    const pnpmEntry = join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin/pnpm.cjs')
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:path|systemroot|windir|comspec|temp|tmp)$/iu.test(name))),
      CI: 'true',
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      GIT_TERMINAL_PROMPT: '0',
      NODE_OPTIONS: `--require=${JSON.stringify(guard)}`,
    }
    const install = async (flags: string[]): Promise<void> => {
      const invocation = pnpmInvocation([
        'install', '--offline',
        `--config.userconfig=${config}`, `--config.globalconfig=${config}`,
        `--config.store-dir=${join(root, 'store')}`,
        '--config.manage-package-manager-versions=false', '--config.enable-global-virtual-store=false',
        ...flags,
      ], { npm_execpath: pnpmEntry })
      await run(invocation.command, invocation.args, { cwd: project, env, timeout: 30_000, windowsHide: true })
    }

    await install(['--lockfile-only', '--no-frozen-lockfile'])
    verifyRuntimeDependencies(project, plan)
    const locked = readFileSync(join(project, 'pnpm-lock.yaml'))
    await install(['--frozen-lockfile', '--prod'])

    verifyRuntimeDependencies(project, plan)
    expect(readFileSync(join(project, 'pnpm-lock.yaml'))).toEqual(locked)
    const parentManifest = join(project, 'node_modules', WEB_PACKAGE, 'package.json')
    const installedManifest = join(project, 'node_modules', VIDEO_PACKAGE, 'package.json')
    expect(readFileSync(join(dirname(installedManifest), 'LICENSE'), 'utf8')).toBe('Fixture license retained verbatim.\n')
    expect(JSON.parse(readFileSync(installedManifest, 'utf8'))).toMatchObject({
      name: VIDEO_PACKAGE, version: VIDEO_VERSION, license: 'SEE LICENSE IN LICENSE',
    })
    expect(JSON.parse(readFileSync(parentManifest, 'utf8'))).toMatchObject({ dependencies: { [VIDEO_PACKAGE]: SOURCE_PIN } })
    expect(workspace(project)).not.toHaveProperty('blockExoticSubdeps')
    expect(workspace(project)).not.toHaveProperty('dangerouslyAllowAllBuilds')
  })
})
