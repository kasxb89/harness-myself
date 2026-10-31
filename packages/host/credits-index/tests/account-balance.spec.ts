/** Funding identity comes from the account gateway, never a provider quota or diagnostic text. */
import { describe, expect, it } from 'vitest'
import { accountBalanceFailure, isAccountBalanceRejection, isAccountBalanceRejectionText } from '../src/account-balance.ts'

describe('product-account funding failures', () => {
  it.each([402, 403])('recognizes exact gateway funding identity at HTTP%s', (status) => {
    for (const body of [{ code: 'insufficient_user_quota' },
      { error: { code: 'insufficient_user_quota', type: 'new_api_error' } },
      { error: { code: 'insufficient_user_quota', type: 'invalid_request_error' } }]) {
      expect(isAccountBalanceRejection(body, status)).toBe(true)
      expect(isAccountBalanceRejectionText(JSON.stringify(body), status)).toBe(true)
    }
    expect(accountBalanceFailure('insufficient_user_quota')).toEqual({ code: 'INSUFFICIENT_BALANCE', message: '余额不足，请充值' })
  })

  it.each(['pre_consume_token_quota_failed', 'insufficient_quota', 'QUOTA', 'quota_exceeded', 'provider_quota_exhausted'])
  ('keeps %s separate from product-account funding', (code) => {
    expect(accountBalanceFailure(code)).toBeUndefined()
    expect(isAccountBalanceRejection({ error: { code, type: 'new_api_error' } }, 403)).toBe(false)
  })

  it('does not infer ownership from HTTP status, diagnostic text, or a provider envelope', () => {
    expect(isAccountBalanceRejection({ message: '余额不足 insufficient balance' }, 402)).toBe(false)
    expect(isAccountBalanceRejection({ code: 'permission_denied', message: 'insufficient balance' }, 403)).toBe(false)
    expect(isAccountBalanceRejection({ error: { code: 'insufficient_user_quota', type: 'upstream_error' } }, 403)).toBe(false)
    expect(isAccountBalanceRejectionText('private malformed response', 403)).toBe(false)
    expect(isAccountBalanceRejection({ code: 'insufficient_user_quota' }, 500)).toBe(false)
  })
})
