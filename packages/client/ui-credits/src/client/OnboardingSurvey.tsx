/** Optional, account-bound onboarding survey shared by the root overlay and wallet entry. */
import { useEffect, useState } from 'react'
import { Button, Checkbox, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { creditsRetrySeconds } from './read-failure.ts'
import { surveyNoteLength } from './onboarding-survey.ts'
import type { OnboardingSurveyInjected } from './onboarding-survey-store.ts'
import css from './OnboardingSurvey.module.css'
import { cx } from './class-names.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Root-local entry for continuing a deferred registration questionnaire. */
    'credits.onboarding-entry': { kind: 'single'; scope: 'root' }
  }
}

type Shared = PropsLocale<'credits'> & InjectFace<OnboardingSurveyInjected>

/** @param props - Root account-owned survey controller. @returns A dismissible multi-choice questionnaire for confirmed new users. */
export function OnboardingSurvey(props: PropsRuntime<'shell.overlay'> & Shared) {
  const { useOnboardingSurvey, selectSurveyOption, setSurveyNotes, dismissSurvey, submitSurvey,
    retrySurvey, dismissSurveyNotice, t } = props
  const state = useOnboardingSurvey(value => value)
  const [cooldown, setCooldown] = useState(0)
  useEffect(() => {
    const update = (): void => { setCooldown(creditsRetrySeconds(state.failure)) }
    update()
    if (creditsRetrySeconds(state.failure) === 0) return undefined
    const timer = setInterval(update, 1000)
    return () => { clearInterval(timer) }
  }, [state.failure])
  if (state.notice) return <Toast text={t('survey.submitted')} tone="success" onDone={dismissSurveyNotice} />
  const data = state.data
  if (!state.open || state.owner === null || data === null || !data.eligible || data.status === 'submitted') return null
  const length = surveyNoteLength(state.notes)
  const invalid = state.selected.length === 0 || state.unavailableOptions.length > 0
    || state.selected.length > data.max_selections || length > data.max_notes_length
  const english = t('survey.locale') === 'en-US'
  return <Modal open title={t('survey.title')} description={t('survey.description')} closeLabel={t('survey.later')}
    onClose={dismissSurvey} className={cx(css.dialog)} contentClassName={cx(css.content)} footer={<>
      <Button variant="outline" onClick={dismissSurvey}>{t('survey.later')}</Button>
      <Button variant="primary" disabled={state.busy || state.uncertain || invalid || cooldown > 0} onClick={submitSurvey}>
        {t(state.busy ? 'survey.submitting' : state.configurationChanged ? 'survey.reviewSubmit' : 'survey.submit')}
      </Button>
    </>}>
    <fieldset className={css.choices} disabled={state.busy || state.uncertain}>
      <legend className={css.legend}>{t('survey.choose')}</legend>
      {data.options.map(option => <Checkbox key={option.id} checked={state.selected.includes(option.id)}
        onChange={(checked) => { selectSurveyOption(option.id, checked) }} label={english ? option.label_en : option.label}
        disabled={!state.selected.includes(option.id) && state.selected.length >= data.max_selections} />)}
    </fieldset>
    {state.configurationChanged && <p className={css.failure} role="status">{t('survey.configurationChanged')}</p>}
    {state.unavailableOptions.length > 0 && <fieldset className={cx(css.choices, css.unavailable)} disabled={state.busy || state.uncertain}>
      <legend className={css.legend}>{t('survey.unavailableChoices')}</legend>
      {state.unavailableOptions.map(option => <Checkbox key={option.id} checked
        onChange={(checked) => { selectSurveyOption(option.id, checked) }} label={english ? option.label_en : option.label} />)}
    </fieldset>}
    <label className={css.notesLabel}>
      <span>{t('survey.notes')}</span>
      <textarea className={css.notes} value={state.notes} disabled={state.busy || state.uncertain}
        onChange={(event) => { setSurveyNotes(event.target.value) }} placeholder={t('survey.notesHint')}
        aria-invalid={length > data.max_notes_length} />
    </label>
    <p className={css.hint}>{t('survey.count', { count: String(length), max: String(data.max_notes_length) })}</p>
    {state.failure !== null && <div className={css.failure} role="status">
      <span>{t(state.uncertain ? state.configurationChanged ? 'survey.configurationUnconfirmed' : 'survey.unconfirmed'
        : `survey.error.${state.failure.kind}`)}</span>
      <Button size="sm" variant="ghost" disabled={state.busy || cooldown > 0} onClick={retrySurvey}>{t('survey.refresh')}</Button>
      {cooldown > 0 && <span>{t('read.retryAfter', { seconds: String(cooldown) })}</span>}
    </div>}
  </Modal>
}

/** @param props - Shared root controller. @returns A wallet entry only for a current incomplete or temporarily unconfirmed survey. */
export function OnboardingSurveyEntry({ useOnboardingSurvey, openSurvey, t }: PropsRuntime<'credits.onboarding-entry'> & Shared) {
  const state = useOnboardingSurvey(value => value)
  if (state.owner === null || state.data?.status === 'submitted'
    || state.data?.eligible !== true && state.failure === null) return null
  return <div className={css.entry}>
    <Button size="sm" variant="ghost" disabled={state.busy} onClick={openSurvey}>{t('survey.entry')}</Button>
  </div>
}
