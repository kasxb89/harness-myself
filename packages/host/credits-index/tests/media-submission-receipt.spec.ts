/** Synthetic consumer adversaries; actual producer HTTP fixtures are bound separately. */
import { describe, expect, it } from 'vitest'
import {
  hasMediaSubmissionReceipt, mediaSubmissionTaskId, mediaSubmissionRejection, mediaSubmissionQueryRejection,
  hasMediaSubmissionUnknown, mediaSubmissionUnknownTaskId,
  mediaSubmissionMessage,
} from '../src/media-submission-receipt.ts'
import synthetic from './fixtures/media-submission-synthetic.json' with { type: 'json' }
import actual from './fixtures/media-submission-api-contract-v3.json' with { type: 'json' }
import rejectionSynthetic from './fixtures/media-submission-rejected-synthetic.json' with { type: 'json' }
import rejectedActualPost from './fixtures/media-submission-rejected-create-api-handler-v1.json' with { type: 'json' }
import rejectedActualGet from './fixtures/media-submission-rejected-get-api-handler-v1.json' with { type: 'json' }

describe('platform media submission receipt validation', () => {
  it.each(actual)('reads actual producer $method $http_status $path without inventing task or financial facts', ({ method, http_status: httpStatus, response }) => {
    const kind = response.media_kind
    const model = response.model
    const id = response.task_id
    if (kind === 'image' || kind === 'video') {
      const proof = method === 'POST' ? mediaSubmissionRejection(model, kind, httpStatus, response)
        : typeof id === 'string' ? mediaSubmissionQueryRejection(model, kind, httpStatus, response, id) : undefined
      expect(proof !== undefined).toBe(hasMediaSubmissionReceipt(response))
      if (proof !== undefined) expect(proof).toMatchObject({ taskId: id, model, mediaKind: kind, billingState: 'not_charged' })
      const unknownId = mediaSubmissionUnknownTaskId(model, kind, httpStatus, response)
      expect(unknownId).toBe(method === 'POST' && httpStatus === 202 ? id : undefined)
    } else expect(hasMediaSubmissionReceipt(response)).toBe(false)
  })

  const unknown = actual.find(entry => entry.http_status === 202)
  if (unknown === undefined) throw new Error('Actual producer uncertainty envelope is required')
  it.each([
    { id: 'another-task' }, { task_id: 'another-task' }, { model: 'different-model' }, { media_kind: 'image' },
    { submission_state: 'not_submitted' }, { retryable: true }, { resubmittable: true }, { status: 'FAILURE' },
    { error: { code: 'generic_error' } }, { error: { code: 'media_submission_unknown', id: 'another-task' } },
    { recovery: { method: 'GET', path: 'https://untrusted.invalid/v1/tasks/original' } },
    { media_submission_receipt: null }, { submission_receipt: null }, { provider_terminal_confirmed: true },
  ])('does not bind a partial or contradictory actual uncertainty envelope %j', (patch) => {
    expect(mediaSubmissionUnknownTaskId(unknown.response.model, 'video', 202, { ...unknown.response, ...patch })).toBeUndefined()
  })
  it('keeps uncertainty separate from no-charge proofs and rejects forged success beside its code', () => {
    expect(hasMediaSubmissionUnknown(unknown.response)).toBe(true)
    expect(mediaSubmissionRejection(unknown.response.model, 'video', 202, unknown.response)).toBeUndefined()
    expect(mediaSubmissionUnknownTaskId(unknown.response.model, 'video', 200, unknown.response)).toBeUndefined()
  })

  for (const mediaKind of ['image', 'video'] as const) {
    const { body, query } = synthetic[mediaKind]
    const proof = body.media_submission_receipt
    it(`binds ${mediaKind} POST and canonical GET to the requested model and original platform task`, () => {
      expect(mediaSubmissionRejection(body.model, mediaKind, 429, body)).toMatchObject({
        taskId: body.id, model: body.model, mediaKind, billingState: 'not_charged', code: body.code,
      })
      expect(mediaSubmissionQueryRejection(body.model, mediaKind, 200, query, body.id))
        .toMatchObject({ taskId: body.id, code: 'MEDIA_SUBMISSION_NOT_SENT' })
      expect(mediaSubmissionTaskId(body.model, mediaKind, body)).toBe(body.id)
    })

    it.each(Object.keys(proof))(`requires every ${mediaKind} proof field %s`, (key) => {
      const incomplete = Object.fromEntries(Object.entries(proof).filter(([field]) => field !== key))
      expect(mediaSubmissionRejection(body.model, mediaKind, 429, { ...body, media_submission_receipt: incomplete })).toBeUndefined()
      expect(mediaSubmissionQueryRejection(body.model, mediaKind, 200,
        { ...query, media_submission_receipt: incomplete }, body.id)).toBeUndefined()
    })

    it.each([
      { schema_version: '1' }, { model: 'upstream-alias' }, { media_kind: 'audio' },
      { id: 'other-task' }, { task_id: 'other-task' }, { id: 'sk-private', task_id: 'sk-private' },
      { id: '../task', task_id: '../task' }, { submission_code: 'h3_submission_not_sent' },
      { submission_state: 'unknown' }, { billing_state: 'reserved' }, { refund_confirmed: true },
      { upstream_submitted: true }, { retryable: true }, { resubmittable: false },
      { recovery: { method: 'POST', path: '/v1/tasks/' + body.id } },
      { recovery: { method: 'GET', path: 'https://untrusted.invalid/v1/tasks/' + body.id } },
      { recovery: { method: 'GET', path: '/v1/tasks/another-task' } },
      { recovery: { method: 'GET', path: '/v1/tasks/' + body.id, token: 'private' } },
      { extra_authority: true },
    ])(`rejects incomplete or conflicting ${mediaKind} facts %j`, (patch) => {
      const malformed = { ...proof, ...patch }
      expect(mediaSubmissionRejection(body.model, mediaKind, 429, { ...body, media_submission_receipt: malformed })).toBeUndefined()
      expect(mediaSubmissionQueryRejection(body.model, mediaKind, 200,
        { ...query, media_submission_receipt: malformed }, body.id)).toBeUndefined()
    })

    it.each([
      { id: 'other-task' }, { task_id: 1 }, { model: 'upstream-alias' }, { media_kind: 'audio' },
      { data: { task_id: 'other-task' } }, { error: { id: 'other-task' } },
      { submission_state: 'unknown' }, { billing_state: 'reserved' }, { upstream_submitted: true },
      { retryable: true }, { resubmittable: false }, { refund_confirmed: true },
      { provider_terminal_confirmed: true }, { submission_receipt: {} },
      { status: 'UNKNOWN' }, { status: 'SUCCESS' },
    ])(`rejects contradictory outer ${mediaKind} evidence %j`, (patch) => {
      expect(mediaSubmissionRejection(body.model, mediaKind, 429, { ...body, ...patch })).toBeUndefined()
      expect(mediaSubmissionQueryRejection(body.model, mediaKind, 200, { ...query, ...patch }, body.id)).toBeUndefined()
    })

    it(`distinguishes confirmed ${mediaKind} refunds from missing or unconfirmed refunds`, () => {
      const refunded = { ...proof, billing_state: 'refunded', refund_confirmed: true }
      expect(mediaSubmissionRejection(body.model, mediaKind, 403, {
        ...body, code: 'insufficient_user_quota', media_submission_receipt: refunded,
      })).toMatchObject({ billingState: 'refunded', code: 'insufficient_user_quota' })
      for (const refund_confirmed of [undefined, false, 'true']) {
        expect(mediaSubmissionQueryRejection(body.model, mediaKind, 200,
          { ...query, media_submission_receipt: { ...refunded, refund_confirmed } }, body.id)).toBeUndefined()
      }
    })

    it.each([200, 201, 202, 302, 403, 408, 500, 502])(`does not settle ${mediaKind} capacity through HTTP %s`, (httpStatus) => {
      expect(mediaSubmissionRejection(body.model, mediaKind, httpStatus, body)).toBeUndefined()
    })

    it.each([202, 401, 403, 404, 429, 500])(`does not trust a ${mediaKind} GET proof through HTTP %s`, (httpStatus) => {
      expect(mediaSubmissionQueryRejection(body.model, mediaKind, httpStatus, query, body.id)).toBeUndefined()
    })

    it(`requires exact ${mediaKind} model, category, query ID and root proof placement`, () => {
      expect(mediaSubmissionRejection('another-model', mediaKind, 429, body)).toBeUndefined()
      expect(mediaSubmissionRejection(body.model, mediaKind === 'image' ? 'video' : 'image', 429, body)).toBeUndefined()
      expect(mediaSubmissionQueryRejection(body.model, mediaKind, 200, query, 'another-task')).toBeUndefined()
      for (const value of [{ ...body, media_submission_receipt: null },
        { ...body, data: { media_submission_receipt: proof } },
        { data: { ...body } }, { error: { media_submission_receipt: proof } }]) {
        expect(hasMediaSubmissionReceipt(value)).toBe(true)
        expect(mediaSubmissionRejection(body.model, mediaKind, 429, value)).toBeUndefined()
        expect(mediaSubmissionQueryRejection(body.model, mediaKind, 200, value, body.id)).toBeUndefined()
      }
      expect(mediaSubmissionRejection(body.model, mediaKind, 429, { ...body, code: undefined, error: { code: body.code } })).toBeUndefined()
      expect(mediaSubmissionRejection(body.model, mediaKind, 429, { ...body, code: 'HTTP_429' })).toBeUndefined()
    })
  }
})

