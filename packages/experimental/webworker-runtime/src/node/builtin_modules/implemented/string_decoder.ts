/** Incremental text decoding for image packages, using Node's maintained userland implementation. */
import { StringDecoder } from 'string_decoder'

export { StringDecoder }

/** CommonJS interop marker consumed by the worker module loader. */
export const __esModule = true

/** CommonJS-compatible incremental decoder constructor. */
export default { StringDecoder } satisfies typeof import('node:string_decoder')
