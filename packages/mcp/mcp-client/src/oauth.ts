/** Browser OAuth with SDK discovery, PKCE, and endpoint-bound credentials. */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import {
  auth, extractWWWAuthenticateParams,
  type AuthProvider, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import type { StreamableHttpConfig } from './index.ts'

/** Trust boundary and optional registration information for an HTTP server. */
export interface OAuthConfig {
  /** Exact trusted authorization server origin, including scheme and optional port. */
  authorizationOrigin: string
  /** Optional pre-registered public client identifier. */
  clientId?: string
  /** Optional HTTPS Client ID Metadata Document URL. */
  clientMetadataUrl?: string
  /** Optional fixed loopback port required by a registered redirect URI. */
  redirectPort?: number
}

const exec = promisify(execFile)
const callbackPath = '/mcp/oauth/callback'
const loopback = '127.0.0.1'

/** Opens authorization URLs with the operating system browser and a scrubbed child environment. */
export const oauthBrowser = {
  async open(url: URL, signal: AbortSignal): Promise<void> {
    const argv = process.platform === 'win32'
      ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'), 'url.dll,FileProtocolHandler', url.href] as const
      : process.platform === 'darwin'
        ? ['/usr/bin/open', '--', url.href] as const
        : ['xdg-open', url.href] as const
    const [command, ...args] = argv
    await exec(command, args, { signal, env: scrubbedParentEnv(), windowsHide: true })
  },
}

function trustedUrl(value: string): URL {
  const url = new URL(value)
  const local = url.protocol === 'http:' && url.hostname === loopback
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new Error('MCP OAuth requires HTTPS, with HTTP permitted on 127.0.0.1 for local servers')
  }
  return url
}

async function listenForCallback(port: number, state: string, signal: AbortSignal) {
  const callback = Promise.withResolvers<URLSearchParams>()
  // The callback can time out before discovery reaches the browser step.
  void callback.promise.catch(() => undefined)
  const server = createServer((request, response) => {
    const url = new URL(`http://127.0.0.1${request.url?.startsWith('/') ? request.url : '/'}`)
    const params = url.searchParams
    const valid = request.method === 'GET' && url.pathname === callbackPath
      && request.headers.host === `${loopback}:${boundPort}`
      && params.getAll('state').length === 1 && params.get('state') === state
      && params.getAll('code').length <= 1 && params.getAll('iss').length <= 1
    const code = valid && !!params.get('code') && !params.has('error')
    response.writeHead(code ? 200 : 400, {
      'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8',
      'Referrer-Policy': 'no-referrer', Connection: 'close',
    })
    response.end(code ? '已收到云枢 MCP 授权结果。请返回客户端。' : '云枢 MCP 授权回调无效或已取消。')
    if (code) callback.resolve(params)
    else if (valid && params.has('error')) callback.reject(new Error('MCP OAuth authorization was declined'))
  })
  let boundPort = 0
  server.requestTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, loopback, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not start the MCP OAuth callback')
  }
  boundPort = address.port
  const abort = (): void => { callback.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return {
    url: new URL(`http://${loopback}:${address.port}${callbackPath}`),
    params: callback.promise,
    close() {
      signal.removeEventListener('abort', abort)
      server.close()
    },
  }
}

interface Grant {
  redirect?: string
  registration?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
}

/**
 * Create one credential owner shared by this server's reconnect generations.
 * @param ctx - Context providing optional persisted credentials.
 * @param server - HTTP server configuration with its trusted OAuth origin and client settings.
 * @param lifetime - Connection lifetime that cancels authorization when closed.
 * @returns Token reader and unauthorized-response handler for this server.
 */
