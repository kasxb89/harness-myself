/** Pack selected private workspaces and copy the complete local Desktop runtime tarball closure. */

import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  parseDesktopCorePackageSet,
  type DesktopCorePackageRecord,
} from '../src/core-package-set.ts'
import { capture } from '../../../scripts/release/process.ts'
import { tarballFiles } from '../../../scripts/release/tarball.ts'
import { releaseFamily, tarballName, type ReleaseMember } from '../../../scripts/release/families.ts'
import { pnpmInvocation } from '../../../scripts/pnpm-invocation.ts'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const ROOT_PACKAGES = [DSH_PACKAGE, DESKTOP_HOST_PACKAGE] as const
const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')

const REQUIRED_DEPENDENCY_SECTIONS = ['dependencies', 'peerDependencies'] as const
const OPTIONAL_DEPENDENCY_SECTION = 'optionalDependencies'

/** Packed package information needed to form the local Desktop closure. */
export interface PackedDesktopPackage {
  readonly tarball: string
  readonly manifest: Readonly<Record<string, unknown>>
}

function dependencyNames(manifest: Readonly<Record<string, unknown>>, section: string): string[] {
  const value = manifest[section]
  if (value === undefined) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop package set: ${String(manifest.name)} has invalid ${section}`)
  }
  return Object.keys(value).sort()
}

function workspacePackages(root: string): Map<string, ReleaseMember> {
  const workspace = yaml.load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  return new Map(globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: root }).map((path) => {
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`desktop package set: ${path} has no package identity`)
    }
    return [manifest.name, { directory: dirname(path), name: manifest.name, version: manifest.version, manifest }]
  }))
}

function isDshPackage(name: string): boolean {
  return name === DSH_PACKAGE || name.startsWith('@deepseek-ai/dsh-')
}

/**
 * Discover private first-party dependencies missing from the selected Desktop tarball roots.
 * Public workspace dependencies must already be packed; absent first-party source fails explicitly.
 * @param available - Existing release tarballs indexed by package name.
 * @param workspaceRoot - Repository containing the selected private workspace sources.
 * @returns Only selected private workspaces, in deterministic package-name order.
 */
export function selectDesktopPrivatePackageInputs(
  available: ReadonlyMap<string, PackedDesktopPackage>,
  workspaceRoot: string = REPOSITORY_ROOT,
): ReleaseMember[] {
  const workspace = workspacePackages(workspaceRoot)
  const selected = new Map<string, ReleaseMember>()
  const visited = new Set<string>()
  const visit = (name: string, consumer: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    const packed = available.get(name)
    const source = workspace.get(name)
    if (packed === undefined) {
      if (source === undefined) throw new Error(`desktop package set: ${consumer} requires missing workspace source ${name}`)
      if (source.manifest.private !== true || !isDshPackage(name)) {
        throw new Error(`desktop package set: ${consumer} requires unpacked package ${name}`)
      }
      selected.set(name, source)
    }
    const manifest = packed?.manifest ?? source?.manifest
    if (manifest === undefined) throw new Error(`desktop package set: missing manifest for ${name}`)
    for (const section of REQUIRED_DEPENDENCY_SECTIONS) {
      for (const dependency of dependencyNames(manifest, section)) {
        if (available.has(dependency) || workspace.has(dependency) || isDshPackage(dependency)) visit(dependency, name)
      }
    }
    for (const dependency of dependencyNames(manifest, OPTIONAL_DEPENDENCY_SECTION)) {
      if (available.has(dependency)) visit(dependency, name)
    }
  }
  for (const name of ROOT_PACKAGES) {
    if (!available.has(name)) throw new Error(`desktop package set: packed inputs omit ${name}`)
    visit(name, name)
  }
  return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function privateBuildOutputs(member: ReleaseMember, workspaceRoot: string): string[] {
  const outputs = new Set<string>()
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      const file = value.replace(/^\.\//u, '')
      if (file.startsWith('lib/') && !file.includes('*')) outputs.add(file)
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const child of Object.values(value)) collect(child)
    }
  }
  for (const field of ['main', 'types', 'exports']) collect(member.manifest[field])
  for (const file of outputs) {
    const path = join(workspaceRoot, member.directory, file)
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`desktop package set: ${member.name} is missing built file ${file}; run the official build before packing`)
    }
  }
  return [...outputs]
}

/**
 * Pack the selected private workspaces without adding them to the public release family.
 * Validate built entry points, tarball contents, identity and exact first-party dependency versions.
 * @param available - Existing release tarballs; this map is not mutated.
 * @param outputDirectory - Caller-owned staging directory for the private tarballs.
 * @param workspaceRoot - Repository containing the built private workspaces.
 * @returns Existing inputs plus the verified private npm tarballs.
 */
export function packDesktopPrivatePackageInputs(
  available: ReadonlyMap<string, PackedDesktopPackage>,
  outputDirectory: string,
  workspaceRoot: string = REPOSITORY_ROOT,
): Map<string, PackedDesktopPackage> {
  const selected = selectDesktopPrivatePackageInputs(available, workspaceRoot)
  const completed = new Map(available)
  const family = releaseFamily('dsh')
  mkdirSync(outputDirectory, { recursive: true })
  for (const member of selected) {
    const required = privateBuildOutputs(member, workspaceRoot)
    const invocation = pnpmInvocation(['--dir', join(workspaceRoot, member.directory), 'pack', '--pack-destination', outputDirectory])
    capture(invocation.command, invocation.args, { cwd: workspaceRoot })
    const tarball = join(outputDirectory, tarballName(member))
    const files = tarballFiles(tarball)
    family.validatePayload(member, files)
    for (const file of required) {
      if (!files.includes(`package/${file}`)) throw new Error(`desktop package set: ${member.name} tarball omits built file ${file}`)
    }
    const manifest = packedManifest(tarball)
    family.validatePackedManifest(member, manifest)
    completed.set(member.name, { tarball, manifest })
    console.log(`desktop package set: packed private workspace ${member.name}@${member.version}`)
  }
  return completed
}

/**
 * Select workspace dependencies rooted at dsh and its private Host; npm resolves external packages.
 * Reads the repository workspace manifest and package manifests to distinguish required local packages from npm-resolved externals.
 * @param available - Packed packages indexed by package name.
 * @param workspaceRoot - Repository whose manifest identifies required local packages.
 * @returns Selected packages sorted by name.
 */
export function selectDesktopPackageClosure(
  available: ReadonlyMap<string, PackedDesktopPackage>,
  workspaceRoot: string = REPOSITORY_ROOT,
): PackedDesktopPackage[] {
  const workspaceNames = new Set(workspacePackages(workspaceRoot).keys())
  const selected = new Map<string, PackedDesktopPackage>()
  const visit = (name: string): void => {
    if (selected.has(name)) return
    const packed = available.get(name)
    if (packed === undefined) throw new Error(`desktop package set: packed inputs omit required package ${name}`)
    selected.set(name, packed)
    for (const section of REQUIRED_DEPENDENCY_SECTIONS) {
      for (const dependency of dependencyNames(packed.manifest, section)) {
        if (available.has(dependency)) visit(dependency)
        else if (workspaceNames.has(dependency)) {
          throw new Error(`desktop package set: ${name} requires unpacked package ${dependency}`)
        }
      }
    }
    for (const dependency of dependencyNames(packed.manifest, OPTIONAL_DEPENDENCY_SECTION)) {
      if (available.has(dependency)) visit(dependency)
    }
  }
  for (const name of ROOT_PACKAGES) {
    if (!available.has(name)) throw new Error(`desktop package set: packed inputs omit ${name}`)
    visit(name)
  }
  return [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, packed]) => packed)
}

function packedManifest(tarball: string): Record<string, unknown> {
  const value: unknown = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json']))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop package set: ${tarball} has no package manifest`)
  }
  return value as Record<string, unknown>
}

