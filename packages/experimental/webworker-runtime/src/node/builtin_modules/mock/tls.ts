/** Native TLS socket operations have no carrier in a browser Worker. */
import { notImplementedFail } from '../../notImplementedFail.ts'

/** TLS connection used by native proxy clients; no socket is opened. */
export const connect: typeof import('node:tls').connect = notImplementedFail('node:tls', 'connect')

/** CommonJS interop marker. */
export const __esModule = true

/** Native TLS operations refuse explicitly. */
export default { connect } satisfies Partial<typeof import('node:tls')>
