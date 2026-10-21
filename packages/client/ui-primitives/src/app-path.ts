/** Resolve canonical Host paths within the browser application's public mount. @module */

/**
 * Keep an internal API or media path beneath the document's application directory.
 * @param path - Canonical local path, beginning with one slash; query and fragment are retained.
 * @param baseURI - Browser document base; the root fallback also supports non-DOM consumers.
 * @returns Same-origin pathname, query and fragment with the public mount prepended.
 */
export function appPath(path: string, baseURI = typeof document === 'undefined' ? 'https://app.invalid/' : document.baseURI): string {
  const pathname = path.split(/[?#]/u)[0] ?? ''
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch (_invalidEncoding) { throw new TypeError('Expected a canonical application path') }
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\\\u0000-\u001f\u007f]/u.test(path) || /\s/u.test(path)
    || decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..')) {
    throw new TypeError('Expected a canonical application path')
  }
  const base = new URL('.', baseURI)
  const target = new URL(path.slice(1), base)
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw new TypeError('Application path escapes its mount')
  return `${target.pathname}${target.search}${target.hash}`
}
