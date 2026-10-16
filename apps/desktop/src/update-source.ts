/** Main-process-only discovery of a target feed from the packaged backend authority. */
import type { DesktopUpdateSourceFailureKind } from './ipc.ts'

/** A configured generic Nightly directory; publisher identity stays in signed app-update.yml. */
export interface DesktopUpdateSource {
  readonly url: string
  readonly channel: 'nightly'
}

/** Expected discovery failure; diagnostics never contain remote content or credential-bearing URLs. */
export class DesktopUpdateSourceError extends Error {
  /**
   * @param kind - Stable cause localized by the receiving presentation.
   * @param options - Retained internal cause.
   */
  constructor(readonly kind: DesktopUpdateSourceFailureKind, options?: ErrorOptions) { super(kind, options) }
}

/** Trusted process settings, never supplied by a renderer or the remote response. */
export interface DesktopUpdateSourceConfig {
  readonly origin: string | undefined
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly allowLoopbackHttp: boolean
}

/**
 * Select the backend authority without letting ambient environment override a signed application.
 * @param packaged - Whether Electron runs an installed package.
 * @param manifest - Parsed application manifest from app.getAppPath().
 * @param environment - Development launcher child environment.
 * @returns Fixed authority, or undefined until the release operator configures one.
 */
export function resolveDesktopUpdateConfigOrigin(packaged: boolean, manifest: unknown, environment: NodeJS.ProcessEnv): string | undefined {
  if (!packaged) return environment.DSH_DESKTOP_UPDATE_CONFIG_ORIGIN
  if (typeof manifest !== 'object' || manifest === null || !('dshDesktopUpdateConfigOrigin' in manifest)) return undefined
  if (typeof manifest.dshDesktopUpdateConfigOrigin !== 'string') throw new DesktopUpdateSourceError('source-invalid')
  return manifest.dshDesktopUpdateConfigOrigin
}

function trustedUrl(value: string, allowLoopbackHttp: boolean, originOnly: boolean): URL {
  if (!/^https?:\/\//iu.test(value) || /[\u0000-\u0020\u007f\\?#]/u.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c|2f)/iu.test(value)) {
    throw new DesktopUpdateSourceError('source-invalid')
  }
  let parsed: URL
  try { parsed = new URL(value) } catch (cause) { throw new DesktopUpdateSourceError('source-invalid', { cause }) }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
  if ((parsed.protocol !== 'https:' && !(allowLoopbackHttp && loopback && parsed.protocol === 'http:'))
    || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== ''
    || (originOnly ? parsed.pathname !== '/' : /\.(?:ya?ml|exe|zip|dmg|blockmap|json)\/?$/iu.test(parsed.pathname))) throw new DesktopUpdateSourceError('source-invalid')
  if (!originOnly && !parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

/**
 * Read public status anonymously, with an eight-second total deadline and a 512 KiB response cap.
 * Discovery owns request cleanup. A failure yields no reusable source and never selects a previous feed.
 * @param config - Fixed authority and application target; HTTP is restricted to explicit loopback development.
 * @param fetcher - Fetch transport, replaceable at the HTTP test boundary.
 * @returns Validated current-target generic feed directory.
 * @throws DesktopUpdateSourceError for unavailable, disabled, missing, or malformed configuration.
 */
export async function resolveDesktopUpdateSource(
  config: DesktopUpdateSourceConfig,
  fetcher: typeof fetch = fetch,
): Promise<DesktopUpdateSource> {
  if (config.origin === undefined || config.origin === '') throw new DesktopUpdateSourceError('source-unbound')
  const origin = trustedUrl(config.origin, config.allowLoopbackHttp, true).origin
  const os = config.platform === 'darwin' ? 'mac' : config.platform === 'win32' ? 'win' : config.platform
  const target = `${os}-${config.arch}`
  if (!['mac-arm64', 'mac-x64', 'win-x64'].includes(target)) throw new DesktopUpdateSourceError('source-unsupported-target')
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 8_000)
  timer.unref()
  try {
    const response = await fetcher(`${origin}/api/status`, { redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal })
    if (!response.ok || response.redirected) throw new DesktopUpdateSourceError('source-unavailable')
    const maximum = 512 * 1024
    if (Number(response.headers.get('content-length')) > maximum || response.body === null) throw new DesktopUpdateSourceError('source-invalid')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > maximum) { await reader.cancel(); throw new DesktopUpdateSourceError('source-invalid') }
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (cause) { throw new DesktopUpdateSourceError('source-invalid', { cause }) }
    if (!record(body) || body.success !== true || !record(body.data) || !record(body.data.desktop_update)) throw new DesktopUpdateSourceError('source-invalid')
    const update = body.data.desktop_update
    if (typeof update.enabled !== 'boolean' || update.channel !== 'nightly' || !record(update.feeds)) throw new DesktopUpdateSourceError('source-invalid')
    if (!update.enabled) throw new DesktopUpdateSourceError('source-disabled')
    const value = update.feeds[target]
    if (value === '') throw new DesktopUpdateSourceError('source-target-missing')
    if (typeof value !== 'string') throw new DesktopUpdateSourceError('source-invalid')
    return { url: trustedUrl(value, config.allowLoopbackHttp, false).href, channel: 'nightly' }
  } catch (cause) {
    if (cause instanceof DesktopUpdateSourceError) throw cause
    throw new DesktopUpdateSourceError('source-unavailable', { cause })
  } finally { clearTimeout(timer); controller.abort() }
}
