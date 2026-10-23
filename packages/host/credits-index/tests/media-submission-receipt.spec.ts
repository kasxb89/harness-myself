/** Synthetic consumer adversaries; actual producer HTTP fixtures are bound separately. */
import { describe, expect, it } from 'vitest'
import {
  hasMediaSubmissionReceipt, mediaSubmissionTaskId, mediaSubmissionRejection, mediaSubmissionQueryRejection,
  hasMediaSubmissionUnknown, mediaSubmissionUnknownTaskId,
} from '../src/media-submission-receipt.ts'
import synthetic from './fixtures/media-submission-synthetic.json' with { type: 'json' }
import actual from './fixtures/media-submission-api-contract-v3.json' with { type: 'json' }

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
