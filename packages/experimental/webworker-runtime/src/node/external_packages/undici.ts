/** Browser Fetch primitives for exact `undici` imports; Node dispatchers remain unavailable. */
import { notImplementedFail, notAvailableError } from '../notImplementedFail.ts'

/** Native Fetch data classes retain their browser identity and semantics. */
export const { Headers, Request, Response, FormData } = globalThis

/**
 * Fetch with the browser's HTTP, CORS, redirect, body, and cancellation behavior.
 * @param input - Browser Fetch request or URL.
 * @param init - Browser request options; an explicit Node dispatcher is rejected before any request.
 * @returns The browser response, unchanged.
 */
export async function fetch(input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }): Promise<Response> {
  if (init?.dispatcher !== undefined) throw notAvailableError('undici', 'fetch dispatcher')
  return globalThis.fetch(input, init)
}

/** Native connection-pool construction is unavailable. */
export const Agent = notImplementedFail('undici', 'Agent')
/** Native per-origin pool construction is unavailable. */
export const Pool = notImplementedFail('undici', 'Pool')
/** Explicit native proxy construction is unavailable. */
export const ProxyAgent = notImplementedFail('undici', 'ProxyAgent')
/** Environment-controlled native proxy construction is unavailable. */
export const EnvHttpProxyAgent = notImplementedFail('undici', 'EnvHttpProxyAgent')
/** Native process-wide dispatchers are unavailable. */
export const getGlobalDispatcher = notImplementedFail('undici', 'getGlobalDispatcher')
/** Browser Fetch cannot install a native process-wide dispatcher. */
export const setGlobalDispatcher = notImplementedFail('undici', 'setGlobalDispatcher')

/** CommonJS interop marker. */
export const __esModule = true

/** Exact public members consumed by the packed market, IM, proxy-policy, and HTTP provider modules. */
export default {
  fetch, Headers, Request, Response, FormData,
  Agent, Pool, ProxyAgent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher,
}
