/** Deployment-owned customer support presentation, independent of product login and login QR codes. */
import { apiUrl } from './api-url.ts'
import { readPublicStatus, type PublicStatusFailure } from './public-status.ts'

/** The complete, public customer-support presentation retained by the Host. */
export interface CustomerSupport {
  readonly enabled: boolean
  readonly qrCodeUrl: string
  readonly title: string
  readonly description: string
}

/** Safe customer-support data or a stable, observed read failure. */
export type CustomerSupportResponse = { readonly ok: true; readonly payload: CustomerSupport } | {
  readonly ok: false
  readonly code: 'CUSTOMER_SUPPORT_UNSUPPORTED' | 'CUSTOMER_SUPPORT_NETWORK' | 'CUSTOMER_SUPPORT_TIMEOUT'
    | 'CUSTOMER_SUPPORT_UNAVAILABLE' | 'CUSTOMER_SUPPORT_INVALID'
}

const empty: CustomerSupportResponse = { ok: true, payload: { enabled: false, qrCodeUrl: '', title: '', description: '' } }
const failureCodes: Record<PublicStatusFailure, Exclude<CustomerSupportResponse, { ok: true }>['code']> = {
  unsupported: 'CUSTOMER_SUPPORT_UNSUPPORTED', network: 'CUSTOMER_SUPPORT_NETWORK', timeout: 'CUSTOMER_SUPPORT_TIMEOUT',
  unavailable: 'CUSTOMER_SUPPORT_UNAVAILABLE', invalid: 'CUSTOMER_SUPPORT_INVALID',
}

function record(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
}

function displayUrl(raw: string, baseUrl: string): string | undefined {
  if (Buffer.byteLength(raw, 'utf8') > 2048 || raw !== raw.trim() || /[\\\p{Cc}\u0020]/u.test(raw)) return undefined
  if (/^\/api\/creation\/assets\/cc_[a-f\d]{64}$/u.test(raw)) return apiUrl(baseUrl, raw)
  if (!/^https:\/\//iu.test(raw)) return undefined
  const authority = raw.slice(raw.indexOf('://') + 3).split('/')[0] ?? ''
  if (authority.includes('@')) return undefined
  try {
    if (/[\\\p{Cc}]/u.test(decodeURIComponent(raw))) return undefined
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return undefined
    if (/\.svg(?:\/|$)/iu.test(decodeURIComponent(url.pathname))) return undefined
    return url.href
  } catch (_invalidUrl: unknown) { return undefined }
}

/**
 * Select the dedicated customer-service status fields without reusing login QR settings.
 * @param value - Decoded API status JSON.
 * @param baseUrl - Validated deployment root used for dedicated creation-asset paths.
 * @returns Bounded plain text and a display URL, an unconfigured state, or a safe validation failure.
 */
export function parseCustomerSupport(value: unknown, baseUrl: string): CustomerSupportResponse {
  const body = record(value)
  const data = record(body?.data)
  if (body?.success !== true || data === null) return { ok: false, code: 'CUSTOMER_SUPPORT_INVALID' }
  if (!Object.hasOwn(data, 'customer_service')) return { ok: false, code: 'CUSTOMER_SUPPORT_UNSUPPORTED' }
  const support = record(data.customer_service)
  if (support?.schema_version !== 1 || typeof support.enabled !== 'boolean') return { ok: false, code: 'CUSTOMER_SUPPORT_INVALID' }
  if (!support.enabled) return empty
  if (typeof support.qr_code_url !== 'string' || typeof support.title !== 'string' || support.title.length > 64
    || typeof support.description !== 'string' || support.description.length > 256
    || /\p{Cc}/u.test(support.title) || /\p{Cc}/u.test(support.description)) return { ok: false, code: 'CUSTOMER_SUPPORT_INVALID' }
  if (support.qr_code_url === '') return empty
  const qrCodeUrl = displayUrl(support.qr_code_url, baseUrl)
  if (qrCodeUrl === undefined) return { ok: false, code: 'CUSTOMER_SUPPORT_INVALID' }
  return { ok: true, payload: { enabled: true, qrCodeUrl, title: support.title, description: support.description } }
}

/**
 * Read current customer support settings without account credentials or a retained QR cache.
 * @param fetchStatus - Deployment-bound, credential-free public status request.
 * @param signal - Request, plugin and configured deadline lifetime.
 * @param baseUrl - Complete deployment root, preserving reverse-proxy prefixes.
 * @returns Only current safe display fields or an observed failure category.
 */
export async function readCustomerSupport(
  fetchStatus: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal, baseUrl: string,
): Promise<CustomerSupportResponse> {
  const result = await readPublicStatus(fetchStatus, signal)
  return result.ok ? parseCustomerSupport(result.value, baseUrl) : { ok: false, code: failureCodes[result.reason] }
}
