/** Exact gateway rejection identity; upstream quota and token limits are not user balance. */

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Recognize the configured new-api gateway's own user-funding rejection.
 * @param value - Decoded error response from the account-owned API request.
 * @param status - Actual HTTP status, never a body-provided status.
 * @returns Whether the user can resolve this rejection by recharging their product account.
 */
export function isAccountBalanceRejection(value: unknown, status: number): boolean {
  if (status !== 403) return false
  const body = record(value)
  const error = record(body?.error)
  // Native task replies carry the gateway code at the root; Images and Chat
  // use an OpenAI envelope. Never infer ownership from a vendor message or 403.
  return error === undefined ? body?.code === 'insufficient_user_quota'
    : error.code === 'insufficient_user_quota'
      && (error.type === 'new_api_error' || error.type === 'invalid_request_error')
}

/**
 * Decode an already-read gateway error without inferring balance from its text.
 * @param text - Already-read JSON error body.
 * @param status - Actual HTTP status.
 * @returns Whether the response confirms the user's funding rejection.
 */
export function isAccountBalanceRejectionText(text: string, status: number): boolean {
  try { return isAccountBalanceRejection(JSON.parse(text), status) } catch (_invalidJson: unknown) { return false }
}
