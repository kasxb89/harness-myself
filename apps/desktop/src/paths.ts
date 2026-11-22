/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable product-owned configuration paths; account and Session data remain in the Harness home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve the product configuration below the existing data root, without importing another desktop's profile.
 * @param dshHome - Existing Harness data home; account, Session and task storage keep their paths.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = resolveDshHome()): DesktopPaths {
  const profile = join(dshHome, 'products', 'yunshu', 'profiles', 'desktop')
  return {
    profile,
    lock: join(profile, 'lock'),
  }
}
