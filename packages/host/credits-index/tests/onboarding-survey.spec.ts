/** Questionnaire authority and bounded public fields never derive from local first-login history. */
import { describe, expect, it } from 'vitest'
import { LEGACY_SURVEY_OPTION_IDS, ONBOARDING_SURVEY_RESPONSE_LIMIT,
  parseOnboardingSurvey, parseSurveyRequest, readOnboardingSurvey } from '../src/onboarding-survey.ts'
import pending from './fixtures/onboarding-survey-api/pending.json' with { type: 'json' }
import deferred from './fixtures/onboarding-survey-api/deferred.json' with { type: 'json' }
import submitted from './fixtures/onboarding-survey-api/submitted.json' with { type: 'json' }
import replay from './fixtures/onboarding-survey-api/same-answer-replay.json' with { type: 'json' }
import ineligible from './fixtures/onboarding-survey-api/not-eligible.json' with { type: 'json' }
import configuredPending from './fixtures/onboarding-survey-api-v2/pending.json' with { type: 'json' }
import configuredDeferred from './fixtures/onboarding-survey-api-v2/deferred.json' with { type: 'json' }
import configuredSubmitted from './fixtures/onboarding-survey-api-v2/submitted.json' with { type: 'json' }
import configuredIneligible from './fixtures/onboarding-survey-api-v2/not-eligible.json' with { type: 'json' }
import changedPending from './fixtures/onboarding-survey-api-v2/config-changed-pending.json' with { type: 'json' }
import changedSubmitted from './fixtures/onboarding-survey-api-v2/config-changed-submitted.json' with { type: 'json' }
import legacySubmitted from './fixtures/onboarding-survey-api-v2/legacy-submitted.json' with { type: 'json' }
import staleConfiguration from './fixtures/onboarding-survey-api-v2/stale-config.json' with { type: 'json' }