describe('actual free mocked-upstream rejected handler captures', () => {
  for (const [method, capture] of [['POST', rejectedActualPost], ['GET', rejectedActualGet]] as const) {
    const { body, http_status: httpStatus } = capture
    const receipt = body.media_submission_receipt
    const decode = (value: unknown, status = httpStatus) => method === 'POST'
      ? mediaSubmissionRejection(body.model, 'video', status, value)
      : mediaSubmissionQueryRejection(body.model, 'video', status, value, body.task_id)

    it(`accepts the actual ${method} handler body without changing the task or financial facts`, () => {
      expect(decode(body)).toEqual({ taskId: body.task_id, model: body.model, mediaKind: 'video',
        billingState: 'refunded', upstreamSubmitted: true, code: 'media_submission_rejected' })
      expect(mediaSubmissionTaskId(body.model, 'video', body)).toBe(body.task_id)
      expect(hasMediaSubmissionReceipt(body)).toBe(true)
      expect(body.task_id).toBe(rejectedActualPost.body.task_id)
      expect(rejectedActualGet.body.task_id).toBe(body.task_id)
    })

    it.each(Object.keys(receipt))(`rejects actual ${method} proof missing %s`, (key) => {
      const partial = Object.fromEntries(Object.entries(receipt).filter(([field]) => field !== key))
      expect(decode({ ...body, media_submission_receipt: partial })).toBeUndefined()
    })

    it.each([
      { schema_version: '1' }, { model: 'other-model' }, { media_kind: 'image' },
      { task_id: 'different-original' }, { id: 'different-original' },
      { submission_code: 'media_submission_not_sent' }, { submission_state: 'unknown' },
      { billing_state: 'not_charged' }, { billing_state: 'reserved' },
      { refund_confirmed: false }, { upstream_submitted: false }, { retryable: true }, { resubmittable: false },
      { rejection_reason: 'generic_error' }, { provider_response_received: false },
      { recovery: { method: 'POST', path: `/v1/tasks/${body.task_id}` } },
      { recovery: { method: 'GET', path: `/v1/tasks/${body.task_id}`, extra: true } },
      { recovery: { method: 'GET', path: '/v1/tasks/other' } }, { extra_authority: true },
    ])(`rejects actual ${method} mutated proof %j`, (patch) => {
      expect(decode({ ...body, media_submission_receipt: { ...receipt, ...patch } })).toBeUndefined()
    })

    it.each([
      { id: 'other-task' }, { task_id: 'other-task' }, { model: 'other-model' }, { media_kind: 'image' },
      { submission_state: 'unknown' }, { billing_state: 'reserved' }, { refund_confirmed: false },
      { upstream_submitted: false }, { retryable: true }, { resubmittable: false },
      { provider_response_received: false }, { rejection_reason: 'generic_error' },
      { code: 'media_submission_unknown' }, { status: 'UNKNOWN' }, { status: 'SUCCESS' },
      { provider_terminal_confirmed: true }, { submission_receipt: {} },
      { error: { code: 'media_submission_unknown' } }, { data: { task_id: 'other-task' } },
      { recovery: { method: 'GET', path: '/v1/tasks/other' } },
    ])(`rejects actual ${method} outer contradiction %j`, (patch) => {
      expect(decode({ ...body, ...patch })).toBeUndefined()
    })

    it.each([202, 403, 404, 408, 429, 500, 503])(`does not confirm actual ${method} rejection on HTTP %s`, (status) => {
      expect(decode(body, status)).toBeUndefined()
    })

    it(`blocks fallback when the actual ${method} receipt is missing or misplaced`, () => {
      const { media_submission_receipt: removed, ...withoutProof } = body
      expect(removed).toBe(receipt)
      const declared = { ...withoutProof, code: 'media_submission_rejected' }
      expect(hasMediaSubmissionReceipt(declared)).toBe(true)
      expect(decode(declared)).toBeUndefined()
      for (const value of [{ ...body, media_submission_receipt: null },
        { ...body, data: { media_submission_receipt: receipt } }, { data: body }, { error: body }]) {
        expect(hasMediaSubmissionReceipt(value)).toBe(true)
        expect(decode(value)).toBeUndefined()
      }
    })
  }
})

