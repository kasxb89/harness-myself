/** Community recommendations, explicit search and installation inside the product's main panel. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconLoadingOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
  IconSkillOutlineRegular, Input, LinkIconMedium, Modal, SegmentedTabs,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  InstalledSkill, SkillHubErrorCode, SkillHubInstallResponse,
  SkillHubInstalledResponse, SkillHubSearchResponse, SkillHubSkill,
} from '../types.ts'
import css from './SkillHubPage.module.css'
import { SkillHubPanelIcon } from './SkillHubPanelIcon.tsx'

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

function SkillIcon({ slug }: { slug: string }): ReactNode {
  const tone = Array.from(slug).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4
  return <span className={css.skillIcon} data-tone={tone} aria-hidden="true"><IconSkillOutlineRegular size={22} /></span>
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
    setDiscoverPage(1)
    setSearching(true)
    setSearchError(null)
    try {
      const result = await search(value, request.signal)
      if (!mounted.current || request.signal.aborted || searchRequest.current !== request) return
      if (result.ok) setResults(result.skills)
      else setSearchError(result.code)
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

  const visibleSkills = submitted === null ? recommendations : results
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
        <span className={css.storeIcon} aria-hidden="true"><SkillHubPanelIcon /></span>
        <div className={css.headingCopy}>
          <p className={css.brand}>{t('brand')}</p>
          <h1 className={css.title}>{t('panel')}</h1>
          <p className={css.subtitle}>{t('catalogScale')} · {t('subtitle')}</p>
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
          <span>{t(`error.${searchError}`)}</span>
          {submitted !== null && <Button size="sm" onClick={() => { void runSearch(submitted) }}>{t('retry')}</Button>}
        </div>}
        <div className={css.discoveryHeader}>
          <div className={css.sectionHeading}>
            <h2 className={css.sectionTitle}>{submitted === null ? t('recommendations') : t('results', { query: submitted })}</h2>
            <span className={css.count}>{t('catalogCount', { count: visibleSkills.length })}</span>
          </div>
          {submitted !== null && <Button size="sm" variant="ghost" onClick={showRecommendations}>{t('backToRecommendations')}</Button>}
        </div>
        {submitted === null && recommendationsError !== null && <div className={css.notice} role="alert">
          <span>{t(`error.${recommendationsError}`)}</span>
          <Button size="sm" onClick={() => { void refreshRecommendations(true) }}>{t('retry')}</Button>
        </div>}
        {submitted === null && loadingRecommendations && <div className={css.loading} role="status" aria-label={t('recommendationsLoading')}><IconLoadingOutlineRegular className={css.spinner} /></div>}
        {submitted === null && !loadingRecommendations && recommendationsError === null && recommendations.length === 0 && (
          <div className={css.empty}>
            <IconSkillOutlineRegular size={28} />
            <h2>{t('recommendationsEmpty')}</h2><p>{t('searchHint')}</p>
          </div>
        )}
        {submitted !== null && searching && <div className={css.loading} role="status" aria-label={t('searching')}><IconLoadingOutlineRegular className={css.spinner} /></div>}
        {submitted !== null && !searching && searchError === null && results.length === 0 && <p className={css.empty}>{t('noResults')}</p>}
        <ul className={css.cards}>
          {visibleSkills.slice((currentDiscoverPage - 1) * PAGE_SIZE, currentDiscoverPage * PAGE_SIZE).map((skill) => {
            const state = installs[skill.slug]
            const isInstalled = installed.some(entry => entry.slug === skill.slug) || state?.status === 'installed'
            return <li key={skill.slug} className={css.card}>
              <div className={css.cardHeading}>
                <SkillIcon slug={skill.slug} />
                <div className={css.skillHeading}><h3>{skill.name}</h3><code className={css.slug}>{skill.slug}</code></div>
              </div>
              <p className={css.description}>{skill.description}</p>
              <div className={css.metadataRow}>
                {skill.version !== '' && <p className={css.metadata}>{t('version', { version: skill.version })}</p>}
                <p className={css.metadata}>{t('source', { source: skill.source })}</p>
              </div>
              <div className={css.cardFooter}>
                <Button size="sm" variant="ghost" onClick={() => { setDetails({ kind: 'community', skill }) }}>{t('details')}</Button>
                <Button size="sm" variant={isInstalled ? 'ghost' : 'outline'}
                  disabled={isInstalled || state?.status === 'pending'} onClick={() => { void runInstall(skill) }}>
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
          <span>{t(`error.${installedError}`)}</span>
          <Button size="sm" onClick={() => { void refreshInstalled() }}>{t('retry')}</Button>
        </div>}
        {loadingInstalled && <div className={css.loading} role="status" aria-label={t('installedLoading')}><IconLoadingOutlineRegular className={css.spinner} /></div>}
        {!loadingInstalled && installedError === null && installed.length === 0 && <div className={css.empty}>
          <h2>{t('installedEmpty')}</h2><p>{t('installedHint')}</p>
        </div>}
        <ul className={css.cards}>
          {installed.slice((currentInstalledPage - 1) * PAGE_SIZE, currentInstalledPage * PAGE_SIZE).map(skill => <li key={skill.slug} className={`${css.card} ${css.installedCard}`}>
            <div className={css.cardHeading}>
              <SkillIcon slug={skill.slug} />
              <div className={css.skillHeading}><h3>{skill.name}</h3><code className={css.slug}>{skill.slug}</code></div>
            </div>
            <div className={css.metadataRow}>
              <p className={css.metadata}>{t('version', { version: skill.version })}</p>
              <p className={css.metadata}>{t('source', { source: t('brand') })}</p>
            </div>
            <div className={css.cardFooter}>
              <Button size="sm" variant="ghost" onClick={() => { setDetails({ kind: 'installed', skill }) }}>{t('details')}</Button>
              <span className={css.success}>{t('installedState')}</span>
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
        <h3 className={css.detailName}>{details.skill.name}</h3>
        <div className={css.detailIdentity}><SkillIcon slug={details.skill.slug} /><div>
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
