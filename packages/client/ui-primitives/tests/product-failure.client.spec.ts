import { describe, expect, it } from 'vitest'
import { productFailureKind } from '../src/product-failure.ts'

describe('product failure presentation', () => {
  it.each(['AUTH', 'QUOTA', 'SERVER', 'unknown', undefined, null])(
    'keeps unrecognized code %s unconfirmed without attributing a server fault', (code) => {
      expect(productFailureKind(code)).toBe('unknown')
    },
  )

  it.each([
    ['ACCOUNT_SIGNED_OUT', 'signed-out'], ['ACCOUNT_SIGN_IN_REQUIRED', 'sign-in'],
    ['SESSION_REQUIRED', 'sign-in'], ['SESSION_EXPIRED', 'sign-in'], ['RELAY_MISSING', 'sign-in'],
    ['SESSION_INVALID', 'sign-in'], ['HTTP_401', 'sign-in'],
    ['ACCOUNT_QUOTA', 'insufficient-credits'], ['INSUFFICIENT_POINTS', 'insufficient-credits'],
    ['INSUFFICIENT_USER_QUOTA', 'insufficient-credits'], ['INSUFFICIENT_TOKEN_QUOTA', 'insufficient-credits'],
    ['insufficient_user_quota', 'insufficient-credits'],
    ['INSUFFICIENT_BALANCE', 'insufficient-credits'], ['ABORTED', 'cancelled'],
    ['CANCELLED', 'cancelled'], ['USER_CANCELLED', 'cancelled'],
    ['TRANSPORT', 'network'], ['NETWORK', 'network'], ['ECONNRESET', 'network'],
    ['ENOTFOUND', 'network'], ['EAI_AGAIN', 'network'], ['TIMEOUT', 'timeout'],
    ['TRANSPORT_TIMEOUT', 'timeout'], ['HTTP_REQUEST_TIMEOUT', 'timeout'], ['HTTP_408', 'timeout'],
    ['VIDEO_QUERY_TIMEOUT', 'timeout'], ['IMAGE_SUBMIT_TIMEOUT', 'timeout'],
    ['INVALID_REQUEST', 'invalid-input'], ['INVALID_ARGUMENT', 'invalid-input'], ['INVALID_ARGS', 'invalid-input'],
    ['VIDEO_EDIT_INVALID_INPUT', 'invalid-input'], ['RATIO_NOT_SUPPORTED', 'invalid-input'],
    ['HTTP_400', 'invalid-input'], ['HTTP_413', 'invalid-input'], ['HTTP_415', 'invalid-input'],
    ['IMAGE_INPUT_TOO_LARGE', 'invalid-input'], ['IMAGE_FORMAT_UNSUPPORTED', 'invalid-input'],
    ['IMAGE_EMPTY', 'invalid-input'], ['HTTP_403', 'forbidden'], ['HTTP_429', 'busy'],
    ['H3_ACCOUNT_CAPACITY_EXHAUSTED', 'busy'],
    ['media_account_capacity_exhausted', 'busy'],
    ['HTTP_500', 'service'], ['HTTP_502', 'service'], ['HTTP_503', 'service'], ['HTTP_504', 'timeout'],
    ['UPSTREAM_AUTH', 'upstream'], ['PROVIDER_TASK_FAILED', 'upstream'], ['TASK_FAILED', 'upstream'],
    ['H3_UPSTREAM_AUTH_REJECTED', 'upstream'],
    ['LOCAL_SAVE_FAILED', 'local'], ['ARTIFACT_PUBLISH_FAILED', 'local'], ['IMAGE_RECEIPT_UNAVAILABLE', 'local'],
  ])('retains the observed category for stable code %s', (code, category) => {
    expect(productFailureKind(code)).toBe(category)
  })

  it.each(['HTTP_500 private', ' HTTP_503', 'HTTP_5000', 'HTTP_503\n', 'http_503', 'HTTP_5xx'])(
    'does not parse a malformed status or diagnostic string %s', (code) => {
      expect(productFailureKind(code)).toBe('unknown')
    },
  )

  it.each(['INVALID_ARGS_EXTRA', 'INSUFFICIENT_USER_QUOTA_EXTRA', 'INSUFFICIENT_TOKEN_QUOTA_EXTRA', 'CREATIVE_INVALID',
    'media_account_capacity_exhausted_EXTRA', ' media_account_capacity_exhausted', 'H3_UPSTREAM_AUTH_REJECTED\n',
    'insufficient_user_quota_extra'])(
    'keeps unrelated or extended code %s unconfirmed', (code) => {
      expect(productFailureKind(code)).toBe('unknown')
    },
  )

  it('does not invoke a diagnostic object or mutate its details', () => {
    const diagnostic = Object.freeze({ code: 'INVALID_REQUEST', message: 'private upstream error', requestId: 'private-id' })
    expect(productFailureKind(diagnostic)).toBe('unknown')
    expect(diagnostic.message).toBe('private upstream error')
    expect(diagnostic.requestId).toBe('private-id')
  })
})
