/** Platform media rejection proofs and compatible exact H3 settlement proofs. @module */
import {
  hasMediaSubmissionReceipt, mediaSubmissionRejection, mediaSubmissionQueryRejection, mediaSubmissionMessage,
} from './media-submission-receipt.ts'

/** A gateway-confirmed terminal attempt; it never authorizes automatic resubmission. */
export class VideoSubmissionRejection extends Error {
  /**
   * @param code - Safe client-facing failure identity.
   * @param message - Gateway-owned outcome summary without upstream response content.
   * @param submissionState - Confirmed non-acceptance, including a settled upstream refusal, or a definitively failed task.
   * @param taskId - Original platform task, absent when admission created no task.
   */
  constructor(
    readonly code: string, message: string,
    readonly submissionState: 'not_submitted' | 'failed', readonly taskId?: string,
  ) { super(message); this.name = 'VideoSubmissionRejection' }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) && !/^(?:sk-|nap_)/iu.test(value)
}

/** Ledger proof that the gateway created an original local task but never sent it upstream. */
function notSent(value: Record<string, unknown>, code: unknown): VideoSubmissionRejection | undefined {
  if (value.submission_code !== 'h3_submission_not_sent' || value.submission_state !== 'not_submitted'
    || value.upstream_submitted !== false || value.retryable !== false || value.resubmittable !== true
    || !identifier(value.id) || value.id !== value.task_id
    || value.billing_state !== 'not_charged' && value.billing_state !== 'refunded'
    || value.billing_state === 'refunded' && value.refund_confirmed !== true
    || value.billing_state === 'not_charged' && value.refund_confirmed !== undefined && value.refund_confirmed !== false) return undefined
  if (code !== undefined && (typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(code)
    || /^(?:sk-|nap_)/iu.test(code))) return undefined
  return new VideoSubmissionRejection(typeof code === 'string' ? code : 'H3_SUBMISSION_NOT_SENT',
    value.billing_state === 'refunded' ? '原视频请求未发送至上游，退款已确认；原任务记录保留，不会自动重新生成。'
      : '原视频请求未发送至上游且未扣费；原任务记录保留，不会自动重新生成。', 'not_submitted', value.id)
}

/**
 * Detect a query's explicit proof field so a malformed proof cannot fall through to a generic failed status.
 * @param value - Parsed original-task query response.
 * @returns Whether either supported query envelope contains the proof field.
 */
export function hasH3SubmissionReceipt(value: unknown): boolean {
  const body = record(value)
  return body !== undefined && (Object.hasOwn(body, 'submission_receipt')
    || Object.hasOwn(record(body.data) ?? {}, 'submission_receipt'))
}

/**
 * Accept only an owned original-task GET proof matching every returned identity.
 * @param model - Exact model retained by the original local operation.
 * @param httpStatus - Actual query transport status; authentication failures never settle tasks.
 * @param value - Parsed native video object or generic data envelope.
 * @param taskId - Original task id used in this GET, never inferred from a header.
 * @returns A confirmed unsent rejection, otherwise the original task must remain unresolved.
 */
export function h3SubmissionQueryRejection(
  model: unknown, httpStatus: number, value: unknown, taskId: string,
): VideoSubmissionRejection | undefined {
  if (hasMediaSubmissionReceipt(value)) {
    const proof = mediaSubmissionQueryRejection(model, 'video', httpStatus, value, taskId)
    return proof === undefined ? undefined : new VideoSubmissionRejection(proof.code, mediaSubmissionMessage(proof), 'not_submitted', proof.taskId)
  }
  const body = record(value)
  if (model !== 'MiniMax-H3' || httpStatus !== 200 || body === undefined || !identifier(taskId)) return undefined
  const nested = record(body.data)
  const containers = [body, ...nested === undefined ? [] : [nested]]
  const proofs = containers.filter(container => Object.hasOwn(container, 'submission_receipt'))
  if (proofs.length !== 1 || containers.some(container =>
    container.provider_terminal_confirmed !== undefined && container.provider_terminal_confirmed !== false
    || ['id', 'task_id'].some(key => container[key] !== undefined && container[key] !== taskId))) return undefined
  const proof = record(proofs[0]?.submission_receipt)
  if (proof === undefined || proof.id !== taskId || proof.task_id !== taskId) return undefined
  return notSent(proof, proof.code)
}

/**
 * Detect an explicit terminal-marker field, including malformed values that must remain unresolved.
 * @param value - Parsed original-task response.
 * @returns Whether a supported query envelope declares a provider terminal marker.
 */
