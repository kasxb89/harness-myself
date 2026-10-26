/** Safe account-read diagnostics; never retain remote bodies, credentials or exception text. */

/** The account operation which could not confirm current access. */
export type SessionFailureStage = 'account-read' | 'renewal'

/** Safe optional detail accompanying an existing ACCOUNT_UNAVAILABLE response. */
export interface SessionFailure {
  readonly reason: 'network' | 'timeout' | 'rate_limited' | 'upstream_unavailable' | 'upstream_rejected'
    | 'protocol' | 'identity_mismatch' | 'renewal_unavailable' | 'storage'
  readonly stage: SessionFailureStage
  readonly status?: number
  /** Server-directed wait retained without publishing a remote response body. */
  readonly retryAfterSeconds?: number
}

/**
 * Classify an observed HTTP response without attributing a transport failure to the server.
 * @param status - Actual upstream HTTP status.
 * @param stage - Account operation which received the response.
 * @returns Safe reason, operation and observed status only.
 */
export function sessionHttpFailure(status: number, stage: SessionFailureStage): SessionFailure {
  return { reason: status === 408 || status === 504 ? 'timeout' : status === 429 ? 'rate_limited'
    : status >= 500 ? 'upstream_unavailable' : 'upstream_rejected', stage, status }
}

/**
 * Classify a transport exception without publishing its message or cause.
 * @param error - Fetch or response-stream exception.
 * @param stage - Account operation which failed to receive a complete response.
 * @returns Timeout only for an explicit timeout marker, otherwise an unassigned network failure.
 */
export function sessionTransportFailure(error: unknown, stage: SessionFailureStage): SessionFailure {
  const timeout = (value: unknown): boolean => value !== null && typeof value === 'object'
    && (('name' in value && value.name === 'TimeoutError') || ('code' in value
      && ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(value.code))))
  const cause = error !== null && typeof error === 'object' && 'cause' in error ? error.cause : undefined
  return { reason: timeout(error) || timeout(cause) ? 'timeout' : 'network', stage }
}

/**
 * Keep malformed JSON distinct from an interrupted response stream.
 * @param error - Response JSON decoder failure.
 * @param stage - Operation decoding the response.
 * @param status - Actual successful HTTP status already received.
 * @returns Safe protocol or transport category with the observed status.
 */
export function sessionBodyFailure(error: unknown, stage: SessionFailureStage, status: number): SessionFailure {
  return { ...error instanceof SyntaxError ? { reason: 'protocol' as const, stage } : sessionTransportFailure(error, stage), status }
}
