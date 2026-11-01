// @vitest-environment jsdom
/** Server enrollment, ownership and canonical recovery drive the root survey controller. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOnboardingSurvey } from '../src/client/onboarding-survey-store.ts'
import { parseSurvey, LEGACY_SURVEY_OPTIONS, surveyNoteLength } from '../src/client/onboarding-survey.ts'
import type { CreditsSnapshot } from '../src/client/session-store.ts'
import pending from '../../../host/credits-index/tests/fixtures/onboarding-survey-api/pending.json' with { type: 'json' }
import deferred from '../../../host/credits-index/tests/fixtures/onboarding-survey-api/deferred.json' with { type: 'json' }
import submitted from '../../../host/credits-index/tests/fixtures/onboarding-survey-api/submitted.json' with { type: 'json' }
import not_eligible from '../../../host/credits-index/tests/fixtures/onboarding-survey-api/not-eligible.json' with { type: 'json' }
import v2Pending from '../../../host/credits-index/tests/fixtures/onboarding-survey-api-v2/pending.json' with { type: 'json' }
import v2Deferred from '../../../host/credits-index/tests/fixtures/onboarding-survey-api-v2/deferred.json' with { type: 'json' }
import v2Submitted from '../../../host/credits-index/tests/fixtures/onboarding-survey-api-v2/submitted.json' with { type: 'json' }
import v2NotEligible from '../../../host/credits-index/tests/fixtures/onboarding-survey-api-v2/not-eligible.json' with { type: 'json' }
import v2Changed from '../../../host/credits-index/tests/fixtures/onboarding-survey-api-v2/config-changed-pending.json' with { type: 'json' }
import v2ChangedSubmitted from '../../../host/credits-index/tests/fixtures/onboarding-survey-api-v2/config-changed-submitted.json' with { type: 'json' }
import v2LegacySubmitted from '../../../host/credits-index/tests/fixtures/onboarding-survey-api-v2/legacy-submitted.json' with { type: 'json' }

const pathOf = (url: RequestInfo | URL): string => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
function bodyOf(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected JSON string body')
  return body
}

export function survey(status = 'pending') {
  return { schema_version: 1, survey_id: 'product-use-v1', eligible: status !== 'not_eligible', status,
    options: LEGACY_SURVEY_OPTIONS.map(id => ({ id, label: id, label_en: id })), max_selections: 9, max_notes_length: 1000,
    selected_option_ids: status === 'submitted' ? ['coding'] : [], notes: '', registered_at: status === 'not_eligible' ? 0 : 100,
    submitted_at: status === 'submitted' ? 110 : 0, deferred_at: status === 'deferred' ? 105 : 0 }
}
const dynamicOptions = [
  { id: 'custom_slides', label: '商务演示与路演', label_en: 'Business presentations' },
  { id: 'custom_video', label: '产品视频', label_en: 'Product videos' },
  { id: 'custom_research', label: '资料研究', label_en: 'Research' },
]
function configurableSurvey(status = 'pending', revision = '1'.repeat(64), options = dynamicOptions) {
  return { ...survey(status), schema_version: 2, config_revision: revision, options, max_selections: options.length,
    selected_option_ids: status === 'submitted' ? [options[0]!.id] : [] }
}
const stoppers: (() => void)[] = []
afterEach(() => { for (const stop of stoppers.splice(0)) stop(); vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture(initial = 'pending', makeSurvey: (status: string) => object = survey) {
  let status = initial
  let account = 'a'
  let snapshot: CreditsSnapshot = { accountEpoch: 1, loaded: true, failure: null, balance: null,
    session: { signedIn: true, creditsPerYuan: 1000, account: { id: 'a', phone: 'fixture' }, accountOwner: 'a'.repeat(64) } }
  const listeners = new Set<() => void>()
  const source = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }
  const answer = (value: unknown, owner = account) => Response.json({ ok: true, account: { id: owner },
    accountOwner: owner.repeat(64), payload: value })
  const fetcher = vi.fn<typeof fetch>(async (_path, options) => {
    if (options?.method === 'POST') status = pathOf(_path).endsWith('/defer') ? 'deferred' : 'submitted'
    return answer(makeSurvey(status))
  })
  vi.stubGlobal('fetch', fetcher)
  const controller = createOnboardingSurvey(source)
  stoppers.push(controller.start())
  const read = () => controller.hooks.onboardingSurvey.getSnapshot()
  const change = (owner: string) => {
    account = owner
    snapshot = { ...snapshot, accountEpoch: snapshot.accountEpoch + 1, session: { signedIn: true,
      creditsPerYuan: 1000, account: { id: owner, phone: 'fixture' }, accountOwner: owner.repeat(64) } }
    for (const listener of listeners) listener()
  }
  return { controller, fetcher, read, change, answer, setStatus: (next: string) => { status = next } }
}

describe('onboarding eligibility and notes', () => {
  it('accepts actual API registration-state responses without inferring new-account flags', () => {
    for (const fixture of [pending, deferred, submitted, not_eligible]) {
      const parsed = parseSurvey(fixture.data)
      expect(parsed?.status).toBe(fixture.data.status)
      expect(parsed?.options).toHaveLength(9)
    }
  })
  it('accepts only the complete server version and counts emoji as one Unicode character', () => {
    expect(parseSurvey(survey())?.status).toBe('pending')
    expect(surveyNoteLength('😀'.repeat(1000))).toBe(1000)
    expect(parseSurvey({ ...survey('submitted'), notes: '😀'.repeat(1000) })).toBeDefined()
    for (const value of [{ ...survey(), schema_version: 2 }, { ...survey(), eligible: false },
      { ...survey(), notes: '😀'.repeat(1001) }, { ...survey(), selected_option_ids: ['unknown'] },
      { ...survey(), options: [survey().options[0], survey().options[0]] }]) expect(parseSurvey(value)).toBeUndefined()
  })
  it.each(['not_eligible', 'deferred', 'submitted'])('does not automatically open for %s', async (status) => {
    const f = fixture(status)
    await vi.waitFor(() => { expect(f.read().busy).toBe(false) })
    expect(f.read().data?.status).toBe(status)
    expect(f.read().open).toBe(false)
    f.controller.openSurvey()
    if (status === 'deferred') expect(f.read().open).toBe(true)
    else await vi.waitFor(() => { expect(f.read().open).toBe(false) })
  })
  it('quietly ignores an older API without inferring eligibility or blocking login', async () => {
    const f = fixture()
    f.change('b')
    f.fetcher.mockResolvedValueOnce(Response.json({ ok: false }, { status: 404 }))
    f.change('c')
    await vi.waitFor(() => { expect(f.read().busy).toBe(false) })
    expect(f.read()).toMatchObject({ owner: { id: 'c' }, data: null, open: false, failure: null })
  })
})

describe('root survey lifecycle', () => {
  it('opens a confirmed new enrollment, sends selected choices once and never repeats a submitted survey', async () => {
    const f = fixture()
    await vi.waitFor(() => { expect(f.read().open).toBe(true) })
    f.controller.submitSurvey()
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    f.controller.selectSurveyOption('coding', true)
    f.controller.setSurveyNotes('😀'.repeat(1001))
    f.controller.submitSurvey()
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    f.controller.setSurveyNotes('😀'.repeat(1000))
    f.controller.submitSurvey(); f.controller.submitSurvey()
    await vi.waitFor(() => { expect(f.read().data?.status).toBe('submitted') })
    const writes = f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(bodyOf(writes[0]?.[1]?.body))).toMatchObject({ schema_version: 1, survey_id: 'product-use-v1',
      selected_option_ids: ['coding'], notes: '😀'.repeat(1000), expected_account_id: 'a', expected_account_owner: 'a'.repeat(64) })
    expect(f.read()).toMatchObject({ open: false, notes: '', selected: [] })
    f.controller.openSurvey()
    await vi.waitFor(() => { expect(f.read().busy).toBe(false) })
    expect(f.read().open).toBe(false)
  })
  it('defers without blocking use and can be manually resumed', async () => {
    const f = fixture()
    await vi.waitFor(() => { expect(f.read().open).toBe(true) })
    f.controller.dismissSurvey()
    expect(f.read().open).toBe(false)
    await vi.waitFor(() => { expect(f.read().data?.status).toBe('deferred') })
    expect(f.read().open).toBe(false)
    f.controller.openSurvey()
    expect(f.read().open).toBe(true)
    expect(f.fetcher.mock.calls.filter(([url]) => pathOf(url).endsWith('/defer'))).toHaveLength(1)
  })
  it('drops an old account response and draft without submitting anything for the replacement account', async () => {
    const f = fixture()
    await vi.waitFor(() => { expect(f.read().open).toBe(true) })
    f.controller.selectSurveyOption('coding', true); f.controller.setSurveyNotes('private draft')
    const late = Promise.withResolvers<Response>()
    f.fetcher.mockReturnValueOnce(late.promise)
    f.change('b')
    f.setStatus('not_eligible'); f.change('c')
    await vi.waitFor(() => { expect(f.read().data?.status).toBe('not_eligible') })
    late.resolve(f.answer(survey(), 'b'))
    await Promise.resolve()
    expect(f.read()).toMatchObject({ owner: { id: 'c' }, notes: '', selected: [], open: false })
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
  it('resolves a lost submit acknowledgement by GET without repeating the write', async () => {
    const f = fixture()
    await vi.waitFor(() => { expect(f.read().open).toBe(true) })
    f.fetcher.mockRejectedValueOnce(new TypeError('interrupted')).mockResolvedValueOnce(f.answer(survey('submitted')))
    f.controller.selectSurveyOption('coding', true); f.controller.submitSurvey()
    await vi.waitFor(() => { expect(f.read().data?.status).toBe('submitted') })
    expect(f.read()).toMatchObject({ open: false, uncertain: false, failure: null })
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('retains the exact uncertain draft until an explicit canonical recheck', async () => {
    const f = fixture()
    await vi.waitFor(() => { expect(f.read().open).toBe(true) })
    f.fetcher.mockRejectedValueOnce(new TypeError('interrupted')).mockRejectedValueOnce(new TypeError('offline'))
    f.controller.selectSurveyOption('coding', true); f.controller.setSurveyNotes('original'); f.controller.submitSurvey()
    await vi.waitFor(() => { expect(f.read().uncertain).toBe(true) })
    f.controller.selectSurveyOption('other', true); f.controller.setSurveyNotes('replacement'); f.controller.submitSurvey()
    expect(f.read()).toMatchObject({ notes: 'original', selected: ['coding'] })
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    f.controller.dismissSurvey()
    expect(f.read()).toMatchObject({ open: false, uncertain: true, notes: 'original' })
    f.controller.openSurvey()
    expect(f.read().open).toBe(true)
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    f.controller.retrySurvey()
    await vi.waitFor(() => { expect(f.read().uncertain).toBe(false) })
    expect(f.read()).toMatchObject({ open: true, notes: 'original', selected: ['coding'] })
  })
})

describe('configurable onboarding survey', () => {
  it('accepts actual configured and migrated API states, including a complete legacy submission snapshot', () => {
    for (const fixture of [v2Pending, v2Deferred, v2Submitted, v2NotEligible, v2Changed, v2ChangedSubmitted, v2LegacySubmitted]) {
      const parsed = parseSurvey(fixture.data)
      expect(parsed).toMatchObject({ schema_version: 2, status: fixture.data.status,
        config_revision: fixture.data.config_revision, options: fixture.data.options })
    }
    expect(parseSurvey(v2LegacySubmitted.data)?.options).toHaveLength(9)
  })
  it('accepts ordered custom scenarios and the full bounded catalog without a local business ID list', () => {
    expect(parseSurvey(configurableSurvey())?.options).toEqual(dynamicOptions)
    const maximum = Array.from({ length: 64 }, (_, index) => ({ id: `custom_${index}`, label: '😀'.repeat(80), label_en: '😀'.repeat(160) }))
    expect(parseSurvey(configurableSurvey('pending', 'a'.repeat(64), maximum))?.options).toHaveLength(64)
    expect(parseSurvey({ ...configurableSurvey('submitted'), notes: '😀'.repeat(1000) })).toBeDefined()
    const values = [
      { ...configurableSurvey(), config_revision: 'A'.repeat(64) },
      { ...configurableSurvey(), schema_version: 3 },
      { ...configurableSurvey(), max_selections: 2 },
      configurableSurvey('pending', '1'.repeat(64), [...maximum, dynamicOptions[0]!]),
      configurableSurvey('pending', '1'.repeat(64), [{ ...dynamicOptions[0]!, id: 'a'.repeat(49) }]),
      configurableSurvey('pending', '1'.repeat(64), [{ ...dynamicOptions[0]!, id: 'unsafe.id' }]),
      configurableSurvey('pending', '1'.repeat(64), [{ ...dynamicOptions[0]!, label: '😀'.repeat(81) }]),
      configurableSurvey('pending', '1'.repeat(64), [{ ...dynamicOptions[0]!, label_en: '😀'.repeat(161) }]),
      configurableSurvey('pending', '1'.repeat(64), [{ ...dynamicOptions[0]!, label: 'hidden\u007fcontrol' }]),
      { ...configurableSurvey(), selected_option_ids: ['custom_video'] },
      { ...configurableSurvey(), notes: 'unsubmitted' },
      { ...configurableSurvey('submitted'), notes: 'bad\u000bnote' },
      { ...survey(), max_selections: 8 },
      { ...survey(), options: survey().options.slice(1) },
    ]
    for (const value of values) expect(parseSurvey(value)).toBeUndefined()
  })
  it('sends the returned schema and revision while defer excludes a revision', async () => {
    const f = fixture('pending', configurableSurvey)
    await vi.waitFor(() => { expect(f.read().open).toBe(true) })
    f.controller.selectSurveyOption('custom_slides', true)
    f.controller.submitSurvey()
    await vi.waitFor(() => { expect(f.read().data?.status).toBe('submitted') })
    const write = f.fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(bodyOf(write?.[1]?.body))).toMatchObject({ schema_version: 2, config_revision: '1'.repeat(64),
      selected_option_ids: ['custom_slides'], expected_account_id: 'a', expected_account_owner: 'a'.repeat(64) })
    const g = fixture('pending', configurableSurvey)
    await vi.waitFor(() => { expect(g.read().open).toBe(true) })
    g.controller.dismissSurvey()
    await vi.waitFor(() => { expect(g.read().data?.status).toBe('deferred') })
    const defer = g.fetcher.mock.calls.find(([url]) => pathOf(url).endsWith('/defer'))
    const body: unknown = JSON.parse(bodyOf(defer?.[1]?.body))
    expect(body).toMatchObject({ schema_version: 2, survey_id: 'product-use-v1' })
    expect(body).not.toHaveProperty('config_revision')
  })
  it('recovers an actual API configuration conflict without discarding choices or resubmitting automatically', async () => {
    const f = fixture('pending', () => v2Pending.data)
    await vi.waitFor(() => { expect(f.read().open).toBe(true) })
    f.controller.selectSurveyOption('daily_qa', true)
    f.controller.selectSurveyOption('code_debugging', true)
    f.controller.setSurveyNotes(v2ChangedSubmitted.data.notes)
    const next = v2Changed.data
    f.fetcher.mockResolvedValueOnce(Response.json({ ok: false, code: 'SURVEY_CONFIG_CHANGED' }, { status: 409 }))
      .mockResolvedValueOnce(f.answer(next))
    f.controller.submitSurvey()
    await vi.waitFor(() => { expect(f.read().busy).toBe(false) })
    expect(f.read()).toMatchObject({ configurationChanged: true, uncertain: false,
      selected: ['daily_qa', 'code_debugging'], notes: v2ChangedSubmitted.data.notes,
      unavailableOptions: [v2Pending.data.options.find(option => option.id === 'code_debugging')] })
    expect(f.read().data?.options).toEqual(next.options)
    f.controller.submitSurvey()
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    f.controller.selectSurveyOption('code_debugging', false)
    f.controller.selectSurveyOption('custom_research', true)
    expect(f.read()).toMatchObject({ selected: ['daily_qa', 'custom_research'], unavailableOptions: [], notes: v2ChangedSubmitted.data.notes })
    f.fetcher.mockResolvedValueOnce(f.answer(v2ChangedSubmitted.data))
    f.controller.submitSurvey()
    await vi.waitFor(() => { expect(f.read().data?.status).toBe('submitted') })
    const writes = f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes).toHaveLength(2)
    expect(JSON.parse(bodyOf(writes[1]?.[1]?.body))).toMatchObject({ config_revision: next.config_revision,
      selected_option_ids: v2ChangedSubmitted.data.selected_option_ids, notes: v2ChangedSubmitted.data.notes })
  })
  it('locks a stale configuration when its required read fails and restores only through an explicit recheck', async () => {
    const f = fixture('pending', configurableSurvey)
    await vi.waitFor(() => { expect(f.read().open).toBe(true) })
    f.controller.selectSurveyOption('custom_slides', true); f.controller.setSurveyNotes('retained')
    f.fetcher.mockResolvedValueOnce(Response.json({ ok: false, code: 'SURVEY_CONFIG_CHANGED' }, { status: 409 }))
      .mockRejectedValueOnce(new TypeError('offline'))
    f.controller.submitSurvey()
    await vi.waitFor(() => { expect(f.read().uncertain).toBe(true) })
    f.controller.setSurveyNotes('replacement'); f.controller.selectSurveyOption('custom_research', true)
    f.controller.submitSurvey(); f.controller.dismissSurvey(); f.controller.openSurvey()
    expect(f.read()).toMatchObject({ notes: 'retained', selected: ['custom_slides'], configurationChanged: true, open: true })
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    f.fetcher.mockResolvedValueOnce(f.answer(configurableSurvey('pending', '2'.repeat(64))))
    f.controller.retrySurvey()
    await vi.waitFor(() => { expect(f.read().uncertain).toBe(false) })
    expect(f.read()).toMatchObject({ notes: 'retained', selected: ['custom_slides'], configurationChanged: true })
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('keeps a submitted configuration snapshot complete when it is no longer the active catalog', () => {
    const snapshot = configurableSurvey('submitted', 'f'.repeat(64), [{ id: 'retired_choice', label: '原始场景', label_en: 'Original scenario' }])
    expect(parseSurvey(snapshot)).toMatchObject({ schema_version: 2, status: 'submitted', config_revision: 'f'.repeat(64),
      options: snapshot.options, selected_option_ids: ['retired_choice'] })
  })
})
