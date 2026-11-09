/** HTTP transport confinement for the product's deployed Harness model API. */
import { LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { LlmTextReselectionProof } from '@deepseek-ai/dsh-llm'

/** Prepared route identity required before accepting a chat request's zero-send evidence. */
export interface HarnessTextReselectionRequest {
  readonly model: string
  readonly managedScope: string
}

/** Read a bounded JSON error without consuming the response the SDK will receive. */
async function errorJson(response: Response): Promise<Record<string, unknown> | undefined> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    reader = response.clone().body?.getReader()
    if (reader === undefined) return undefined
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 32 * 1024) return undefined
      chunks.push(part.value)
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown> : undefined
  } catch (_unreadableBody: unknown) {
    return undefined
  } finally {
    // A tee cancellation can wait for the SDK's other reader.
    void reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}

/** Validate only the gateway's declared model-unavailable rejection statuses. */
async function textReselectionProof(
  response: Response, request: HarnessTextReselectionRequest, origin: string,
): Promise<LlmTextReselectionProof | undefined> {
  if (response.status !== 400 && response.status !== 503) return undefined
  const requestId = response.headers.get('x-oneapi-request-id')
  if (requestId === null || !/^[A-Za-z\d_.-]{1,64}$/u.test(requestId)) return undefined
  const raw = await errorJson(response)
  const proof = raw?.text_reselection
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) return undefined
  const value = proof as Record<string, unknown>
  if (Object.keys(value).length !== 7 || value.schema_version !== 1 || value.model !== request.model
    || value.request_id !== requestId || value.submission_state !== 'not_submitted'
    || value.upstream_submitted !== false || value.billing_reserved !== false
    || value.reason !== 'model_unavailable') return undefined
  return Object.freeze({ schemaVersion: 1, model: request.model, requestId: ProviderRequestId(requestId), origin,
    managedScope: request.managedScope, submissionState: 'not_submitted', upstreamSubmitted: false,
    billingReserved: false, reason: 'model_unavailable' })
}

/** Only an SDK JSON string with this prepared model can establish request identity. */
function matchesRequest(body: BodyInit | null | undefined, request: HarnessTextReselectionRequest): boolean {
  if (typeof body !== 'string' || request.model.length === 0 || request.model.length > 512
    || request.model !== request.model.trim() || /[\u0000-\u001f\u007f]/u.test(request.model)
    || request.managedScope.length === 0 || request.managedScope.length > 512
    || request.managedScope !== request.managedScope.trim() || /[\u0000-\u001f\u007f]/u.test(request.managedScope)) return false
  try {
    const value: unknown = JSON.parse(body)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && 'model' in value && value.model === request.model
  } catch (_invalidSdkJson: unknown) {
    return false
  }
}

/**
 * Read only a bounded rejected gateway envelope, before the SDK flattens its code.
 * @param response - Rejected response from the confined Harness endpoint.
 * @returns True only for the gateway's explicit user-funding code.
 */
export async function harnessBalanceRejected(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  const error = (await errorJson(response))?.error
  return error !== null && typeof error === 'object'
    && 'code' in error && error.code === 'insufficient_user_quota'
    && 'type' in error && error.type === 'new_api_error'
}

/**
 * Protect the deployed Harness prefix on its shared production authority.
 * @param baseUrl - Configured model API root.
 * @param onResponse - Optional transport observer, including rejected HTTP responses.
 * @param reselection - Prepared managed route identity; absent prevents accepting reselection evidence.
 * @returns A prefix-validating, redirect-refusing fetch for Harness, or the provider's normal transport selection.
 * @throws LlmError when the Harness model root can address the adjacent production service.
 */
export function harnessFetch(
  baseUrl: string,
  onResponse?: (response: Response, proof?: LlmTextReselectionProof) => void | Promise<void>,
  reselection?: HarnessTextReselectionRequest,
): typeof globalThis.fetch | undefined {
  let base: URL
  try { base = new URL(baseUrl) } catch (_invalidProviderUrl: unknown) {
    // Other providers retain the SDK's endpoint validation and transport behavior.
    return undefined
  }
  if (base.hostname !== '8.133.202.230') return undefined
  if (base.origin !== 'https://8.133.202.230' || base.pathname.replace(/\/+$/u, '') !== '/harness/v1'
    || base.username !== '' || base.password !== '' || baseUrl.includes('@') || baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new LlmError('Harness model endpoint must be https://8.133.202.230/harness/v1', 'INVALID_CONFIG')
  }
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin !== base.origin || !url.pathname.startsWith('/harness/v1/')
      || url.username !== '' || url.password !== '' || url.hash !== '' || /%(?:2f|5c|25)/iu.test(url.pathname)) {
      throw new LlmError('Harness model request escaped its configured API prefix', 'INVALID_REQUEST')
    }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const chatPost = method.toUpperCase() === 'POST' && url.pathname === '/harness/v1/chat/completions'
    const canProve = chatPost && url.search === '' && reselection !== undefined && matchesRequest(init?.body, reselection)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    // Single-attempt server dispatch does not depend on SDK body representation.
    headers.delete('X-Yunshu-Text-Reselection')
    if (chatPost) headers.set('X-Yunshu-Text-Reselection', '1')
    const response = await globalThis.fetch(input, { ...init, headers, redirect: 'error' })
    const proof = canProve ? await textReselectionProof(response, reselection, base.origin) : undefined
    await onResponse?.(response, proof)
    return response
  }
}
