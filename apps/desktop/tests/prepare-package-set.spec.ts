import { globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseFamily, tarballName } from '../../../scripts/release/families.ts'
import { capture } from '../../../scripts/release/process.ts'
import { packedManifest, tarballFiles } from '../../../scripts/release/tarball.ts'
import { removeFixtureSafely } from '../../../scripts/test-fixture-cleanup.ts'
import { DESKTOP_PACKAGES_DIR, verifyDesktopCorePackageSet } from '../src/core-package-set.ts'
import {
  assertDesktopHostPackageFiles,
  packDesktopPrivatePackageInputs,
  prepareDesktopPackageSet,
  selectDesktopPackageClosure,
  selectDesktopPrivatePackageInputs,
  type PackedDesktopPackage,
} from '../scripts/prepare-package-set.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..')
const roots: string[] = []
const PRIVATE_ENTRY = '@deepseek-ai/dsh-private-entry'
const PRIVATE_LEAF = '@deepseek-ai/dsh-private-leaf'
const PUBLIC_PACKAGE = '@deepseek-ai/dsh-public'

function packed(name: string, manifest: Record<string, unknown> = {}): PackedDesktopPackage {
  return { tarball: `${name}.tgz`, manifest: { name, version: '1.0.0', ...manifest } }
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function sourcePackage(root: string, directory: string, name: string, additions: Record<string, unknown> = {}): PackedDesktopPackage {
  const manifest = {
    name,
    version: '1.2.3',
    type: 'module',
    main: 'lib/index.js',
    types: 'lib/types/index.d.ts',
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
    files: ['lib'],
    ...additions,
  }
  write(join(root, directory, 'package.json'), `${JSON.stringify(manifest)}\n`)
  write(join(root, directory, 'lib/index.js'), 'export const value = 1;\n')
  write(join(root, directory, 'lib/types/index.d.ts'), 'export declare const value: number;\n')
  return { tarball: join(root, `${name.slice(1).replace('/', '-')}-1.2.3.tgz`), manifest }
}

function privateWorkspace(): { root: string; available: Map<string, PackedDesktopPackage> } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-private-pack-'))
  roots.push(root)
  write(join(root, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/fixture-root', version: '1.2.3', private: true })}\n`)
  write(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*/*\n  - apps/*\n')
  const dsh = sourcePackage(root, 'apps/cli', '@deepseek-ai/dsh', {
    dependencies: { [PRIVATE_ENTRY]: '1.2.3' },
  })
  const host = sourcePackage(root, 'apps/desktop-host', '@deepseek-ai/dsh-desktop-host', {
    private: true,
    dependencies: { '@deepseek-ai/dsh': '1.2.3' },
  })
  write(join(root, 'apps/desktop-host/lib/cli.js'), 'export {};\n')
  const publicPackage = sourcePackage(root, 'packages/util/public', PUBLIC_PACKAGE)
  sourcePackage(root, 'packages/host/private-entry', PRIVATE_ENTRY, {
    private: true,
    dependencies: { [PRIVATE_LEAF]: 'workspace:*' },
    peerDependencies: { [PUBLIC_PACKAGE]: 'workspace:*' },
    optionalDependencies: { '@deepseek-ai/dsh-private-unused': 'workspace:*' },
    devDependencies: { '@deepseek-ai/dsh-private-development': 'workspace:*' },
  })
  sourcePackage(root, 'packages/util/private-leaf', PRIVATE_LEAF, { private: true })
  sourcePackage(root, 'packages/util/private-unused', '@deepseek-ai/dsh-private-unused', { private: true })
  sourcePackage(root, 'packages/util/private-development', '@deepseek-ai/dsh-private-development', { private: true })
  return {
    root,
    available: new Map([dsh, host, publicPackage].map(entry => [String(entry.manifest.name), entry])),
  }
}

function inputTarballs(root: string, available: ReadonlyMap<string, PackedDesktopPackage>): string {
  const input = join(root, 'release-inputs')
  mkdirSync(input)
  for (const entry of available.values()) {
    const name = String(entry.manifest.name)
    const staging = join(root, 'staging', name.slice(1).replace('/', '-'))
    write(join(staging, 'package/package.json'), `${JSON.stringify(entry.manifest)}\n`)
    write(join(staging, 'package/lib/index.js'), 'export {};\n')
    if (name === '@deepseek-ai/dsh-desktop-host') write(join(staging, 'package/lib/cli.js'), 'export {};\n')
    capture('tar', ['-czf', basename(entry.tarball), '-C', staging, 'package'], { cwd: root })
    writeFileSync(join(input, basename(entry.tarball)), readFileSync(entry.tarball))
  }
  return input
}

describe('desktop package-set selection', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) removeFixtureSafely(root)
    vi.unstubAllEnvs()
  })

  it('does not select a packaging target when imported as a library', async () => {
    vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', 'linux')
    vi.stubEnv('DSH_DESKTOP_TARGET_ARCH', 'x64')
    vi.resetModules()
    await expect(import('../scripts/prepare-package-set.ts')).resolves.toHaveProperty('prepareDesktopPackageSet')
  })

  it('includes only the available internal production closure', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { '@deepseek-ai/dsh-base': '^1.0.0', external: '^2.0.0' },
        optionalDependencies: { '@deepseek-ai/platform-package': '1.0.0', '@deepseek-ai/missing-platform': '1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-base', packed('@deepseek-ai/dsh-base', {
        peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' },
      })],
      ['@deepseek-ai/cordis', packed('@deepseek-ai/cordis')],
      ['@deepseek-ai/platform-package', packed('@deepseek-ai/platform-package')],
      ['@deepseek-ai/unused', packed('@deepseek-ai/unused')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-desktop-host',
      '@deepseek-ai/platform-package',
    ])
  })

  it.each([
    '@deepseek-ai/dsh-base', '@deepseek-ai/cordis', '@deepseek-ai/node-addon-system',
  ])('rejects required prepared package %s absent from the packed release inputs', (dependency) => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { [dependency]: '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
    ])
    expect(() => selectDesktopPackageClosure(available)).toThrow(/unpacked package/u)
    expect(() => selectDesktopPackageClosure(new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
    ]))).toThrow(/omit @deepseek-ai\/dsh-desktop-host/u)
  })

  it('leaves independently published Office packages to npm resolution', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: {
          '@deepseek-ai/libreoffice-kit': '0.0.1',
          '@deepseek-ai/libreoffice-kit-wasm': '0.0.1',
        },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host',
    ])
  })

  it('requires both Desktop Host and public CLI entries', () => {
    const files = [
      'package/lib/index.js',
      'package/lib/cli.js',
    ]
    expect(() => {
      assertDesktopHostPackageFiles(files)
    }).not.toThrow()
    expect(() => {
      assertDesktopHostPackageFiles(files.slice(1))
    }).toThrow(/lib\/index\.js/u)
    expect(() => { assertDesktopHostPackageFiles(files.slice(0, 1)) }).toThrow(/lib\/cli\.js/u)
  })

  it('selects the thirteen private packages required by the real web-app graph without building source packages', () => {
    const publicMembers = releaseFamily('dsh').members(REPOSITORY_ROOT)
    const available = new Map(publicMembers.map(member => [member.name, {
      tarball: join(REPOSITORY_ROOT, tarballName(member)), manifest: member.manifest,
    }]))
    const supplied = [
      'apps/desktop-host/package.json',
      ...globSync(['vendor/*/package.json', 'native/system/packages/*/package.json'], { cwd: REPOSITORY_ROOT }),
    ]
    for (const path of supplied) {
      const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')) as Record<string, unknown>
      available.set(String(manifest.name), { tarball: `${path}.tgz`, manifest })
    }

    const selected = selectDesktopPrivatePackageInputs(available, REPOSITORY_ROOT)

    expect(selected.map(member => member.name)).toEqual([
      '@deepseek-ai/dsh-artifacts-index',
      '@deepseek-ai/dsh-client-creation-content',
      '@deepseek-ai/dsh-client-ui-artifacts',
      '@deepseek-ai/dsh-client-ui-background',
      '@deepseek-ai/dsh-client-ui-credits',
      '@deepseek-ai/dsh-client-ui-imagegen',
      '@deepseek-ai/dsh-client-ui-mobile',
      '@deepseek-ai/dsh-client-ui-plaza',
      '@deepseek-ai/dsh-client-ui-prompt-assist',
      '@deepseek-ai/dsh-client-ui-skillhub',
      '@deepseek-ai/dsh-client-ui-videogen',
      '@deepseek-ai/dsh-credits-index',
      '@deepseek-ai/dsh-web-app',
    ])
    expect(selected.every(member => member.manifest.private === true)).toBe(true)
    expect(publicMembers.some(member => selected.some(privateMember => privateMember.name === member.name))).toBe(false)
    expect(selected.some(member => member.directory.startsWith('apps/'))).toBe(false)
  })

  it('packs the selected private dependency and peer closure into real tarballs with exact workspace versions', () => {
    const { root, available } = privateWorkspace()
    const output = join(root, 'private-tarballs')

    const selected = selectDesktopPrivatePackageInputs(available, root)
    const prepared = packDesktopPrivatePackageInputs(available, output, root)

    expect(selected.map(member => member.name)).toEqual([PRIVATE_ENTRY, PRIVATE_LEAF])
    expect(readdirSync(output).sort()).toEqual(selected.map(tarballName).sort())
    expect([...prepared.keys()].sort()).toEqual([...available.keys(), PRIVATE_ENTRY, PRIVATE_LEAF].sort())
    expect(selectDesktopPackageClosure(prepared, root).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', PRIVATE_ENTRY, PRIVATE_LEAF, PUBLIC_PACKAGE,
    ])
    const entry = prepared.get(PRIVATE_ENTRY)
    if (entry === undefined) throw new Error('private entry tarball was not prepared')
    expect(packedManifest(entry.tarball)).toMatchObject({
      name: PRIVATE_ENTRY,
      private: true,
      version: '1.2.3',
      dependencies: { [PRIVATE_LEAF]: '1.2.3' },
      peerDependencies: { [PUBLIC_PACKAGE]: '1.2.3' },
    })
    expect(tarballFiles(entry.tarball)).toEqual(expect.arrayContaining([
      'package/package.json', 'package/lib/index.js', 'package/lib/types/index.d.ts',
    ]))
    expect(prepared.has('@deepseek-ai/dsh-private-unused')).toBe(false)
    expect(prepared.has('@deepseek-ai/dsh-private-development')).toBe(false)
    expect(releaseFamily('dsh').members(root).map(member => member.name)).toEqual(['@deepseek-ai/dsh', PUBLIC_PACKAGE])
  })

  it('prepares and verifies a complete package set from release inputs plus private source packages', () => {
    const { root, available } = privateWorkspace()
    const input = inputTarballs(root, available)
    const output = join(root, 'package-set')

    prepareDesktopPackageSet([input], output, root)

    const descriptor = verifyDesktopCorePackageSet(output, '1.2.3')
    expect(descriptor.packages.map(entry => entry.name)).toEqual([
      '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', PRIVATE_ENTRY, PRIVATE_LEAF, PUBLIC_PACKAGE,
    ])
    const privateRecord = descriptor.packages.find(entry => entry.name === PRIVATE_ENTRY)
    if (privateRecord === undefined) throw new Error('private entry is absent from the verified descriptor')
    const privateTarball = join(output, DESKTOP_PACKAGES_DIR, privateRecord.file)
    expect(packedManifest(privateTarball)).toMatchObject({ name: PRIVATE_ENTRY, version: '1.2.3' })
    writeFileSync(privateTarball, 'corrupted private package')
    expect(() => verifyDesktopCorePackageSet(output, '1.2.3')).toThrow(/integrity check failed/u)
  })

  it('does not replace missing public release inputs with workspace source packages', () => {
    const { root, available } = privateWorkspace()
    available.delete(PUBLIC_PACKAGE)
    const input = inputTarballs(root, available)

    expect(() => selectDesktopPrivatePackageInputs(available, root)).toThrow(/dsh-public/u)
    expect(() => { prepareDesktopPackageSet([input], join(root, 'package-set'), root) }).toThrow(/dsh-public/u)
  })

  it('rejects a first-party runtime dependency whose workspace source is missing', () => {
    const { root, available } = privateWorkspace()
    const dsh = available.get('@deepseek-ai/dsh')
    if (dsh === undefined) throw new Error('dsh fixture is missing')
    available.set('@deepseek-ai/dsh', {
      ...dsh,
      manifest: { ...dsh.manifest, dependencies: { '@deepseek-ai/dsh-private-missing': 'workspace:*' } },
    })

    expect(() => selectDesktopPrivatePackageInputs(available, root)).toThrow(/dsh-private-missing/u)
  })

  it.each([
    ['main', { main: 'lib/missing.js' }],
    ['types', { types: 'lib/types/missing.d.ts' }],
    ['exports', { exports: { '.': './lib/index.js', './extra': { import: './lib/missing.js' } } }],
    ['client', { exports: { '.': './lib/index.js', './client': './lib/client.js' } }],
  ])('rejects a private package with an unbuilt declared %s entry', (_field, additions) => {
    const { root, available } = privateWorkspace()
    sourcePackage(root, 'packages/util/private-leaf', PRIVATE_LEAF, { private: true, ...additions })

    expect(() => packDesktopPrivatePackageInputs(available, join(root, 'private-tarballs'), root))
      .toThrow(/missing built file/u)
  })

  it('rejects a private tarball that omits a built client entry present in its source package', () => {
    const { root, available } = privateWorkspace()
    sourcePackage(root, 'packages/util/private-leaf', PRIVATE_LEAF, {
      private: true,
      files: ['lib/types'],
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
    })
    write(join(root, 'packages/util/private-leaf/lib/client.js'), 'export {};\n')

    expect(() => packDesktopPrivatePackageInputs(available, join(root, 'private-tarballs'), root))
      .toThrow(/tarball omits built file lib\/client\.js/u)
  })

  it('keeps the release payload policy for private package tarballs', () => {
    const { root, available } = privateWorkspace()
    sourcePackage(root, 'packages/util/private-leaf', PRIVATE_LEAF, { private: true, files: ['lib', 'src'] })
    write(join(root, 'packages/util/private-leaf/src/index.ts'), 'export const source = 1;\n')

    expect(() => packDesktopPrivatePackageInputs(available, join(root, 'private-tarballs'), root))
      .toThrow(/publishes source file package\/src\/index\.ts/u)
  })

  it('keeps exact DSH dependency validation for private package tarballs', () => {
    const { root, available } = privateWorkspace()
    sourcePackage(root, 'packages/util/private-leaf', PRIVATE_LEAF, {
      private: true, dependencies: { [PUBLIC_PACKAGE]: '^1.2.3' },
    })

    expect(() => packDesktopPrivatePackageInputs(available, join(root, 'private-tarballs'), root))
      .toThrow(/packed dependencies\.@deepseek-ai\/dsh-public must equal 1\.2\.3/u)
  })
})
