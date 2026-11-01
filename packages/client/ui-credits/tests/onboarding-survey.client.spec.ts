// @vitest-environment jsdom
/** Server enrollment, ownership and canonical recovery drive the root survey controller. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOnboardingSurvey } from '../src/client/onboarding-survey-store.ts'
import { parseSurvey, SURVEY_OPTIONS, surveyNoteLength } from '../src/client/onboarding-survey.ts'
import type { CreditsSnapshot } from '../src/client/session-store.ts'
import pending from '../../../host/credits-index/tests/fixtures/onboarding-survey-api/pending.json' with { type: 'json' }
import deferred from '../../../host/credits-index/tests/fixtures/onboarding-survey-api/deferred.json' with { type: 'json' }
import submitted from '../../../host/credits-index/tests/fixtures/onboarding-survey-api/submitted.json' with { type: 'json' }
import not_eligible from '../../../host/credits-index/tests/fixtures/onboarding-survey-api/not-eligible.json' with { type: 'json' }

const pathOf = (url: RequestInfo | URL): string => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
function bodyOf(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected JSON string body')
  return body
}

export function survey(status = 'pending') {
  return { schema_version: 1, survey_id: 'product-use-v1', eligible: status !== 'not_eligible', status,
    options: SURVEY_OPTIONS.map(id => ({ id, label: id, label_en: id })), max_selections: 9, max_notes_length: 1000,
    selected_option_ids: status === 'submitted' ? ['coding'] : [], notes: '', registered_at: 100,
    submitted_at: status === 'submitted' ? 110 : 0, deferred_at: status === 'deferred' ? 105 : 0 }
}
const stoppers: (() => void)[] = []
afterEach(() => { for (const stop of stoppers.splice(0)) stop(); vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture(initial = 'pending') {
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
    return answer(survey(status))
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
    expect(parseSurvey({ ...survey(), notes: '😀'.repeat(1000) })).toBeDefined()
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