export function hasH3ProviderTerminal(value: unknown): boolean {
  const body = record(value)
  return body !== undefined && (Object.hasOwn(body, 'provider_terminal_confirmed')
    || Object.hasOwn(record(body.data) ?? {}, 'provider_terminal_confirmed'))
}

/**
 * Recognize a gateway-confirmed original provider terminal without implying a refund or permission to submit.
 * @param model - Exact model retained by the original local operation.
 * @param httpStatus - Actual canonical GET transport status.
 * @param value - Canonical video task object or data envelope.
 * @param taskId - Original platform task id used in this GET.
 * @returns A typed original-task failure, otherwise the retained task remains unresolved.
 */
export function h3ProviderTerminalRejection(
  model: unknown, httpStatus: number, value: unknown, taskId: string,
): VideoSubmissionRejection | undefined {
  const body = record(value)
  if (hasMediaSubmissionReceipt(value) || model !== 'MiniMax-H3' || httpStatus !== 200 || body === undefined || !identifier(taskId)) return undefined
  const nested = record(body.data)
  const containers = [body, ...nested === undefined ? [] : [nested]]
  const markers = containers.filter(container => Object.hasOwn(container, 'provider_terminal_confirmed'))
  const identities = containers.flatMap(container => [container.id, container.task_id].filter(id => id !== undefined))
  const states = containers.flatMap(container => [container.status, container.task_status].filter(state => state !== undefined))
  if (markers.length !== 1 || markers[0]?.provider_terminal_confirmed !== true || identities.length === 0
    || identities.some(id => id !== taskId) || states.length === 0
    || states.some(state => typeof state !== 'string' || !['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled'].includes(state.toLowerCase()))
    || containers.some(container => Object.hasOwn(container, 'submission_receipt') || container.resubmittable === true
      || container.object !== undefined && container.object !== 'video')) return undefined
  return new VideoSubmissionRejection('PROVIDER_TASK_FAILED',
    '上游原视频任务已明确结束且未成功；该终态不代表退款已确认，不会自动重新生成。', 'failed', taskId)
}

/**
 * Recognize complete platform media rejection proofs or the legacy exact H3 no-charge and confirmed-refund fields.
 * @param model - Exact submitted public model; legacy H3 settlement applies only to MiniMax-H3.
 * @param httpStatus - Actual transport status, not a value inside the JSON body.
 * @param value - Parsed gateway JSON; partial, conflicting and legacy responses remain uncertain.
 * @returns A terminal rejection proof, or undefined when acceptance or settlement remains unknown.
 */
export function h3SubmissionRejection(model: unknown, httpStatus: number, value: unknown): VideoSubmissionRejection | undefined {
  if (hasMediaSubmissionReceipt(value)) {
    const proof = mediaSubmissionRejection(model, 'video', httpStatus, value)
    return proof === undefined ? undefined : new VideoSubmissionRejection(proof.code, mediaSubmissionMessage(proof), 'not_submitted', proof.taskId)
  }
  if (model !== 'MiniMax-H3' || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  if (httpStatus >= 400 && httpStatus <= 599) {
    const nested = record(body.error)
    if (body.code === undefined || nested?.code === undefined || body.code === nested.code) {
      const rejected = notSent(body, body.code ?? nested?.code)
      if (rejected !== undefined && (body.data === undefined || body.data === null)) return rejected
    }
  }
  if (body.data !== null || body.retryable !== false) return undefined
  if (httpStatus === 429 && body.code === 'h3_account_capacity_exhausted' && body.submission_state === 'not_submitted'
    && body.resubmittable === true && body.id === undefined && body.task_id === undefined) {
    return new VideoSubmissionRejection('H3_ACCOUNT_CAPACITY_EXHAUSTED',
      '视频服务当前没有可用生成名额，本次未提交生成、未扣费；请稍后由你重新发起。', 'not_submitted')
  }
  if (httpStatus === 502 && body.code === 'h3_upstream_auth_rejected' && body.submission_state === 'failed'
    && body.refund_confirmed === true && body.resubmittable === false && typeof body.id === 'string'
    && body.id === body.task_id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(body.id) && !/^(?:sk-|nap_)/iu.test(body.id)) {
    return new VideoSubmissionRejection('H3_UPSTREAM_AUTH_REJECTED',
      '上游视频服务拒绝了本次请求，原任务已失败且退款已确认；请保留任务编号核对，不会自动重新生成。', 'failed', body.id)
  }
  return undefined
}
