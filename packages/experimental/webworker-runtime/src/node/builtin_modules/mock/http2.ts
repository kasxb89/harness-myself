/** HTTP/2 header names are data; native sessions are unavailable in a browser Worker. */
import { notImplementedFail } from '../../notImplementedFail.ts'

/** Standard pseudo-header names read by the IM client's HTTP/2 implementation. */
export const constants = {
  HTTP2_HEADER_SCHEME: ':scheme', HTTP2_HEADER_METHOD: ':method',
  HTTP2_HEADER_PATH: ':path', HTTP2_HEADER_STATUS: ':status',
} satisfies Partial<typeof import('node:http2').constants>

/** Native HTTP/2 connection; refuses before opening a socket. */
export const connect: typeof import('node:http2').connect = notImplementedFail('node:http2', 'connect')
/** CommonJS interop marker. */
export const __esModule = true
/** Only protocol metadata and explicit transport refusal are exposed. */
export default { constants, connect }
