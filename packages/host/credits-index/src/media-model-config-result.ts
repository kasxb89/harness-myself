/** Gateway-owned model configuration receipts; vendor messages never authorize a replay. @module */
import { CreativeError } from './creative-store.ts'
import { readModelConfigVersion, type ModelConfigVersion } from './model-config-version.ts'

/** Exact authenticated Host operation associated with this fetch response. */
export interface MediaModelConfigBinding {
  readonly url: string
  readonly method: 'POST'
  readonly model: string
  readonly accountId: string
  readonly modelConfigVersion?: ModelConfigVersion
}

/** Gateway guard reasons that confirm no submission but never authorize a replay. */
export type MediaModelConfigRejectionCode = 'MODEL_CONFIG_CHANGED' | 'MODEL_PARAMETERS_INVALID'

/**
 * Describe one rejected request without changing other accepted tasks' financial state.
 * @param code - Validated gateway guard reason.
 * @returns A safe refresh instruction with no automatic retry permission.
 */
export function mediaModelConfigRejectionMessage(code: MediaModelConfigRejectionCode): string {
  return code === 'MODEL_CONFIG_CHANGED'
    ? '模型配置已更新，该请求尚未提交上游、未预扣积分；请刷新配置并明确重新操作，不会自动重发。'
    : '当前参数不在该模型支持范围内，该请求尚未提交上游、未预扣积分；请按当前模型配置重新选择，不会自动重发。'
}

/** Complete zero-submission proof for this operation, with no permission to resend. */
export class MediaModelConfigRejection extends CreativeError {
  /** The gateway did not admit this request. */
  readonly accepted = false
  /** The gateway confirmed that this request did not reach its provider. */
  readonly submissionState = 'not_submitted'
  /** Transport must not retry this POST automatically. */
  readonly retryable = false
  /** A new operation requires a fresh explicit human decision. */
  readonly resubmittable = false
  /** No charge was consumed by this rejected request. */
  readonly charged = false
  /** No charge was reserved by this rejected request. */
  readonly reserved = false

  /** @param code - Validated guard reason. @param binding - Captured Host operation. @param requestId - Exact gateway response identity. */
  constructor(
    code: MediaModelConfigRejectionCode,
    readonly binding: Readonly<MediaModelConfigBinding>,
    readonly requestId: string,
  ) {
    super(code, 400, mediaModelConfigRejectionMessage(code))
    this.name = 'MediaModelConfigRejection'
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function boundResponse(response: Response, binding: MediaModelConfigBinding): boolean {
  const operation = object(binding)
  if (operation?.method !== 'POST' || response.redirected || typeof operation.url !== 'string'
    || typeof operation.model !== 'string' || operation.model.trim() !== operation.model || operation.model.length === 0
    || operation.model.length > 191 || /[\u0000-\u0020\u007f]/u.test(operation.model)
    || typeof operation.accountId !== 'string' || operation.accountId.length === 0 || operation.accountId.length > 256
    || /[\u0000-\u0020\u007f]/u.test(operation.accountId)
    || Object.keys(operation).some(key => !['url', 'method', 'model', 'accountId', 'modelConfigVersion'].includes(key))) return false
  try {
    const expected = new URL(operation.url), actual = new URL(response.url)
    if (!['http:', 'https:'].includes(expected.protocol) || expected.username !== '' || expected.password !== ''
      || expected.hash !== '' || actual.href !== expected.href) return false
    if (operation.modelConfigVersion !== undefined) readModelConfigVersion({ model_config_version: operation.modelConfigVersion })
    return true
  } catch (_unboundResponse: unknown) { return false }
}

/**
 * Recognize only the configured gateway's exact pre-billing guard response.
 * @param response - Actual same-origin fetch response, not a model-provided object.
 * @param value - Its bounded parsed JSON body.
 * @param binding - Captured account, model, endpoint and optional requested version.
 * @returns A no-send/no-reservation rejection, never a replay authorization.
 */
export function mediaModelConfigRejection(
  response: Response, value: unknown, binding: MediaModelConfigBinding,
): MediaModelConfigRejection | undefined {
  if (response.status !== 400 || !boundResponse(response, binding)
    || response.headers.get('X-Yunshu-Model-Config-Result') !== 'rejected-before-billing') return undefined
  const requestId = response.headers.get('X-Oneapi-Request-Id')
  if (requestId === null || requestId.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(requestId)) return undefined
  const body = object(value), error = object(body?.error)
  if (body?.accepted !== false || body.charged !== false || body.reserved !== false || body.retryable !== false
    || body.resubmittable !== false || body.submission_state !== 'not_submitted'
    || error?.type !== 'invalid_request_error' || typeof error.message !== 'string' || error.message.length > 4096
    || !['model_config_changed', 'model_parameters_invalid'].includes(String(error.code))
    || Object.keys(body).some(key => !['accepted', 'charged', 'reserved', 'retryable', 'resubmittable', 'submission_state', 'error'].includes(key))
    || Object.keys(error).some(key => !['code', 'type', 'message'].includes(key))) return undefined
  return new MediaModelConfigRejection(error.code === 'model_config_changed' ? 'MODEL_CONFIG_CHANGED' : 'MODEL_PARAMETERS_INVALID',
    Object.freeze({ ...binding }), requestId)
}

/**
 * Check an accepted response's echo without treating a mismatch as an unsent request.
 * @param response - Successful gateway response already received after POST.
 * @param expectedVersion - Captured model row version, absent for legacy operations.
 * @returns Whether the echo agrees, or true for an unversioned legacy operation.
 */
export function matchesModelConfigAcceptance(response: Response, expectedVersion: ModelConfigVersion | undefined): boolean {
  if (expectedVersion === undefined) return true
  const echo = response.headers.get('X-Yunshu-Model-Config-Version')
  return echo !== null && /^[a-f0-9]{64}$/u.test(echo) && echo === expectedVersion
}

/**
 * Read only the reported acceptance version; it does not prove submission or grant a replay.
 * @param response - Original gateway response.
 * @returns A valid echo, or absence for a missing or malformed header.
 */
export function readModelConfigAcceptanceVersion(response: Response): ModelConfigVersion | undefined {
  const echo = response.headers.get('X-Yunshu-Model-Config-Version')
  return echo === null || !/^[a-f0-9]{64}$/u.test(echo) ? undefined : readModelConfigVersion({ model_config_version: echo })
}
