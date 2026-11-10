/** Explicit dialing codes and digit-preserving phone entry for the existing sign-in flow. */
import { phoneCountries } from './phone-countries.ts'

/** Country calling codes plus a complete-number option for unlisted prefixes. */
export const phoneCallingCodes = [...phoneCountries.map(country => country.callingCode), 'international'] as const
export type PhoneCallingCode = typeof phoneCallingCodes[number]

const longestCallingCodes = [...phoneCountries].sort((left, right) => right.callingCode.length - left.callingCode.length)

/** The display split never changes digits from a pasted international number. */
export interface PhoneEntry {
  readonly callingCode: PhoneCallingCode
  readonly number: string
  readonly explicitInternational: boolean
}

/**
 * Split an explicit international number, or attach the user-selected calling code.
 * @param input - Typed or pasted number; only visual separators are removed.
 * @param callingCode - Explicit current selection, never inferred from national digits.
 * @returns Editable digits and an exact international-prefix marker.
 */
export function phoneEntry(input: string, callingCode: PhoneCallingCode): PhoneEntry {
  const compact = input.trim().replace(/[\s()-]/gu, '')
  if (compact.startsWith('+')) {
    const selected = longestCallingCodes.find(country => compact.startsWith(country.callingCode))?.callingCode ?? 'international'
    return { callingCode: selected, number: selected === 'international' ? compact : compact.slice(selected.length),
      explicitInternational: true }
  }
  // Preserve the existing unambiguous mainland-China paste without a plus sign.
  const number = callingCode === '+86' && /^861[3-9]\d{9}$/u.test(compact) ? compact.slice(2) : compact
  return { callingCode, number, explicitInternational: false }
}

/** @param entry - Current editor state. @returns Exact digits with the explicit international prefix. */
export function phoneE164(entry: PhoneEntry): string {
  return entry.callingCode === 'international'
    ? entry.number.startsWith('+') ? entry.number : '+' + entry.number
    : entry.callingCode + entry.number
}

/** @param entry - Current editor state. @returns Whether a local trunk prefix needs the user's correction. */
export function hasLocalTrunkPrefix(entry: PhoneEntry): boolean {
  return !entry.explicitInternational && phoneCountries.some(country => country.callingCode === entry.callingCode
    && country.hasLocalTrunkZero)
    && entry.number.startsWith('0')
}

/**
 * Match the gateway E.164 grammar, retaining the existing mainland mobile-number check.
 * @param entry - Explicit calling code and number, without guessing or dropping trunk digits.
 * @returns Whether the form can submit this exact number.
 */
export function validPhoneEntry(entry: PhoneEntry): boolean {
  const phone = phoneE164(entry)
  return !hasLocalTrunkPrefix(entry) && (phone.startsWith('+86') ? /^\+861[3-9]\d{9}$/u.test(phone)
    : /^\+[1-9]\d{6,14}$/u.test(phone))
}

/**
 * @param code - Complete entered code; invalid lengths and characters are not rewritten.
 * @param phone - Exact number deciding whether the mainland SMS-only format applies.
 * @returns Whether the existing SMS code or overseas fixed/temporary code can be submitted.
 */
export function validPhoneLoginCode(code: string, phone: string): boolean {
  return phone.startsWith('+86') ? /^\d{6}$/u.test(code) : /^(?:\d{6}|\d{16})$/u.test(code)
}

const manualMessages: Readonly<Record<string, string>> = {
  codeSent: 'loginManualReady', loginSubtitle: 'loginManualSubtitle', loginCodeHint: 'loginManualCodeHint',
  loginSending: 'loginManualPreparing', sendCode: 'loginManualPrepare', loginCheckDelivery: 'loginManualCheck',
  resendIn: 'loginRetryIn', loginHint: 'loginManualHint', loginSendFailed: 'loginManualUnconfirmed',
  loginDeliveryUnknown: 'loginManualUnconfirmed', loginDeliveryPending: 'loginManualPending', loginNotSent: 'loginManualUnavailable',
  loginCodeInvalid: 'loginManualCodeInvalid', loginCodeInvalidOrExpired: 'loginManualCodeInvalidOrExpired',
  loginExpiredExchangeRecovery: 'loginManualExpiredExchangeRecovery', errNeedCode: 'loginManualNeedRequest',
  loginCodeExpired: 'loginManualRequestExpired', loginCodeConsumed: 'loginManualRequestExpired',
  errCodeFormat: 'loginManualCodeFormat', codePlaceholder: 'loginManualCodePlaceholder',
}

/**
 * @param key - Existing phone-flow locale key.
 * @param phone - Exact edited or recovered number.
 * @returns Delivery-neutral overseas copy.
 */
export function phoneMessageKey(key: string, phone: string): string {
  return phone.startsWith('+86') ? key : manualMessages[key] ?? key
}
