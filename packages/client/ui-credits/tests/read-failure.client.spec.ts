/** Actual Host error envelopes retain their specific safe classifications. */
import { describe, expect, it } from 'vitest'
import { creditsReadFailure } from '../src/client/read-failure.ts'
describe('Host account failure envelopes', () => {
  it.each([
    ['ACCOUNT_NETWORK_ERROR', 'network', undefined],
    ['ACCOUNT_TIMEOUT', 'timeout', undefined],
    ['ACCOUNT_INVALID_RESPONSE', 'invalid', 200],
    ['ACCOUNT_RATE_LIMITED', 'rateLimited', 429],
    ['ACCOUNT_UNAVAILABLE', 'service', 503],
    ['ACCOUNT_AUTH_REQUIRED', 'auth', 401],
    ['ACCOUNT_ACCESS_DENIED', 'access', 403],
  ] as const)('uses %s when the nested diagnostic has no code', (code, kind, status) => {
    const result = creditsReadFailure({ code, httpStatus: status ?? 200,
      failure: { reason: 'fixture-safe-category', stage: 'account-read', ...status === undefined ? {} : { status } } }, 'ACCOUNT_UNAVAILABLE')
    expect(result).toMatchObject({ code, kind })
  })
  it('accepts a nested observed status and keeps explicit nested codes authoritative', () => {
    expect(creditsReadFailure({ code: 'ACCOUNT_UNAVAILABLE', httpStatus: 200,
      failure: { status: 429, code: 'ACCOUNT_RATE_LIMITED', retryAfterSeconds: 2 } }, 'ACCOUNT_UNAVAILABLE'))
      .toMatchObject({ kind: 'rateLimited', code: 'ACCOUNT_RATE_LIMITED', httpStatus: 429, retryAfterSeconds: 2 })
  })
})