function packedPackages(inputs: readonly string[]): Map<string, PackedDesktopPackage> {
  const available = new Map<string, PackedDesktopPackage>()
  for (const input of inputs) {
    const tarballs = readdirSync(input).filter(file => file.endsWith('.tgz')).sort()
    if (tarballs.length === 0) throw new Error(`desktop package set: ${input} contains no tarballs`)
    for (const file of tarballs) {
      const tarball = join(input, file)
      const manifest = packedManifest(tarball)
      const name = manifest.name
      if (typeof name !== 'string' || name === '') throw new Error(`desktop package set: ${tarball} has no package name`)
      if (available.has(name)) throw new Error(`desktop package set: duplicate packed package ${name}`)
      available.set(name, { tarball, manifest })
    }
  }
  return available
}

/**
 * Require every private Host file used before the Desktop profile can pass its health check.
 * @param files - Tarball paths rooted at `package/`.
 * @returns Nothing.
 */
export function assertDesktopHostPackageFiles(files: readonly string[]): void {
  const available = new Set(files)
  const missing = DESKTOP_HOST_RUNTIME_FILES
    .map(file => `package/${file}`)
    .filter(file => !available.has(file))
  if (missing.length > 0) {
    throw new Error(`desktop package set: ${DESKTOP_HOST_PACKAGE} tarball omits required file(s): ${missing.join(', ')}`)
  }
}

