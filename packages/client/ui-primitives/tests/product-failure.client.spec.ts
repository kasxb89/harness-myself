import { describe, expect, it } from 'vitest'
import { productFailureKind } from '../src/product-failure.ts'

describe('product failure presentation', () => {
  it.each(['INVALID_REQUEST', 'AUTH', 'QUOTA', 'SERVER', 'HTTP_400', 'TRANSPORT', 'unknown', undefined, null])(
    'classifies upstream or unrecognized code %s without inspecting diagnostic text', (code) => {
      expect(productFailureKind(code)).toBe('busy')
    },
  )

  it.each([
    ['ACCOUNT_SIGNED_OUT', 'signed-out'], ['ACCOUNT_SIGN_IN_REQUIRED', 'sign-in'],
    ['SESSION_REQUIRED', 'sign-in'], ['SESSION_EXPIRED', 'sign-in'], ['RELAY_MISSING', 'sign-in'],
    ['ACCOUNT_QUOTA', 'insufficient-credits'], ['INSUFFICIENT_POINTS', 'insufficient-credits'],
    ['INSUFFICIENT_BALANCE', 'insufficient-credits'], ['ABORTED', 'cancelled'],
    ['CANCELLED', 'cancelled'], ['USER_CANCELLED', 'cancelled'],
  ])('retains actionable category for stable product code %s', (code, category) => {
    expect(productFailureKind(code)).toBe(category)
  })

  it('does not invoke a diagnostic object or mutate its details', () => {
    const diagnostic = Object.freeze({ code: 'INVALID_REQUEST', message: 'private upstream error', requestId: 'private-id' })
    expect(productFailureKind(diagnostic)).toBe('busy')
    expect(diagnostic.message).toBe('private upstream error')
    expect(diagnostic.requestId).toBe('private-id')
  })
})
