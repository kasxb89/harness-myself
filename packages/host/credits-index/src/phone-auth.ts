/** Phone endpoint decoding and safe error reports owned by the Credits Host. */

/** JSON fields returned by phone authentication endpoints. */
export interface PhoneApiBody {
  readonly success?: unknown
  readonly code?: unknown
  readonly retry_after_seconds?: unknown
  readonly data?: Record<string, unknown>
}

/** Safe failure returned to the phone form, without provider diagnostics. */
export interface PhoneFailure {
  readonly ok: false
  readonly code: string
  readonly message: string
  readonly retryAfterSeconds: number | null
}

/**
 * Decode a phone response while retaining HTTP failures with empty or malformed bodies.
 * @param response - Upstream response, or null when transport failed.
 * @returns only the validated top-level JSON object fields.
 */
export async function readPhoneBody(response: Response | null): Promise<PhoneApiBody> {
  if (response === null) return {}
  let body: unknown
  try { body = JSON.parse(await response.text()) } catch { return {} }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {}
  const source = body as Record<string, unknown>
  const data = source.data
  return { success: source.success, code: source.code, retry_after_seconds: source.retry_after_seconds,
    ...data !== null && typeof data === 'object' && !Array.isArray(data) ? { data: data as Record<string, unknown> } : {} }
}

/**
 * Read the upstream retry delay, rounding upward so the next request is never early.
 * @param response - Upstream response with an optional Retry-After header.
 * @param body - Decoded response fields.
 * @param now - Current Unix time in milliseconds.
 * @returns nonnegative whole seconds, or null when no valid delay was supplied.
 */
export function phoneRetryAfter(response: Response | null, body: PhoneApiBody, now = Date.now()): number | null {
  const delays: number[] = []
  if (typeof body.retry_after_seconds === 'number' && Number.isFinite(body.retry_after_seconds) && body.retry_after_seconds >= 0) {
    delays.push(Math.ceil(body.retry_after_seconds))
  }
  const header = response?.headers.get('retry-after')?.trim()
  if (header !== undefined && header !== '') {
    const seconds = /^\d+$/u.test(header) ? Number(header) : (Date.parse(header) - now) / 1000
    if (Number.isFinite(seconds)) delays.push(Math.max(0, Math.ceil(seconds)))
  }
  return delays.length === 0 ? null : Math.max(...delays)
}

/**
 * Classify a failed phone operation without exposing upstream messages.
 * @param response - Upstream response, or null after a transport failure.
 * @param body - Decoded response fields.
 * @param operation - Phone operation that failed.
 * @returns a stable failure and the upstream cooldown when present.
 */
export function phoneFailure(response: Response | null, body: PhoneApiBody, operation: 'challenge' | 'login'): PhoneFailure {
  const retryAfterSeconds = phoneRetryAfter(response, body)
  if (response?.status === 429) return { ok: false, code: 'PHONE_RATE_LIMITED',
    message: '操作过于频繁，请等待倒计时结束后重试。', retryAfterSeconds: retryAfterSeconds ?? 60 }
  const code = typeof body.code === 'string' ? body.code : null
  const messages: Record<string, string> = {
    PHONE_LOGIN_DISABLED: '手机号登录暂未开放，请稍后再试。',
    PHONE_INVALID_PARAMETERS: '登录信息不完整，请检查手机号和验证码。',
    PHONE_RATE_LIMITED: '操作过于频繁，请等待倒计时结束后重试。',
    PHONE_CHALLENGE_UNAVAILABLE: body.data?.delivery_status === 'not_sent'
      ? '短信服务暂不可用，本次未发送。请稍后手动重新获取验证码。'
      : '短信发送结果尚未确认；若已收到短信可直接输入验证码，否则请查询本次发送结果。',
    PHONE_DELIVERY_UNKNOWN: '短信发送结果尚未确认；若已收到短信可直接输入验证码，否则请查询本次发送结果。',
    PHONE_CHALLENGE_PENDING: '短信请求仍在处理中，请稍后查询本次发送结果。',
    PHONE_CODE_INVALID_OR_EXPIRED: '验证码不正确或已过期，请检查短信或重新获取验证码。',
    PHONE_LOGIN_UNAVAILABLE: '登录服务暂不可用，请保留验证码并稍后重试本次登录。',
    PHONE_CHALLENGE_CONSUMED: '此登录已失效，请重新获取验证码。',
    PHONE_IDEMPOTENCY_CONFLICT: '本次请求与原内容不同，请使用原内容重试或修改验证码后重新登录。',
    PHONE_LOGIN_VERIFICATION_REQUIRED: '账户需要安全验证，请输入验证器验证码或备用码。',
  }
  const message = code === null ? undefined : messages[code]
  if (code !== null && message !== undefined) return { ok: false, code, message,
    retryAfterSeconds: code === 'PHONE_RATE_LIMITED' ? retryAfterSeconds ?? 60 : retryAfterSeconds }
  return { ok: false, code: operation === 'challenge' ? 'PHONE_DELIVERY_UNKNOWN' : 'PHONE_LOGIN_UNAVAILABLE',
    message: operation === 'challenge' ? '短信服务暂不可用或发送结果未确认，请稍后重试本次请求。'
      : '登录服务暂不可用或结果未确认，请保留验证码并稍后重试本次登录。', retryAfterSeconds }
}
