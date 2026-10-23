/** Platform-owned proofs for a durable media task which was never sent upstream. @module */

/** Media category retained by the initiating request, never inferred from a provider alias. */
export type MediaKind = 'image' | 'video'

/** Verified original task facts; resubmittable never authorizes an automatic POST. */
export interface MediaSubmissionRejection {
  readonly taskId: string
  readonly model: string
  readonly mediaKind: MediaKind
  readonly billingState: 'not_charged' | 'refunded'
  readonly code: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) && !/^(?:sk-|nap_)/iu.test(value)
}

function businessCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(value)
    && !/^(?:sk-|nap_)/iu.test(value) && value !== 'media_submission_unknown'
}

function containers(body: Record<string, unknown>): readonly Record<string, unknown>[] {
  return [body, record(body.data), record(body.error)].filter((value): value is Record<string, unknown> => value !== undefined)
}

function canonicalRecovery(value: unknown, taskId: string): boolean {
  const recovery = record(value)
  return recovery?.method === 'GET' && recovery.path === `/v1/tasks/${taskId}`
    && Object.keys(recovery).every(key => key === 'method' || key === 'path')
}

/**
 * Detect malformed or misplaced proofs before legacy failure decoding.
 * @param value - Parsed HTTP body.
 * @returns Whether a proof field exists.
 */
export function hasMediaSubmissionReceipt(value: unknown): boolean {
  const body = record(value)
  return body !== undefined && containers(body).some(container => Object.hasOwn(container, 'media_submission_receipt'))
}

/**
 * Detect explicit uncertainty without asserting rejection.
 * @param value - Parsed HTTP body.
 * @returns Whether the gateway unknown code exists.
 */
export function hasMediaSubmissionUnknown(value: unknown): boolean {
  const body = record(value)
  return body !== undefined && containers(body).some(container => container.code === 'media_submission_unknown')
}

/**
 * Bind HTTP202 uncertainty to the original task and fixed canonical GET path, without asserting billing.
 * @param model - Exact requested public model.
 * @param kind - Requested media category.
 * @param httpStatus - Actual transport status.
 * @param value - Parsed HTTP body.
 * @returns Coherent original task ID, otherwise undefined.
 */
export function mediaSubmissionUnknownTaskId(model: unknown, kind: MediaKind, httpStatus: number, value: unknown): string | undefined {
  const body = record(value)
  if (httpStatus !== 202 || body === undefined || record(body.error)?.code !== 'media_submission_unknown'
    || typeof model !== 'string' || body.model !== model || body.media_kind !== kind
    || !identifier(body.id) || body.task_id !== body.id || body.submission_state !== 'unknown'
    || body.status !== 'unknown' || body.retryable !== false || body.resubmittable !== false
    || body.code !== undefined || body.data !== undefined && body.data !== null
    || hasMediaSubmissionReceipt(body) || containers(body).some(container => Object.hasOwn(container, 'submission_receipt')
      || Object.hasOwn(container, 'provider_terminal_confirmed'))) return undefined
  if (!canonicalRecovery(body.recovery, body.id)) return undefined
  const error = record(body.error)
  if (error !== undefined && ['id', 'task_id'].some(key => error[key] !== undefined && error[key] !== body.id)) return undefined
  return body.id
}

function originalIdentity(model: unknown, kind: MediaKind, body: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof model !== 'string' || model.length === 0 || model.length > 256 || /[\u0000-\u0020\u007f]/u.test(model)) return undefined
  if (body.data !== undefined && body.data !== null && record(body.data) === undefined) return undefined
  const all = containers(body)
  const proofs = all.filter(container => Object.hasOwn(container, 'media_submission_receipt'))
  if (proofs.length !== 1 || proofs[0] !== body || all.some(container => Object.hasOwn(container, 'submission_receipt')
    || container.provider_terminal_confirmed !== undefined && container.provider_terminal_confirmed !== false)) return undefined
  const proof = record(body.media_submission_receipt)
  if (proof?.schema_version !== 1 || proof.model !== model || proof.media_kind !== kind
    || !identifier(proof.id) || proof.task_id !== proof.id) return undefined
  if (!canonicalRecovery(proof.recovery, proof.id)) return undefined
  if (all.some(container => ['id', 'task_id'].some(key => container[key] !== undefined && container[key] !== proof.id)
    || container.model !== undefined && container.model !== model
    || container.media_kind !== undefined && container.media_kind !== kind
    || container.recovery !== undefined && !canonicalRecovery(container.recovery, String(proof.id)))) return undefined
  return proof
}

/**
 * Retain an unambiguous task and fixed recovery route without asserting billing or submission state.
 * @param model - Exact requested public model.
 * @param kind - Requested media category.
 * @param value - Parsed HTTP body.
 * @returns Coherent original task ID, otherwise undefined.
 */
