/** Media requests retain structured failures and never retry generation mutations. */

/** The existing local media routes return an envelope for business failures. */
export interface Envelope<T> {
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
  try {
    const response = await fetch(path, init)
    if (!response.ok) return { ok: false, code: 'HTTP', message: String(response.status) }
    const value: unknown = await response.json()
    if (value === null || typeof value !== 'object' || !('ok' in value) || typeof value.ok !== 'boolean') {
      return { ok: false, code: 'RESPONSE_INVALID' }
    }
    return value as Envelope<T>
  } catch (error) {
    return { ok: false, code: 'TRANSPORT', message: error instanceof Error ? error.message : String(error) }
  }
}
