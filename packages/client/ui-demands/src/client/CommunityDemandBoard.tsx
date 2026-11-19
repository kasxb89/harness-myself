/** A controlled board displays only the authorized normalized rows supplied by its parent. */
import type { ReactNode } from 'react'
import { Button, Input, Pill, IconPlusOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommunityBoardAction, CommunityBoardRow, CommunityBoardView } from './community-view.ts'
import type { DemandLocaleKey } from './locales.ts'
import { DemandEmpty, DemandSkeleton, demandTime, type DemandTranslate } from './DemandUI.tsx'
import pageCss from './DemandPage.module.css'
import css from './CommunityDemand.module.css'

const viewKeys: Record<CommunityBoardView, DemandLocaleKey> = {
  mine: 'communityBoardMine', public: 'communityBoardPublic', accepted: 'communityBoardAccepted',
}
const emptyKeys: Record<CommunityBoardView, DemandLocaleKey> = {
  mine: 'communityBoardMineEmpty', public: 'communityBoardPublicEmpty', accepted: 'communityBoardAcceptedEmpty',
}
const actionKeys: Record<CommunityBoardAction, DemandLocaleKey> = {
  'view-demand': 'communityViewDemand', communicate: 'communicate', view: 'communityView',
  'continue-draft': 'continueDraft', 'check-submission': 'confirmPublication',
}

/**
 * Show selected split cards without fetching data, inventing counts or resolving routes.
 * @param props - Controlled collection, search, authorized rows, load states and parent commands.
 * @returns A two-column board whose actions preserve each parent-owned row key.
 */
export function CommunityDemandBoard(props: {
  view: CommunityBoardView
  search: string
  rows: readonly CommunityBoardRow[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  canCreate?: boolean
  onViewChange: (view: CommunityBoardView) => void
  onSearch: (value: string) => void
  onCreate: () => void
  onOpen: (rowKey: string) => void
  onRetry: () => void
  onLoadMore: () => void
  t: DemandTranslate
}): ReactNode {
  const { view, search, rows, loading, error, hasMore, loadingMore, t } = props
  const views: readonly CommunityBoardView[] = ['mine', 'public', 'accepted']
  return <div className={pageCss.directory} aria-busy={loading}>
    <div className={css.boardToolbar}>
      <div className={pageCss.cardsToolbar}>
        <div className={css.boardFilters} role="group" aria-label={t('communityBoardCollections')}>
          {views.map(value => <Pill key={value} active={view === value} aria-pressed={view === value}
            onClick={() => { props.onViewChange(value) }}>{t(viewKeys[value])}</Pill>)}
        </div>
        <Button size="sm" variant="outline" disabled={props.canCreate === false}
          icon={<IconPlusOutlineRegular size={14} />} onClick={props.onCreate}>
          {t('newRequest')}</Button>
      </div>
      <div className={pageCss.cardsToolbar}>
        <div className={pageCss.searchField}>
          <Input type="search" value={search} aria-label={t('searchRequests')} placeholder={t('searchRequests')}
            icon={<IconSearchOutlineRegular size={16} />} onChange={(event) => { props.onSearch(event.target.value) }} />
        </div>
        <span className={pageCss.resultCount} aria-live="polite">{t('communityBoardCount', { count: rows.length })}</span>
      </div>
    </div>
    {error === null ? null : <div className={pageCss.inlineNotice} role="alert">
      <span>{error}</span><Button size="sm" disabled={loading} onClick={props.onRetry}>{t('retry')}</Button>
    </div>}
    {!loading || rows.length > 0 ? null : <DemandSkeleton compact label={t('loading')} />}
    {rows.length === 0 ? null : <ul className={pageCss.personalCardGrid} aria-label={t(viewKeys[view])}>
      {rows.map(row => <li key={row.key} className={pageCss.personalCard}>
        <div className={pageCss.personalCardBody}>
          <h2>{row.title}</h2><p>{row.serviceName}</p>
          {row.updatedAt === '' ? null : <time dateTime={row.updatedAt}>{demandTime(row.updatedAt, t)}</time>}
          {row.origin !== 'draft' || !row.feedback ? null
            : <p className={pageCss.personalCardFeedback} role="status">{row.feedback}</p>}
        </div>
        <div className={pageCss.personalCardAction}>
          <Button variant="primary" disabled={row.disabled || row.busy} aria-busy={row.busy === true}
            aria-label={t('communityBoardActionNamed', { action: t(actionKeys[row.action]), title: row.title })}
            onClick={() => { props.onOpen(row.key) }}>{t(row.busy ? 'communityBoardWorking' : actionKeys[row.action])}</Button>
        </div>
      </li>)}
    </ul>}
    {!hasMore ? null : <div className={pageCss.historyAction}>
      <Button size="sm" variant="outline" disabled={loadingMore || loading} onClick={props.onLoadMore}>
        {t(loadingMore ? 'loadingMoreRequests' : 'loadMoreRequests')}</Button>
    </div>}
    {loading || error !== null || rows.length > 0 ? null
      : <DemandEmpty title={t(search.trim() === '' ? emptyKeys[view] : 'noMatchingRequests')}
        detail={t('communityBoardEmptyHint')} />}
  </div>
}
