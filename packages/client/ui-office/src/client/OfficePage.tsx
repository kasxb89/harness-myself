/**
 * The Office page: the document, spreadsheet and slide workspace.
 *
 * The workspace is served by its own plugin on `/uf`; this page is the frame it
 * lives in, so the entry sits with the other columns instead of only being
 * reachable from the conversation.
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './OfficePage.module.css'

/** What the plugin injects into the page. */
export interface OfficeInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
}

export function OfficePage(props: PropsRuntime<'main'> & OfficeInjected): ReactNode {
  const { t } = props
  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        <span className={css.hint}>{t('hint')}</span>
      </header>
      <iframe className={css.frame} src="/uf" title={t('title')} referrerPolicy="same-origin" />
    </div>
  )
}
