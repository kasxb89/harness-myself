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
