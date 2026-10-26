/** Safe read failures and monotonic retry deadlines shared by account views. */
export interface CreditsReadFailure {
  readonly kind: 'accountChanged' | 'network' | 'timeout' | 'auth' | 'access' | 'rateLimited' | 'service' | 'invalid' | 'unavailable' | 'failed'
  readonly code: string
  readonly httpStatus?: number
  readonly retryAfterSeconds?: number
  /** In-memory performance.now() deadline; never persisted across page loads. */
  readonly retryAt?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Normalize an HTTP envelope or local read exception without exposing its raw message.
 * @param value - Untrusted read response or caught exception.
 * @param fallback - Owning operation's stable unavailable code.
 * @param status - Observed local HTTP status when available.
 * @returns A localized failure category and an optional server-directed retry deadline.
 */
export function creditsReadFailure(value: unknown, fallback: string, status?: number): CreditsReadFailure {
  const envelope = record(value)
  const detail = record(envelope?.failure) ?? envelope
  const code = typeof detail?.code === 'string' ? detail.code : fallback
  const declaredStatus = detail?.httpStatus ?? envelope?.httpStatus ?? envelope?.status ?? status
  const httpStatus = typeof declaredStatus === 'number' ? declaredStatus : undefined
  const seconds = detail?.retryAfterSeconds ?? envelope?.retryAfterSeconds
  const retryAfterSeconds = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
  const kind: CreditsReadFailure['kind'] = code === 'ACCOUNT_CHANGED' ? 'accountChanged' : httpStatus === 429 || /(?:RATE_LIMITED|HTTP_429)$/u.test(code) || code === '429' ? 'rateLimited'
    : httpStatus === 401 || ['SESSION_REQUIRED', 'SESSION_INVALID', 'AUTH_TOKEN_EXPIRED', 'ACCOUNT_AUTH_REQUIRED', 'BALANCE_AUTH_REQUIRED'].includes(code) ? 'auth'
      : httpStatus === 403 || /(?:ACCESS_DENIED|ACCESS_REQUIRED|FORBIDDEN)$/u.test(code) ? 'access'
        : httpStatus === 408 || httpStatus === 504 || /TIMEOUT$/u.test(code) || value instanceof DOMException && value.name === 'TimeoutError' ? 'timeout'
          : /(?:NETWORK_ERROR|TRANSPORT)$/u.test(code) || value instanceof TypeError ? 'network'
            : httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599 ? 'service'
              : /(?:INVALID_RESPONSE|INVALID_DATA|PROTOCOL)$/u.test(code) || value instanceof SyntaxError ? 'invalid'
                : /(?:UNAVAILABLE|CONVERSION_UNAVAILABLE)$/u.test(code) || httpStatus === 404 ? 'unavailable' : 'failed'
  return { kind, code, ...httpStatus === undefined ? {} : { httpStatus },
    ...retryAfterSeconds === undefined ? {} : { retryAfterSeconds, retryAt: performance.now() + retryAfterSeconds * 1000 } }
}

/**
 * Read a server-directed cooldown without depending on the system wall clock.
 * @param failure - Current account or usage read failure.
 * @returns Remaining whole seconds, or zero when no cooldown remains.
 */
export function creditsRetrySeconds(failure: CreditsReadFailure | null | undefined): number {
  return Math.max(0, Math.ceil(((failure?.retryAt ?? 0) - performance.now()) / 1000))
}
