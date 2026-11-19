/** Private request cards use only the customer's received summaries and local draft scopes. */
import { useState, type ReactNode } from 'react'
import { Button, Input, IconPlusOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandDraftSummary, DemandPageState } from './types.ts'
import { DemandEmpty, DemandSkeleton, demandTime, type DemandTranslate } from './DemandUI.tsx'
import css from './DemandPage.module.css'

/**
 * Continue the customer's own requests without publishing a shared demand feed.
 * @param props - Private server summaries, local scopes and original conversation callbacks.
 * @returns Split cards with request identity, service, time and the original conversation action.
 */
export function PersonalDemandCards(props: {
  state: DemandPageState
  open: (id: string) => void
  openDraft: (scopeKey: string) => void
  create: () => void
  conversations: () => void
  refresh: () => void
  loadMore: () => void
  t: DemandTranslate
}): ReactNode {
  const { state, open, openDraft, create, conversations, refresh, loadMore, t } = props
  const [query, setQuery] = useState('')
  const search = query.trim().toLocaleLowerCase()
  const current = state.conversation
  const draftScopes: readonly DemandDraftSummary[] = current !== null && current.requestId === null
    && !state.drafts.some(row => row.scopeKey === current.scopeKey) ? [...state.drafts, {
      ...current, updatedAt: '',
      pending: state.draft?.scopeKey === current.scopeKey && state.draft.sending,
      error: state.draft?.scopeKey === current.scopeKey ? state.draft.error : null,
      ...(state.draft?.scopeKey !== current.scopeKey ? {} : { budget: state.draft.budget, expectedDate: state.draft.expectedDate }),
    }] : state.drafts
  const draftText = (scopeKey: string) => state.draft?.scopeKey === scopeKey ? state.draft.text.trim() : ''
  const drafts = draftScopes.filter(row => [row.title, row.serviceProfileName ?? '', row.engineer?.displayName ?? '',
    row.budget ?? '', draftText(row.scopeKey)].join(' ').toLocaleLowerCase().includes(search))
  const requests = state.requests.filter(row => [row.title, row.number, row.preview, row.serviceProfileName ?? '',
    row.engineer?.displayName ?? '', row.budget ?? ''].join(' ').toLocaleLowerCase().includes(search))
  const count = drafts.length + requests.length
  const initialLoading = state.requestsStatus === 'loading' && state.requests.length === 0 && draftScopes.length === 0
  return <div className={css.directory}>
    <div className={css.cardsToolbar}>
      <div className={css.searchField}>
        <Input type="search" value={query} aria-label={t('searchRequests')} placeholder={t('searchRequests')}
          icon={<IconSearchOutlineRegular size={16} />} onChange={(event) => { setQuery(event.target.value) }} />
      </div>
      <div className={css.cardsToolbarActions}>
        <Button size="sm" onClick={conversations}>{t('viewConversations')}</Button>
        <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={14} />} onClick={create}>{t('newRequest')}</Button>
      </div>
    </div>
    <div className={css.cardsContext}><p>{t('personalRequestsHint')}</p>
      {initialLoading ? null : <span aria-live="polite">{t('visibleRequestCount', { count })}</span>}</div>
    {state.requestsStatus !== 'error' ? null : <div className={css.inlineNotice} role="alert">
      <span>{t('errorHint')}</span><Button size="sm" onClick={refresh}>{t('retry')}</Button>
    </div>}
    {initialLoading ? <DemandSkeleton label={t('loading')} /> : null}
    {count === 0 ? null : <ul className={css.personalCardGrid} aria-label={t('personalRequests')}>
      {drafts.map((row) => {
        const title = row.title.trim() || row.serviceProfileName?.trim() || t('newRequest')
        const source = row.serviceProfileName?.trim()
          || (row.assigned === false ? t('platformReception') : row.engineer?.displayName.trim()) || t('pageTitle')
        const feedback = row.error ?? (row.pending ? t('pendingDraftHint') : '')
        return <li key={row.scopeKey} className={css.personalCard}>
          <div className={css.personalCardBody}>
            <h2>{title}</h2><p>{source}</p>
            {row.updatedAt === '' ? null : <time dateTime={row.updatedAt}>{demandTime(row.updatedAt, t)}</time>}
            {feedback === '' ? null : <p className={css.personalCardFeedback} role="status">{feedback}</p>}
          </div>
          <div className={css.personalCardAction}>
            <Button variant="primary" aria-label={t(row.pending ? 'checkDraftNamed' : 'continueDraftNamed', { title })}
              onClick={() => { openDraft(row.scopeKey) }}>{t(row.pending ? 'confirmPublication' : 'continueDraft')}</Button>
          </div>
        </li>
      })}
      {requests.map((row) => {
        const title = row.title.trim() || row.serviceProfileName?.trim() || t('newRequest')
        const source = row.serviceProfileName?.trim()
          || (row.assigned === false ? t('platformReception') : row.engineer?.displayName.trim()) || t('pageTitle')
        return <li key={row.id} className={css.personalCard}>
          <div className={css.personalCardBody}>
            <h2>{title}</h2><p>{source}</p>
            <time dateTime={row.updatedAt}>{demandTime(row.updatedAt, t)}</time>
          </div>
          <div className={css.personalCardAction}>
            <Button variant="primary" aria-label={t('communicateRequestNamed', { title, number: row.number })}
              onClick={() => { open(row.id) }}>{t('communicate')}</Button>
          </div>
        </li>
      })}
    </ul>}
    {!state.requestsHaveMore ? null : <div className={css.historyAction}>
      <Button size="sm" variant="outline" disabled={state.loadingMoreRequests} onClick={loadMore}>
        {t(state.loadingMoreRequests ? 'loadingMoreRequests' : 'loadMoreRequests')}
      </Button>
    </div>}
    {count > 0 || state.requestsStatus !== 'ready' ? null
      : <DemandEmpty title={t(search === '' ? 'noRequests' : 'noMatchingRequests')}
        detail={t(search === '' ? 'personalRequestsEmptyHint' : 'noMatchingRequestsHint')}
        actionLabel={search === '' ? t('officialCustomization') : undefined} onAction={search === '' ? create : undefined} />}
  </div>
}
