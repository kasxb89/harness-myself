/** Stage reviewed local dependencies and lifecycle decisions for the isolated Desktop install. */

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { capture } from '../../../scripts/release/process.ts'
import { packedManifest } from '../../../scripts/release/tarball.ts'

const VIDEO_PACKAGE = 'deepseek-ivideo'
const VIDEO_VERSION = '0.5.0'
const HEIC_OVERRIDE = 'heic-decode@2.1.0>libheif-js'
const HEIC_LIBRARY_VERSION = '1.23.5'
const REVIEWED_BUILDS = { esbuild: true, 'onnxruntime-node@1.23.2': false, 'sharp@0.34.5': false } as const

interface RuntimeWorkspace {
  overrides?: Record<string, string>
  allowBuilds?: Record<string, boolean>
  [key: string]: unknown
}

interface RuntimeLock {
  packages?: Record<string, { version?: string; resolution?: { integrity?: string; tarball?: string } }>
  snapshots?: Record<string, { dependencies?: Record<string, string> }>
}

/** Immutable local release mirror required by the selected product bundle. */
export interface PreparedRuntimeDependencies {
  readonly name: string
  readonly version: string
  readonly path: string
  readonly integrity: string
}

function integrity(path: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
}

function normalizeSpec(spec: string): string {
  return spec.replace(/^file:\.\//u, 'file:')
}

/**
 * Copy the locked Video Studio release, HEIC library pin and reviewed build decisions before resolving Desktop dependencies.
 * The source workspace remains read-only; a rejected preparation must discard the disposable project.
 * @param projectRoot - Independent Desktop project containing its generated workspace settings.
 * @param repositoryRoot - Source workspace containing the reviewed mirror, source pin and lockfile.
 * @returns Identity, relative path and integrity required by the generated runtime lockfile.
 */
export function prepareRuntimeDependencies(projectRoot: string, repositoryRoot: string): PreparedRuntimeDependencies {
  if (resolve(projectRoot) === resolve(repositoryRoot)) throw new Error('desktop dependencies: destination must not be the source workspace')
  const source = yaml.load(readFileSync(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')) as RuntimeWorkspace
  const lock = yaml.load(readFileSync(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')) as RuntimeLock
  const web = JSON.parse(readFileSync(join(repositoryRoot, 'packages/bundle/web-app/package.json'), 'utf8')) as {
    name?: string
    version?: string
    dependencies?: Record<string, string>
  }
  const inventory = JSON.parse(readFileSync(join(repositoryRoot, 'vendor-plugins/deepseek-ivideo-0.5.0.files.json'), 'utf8')) as {
    name?: string
    version?: string
    sourceCommit?: string
    tarball?: string
  }
  if (web.name !== '@deepseek-ai/dsh-web-app' || typeof web.version !== 'string'
    || inventory.name !== VIDEO_PACKAGE || inventory.version !== VIDEO_VERSION
    || typeof inventory.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(inventory.sourceCommit)
    || inventory.tarball !== `${VIDEO_PACKAGE}-${VIDEO_VERSION}-${inventory.sourceCommit.slice(0, 8)}.tgz`
    || web.dependencies?.[VIDEO_PACKAGE] !== `github:Devin-AXIS/deepseek-design#${inventory.sourceCommit}&path:/packages/deepseek-ivideo`) {
    throw new Error('desktop dependencies: Video Studio source pin or release inventory differs from the reviewed mirror')
  }
  const path = `vendor-plugins/${inventory.tarball}`
  const edge = `${web.name}@${web.version}>${VIDEO_PACKAGE}`
  if (source.overrides?.[edge] !== `file:./${path}`) {
    throw new Error('desktop dependencies: missing reviewed Video Studio mirror override')
  }
  if (source.overrides[HEIC_OVERRIDE] !== HEIC_LIBRARY_VERSION) {
    throw new Error(`desktop dependencies: missing reviewed HEIC override for ${HEIC_OVERRIDE}`)
  }
  const resolved = lock.packages?.[`${VIDEO_PACKAGE}@file:${path}`]
  const sourcePath = join(repositoryRoot, path)
  const hash = integrity(sourcePath)
  if (resolved?.version !== VIDEO_VERSION || resolved.resolution?.integrity !== hash
    || resolved.resolution.tarball !== `file:${path}`) {
    throw new Error('desktop dependencies: Video Studio mirror integrity differs from the root lockfile')
  }
  const manifest = packedManifest(sourcePath)
  if (manifest.name !== VIDEO_PACKAGE || manifest.version !== VIDEO_VERSION || manifest.license !== 'SEE LICENSE IN LICENSE'
    || capture('tar', ['-xOzf', basename(sourcePath), 'package/LICENSE'], { cwd: dirname(sourcePath) }).trim() === '') {
    throw new Error('desktop dependencies: Video Studio mirror has a different package identity or license')
  }
  const targetPath = join(projectRoot, 'pnpm-workspace.yaml')
  const target = yaml.load(readFileSync(targetPath, 'utf8')) as RuntimeWorkspace
  if (target.overrides?.[edge] !== undefined && target.overrides[edge] !== source.overrides[edge]) {
    throw new Error(`desktop dependencies: conflicting dependency override for ${edge}`)
  }
  if (target.overrides?.[HEIC_OVERRIDE] !== undefined && target.overrides[HEIC_OVERRIDE] !== HEIC_LIBRARY_VERSION) {
    throw new Error(`desktop dependencies: conflicting dependency override for ${HEIC_OVERRIDE}`)
  }
  for (const [name, allowed] of Object.entries(REVIEWED_BUILDS)) {
    if (source.allowBuilds?.[name] !== allowed) throw new Error(`desktop dependencies: missing reviewed build decision for ${name}`)
    if (target.allowBuilds?.[name] !== undefined && target.allowBuilds[name] !== allowed) {
      throw new Error(`desktop dependencies: conflicting build decision for ${name}`)
    }
  }
  mkdirSync(dirname(join(projectRoot, path)), { recursive: true })
  copyFileSync(sourcePath, join(projectRoot, path))
  writeFileSync(targetPath, yaml.dump({
    ...target,
    overrides: { ...target.overrides, [edge]: source.overrides[edge], [HEIC_OVERRIDE]: HEIC_LIBRARY_VERSION },
    allowBuilds: { ...target.allowBuilds, ...REVIEWED_BUILDS },
  }))
  return { name: VIDEO_PACKAGE, version: VIDEO_VERSION, path, integrity: hash }
}

/**
 * Reject changed mirror bytes or a Git/registry resolution before the frozen production install.
 * @param projectRoot - Independent Desktop installation containing its resolved lockfile.
 * @param plan - Expected release mirror returned by dependency preparation.
 */
export function verifyRuntimeDependencies(projectRoot: string, plan: PreparedRuntimeDependencies): void {
  if (integrity(join(projectRoot, plan.path)) !== plan.integrity) throw new Error('desktop dependencies: staged mirror bytes changed')
  const lock = yaml.load(readFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'utf8')) as RuntimeLock
  const heicDecoders = Object.keys(lock.packages ?? {}).filter(name => name.startsWith('heic-decode@'))
  const libraries = Object.keys(lock.packages ?? {}).filter(name => name.startsWith('libheif-js@'))
  if (heicDecoders.length > 0 || libraries.length > 0) {
    if (heicDecoders.length !== 1 || heicDecoders[0] !== 'heic-decode@2.1.0'
      || libraries.length !== 1 || libraries[0] !== `libheif-js@${HEIC_LIBRARY_VERSION}`
      || lock.snapshots?.['heic-decode@2.1.0']?.dependencies?.['libheif-js'] !== HEIC_LIBRARY_VERSION) {
      throw new Error('desktop dependencies: HEIC decoder did not resolve its reviewed library version')
    }
  }
  const entries = Object.entries(lock.packages ?? {}).filter(([name]) => name.startsWith(`${plan.name}@`))
  const [entry] = entries
  if (entries.length !== 1 || entry === undefined || normalizeSpec(entry[0].slice(plan.name.length + 1)) !== `file:${plan.path}`
    || entry[1].version !== plan.version || entry[1].resolution?.integrity !== plan.integrity
    || normalizeSpec(entry[1].resolution.tarball ?? '') !== `file:${plan.path}`) {
    throw new Error('desktop dependencies: lockfile did not resolve the verified local Video Studio mirror')
  }
}
