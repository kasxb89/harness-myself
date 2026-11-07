/** Reuse verified, target-owned runtime trees and immutable pnpm bytes on the D-drive builder. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { prepareDesktopDependencyCache } from './desktop-dependency-cache.ts'
import { resolveNpmRegistry } from './desktop-release-environment.mjs'

const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

interface ShellPackage {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** Reject an incomplete export or a legacy pnpm resolution that changed a required dependency version. */
export function verifyMacCrossShellVersions(root: string, source: string): { packages: number; requiredEdges: number } {
  const contained = (path: string): boolean => {
    const name = relative(root, realpathSync(path))
    return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name)
  }
  const locate = (name: string, start: string, bounded: boolean): string => {
    for (let here = start; !bounded || contained(here); here = dirname(here)) {
      const file = join(here, 'node_modules', name, 'package.json')
      if (existsSync(file)) {
        const directory = realpathSync(dirname(file))
        if (bounded && !contained(directory)) throw new Error(`macOS shell: dependency escaped export: ${name}`)
        return directory
      }
      if (dirname(here) === here || (bounded && here === root)) break
    }
    throw new Error(`macOS shell: missing required dependency ${name} from ${start}`)
  }
  const queue = [{ directory: root, original: source }]
  const seen = new Set<string>()
  let requiredEdges = 0
  while (queue.length > 0) {
    const { directory, original } = queue.shift()!
    const actual = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as ShellPackage
    const expected = JSON.parse(readFileSync(join(original, 'package.json'), 'utf8')) as ShellPackage
    if (actual.name !== expected.name || actual.version !== expected.version) {
      throw new Error(`macOS shell: dependency version changed: ${actual.name} ${actual.version}; expected ${expected.version}`)
    }
    const physical = realpathSync(directory)
    if (seen.has(physical)) continue
    seen.add(physical)
    for (const name of Object.keys(actual.dependencies ?? {})) {
      if (name in (actual.optionalDependencies ?? {})) continue
      queue.push({ directory: locate(name, directory, true), original: locate(name, original, false) })
      requiredEdges++
    }
  }
  const shell = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as ShellPackage
  if (shell.dependencies?.['@deepseek-ai/cordis'] !== undefined && shell.dependencies['@deepseek-ai/dsh-api-gateway'] !== undefined) {
    const gateway = locate('@deepseek-ai/dsh-api-gateway', root, true)
    if (locate('@deepseek-ai/cordis', gateway, true) !== locate('@deepseek-ai/cordis', root, true)) {
      throw new Error('macOS shell: gateway and shell resolve different Cordis instances')
    }
  }
  return { packages: seen.size, requiredEdges }
}

/** Bind reuse to every production cohort, materializer source, target, tool version and native byte. */
export function macCrossRuntimeKey(options: {
  repository: string
  git: string
  cohortKey: string
  target: 'mac-arm64' | 'mac-x64'
  versions: string
  native: string
  environment: NodeJS.ProcessEnv
}): string {
  const names = execFileSync(options.git, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: options.repository, encoding: 'utf8',
  }).split('\0').filter(name => (name.startsWith('apps/desktop/src/') || name.startsWith('apps/desktop/scripts/'))
    && /\.(?:ts|mjs|json)$/u.test(name)
    && !['package-mac-cross.ts', 'mac-cross-cache.ts', 'mac-cross-shell.ts'].some(file => name.endsWith(`/${file}`))).sort()
  // Cache transport and app assembly do not generate this tree; bump format if their runtime assembly rules change.
  const digest = createHash('sha256').update(JSON.stringify({
    format: 1, cohort: options.cohortKey, target: options.target, versions: hash(options.versions),
    native: hash(options.native), registry: resolveNpmRegistry(options.environment),
  }))
  for (const name of names) digest.update(name).update('\0').update(readFileSync(join(options.repository, name)))
  return digest.digest('hex')
}

/** A cached tree is reusable only after every byte passes the normal runtime verifier. */
export async function reuseMacCrossRuntime(root: string, key: string, version: string, arch: 'arm64' | 'x64'): Promise<boolean> {
  try {
    const record: unknown = JSON.parse(readFileSync(join(root, 'cross-runtime-cache.json'), 'utf8'))
    if (typeof record !== 'object' || record === null || !('key' in record) || record.key !== key
      || !('descriptorSha256' in record) || record.descriptorSha256 !== hash(join(root, 'dsh/desktop-runtime.json'))) return false
    await verifyDesktopRuntime(join(root, 'dsh'), version, { platform: 'darwin', arch })
    return true
  } catch { return false }
}

/** Record a completed tree after verification; descriptors from failed preparations never qualify. */
export async function recordMacCrossRuntime(root: string, key: string, version: string, arch: 'arm64' | 'x64'): Promise<void> {
  await verifyDesktopRuntime(join(root, 'dsh'), version, { platform: 'darwin', arch })
  writeFileSync(join(root, 'cross-runtime-cache.json'), `${JSON.stringify({
    key, descriptorSha256: hash(join(root, 'dsh/desktop-runtime.json')), verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`)
}

/** Seed missing pnpm content; mutable indexes are copied and content-addressed data can be hard linked. */
export function seedMacCrossDependencyCache(options: {
  root: string
  target: 'mac-arm64' | 'mac-x64'
  environment: NodeJS.ProcessEnv
  nodeVersion: string
  pnpmVersion: string
}): { copied: number; linked: number; reused: number; skippedLinks: number } {
  const target = prepareDesktopDependencyCache(options.environment, options.target, options)
  const others = (['mac-arm64', 'mac-x64', 'win-x64'] as const).filter(name => name !== options.target)
    .map(name => prepareDesktopDependencyCache(options.environment, name, options))
  const stores = [join(options.root, 'cache/pnpm/store'), ...others.map(cache => cache.store)]
  const sources: { source: string; destination: string; content: boolean }[] = []
  for (const store of stores) {
    if (!existsSync(store)) continue
    for (const version of readdirSync(store, { withFileTypes: true })) {
      if (!version.isDirectory() || !/^v\d+$/u.test(version.name)) continue
      for (const part of ['files', 'index']) sources.push({
        source: join(store, version.name, part), destination: join(target.store, version.name, part), content: part === 'files',
      })
    }
  }
  // Registry metadata is CPU-independent; never copy the rest of a builder's cache root.
  sources.push(...[join(options.root, 'cache'), ...others.map(cache => cache.metadata)].map(source => ({
    source: join(source, 'pnpm/v12'), destination: join(target.metadata, 'pnpm/v12'), content: false,
  })))
  const result = { copied: 0, linked: 0, reused: 0, skippedLinks: 0 }
  for (const { source, destination: output, content } of sources) {
    if (!existsSync(source)) continue
    if (lstatSync(source).isSymbolicLink()) { result.skippedLinks++; continue }
    mkdirSync(output, { recursive: true })
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        const name = relative(source, path)
        const destination = join(output, name)
        if (entry.isSymbolicLink()) { result.skippedLinks++; continue }
        if (entry.isDirectory()) { mkdirSync(destination, { recursive: true }); visit(path) }
        else if (entry.isFile()) {
          if (existsSync(destination)) { result.reused++; continue }
          // Only immutable content bytes share an inode; pnpm may rewrite an index in place.
          const immutable = content && /^[a-f0-9]{2}\//u.test(name.split(sep).join('/'))
          if (immutable && lstatSync(path).isFile()) { linkSync(path, destination); result.linked++ }
          else { copyFileSync(path, destination); result.copied++ }
        } else throw new Error('macOS cross cache: unsupported dependency store entry')
      }
    }
    visit(source)
  }
  return result
}
