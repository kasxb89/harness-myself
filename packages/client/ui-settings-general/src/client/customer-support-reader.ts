/** Read-only customer support settings from the connected Host. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'

/** Public display fields validated independently of the Host response. */
export interface CustomerSupportDetails {
  readonly enabled: boolean
  readonly qrCodeUrl: string
  readonly title: string
  readonly description: string
}

/** Safe states for the customer support dialog, without upstream diagnostics. */
export type CustomerSupportRead = { readonly ok: true; readonly payload: CustomerSupportDetails }
  | { readonly ok: false; readonly reason: 'unsupported' | 'network' | 'timeout' | 'unavailable' | 'invalid' | 'authorization' | 'account-changed' }

/** Accept HTTPS images, plus exact local API image assets on loopback-only development deployments. */
function safeImageUrl(value: string): boolean {
  if (/[\s\u0000-\u0008\u000e-\u001f\u007f\\]/u.test(value)) return false
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.search === '' && url.hash === '' && !/%(?:2f|5c|2e)/iu.test(value) && !/\/\.{1,2}(?:\/|$)/u.test(value)
      && /^(?:\/[^/]+)*\/api\/creation\/assets\/cc_[0-9a-f]{64}$/u.test(url.pathname)
  } catch (_invalidUrl: unknown) { return false }
}

/** DOM errors can cross realms and need not inherit the page's Error constructor. */
function timedOut(error: unknown, deadline: AbortSignal): boolean {
  return deadline.aborted || (error !== null && typeof error === 'object' && 'name' in error && error.name === 'TimeoutError')
}

/**
 * Read current support settings only for an open dialog, with a bounded request lifetime.
 * @param signal - Dialog closure or explicit replacement request cancellation.
 * @returns Validated display fields or a safe, localized failure category.
 */
export async function readCustomerSupport(signal: AbortSignal): Promise<CustomerSupportRead> {
  const deadline = AbortSignal.timeout(15_000)
  const requestSignal = AbortSignal.any([signal, deadline])
  let response: Response
  try {
    response = await fetch(appPath('/credits/api/customer-support'), {
      headers: { accept: 'application/json' }, signal: requestSignal, cache: 'no-store',
    })
  } catch (error: unknown) {
    return { ok: false, reason: timedOut(error, deadline) ? 'timeout' : 'network' }
  }
  if (response.status === 404) return { ok: false, reason: 'unsupported' }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'authorization' }
  if (response.status === 408 || response.status === 504) return { ok: false, reason: 'timeout' }
  if (!response.ok) return { ok: false, reason: 'unavailable' }
  let value: unknown
  try { value = await response.json() } catch (error: unknown) {
    return { ok: false, reason: timedOut(error, deadline) ? 'timeout'
      : error instanceof SyntaxError ? 'invalid' : 'network' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid' }
  const body = value as Record<string, unknown>
  if (body.ok === false) {
    const reasons = {
      CUSTOMER_SUPPORT_UNSUPPORTED: 'unsupported', CUSTOMER_SUPPORT_NETWORK: 'network', CUSTOMER_SUPPORT_TIMEOUT: 'timeout',
      CUSTOMER_SUPPORT_UNAVAILABLE: 'unavailable', CUSTOMER_SUPPORT_INVALID: 'invalid', ACCOUNT_CHANGED: 'account-changed',
    } as const
    const code = typeof body.code === 'string' ? body.code : ''
    return { ok: false, reason: Object.hasOwn(reasons, code) ? reasons[code as keyof typeof reasons] : 'unavailable' }
  }
  const payload = body.payload
  if (body.ok !== true || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'invalid' }
  const fields = payload as Record<string, unknown>
  if (typeof fields.enabled !== 'boolean' || typeof fields.qrCodeUrl !== 'string'
    || typeof fields.title !== 'string' || fields.title.length > 64
    || typeof fields.description !== 'string' || fields.description.length > 256
    || (fields.enabled ? !safeImageUrl(fields.qrCodeUrl) : fields.qrCodeUrl !== '')) return { ok: false, reason: 'invalid' }
  return { ok: true, payload: {
    enabled: fields.enabled, qrCodeUrl: fields.qrCodeUrl, title: fields.title, description: fields.description,
  } }
}
