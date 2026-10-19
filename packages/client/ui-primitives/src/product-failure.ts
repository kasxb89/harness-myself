/** Product-safe failure categories; diagnostic messages remain with their owner. */
export type ProductFailureKind = 'signed-out' | 'sign-in' | 'insufficient-credits' | 'cancelled' | 'busy'

/**
 * Classify stable product codes without reading upstream text or changing diagnostics.
 * @param code - Stable failure identity from an existing response or Session event.
 * @returns A category whose copy is supplied by the receiving locale namespace.
 */
export function productFailureKind(code: unknown): ProductFailureKind {
  switch (code) {
    case 'ACCOUNT_SIGNED_OUT': return 'signed-out'
    case 'ACCOUNT_SIGN_IN_REQUIRED':
    case 'SESSION_REQUIRED':
    case 'SESSION_EXPIRED':
    case 'RELAY_MISSING': return 'sign-in'
    case 'ACCOUNT_QUOTA':
    case 'INSUFFICIENT_POINTS':
    case 'INSUFFICIENT_BALANCE': return 'insufficient-credits'
    case 'ABORTED':
    case 'CANCELLED':
    case 'USER_CANCELLED': return 'cancelled'
    default: return 'busy'
  }
}
