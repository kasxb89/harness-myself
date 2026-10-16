/** Validated API roots and routes retain a deployment's reverse-proxy prefix. */

function safePath(path: string): boolean {
  if (/[\\\u0000-\u0020\u007f]/u.test(path) || /%(?:2f|5c|25)/iu.test(path)) return false
  try {
    return path.split('/').every(segment => !['.', '..'].includes(decodeURIComponent(segment)))
  } catch (_invalidEncoding: unknown) {
    // Malformed path encoding cannot identify one trusted upstream route.
    return false
  }
}

/**
 * Validate an HTTP API root without discarding its path prefix.
 * @param raw - Configured root; plain HTTP is reserved for local services.
 * @returns A canonical URL without a trailing slash.
 * @throws Error when credentials, suffixes, transport, or the deployed instance path are unsafe.
 */
export function normalizeApiBaseUrl(raw: string): string {
  if (!/^https?:\/\//iu.test(raw) || raw !== raw.trim() || raw.includes('?') || raw.includes('#')
    || /[\\\u0000-\u0020\u007f]/u.test(raw)) throw new Error('Invalid API base URL')
  const authority = raw.slice(raw.indexOf('://') + 3).split('/')[0] ?? ''
  if (authority === '' || authority.includes('@')) throw new Error('Invalid API base URL')
  const rawPath = raw.replace(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*/iu, '').split(/[?#]/u)[0] ?? ''
  const url = new URL(raw)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || !safePath(rawPath)) throw new Error('Invalid API base URL')
  const prefix = url.pathname.replace(/\/+$/u, '')
  if (url.hostname === '8.133.202.230' && (url.protocol !== 'https:' || url.port !== '' || prefix !== '/harness')) {
    throw new Error('Harness API requires https://8.133.202.230/harness')
  }
  return url.origin + prefix
}

/**
 * Append one API route while retaining the configured reverse-proxy prefix.
 * @param baseUrl - Configured API root.
 * @param route - Absolute API path, optionally followed by query parameters.
 * @returns A same-origin URL under the complete configured root.
 * @throws Error when a route can replace the origin or escape the configured prefix.
 */
export function apiUrl(baseUrl: string, route: string): string {
  const base = normalizeApiBaseUrl(baseUrl)
  const path = route.split('?')[0] ?? ''
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('#') || !safePath(path)) {
    throw new Error('Invalid API route')
  }
  const root = new URL(base)
  const url = new URL(base + route)
  const prefix = root.pathname.replace(/\/+$/u, '')
  if (url.origin !== root.origin || !url.pathname.startsWith(prefix + '/')) throw new Error('API route escapes configured root')
  return url.href
}
