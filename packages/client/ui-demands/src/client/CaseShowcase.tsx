/** Configured public materials are displayed separately from customer request publications. */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { appPath, Button, IconPlayOutlineRegular, LinkIconMedium, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CaseShowcaseCategory, CaseShowcaseItem } from './case-showcase-types.ts'
import { DemandEmpty, type DemandTranslate } from './DemandUI.tsx'
import css from './CaseShowcase.module.css'

const categories: readonly CaseShowcaseCategory[] = ['pc', 'web', 'miniapp', 'exe', 'game', 'image', 'video']
const categoryLabels = {
  pc: 'showcaseCategoryPc', web: 'showcaseCategoryWeb', miniapp: 'showcaseCategoryMiniapp',
  exe: 'showcaseCategoryExe', game: 'showcaseCategoryGame', image: 'showcaseCategoryImage', video: 'showcaseCategoryVideo',
} as const

function materialUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  if (value.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u0020]/u.test(value)) return appPath(value)
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') return undefined
    if (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.href
  } catch { /* Invalid publication metadata never becomes an executable URL. */ }
  return undefined
}

/**
 * Browse only supplied case records and preview their original images and videos.
 * @param props - Public presentation metadata and the owning locale translator.
 * @returns Category filters, material cards and one dismissible media preview.
 */
export function CaseShowcase({ items, t }: { readonly items: readonly CaseShowcaseItem[]; readonly t: DemandTranslate }): ReactNode {
  const [category, setCategory] = useState<CaseShowcaseCategory | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mediaIndex, setMediaIndex] = useState(0)
  const available = categories.filter(value => items.some(item => item.category === value))
  const currentCategory = category !== null && available.includes(category) ? category : null
  const rows = currentCategory === null ? items : items.filter(item => item.category === currentCategory)
  const selected = items.find(item => item.id === selectedId)
  const media = selected?.media[mediaIndex] ?? selected?.media[0]
  const previewUrl = materialUrl(media?.url)
  const sourceUrl = materialUrl(selected?.sourceUrl)
  const close = (): void => { setSelectedId(null) }
  return <section className={css.showcase} aria-label={t('showcaseTab')}>
    <header className={css.heading}><div><h2>{t('showcaseTab')}</h2><p>{t('showcaseDescription')}</p></div>
      <span className={css.count}>{t('showcaseCount', { count: rows.length })}</span>
    </header>
    {available.length === 0 ? null : <div className={css.filters} role="group" aria-label={t('showcaseCategories')}>
      <Pill active={currentCategory === null} aria-pressed={currentCategory === null} onClick={() => { setCategory(null) }}>{t('showcaseAll')}</Pill>
      {available.map(value => <Pill key={value} active={currentCategory === value} aria-pressed={currentCategory === value}
        onClick={() => { setCategory(value) }}>{t(categoryLabels[value])}</Pill>)}
    </div>}
    <div className={css.viewport}>
      {rows.length === 0 ? <DemandEmpty title={t('showcaseEmpty')} detail={t('showcaseEmptyHint')} /> : <ul className={css.grid} aria-label={t('showcaseTab')}>
        {rows.map((item) => {
          const coverUrl = materialUrl(item.coverUrl)
          const video = item.media.some(file => file.kind === 'video')
          return <li key={item.id} className={css.card}><button type="button" className={css.open}
            aria-label={t('showcasePreviewNamed', { title: item.title })} onClick={() => { setSelectedId(item.id); setMediaIndex(0) }}>
            <span className={css.cover}>
              {coverUrl === undefined ? null : <img src={coverUrl} alt="" loading="lazy" decoding="async" draggable={false} />}
              <span className={css.category}>{t(categoryLabels[item.category])}</span>
              {!video ? null : <span className={css.play} aria-hidden="true"><IconPlayOutlineRegular size={20} /></span>}
            </span>
            <span className={css.copy}><span className={css.title}>{item.title}</span>
              <span className={css.description}>{item.description}</span>
              <span className={css.cardFooter}><span>{item.sourceName}</span><span>{t('showcaseMediaCount', { count: item.media.length })}</span></span>
            </span>
          </button></li>
        })}
      </ul>}
    </div>
    <Modal open={selected !== undefined} onClose={close} title={selected?.title ?? t('showcaseTab')} closeLabel={t('close')}
      className={clsx(css.dialog)} contentClassName={clsx(css.dialogContent)} footer={<div className={css.footer}>
        {sourceUrl === undefined ? null : <a className={css.source} href={sourceUrl} target="_blank" rel="noopener noreferrer">
          <LinkIconMedium kind="url" href={sourceUrl} />{t('showcaseSource')}</a>}
        <Button onClick={close}>{t('close')}</Button>
      </div>}>
      {selected === undefined ? null : <>
        <div className={css.preview}>
          {previewUrl === undefined ? <DemandEmpty title={t('showcaseUnavailable')} detail={t('showcaseEmptyHint')} /> : media?.kind === 'video'
            ? <video key={previewUrl} src={previewUrl} poster={materialUrl(media.posterUrl)} controls playsInline preload="metadata" aria-label={selected.title} />
            : <img key={previewUrl} src={previewUrl} alt={selected.title} draggable={false} />}
        </div>
        {selected.media.length < 2 ? null : <div className={css.mediaOptions} role="group" aria-label={t('showcaseMaterials')}>
          {selected.media.map((file, index) => <Button key={`${file.url}:${index}`} size="sm" variant="outline"
            aria-pressed={mediaIndex === index} onClick={() => { setMediaIndex(index) }}>
            {file.kind !== 'video' ? null : <IconPlayOutlineRegular size={14} />}
            {t('showcaseMediaIndex', { index: index + 1 })}
          </Button>)}
        </div>}
        <div className={css.caption}><p>{selected.description}</p>
          {!selected.sourceName && !selected.attribution ? null : <div className={css.attribution}>
            {selected.sourceName ? <p><span>{t('showcaseAttribution')}</span>{selected.sourceName}</p> : null}
            {selected.attribution ? <p>{selected.attribution}</p> : null}
          </div>}
        </div>
      </>}
    </Modal>
  </section>
}