export function createOAuth(ctx: Context, server: StreamableHttpConfig, lifetime: AbortSignal): AuthProvider {
  const config = server.oauth
  if (!config) throw new Error('MCP OAuth configuration is missing')
  const resource = trustedUrl(server.url)
  const authorization = trustedUrl(config.authorizationOrigin)
  if (authorization.href !== `${authorization.origin}/` || (resource.protocol === 'https:' && authorization.protocol !== 'https:')) {
    throw new Error('MCP OAuth authorizationOrigin must be a trusted origin')
  }
  if (config.clientId && config.clientMetadataUrl) throw new Error('Configure only one MCP OAuth client identifier')
  if (config.clientMetadataUrl && trustedUrl(config.clientMetadataUrl).protocol !== 'https:') {
    throw new Error('MCP OAuth clientMetadataUrl must use HTTPS')
  }
  const credentials = ctx.get('credentials')
  const identity = JSON.stringify([
    server.serverName, resource.href, authorization.origin, config.clientId, config.clientMetadataUrl, config.redirectPort,
  ])
  const key = credentialKey('mcp-client', `server-${createHash('sha256').update(identity).digest('hex')}`)
  let load: Promise<void> | undefined
  let grant: Grant = {}
  let inFlight: Promise<void> | undefined
  let interactiveAvailable = true
  const loadGrant = (): Promise<void> => load ??= (async () => {
    const record = await credentials?.readRecord(key)
    if (record?.kind === 'grant' && record.payload !== null && typeof record.payload === 'object') {
      grant = record.payload
    }
  })()

  const provider: AuthProvider = {
    async token() {
      await loadGrant()
      return grant.tokens?.access_token
    },
    onUnauthorized({ response }) {
      if (lifetime.aborted) return Promise.reject(new Error('MCP connection closed', { cause: lifetime.reason }))
      return inFlight ??= authorize(response, config)
        .catch(() => { throw new Error('MCP OAuth could not authorize this connection') })
        .finally(() => { inFlight = undefined })
    },
  }
  async function authorize(response: Response, config: OAuthConfig): Promise<void> {
    await loadGrant()
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(150_000)])
    const state = randomBytes(32).toString('base64url')
    const previousPort = grant.redirect ? Number(new URL(grant.redirect).port) : 0
    let pending = { ...grant }
    let callback
    try {
      callback = await listenForCallback(config.redirectPort ?? previousPort, state, signal)
    } catch (error) {
      if (config.redirectPort !== undefined || previousPort === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      callback = await listenForCallback(0, state, signal)
      pending = {}
    }
    let verifier = ''
    let discovery: OAuthDiscoveryState | undefined
    let browserParams: URLSearchParams | undefined
    const oauth: OAuthClientProvider = {
      redirectUrl: callback.url,
      ...config.clientMetadataUrl && { clientMetadataUrl: config.clientMetadataUrl },
      clientMetadata: {
        client_name: 'Yunshu', redirect_uris: [callback.url.href],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      state: () => state,
      clientInformation: context => config.clientId
        ? { client_id: config.clientId, ...context && { issuer: context.issuer } }
        : pending.registration,
      saveClientInformation: (registration) => { pending.registration = registration },
      tokens: () => pending.tokens,
      saveTokens: (tokens) => {
        pending.tokens = {
          ...tokens,
          ...browserParams === undefined && tokens.refresh_token === undefined && pending.tokens?.refresh_token !== undefined
            && { refresh_token: pending.tokens.refresh_token },
        }
      },
      saveCodeVerifier: (value) => { verifier = value },
      codeVerifier: () => verifier,
      saveDiscoveryState: (value) => { discovery = value },
      discoveryState: () => discovery,
      invalidateCredentials: (scope) => {
        if (scope === 'all' || scope === 'client') delete pending.registration
        if (scope === 'all' || scope === 'tokens') delete pending.tokens
        if (scope === 'all' || scope === 'verifier') verifier = ''
        if (scope === 'all' || scope === 'discovery') discovery = undefined
      },
      async redirectToAuthorization(url) {
        if (trustedUrl(url.href).origin !== authorization.origin) throw new Error('Untrusted MCP OAuth browser destination')
        signal.throwIfAborted()
        if (!interactiveAvailable) throw new Error('MCP OAuth requires reconnecting after an incomplete authorization')
        interactiveAvailable = false
        await oauthBrowser.open(url, signal)
        browserParams = await callback.params
      },
    }
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response)
    const options = {
      serverUrl: resource,
      ...resourceMetadataUrl && { resourceMetadataUrl },
      ...scope && { scope },
      fetchFn: (value: string | URL, init?: RequestInit) => {
        const target = trustedUrl(String(value))
        const readOnly = init?.method === undefined || init.method === 'GET'
        if (target.origin !== authorization.origin && (!readOnly || target.origin !== resource.origin)) {
          throw new Error('Untrusted MCP OAuth discovery or token destination')
        }
        return fetch(target, { ...init, signal, redirect: 'error' })
      },
    }
    try {
      signal.throwIfAborted()
      let result = await auth(oauth, options)
      if (result === 'REDIRECT' && browserParams) {
        const iss = browserParams.get('iss')
        result = await auth(oauth, {
          ...options, authorizationCode: browserParams.get('code') ?? '',
          ...iss === null ? {} : { iss },
        })
      }
      signal.throwIfAborted()
      if (result !== 'AUTHORIZED' || !pending.tokens?.access_token) throw new Error('The MCP server did not grant access')
      pending.redirect = callback.url.href
      await credentials?.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: pending }))
      grant = pending
      interactiveAvailable = true
    } finally {
      callback.close()
    }
  }
  return provider
}
