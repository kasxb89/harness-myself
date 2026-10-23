/** Bounded, credential-free public status reads shared by deployment-controlled dialogs. */

/** Observed failure categories; callers own their public route's stable error codes. */
export type PublicStatusFailure = 'unsupported' | 'network' | 'timeout' | 'unavailable' | 'invalid'

/** Decoded status JSON or the observed safe read failure. */
export type PublicStatusRead = { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: PublicStatusFailure }

/**
 * Read one status document without retaining raw failures or caching earlier documents.
 * @param fetchStatus - Credential-free, deployment-bound request with redirects disabled.
 * @param signal - Request, plugin and configured deadline lifetime.
 * @returns Decoded JSON limited to 1 MiB, or a safe observed failure category.
 */
export async function readPublicStatus(
  fetchStatus: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal,
): Promise<PublicStatusRead> {
  const interrupted = (): PublicStatusRead => ({ ok: false,
    reason: signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'network' })
  let response: Response
  try { signal.throwIfAborted(); response = await fetchStatus(signal) }
  catch (_transportFailed: unknown) { return interrupted() }
  if (!response.ok) {
    await response.body?.cancel().catch((_cancelledBody: unknown) => {})
    return { ok: false, reason: response.status === 404 ? 'unsupported' : 'unavailable' }
  }
  if (response.body === null) return { ok: false, reason: 'invalid' }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  const abort = (): void => { void reader.cancel().catch((_cancelledBody: unknown) => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > 1_048_576) return { ok: false, reason: 'invalid' }
      chunks.push(chunk.value)
    }
  } catch (_interruptedBody: unknown) { return interrupted() }
  finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch((_cancelledBody: unknown) => {})
  }
  try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) } }
  catch (_invalidJson: unknown) { return { ok: false, reason: 'invalid' } }
}
