/** A browser Worker has no Node inspector endpoint or native debugging session. */
import { notImplementedFail } from '../../notImplementedFail.ts'

/**
 * Read the Node debugging endpoint.
 * @returns Undefined; the Worker never opens a Node inspector.
 */
export function url(): string | undefined { return undefined }

/** Opening a native Node debugger is unavailable. */
export const open: typeof import('node:inspector').open = notImplementedFail('node:inspector', 'open')
/** Native inspector sessions are unavailable. */
export const Session: typeof import('node:inspector').Session = notImplementedFail('node:inspector', 'Session')
/** CommonJS interop marker. */
export const __esModule = true
/** Debugger metadata remains distinct from unsupported native actions. */
export default { url, open, Session } satisfies Partial<typeof import('node:inspector')>
