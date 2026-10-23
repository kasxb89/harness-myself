import type { ProductEvent } from '@deepseek-ai/dsh-client-product-analytics/types'
/** Native welcome operations using the shared Web authentication and RPC APIs. */

import { randomUUID } from 'node:crypto'
import type { DesktopActivitySample } from './client-activity.ts'
import { desktopAccountBackend, type DesktopAccountBackend } from './account-backend.ts'
import { DesktopWelcomeUnavailableError, fetchDesktopWelcome, type WelcomeSessionIssue } from './welcome-session.ts'

/** Metadata needed before the native entry or workspace becomes visible. */
export interface WelcomeState {
  readonly loggedIn: boolean
  /** Legacy onboarding fields; manual provider-key entry is disabled in the product. */
  readonly hasApiKey: false
  readonly writable: false
  readonly localePreference: string | null
  /** Present when login validity is unknown; `loggedIn` remains false until a verified read. */
  readonly sessionIssue?: WelcomeSessionIssue
}

/** Narrow operations available to the native welcome flow. */
export interface DesktopWelcomeBackend {
  /** Cancel in-flight native reads before Host teardown. */
  dispose(): void
  /** @returns the current Host policy; every read observes live configuration. */
  analyticsEnabled(): Promise<boolean>
  readonly account: DesktopAccountBackend
  /** @param sample - native high-level presence, without identity or content. @param signal - bounded local transport lifetime. */
  activity(sample: DesktopActivitySample, signal: AbortSignal): Promise<void>
  /** @param event - desktop-owned fields. @returns after local Host intake. */
  report(event: ProductEvent): Promise<void>
  /** @returns Product phone-session status and the shared language preference, without credential values. */
  read(): Promise<WelcomeState>
  /** @returns The saved UI language without account or provider requests. */
  readLocalePreference(): Promise<string | null>
  /**
   * @param apiKey - User-entered official provider key.
   * @returns A safe write outcome without provider diagnostics.
   */
  save(apiKey: string): Promise<{ ok: boolean }>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Authenticate the native HTTP client through the Web application's launch URL.
 * @param authenticatedUrl - URL supplied by the running Desktop Host.
 * @param send - Electron session fetch, retaining the Web authentication cookie.
 * @returns metadata reads and write-only credential operations over standard RPC.
 */
export async function connectDesktopWelcome(
  authenticatedUrl: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
  cookies: () => Promise<string> = () => Promise.resolve(''),
): Promise<DesktopWelcomeBackend> {
  const origin = new URL(authenticatedUrl).origin
  const lifetime = new AbortController()
  let authentication: Promise<void> | undefined
  const authenticate = (): Promise<void> => authentication ??= (async () => {
    const authenticated = await fetchDesktopWelcome(send, authenticatedUrl, { credentials: 'include', signal: lifetime.signal })
    try { await authenticated.body?.cancel() }
    catch (error) { throw new DesktopWelcomeUnavailableError(error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network') }
    if (!authenticated.ok) {
      if (authenticated.status === 408 || authenticated.status === 429 || authenticated.status >= 500) {
        throw new DesktopWelcomeUnavailableError(authenticated.status === 408 || authenticated.status === 504 ? 'timeout'
          : authenticated.status === 429 ? 'rate_limited' : 'host_unavailable')
      }
      throw new Error('desktop welcome: Web authentication failed')
    }
  })().catch((error: unknown) => { authentication = undefined; throw error })
  let initialIssue: WelcomeSessionIssue | undefined
  try { await authenticate() }
  catch (error) {
    if (!(error instanceof DesktopWelcomeUnavailableError)) throw error
    initialIssue = error.reason
  }
  const invoke = async (
    request: { namespace: string; method: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown> => {
    await authenticate()
    const rpcId = randomUUID()
    const method = `${request.namespace}/${request.method}`
    const response = await fetchDesktopWelcome(send, new URL(`/api/${method}`, origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error', signal: signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    })
    if (!response.ok) {
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new DesktopWelcomeUnavailableError(response.status === 408 || response.status === 504 ? 'timeout'
          : response.status === 429 ? 'rate_limited' : 'host_unavailable')
      }
      throw new Error('desktop welcome: Web request failed')
    }
    let envelope: unknown
    try { envelope = await response.json() }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('desktop welcome: Web RPC failed')
      throw new DesktopWelcomeUnavailableError(error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network')
    }
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('desktop welcome: Web RPC failed')
    }
    return envelope.result.value
  }
  const account = desktopAccountBackend(origin, invoke, cookies)
  const settingsAndReference = async () => {
    const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
    if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
    const official: unknown = settings.namespaces.find((item: unknown) => record(item) && item.ns === 'llm-deepseek')
    if (official === undefined) return { settings: { namespaces: settings.namespaces }, ref: undefined }
    if (!record(official) || !record(official.value) || typeof official.value.apiKeyEnv !== 'string') {
      throw new Error('desktop welcome: missing official DeepSeek credential reference')
    }
    return { settings: { namespaces: settings.namespaces }, ref: official.value.apiKeyEnv }
  }
  const localePreference = (namespaces: unknown[]): string | null => {
    const locale: unknown = namespaces.find((item: unknown) => record(item) && item.ns === 'locale')
    if (!record(locale) || !record(locale.value)
      || (locale.value.preference !== undefined && typeof locale.value.preference !== 'string')) {
      throw new Error('desktop welcome: invalid locale preference')
    }
    return locale.value.preference ?? null
  }
  const readLocalePreference = async (): Promise<string | null> => {
    const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
    if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
    return localePreference(settings.namespaces)
  }
  const read = async (): Promise<WelcomeState> => {
    let preference: string | null = null
    try { preference = await readLocalePreference() }
    catch (error) { if (!(error instanceof DesktopWelcomeUnavailableError)) throw error }
    const unavailable = (sessionIssue: WelcomeSessionIssue): WelcomeState => ({
      loggedIn: false, hasApiKey: false, writable: false, localePreference: preference, sessionIssue,
    })
    if (initialIssue !== undefined) {
      const issue = initialIssue
      initialIssue = undefined
      return unavailable(issue)
    }
    let response: Response
    try {
      await authenticate()
      response = await fetchDesktopWelcome(send, new URL('/credits/api/session', origin).href, {
        credentials: 'include', redirect: 'error', signal: lifetime.signal,
      })
    } catch (error) {
      if (error instanceof DesktopWelcomeUnavailableError) return unavailable(error.reason)
      throw error
    }
    if (!response.ok) {
      if (response.status === 408 || response.status === 504) return unavailable('timeout')
      if (response.status === 429) return unavailable('rate_limited')
      if (response.status >= 500) return unavailable('host_unavailable')
      throw new Error('desktop welcome: product session request failed')
    }
    let session: unknown
    try { session = await response.json() }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('desktop welcome: invalid product session')
      return unavailable(error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network')
    }
    if (!record(session) || typeof session.signedIn !== 'boolean') throw new Error('desktop welcome: invalid product session')
    if (session.ok === false && session.code === 'ACCOUNT_UNAVAILABLE' && session.signedIn && session.liveness === 'unknown') {
      let issue: WelcomeSessionIssue = 'account_unavailable'
      if (session.failure !== undefined) {
        const failure = session.failure
        const reasons: readonly string[] = ['network', 'timeout', 'rate_limited', 'upstream_unavailable', 'upstream_rejected',
          'protocol', 'identity_mismatch', 'renewal_unavailable', 'storage']
        if (!record(failure) || typeof failure.reason !== 'string' || !reasons.includes(failure.reason)
          || !['account-read', 'renewal'].includes(String(failure.stage))
          || (failure.status !== undefined
            && (!Number.isInteger(failure.status) || Number(failure.status) < 100 || Number(failure.status) > 599))) {
          throw new Error('desktop welcome: invalid product session failure')
        }
        issue = failure.reason as WelcomeSessionIssue
      }
      return unavailable(issue)
    }
    if (session.ok !== true || (session.signedIn && session.liveness !== undefined && session.liveness !== 'verified')) {
      throw new Error('desktop welcome: invalid product session')
    }
    return {
      loggedIn: session.signedIn,
      hasApiKey: false,
      writable: false,
      localePreference: preference,
    }
  }
  return {
    dispose() { lifetime.abort() },
    account,
    read,
    async activity(sample, signal) {
      const response = await send(new URL('/credits/api/activity', origin).href, {
        method: 'POST', credentials: 'include', redirect: 'error', signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample),
      })
      await response.body?.cancel()
      if (!response.ok) throw new Error('desktop activity: Host unavailable')
    },
    async analyticsEnabled() {
      const enabled = await invoke({ namespace: 'productAnalytics', method: 'enabled', args: {} }, AbortSignal.timeout(1000))
      if (typeof enabled !== 'boolean') throw new Error('desktop analytics: invalid collection policy')
      return enabled
    },
    async report(event) { await invoke({ namespace: 'productAnalytics', method: 'report', args: { event } }, AbortSignal.timeout(1000)) },
    readLocalePreference,
    async save(apiKey) {
      if (!/^[\x21-\x7e]+$/.test(apiKey)) return { ok: false }
      try {
        const { ref } = await settingsAndReference()
        if (ref === undefined) return { ok: false }
        await invoke({ namespace: 'credentials', method: 'set', args: { ref, value: apiKey } })
        return { ok: true }
      } catch {
        // Provider diagnostics may contain credentials; the native form owns failure copy.
        return { ok: false }
      }
    },
  }
}
