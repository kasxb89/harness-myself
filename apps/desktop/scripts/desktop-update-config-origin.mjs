/** Validate the fixed backend authority embedded in signed Desktop releases. */

/**
 * Read an explicit release input without supplying a production deployment default.
 * @param {NodeJS.ProcessEnv} environment - File-owned release configuration.
 * @returns {string | undefined} HTTPS origin, or no configured authority.
 */
export function resolvePackagedDesktopUpdateConfigOrigin(environment) {
  const value = environment.DSH_DESKTOP_UPDATE_CONFIG_ORIGIN
  if (value === undefined || value === '') return undefined
  if (!/^https:\/\//iu.test(value) || /[\u0000-\u0020\u007f\\?#]/u.test(value)) {
    throw new Error('desktop package: DSH_DESKTOP_UPDATE_CONFIG_ORIGIN requires an HTTPS origin')
  }
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('desktop package: DSH_DESKTOP_UPDATE_CONFIG_ORIGIN requires an HTTPS origin') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('desktop package: DSH_DESKTOP_UPDATE_CONFIG_ORIGIN requires an HTTPS origin without credentials, path, query, or fragment')
  }
  return parsed.origin
}
