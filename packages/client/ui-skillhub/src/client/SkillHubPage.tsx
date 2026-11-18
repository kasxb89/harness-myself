/** Community recommendations, explicit search and installation inside the product's main panel. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconCheckOutlineRegular, IconLoadingOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
  IconSkillOutlineRegular, IconWarningOutlineRegular, Input, LinkIconMedium, Modal, SegmentedTabs,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  InstalledSkill, SkillHubErrorCode, SkillHubInstallResponse,
  SkillHubInstalledResponse, SkillHubSearchResponse, SkillHubSkill,
} from '../types.ts'
import css from './SkillHubPage.module.css'
import storeArtwork from './assets/skillhub-mark.png'

/** Cancellable Host operations injected into the skill store. */
export interface SkillHubInjected {
  /** Read the official community recommendations without installing anything. */
  readRecommendations: (signal: AbortSignal, refresh?: boolean) => Promise<SkillHubSearchResponse>
  /** Search an explicitly submitted community query. */
  search: (query: string, signal: AbortSignal) => Promise<SkillHubSearchResponse>
  /** Read installed skills without mutating the product. */
  readInstalled: (signal: AbortSignal) => Promise<SkillHubInstalledResponse>
  /** Install a selected slug and invalidate the conversation skill catalog after success. */
  install: (slug: string, signal: AbortSignal) => Promise<SkillHubInstallResponse>
}

type InstallState = { status: 'pending' | 'installed' } | { status: 'failed'; code: SkillHubErrorCode }
type SkillDetails = { kind: 'community'; skill: SkillHubSkill } | { kind: 'installed'; skill: InstalledSkill }

const PAGE_SIZE = 24

function skillName(skill: Pick<InstalledSkill, 'name' | 'slug'>): string {
  return skill.name.trim() || skill.slug
}

function SkillIcon({ slug, name }: { slug: string; name: string }): ReactNode {
  const tone = Array.from(slug).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4
  const words = (name.trim() || slug).split(/[\s/_-]+/u)
  const initials = words.length > 1
    ? words.slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase()
    : Array.from(words[0] ?? slug).slice(0, 2).join('').toUpperCase()
  return <span className={css.skillIcon} data-tone={tone} aria-hidden="true">
    <span className={css.skillInitials}>{initials}</span>
    <IconSkillOutlineRegular className={css.skillMark} size={12} />
  </span>
}

function SkillListSkeleton({ label, installed = false }: { label: string; installed?: boolean }): ReactNode {
  return <div role="status" aria-label={label}>
    <ul className={css.cards} aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => <li key={index} className={`${css.card} ${installed ? css.installedCard : ''}`}>
        <div className={css.cardHeading}>
          <span className={`${css.skeletonFill} ${css.skeletonIcon}`} />
          <div className={css.skillHeading}><span className={`${css.skeletonFill} ${css.skeletonTitle}`} /><span className={`${css.skeletonFill} ${css.skeletonLine}`} /></div>
        </div>
        {!installed && <span className={`${css.skeletonFill} ${css.skeletonDescription}`} />}
        <span className={`${css.skeletonFill} ${css.skeletonLine}`} />
        <div className={css.cardFooter}><span className={`${css.skeletonFill} ${css.skeletonAction}`} /><span className={`${css.skeletonFill} ${css.skeletonAction}`} /></div>
      </li>)}
    </ul>
  </div>
}

/** Locale and operation shares consumed by the main-panel registration. */
export type SkillHubPageProps = SkillHubInjected & PropsLocale<'skillhub'>

/**
 * Render recommended skills, search results and installed skills with independent request lifetimes.
 * @param props - Locale seat and cancellable Host callbacks supplied by registration.
 * @returns The native skill-store page.
 */