function surveyFixture(status: 'not_eligible' | 'pending' | 'deferred' | 'submitted' = 'pending') {
  return { schema_version: 1, survey_id: 'product-use-v1', eligible: status !== 'not_eligible', status,
    options: LEGACY_SURVEY_OPTION_IDS.map(id => ({ id, label: `中文${id}`, label_en: `English ${id}` })),
    max_selections: 9, max_notes_length: 1000, selected_option_ids: status === 'submitted' ? ['coding'] : [],
    notes: status === 'submitted' ? '办公与编程' : '', registered_at: status === 'not_eligible' ? 0 : 100,
    submitted_at: status === 'submitted' ? 200 : 0, deferred_at: status === 'deferred' ? 150 : 0 }
}
function configuredFixture(count = 3, status: 'not_eligible' | 'pending' | 'deferred' | 'submitted' = 'pending') {
  return { ...surveyFixture(status), schema_version: 2, config_revision: 'b'.repeat(64), max_selections: count,
    options: Array.from({ length: count }, (_unused, index) => ({ id: `scenario_${String(count - index)}`,
      label: `自定义场景${String(index + 1)}`, label_en: `Configured scenario ${String(index + 1)}` })),
    selected_option_ids: status === 'submitted' ? [`scenario_${String(count)}`] : [] }
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
  it.each([configuredPending, configuredDeferred, configuredSubmitted, configuredIneligible,
    changedPending, changedSubmitted, legacySubmitted])('retains the actual configured API response state $data.status', async (fixture) => {
    expect(await readOnboardingSurvey(async () => Response.json(fixture), signal())).toEqual({ ok: true, payload: fixture.data })
  })
  it('projects the actual changed-configuration rejection without forwarding its data as a submitted answer', async () => {
    const result = await readOnboardingSurvey(async () => Response.json(staleConfiguration, { status: 409 }), signal())
    expect(result).toMatchObject({ ok: false, code: 'SURVEY_CONFIG_CHANGED', httpStatus: 409 })
    expect(result).not.toHaveProperty('payload')
    expect(result).not.toHaveProperty('data')
    expect(result).not.toHaveProperty('message')
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
  it.each(['not_eligible', 'pending', 'deferred', 'submitted'] as const)(
    'retains configured %s choices, their server order and the submitted revision', (status) => {
      const source = configuredFixture(12, status)
      expect(parseOnboardingSurvey({ ...source, private_key: 'secret',
        options: source.options.map(option => ({ ...option, enabled: true, secret: 'hidden' })) })).toEqual(source)
    })
  it('accepts one through sixty-four configured choices without a fixed catalog or local sort', () => {
    expect(parseOnboardingSurvey(configuredFixture(1))).toEqual(configuredFixture(1))
    expect(parseOnboardingSurvey(configuredFixture(64))).toEqual(configuredFixture(64))
    expect(parseOnboardingSurvey(configuredFixture(65))).toBeUndefined()
    expect(parseOnboardingSurvey(configuredFixture(0))).toBeUndefined()
  })
  it('bounds configured IDs, bilingual Unicode labels and the opaque revision', () => {
    const source = configuredFixture(1)
    const longest = { id: 'a'.repeat(48), label: '🌱'.repeat(80), label_en: '🌱'.repeat(160) }
    expect(parseOnboardingSurvey({ ...source, options: [longest] })?.options).toEqual([longest])
    for (const option of [{ ...longest, id: 'a'.repeat(49) }, { ...longest, id: 'Uppercase' },
      { ...longest, id: '../file' }, { ...longest, id: '_first' }, { ...longest, label: '' },
      { ...longest, label: '🌱'.repeat(81) }, { ...longest, label_en: '🌱'.repeat(161) },
      { ...longest, label: 'line\nfeed' }, { ...longest, label_en: 'C1\u0085' }]) {
      expect(parseOnboardingSurvey({ ...source, options: [option] })).toBeUndefined()
    }
    for (const config_revision of [undefined, '', 'a'.repeat(63), 'A'.repeat(64), {}]) {
      expect(parseOnboardingSurvey({ ...source, config_revision })).toBeUndefined()
    }
  })
  it('rejects duplicate configured choices, conflicting limits and selections absent from the submitted snapshot', () => {
    const source = configuredFixture()
    expect(parseOnboardingSurvey({ ...source, options: Array(3).fill(source.options[0]) })).toBeUndefined()
    expect(parseOnboardingSurvey({ ...source, max_selections: 2 })).toBeUndefined()
    expect(parseOnboardingSurvey({ ...configuredFixture(3, 'submitted'), selected_option_ids: ['removed_choice'] })).toBeUndefined()
    expect(parseOnboardingSurvey({ ...configuredFixture(3, 'submitted'), selected_option_ids: ['scenario_3', 'scenario_3'] })).toBeUndefined()
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
  it('forwards explicit configured IDs in their submitted order with the viewed revision', () => {
    const request = { ...input, schema_version: 2, config_revision: 'b'.repeat(64),
      selected_option_ids: ['custom_video_ad', 'finance_reconciliation'], notes: '  备注\r\n第二行  ' }
    expect(parseSurveyRequest(request, false)).toEqual({ schema_version: 2, survey_id: 'product-use-v1',
      config_revision: request.config_revision, selected_option_ids: request.selected_option_ids, notes: '备注\n第二行' })
    expect(parseSurveyRequest({ schema_version: 2, survey_id: 'product-use-v1', expected_account_id: '7',
      expected_account_owner: input.expected_account_owner }, true)).toEqual({ schema_version: 2, survey_id: 'product-use-v1' })
    expect(parseSurveyRequest(request, true)).toBeUndefined()
    expect(parseSurveyRequest({ ...request, user_id: 'victim' }, false)).toBeUndefined()
    expect(parseSurveyRequest({ ...request, schema_version: 1 }, false)).toBeUndefined()
  })
  it('rejects configured answers without a valid revision or with duplicate and out-of-bounds IDs', () => {
    const request = { ...input, schema_version: 2, config_revision: 'b'.repeat(64) }
    for (const config_revision of [undefined, '', 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(parseSurveyRequest({ ...request, config_revision }, false)).toBeUndefined()
    }
    for (const selected_option_ids of [[], ['valid', 'valid'], ['a'.repeat(49)], ['UPPER'],
      Array.from({ length: 65 }, (_unused, index) => `choice_${String(index)}`)]) {
      expect(parseSurveyRequest({ ...request, selected_option_ids }, false)).toBeUndefined()
    }
    const selected_option_ids = Array.from({ length: 64 }, (_unused, index) => `choice_${String(index)}`)
    expect(parseSurveyRequest({ ...request, selected_option_ids }, false)?.selected_option_ids).toEqual(selected_option_ids)
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
  it.each([[400, 'SURVEY_INVALID_REQUEST'], [403, 'SURVEY_NOT_ELIGIBLE'], [409, 'SURVEY_ALREADY_SUBMITTED'],
    [409, 'SURVEY_CONFIG_CHANGED']] as const)(
    'retains declared business failure %i %s without its raw message', async (status, code) => {
      const result = await readOnboardingSurvey(async () => Response.json({ success: false, code, message: 'private account detail' }, { status }), signal())
      expect(result).toMatchObject({ ok: false, code, httpStatus: status })
      expect(JSON.stringify(result)).not.toContain('private')
    })
  it('bounds responses and rejects malformed JSON without exposing it', async () => {
    expect(await readOnboardingSurvey(async () => new Response('x'.repeat(ONBOARDING_SURVEY_RESPONSE_LIMIT + 1)), signal()))
      .toMatchObject({ code: 'SURVEY_INVALID_RESPONSE' })
    expect(await readOnboardingSurvey(async () => new Response('{private'), signal())).toMatchObject({ code: 'SURVEY_INVALID_RESPONSE' })
  })
  it('reads the bounded sixty-four-choice bilingual configuration even when escaped JSON exceeds sixty-four KiB', async () => {
    const source = configuredFixture(64, 'submitted')
    const data = { ...source, notes: '<'.repeat(1000), options: source.options.map(option =>
      ({ ...option, label: '<'.repeat(80), label_en: '>'.repeat(160) })) }
    const body = JSON.stringify({ success: true, data }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
    expect(Buffer.byteLength(body)).toBeGreaterThan(64 * 1024)
    expect(Buffer.byteLength(body)).toBeLessThan(ONBOARDING_SURVEY_RESPONSE_LIMIT)
    expect(await readOnboardingSurvey(async () => new Response(body), signal())).toEqual({ ok: true, payload: data })
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
