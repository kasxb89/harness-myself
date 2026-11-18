/** Existing private requests, their server stages and unread counts. */
import { useState, type ReactNode } from 'react'
import { Button, Input, Pill, IconPlusOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandDraftSummary, DemandPageState, DemandStatus } from './types.ts'
import { DemandEmpty, DemandSkeleton, DemandStatusTag, demandTime, engineerName, type DemandTranslate } from './DemandUI.tsx'
import css from './DemandPage.module.css'

/**
 * Keep saved drafts and requests selectable independently of the current send.
 * @param props - Actual summaries, selection and paging callbacks, and localized labels.
 * @returns A flat scrollable list with recoverable local scopes.
 */
export function DemandInbox(props: {
  state: DemandPageState
  open: (id: string) => void
  openDraft: (scopeKey: string) => void
  create: () => void
  refresh: () => void
  loadMore: () => void
  t: DemandTranslate
}): ReactNode {
  const { state, open, openDraft, create, refresh, loadMore, t } = props
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<DemandStatus | ''>('')
  const search = query.trim().toLocaleLowerCase()
  const rows = state.requests.filter(request => (status === '' || request.status === status)
    && [request.title, request.number, request.preview, request.engineer?.displayName ?? ''].join(' ').toLocaleLowerCase().includes(search))
  const statusFilters: readonly DemandStatus[] = ['pending', 'communicating', 'in_progress', 'awaiting_acceptance', 'completed']
  const current = state.conversation
  const draftScopes: readonly DemandDraftSummary[] = current !== null && current.requestId === null
    && !state.drafts.some(row => row.scopeKey === current.scopeKey) ? [...state.drafts, {
      scopeKey: current.scopeKey, title: current.title, engineer: current.engineer, updatedAt: '',
      pending: state.draft?.scopeKey === current.scopeKey && state.draft.sending,
      error: state.draft?.scopeKey === current.scopeKey ? state.draft.error : null,
    }] : state.drafts
  const drafts = draftScopes.filter(row => [row.title, row.engineer?.displayName ?? ''].join(' ').toLocaleLowerCase().includes(search))
  return <aside className={css.inbox} aria-label={t('myRequests')}>
    <div className={css.inboxHeading}><h2>{t('myRequests')}</h2>
      <Button size="sm" variant="outline" onClick={create} icon={<IconPlusOutlineRegular size={14} />}>{t('newRequest')}</Button>
    </div>
    <Input type="search" aria-label={t('searchRequests')} placeholder={t('searchRequests')} value={query}
      icon={<IconSearchOutlineRegular size={15} />} onChange={(event) => { setQuery(event.target.value) }} />
    <div className={css.inboxFilters}>
      <Pill active={status === ''} aria-pressed={status === ''} onClick={() => { setStatus('') }}>{t('allRequests')}</Pill>
      {statusFilters.map(value => <Pill key={value} active={status === value} aria-pressed={status === value}
        onClick={() => { setStatus(value) }}><DemandStatusTag status={value} t={t} /></Pill>)}
    </div>
    {state.requestsStatus !== 'error' ? null : <div className={css.inlineNotice} role="alert">
      <span>{t('errorHint')}</span><Button size="sm" onClick={refresh}>{t('retry')}</Button>
    </div>}
    <div className={css.requestScroller}>
      {state.requestsStatus === 'loading' && state.requests.length === 0 ? <DemandSkeleton compact label={t('loading')} /> : null}
      {drafts.length === 0 ? null : <div role="group" aria-label={t('draftsGroup')}>
        <h3 className={css.listGroupHeading}>{t('draftsGroup')}</h3>
        {drafts.map((row) => {
          const selected = row.scopeKey === current?.scopeKey
          return <button type="button" key={row.scopeKey} className={css.requestRow} data-selected={selected}
            aria-current={selected ? 'true' : undefined} onClick={() => { openDraft(row.scopeKey) }}>
            <span className={css.requestRowTop}><strong>{row.title.trim() || t('newRequest')}</strong>
              <span className={css.draftLabel} data-pending={row.pending}>{t(row.pending ? 'pendingPublish' : 'notPublished')}</span></span>
            <span className={css.requestRowMeta}><span>{engineerName(row.engineer, t)}</span>
              {row.updatedAt === '' ? null : <time dateTime={row.updatedAt}>{demandTime(row.updatedAt, t)}</time>}</span>
            {row.error === null ? null : <span className={css.draftError}>{row.error}</span>}
          </button>
        })}
      </div>}
      {drafts.length === 0 || rows.length === 0 ? null : <h3 className={css.listGroupHeading}>{t('publishedRequests')}</h3>}
      {rows.map((request) => {
        const selected = request.id === current?.requestId
        const title = request.title.trim() || t('newRequest')
        return <button type="button" key={request.id} className={css.requestRow} data-selected={selected} aria-current={selected ? 'true' : undefined}
          onClick={() => { open(request.id) }}>
          <span className={css.requestRowTop}><strong>{title}</strong>
            {request.unreadCount <= 0 ? null : <span className={css.unread}
              aria-label={t('unreadNamed', { name: title, count: request.unreadCount })}>{request.unreadCount}</span>}</span>
          <span className={css.requestRowMeta}><span>{engineerName(request.engineer, t)}</span>
            <time dateTime={request.updatedAt}>{demandTime(request.updatedAt, t)}</time></span>
          {request.preview.trim() === '' ? null : <span className={css.requestPreview}>{request.preview}</span>}
          <span className={css.requestRowBottom}><DemandStatusTag status={request.status} t={t} />
            <span>{t('requestNumber', { number: request.number })}</span></span>
        </button>
      })}
      {!state.requestsHaveMore ? null : <div className={css.historyAction}>
        <Button size="sm" variant="outline" disabled={state.loadingMoreRequests} onClick={loadMore}>
          {t(state.loadingMoreRequests ? 'loadingMoreRequests' : 'loadMoreRequests')}
        </Button>
      </div>}
      {rows.length > 0 || drafts.length > 0 || state.requestsStatus !== 'ready' ? null
        : <DemandEmpty title={t(state.requests.length === 0 ? 'noRequests' : 'noMatchingRequests')}
          detail={t(state.requests.length === 0 ? 'noRequestsHint' : 'noMatchingRequestsHint')}
          actionLabel={state.requests.length === 0 ? t('findEngineers') : undefined}
          onAction={state.requests.length === 0 ? create : undefined} />}
    </div>
  </aside>
}
