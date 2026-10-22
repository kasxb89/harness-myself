/** Exact gateway proofs which distinguish rejected H3 attempts from uncertain submissions. @module */

/** A gateway-confirmed terminal attempt; it never authorizes automatic resubmission. */
export class VideoSubmissionRejection extends Error {
  /**
   * @param code - Safe client-facing failure identity.
   * @param message - Gateway-owned outcome summary without upstream response content.
   * @param submissionState - Whether generation never started or a created task definitively failed.
   * @param taskId - Original failed task, absent when admission created no task.
   */
  constructor(
    readonly code: 'H3_ACCOUNT_CAPACITY_EXHAUSTED' | 'H3_UPSTREAM_AUTH_REJECTED', message: string,
    readonly submissionState: 'not_submitted' | 'failed', readonly taskId?: string,
  ) { super(message); this.name = 'VideoSubmissionRejection' }
}

/**
 * Recognize only the gateway's complete H3 no-charge or confirmed-refund contract.
 * @param model - Exact submitted model; other suppliers cannot establish an H3 settlement.
 * @param httpStatus - Actual transport status, not a value inside the JSON body.
 * @param value - Parsed gateway JSON; partial, conflicting and legacy responses remain uncertain.
 * @returns A terminal rejection proof, or undefined when acceptance or settlement remains unknown.
 */
export function h3SubmissionRejection(model: unknown, httpStatus: number, value: unknown): VideoSubmissionRejection | undefined {
  if (model !== 'MiniMax-H3' || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
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
