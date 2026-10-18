/** Per-install GitHub transport settings; package identities and parent configuration stay unchanged. */
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { isIP } from 'node:net'
import { proxyForUrl, resolveProxyPolicy } from '@deepseek-ai/dsh-http-proxy'
import { Server } from 'proxy-chain'
import type { ParsedInstallSpec } from './install-spec.ts'

/** GitHub download origins accepted by the product's restricted forward proxy. */
const GITHUB_HOSTS = new Set([
  'github.com', 'api.github.com', 'codeload.github.com',
  'raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com', 'avatars.githubusercontent.com',
])

/**
 * Validate one credential-free HTTPS forward-proxy origin.
 * @param value Configured proxy URL.
 * @returns Canonical origin without a trailing slash.
 * @throws {Error} When the endpoint includes credentials, a path, a query, a fragment, or an invalid authority.
 */
export function normalizeGithubProxy(value: string): string {
  if (!/^https:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::\d+)?\/?$/iu.test(value)) {
    throw new Error('githubProxy must be an HTTPS proxy origin without credentials, a path, a query, or a fragment')
  }
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('githubProxy must be an HTTPS proxy origin without credentials, a path, a query, or a fragment')
  }
  return url.origin
}

/** Whether a no-proxy entry would bypass a supported GitHub download origin. */
function bypassesGithub(entry: string): boolean {
  if (entry === '*') return true
  const domain = entry.toLowerCase().replace(/:\d+$/u, '').replace(/^\*?\./u, '')
  return [...GITHUB_HOSTS].some(host => host === domain || host.endsWith(`.${domain}`))
}

/**
 * Whether a parsed package spec names a supported GitHub download host.
 * @param spec Parsed installation address.
 * @returns True for GitHub Git or tarball addresses; false for registry, local, and other hosts.
 */
export function isGithubProxySpec(spec: ParsedInstallSpec): boolean {
  const host = spec.kind === 'git' || spec.kind === 'tarball' ? spec.host?.toLowerCase().replace(/:\d+$/u, '') : undefined
  return host !== undefined && GITHUB_HOSTS.has(host)
}

/** The Git and pnpm child environment pointing at this installation's loopback router. */
function githubProxyEnvironment(proxy: string, originalEnv: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const env = { ...originalEnv }
  // The subprocess scrub omits KEY-named entries. Restore only Git's indexed setting names,
  // whose paired values already survive that scrub, before extending the existing group.
  const inheritedCount = Number(env.GIT_CONFIG_COUNT ?? '0')
  if (!Number.isSafeInteger(inheritedCount) || inheritedCount < 0) throw new Error('invalid Git configuration count')
  for (let index = 0; index < inheritedCount; index++) {
    const key = `GIT_CONFIG_KEY_${String(index)}`
    const value = `GIT_CONFIG_VALUE_${String(index)}`
    const setting = env[key] ?? process.env[key]
    if (setting === undefined || env[value] === undefined) throw new Error('incomplete Git configuration environment')
    env[key] = setting
  }
  const settings: [string, string][] = ['github.com'].flatMap(domain => [
    [`http.https://${domain}/.proxy`, proxy] as [string, string],
    ...[`git@${domain}:`, `ssh://git@${domain}/`, `ssh://git@${domain}:22/`, `http://${domain}/`]
      .map((prefix): [string, string] => [`url.https://${domain}/.insteadOf`, prefix]),
  ])
  for (const [offset, [key, value]] of settings.entries()) {
    const index = String(inheritedCount + offset)
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  }
  env.GIT_CONFIG_COUNT = String(inheritedCount + settings.length)
  const bypass = [env.NO_PROXY, env.no_proxy, env.npm_config_noproxy, env.NPM_CONFIG_NOPROXY,
    env.pnpm_config_no_proxy, env.PNPM_CONFIG_NO_PROXY, env.pnpm_config_noproxy, env.PNPM_CONFIG_NOPROXY]
    .flatMap(value => value?.split(/[\s,]+/u) ?? []).filter(value => value !== '' && !bypassesGithub(value))
  const directHosts = ['localhost', '127.0.0.1', '::1', '[::1]']
  const noProxy = [...new Set([...bypass, ...directHosts])].join(',')
  for (const key of Object.keys(env)) {
    if (/^(?:HTTPS?_PROXY|NO_PROXY|(?:P?NPM_CONFIG)_(?:HTTPS?_PROXY|NO_?PROXY))$/u.test(key.toUpperCase())) Reflect.deleteProperty(env, key)
  }
  return {
    ...env,
    HTTP_PROXY: proxy, http_proxy: proxy, npm_config_http_proxy: proxy, NPM_CONFIG_HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy, https_proxy: proxy, npm_config_https_proxy: proxy, NPM_CONFIG_HTTPS_PROXY: proxy,
    pnpm_config_http_proxy: proxy, PNPM_CONFIG_HTTP_PROXY: proxy, pnpm_config_https_proxy: proxy, PNPM_CONFIG_HTTPS_PROXY: proxy,
    NO_PROXY: noProxy, no_proxy: noProxy, npm_config_noproxy: noProxy, NPM_CONFIG_NOPROXY: noProxy,
    pnpm_config_no_proxy: noProxy, PNPM_CONFIG_NO_PROXY: noProxy, pnpm_config_noproxy: noProxy, PNPM_CONFIG_NOPROXY: noProxy,
  }
}

