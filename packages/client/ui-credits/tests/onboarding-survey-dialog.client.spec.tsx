// @vitest-environment jsdom
/** Actual controls drive the shared controller; no login flags are fabricated by the dialog. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnboardingSurvey, OnboardingSurveyEntry } from '../src/client/OnboardingSurvey.tsx'
import { createOnboardingSurvey } from '../src/client/onboarding-survey-store.ts'
import { LEGACY_SURVEY_OPTIONS } from '../src/client/onboarding-survey.ts'
import type { CreditsSnapshot } from '../src/client/session-store.ts'
import { en, zh, type CreditsKey } from '../src/client/locales.ts'
import type { SurveyChoice } from '../src/client/onboarding-survey.ts'

const pathOf = (url: RequestInfo | URL): string => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
function bodyOf(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected JSON string body')
  return body
}

const stops: (() => void)[] = []
afterEach(() => { cleanup(); for (const stop of stops.splice(0)) stop(); vi.unstubAllGlobals() })
function fixture(status = 'pending', catalog?: { revision: string; options: SurveyChoice[] }, english = false) {
  const snapshot: CreditsSnapshot = { loaded: true, accountEpoch: 1, failure: null, balance: null,
    session: { signedIn: true, creditsPerYuan: 1000, account: { id: '7', phone: 'fixture' }, accountOwner: 'a'.repeat(64) } }
  const source = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const payload = () => ({ schema_version: catalog === undefined ? 1 : 2,
    ...catalog === undefined ? {} : { config_revision: catalog.revision },
    survey_id: 'product-use-v1', eligible: status !== 'not_eligible', status,
    options: catalog?.options ?? LEGACY_SURVEY_OPTIONS.map(id => ({ id, label: id, label_en: id })),
    max_selections: catalog?.options.length ?? 9, max_notes_length: 1000,
    selected_option_ids: status === 'submitted' ? [catalog?.options[0]?.id ?? 'coding'] : [], notes: '',
    registered_at: status === 'not_eligible' ? 0 : 100,
    submitted_at: status === 'submitted' ? 110 : 0, deferred_at: status === 'deferred' ? 105 : 0 })
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'POST') status = pathOf(url).endsWith('/defer') ? 'deferred' : 'submitted'
    return Response.json({ ok: true, account: { id: '7' }, accountOwner: 'a'.repeat(64), payload: payload() })
  })
  vi.stubGlobal('fetch', fetcher)
  const controller = createOnboardingSurvey(source)
  const { hooks, start, ...commands } = controller
  stops.push(start())
  const view = hooks.onboardingSurvey
  const t = (key: string, values?: Record<string, unknown>): string => {
    let text: string = (english ? en : zh)[key as CreditsKey] ?? key
    for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
  const useOnboardingSurvey: Parameters<typeof OnboardingSurvey>[0]['useOnboardingSurvey'] = selector =>
    selector(useSyncExternalStore(listener => view.subscribe(listener), () => view.getSnapshot()))
  const props = { ...commands, t, useOnboardingSurvey } as Parameters<typeof OnboardingSurvey>[0]
  render(<><OnboardingSurvey {...props} /><OnboardingSurveyEntry {...props} /></>)
  return { controller, fetcher, setCatalog: (next: NonNullable<typeof catalog>) => { catalog = next } }
}

describe('onboarding questionnaire controls', () => {
  it('shows nine checkboxes, allows optional Unicode notes and submits without triggering other product operations', async () => {
    const f = fixture()
    const dialog = await screen.findByRole('dialog', { name: zh['survey.title'] })
    expect(dialog).toBeDefined()
    expect(screen.getAllByRole('checkbox')).toHaveLength(9)
    expect(screen.getByRole('button', { name: zh['survey.submit'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'coding' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'video_creation' }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['survey.notes'] }), { target: { value: '😀'.repeat(1000) } })
    expect(screen.getByText('1000 / 1000 字')).toBeDefined()
    expect(screen.getByRole('button', { name: zh['survey.submit'] }).hasAttribute('disabled')).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['survey.submit'] })) })
    await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    const writes = f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[0]).toBe('/credits/api/onboarding-survey')
    expect(JSON.parse(bodyOf(writes[0]?.[1]?.body))).toMatchObject({ selected_option_ids: ['coding', 'video_creation'] })
    expect(screen.queryByRole('button', { name: zh['survey.entry'] })).toBeNull()
  })
  it('closes via Later and retains a manual entry for the deferred survey', async () => {
    const f = fixture()
    await screen.findByRole('dialog')
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: zh['survey.later'] }).at(-1)!) })
    await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['survey.entry'] })) })
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(f.fetcher.mock.calls.filter(([url]) => pathOf(url).endsWith('/defer'))).toHaveLength(1)
  })
  it('does not open for an existing user or a previously submitted survey', async () => {
    const f = fixture('submitted')
    await vi.waitFor(() => { expect(f.controller.hooks.onboardingSurvey.getSnapshot().busy).toBe(false) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: zh['survey.entry'] })).toBeNull()
  })
  it('reopens an uncertain submission from the wallet and checks status without another POST', async () => {
    const f = fixture()
    await screen.findByRole('dialog')
    f.fetcher.mockRejectedValueOnce(new TypeError('lost acknowledgement')).mockRejectedValueOnce(new TypeError('offline'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'coding' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'retained draft' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['survey.submit'] })) })
    expect(screen.getByText(zh['survey.unconfirmed'])).toBeDefined()
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: zh['survey.later'] }).at(-1)!) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: zh['survey.entry'] }).hasAttribute('disabled')).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['survey.entry'] })) })
    expect(screen.getByDisplayValue('retained draft')).toBeDefined()
    expect(screen.getByRole('button', { name: zh['survey.submit'] }).hasAttribute('disabled')).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['survey.refresh'] })) })
    expect(screen.getByRole('button', { name: zh['survey.submit'] }).hasAttribute('disabled')).toBe(false)
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('keeps over-limit notes visible and refuses a submission until corrected', async () => {
    const f = fixture()
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('checkbox', { name: 'other' }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['survey.notes'] }), { target: { value: '😀'.repeat(1001) } })
    expect(screen.getByRole('button', { name: zh['survey.submit'] }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true')
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
  it('shows configurable labels and order in the current language without fixed scenario translations', async () => {
    fixture('pending', { revision: '1'.repeat(64), options: [
      { id: 'school_slides', label: '课堂课件', label_en: 'Classroom slides' },
      { id: 'shop_gallery', label: '商品详情图', label_en: 'Product galleries' },
    ] }, true)
    await screen.findByRole('dialog', { name: en['survey.title'] })
    expect(screen.getAllByRole('checkbox').map(input => input.getAttribute('aria-label') ?? input.closest('label')?.textContent))
      .toEqual(['Classroom slides', 'Product galleries'])
    expect(screen.getByText(en['survey.description'])).toBeDefined()
    expect(screen.queryByText('课堂课件')).toBeNull()
  })
  it('retains stopped choices visibly and requires a reviewed user submission using the current revision', async () => {
    const options = [
      { id: 'school_slides', label: '课堂课件', label_en: 'Classroom slides' },
      { id: 'shop_gallery', label: '商品详情图', label_en: 'Product galleries' },
    ]
    const f = fixture('pending', { revision: '1'.repeat(64), options })
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('checkbox', { name: '课堂课件' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '商品详情图' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'preserved notes' } })
    f.setCatalog({ revision: '2'.repeat(64), options: [options[1]!] })
    f.fetcher.mockResolvedValueOnce(Response.json({ ok: false, code: 'SURVEY_CONFIG_CHANGED' }, { status: 409 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['survey.submit'] })) })
    expect(screen.getByText(zh['survey.configurationChanged'])).toBeDefined()
    expect(screen.getByText(zh['survey.unavailableChoices'])).toBeDefined()
    expect(screen.getByRole('checkbox', { name: '课堂课件' })).toBeDefined()
    expect(screen.getByDisplayValue('preserved notes')).toBeDefined()
    expect(screen.getByRole('button', { name: zh['survey.reviewSubmit'] }).hasAttribute('disabled')).toBe(true)
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    fireEvent.click(screen.getByRole('checkbox', { name: '课堂课件' }))
    expect(screen.getByRole('button', { name: zh['survey.reviewSubmit'] }).hasAttribute('disabled')).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['survey.reviewSubmit'] })) })
    await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    const writes = f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes).toHaveLength(2)
    expect(JSON.parse(bodyOf(writes[1]?.[1]?.body))).toMatchObject({ schema_version: 2, config_revision: '2'.repeat(64),
      selected_option_ids: ['shop_gallery'], notes: 'preserved notes' })
  })
})
