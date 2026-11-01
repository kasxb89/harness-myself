/** One root-owned survey lifecycle shared by the global dialog and its balance-page entry. @module */
import { defineStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { get, post } from './api.ts'
import { creditsReadFailure, creditsRetrySeconds, type CreditsReadFailure } from './read-failure.ts'
import type { CreditsSnapshot } from './session-store.ts'
import { parseSurvey, SURVEY_ID, surveyNoteLength, type SurveyData, type SurveyChoice } from './onboarding-survey.ts'

export interface SurveyOwner { readonly id: string; readonly scope: string; readonly epoch: number }
export interface OnboardingSurveyState {
  readonly owner: SurveyOwner | null
  readonly data: SurveyData | null
  readonly open: boolean
  readonly busy: boolean
  readonly selected: readonly string[]
  readonly unavailableOptions: readonly SurveyChoice[]
  readonly configurationChanged: boolean
  readonly notes: string
  readonly failure: CreditsReadFailure | null
  readonly uncertain: boolean
  readonly notice: boolean
}
export interface OnboardingSurveyInjected {
  readonly hooks: { readonly onboardingSurvey: ObservableSnapshot<OnboardingSurveyState> }
  readonly openSurvey: () => void
  readonly dismissSurvey: () => void
  readonly selectSurveyOption: (option: string, checked: boolean) => void
  readonly setSurveyNotes: (notes: string) => void
  readonly submitSurvey: () => void
  readonly retrySurvey: () => void
  readonly dismissSurveyNotice: () => void
}
function ownerOf(snapshot: CreditsSnapshot): SurveyOwner | null {
  const session = snapshot.session
  return session?.signedIn === true && typeof session.account?.id === 'string' && session.account.id !== ''
    && typeof session.accountOwner === 'string' && /^[a-f0-9]{64}$/u.test(session.accountOwner)
    ? { id: session.account.id, scope: session.accountOwner, epoch: snapshot.accountEpoch } : null
}
function same(left: SurveyOwner | null, right: SurveyOwner | null): boolean {
  return left?.id === right?.id && left?.scope === right?.scope && left?.epoch === right?.epoch
}
function sameConfiguration(left: SurveyData, right: SurveyData): boolean {
  return left.schema_version === 1 ? right.schema_version === 1
    : right.schema_version === 2 && left.config_revision === right.config_revision
}
class SurveyOperationError extends Error {
  readonly failure: CreditsReadFailure
  constructor(value: unknown) {
    super('Survey operation did not complete')
    this.failure = creditsReadFailure(value, 'SURVEY_UNAVAILABLE')
  }
}
function failureOf(value: unknown): CreditsReadFailure {
  const base = value instanceof SurveyOperationError ? value.failure : creditsReadFailure(value, 'SURVEY_UNAVAILABLE')
  return base.code === 'SURVEY_INVALID_REQUEST' ? { ...base, kind: 'invalid' }
    : /SURVEY_(?:NETWORK|TRANSPORT)$/u.test(base.code) ? { ...base, kind: 'network' } : base
}

/**
 * Create one disposable controller. Only a verified pending enrollment may automatically open it.
 * @param source - Existing account snapshot, also used to invalidate reads and drafts after identity changes.
 * @returns Slot data and commands plus lifecycle start/disposal; no credentials are retained here.
 */
export function createOnboardingSurvey(
  source: ObservableSnapshot<CreditsSnapshot>,
): OnboardingSurveyInjected & { start: () => () => void } {
  const initial = (): OnboardingSurveyState => ({ owner: null, data: null, open: false, busy: false,
    selected: [], unavailableOptions: [], configurationChanged: false,
    notes: '', failure: null, uncertain: false, notice: false })
  const view = defineStore({ init: initial, actions: {
    replace: (draft, state: OnboardingSurveyState) => { Object.assign(draft, state) },
    patch: (draft, state: Partial<OnboardingSurveyState>) => { Object.assign(draft, state) },
  } }).create()
  let active: AbortController | null = null
  let autoShown = false
  let disposed = true
  const current = (owner: SurveyOwner): boolean => !disposed && same(owner, ownerOf(source.getSnapshot()))
  const transport = async (owner: SurveyOwner, lifetime: AbortController, method: 'GET' | 'POST', body?: Record<string, unknown>, defer = false) => {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)])
    const url = '/credits/api/onboarding-survey' + (defer ? '/defer' : '')
    const answer = method === 'GET' ? await get<unknown>(url, signal) : await post<unknown>(url,
      { ...body, expected_account_id: owner.id, expected_account_owner: owner.scope }, signal)
    signal.throwIfAborted()
    if (!current(owner)) throw new DOMException('Account changed', 'AbortError')
    if (!answer.ok) throw new SurveyOperationError(answer)
    if (answer.account?.id !== owner.id || answer.accountOwner !== owner.scope) {
      throw new SurveyOperationError({ code: 'ACCOUNT_CHANGED' })
    }
    const data = parseSurvey(answer.payload)
    if (data === undefined) throw new SurveyOperationError({ code: 'INVALID_RESPONSE' })
    return data
  }
  const apply = (data: SurveyData, manual: boolean): void => {
    const state = view.getSnapshot()
    const eligible = data.eligible && (data.status === 'pending' || data.status === 'deferred')
    const automatic = data.status === 'pending' && !autoShown
    if (automatic) autoShown = true
    const previousOptions = [...state.data?.options ?? [], ...state.unavailableOptions]
    const unavailableOptions = state.selected.flatMap((id) => {
      if (data.options.some(option => option.id === id)) return []
      const previous = previousOptions.find(option => option.id === id)
      return previous === undefined ? [] : [previous]
    })
    view.actions.patch({ data, open: eligible && (manual || state.open || automatic), uncertain: false,
      unavailableOptions, configurationChanged: state.configurationChanged
        || state.data !== null && !sameConfiguration(state.data, data),
      ...data.status === 'submitted' ? { selected: [], unavailableOptions: [], notes: '', configurationChanged: false } : {}, failure: null })
  }
  const perform = (kind: 'read' | 'submit' | 'defer', manual = false): void => {
    const state = view.getSnapshot(), owner = state.owner
    if (owner === null || active !== null || !current(owner) || creditsRetrySeconds(state.failure) > 0) return
    const data = state.data
    if (kind !== 'read' && (data === null || !data.eligible || data.status === 'submitted' || data.status === 'not_eligible')) return
    if (kind === 'submit' && (state.uncertain || state.selected.length === 0 || state.selected.length > (data?.max_selections ?? 0)
      || state.selected.some(id => !data?.options.some(option => option.id === id))
      || surveyNoteLength(state.notes) > (data?.max_notes_length ?? 0))) return
    const controller = new AbortController()
    active = controller
    view.actions.patch({ busy: true, failure: null })
    const run = async (): Promise<void> => {
      try {
        if (kind === 'read') { apply(await transport(owner, controller, 'GET'), manual); return }
        const body = { schema_version: data?.schema_version, survey_id: SURVEY_ID,
          ...kind === 'submit' && data?.schema_version === 2 ? { config_revision: data.config_revision } : {},
          ...kind === 'submit' ? { selected_option_ids: [...state.selected], notes: state.notes } : {} }
        try {
          const result = await transport(owner, controller, 'POST', body, kind === 'defer')
          if (kind === 'submit' && result.status !== 'submitted' || kind === 'defer' && result.status === 'pending') {
            throw new SurveyOperationError({ code: 'INVALID_RESPONSE' })
          }
          apply(result, false)
          if (kind === 'submit' && result.status === 'submitted') view.actions.patch({ notice: true })
        } catch (error) {
          if (!current(owner) || controller.signal.aborted) return
          const failure = failureOf(error)
          if (failure.code === 'SURVEY_NOT_ELIGIBLE' || failure.code === 'SURVEY_UNSUPPORTED') {
            view.actions.patch({ data: null, open: false, failure: null }); return
          }
          const configurationChanged = failure.code === 'SURVEY_CONFIG_CHANGED'
          if (configurationChanged) view.actions.patch({ configurationChanged: true })
          // The canonical read resolves a lost acknowledgement without blindly repeating a write.
          try {
            const result = await transport(owner, controller, 'GET')
            apply(result, false)
            if (result.status === 'submitted') {
              if (kind === 'submit') view.actions.patch({ notice: true })
              return
            }
            if (kind === 'defer' && result.status === 'deferred') return
            if (configurationChanged) return
          } catch (_unconfirmed: unknown) { /* Keep this owner's exact draft for an explicit retry. */ }
          view.actions.patch({ failure: failureOf(error), uncertain: kind === 'submit' })
        }
      } catch (error) {
        if (!current(owner) || controller.signal.aborted) return
        const failure = failureOf(error)
        if (failure.httpStatus === 404 || failure.code === 'SURVEY_UNSUPPORTED' || failure.code === 'SURVEY_NOT_ELIGIBLE') {
          view.actions.patch({ data: null, open: false, failure: null }); return
        }
        view.actions.patch({ failure: failureOf(error) })
      } finally {
        if (active === controller) {
          active = null
          if (current(owner)) view.actions.patch({ busy: false })
        }
      }
    }
    void run()
  }
  return {
    hooks: { onboardingSurvey: view },
    start: () => {
      disposed = false
      const changed = (): void => {
        const owner = ownerOf(source.getSnapshot())
        if (same(owner, view.getSnapshot().owner)) return
        active?.abort(); active = null; autoShown = false
        view.actions.replace({ ...initial(), owner })
        if (owner !== null) perform('read')
      }
      const unsubscribe = source.subscribe(changed)
      changed()
      return () => { disposed = true; unsubscribe(); active?.abort(); active = null; view.actions.replace(initial()) }
    },
    openSurvey: () => {
      const state = view.getSnapshot()
      if (state.data?.eligible === true && state.data.status !== 'submitted') view.actions.patch({ open: true })
      else perform('read', true)
    },
    dismissSurvey: () => {
      autoShown = true
      view.actions.patch({ open: false })
      if (!view.getSnapshot().uncertain) perform('defer')
    },
    selectSurveyOption: (option, checked) => {
      const state = view.getSnapshot()
      if (state.busy || state.uncertain || !(state.data?.options.some(item => item.id === option)
        || !checked && state.unavailableOptions.some(item => item.id === option))) return
      const selected = checked ? [...new Set([...state.selected, option])] : state.selected.filter(item => item !== option)
      if (!checked || selected.length <= (state.data?.max_selections ?? 0)) view.actions.patch({ selected,
        unavailableOptions: state.unavailableOptions.filter(item => selected.includes(item.id)), uncertain: false })
    },
    setSurveyNotes: (notes) => { if (!view.getSnapshot().busy && !view.getSnapshot().uncertain) view.actions.patch({ notes }) },
    submitSurvey: () => { perform('submit') },
    retrySurvey: () => { perform('read', true) },
    dismissSurveyNotice: () => { view.actions.patch({ notice: false }) },
  }
}
