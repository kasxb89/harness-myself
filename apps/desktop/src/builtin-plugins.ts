/** One-time activation of plugins shipped in the Desktop runtime. */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readProfileManifest, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'

const CUSTOM_MODE = 'dsh-custom-mode'
const RECEIPT = '.yunshu-builtin-plugins-v1.json'

/**
 * Preserve recovery's explicit plugin opt-out before this release's first normal launch.
 * @param profileDir - Desktop profile held under the project manager's lock.
 */
export function suppressBuiltinPluginActivation(profileDir: string): void {
  if (!existsSync(join(profileDir, 'package.json'))) return
  const receipt = join(profileDir, RECEIPT)
  if (!existsSync(receipt)) writeFileSync(receipt, '{"version":1}\n', { mode: 0o600, flag: 'wx' })
}

/**
 * Enable the bundled assistant editor once, preserving existing installations and later opt-outs.
 * @param profileDir - initialized Desktop profile, held under the project manager's lock.
 */
export function initializeBuiltinPlugins(profileDir: string): void {
  const receipt = join(profileDir, RECEIPT)
  if (existsSync(receipt)) return
  const manifest = readProfileManifest('desktop', profileDir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some(bundle => typeof bundle !== 'string')) {
    throw new Error('desktop: profile bundles must be a list of package names')
  }
  // A profile-local dependency without an enabled bundle records an existing user opt-out.
  if (!bundles.includes(CUSTOM_MODE) && !Object.hasOwn(manifest.dependencies ?? {}, CUSTOM_MODE)) {
    writeProfileManifest(profileDir, {
      ...manifest,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, CUSTOM_MODE] } },
    })
  }
  writeFileSync(receipt, '{"version":1}\n', { mode: 0o600, flag: 'wx' })
}