export function mediaSubmissionTaskId(model: unknown, kind: MediaKind, value: unknown): string | undefined {
  const body = record(value)
  if (body === undefined) return undefined
  const proof = originalIdentity(model, kind, body)
  return proof !== undefined && typeof proof.id === 'string' ? proof.id : undefined
}

const PROOF_KEYS = new Set(['schema_version', 'model', 'media_kind', 'id', 'task_id', 'submission_code', 'submission_state',
  'billing_state', 'refund_confirmed', 'upstream_submitted', 'retryable', 'resubmittable', 'recovery'])

function notSent(model: unknown, kind: MediaKind, body: Record<string, unknown>, code: string): MediaSubmissionRejection | undefined {
  const proof = originalIdentity(model, kind, body)
  if (proof === undefined || Object.keys(proof).some(key => !PROOF_KEYS.has(key))
    || proof.submission_code !== 'media_submission_not_sent' || proof.submission_state !== 'not_submitted'
    || proof.upstream_submitted !== false || proof.retryable !== false || proof.resubmittable !== true
    || proof.billing_state !== 'not_charged' && proof.billing_state !== 'refunded'
    || proof.billing_state === 'refunded' && proof.refund_confirmed !== true
    || proof.billing_state === 'not_charged' && proof.refund_confirmed !== undefined && proof.refund_confirmed !== false) return undefined
  if (containers(body).some(container =>
    container.submission_code !== undefined && container.submission_code !== proof.submission_code
    || container.submission_state !== undefined && container.submission_state !== proof.submission_state
    || container.upstream_submitted !== undefined && container.upstream_submitted !== false
    || container.retryable !== undefined && container.retryable !== false
    || container.resubmittable !== undefined && container.resubmittable !== true
    || container.billing_state !== undefined && container.billing_state !== proof.billing_state
    || container.refund_confirmed !== undefined && container.refund_confirmed !== proof.refund_confirmed
    || container.code === 'media_submission_unknown')) return undefined
  return { taskId: String(proof.id), model: String(proof.model), mediaKind: kind, billingState: proof.billing_state, code }
}

/**
 * Accept a complete schema1 platform rejection only on its failed POST transport.
 * @param model - Exact requested public model.
 * @param kind - Requested media category.
 * @param httpStatus - Actual transport status.
 * @param value - Parsed HTTP body.
 * @returns Confirmed original-task rejection, otherwise undefined.
 */
export function mediaSubmissionRejection(
  model: unknown, kind: MediaKind, httpStatus: number, value: unknown,
): MediaSubmissionRejection | undefined {
  const body = record(value)
  if (body === undefined || !Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 499 || !businessCode(body.code)
    || (httpStatus === 429) !== (body.code === 'media_account_capacity_exhausted')
    || body.data !== undefined && body.data !== null) return undefined
  const nestedCode = record(body.error)?.code
  if (nestedCode !== undefined && nestedCode !== body.code) return undefined
  if (containers(body).some(container => [container.status, container.task_status].some(state => state !== undefined
    && (typeof state !== 'string' || !['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled'].includes(state.toLowerCase()))))) return undefined
  const proof = notSent(model, kind, body, body.code)
  return proof !== undefined && body.id === proof.taskId && body.task_id === proof.taskId
    && body.model === proof.model && body.media_kind === kind ? proof : undefined
}

/**
 * Accept a canonical GET proof bound to the original ID and failed task status.
 * @param model - Retained public model.
 * @param kind - Retained media category.
 * @param httpStatus - Actual query status.
 * @param value - Parsed HTTP body.
 * @param taskId - Original task ID used in this GET.
 * @returns Confirmed original-task rejection, otherwise undefined.
 */
export function mediaSubmissionQueryRejection(
  model: unknown, kind: MediaKind, httpStatus: number, value: unknown, taskId: string,
): MediaSubmissionRejection | undefined {
  const body = record(value)
  if (httpStatus !== 200 || body === undefined || !identifier(taskId)) return undefined
  const states = containers(body).flatMap(container => [container.status, container.task_status].filter(state => state !== undefined))
  if (states.length === 0 || states.some(state => typeof state !== 'string'
    || !['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled'].includes(state.toLowerCase()))) return undefined
  const proof = notSent(model, kind, body, 'MEDIA_SUBMISSION_NOT_SENT')
  return proof?.taskId === taskId ? proof : undefined
}

/**
 * Render only verified platform facts.
 * @param proof - Validated rejection.
 * @returns Safe summary without provider content or secrets.
 */
export function mediaSubmissionMessage(proof: MediaSubmissionRejection): string {
  const kind = proof.mediaKind === 'image' ? '图片' : '视频'
  return proof.billingState === 'refunded'
    ? `本次${kind}请求未发送至上游，退款已确认；原任务记录保留，不会自动重新生成。`
    : `本次${kind}请求未发送至上游且未扣费；原任务记录保留，不会自动重新生成。`
}
