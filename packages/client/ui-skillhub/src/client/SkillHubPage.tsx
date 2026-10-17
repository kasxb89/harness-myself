/** Community recommendations, explicit search and installation inside the product's main panel. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconLoadingOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
  IconSkillOutlineRegular, Input, LinkIconMedium, SegmentedTabs,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  InstalledSkill, SkillHubErrorCode, SkillHubInstallResponse,
  SkillHubInstalledResponse, SkillHubSearchResponse, SkillHubSkill,
} from '../types.ts'
import css from './SkillHubPage.module.css'

/** Cancellable Host operations injected into the skill store. */
export interface SkillHubInjected {
  /** Read the official community recommendations without installing anything. */
  readRecommendations: (signal: AbortSignal) => Promise<SkillHubSearchResponse>
  /** Search an explicitly submitted community query. */
  search: (query: string, signal: AbortSignal) => Promise<SkillHubSearchResponse>
  /** Read installed skills without mutating the product. */
  readInstalled: (signal: AbortSignal) => Promise<SkillHubInstalledResponse>
  /** Install a selected slug and invalidate the conversation skill catalog after success. */
  install: (slug: string, signal: AbortSignal) => Promise<SkillHubInstallResponse>
}

type InstallState = { status: 'pending' | 'installed' } | { status: 'failed'; code: SkillHubErrorCode }

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
  const mounted = useRef(false)
  const searchRequest = useRef<AbortController | null>(null)
  const recommendationsRequest = useRef<AbortController | null>(null)
  const inventoryRequest = useRef<AbortController | null>(null)
  const installRequests = useRef(new Map<string, AbortController>())

  const refreshRecommendations = useCallback(async () => {
    recommendationsRequest.current?.abort()
    const request = new AbortController()
    recommendationsRequest.current = request
    setLoadingRecommendations(true)
    setRecommendationsError(null)
    try {
      const result = await readRecommendations(request.signal)
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

  return <section className={css.page} aria-label={t('panel')}>
    <header className={css.header}>
      <div>
        <p className={css.brand}>{t('brand')}</p>
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
        <span>{t(`error.${searchError}`)}</span>
        {submitted !== null && <Button size="sm" onClick={() => { void runSearch(submitted) }}>{t('retry')}</Button>}
      </div>}
      <div className={css.discoveryHeader}>
        <h2 className={css.sectionTitle}>{submitted === null ? t('recommendations') : t('results', { query: submitted })}</h2>
        {submitted !== null && <Button size="sm" variant="ghost" onClick={showRecommendations}>{t('backToRecommendations')}</Button>}
      </div>
      {submitted === null && recommendationsError !== null && <div className={css.notice} role="alert">
        <span>{t(`error.${recommendationsError}`)}</span>
        <Button size="sm" onClick={() => { void refreshRecommendations() }}>{t('retry')}</Button>
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
        {visibleSkills.map((skill) => {
          const state = installs[skill.slug]
          const isInstalled = installed.some(entry => entry.slug === skill.slug) || state?.status === 'installed'
          return <li key={skill.slug} className={css.card}>
            <div className={css.cardHeading}><IconSkillOutlineRegular /><h3>{skill.name}</h3></div>
            <p className={css.description}>{skill.description}</p>
            {skill.version !== '' && <p className={css.metadata}>{t('version', { version: skill.version })}</p>}
            <p className={css.metadata}>{t('source', { source: skill.source })}</p>
            <div className={css.cardFooter}>
              <code className={css.slug}>{skill.slug}</code>
              <Button size="sm" variant={isInstalled ? 'ghost' : 'outline'}
                disabled={isInstalled || state?.status === 'pending'} onClick={() => { void runInstall(skill) }}>
                {isInstalled ? t('installedState') : state?.status === 'pending' ? t('installing') : t('install')}
              </Button>
            </div>
            {isInstalled && <span className={css.success} role="status">{t('installedState')}</span>}
            {state?.status === 'failed' && <p className={css.error} role="alert">{t(`error.${state.code}`)}</p>}
          </li>
        })}
      </ul>
    </div>
    <div role="tabpanel" id={`${id}-installed-panel`} aria-labelledby={`${id}-installed`} hidden={tab !== 'installed'}>
      <div className={css.installedHeader}>
        <h2 className={css.sectionTitle}>{t('installedTitle')}</h2>
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
        {installed.map(skill => <li key={skill.slug} className={css.card}>
          <div className={css.cardHeading}><IconSkillOutlineRegular /><h3>{skill.name}</h3></div>
          <p className={css.metadata}>{t('version', { version: skill.version })}</p>
          <p className={css.metadata}>{t('source', { source: t('brand') })}</p>
          <div className={css.cardFooter}><code className={css.slug}>{skill.slug}</code><span className={css.success}>{t('installedState')}</span></div>
        </li>)}
      </ul>
    </div>
  </section>
}
