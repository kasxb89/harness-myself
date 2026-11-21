/** Backend-paged service capabilities enter the platform's central reception queue. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { appPath, Button, Input, Modal, Pill, VideoPlayer, IconPlayOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandPageFace, DemandPageState, DemandServiceMedia } from './types.ts'
import { DemandEmpty, DemandSkeleton, ServiceProfileAvatar, type DemandTranslate } from './DemandUI.tsx'
import css from './DemandPage.module.css'
import mediaCss from './ServiceDirectory.module.css'

function mediaPath(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  try { return appPath(value) }
  catch (_invalidPath: unknown) { return undefined }
}

function ServiceMaterial({ file, t }: { readonly file: DemandServiceMedia; readonly t: DemandTranslate }): ReactNode {
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const src = mediaPath(file.previewUrl)
  if (src === undefined || failed) return <div className={mediaCss.unavailable} role="status">
    <p>{t('serviceMediaUnavailable')}</p>
    {src === undefined ? null : <Button size="sm" variant="outline" onClick={() => { setFailed(false); setAttempt(attempt + 1) }}>
      {t('serviceMediaRetry')}
    </Button>}
  </div>
  return file.kind === 'video'
    ? <VideoPlayer key={attempt} src={src} poster={mediaPath(file.posterUrl)} playsInline preload="metadata"
      aria-label={file.name} onError={() => { setFailed(true) }} />
    : <img key={attempt} src={src} alt={file.name} draggable={false} onError={() => { setFailed(true) }} />
}

function ServiceCover({ src, video, t }: {
  readonly src: string | undefined
  readonly video: boolean
  readonly t: DemandTranslate
}): ReactNode {
  const [failed, setFailed] = useState(false)
  return <>
    {src === undefined || failed ? <span className={mediaCss.coverUnavailable}>{t('serviceMediaUnavailable')}</span>
      : <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => { setFailed(true) }} />}
    {!video ? null : <span className={mediaCss.play} aria-hidden="true"><IconPlayOutlineRegular size={20} /></span>}
  </>
}

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
  const [selection, setSelection] = useState<{ readonly profileId: string; readonly mediaId: string } | null>(null)
  const category = state.serviceCategoryId
  const query = state.serviceQuery
  const initialLoading = state.servicesStatus === 'loading' && state.serviceProfiles.length === 0
  const filtered = query.trim() !== '' || category !== ''
  const selected = state.serviceProfiles.find(profile => profile.id === selection?.profileId)
  const selectedMedia = selected?.media?.find(file => file.id === selection?.mediaId) ?? selected?.media?.[0]
  const close = (): void => { setSelection(null) }
  useEffect(() => { if (scroller.current !== null) scroller.current.scrollTop = 0 }, [query, category])
  return <div ref={scroller} className={css.directory}>
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
    {state.serviceProfiles.length === 0 ? null : <ul className={css.demandCardGrid} aria-label={t('officialCustomization')}>
      {state.serviceProfiles.map((profile) => {
        const name = profile.displayName.trim() || profile.code
        const categories = state.categories.filter(row => profile.categoryIds.includes(row.id))
        const firstMedia = profile.media?.[0]
        const cover = mediaPath(profile.coverUrl) ?? mediaPath(profile.media?.find(file => file.kind === 'image')?.previewUrl)
          ?? mediaPath(firstMedia?.posterUrl)
        return <li key={profile.id} className={clsx(css.demandCard, css.serviceCard)}>
          {firstMedia === undefined ? null : <button type="button" className={mediaCss.cover}
            aria-label={t('servicePreviewNamed', { name })} onClick={() => { setSelection({ profileId: profile.id, mediaId: firstMedia.id }) }}>
            <ServiceCover key={cover} src={cover} video={profile.media?.some(file => file.kind === 'video') === true} t={t} />
          </button>}
          <div className={css.serviceCardIdentity}><ServiceProfileAvatar profile={profile} small />
            <div><h2>{name}</h2><p className={css.serviceDirection}>{profile.serviceDirection}</p></div>
          </div>
          {profile.introduction.trim() === '' ? null : <p className={css.cardExcerpt}>{profile.introduction}</p>}
          {categories.length === 0 ? null : <div className={css.skills}>
            {categories.map(row => <span key={row.id}>{row.label}</span>)}
          </div>}
          <div className={css.cardFooter}>
            <Button size="sm" variant="primary" disabled={!profile.canStart} aria-label={t('startServiceRequestNamed', { name })}
              onClick={() => { start(profile.id) }}>{t(profile.canStart ? 'communicate' : 'notAccepting')}</Button>
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
    <Modal open={selected !== undefined && selectedMedia !== undefined} onClose={close}
      title={selected?.displayName.trim() || selected?.code || t('officialCustomization')} closeLabel={t('close')}
      className={clsx(mediaCss.dialog)} contentClassName={clsx(mediaCss.dialogContent)}>
      {selected === undefined || selectedMedia === undefined ? null : <div className={mediaCss.gallery}>
        <div className={mediaCss.preview}>
          <ServiceMaterial key={`${selected.id}:${selectedMedia.id}:${selectedMedia.previewUrl}`} file={selectedMedia} t={t} />
        </div>
        {(selected.media?.length ?? 0) < 2 ? null : <div className={mediaCss.mediaOptions} role="group" aria-label={t('serviceMaterials')}>
          {selected.media?.map((file, index) => <Button key={file.id} size="sm" variant="outline"
            aria-label={t('serviceMediaIndex', { index: index + 1 })} aria-pressed={selectedMedia.id === file.id}
            onClick={() => { setSelection({ profileId: selected.id, mediaId: file.id }) }}>
            <span className={mediaCss.thumbnail} aria-hidden="true">
              <ServiceCover key={file.previewUrl} src={mediaPath(file.kind === 'image' ? file.previewUrl : file.posterUrl)} video={file.kind === 'video'} t={t} />
            </span>{t('serviceMediaIndex', { index: index + 1 })}
          </Button>)}
        </div>}
        <p className={mediaCss.materialName}>{selectedMedia.name}</p>
        <div className={mediaCss.description}><p>{selected.serviceDirection}</p><p>{selected.introduction}</p></div>
      </div>}
    </Modal>
  </div>
}
