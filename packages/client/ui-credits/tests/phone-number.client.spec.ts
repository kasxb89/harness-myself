import { describe, expect, it } from 'vitest'
import { hasLocalTrunkPrefix, phoneE164, phoneEntry, phoneMessageKey, validPhoneEntry,
  validPhoneLoginCode, phoneCallingCodes } from '../src/client/phone-number.ts'
import { phoneCountries } from '../src/client/phone-countries.ts'
import { en, zh } from '../src/client/locales.ts'

describe('published calling-code catalog', () => {
  it('covers the pinned 245-region data without duplicate calling-code choices or region assignments', () => {
    expect(phoneCountries).toHaveLength(206)
    expect(new Set(phoneCountries.map(country => country.callingCode)).size).toBe(206)
    const regions = phoneCountries.flatMap(country => country.regions)
    expect(regions).toHaveLength(245)
    expect(new Set(regions).size).toBe(245)
    expect(phoneCallingCodes).toHaveLength(207)
    expect(new Set(phoneCallingCodes).size).toBe(207)
    expect(phoneCallingCodes.filter(code => code === 'international')).toEqual(['international'])
    expect(new Set(phoneCallingCodes.filter(code => code !== 'international')))
      .toEqual(new Set(phoneCountries.map(country => country.callingCode)))
  })

  it('supplies Chinese and English labels for every country group', () => {
    for (const country of phoneCountries) {
      expect(zh[country.labelKey]).toContain(country.callingCode)
      expect(en[country.labelKey]).toContain(country.callingCode)
      expect(zh[country.labelKey].length).toBeGreaterThan(country.callingCode.length)
      expect(en[country.labelKey].length).toBeGreaterThan(country.callingCode.length)
    }
  })

  it('describes the list as entry assistance while retaining the backend authorization requirement', () => {
    for (const key of ['loginInternationalPhoneHint', 'loginTrunkZeroPhoneHint'] as const) {
      expect(zh[key]).toContain('登录仍需后台授权')
      expect(en[key].toLowerCase()).toContain('sign-in still requires administrator authorization')
    }
  })

  it.each([
    { code: '+1', regions: ['US', 'CA', 'BS'] }, { code: '+7', regions: ['RU', 'KZ'] },
    { code: '+44', regions: ['GB', 'GG', 'IM', 'JE'] }, { code: '+61', regions: ['AU', 'CC', 'CX'] },
    { code: '+39', regions: ['IT', 'VA'] },
  ])('groups shared $code without promoting a national destination prefix to a country code', ({ code, regions }) => {
    const group = phoneCountries.filter(country => country.callingCode === code)
    expect(group).toHaveLength(1)
    expect(group[0]?.regions).toEqual(expect.arrayContaining(regions))
    expect(phoneCallingCodes.filter(value => value === code)).toHaveLength(1)
  })
})

describe('explicit international phone entry', () => {
  it.each([
    ['13800138000', '+86', '+8613800138000'], ['8613800138000', '+86', '+8613800138000'],
    ['+86 138 0013 8000', '+86', '+8613800138000'], ['+60 12-345 6789', '+60', '+60123456789'],
    ['+81 90 1234 5678', '+81', '+819012345678'], ['+1 (415) 555-2671', '+1', '+14155552671'],
    ['+44 7700 900123', '+44', '+447700900123'], ['+82 10-1234-5678', '+82', '+821012345678'],
    ['+358 40 123 4567', '+358', '+358401234567'], ['+971 50 123 4567', '+971', '+971501234567'],
    ['+234 803 123 4567', '+234', '+2348031234567'], ['+55 (11) 91234-5678', '+55', '+5511912345678'],
    ['+91 98765 43210', '+91', '+919876543210'], ['+64 21 123 4567', '+64', '+64211234567'],
    ['+1 242 555 0123', '+1', '+12425550123'], ['+7 701 123 4567', '+7', '+77011234567'],
  ] as const)('preserves the exact number from %s', (input, callingCode, expected) => {
    const entry = phoneEntry(input, '+86')
    expect(entry.callingCode).toBe(callingCode)
    expect(entry.explicitInternational).toBe(input.trim().startsWith('+'))
    expect(phoneE164(entry)).toBe(expected)
    expect(validPhoneEntry(entry)).toBe(true)
  })

  it.each(['+60', '+81', '+44', '+82', '+61'] as const)('requires explicit correction of a local trunk 0 for %s', (callingCode) => {
    const entry = phoneEntry('09012345678', callingCode)
    expect(hasLocalTrunkPrefix(entry)).toBe(true)
    expect(validPhoneEntry(entry)).toBe(false)
    expect(phoneE164(entry)).toBe(callingCode + '09012345678')
    const explicit = phoneEntry(callingCode + '09012345678', '+86')
    expect(phoneE164(explicit)).toBe(callingCode + '09012345678')
    expect(hasLocalTrunkPrefix(explicit)).toBe(false)
  })

  it.each([
    ['+39', '0669823456'], ['+378', '0549881234'],
  ] as const)('preserves a significant local leading zero for %s', (callingCode, number) => {
    const local = phoneEntry(number, callingCode)
    expect(local).toEqual({ callingCode, number, explicitInternational: false })
    expect(phoneE164(local)).toBe(callingCode + number)
    expect(hasLocalTrunkPrefix(local)).toBe(false)
    expect(validPhoneEntry(local)).toBe(true)
    const explicit = phoneEntry(callingCode + number, '+86')
    expect(explicit).toEqual({ callingCode, number, explicitInternational: true })
    expect(phoneE164(explicit)).toBe(callingCode + number)
    expect(hasLocalTrunkPrefix(explicit)).toBe(false)
  })

  it.each([
    ['+7', '88005553535'], ['+375', '80171234567'], ['+1', '14155552671'],
  ] as const)('does not guess or delete complex national prefixes from %s local entry', (callingCode, number) => {
    const entry = phoneEntry(number, callingCode)
    expect(entry.number).toBe(number)
    expect(hasLocalTrunkPrefix(entry)).toBe(false)
    expect(phoneE164(entry)).toBe(callingCode + number)
  })

  it('keeps an unknown complete international number in the explicit international entry', () => {
    const entry = phoneEntry(' +999 (123) 456-789 ', '+81')
    expect(entry).toEqual({ callingCode: 'international', number: '+999123456789', explicitInternational: true })
    expect(phoneE164(entry)).toBe('+999123456789')
    expect(hasLocalTrunkPrefix(entry)).toBe(false)
    expect(validPhoneEntry(entry)).toBe(true)
    expect(phoneE164(phoneEntry('999123456789', 'international'))).toBe('+999123456789')
  })

  it('restores the exact international identity instead of guessing a region within a shared calling code', () => {
    for (const phone of ['+12425550123', '+77011234567', '+390669823456', '+447700900123']) {
      const entry = phoneEntry(phone, '+86')
      expect(phoneE164(entry)).toBe(phone)
      expect(phoneE164(phoneEntry(phoneE164(entry), '+81'))).toBe(phone)
    }
  })

  it.each(['+01234567', '+123456', '+1234567890123456', '+819012345678ext123', '+8190#12345678',
    '+391234567x', '+44/7700900123', '+９９９1234567'])(
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
  it.each(['+60123456789', '+819012345678', '+14155552671', '+447700900123', '+390669823456', '+821012345678', '+999123456789'])(
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
