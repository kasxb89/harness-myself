/** Safe session-check failures shared by the native shell and its welcome renderer. */

/** Bounded categories; no server messages or credential values cross this interface. */
export type WelcomeSessionIssue = 'network' | 'timeout' | 'rate_limited' | 'upstream_unavailable'
  | 'upstream_rejected' | 'protocol' | 'identity_mismatch' | 'renewal_unavailable' | 'storage'
  | 'account_unavailable' | 'host_unavailable'

/** A failed check does not establish either a signed-in or a signed-out account. */
export type WelcomeRecoveryState = { readonly kind: 'ready' }
  | { readonly kind: 'unavailable'; readonly reason: WelcomeSessionIssue }

/** Local transport failure whose caller can safely offer another read without changing credentials. */
export class DesktopWelcomeUnavailableError extends Error {
  /** @param reason - Safe category owned by the failed read. */
  constructor(readonly reason: WelcomeSessionIssue) {
    super('desktop welcome: session check unavailable')
    this.name = 'DesktopWelcomeUnavailableError'
  }
}

/** Upper bound for each finite local authentication/session request, including its response body. */
export const WELCOME_REQUEST_TIMEOUT_MS = 15_000

/**
 * Perform a bounded local request, retaining no transport diagnostics in the recovery state.
 * @param send - Owned HTTP transport.
 * @param input - Fixed local Host destination.
 * @param init - Request options and an optional shorter cancellation signal.
 * @returns Response headers; its body remains governed by the same abort signal.
 */
export async function fetchDesktopWelcome(
  send: (input: string, init?: RequestInit) => Promise<Response>, input: string, init: RequestInit,
): Promise<Response> {
  const timeout = AbortSignal.timeout(WELCOME_REQUEST_TIMEOUT_MS)
  const signal = init.signal === undefined || init.signal === null ? timeout : AbortSignal.any([timeout, init.signal])
  try { return await send(input, { ...init, signal }) }
  catch { throw new DesktopWelcomeUnavailableError(signal.aborted ? 'timeout' : 'network') }
}
