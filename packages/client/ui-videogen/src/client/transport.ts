/** Media requests retain structured failures and never retry generation mutations. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'


/** The existing local media routes return an envelope for business failures. */
export interface Envelope<T> {
  readonly plan_id?: string | null
  readonly operation_id?: string | null
  readonly task_id?: string | null
  readonly request_id?: string | null
  readonly ok: boolean
  readonly code?: string | null
  readonly message?: string | null
  readonly sessionInvalid?: boolean
  readonly submission_state?: 'not-submitted' | 'pending' | 'unknown' | 'failed' | 'completed' | null
  readonly payload?: T
}

/**
 * Read one JSON response, containing network, HTTP and invalid-JSON failures.
 * @param path - existing local route.
 * @param init - request options; mutation requests execute once.
 * @returns an envelope without transport exceptions escaping into UI state.
 */
export async function requestJson<T>(path: string, init?: RequestInit): Promise<Envelope<T>> {
  let response: Response
  try {
    response = await fetch(appPath(path), init)
  } catch (error) {
    const code = init?.signal?.aborted === true ? 'CANCELLED'
      : error instanceof DOMException && error.name === 'TimeoutError' ? 'TIMEOUT'
        : error instanceof TypeError ? 'TRANSPORT' : 'UNKNOWN'
    return { ok: false, code, message: error instanceof Error ? error.message : String(error) }
  }
  if (!response.ok) return { ok: false, code: `HTTP_${String(response.status)}` }
  try {
    const value: unknown = await response.json()
    if (value === null || typeof value !== 'object' || !('ok' in value) || typeof value.ok !== 'boolean') {
      return { ok: false, code: 'RESPONSE_INVALID' }
    }
    return value as Envelope<T>
  } catch (_error) {
    return { ok: false, code: 'RESPONSE_INVALID' }
  }
}
