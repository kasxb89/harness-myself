import { describe, expect, it } from 'vitest'
import { hasLocalTrunkPrefix, phoneE164, phoneEntry, phoneMessageKey, validPhoneEntry,
  validPhoneLoginCode } from '../src/client/phone-number.ts'

describe('explicit international phone entry', () => {
  it.each([
    ['13800138000', '+86', '+8613800138000'], ['8613800138000', '+86', '+8613800138000'],
    ['+86 138 0013 8000', '+86', '+8613800138000'], ['+60 12-345 6789', '+60', '+60123456789'],
    ['+81 90 1234 5678', '+81', '+819012345678'], ['+1 (415) 555-2671', '+1', '+14155552671'],
    ['+44 7700 900123', 'international', '+447700900123'],
  ] as const)('preserves the exact number from %s', (input, callingCode, expected) => {
    const entry = phoneEntry(input, '+86')
    expect(entry.callingCode).toBe(callingCode)
    expect(phoneE164(entry)).toBe(expected)
    expect(validPhoneEntry(entry)).toBe(true)
  })

  it.each(['+60', '+81'] as const)('requires explicit correction of a local trunk 0 for %s', (callingCode) => {
    const entry = phoneEntry('09012345678', callingCode)
    expect(hasLocalTrunkPrefix(entry)).toBe(true)
    expect(validPhoneEntry(entry)).toBe(false)
    expect(phoneE164(entry)).toBe(callingCode + '09012345678')
    const explicit = phoneEntry(callingCode + '09012345678', '+86')
    expect(phoneE164(explicit)).toBe(callingCode + '09012345678')
    expect(hasLocalTrunkPrefix(explicit)).toBe(false)
  })

  it.each(['+01234567', '+123456', '+1234567890123456', '+819012345678ext123', '+8190#12345678'])(
    'does not truncate or remove non-formatting data from invalid %s', (input) => {
      const entry = phoneEntry(input, '+86')
      expect(phoneE164(entry)).toBe(input)
      expect(validPhoneEntry(entry)).toBe(false)
    },
  )

  it('matches the generic gateway digit bounds for non-mainland international numbers', () => {
    expect(validPhoneEntry(phoneEntry('+1234567', '+86'))).toBe(true)
    expect(validPhoneEntry(phoneEntry('+123456789012345', '+86'))).toBe(true)
    expect(validPhoneEntry(phoneEntry('+861234567890', '+86'))).toBe(false)
  })

  it('selects overseas delivery-neutral copy without changing domestic or security messages', () => {
    expect(phoneMessageKey('codeSent', '+60123456789')).toBe('loginManualReady')
    expect(phoneMessageKey('loginDeliveryUnknown', '+819012345678')).toBe('loginManualUnconfirmed')
    expect(phoneMessageKey('codeSent', '+8613800138000')).toBe('codeSent')
    expect(phoneMessageKey('loginSecurityUnconfirmed', '+14155552671')).toBe('loginSecurityUnconfirmed')
  })
})

describe('phone sign-in code formats', () => {
  it.each(['+60123456789', '+819012345678', '+14155552671', '+447700900123'])(
    'accepts legacy six-digit and fixed sixteen-digit codes for %s', (phone) => {
      expect(validPhoneLoginCode('123456', phone)).toBe(true)
      expect(validPhoneLoginCode('0123456789012345', phone)).toBe(true)
      for (const code of ['12345', '1234567', '123456789012345', '01234567890123456', '012345678901234a', ' 123456']) {
        expect(validPhoneLoginCode(code, phone)).toBe(false)
      }
    },
  )

  it('retains the six-digit SMS format for mainland China', () => {
    expect(validPhoneLoginCode('123456', '+8613800138000')).toBe(true)
    expect(validPhoneLoginCode('0123456789012345', '+8613800138000')).toBe(false)
    expect(validPhoneLoginCode('12345a', '+8613800138000')).toBe(false)
  })

  it('distinguishes expired overseas requests from fixed-code and temporary-code validity', () => {
    expect(phoneMessageKey('loginCodeExpired', '+60123456789')).toBe('loginManualRequestExpired')
    expect(phoneMessageKey('loginCodeConsumed', '+819012345678')).toBe('loginManualRequestExpired')
    expect(phoneMessageKey('errCodeFormat', '+14155552671')).toBe('loginManualCodeFormat')
    expect(phoneMessageKey('loginCodeExpired', '+8613800138000')).toBe('loginCodeExpired')
  })
})
