/** Existing private requests, their server stages and unread counts. */
import { useState, type ReactNode } from 'react'
import { Button, Input, Menu, Tooltip, IconPlusOutlineRegular, IconSearchOutlineRegular, IconSlidersTwoOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandDraftSummary, DemandPageState, DemandStatus } from './types.ts'
import {
  DemandEmpty, DemandSkeleton, DemandStatusTag, EngineerAvatar, ServiceProfileAvatar, demandTime, engineerName, type DemandTranslate,
} from './DemandUI.tsx'
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
  const [filterOpen, setFilterOpen] = useState(false)
  const search = query.trim().toLocaleLowerCase()
  const rows = state.requests.filter(request => (status === '' || request.status === status)
    && [request.title, request.number, request.preview, request.engineer?.displayName ?? '', request.serviceProfileName ?? '']
      .join(' ').toLocaleLowerCase().includes(search))
  const statusFilters: readonly DemandStatus[] = ['pending', 'communicating', 'in_progress', 'awaiting_acceptance', 'completed']
  const current = state.conversation
  const draftScopes: readonly DemandDraftSummary[] = current !== null && current.requestId === null
    && !state.drafts.some(row => row.scopeKey === current.scopeKey) ? [...state.drafts, {
      ...current, updatedAt: '',
      pending: state.draft?.scopeKey === current.scopeKey && state.draft.sending,
      error: state.draft?.scopeKey === current.scopeKey ? state.draft.error : null,
    }] : state.drafts
  const draftText = (scopeKey: string) => state.draft?.scopeKey === scopeKey ? state.draft.text.trim() : ''
  const drafts = draftScopes.filter(row => status === ''
    && [row.title, row.engineer?.displayName ?? '', row.serviceProfileName ?? '', draftText(row.scopeKey)]
      .join(' ').toLocaleLowerCase().includes(search))
  const empty = search === '' && status === '' && state.requests.length === 0 && draftScopes.length === 0
  const preview = (title: string, heading: string, text: string, fallback: string) =>
    [title.trim() !== heading && title.trim() !== text.trim() ? title.trim() : '', text.trim()]
      .filter(Boolean).join(' · ') || fallback
  return <aside className={css.inbox} aria-label={t('myRequests')}>
    <div className={css.inboxHeading}><h2>{t('myRequests')}</h2>
      <Button size="sm" variant="outline" onClick={create} icon={<IconPlusOutlineRegular size={14} />}>{t('newRequest')}</Button>
    </div>
    <div className={css.inboxSearch}>
      <Input type="search" aria-label={t('searchRequests')} placeholder={t('searchRequests')} value={query}
        icon={<IconSearchOutlineRegular size={15} />} onChange={(event) => { setQuery(event.target.value) }} />
      <Menu open={filterOpen} portal align="end" selectedId={status || 'all'}
        onClose={() => { setFilterOpen(false) }} items={[
          { id: 'all', label: t('allRequests') },
          ...statusFilters.map(value => ({ id: value, label: <DemandStatusTag status={value} t={t} /> })),
        ]} onSelect={(id) => { setStatus(statusFilters.find(value => value === id) ?? ''); setFilterOpen(false) }}
        anchor={<Tooltip label={t(status === '' ? 'filterRequests' : 'filterRequestsActive')} portal>
          <Button size="sm" className={css.inboxFilter} aria-label={t('filterRequests')} aria-haspopup="menu" aria-expanded={filterOpen}
            aria-pressed={status !== ''} data-active={status !== ''} onClick={() => { setFilterOpen(value => !value) }}
            icon={<IconSlidersTwoOutlineRegular size={16} />} />
        </Tooltip>} />
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
          const title = row.serviceProfileName?.trim() || row.title.trim()
            || (row.assigned === false ? t('platformReception') : engineerName(row.engineer, t))
          const profile = state.serviceProfiles.find(value => value.id === row.serviceProfileId)
          const service = row.serviceProfileId || row.serviceProfileName?.trim() || row.assigned === false
          return <button type="button" key={row.scopeKey} className={css.requestRow} data-selected={selected}
            aria-current={selected ? 'true' : undefined} onClick={() => { openDraft(row.scopeKey) }}>
            {service ? <ServiceProfileAvatar {...(profile ? { profile } : {})} small />
              : <EngineerAvatar engineer={row.engineer} small />}
            <span className={css.requestRowBody}>
              <span className={css.requestRowTop}><strong>{title}</strong>
                <span className={css.draftLabel} data-pending={row.pending}>{t(row.pending ? 'pendingPublish' : 'requestDraft')}</span></span>
              <span className={css.requestRowBottom}>
                <span className={css.requestPreview}>{preview(row.title, title, row.error ?? draftText(row.scopeKey),
                  row.assigned === false ? t('platformReception') : engineerName(row.engineer, t))}</span>
                {row.updatedAt === '' ? null : <time dateTime={row.updatedAt}>{demandTime(row.updatedAt, t)}</time>}
              </span>
            </span>
          </button>
        })}
      </div>}
      {rows.length === 0 ? null : <h3 className={css.listGroupHeading}>{t('publishedRequests')}</h3>}
      {rows.map((request) => {
        const selected = request.id === current?.requestId
        const originalTitle = request.title.trim()
        const title = request.serviceProfileName?.trim() || originalTitle
          || (request.assigned === false ? t('platformReception') : engineerName(request.engineer, t))
        const profile = state.serviceProfiles.find(value => value.id === request.serviceProfileId)
        const service = request.serviceProfileId || request.serviceProfileName?.trim() || request.assigned === false
        return <button type="button" key={request.id} className={css.requestRow} data-selected={selected} aria-current={selected ? 'true' : undefined}
          onClick={() => { open(request.id) }}>
          {service ? <ServiceProfileAvatar {...(profile ? { profile } : {})} small />
            : <EngineerAvatar engineer={request.engineer} small />}
          <span className={css.requestRowBody}>
            <span className={css.requestIdentity}>{t('requestNumber', { number: request.number })}</span>
            <span className={css.requestRowTop}><strong>{title}</strong>
              <span className={css.requestRowContext}>
                <DemandStatusTag status={request.status} unassigned={request.assigned === false} t={t} />
                {request.unreadCount <= 0 ? null : <span className={css.unread}
                  aria-label={t('unreadNamed', { name: originalTitle || title, count: request.unreadCount })}>{request.unreadCount}</span>}
              </span></span>
            <span className={css.requestRowBottom}>
              <span className={css.requestPreview}>{preview(originalTitle, title, request.preview,
                request.assigned === false ? t('platformReception') : engineerName(request.engineer, t))}</span>
              <time dateTime={request.updatedAt}>{demandTime(request.updatedAt, t)}</time>
            </span>
          </span>
        </button>
      })}
      {!state.requestsHaveMore ? null : <div className={css.historyAction}>
        <Button size="sm" variant="outline" disabled={state.loadingMoreRequests} onClick={loadMore}>
          {t(state.loadingMoreRequests ? 'loadingMoreRequests' : 'loadMoreRequests')}
        </Button>
      </div>}
      {rows.length > 0 || drafts.length > 0 || state.requestsStatus !== 'ready' ? null
        : <DemandEmpty title={t(empty ? 'noRequests' : 'noMatchingRequests')}
          detail={t(empty ? state.directoryMode === 'services' ? 'noServiceRequestsHint' : 'noRequestsHint'
            : 'noMatchingRequestsHint')}
          actionLabel={empty ? t(state.directoryMode === 'services' ? 'findServices' : 'findEngineers') : undefined}
          onAction={empty ? create : undefined} />}
    </div>
  </aside>
}