/** One installation's local routing server, retained until its children stop. */
export interface GithubProxyOperation {
  /** Environment shared by the Git check and every pnpm attempt of this installation. */
  readonly env: Readonly<Record<string, string>>
  /** Settles after cancellation or close has stopped the listener and all active connections. */
  readonly closed: Promise<void>
  /** Stop accepting traffic, destroy active connections, and wait for the listener to close. */
  close(): Promise<void>
}

/**
 * Start one loopback-only router: GitHub uses the configured node; all other destinations retain their original environment policy.
 * @param proxy Validated remote HTTPS forward-proxy origin.
 * @param applicationEnv Launcher-owned package-manager environment, before local proxy injection.
 * @param options Operation cancellation and the existing package-operation silence deadline.
 * @returns The child environment and an idempotent close operation. The caller must await close in finally.
 * @throws {Error} For invalid inherited proxy or Git settings, a failed listen, or cancellation; no listener is retained.
 */
export async function createGithubProxyOperation(
  proxy: string, applicationEnv: Readonly<Record<string, string>> | undefined,
  options: { signal: AbortSignal; idleTimeoutMs: number },
): Promise<GithubProxyOperation> {
  options.signal.throwIfAborted()
  const originalEnv = { ...scrubbedParentEnv(), ...applicationEnv }
  const { policy, diagnostics } = resolveProxyPolicy({
    get: name => originalEnv[name] === undefined ? undefined : { value: originalEnv[name] },
  })
  if (diagnostics.length > 0) throw new Error(diagnostics.map(diagnostic => diagnostic.message).join('\n'))
  const httpAgent = new HttpAgent({ keepAlive: false })
  const httpsAgents = new Map<string, HttpsAgent>()
  const httpsAgentFor = (upstream: string | undefined): HttpsAgent | undefined => {
    if (upstream === undefined || !upstream.startsWith('https:')) return undefined
    const url = new URL(upstream)
    let agent = httpsAgents.get(url.origin)
    if (agent === undefined) {
      const hostname = url.hostname.replace(/^\[|\]$/gu, '')
      // CONNECT's Host is the target, so Node must take upstream SNI from the proxy URL instead.
      agent = new HttpsAgent({ keepAlive: false, servername: isIP(hostname) === 0 ? hostname : '' })
      httpsAgents.set(url.origin, agent)
    }
    return agent
  }
  const server = new Server({
    host: '127.0.0.1', port: 0,
    prepareRequestFunction: ({ hostname, port, isHttp, request }) => {
      const target = isHttp ? new URL(request.url as string) : new URL(`https://${hostname}:${String(port)}`)
      const upstream = GITHUB_HOSTS.has(target.hostname.toLowerCase()) ? proxy : proxyForUrl(policy, target)
      const httpsAgent = httpsAgentFor(upstream)
      return { upstreamProxyUrl: upstream ?? null, httpAgent, ...httpsAgent === undefined ? {} : { httpsAgent } }
    },
  })
  server.server.timeout = options.idleTimeoutMs
  const settled = Promise.withResolvers<void>()
  // Abort initiates close before the installation reaches finally; that finally owns any close failure.
  void settled.promise.catch(() => {})
  let closing: Promise<void> | undefined
  const listening = server.listen()
  const close = (): Promise<void> => closing ??= (async () => {
    options.signal.removeEventListener('abort', onAbort)
    const started = await listening.then(() => true, () => false)
    try {
      const stopping = started ? server.close(true) : Promise.resolve()
      httpAgent.destroy()
      for (const agent of httpsAgents.values()) agent.destroy()
      await stopping
      settled.resolve()
    }
    catch (error) { settled.reject(error); throw error }
  })()
  const onAbort = (): void => { void close().catch(() => { /* the caller awaits close in finally */ }) }
  options.signal.addEventListener('abort', onAbort, { once: true })
  try {
    await listening
    options.signal.throwIfAborted()
    if ([policy.httpProxy, policy.httpsProxy].some((upstream) => {
      if (upstream === undefined) return false
      const url = new URL(upstream)
      return ['localhost', '127.0.0.1'].includes(url.hostname) && Number(url.port) === server.port
    })) throw new Error('existing proxy points at the installation router itself')
    const env = githubProxyEnvironment(`http://127.0.0.1:${String(server.port)}`, originalEnv)
    return { env, closed: settled.promise, close }
  } catch (error) {
    await close()
    throw error
  }
}
