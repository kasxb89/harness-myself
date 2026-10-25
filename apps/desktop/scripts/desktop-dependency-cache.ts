/** Reuse verified pnpm downloads across isolated Desktop build worktrees. */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { resolveNpmRegistry } from './desktop-release-environment.mjs'
import { desktopTargetPlatform } from './desktop-build-paths.mjs'
import type { DesktopAutoUpdateTarget } from './desktop-auto-update-environment.mjs'

/** Build-machine downloads and metadata; installed modules and npmrc remain run-owned. */
export interface DesktopDependencyCache {
  readonly directory: string
  readonly store: string
  readonly metadata: string
  readonly registry: string
}

function directory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const status = lstatSync(path)
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`desktop dependency cache: expected a real directory at ${path}`)
  }
}

/**
 * Prepare a persistent content store, partitioned by target, tool versions, and registry.
 * @param environment Packaging settings; an optional cache directory must be absolute.
 * @param target Complete Desktop payload target.
 * @param versions pnpm and Node versions bundled in the prepared primary runtime.
 * @param homeDirectory Build-account home used by the default cache location.
 * @returns Paths that survive runtime cleanup and are safe to share between build worktrees.
 */
export function prepareDesktopDependencyCache(
  environment: NodeJS.ProcessEnv,
  target: DesktopAutoUpdateTarget,
  versions: { readonly pnpmVersion: string; readonly nodeVersion: string },
  homeDirectory = homedir(),
): DesktopDependencyCache {
  desktopTargetPlatform(target)
  const configured = environment.DSH_DESKTOP_DEPENDENCY_CACHE_DIR
  const root = configured === undefined
    ? join(homeDirectory, '.dsh-desktop-build', 'dependencies', 'v1') : configured.trim()
  if (!isAbsolute(root) || resolve(root) === parse(root).root) {
    throw new Error('desktop dependency cache: DSH_DESKTOP_DEPENDENCY_CACHE_DIR must be an absolute non-root directory')
  }
  const registry = new URL(resolveNpmRegistry(environment)).origin
  const key = createHash('sha256').update(JSON.stringify({
    target, registry, pnpmVersion: versions.pnpmVersion, nodeVersion: versions.nodeVersion,
  })).digest('hex')
  const cacheRoot = join(root, key)
  const store = join(cacheRoot, 'store')
  const metadata = join(cacheRoot, 'metadata')
  for (const path of [root, cacheRoot, store, metadata]) directory(path)
  return { directory: cacheRoot, store, metadata, registry }
}

/**
 * Keep pnpm integrity checks and lifecycle builds while preferring previously fetched bytes.
 * @param cache Prepared, account-owned dependency cache.
 * @returns pnpm options; each install still resolves the current project's package and patch inputs.
 */
export function desktopDependencyCacheArguments(cache: DesktopDependencyCache): string[] {
  return [
    `--config.registry=${cache.registry}`,
    `--config.store-dir=${cache.store}`,
    '--config.prefer-offline=true',
    '--config.verify-store-integrity=true',
    '--config.package-import-method=copy',
    '--config.side-effects-cache=false',
    '--config.enable-global-virtual-store=false',
  ]
}
