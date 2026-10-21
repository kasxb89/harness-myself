/** Localized failure selection for the phone form; server diagnostics stay private. */

/**
 * Select the form message from a stable failure code.
 * @param code - Host failure discriminator.
 * @param operation - Form operation that failed.
 * @param deliveryStatus - Delivery evidence supplied by the Host, when available.
 * @returns the locale key describing the safe next action.
 */
export function phoneFailureKey(code: string | null | undefined, operation: 'send' | 'verify',
  deliveryStatus?: PhoneRecovery['deliveryStatus']): string {
  switch (code) {
    case 'SMS_CODE_MISMATCH': return 'loginCodeInvalid'
    case 'SMS_CHALLENGE_EXPIRED': return 'loginCodeExpired'
    case 'SMS_CHALLENGE_CONSUMED': return 'loginCodeConsumed'
    case 'PHONE_CODE_INVALID_OR_EXPIRED': return 'loginCodeInvalidOrExpired'
    case 'PHONE_CHALLENGE_CONSUMED': return 'loginCodeConsumed'
    case 'PHONE_LOGIN_DISABLED': return 'loginDisabled'
    case 'PHONE_INVALID_PARAMETERS': return 'loginParametersInvalid'
    case 'PHONE_CHALLENGE_UNAVAILABLE': return deliveryStatus === 'not_sent' ? 'loginNotSent' : 'loginDeliveryUnknown'
    case 'PHONE_DELIVERY_UNKNOWN': return 'loginDeliveryUnknown'
    case 'PHONE_CHALLENGE_PENDING': return 'loginDeliveryPending'
    case 'PHONE_IDEMPOTENCY_CONFLICT': return 'loginRequestConflict'
    case 'PHONE_LOGIN_VERIFICATION_REQUIRED': return 'loginVerificationRequired'
    case 'PHONE_SECURITY_REJECTED': return 'loginSecurityRejected'
    case 'PHONE_SECURITY_EXPIRED': return 'loginSecurityExpired'
    case 'PHONE_SECURITY_UNCONFIRMED': return 'loginSecurityUnconfirmed'
    case 'PHONE_SECURITY_UNSUPPORTED': return 'loginSecurityUnsupported'
    case 'PHONE_RECOVERY_UNAVAILABLE': return 'loginRecoveryUnavailable'
    case 'PHONE_RATE_LIMITED':
    case '429': return 'loginRateLimited'
    case 'ACCOUNT_CHANGED': return 'loginAccountChanged'
    default: return operation === 'send' ? 'loginSendFailed' : 'loginVerifyFailed'
  }
}

/** Durable non-secret phone request identity returned with the signed-out session. */
export interface PhoneRecovery {
  readonly phone: string
  readonly challengeKey: string | null
  readonly challengeId: string | null
  readonly deliveryStatus: 'accepted' | 'unknown' | 'sending' | 'not_sent'
  readonly expiresAt: string | null
  readonly resendAt: number
  readonly exchangeKey: string | null
  readonly verifyRetryAt: number
  readonly securityUnconfirmed: boolean
}
