/** Exact settlement proofs never infer acceptance, funding or refunds from generic HTTP errors. */
import { describe, expect, it } from 'vitest'
import { h3SubmissionRejection, h3SubmissionQueryRejection, h3ProviderTerminalRejection } from '../src/video-submission-result.ts'
import notSentContract from './fixtures/h3-not-sent-contract.json' with { type: 'json' }
import terminalContract from './fixtures/h3-terminal-api-contract.json' with { type: 'json' }

const capacity = { code: 'h3_account_capacity_exhausted', data: null, submission_state: 'not_submitted', retryable: false, resubmittable: true }
const refunded = { code: 'h3_upstream_auth_rejected', data: null, submission_state: 'failed', id: 'original-h3-task', task_id: 'original-h3-task',
  refund_confirmed: true, retryable: false, resubmittable: false }
const terminal = terminalContract.fixtures.find(entry => entry.name === 'canonical_get_confirmed_provider_failure')
if (terminal === undefined || typeof terminal.body.task_id !== 'string') throw new Error('Expected the actual provider-terminal fixture')
const terminalTaskId = terminal.body.task_id

describe('strict H3 submission settlement proofs', () => {
  it('adds a safe recharge reason to an original never-sent GET proof without replacing its settlement facts', () => {
    const taskId = notSentContract.receipt.id
    const result = h3SubmissionQueryRejection('MiniMax-H3', 200, { task_id: taskId, status: 'FAILURE',
      submission_receipt: notSentContract.receipt, failure_code: 'insufficient_user_quota', failure_reason: 'private detail' }, taskId)
    expect(result).toMatchObject({ code: 'INSUFFICIENT_BALANCE', taskId, submissionState: 'not_submitted' })
    expect(result?.message).toContain('余额不足，请充值')
    expect(result?.message).toContain('未发送至上游且未扣费')
    expect(result?.message).not.toContain('private')
  })

  it('recognizes the actual provider terminal without claiming a refund or permitting another submission', () => {
    expect(h3ProviderTerminalRejection('MiniMax-H3', terminal.http_status, terminal.body, terminalTaskId))
      .toMatchObject({ code: 'PROVIDER_TASK_FAILED', submissionState: 'failed', taskId: terminalTaskId })
    expect(h3SubmissionQueryRejection('MiniMax-H3', terminal.http_status, terminal.body, terminalTaskId)).toBeUndefined()
  })

  it.each([
    { provider_terminal_confirmed: undefined }, { provider_terminal_confirmed: false }, { provider_terminal_confirmed: 'true' },
    { task_id: undefined }, { task_id: 'another-task' }, { id: 'another-task' }, { id: 1 },
    { status: 'UNKNOWN' }, { status: 'SUCCESS' }, { task_status: 'running' }, { resubmittable: true }, { object: 'response' },
    { submission_receipt: null }, { data: { provider_terminal_confirmed: true } }, { data: { task_id: 'another-task' } },
  ])('does not terminalize a partial or conflicting provider marker %j', (patch) => {
    expect(h3ProviderTerminalRejection('MiniMax-H3', 200, { ...terminal.body, ...patch }, terminalTaskId)).toBeUndefined()
  })

  it.each(['model_5', 'minimax-h3', undefined])('does not apply provider confirmation to model %s', (model) => {
    expect(h3ProviderTerminalRejection(model, 200, terminal.body, terminalTaskId)).toBeUndefined()
  })

  it.each([202, 401, 403, 404, 429, 500])('does not trust a provider marker through HTTP %s', (httpStatus) => {
    expect(h3ProviderTerminalRejection('MiniMax-H3', httpStatus, terminal.body, terminalTaskId)).toBeUndefined()
  })

  it('keeps conflicting financial and provider-terminal proofs unresolved', () => {
    const value = { ...terminal.body, task_id: notSentContract.receipt.id, submission_receipt: notSentContract.receipt }
    expect(h3ProviderTerminalRejection('MiniMax-H3', 200, value, notSentContract.receipt.id)).toBeUndefined()
    expect(h3SubmissionQueryRejection('MiniMax-H3', 200, value, notSentContract.receipt.id)).toBeUndefined()
  })

  it.each([notSentContract.notCharged, notSentContract.refunded])('retains business code and original platform id for an unsent HTTP $httpStatus attempt', ({ httpStatus, body }) => {
    const rejection = h3SubmissionRejection('MiniMax-H3', httpStatus, body)
    expect(rejection).toMatchObject({ code: body.code === 'insufficient_user_quota' ? 'INSUFFICIENT_BALANCE' : body.code,
      submissionState: 'not_submitted', taskId: body.id })
    if (body.code === 'insufficient_user_quota') expect(rejection?.message).toContain('余额不足，请充值')
    expect(rejection?.message).not.toContain('private')
  })

  it.each(['submission_code', 'submission_state', 'billing_state', 'upstream_submitted', 'retryable', 'resubmittable', 'id', 'task_id'])('requires the complete unsent proof field %s', (key) => {
    const body = Object.fromEntries(Object.entries(notSentContract.notCharged.body).filter(([field]) => field !== key))
    expect(h3SubmissionRejection('MiniMax-H3', 403, body)).toBeUndefined()
    expect(h3SubmissionQueryRejection('MiniMax-H3', 200, { submission_receipt: body }, 'h3-unsent-original')).toBeUndefined()
  })

  it.each([
    { submission_code: 'not_sent' }, { submission_state: 'unknown' }, { billing_state: 'unknown' },
    { upstream_submitted: true }, { upstream_submitted: 'false' }, { retryable: true }, { resubmittable: false },
    { billing_state: 'refunded' }, { billing_state: 'refunded', refund_confirmed: false },
    { refund_confirmed: true }, { id: 'another-task' }, { id: 'sk-private', task_id: 'sk-private' },
    { id: '../task', task_id: '../task' }, { code: 'private diagnostic with spaces' }, { data: { task_id: 'another-task' } },
    { error: { code: 'conflicting_code' } },
  ])('does not settle an incomplete or conflicting unsent POST proof %j', (patch) => {
    expect(h3SubmissionRejection('MiniMax-H3', 403, { ...notSentContract.notCharged.body, ...patch })).toBeUndefined()
  })

  it.each([200, 201, 202, 302])('does not accept an unsent POST proof over HTTP %s', (status) => {
    expect(h3SubmissionRejection('MiniMax-H3', status, notSentContract.notCharged.body)).toBeUndefined()
  })

  it('accepts original-id native and generic GET proofs without following receipt-supplied recovery paths', () => {
    const receipt = { ...notSentContract.receipt, recovery: { method: 'POST', path: 'https://untrusted.invalid/generate' } }
    for (const body of [{ id: receipt.id, status: 'UNKNOWN', submission_receipt: receipt },
      { data: { task_id: receipt.id, status: 'FAILURE', submission_receipt: receipt } }]) {
      expect(h3SubmissionQueryRejection('MiniMax-H3', 200, body, receipt.id))
        .toMatchObject({ code: 'H3_SUBMISSION_NOT_SENT', taskId: receipt.id, submissionState: 'not_submitted' })
    }
  })

  it.each([
    { id: 'another-task' }, { task_id: 'another-task' },
    { data: { id: 'another-task' } }, { data: { submission_receipt: notSentContract.receipt } },
    { submission_receipt: { ...notSentContract.receipt, id: 'another-task', task_id: 'another-task' } },
    { submission_receipt: { ...notSentContract.receipt, billing_state: 'refunded', refund_confirmed: false } },
  ])('keeps conflicting original-task GET evidence unresolved: %j', (patch) => {
    expect(h3SubmissionQueryRejection('MiniMax-H3', 200,
      { id: 'h3-unsent-original', submission_receipt: notSentContract.receipt, ...patch }, 'h3-unsent-original')).toBeUndefined()
  })

  it.each([401, 403, 404, 429, 500, 502])('never settles an original-task GET through HTTP %s', (status) => {
    expect(h3SubmissionQueryRejection('MiniMax-H3', status,
      { submission_receipt: notSentContract.receipt }, 'h3-unsent-original')).toBeUndefined()
  })

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