describe('synthetic confirmed upstream-rejection consumer validation', () => {
  for (const mediaKind of ['image', 'video'] as const) {
    const { body, query } = rejectionSynthetic.cases[mediaKind]
    const receipt = body.media_submission_receipt
    const post = (value: unknown, httpStatus = 400) => mediaSubmissionRejection(body.model, mediaKind, httpStatus, value)
    const get = (value: unknown, httpStatus = 200, taskId = body.id) =>
      mediaSubmissionQueryRejection(body.model, mediaKind, httpStatus, value, taskId)

    it(`keeps the original ${mediaKind} task and distinguishes sent-but-rejected from never-sent`, () => {
      const expected = { taskId: body.id, model: body.model, mediaKind, billingState: 'refunded',
        upstreamSubmitted: true, code: 'media_submission_rejected' }
      expect(post(body)).toEqual(expected)
      expect(get(query)).toEqual(expected)
      expect(mediaSubmissionTaskId(body.model, mediaKind, body)).toBe(body.id)
      const proof = post(body)
      if (proof === undefined) throw new Error('Expected a fully validated synthetic rejection')
      expect(mediaSubmissionMessage(proof)).toContain('已发送，但上游已明确拒绝受理，退款已确认')
      expect(mediaSubmissionMessage(proof)).not.toContain('未发送至上游')
      expect(hasMediaSubmissionUnknown(body)).toBe(false)
    })

    it.each(Object.keys(receipt))(`requires every ${mediaKind} upstream-rejection proof field %s`, (key) => {
      const partial = Object.fromEntries(Object.entries(receipt).filter(([field]) => field !== key))
      expect(post({ ...body, media_submission_receipt: partial })).toBeUndefined()
      expect(get({ ...query, media_submission_receipt: partial })).toBeUndefined()
    })

    it.each(['code', 'id', 'task_id', 'model', 'media_kind', 'submission_state', 'retryable', 'resubmittable'])(
      `requires exact outer ${mediaKind} POST field %s`, (key) => {
        expect(post(Object.fromEntries(Object.entries(body).filter(([field]) => field !== key)))).toBeUndefined()
      },
    )

    it.each([
      { schema_version: '1' }, { schema_version: 2 }, { model: 'other-model' }, { media_kind: 'audio' },
      { id: 'other-task' }, { task_id: 'other-task' }, { id: 'sk-secret', task_id: 'sk-secret' },
      { id: '../original', task_id: '../original' }, { submission_code: 'media_submission_not_sent' },
      { submission_code: 'media_submission_unknown' }, { submission_state: 'unknown' }, { submission_state: 'accepted' },
      { billing_state: 'not_charged' }, { billing_state: 'reserved' }, { refund_confirmed: false }, { refund_confirmed: 'true' },
      { upstream_submitted: false }, { upstream_submitted: 'true' }, { retryable: true }, { resubmittable: false },
      { rejection_reason: 'generic_error' }, { rejection_reason: 'model_not_found' },
      { provider_response_received: false }, { provider_response_received: 'true' },
      { recovery: { method: 'POST', path: `/v1/tasks/${body.id}` } },
      { recovery: { method: 'GET', path: '/v1/tasks/another-task' } },
      { recovery: { method: 'GET', path: `https://untrusted.invalid/v1/tasks/${body.id}` } },
      { recovery: { method: 'GET', path: `/v1/tasks/${body.id}`, token: 'private' } },
      { extra_authority: true },
    ])(`rejects contradictory ${mediaKind} upstream-rejection proof %j`, (patch) => {
      const malformed = { ...receipt, ...patch }
      expect(post({ ...body, media_submission_receipt: malformed })).toBeUndefined()
      expect(get({ ...query, media_submission_receipt: malformed })).toBeUndefined()
    })

    it.each([
      { id: 'other-task' }, { task_id: 'other-task' }, { model: 'other-model' }, { media_kind: 'audio' },
      { submission_code: 'media_submission_not_sent' }, { submission_state: 'unknown' },
      { billing_state: 'reserved' }, { refund_confirmed: false }, { upstream_submitted: false },
      { retryable: true }, { resubmittable: false }, { rejection_reason: 'generic_error' },
      { provider_response_received: false }, { status: 'UNKNOWN' }, { task_status: 'SUCCESS' },
      { provider_terminal_confirmed: true }, { submission_receipt: {} }, { error: { code: 'media_submission_unknown' } },
      { error: { task_id: 'other-task' } },
      { recovery: { method: 'GET', path: '/v1/tasks/other-task' } },
    ])(`rejects contradictory outer ${mediaKind} upstream-rejection fact %j`, (patch) => {
      expect(post({ ...body, ...patch })).toBeUndefined()
      expect(get({ ...query, ...patch })).toBeUndefined()
    })

    it.each([200, 201, 202, 302, 400.5, 401, 403, 404, 408, 409, 429, 500, 502, 503])(
      `never confirms ${mediaKind} rejected admission on POST HTTP %s`, (httpStatus) => {
        expect(post(body, httpStatus)).toBeUndefined()
      },
    )

    it.each([201, 202, 400, 401, 403, 404, 408, 429, 500, 503])(
      `never confirms ${mediaKind} rejected admission on GET HTTP %s`, (httpStatus) => {
        expect(get(query, httpStatus)).toBeUndefined()
      },
    )

    it(`binds ${mediaKind} query identity and exact FAILURE without trusting a generic status`, () => {
      expect(get(query, 200, 'other-task')).toBeUndefined()
      expect(mediaSubmissionQueryRejection('other-model', mediaKind, 200, query, body.id)).toBeUndefined()
      expect(mediaSubmissionQueryRejection(body.model, mediaKind === 'image' ? 'video' : 'image', 200, query, body.id)).toBeUndefined()
      for (const status of [undefined, 'failed', 'UNKNOWN', 'SUCCESS', 'IN_PROGRESS', 0]) {
        expect(get({ ...query, data: { ...query.data, status } })).toBeUndefined()
      }
      for (const patch of [{ model: 'other' }, { task_id: 'other' }, { media_kind: 'audio' }, { retryable: true }]) {
        expect(get({ ...query, data: { ...query.data, ...patch } })).toBeUndefined()
      }
    })

    it(`treats declared ${mediaKind} rejection without a valid root proof as unresolved`, () => {
      for (const value of [{ ...body, media_submission_receipt: undefined },
        { ...body, media_submission_receipt: null }, { data: body }, { error: body },
        { ...body, data: { media_submission_receipt: receipt } },
        { code: 'media_submission_rejected' }, { error: { code: 'media_submission_rejected' } },
        { submission_code: 'media_submission_rejected', status: 'FAILURE' }]) {
        expect(hasMediaSubmissionReceipt(value)).toBe(true)
        expect(post(value)).toBeUndefined()
        expect(get(value)).toBeUndefined()
      }
      for (const httpStatus of [404, 429, 503]) {
        expect(post({ code: 'model_not_found', status: 'FAILURE' }, httpStatus)).toBeUndefined()
        expect(get({ code: 'model_not_found', status: 'FAILURE' }, httpStatus)).toBeUndefined()
      }
    })

    it(`keeps coherent ${mediaKind} recovery identity without claiming a rejected refund is confirmed`, () => {
      const unconfirmed = { ...body, media_submission_receipt: { ...receipt, refund_confirmed: false } }
      expect(post(unconfirmed)).toBeUndefined()
      expect(mediaSubmissionTaskId(body.model, mediaKind, unconfirmed)).toBe(body.id)
      expect(post({ ...body, code: 'media_account_capacity_exhausted' })).toBeUndefined()
      expect(get({ ...query, code: 'media_submission_unknown' })).toBeUndefined()
    })
  }
})
