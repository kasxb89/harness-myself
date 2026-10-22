/** Product-safe failure categories; diagnostic messages remain with their owner. */
export type ProductFailureKind = 'signed-out' | 'sign-in' | 'insufficient-credits' | 'cancelled' | 'busy'
  | 'network' | 'timeout' | 'invalid-input' | 'forbidden' | 'service' | 'upstream' | 'local' | 'unknown'

/**
 * Classify observed failure codes without attributing an unconfirmed cause or reading diagnostic text.
 * @param code - Stable failure identity from an existing response or Session event.
 * @returns A category whose copy is supplied by the receiving locale namespace.
 */
export function productFailureKind(code: unknown): ProductFailureKind {
  switch (code) {
    case 'ACCOUNT_SIGNED_OUT': return 'signed-out'
    case 'ACCOUNT_SIGN_IN_REQUIRED':
    case 'AUTH_REQUIRED':
    case 'SESSION_REQUIRED':
    case 'SESSION_EXPIRED':
    case 'SESSION_INVALID':
    case 'HTTP_401':
    case 'RELAY_MISSING': return 'sign-in'
    case 'ACCOUNT_QUOTA':
    case 'INSUFFICIENT_POINTS':
    case 'INSUFFICIENT_BALANCE': return 'insufficient-credits'
    case 'ABORTED':
    case 'CANCELLED':
    case 'USER_CANCELLED': return 'cancelled'
    case 'TRANSPORT':
    case 'NETWORK':
    case 'FETCH_FAILED':
    case 'ERR_NETWORK':
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return 'network'
    case 'TIMEOUT':
    case 'TRANSPORT_TIMEOUT':
    case 'HTTP_REQUEST_TIMEOUT':
    case 'HTTP_408':
    case 'HTTP_504':
    case 'IMAGE_SUBMIT_TIMEOUT':
    case 'IMAGE_QUERY_TIMEOUT':
    case 'VIDEO_SUBMIT_TIMEOUT':
    case 'VIDEO_QUERY_TIMEOUT': return 'timeout'
    case 'INVALID_ARGUMENT':
    case 'INVALID_REQUEST':
    case 'INVALID_DURATION':
    case 'INVALID_SHOT_DURATION':
    case 'SHOT_DURATION_MISMATCH':
    case 'SHOT_COUNT_MISMATCH':
    case 'DURATION_NOT_SUPPORTED':
    case 'SHOT_DURATION_UNSUPPORTED':
    case 'AUDIO_NOT_SUPPORTED':
    case 'RESOLUTION_NOT_SUPPORTED':
    case 'RATIO_NOT_SUPPORTED':
    case 'PARAMETER_NOT_SUPPORTED':
    case 'REFERENCES_NOT_SUPPORTED':
    case 'MIX_NOT_SUPPORTED':
    case 'MODE_NOT_SUPPORTED':
    case 'SEED_NOT_SUPPORTED':
    case 'VIDEO_EDIT_INVALID_INPUT':
    case 'IMAGE_INVALID':
    case 'IMAGE_TOO_LARGE':
    case 'IMAGE_DIMENSION_TOO_LARGE':
    case 'IMAGE_INPUT_TOO_LARGE':
    case 'IMAGE_FORMAT_UNSUPPORTED':
    case 'IMAGE_EMPTY':
    case 'IMAGE_DECODE_FAILED':
    case 'IMAGE_PIXEL_LIMIT':
    case 'IMAGE_OUTPUT_TOO_LARGE':
    case 'IMAGE_REFERENCE_INVALID':
    case 'REFERENCE_REQUEST_TOO_LARGE':
    case 'HTTP_400':
    case 'HTTP_413':
    case 'HTTP_415':
    case 'HTTP_422': return 'invalid-input'
    case 'HTTP_403':
    case 'PERMISSION_DENIED':
    case 'ACCESS_DENIED': return 'forbidden'
    case 'HTTP_429':
    case 'RATE_LIMITED':
    case 'SERVER_BUSY':
    case 'VIDEO_SUBMIT_BUSY': return 'busy'
    case 'TASK_FAILED':
    case 'PROVIDER_TASK_FAILED':
    case 'UPSTREAM_ERROR':
    case 'UPSTREAM_AUTH':
    case 'UPSTREAM_QUOTA': return 'upstream'
    case 'LOCAL_SAVE_FAILED':
    case 'PROJECT_STORAGE_FAILED':
    case 'ARTIFACT_PUBLISH_FAILED':
    case 'ARTIFACT_STORAGE_UNAVAILABLE':
    case 'VIDEO_RECEIPT_SAVE_FAILED':
    case 'IMAGE_RECEIPT_SAVE_FAILED':
    case 'IMAGE_RECEIPT_UNAVAILABLE':
    case 'VIDEO_EDIT_FAILED':
    case 'VIDEO_EDIT_RUNTIME_UNAVAILABLE':
    case 'VIDEO_EDIT_SANDBOX_DENIED': return 'local'
    default: return typeof code === 'string' && code.length === 8 && /^HTTP_5\d{2}$/u.test(code) ? 'service' : 'unknown'
  }
}
