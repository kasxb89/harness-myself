/** HTTP transport confinement for the product's deployed Harness model API. */
import { LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { LlmTextReselectionProof } from '@deepseek-ai/dsh-llm'
import type { HarnessModelConfigRequest } from './harness-account.ts'

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
  const error = raw?.error
  if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'model_config_changed') return undefined
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

/** Only the configured gateway's reserved pre-billing receipt confirms a version rejection. */
async function modelConfigRejection(response: Response): Promise<ReturnType<typeof ProviderRequestId> | undefined> {
  if (response.status !== 400 || response.headers.get('X-Yunshu-Model-Config-Result') !== 'rejected-before-billing'
    || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return undefined
  const requestId = response.headers.get('X-Oneapi-Request-Id')
  if (requestId === null || !/^[A-Za-z\d_.-]{1,64}$/u.test(requestId)) return undefined
  const raw = await errorJson(response), error = raw?.error
  if (raw === undefined || Object.keys(raw).length !== 1 || error === null || typeof error !== 'object' || Array.isArray(error)) {
    return undefined
  }
  const value = error as Record<string, unknown>
  if (Object.keys(value).length !== 4 || value.code !== 'model_config_changed' || value.type !== 'invalid_request_error'
    || value.param !== '' || typeof value.message !== 'string' || value.message.length === 0 || value.message.length > 1024) return undefined
  return ProviderRequestId(requestId)
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
 * @param authorizedConfig - Prepared metadata already approved by the live Host account owner; never provider-profile authority.
 * @param authorizeConfig - Rechecks that exact prepared metadata immediately before any network send.
 * @returns A prefix-validating, redirect-refusing fetch for Harness, or the provider's normal transport selection.
 * @throws LlmError when the Harness model root can address the adjacent production service.
 */
export function harnessFetch(
  baseUrl: string,
  onResponse?: (response: Response, proof?: LlmTextReselectionProof) => void | Promise<void>,
  reselection?: HarnessTextReselectionRequest,
  authorizedConfig?: HarnessModelConfigRequest,
  authorizeConfig?: () => Promise<boolean>,
): typeof globalThis.fetch | undefined {
  let base: URL
  try { base = new URL(baseUrl) } catch (_invalidProviderUrl: unknown) {
    // Other providers retain the SDK's endpoint validation and transport behavior.
    return undefined
  }
  const production = base.hostname === '8.133.202.230'
  if (!production && authorizedConfig === undefined) return undefined
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(base.hostname)
  if (production && (base.origin !== 'https://8.133.202.230' || base.pathname.replace(/\/+$/u, '') !== '/harness/v1')
    || !production && (authorizedConfig?.baseURL !== baseUrl || base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
    || base.username !== '' || base.password !== '' || baseUrl.includes('@') || baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new LlmError('Harness model endpoint must be https://8.133.202.230/harness/v1', 'INVALID_CONFIG')
  }
  if (authorizedConfig !== undefined && authorizedConfig.baseURL !== baseUrl) {
    throw new LlmError('The authorized model configuration belongs to another endpoint', 'MODEL_CONFIG_CHANGED')
  }
  const prefix = base.pathname.replace(/\/+$/u, '') + '/'
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)
      || url.username !== '' || url.password !== '' || url.hash !== '' || /%(?:2f|5c|25)/iu.test(url.pathname)) {
      throw new LlmError('Harness model request escaped its configured API prefix', 'INVALID_REQUEST')
    }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const chatPost = method.toUpperCase() === 'POST' && url.pathname === prefix + 'chat/completions'
    const canProve = chatPost && url.search === '' && reselection !== undefined && matchesRequest(init?.body, reselection)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    // Single-attempt server dispatch does not depend on SDK body representation.
    headers.delete('X-Yunshu-Text-Reselection')
    headers.delete('X-Yunshu-Model-Config-Version')
    if (chatPost) headers.set('X-Yunshu-Text-Reselection', '1')
    if (authorizedConfig !== undefined) {
      if (!chatPost || url.search !== '' || !matchesRequest(init?.body, {
        model: authorizedConfig.model, managedScope: authorizedConfig.scope,
      })) throw new LlmError('The SDK request does not match the authorized model configuration', 'INVALID_REQUEST')
      if (await authorizeConfig?.() !== true) {
        throw new LlmError('模型配置或登录状态已变化，本次尚未发送；请刷新目录后明确重试。', 'MODEL_CONFIG_CHANGED')
      }
      init?.signal?.throwIfAborted()
      headers.set('X-Yunshu-Model-Config-Version', authorizedConfig.modelConfigVersion)
    }
    const response = await globalThis.fetch(input, { ...init, headers, redirect: 'error' })
    const rejectedConfig = authorizedConfig === undefined ? undefined : await modelConfigRejection(response)
    const proof = rejectedConfig === undefined && canProve ? await textReselectionProof(response, reselection, base.origin) : undefined
    await onResponse?.(response, proof)
    if (rejectedConfig !== undefined) {
      void response.body?.cancel().catch(() => {})
      throw new LlmError('模型配置已更新，本次请求已在计费前拒绝；请刷新目录后重新确认，不会自动重新生成。',
        'MODEL_CONFIG_CHANGED', { status: 400, requestId: rejectedConfig })
    }
    if (authorizedConfig !== undefined && response.ok
      && response.headers.get('X-Yunshu-Model-Config-Version') !== authorizedConfig.modelConfigVersion) {
      void response.body?.cancel().catch(() => {})
      throw new LlmError('模型配置版本确认暂不可用，原请求可能已受理；请核对已有记录，不要重复提交。',
        'MODEL_CONFIG_CONFIRMATION_UNAVAILABLE', { status: response.status })
    }
    return response
  }
}
