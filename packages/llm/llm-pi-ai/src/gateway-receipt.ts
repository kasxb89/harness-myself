/** Optional gateway receipt stored beside adapter-private replay metadata. */
import { ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { ReplayEnvelope, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Transport identity only; neither model usage estimates nor credentials. */
export interface GatewayReceipt {
  readonly kind: 'oneapi'
  readonly version: 1
  readonly apiBaseUrl: string
  readonly requestId: ProviderRequestId
}

/**
 * Validate the response-header request id and retain its configured model endpoint.
 * @param apiBaseUrl - Actual model API root captured for this attempt.
 * @param headers - HTTP response headers supplied by the transport.
 * @returns A receipt when the gateway supplied a bounded request identity.
 */
export function gatewayReceipt(apiBaseUrl: string, headers: Headers): GatewayReceipt | undefined {
  const requestId = headers.get('x-oneapi-request-id')
  if (requestId === null || !/^[A-Za-z\d_.-]{1,64}$/u.test(requestId)) return undefined
  if (apiBaseUrl.length > 2048 || apiBaseUrl !== apiBaseUrl.trim() || /[\\\u0000-\u0020\u007f?#]/u.test(apiBaseUrl)) return undefined
  let endpoint: URL
  try { endpoint = new URL(apiBaseUrl) } catch (_invalidGatewayEndpoint: unknown) { return undefined }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local) || endpoint.hostname === '' || endpoint.username !== ''
    || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '') return undefined
  return { kind: 'oneapi', version: 1, apiBaseUrl: endpoint.origin + endpoint.pathname.replace(/\/+$/u, ''), requestId: ProviderRequestId(requestId) }
}

/**
 * Attach read-only billing correlation without changing provider-native replay fields.
 * @param chunk - Terminal provider outcome.
 * @param receipt - Optional response identity captured by this exact attempt.
 * @returns The same outcome with its optional opaque transport receipt.
 */
export function withGatewayReceipt(chunk: Extract<StreamChunk, { type: 'finish' }>, receipt: GatewayReceipt | undefined): Extract<StreamChunk, { type: 'finish' }> {
  if (receipt === undefined) return chunk
  const original = chunk.replayState?.response
  const response = typeof original === 'object' && original !== null && !Array.isArray(original)
    ? original as Record<string, unknown> : {}
  const replayState: ReplayEnvelope = { ...chunk.replayState, response: { ...response, gatewayReceipt: receipt } }
  return { ...chunk, replayState }
}
