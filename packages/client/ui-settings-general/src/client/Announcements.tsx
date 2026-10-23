/** Sidebar announcement access and a plain-text, request-owned dialog. */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button, IconInfoOutlineRegular, IconLoadingOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type { AnnouncementRead } from './announcement-reader.ts'
import actionCss from './DesktopUpdateCheck.module.css'
import css from './Announcements.module.css'

/** Dialog-owned request capability; content is not shared with other features. */
export interface AnnouncementsInjected {
  readonly readAnnouncements: (signal: AbortSignal) => Promise<AnnouncementRead>
  readonly hooks: { readonly announcementLocale: ObservableSnapshot<LocaleSnapshot> }
}

/** Sidebar geometry, current locale, and the registered read capability. */
export type AnnouncementsProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'settings'> & InjectFace<AnnouncementsInjected>

type Failure = Extract<AnnouncementRead, { ok: false }>['reason']
interface Reading {
  readonly payload: Extract<AnnouncementRead, { ok: true }> | null
  readonly failure: Failure | null
  readonly loading: boolean
}

/**
 * Open announcements below the update action; closing aborts the active read and discards its content.
 * @param props - Sidebar geometry, localized labels, and Host read capability.
 * @returns The sidebar control and its viewport-bounded dialog.
 */
export function Announcements({ wide, t, readAnnouncements, useAnnouncementLocale }: AnnouncementsProps) {
  const locale = useAnnouncementLocale(value => value.active)
  const dateFormat = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : locale, { dateStyle: 'medium', timeStyle: 'short' })
  const [open, setOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [reading, setReading] = useState<Reading>({ payload: null, failure: null, loading: true })
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void readAnnouncements(controller.signal).then((result) => {
      if (!controller.signal.aborted) setReading(previous => result.ok
        ? { payload: result, failure: null, loading: false }
        : { payload: result.reason === 'account-changed' ? null : previous.payload, failure: result.reason, loading: false })
    })
    return () => { controller.abort() }
  }, [open, readAnnouncements, revision])
  const close = (): void => { setOpen(false); setReading({ payload: null, failure: null, loading: true }) }
  const refresh = (): void => {
    setReading(previous => ({ ...previous, failure: null, loading: true }))
    setRevision(value => value + 1)
  }
  const failures: Record<Failure, string> = {
    unsupported: t('announcements.unsupported'), network: t('announcements.network'),
    unavailable: t('announcements.unavailable'), invalid: t('announcements.invalid'),
    authorization: t('announcements.authorization'), 'account-changed': t('announcements.accountChanged'),
  }
  return <>
    <Tooltip label={t('announcements.title')} side="right" portal>
      <button type="button" className={clsx(actionCss.button, actionCss.sidebar, !wide && actionCss.rail)}
        aria-label={t('announcements.title')} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true) }}>
        <IconInfoOutlineRegular size={wide ? 16 : 20} />
        <span className={wide ? actionCss.label : actionCss.railLabel}>{t('announcements.title')}</span>
      </button>
    </Tooltip>
    <Modal open={open} title={t('announcements.title')} closeLabel={t('close')} onClose={close}
      className={clsx(css.dialog)} contentClassName={clsx(css.scroll)}
      footer={<Button variant="outline" size="sm" disabled={reading.loading} onClick={refresh}>
        {t(reading.failure !== null ? 'announcements.retry' : 'announcements.refresh')}
      </Button>}>
      {reading.failure !== null && <p className={css.message} role="alert">{failures[reading.failure]}</p>}
      {reading.payload === null && reading.loading
        ? <div className={css.loading} role="status" aria-label={t('announcements.loading')}>
          <IconLoadingOutlineRegular className={actionCss.spinner} size={20} />
        </div>
        : reading.payload === null ? null
          : reading.payload.items.length === 0 ? <p className={css.message}>{t('announcements.empty')}</p>
            : <ul className={css.list}>
              {reading.payload.items.map((item, index) => <li key={`${item.publishDate}:${String(index)}`} className={css.item}>
                <time className={css.date} dateTime={item.publishDate}>{dateFormat.format(new Date(item.publishDate))}</time>
                <div className={css.content}>{item.content}</div>
                {item.extra !== undefined && item.extra !== '' && <p className={css.message}>{item.extra}</p>}
              </li>)}
            </ul>}
    </Modal>
  </>
}
