/** A controlled board displays only the authorized normalized rows supplied by its parent. */
import { useId, useState, type ReactNode } from 'react'
import { Button, Input, Pill, Tooltip, IconChevronRightOutlineRegular, IconPlayOutlineRegular,
  IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
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
  'continue-draft': 'continueDraft', 'check-submission': 'confirmPublication', 'check-claim': 'communityCheckClaim',
}
const approvalKeys = {
  pending: 'communityApprovalPending', approved: 'communityApprovalApproved', rejected: 'communityApprovalRejected',
} as const satisfies Readonly<Record<string, DemandLocaleKey>>

function DemandCard({ row, publicView, onOpen, t }: {
  row: CommunityBoardRow
  publicView: boolean
  onOpen: (rowKey: string) => void
  t: DemandTranslate
}): ReactNode {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const cover = row.attachments?.find(item => (item.kind === 'image' || item.kind === 'video') && item.previewUrl)
  const source = cover?.previewUrl ?? undefined
  const showCover = source !== undefined && source !== failedUrl
  const author = row.authorDisplayName?.trim()
  const budget = row.publicBudget?.trim()
  const delivery = row.expectedDeliveryDate?.trim()
  const brief = row.brief?.trim() || row.serviceName
  const disabled = row.disabled === true || row.busy === true
  const open = () => { if (!disabled) onOpen(row.key) }
  return <li className={css.demandCard} data-text-only={!showCover}>
    <article className={css.cardContent}>
      <h2 className={css.cardHeading}><button type="button" className={css.cardMain} disabled={disabled}
        aria-label={row.title} onClick={open}>
        {!showCover ? null : <span className={css.cardCover} aria-hidden="true">
          {cover?.kind === 'image' ? <img src={source} alt="" loading="lazy" decoding="async" draggable={false}
            onError={() => { setFailedUrl(source) }} />
            : <><video src={source} muted playsInline preload="metadata" onError={() => { setFailedUrl(source) }} />
              <span className={css.coverPlay}><IconPlayOutlineRegular size={20} /></span></>}
        </span>}
        <span className={css.cardTitle}>{row.title}</span>
      </button></h2>
      {brief === '' ? null : <p className={css.cardBrief}>{brief}</p>}
      {!budget && !delivery ? null : <div className={css.cardTerms}>
        {!budget ? null : <p className={css.cardBudget}>{budget}</p>}
        {!delivery ? null : <p className={css.cardDelivery}>{t('communityExpectedDelivery')}
          <time dateTime={delivery}>{delivery}</time></p>}
      </div>}
      {publicView || row.approvalStatus === undefined ? null : <div className={css.cardReview}>
        <span>{t(approvalKeys[row.approvalStatus])}</span>
        {row.approvalStatus !== 'rejected' || !row.approvalReason?.trim() ? null
          : <p>{row.approvalReason}</p>}
      </div>}
      <div className={css.cardFooter}>
        {!author ? <span className={css.cardUpdated}>{publicView || row.updatedAt === '' ? null
          : <time dateTime={row.updatedAt}>{demandTime(row.updatedAt, t)}</time>}</span>
          : <span className={css.cardAuthor}><span className={css.authorInitial} aria-hidden="true">{Array.from(author)[0]}</span>
            <span>{author}</span></span>}
        <Button size="sm" variant="ghost" className={css.cardAction} disabled={disabled} aria-busy={row.busy === true}
          aria-label={t('communityBoardActionNamed', { action: t(actionKeys[row.action]), title: row.title })}
          onClick={open}>{t(row.busy ? 'communityBoardWorking' : actionKeys[row.action])}
          <IconChevronRightOutlineRegular size={14} /></Button>
      </div>
      {row.origin !== 'draft' || !row.feedback ? null : <p className={css.cardFeedback} role="status">{row.feedback}</p>}
      {row.origin !== 'acceptance' || row.operation.state !== 'unknown' && row.operation.state !== 'failed' ? null
        : <p className={css.cardFeedback} role={row.operation.state === 'failed' ? 'alert' : 'status'}>
          {row.operation.message}</p>}
    </article>
  </li>
}

/**
 * Show selected split cards without fetching data, inventing counts or resolving routes.
 * @param props - Controlled collection, search, authorized rows, load states and parent commands.
 * @returns A responsive cover board whose actions preserve each parent-owned row key.
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
  approvedPublic?: boolean
  onViewChange: (view: CommunityBoardView) => void
  onSearch: (value: string) => void
  onCreate: () => void
  onOpen: (rowKey: string) => void
  onRetry: () => void
  onLoadMore: () => void
  t: DemandTranslate
}): ReactNode {
  const { view, search, rows, loading, error, hasMore, loadingMore, t } = props
  const [searchOpen, setSearchOpen] = useState(false)
  const searchId = useId()
  const views: readonly CommunityBoardView[] = ['mine', 'public', 'accepted']
  const publicView = view === 'public'
  const showSearch = !publicView || searchOpen || search !== ''
  return <div className={css.board} aria-busy={loading}>
    <div className={css.boardToolbar}>
      <div className={css.boardHeading}>
        <div><h2>{t(publicView ? 'demandSquare' : viewKeys[view])}</h2>
          {!publicView ? null : <p className={css.boardScope}>
            {t(props.approvedPublic === true ? 'communityApprovedListings' : 'communityBoardPublic')}</p>}
        </div>
        <div className={css.boardHeadingActions}>
          {!publicView ? null : <>
            <Tooltip label={t('searchRequests')}><Button size="sm" variant="ghost"
              aria-label={t('searchRequests')} aria-expanded={showSearch} aria-controls={searchId}
              icon={<IconSearchOutlineRegular size={16} />} onClick={() => {
                if (showSearch && search !== '') props.onSearch('')
                setSearchOpen(!showSearch)
              }} /></Tooltip>
            <Button className={css.myRequests} onClick={() => { props.onViewChange('mine') }}>{t('communityBoardMine')}</Button>
          </>}
          <Button className={css.publishAction} variant="accent" disabled={props.canCreate === false} onClick={props.onCreate}>
            {t('communityPublishRequest')}</Button>
        </div>
      </div>
      {publicView ? null : <div className={css.boardFilters} role="group" aria-label={t('communityBoardCollections')}>
        {views.map(value => <Pill key={value} active={view === value} aria-pressed={view === value}
          onClick={() => { props.onViewChange(value) }}>{t(viewKeys[value])}</Pill>)}
      </div>}
      {!showSearch ? null : <div className={css.boardQuery} id={searchId}>
        <div className={css.boardSearch}>
          <Input type="search" value={search} autoFocus={publicView} aria-label={t('searchRequests')} placeholder={t('searchRequests')}
            icon={<IconSearchOutlineRegular size={16} />} onChange={(event) => { props.onSearch(event.target.value) }} />
        </div>
        <span className={pageCss.resultCount} aria-live="polite">{t('communityBoardCount', { count: rows.length })}</span>
      </div>}
    </div>
    {error === null ? null : <div className={pageCss.inlineNotice} role="alert">
      <span>{error}</span><Button size="sm" disabled={loading} onClick={props.onRetry}>{t('retry')}</Button>
    </div>}
    {!loading || rows.length > 0 ? null : <DemandSkeleton compact label={t('loading')} />}
    {rows.length === 0 ? null : <ul className={css.coverGrid} aria-label={t(viewKeys[view])}>
      {rows.map(row => <DemandCard key={row.key} row={row} publicView={publicView} onOpen={props.onOpen} t={t} />)}
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