function writeDesktopPackageSet(selected: readonly PackedDesktopPackage[], output: string): void {
  const host = selected.find(packed => packed.manifest.name === DESKTOP_HOST_PACKAGE)
  if (host === undefined) throw new Error(`desktop package set: selected closure omits ${DESKTOP_HOST_PACKAGE}`)
  assertDesktopHostPackageFiles(tarballFiles(host.tarball))
  rmSync(output, { recursive: true, force: true })
  const packageDir = join(output, DESKTOP_PACKAGES_DIR)
  mkdirSync(packageDir, { recursive: true })
  const records: DesktopCorePackageRecord[] = selected.map((packed) => {
    const name = packed.manifest.name
    const version = packed.manifest.version
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error(`desktop package set: ${packed.tarball} has no package identity`)
    }
    const file = basename(packed.tarball)
    const destination = join(packageDir, file)
    copyFileSync(packed.tarball, destination, constants.COPYFILE_EXCL)
    const body = readFileSync(destination)
    return {
      name,
      version,
      file,
      bytes: statSync(destination).size,
      integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
    }
  })
  const packageSet = parseDesktopCorePackageSet({ schemaVersion: 1, packages: records })
  writeFileSync(join(output, DESKTOP_PACKAGE_SET_FILE), `${JSON.stringify(packageSet, undefined, 2)}\n`, { mode: 0o600 })
}

/**
 * Pack selected private dependencies and prepare a complete local Desktop package set.
 * @param inputs - Directories containing the public release and private Host tarballs.
 * @param output - Destination for the verified descriptor and immutable local tarballs.
 * @param workspaceRoot - Repository containing built private workspace dependencies.
 */
export function prepareDesktopPackageSet(inputs: readonly string[], output: string, workspaceRoot: string = REPOSITORY_ROOT): void {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-desktop-private-pack-'))
  try {
    const available = packDesktopPrivatePackageInputs(packedPackages(inputs), staging, workspaceRoot)
    writeDesktopPackageSet(selectDesktopPackageClosure(available, workspaceRoot), output)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function main(): void {
  const buildPaths = resolveDesktopTargetBuildPaths()
  const defaultInputs = [
    buildPaths.packedDsh,
    buildPaths.packedVendor,
    buildPaths.packedLandlock,
  ]
  const { values } = parseArgs({
    options: { from: { type: 'string', multiple: true }, out: { type: 'string' } },
    allowPositionals: false,
  })
  const inputs = (values.from ?? defaultInputs).map(path => resolve(REPOSITORY_ROOT, path))
  const output = values.out === undefined ? buildPaths.packageSet : resolve(REPOSITORY_ROOT, values.out)
  prepareDesktopPackageSet(inputs, output)
  console.log(`desktop package set: prepared ${output}`)
}

if (import.meta.main) main()
