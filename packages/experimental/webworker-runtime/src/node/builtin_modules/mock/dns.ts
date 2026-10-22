/** DNS lookup is unavailable in a browser Worker; importing a native transport does not resolve hosts. */
import { notImplementedFail } from '../../notImplementedFail.ts'

/** Callback lookup used only when a native SOCKS transport attempts a connection. */
export const lookup: typeof import('node:dns').lookup = notImplementedFail('node:dns', 'lookup')

/** CommonJS interop marker. */
export const __esModule = true

/** Native lookup refuses explicitly instead of inventing an address. */
export default { lookup } satisfies Partial<typeof import('node:dns')>
