/** Public deployment notices in the shell's reserved top row. */
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { isBannerDismissed, type AnnouncementBannerInjected, type createAnnouncementDismissalStore } from './announcement-banner-store.ts'
import css from './TopAnnouncementBanner.module.css'

export type TopAnnouncementBannerProps = PropsRuntime<'shell.top'> & PropsLocale<'settings'> & InjectFace<AnnouncementBannerInjected>
  & PropsStore<ReturnType<typeof createAnnouncementDismissalStore>>

/** @param props - Root-scoped viewing preference and independent public reader. @returns One dismissible, motion-aware notice carousel. */
export function TopAnnouncementBanner({ useAnnouncementBanner, useStore, actions, t }: TopAnnouncementBannerProps) {
  const { account, data } = useAnnouncementBanner(value => value)
  const preference = useStore(value => value)
  const [index, setIndex] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const [details, setDetails] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const viewer = data === null ? '' : `${data.scope}:${account}`
  const visible = data?.enabled === true && data.announcements.length > 0 && !isBannerDismissed(preference, viewer, data.revision)
  const total = data?.announcements.length ?? 0
  const item = data?.announcements[index % total]
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => { setReduceMotion(query.matches) }
    query.addEventListener('change', update)
    return () => { query.removeEventListener('change', update) }
  }, [])
  useEffect(() => { setIndex(0); setDetails(false) }, [data?.revision, viewer])
  useEffect(() => {
    if (!visible || paused || details || reduceMotion || total < 2) return undefined
    const timer = setInterval(() => { setIndex(current => (current + 1) % total) }, 6000)
    return () => { clearInterval(timer) }
  }, [visible, paused, details, reduceMotion, total])
  if (!visible || item === undefined) return null
  return <section className={css.banner} aria-label={t('banner.region')}
    onMouseEnter={() => { setHovered(true) }} onMouseLeave={() => { setHovered(false) }}
    onFocusCapture={() => { setFocused(true) }} onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
    }}>
    <span className={css.label}>{t('announcements.title')}</span>
    <button className={css.message} type="button" onClick={() => { setDetails(true) }} title={item.title || item.content}>
      {item.title !== '' && <span className={css.title}>{item.title}</span>}
      {item.title !== item.content && <span className={css.preview}>{item.content}</span>}
    </button>
    {total > 1 && <div className={css.navigation}>
      <button className={css.control} type="button" aria-label={t('banner.previous')}
        onClick={() => { setIndex(current => (current + total - 1) % total) }}>‹</button>
      <span className={css.count} aria-label={t('banner.position', { current: String(index % total + 1), total: String(total) })}>
        {index % total + 1}/{total}
      </span>
      <button className={css.control} type="button" aria-label={t('banner.next')}
        onClick={() => { setIndex(current => (current + 1) % total) }}>›</button>
    </div>}
    <button className={css.control} type="button" aria-label={t('banner.dismiss')}
      onClick={() => { setDetails(false); actions.dismiss(viewer, data.revision) }}>×</button>
    {details && <Modal open title={item.title || t('announcements.title')} closeLabel={t('close')}
      onClose={() => { setDetails(false) }} className={clsx(css.dialog)} contentClassName={clsx(css.dialogContent)}
      footer={<Button onClick={() => { setDetails(false) }}>{t('close')}</Button>}>
      <p className={css.body}>{item.content}</p>
      {item.extra !== '' && <p className={css.body}>{item.extra}</p>}
    </Modal>}
  </section>
}
