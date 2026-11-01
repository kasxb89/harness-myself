/** Questionnaire authority and bounded public fields never derive from local first-login history. */
import { describe, expect, it } from 'vitest'
import { parseOnboardingSurvey, parseSurveyRequest, readOnboardingSurvey, SURVEY_OPTION_IDS } from '../src/onboarding-survey.ts'
import pending from './fixtures/onboarding-survey-api/pending.json' with { type: 'json' }
import deferred from './fixtures/onboarding-survey-api/deferred.json' with { type: 'json' }
import submitted from './fixtures/onboarding-survey-api/submitted.json' with { type: 'json' }
import replay from './fixtures/onboarding-survey-api/same-answer-replay.json' with { type: 'json' }
import ineligible from './fixtures/onboarding-survey-api/not-eligible.json' with { type: 'json' }

function surveyFixture(status: 'not_eligible' | 'pending' | 'deferred' | 'submitted' = 'pending') {
  return { schema_version: 1, survey_id: 'product-use-v1', eligible: status !== 'not_eligible', status,
    options: SURVEY_OPTION_IDS.map(id => ({ id, label: `中文${id}`, label_en: `English ${id}` })),
    max_selections: 9, max_notes_length: 1000, selected_option_ids: status === 'submitted' ? ['coding'] : [],
    notes: status === 'submitted' ? '办公与编程' : '', registered_at: status === 'not_eligible' ? 0 : 100,
    submitted_at: status === 'submitted' ? 200 : 0, deferred_at: status === 'deferred' ? 150 : 0 }
}
const signal = (): AbortSignal => new AbortController().signal
const input = { schema_version: 1, survey_id: 'product-use-v1', selected_option_ids: ['video_creation', 'coding'], notes: '备注',
  expected_account_id: '7', expected_account_owner: 'a'.repeat(64) }

