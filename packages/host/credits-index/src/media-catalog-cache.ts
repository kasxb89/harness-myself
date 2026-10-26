/** Login-scoped reuse of fresh reusable public pricing responses. @module */

interface Entry { readonly expires: number; readonly rows: readonly unknown[] }

/** Cache controls apply to decoded metadata only, never balances or generation authorization. */
export class MediaCatalogCache {
  private readonly entries = new Map<string, Entry>()
  private revision = 0

  /** @param ttlMs - Configured upper bound; zero disables reuse. @param now - Monotonic elapsed clock. */
  constructor(private readonly ttlMs: number, private readonly now: () => number = () => performance.now()) {}

  /** Discard prior login metadata and prevent older reads repopulating the cache. */
  clear(): void { this.revision += 1; this.entries.clear() }

  /**
   * Read public pricing for one captured login and exact request headers.
   * @param scope - API address, account and login epoch, excluding credentials.
   * @param headers - Complete application-supplied headers, covering every possible Vary key.
   * @param request - Fresh bounded GET; response status and JSON remain validated here.
   * @param signal - This caller's cancellation, including cached reads.
   * @returns Decoded pricing rows; failed and non-cacheable responses are never retained.
   */
  async read(scope: string, headers: HeadersInit, request: () => Promise<Response>, signal?: AbortSignal): Promise<readonly unknown[]> {
    signal?.throwIfAborted()
    const key = JSON.stringify([scope, [...new Headers(headers)].sort(([a], [b]) => a.localeCompare(b))])
    const start = this.now()
    for (const [id, entry] of this.entries) if (entry.expires <= start) this.entries.delete(id)
    const cached = this.entries.get(key)
    if (cached !== undefined) return cached.rows
    const revision = this.revision
    const response = await request()
    if (!response.ok) {
      await response.body?.cancel()
      throw new MediaCatalogReadError(`HTTP_${String(response.status)}`)
    }
    const body: unknown = await response.json()
    signal?.throwIfAborted()
    if (body === null || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) {
      throw new MediaCatalogReadError('MODEL_CATALOG_INVALID')
    }
    const rows: readonly unknown[] = body.data
    const directives = (response.headers.get('cache-control') ?? '').toLowerCase().split(',').map(part => part.trim())
    const forbidden = directives.some(part => /^(?:no-store|no-cache)(?:$|=)/u.test(part))
      || response.headers.get('vary')?.split(',').some(part => part.trim() === '*') === true
    let ttl = this.ttlMs
    const maxAge = directives.find(part => /^max-age=/u.test(part))?.match(/^max-age="?(\d+)"?$/u)?.[1]
    const age = Math.max(0, Number(response.headers.get('age') ?? '0'))
    if (maxAge !== undefined) ttl = Math.min(ttl, Math.max(0, Number(maxAge) * 1000 - (Number.isFinite(age) ? age * 1000 : 0)))
    const expires = Date.parse(response.headers.get('expires') ?? '')
    const serverDate = Date.parse(response.headers.get('date') ?? '')
    if (Number.isFinite(expires) && Number.isFinite(serverDate)) {
      ttl = Math.min(ttl, Math.max(0, expires - serverDate - (Number.isFinite(age) ? age * 1000 : 0)))
    }
    // Include network and decoding time in freshness rather than extending a response's lifetime.
    if (!forbidden && ttl > 0 && revision === this.revision) {
      if (this.entries.size >= 64) this.entries.clear()
      this.entries.set(key, { expires: start + ttl, rows })
    }
    return rows
  }
}

/** Safe catalog diagnostic without retaining a remote response or credential. */
export class MediaCatalogReadError extends Error {
  /** @param code - Observed HTTP category or invalid metadata. */
  constructor(readonly code: string) { super('Media catalog could not be read'); this.name = 'MediaCatalogReadError' }
}
