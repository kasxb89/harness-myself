/** Validate the fixed backend authority embedded in Desktop packages. */

import { resolveDesktopAutoUpdateTarget } from './desktop-auto-update-environment.mjs'

/**
 * Read an explicit release input without supplying a production deployment default.
 * @param {NodeJS.ProcessEnv} environment - File-owned release configuration.
 * @returns {string | undefined} HTTPS backend base, or no configured authority.
 */
export function resolvePackagedDesktopUpdateConfigOrigin(environment) {
  const value = environment.DSH_DESKTOP_UPDATE_CONFIG_ORIGIN
  if (value === undefined || value === '') return undefined
  if (!/^https:\/\//iu.test(value) || /[\u0000-\u0020\u007f\\?#]/u.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c|2f)/iu.test(value)) {
    throw new Error('desktop package: DSH_DESKTOP_UPDATE_CONFIG_ORIGIN requires an HTTPS backend base')
  }
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('desktop package: DSH_DESKTOP_UPDATE_CONFIG_ORIGIN requires an HTTPS backend base') }
  const rawPath = /^https:\/\/[^/]+(\/.*)?$/iu.exec(value)?.[1] ?? '/'
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || !['/', '/harness', '/harness/'].includes(rawPath)
    || (parsed.hostname === '8.133.202.230' && parsed.pathname !== '/harness' && parsed.pathname !== '/harness/')) {
    throw new Error('desktop package: DSH_DESKTOP_UPDATE_CONFIG_ORIGIN requires an HTTPS backend base without credentials, query, or fragment; this instance requires /harness')
  }
  return parsed.href.replace(/\/$/u, '')
}

/**
 * Resolve backend discovery for an explicitly unsigned product package.
 * @param {NodeJS.ProcessEnv} environment - File-owned packaging settings.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ authority: string, publicUrl: string }} Validated backend and inert generic bootstrap directory; runtime replaces the feed from backend status before checking.
 */
export function resolveUnsignedDesktopUpdateConfig(environment, platform, arch) {
  const authority = resolvePackagedDesktopUpdateConfigOrigin({
    ...environment,
    DSH_DESKTOP_UPDATE_CONFIG_ORIGIN: environment.DSH_DESKTOP_UPDATE_CONFIG_ORIGIN || 'https://8.133.202.230/harness',
  })
  const target = resolveDesktopAutoUpdateTarget(platform, arch)
  return { authority, publicUrl: `${authority}/desktop-updates/${target}/` }
}
