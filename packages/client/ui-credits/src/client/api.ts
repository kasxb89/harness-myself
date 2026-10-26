/** Wire helpers shared by the Credits pages: the route envelopes and formatting. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** The envelope every credits route answers with. */
export interface Envelope<T> {
  readonly ok: boolean
  readonly code?: string | null
  readonly message?: string | null
  readonly retryAfterSeconds?: number | null
  readonly sessionInvalid?: boolean
  readonly payload?: T
  /** Successful account reads may name their owner; older Hosts omit this field. */
  readonly account?: { readonly id: string } | null
  readonly status?: number
  readonly httpStatus?: number
  readonly failure?: { readonly code?: string; readonly httpStatus?: number; readonly retryAfterSeconds?: number }
}

/**
 * POST one Credits route and decode its JSON envelope.
 * @param path - route URL to request.
 * @param body - fields serialized as the JSON request body.
 * @param signal - optional cancellation of this HTTP request.
 * @returns the decoded response envelope.
 * @throws When the request is cancelled or fetching or JSON decoding fails.
 */
export async function post<T>(
  path: string, body: Record<string, unknown>, signal?: AbortSignal,
): Promise<Envelope<T>> {
  const response = await fetch(appPath(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  return await response.json() as Envelope<T>
}

/**
 * GET one Credits route and decode its JSON envelope.
 * @param path - route URL to request.
 * @param signal - optional cancellation of this HTTP request.
 * @returns the decoded response envelope.
 * @throws When the request is cancelled or fetching or JSON decoding fails.
 */
export async function get<T>(path: string, signal?: AbortSignal): Promise<Envelope<T>> {
  const response = await fetch(appPath(path), {
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  let answer: Envelope<T>
  try {
    const value: unknown = await response.json()
    answer = value !== null && typeof value === 'object' && 'ok' in value && typeof value.ok === 'boolean'
      ? value as Envelope<T> : { ok: false, code: 'INVALID_RESPONSE' }
  }
  catch (error) {
    if (response.ok) throw error
    answer = { ok: false }
  }
  const retryHeader = response.headers.get('retry-after')
  const date = Date.parse(response.headers.get('date') ?? '')
  const retryDate = retryHeader === null ? Number.NaN : Date.parse(retryHeader)
  const retryAfterSeconds = retryHeader === null ? undefined : /^\d+$/u.test(retryHeader) ? Number(retryHeader)
    : Number.isFinite(retryDate) ? Math.max(0, Math.ceil((retryDate - (Number.isFinite(date) ? date : Date.now())) / 1000)) : undefined
  return { ...answer, ok: response.ok && answer.ok, httpStatus: answer.httpStatus ?? response.status,
    ...answer.retryAfterSeconds !== undefined || retryAfterSeconds === undefined ? {} : { retryAfterSeconds } }
}

/**
 * Create a fresh idempotency key using printable ASCII without spaces.
 * @param prefix - operation label placed before the generated UUID.
 * @returns the operation-prefixed UUID restricted to printable ASCII without spaces.
 */
export function newKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`.replace(/[^\x21-\x7e]/g, '')
}

/**
 * Format an amount with Chinese digit grouping and at most two decimal places.
 * @param value - amount to format.
 * @returns the localized number string.
 */
export function grouped(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

/**
 * Calculate the remaining whole seconds until an ISO timestamp.
 * @param iso - target timestamp accepted by Date.parse.
 * @returns nonnegative seconds, or zero for an invalid or elapsed timestamp.
 */
export function secondsUntil(iso: string): number {
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return 0
  return Math.max(0, Math.floor((target - Date.now()) / 1000))
}

/**
 * Create a phone request identity containing 256 random bits before dispatch.
 * @param prefix - Label for the SMS or session operation.
 * @returns a printable identifier safe for durable retries.
 */
export function newPhoneKey(prefix: string): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  return `${prefix}-${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`
}
