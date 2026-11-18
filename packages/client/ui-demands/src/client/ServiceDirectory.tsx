/** Backend-paged service capabilities enter the platform's central reception queue. */
import { useEffect, useRef, type ReactNode } from 'react'
import { Button, Input, Pill, IconSearchOutlineRegular, IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandPageFace, DemandPageState } from './types.ts'
import { DemandEmpty, DemandSkeleton, ServiceProfileAvatar, type DemandTranslate } from './DemandUI.tsx'
import css from './DemandPage.module.css'

/**
 * Browse actual published services with server-owned search, counts and pagination.
 * @param props - Catalog projection, target-specific commands and localized copy.
 * @returns The service directory without fabricated people or presence.
 */
export function ServiceDirectory(props: {
  state: DemandPageState
  start: DemandPageFace['startServiceRequest']
  filter: DemandPageFace['setServiceFilter']
  loadMore: DemandPageFace['loadMoreServices']
  refresh: DemandPageFace['refresh']
  t: DemandTranslate
}): ReactNode {
  const { state, start, filter, loadMore, refresh, t } = props
  const scroller = useRef<HTMLDivElement>(null)
  const category = state.serviceCategoryId
  const query = state.serviceQuery
  const initialLoading = state.servicesStatus === 'loading' && state.serviceProfiles.length === 0
  const filtered = query.trim() !== '' || category !== ''
  useEffect(() => { if (scroller.current !== null) scroller.current.scrollTop = 0 }, [query, category])
  return <div ref={scroller} className={css.directory}>
    <p className={css.routingNote}><IconChecklistOutlineRegular size={16} /><span>{t('platformRoutingHint')}</span></p>
    <div className={css.directoryToolbar}>
      <div className={css.searchField}>
        <Input type="search" value={query} maxLength={100} aria-label={t('searchServices')} placeholder={t('searchServices')}
          onChange={(event) => { filter(event.target.value, category) }} icon={<IconSearchOutlineRegular size={16} />} />
        {query === '' ? null : <Button size="sm" onClick={() => { filter('', category) }}>{t('clearSearch')}</Button>}
      </div>
      {initialLoading || state.servicesStatus === 'error' && state.serviceProfiles.length === 0 ? null
        : <span className={css.resultCount} aria-live="polite">{t('serviceCount', { count: state.servicesTotal })}</span>}
    </div>
    {state.categories.length === 0 ? null : <div className={css.filters}>
      <Pill active={category === ''} aria-pressed={category === ''} onClick={() => { filter(query, '') }}>{t('allCategories')}</Pill>
      {state.categories.map(row => <Pill key={row.id} active={category === row.id} aria-pressed={category === row.id}
        onClick={() => { filter(query, row.id) }}>{row.label}</Pill>)}
    </div>}
    {state.servicesStatus !== 'error' ? null : <div className={css.inlineNotice} role="alert">
      <span>{t('serviceLoadFailed')}</span><Button size="sm" onClick={refresh}>{t('retry')}</Button>
    </div>}
    {initialLoading ? <DemandSkeleton label={t('loading')} /> : null}
    {state.serviceProfiles.length === 0 ? null : <ul className={css.engineerGrid}>
      {state.serviceProfiles.map((profile) => {
        const name = profile.displayName.trim() || profile.code
        const categories = state.categories.filter(row => profile.categoryIds.includes(row.id))
        return <li key={profile.id} className={css.engineerCard}>
          <div className={css.engineerIdentity}><ServiceProfileAvatar profile={profile} />
            <div><h2>{name}</h2><p className={css.serviceDirection}>{profile.serviceDirection}</p></div>
          </div>
          {profile.introduction.trim() === '' ? null : <p className={css.engineerIntro}>{profile.introduction}</p>}
          {categories.length === 0 ? null : <div className={css.skills}>
            {categories.map(row => <span key={row.id}>{row.label}</span>)}
          </div>}
          <div className={css.engineerAction}>
            <Button variant="outline" disabled={!profile.canStart} aria-label={t('startServiceRequestNamed', { name })}
              onClick={() => { start(profile.id) }}>{t(profile.canStart ? 'startServiceRequest' : 'notAccepting')}</Button>
          </div>
        </li>
      })}
    </ul>}
    {!state.servicesHaveMore ? null : <div className={css.historyAction}>
      <Button size="sm" variant="outline" disabled={state.loadingMoreServices || state.servicesStatus === 'loading'} onClick={loadMore}>
        {t(state.loadingMoreServices ? 'loadingMoreServices' : 'loadMoreServices')}
      </Button>
    </div>}
    {state.servicesStatus !== 'ready' || state.serviceProfiles.length > 0 ? null
      : <DemandEmpty title={t(filtered ? 'noMatchingServices' : 'noServices')}
        detail={t(filtered ? 'noMatchingServicesHint' : 'noServicesHint')} />}
  </div>
}
