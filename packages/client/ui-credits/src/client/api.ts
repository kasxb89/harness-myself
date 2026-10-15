/** Wire helpers shared by the Credits pages: the route envelopes and formatting. */

/** The envelope every credits route answers with. */
export interface Envelope<T> {
  readonly ok: boolean
  readonly code?: string | null
  readonly message?: string | null
  readonly retryAfterSeconds?: number | null
  readonly sessionInvalid?: boolean
  readonly payload?: T
  readonly status?: number
}

/** POST one credits route and unwrap its envelope. */
export async function post<T>(path: string, body: Record<string, unknown>): Promise<Envelope<T>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  return await response.json() as Envelope<T>
}

/** GET one credits route and unwrap its envelope. */
export async function get<T>(path: string): Promise<Envelope<T>> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  return await response.json() as Envelope<T>
}

/** A fresh idempotency key; printable ASCII without spaces. */
export function newKey(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${String(Date.now())}-${String(Math.random()).slice(2)}`
  return `${prefix}-${random}`.replace(/[^\x21-\x7e]/g, '')
}

/** Format an integer with grouping. */
export function grouped(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

/** Remaining seconds until an ISO timestamp, floored at zero. */
export function secondsUntil(iso: string): number {
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return 0
  return Math.max(0, Math.floor((target - Date.now()) / 1000))
}