describe('onboarding survey contract', () => {
  it.each([pending, deferred, submitted, replay, ineligible])('retains the actual API response state $data.status', async (fixture) => {
    const result = await readOnboardingSurvey(async () => Response.json(fixture), signal())
    expect(result).toEqual({ ok: true, payload: fixture.data })
    expect(JSON.stringify(result)).not.toMatch(/"(?:user_id|phone|token|cookie|otp)":/u)
  })
  it.each(['not_eligible', 'pending', 'deferred', 'submitted'] as const)('retains authoritative %s state and drops unrelated fields', (status) => {
    const source = surveyFixture(status)
    expect(parseOnboardingSurvey({ ...source, token: 'must not leave Host', user_id: 7,
      options: source.options.map(option => ({ ...option, private_debug: 'secret' })) })).toEqual(source)
  })
  it.each([
    { eligible: false }, { status: 'unknown' }, { status: { toString: 0 } }, { registered_at: 0 },
    { submitted_at: 1 }, { notes: 'unexpected draft' },
    { selected_option_ids: ['coding'] }, { options: [] }, { max_notes_length: 999 }, { schema_version: 2 },
    { options: Array(9).fill({ id: 'coding', label: '中文', label_en: 'English' }) },
  ])('rejects incomplete or conflicting authority %j', (changes) => {
    expect(parseOnboardingSurvey({ ...surveyFixture(), ...changes })).toBeUndefined()
  })
  it('retains submitted notes up to one thousand Unicode codepoints', () => {
    expect(parseOnboardingSurvey({ ...surveyFixture('submitted'), notes: '🌱'.repeat(1000) })?.notes).toHaveLength(2000)
    expect(parseOnboardingSurvey({ ...surveyFixture('submitted'), notes: '🌱'.repeat(1001) })).toBeUndefined()
  })
  it('normalizes answer order and strips owner guards without admitting target account fields', () => {
    expect(parseSurveyRequest(input, false)).toEqual({ schema_version: 1, survey_id: 'product-use-v1',
      selected_option_ids: ['coding', 'video_creation'], notes: '备注' })
    expect(parseSurveyRequest({ ...input, user_id: 'another-user' }, false)).toBeUndefined()
    expect(parseSurveyRequest({ schema_version: 1, survey_id: 'product-use-v1',
      expected_account_id: '7', expected_account_owner: 'a'.repeat(64) }, true)).toEqual({ schema_version: 1, survey_id: 'product-use-v1' })
    expect(parseSurveyRequest(input, true)).toBeUndefined()
  })
  it.each([[], ['coding', 'coding'], ['unknown']].map(selected_option_ids => ({ selected_option_ids })))(
    'rejects empty, duplicate and unknown selections %j', ({ selected_option_ids }) => {
      expect(parseSurveyRequest({ ...input, selected_option_ids }, false)).toBeUndefined()
    })
  it('counts request notes as Unicode codepoints and permits optional notes', () => {
    expect(parseSurveyRequest({ ...input, notes: '🌱'.repeat(1000) }, false)).toBeDefined()
    expect(parseSurveyRequest({ ...input, notes: '🌱'.repeat(1001) }, false)).toBeUndefined()
    const { notes: _omitted, ...withoutNotes } = input
    expect(parseSurveyRequest(withoutNotes, false)).not.toHaveProperty('notes')
  })
  it('keeps old APIs unsupported without constructing eligibility', async () => {
    expect(await readOnboardingSurvey(async () => new Response(null, { status: 404 }), signal()))
      .toEqual({ ok: false, code: 'SURVEY_UNSUPPORTED', httpStatus: 404 })
    expect(await readOnboardingSurvey(async () => Response.json({ success: true, data: {} }), signal()))
      .toMatchObject({ ok: false, code: 'SURVEY_INVALID_RESPONSE' })
  })
  it.each([[401, 'SURVEY_AUTH_REQUIRED'], [429, 'SURVEY_RATE_LIMITED'], [408, 'SURVEY_TIMEOUT'],
    [503, 'SURVEY_UNAVAILABLE'], [504, 'SURVEY_TIMEOUT']] as const)('preserves HTTP %i despite an invalid error body', async (status, code) => {
    expect(await readOnboardingSurvey(async () => new Response('private upstream diagnostic', { status,
      headers: { 'retry-after': '7' } }), signal())).toMatchObject({ ok: false, code, httpStatus: status, retryAfterSeconds: 7 })
  })
  it.each([[400, 'SURVEY_INVALID_REQUEST'], [403, 'SURVEY_NOT_ELIGIBLE'], [409, 'SURVEY_ALREADY_SUBMITTED']] as const)(
    'retains declared business failure %i %s without its raw message', async (status, code) => {
      const result = await readOnboardingSurvey(async () => Response.json({ success: false, code, message: 'private account detail' }, { status }), signal())
      expect(result).toMatchObject({ ok: false, code, httpStatus: status })
      expect(JSON.stringify(result)).not.toContain('private')
    })
  it('bounds responses and rejects malformed JSON without exposing it', async () => {
    expect(await readOnboardingSurvey(async () => new Response('x'.repeat(32 * 1024 + 1)), signal()))
      .toMatchObject({ code: 'SURVEY_INVALID_RESPONSE' })
    expect(await readOnboardingSurvey(async () => new Response('{private'), signal())).toMatchObject({ code: 'SURVEY_INVALID_RESPONSE' })
  })
  it('distinguishes network interruption from a deadline', async () => {
    expect(await readOnboardingSurvey(async () => { throw new TypeError('network disconnected') }, signal()))
      .toMatchObject({ code: 'SURVEY_NETWORK_ERROR', failure: { reason: 'network' } })
    const controller = new AbortController()
    controller.abort(new DOMException('test deadline', 'TimeoutError'))
    expect(await readOnboardingSurvey(async () => { throw new Error('must not be called') }, controller.signal))
      .toMatchObject({ code: 'SURVEY_TIMEOUT', failure: { reason: 'timeout' } })
  })
})
