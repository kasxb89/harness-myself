/** Current-account Desktop activity forwarding without content or persistent device identifiers. */
import { randomUUID } from 'node:crypto'

/** Validated native fields; the Host never accepts a caller-supplied user ID. */
export interface ClientActivitySample {
  session_id: string
  event: 'start' | 'heartbeat' | 'stop'
  foreground: boolean
  platform: 'darwin' | 'win32' | 'linux'
  app_version: string
}

/**
 * Validate the process-to-Host JSON fields, rejecting additional data.
 * @param value - untrusted JSON.
 * @returns selected sample or null.
 */
export function parseClientActivity(value: unknown): ClientActivitySample | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['session_id', 'event', 'foreground', 'platform', 'app_version'].includes(key))
    || typeof input.session_id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(input.session_id)
    || !['start', 'heartbeat', 'stop'].includes(String(input.event)) || typeof input.foreground !== 'boolean'
    || !['darwin', 'win32', 'linux'].includes(String(input.platform))
    || typeof input.app_version !== 'string' || !/^[A-Za-z0-9.+_-]{1,80}$/u.test(input.app_version)) return null
  return { session_id: input.session_id, event: input.event as ClientActivitySample['event'], foreground: input.foreground,
    platform: input.platform as ClientActivitySample['platform'], app_version: input.app_version }
}

/**
 * Confirm that the authenticated presence request established its current account session.
 * @param response - Presence endpoint response; HTTP success alone is insufficient.
 * @param signal - Request and account-epoch lifetime; abort cancels and drains the owned reader.
 * @returns True only for HTTP success with a JSON object containing success: true within 2048 UTF-8 bytes.
 */
export async function readClientActivityAcknowledgement(response: Response, signal: AbortSignal): Promise<boolean> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try { reader = response.body?.getReader() }
  catch (_unavailableBody: unknown) { return false }
  if (reader === undefined) return false
  const owned = reader
  let cancellation: Promise<void> | undefined
  const cancel = (): Promise<void> => cancellation ??= Promise.resolve().then(async () => { await owned.cancel() })
    .catch((_closedBody: unknown) => { /* A failed body cannot confirm presence; cancellation is still settled. */ })
  const abort = (): void => { void cancel() }
  signal.addEventListener('abort', abort, { once: true })
  let confirmed = false
  try {
    signal.throwIfAborted()
    if (!response.ok) return false
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const chunk = await owned.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 2048) return false
      chunks.push(chunk.value)
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    confirmed = value !== null && typeof value === 'object' && !Array.isArray(value)
      && 'success' in value && value.success === true
  } catch (_unconfirmedPresence: unknown) { return false }
  finally {
    signal.removeEventListener('abort', abort)
    await cancel()
    try { owned.releaseLock() }
    catch (_releasedBody: unknown) { /* An unusable reader cannot retain or establish an account session. */ }
  }
  return confirmed && !signal.aborted
}

/** One random UUID for the current native process and phone sign-in; credentials never leave the Host. */
export class ClientActivitySessions {
  private current: { processId: string; accountSession: string; id: string } | undefined

  /**
   * Resolve the current process and account epoch to one random report ID.
   * @param processId - process-local native UUID.
   * @param accountSession - Host-private login epoch.
   * @returns random, sign-in-scoped UUID.
   */
  resolve(processId: string, accountSession: string): string {
    if (this.current?.processId === processId && this.current.accountSession === accountSession) return this.current.id
    const id = randomUUID()
    this.current = { processId, accountSession, id }
    return id
  }

  /** Forget a stopped or signed-out epoch; a subsequent report receives a fresh UUID. */
  clear(): void { this.current = undefined }
}
