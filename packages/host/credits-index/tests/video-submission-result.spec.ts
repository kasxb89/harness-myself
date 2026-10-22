/** Exact settlement proofs never infer acceptance, funding or refunds from generic HTTP errors. */
import { describe, expect, it } from 'vitest'
import { h3SubmissionRejection } from '../src/video-submission-result.ts'

const capacity = { code: 'h3_account_capacity_exhausted', data: null, submission_state: 'not_submitted', retryable: false, resubmittable: true }
const refunded = { code: 'h3_upstream_auth_rejected', data: null, submission_state: 'failed', id: 'original-h3-task', task_id: 'original-h3-task',
  refund_confirmed: true, retryable: false, resubmittable: false }

describe('strict H3 submission settlement proofs', () => {
  it('recognizes admission rejection without inventing a task, and confirmed refund with its exact original id', () => {
    expect(h3SubmissionRejection('MiniMax-H3', 429, capacity)).toMatchObject({ code: 'H3_ACCOUNT_CAPACITY_EXHAUSTED', submissionState: 'not_submitted' })
    expect(h3SubmissionRejection('MiniMax-H3', 429, capacity)).not.toHaveProperty('taskId', expect.any(String))
    expect(h3SubmissionRejection('MiniMax-H3', 502, refunded)).toMatchObject({ code: 'H3_UPSTREAM_AUTH_REJECTED', submissionState: 'failed', taskId: 'original-h3-task' })
  })

  it.each([
    { code: 'busy' }, { submission_state: 'unknown' }, { data: undefined }, { data: {} }, { retryable: true },
    { retryable: undefined }, { resubmittable: false }, { resubmittable: undefined }, { id: 'unexpected-task' }, { task_id: 'unexpected-task' },
  ])('does not trust incomplete or conflicting capacity proof %j', (patch) => {
    expect(h3SubmissionRejection('MiniMax-H3', 429, { ...capacity, ...patch })).toBeUndefined()
  })

  it.each([
    { code: 'upstream_error' }, { submission_state: 'unknown' }, { data: undefined }, { data: {} },
    { refund_confirmed: false }, { refund_confirmed: undefined }, { refund_confirmed: 'true' }, { retryable: true },
    { retryable: undefined }, { resubmittable: true }, { resubmittable: undefined }, { id: undefined }, { task_id: undefined },
    { id: 'different-task' }, { id: 'sk-private', task_id: 'sk-private' }, { id: '../private', task_id: '../private' },
  ])('does not trust incomplete or conflicting refund proof %j', (patch) => {
    expect(h3SubmissionRejection('MiniMax-H3', 502, { ...refunded, ...patch })).toBeUndefined()
  })

  it.each([200, 202, 400, 401, 403, 408, 500, 503])('does not take a body-provided proof as HTTP %s settlement', (status) => {
    expect(h3SubmissionRejection('MiniMax-H3', status, capacity)).toBeUndefined()
    expect(h3SubmissionRejection('MiniMax-H3', status, refunded)).toBeUndefined()
  })

  it.each([undefined, 'model_5', 'minimax-h3'])('does not apply H3 settlement to model %s', (model) => {
    expect(h3SubmissionRejection(model, 429, capacity)).toBeUndefined()
    expect(h3SubmissionRejection(model, 502, refunded)).toBeUndefined()
  })
})