export function SkillHubPage({ t, readRecommendations, search, readInstalled, install }: SkillHubPageProps): ReactNode {
  const id = useId()
  const [tab, setTab] = useState<'discover' | 'installed'>('discover')
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [resultQuery, setResultQuery] = useState<string | null>(null)
  const [results, setResults] = useState<readonly SkillHubSkill[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<SkillHubErrorCode | null>(null)
  const [recommendations, setRecommendations] = useState<readonly SkillHubSkill[]>([])
  const [loadingRecommendations, setLoadingRecommendations] = useState(true)
  const [recommendationsError, setRecommendationsError] = useState<SkillHubErrorCode | null>(null)
  const [installed, setInstalled] = useState<readonly InstalledSkill[]>([])
  const [loadingInstalled, setLoadingInstalled] = useState(true)
  const [installedError, setInstalledError] = useState<SkillHubErrorCode | null>(null)
  const [installs, setInstalls] = useState<Record<string, InstallState>>({})
  const [discoverPage, setDiscoverPage] = useState(1)
  const [installedPage, setInstalledPage] = useState(1)
  const [details, setDetails] = useState<SkillDetails | null>(null)
  const mounted = useRef(false)
  const searchRequest = useRef<AbortController | null>(null)
  const recommendationsRequest = useRef<AbortController | null>(null)
  const inventoryRequest = useRef<AbortController | null>(null)
  const installRequests = useRef(new Map<string, AbortController>())

  const refreshRecommendations = useCallback(async (refresh = false) => {
    recommendationsRequest.current?.abort()
    const request = new AbortController()
    recommendationsRequest.current = request
    setLoadingRecommendations(true)
    setRecommendationsError(null)
    try {
      const result = await readRecommendations(request.signal, refresh)
      if (!mounted.current || request.signal.aborted || recommendationsRequest.current !== request) return
      if (result.ok) setRecommendations(result.skills)
      else setRecommendationsError(result.code)
    } catch (_error) {
      if (mounted.current && !request.signal.aborted) setRecommendationsError('unexpected')
    } finally {
      if (mounted.current && !request.signal.aborted && recommendationsRequest.current === request) setLoadingRecommendations(false)
    }
  }, [readRecommendations])

  const refreshInstalled = useCallback(async () => {
    inventoryRequest.current?.abort()
    const request = new AbortController()
    inventoryRequest.current = request
    setLoadingInstalled(true)
    setInstalledError(null)
    try {
      const result = await readInstalled(request.signal)
      if (!mounted.current || request.signal.aborted || inventoryRequest.current !== request) return
      if (result.ok) setInstalled(result.skills)
      else setInstalledError(result.code)
    } catch (_error) {
      if (mounted.current && !request.signal.aborted) setInstalledError('unexpected')
    } finally {
      if (mounted.current && !request.signal.aborted && inventoryRequest.current === request) setLoadingInstalled(false)
    }
  }, [readInstalled])

  useEffect(() => {
    mounted.current = true
    void refreshRecommendations()
    void refreshInstalled()
    const pendingInstalls = installRequests.current
    return () => {
      mounted.current = false
      searchRequest.current?.abort()
      recommendationsRequest.current?.abort()
      inventoryRequest.current?.abort()
      for (const request of pendingInstalls.values()) request.abort()
      pendingInstalls.clear()
    }
  }, [refreshInstalled, refreshRecommendations])

  const showRecommendations = (): void => {
    searchRequest.current?.abort()
    searchRequest.current = null
    setSubmitted(null)
    setResultQuery(null)
    setQuery('')
    setSearching(false)
    setSearchError(null)
    setDiscoverPage(1)
  }

  const runSearch = async (text: string): Promise<void> => {
    const value = text.trim()
    if (value === '') {
      setSearchError('invalid-request')
      return
    }
    searchRequest.current?.abort()
    const request = new AbortController()
    searchRequest.current = request
    setSubmitted(value)
    setSearching(true)
    setSearchError(null)
    try {
      const result = await search(value, request.signal)
      if (!mounted.current || request.signal.aborted || searchRequest.current !== request) return
      if (result.ok) {
        setResults(result.skills)
        setResultQuery(value)
        setDiscoverPage(1)
      } else setSearchError(result.code)
    } catch (_error) {
      if (mounted.current && !request.signal.aborted) setSearchError('unexpected')
    } finally {
      if (mounted.current && !request.signal.aborted && searchRequest.current === request) setSearching(false)
    }
  }

  const runInstall = async (skill: SkillHubSkill): Promise<void> => {
    if (installRequests.current.has(skill.slug)) return
    const request = new AbortController()
    installRequests.current.set(skill.slug, request)
    setInstalls(previous => ({ ...previous, [skill.slug]: { status: 'pending' } }))
    try {
      const result = await install(skill.slug, request.signal)
      if (!mounted.current || request.signal.aborted) return
      if (result.ok) {
        setInstalls(previous => ({ ...previous, [skill.slug]: { status: 'installed' } }))
        setInstalled(previous => [...previous.filter(entry => entry.slug !== result.skill.slug), result.skill])
        void refreshInstalled()
      } else {
        setInstalls(previous => ({ ...previous, [skill.slug]: { status: 'failed', code: result.code } }))
        if (result.code === 'already-installed') void refreshInstalled()
      }
    } catch (_error) {
      if (mounted.current && !request.signal.aborted) setInstalls(previous => ({ ...previous, [skill.slug]: { status: 'failed', code: 'unexpected' } }))
    } finally {
      if (installRequests.current.get(skill.slug) === request) installRequests.current.delete(skill.slug)
    }
  }

  const showingRecommendations = submitted === null || resultQuery === null
  const visibleSkills = showingRecommendations ? recommendations : results
  const discoverPages = Math.max(1, Math.ceil(visibleSkills.length / PAGE_SIZE))
  const installedPages = Math.max(1, Math.ceil(installed.length / PAGE_SIZE))
  const currentDiscoverPage = Math.min(discoverPage, discoverPages)
  const currentInstalledPage = Math.min(installedPage, installedPages)
  const detailState = details === null ? undefined : installs[details.skill.slug]
  const detailInstalled = details !== null && (details.kind === 'installed'
    || installed.some(entry => entry.slug === details.skill.slug) || detailState?.status === 'installed')

  const pagination = (page: number, pages: number, onChange: (page: number) => void): ReactNode => pages <= 1 ? null
    : <nav className={css.pagination} aria-label={t('pagination')}>
      <Button size="sm" variant="outline" disabled={page === 1} onClick={() => { onChange(page - 1) }}>{t('previousPage')}</Button>
      <span aria-live="polite">{t('pageCount', { page, pages })}</span>
      <Button size="sm" variant="outline" disabled={page === pages} onClick={() => { onChange(page + 1) }}>{t('nextPage')}</Button>
    </nav>

  return <section className={css.page} aria-label={t('panel')}>
    <div className={css.content}>
      <header className={css.header}>
        <span className={css.storeIcon} aria-hidden="true"><img src={storeArtwork} alt="" width={56} height={56} /></span>
        <div className={css.headingCopy}>
          <div className={css.headingMeta}><p className={css.brand}>{t('brand')}</p><span className={css.catalogScale}>{t('catalogScale')}</span></div>
          <h1 className={css.title}>{t('panel')}</h1>
          <p className={css.subtitle}>{t('subtitle')}</p>
        </div>
        <a className={css.website} href="https://skillhub.cn/" target="_blank" rel="noreferrer">
          <LinkIconMedium kind="url" href="https://skillhub.cn/" />{t('website')}
        </a>
      </header>
      <SegmentedTabs
        className={css.tabs} value={tab} onChange={setTab} label={t('tabs')}
        items={[
          { value: 'discover', label: t('discover'), id: `${id}-discover`, panelId: `${id}-discover-panel` },
          { value: 'installed', label: t('installed'), id: `${id}-installed`, panelId: `${id}-installed-panel` },
        ]}
      />
      <div role="tabpanel" id={`${id}-discover-panel`} aria-labelledby={`${id}-discover`} hidden={tab !== 'discover'}>
        <form className={css.search} onSubmit={(event) => { event.preventDefault(); void runSearch(query) }}>
          <div className={css.searchInput}>
            <Input
              icon={<IconSearchOutlineRegular />} aria-label={t('searchLabel')}
              placeholder={t('searchPlaceholder')} value={query} onChange={(event) => { setQuery(event.target.value) }}
            />
          </div>
          <Button type="submit" variant="primary" disabled={query.trim() === ''}>{t('search')}</Button>
        </form>
        {searchError !== null && <div className={css.notice} role="alert">
          <IconWarningOutlineRegular size={18} aria-hidden="true" />
          <span>{t(`error.${searchError}`)}</span>
          {submitted !== null && <Button size="sm" onClick={() => { void runSearch(submitted) }}>{t('retry')}</Button>}
        </div>}
        <div className={css.discoveryHeader}>
          <div className={css.sectionHeading}>
            <h2 className={css.sectionTitle}>{showingRecommendations ? t('recommendations') : t('results', { query: resultQuery })}</h2>
            <span className={css.count}>{t('catalogCount', { count: visibleSkills.length })}</span>
          </div>
          {submitted !== null && <Button size="sm" variant="ghost" onClick={showRecommendations}>{t('backToRecommendations')}</Button>}
        </div>
        {submitted === null && recommendationsError !== null && <div className={css.notice} role="alert" data-empty={recommendations.length === 0}>
          <span className={css.noticeIcon} aria-hidden="true"><IconWarningOutlineRegular size={22} /></span>
          <span>{t(`error.${recommendationsError}`)}</span>
          <Button size="sm" onClick={() => { void refreshRecommendations(true) }}>{t('retry')}</Button>
        </div>}
        {submitted === null && loadingRecommendations && (recommendations.length === 0
          ? <SkillListSkeleton label={t('recommendationsLoading')} />
          : <div className={css.loading} role="status" aria-label={t('recommendationsLoading')}><IconLoadingOutlineRegular className={css.spinner} /></div>)}
        {submitted === null && !loadingRecommendations && recommendationsError === null && recommendations.length === 0 && (
          <div className={css.empty}>
            <IconSkillOutlineRegular size={28} />
            <h2>{t('recommendationsEmpty')}</h2><p>{t('searchHint')}</p>
          </div>
        )}
        {submitted !== null && searching && (visibleSkills.length === 0
          ? <SkillListSkeleton label={t('searching')} />
          : <div className={css.loading} role="status" aria-label={t('searching')}><IconLoadingOutlineRegular className={css.spinner} /></div>)}
        {submitted !== null && !searching && searchError === null && results.length === 0 && <p className={css.empty}>{t('noResults')}</p>}
        <ul className={css.cards}>
          {visibleSkills.slice((currentDiscoverPage - 1) * PAGE_SIZE, currentDiscoverPage * PAGE_SIZE).map((skill) => {
            const state = installs[skill.slug]
            const isInstalled = installed.some(entry => entry.slug === skill.slug) || state?.status === 'installed'
            return <li key={skill.slug} className={css.card}>
              <div className={css.cardHeading}>
                <SkillIcon slug={skill.slug} name={skillName(skill)} />
                <div className={css.skillHeading}><h3>{skillName(skill)}</h3><code className={css.slug}>{skill.slug}</code></div>
              </div>
              <p className={css.description}>{skill.description}</p>
              <div className={css.metadataRow}>
                {skill.version !== '' && <p className={css.metadata}>{t('version', { version: skill.version })}</p>}
                <p className={css.metadata}>{t('source', { source: skill.source })}</p>
              </div>
              <div className={css.cardFooter}>
                <Button size="sm" variant="ghost" className={css.cardOpen} onClick={() => { setDetails({ kind: 'community', skill }) }}>{t('details')}</Button>
                <Button size="sm" variant={isInstalled ? 'ghost' : 'outline'}
                  disabled={isInstalled || state?.status === 'pending'} onClick={() => { void runInstall(skill) }}>
                  {isInstalled && <IconCheckOutlineRegular size={14} aria-hidden="true" />}
                  {isInstalled ? t('installedState') : state?.status === 'pending' ? t('installing') : t('install')}
                </Button>
              </div>
              {state?.status === 'failed' && <p className={css.error} role="alert">{t(`error.${state.code}`)}</p>}
            </li>
          })}
        </ul>
        {pagination(currentDiscoverPage, discoverPages, setDiscoverPage)}
      </div>
      <div role="tabpanel" id={`${id}-installed-panel`} aria-labelledby={`${id}-installed`} hidden={tab !== 'installed'}>
        <div className={css.installedHeader}>
          <div className={css.sectionHeading}>
            <h2 className={css.sectionTitle}>{t('installedTitle')}</h2>
            <span className={css.count}>{t('catalogCount', { count: installed.length })}</span>
          </div>
          <Button size="sm" icon={<IconRefreshOutlineRegular />} onClick={() => { void refreshInstalled() }}>{t('refreshInstalled')}</Button>
        </div>
        {installedError !== null && <div className={css.notice} role="alert">
          <IconWarningOutlineRegular size={18} aria-hidden="true" />
          <span>{t(`error.${installedError}`)}</span>
          <Button size="sm" onClick={() => { void refreshInstalled() }}>{t('retry')}</Button>
        </div>}
        {loadingInstalled && (installed.length === 0
          ? <SkillListSkeleton label={t('installedLoading')} installed />
          : <div className={css.loading} role="status" aria-label={t('installedLoading')}><IconLoadingOutlineRegular className={css.spinner} /></div>)}
        {!loadingInstalled && installedError === null && installed.length === 0 && <div className={css.empty}>
          <span className={css.emptyIcon} aria-hidden="true"><IconSkillOutlineRegular size={26} /></span>
          <h2>{t('installedEmpty')}</h2><p>{t('installedHint')}</p>
          <Button size="sm" variant="outline" onClick={() => { setTab('discover') }}>{t('discover')}</Button>
        </div>}
        <ul className={css.cards}>
          {installed.slice((currentInstalledPage - 1) * PAGE_SIZE, currentInstalledPage * PAGE_SIZE).map(skill => <li key={skill.slug} className={`${css.card} ${css.installedCard}`}>
            <div className={css.cardHeading}>
              <SkillIcon slug={skill.slug} name={skillName(skill)} />
              <div className={css.skillHeading}><h3>{skillName(skill)}</h3><code className={css.slug}>{skill.slug}</code></div>
            </div>
            <div className={css.metadataRow}>
              <p className={css.metadata}>{t('version', { version: skill.version })}</p>
              <p className={css.metadata}>{t('source', { source: t('brand') })}</p>
            </div>
            <div className={css.cardFooter}>
              <Button size="sm" variant="ghost" className={css.cardOpen} onClick={() => { setDetails({ kind: 'installed', skill }) }}>{t('details')}</Button>
              <span className={css.success}><IconCheckOutlineRegular size={14} aria-hidden="true" />{t('installedState')}</span>
            </div>
          </li>)}
        </ul>
        {pagination(currentInstalledPage, installedPages, setInstalledPage)}
      </div>
    </div>
    <Modal open={details !== null} onClose={() => { setDetails(null) }} title={t('skillDetails')}
      closeLabel={t('closeDetails')} className={css.detailsDialog as string} contentClassName={css.detailsContent as string}
      footer={details?.kind === 'community' && <Button variant={detailInstalled ? 'ghost' : 'primary'}
        disabled={detailInstalled || detailState?.status === 'pending'} onClick={() => { void runInstall(details.skill) }}>
        {detailInstalled ? t('installedState') : detailState?.status === 'pending' ? t('installing') : t('install')}
      </Button>}>
      {details !== null && <>
        <h3 className={css.detailName}>{skillName(details.skill)}</h3>
        <div className={css.detailIdentity}><SkillIcon slug={details.skill.slug} name={skillName(details.skill)} /><div>
          <span className={css.detailLabel}>{t('skillIdentifier')}</span><code className={css.detailSlug}>{details.skill.slug}</code>
        </div></div>
        <div className={css.detailMetadata}>
          {details.skill.version !== '' && <p>{t('version', { version: details.skill.version })}</p>}
          <p>{t('source', { source: details.kind === 'community' ? details.skill.source : t('brand') })}</p>
        </div>
        {details.kind === 'community' && <div className={css.detailDescription}>
          <h3>{t('description')}</h3><p>{details.skill.description}</p>
        </div>}
        {detailState?.status === 'failed' && <p className={css.error} role="alert">{t(`error.${detailState.code}`)}</p>}
      </>}
    </Modal>
  </section>
}
