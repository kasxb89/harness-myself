/**
 * The Mobile page: the IM bridge's channel front (WeChat selected) inside the
 * main column, so binding by QR is a standing page rather than a settings hunt.
 *
 * The bridge publishes its panel through the client service `dshImClient`
 * (`render({ preferredSectionId })`). That service hands back a React element,
 * which is the documented way this bridge integrates with other surfaces; the
 * page keeps the element in local state so nothing React-shaped crosses the
 * inject face and the page re-reads it when the service appears.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MobilePage.module.css'

/** What the plugin injects into the page. */
export interface MobileInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
  /**
   * The IM bridge's channel panel, or null while that plugin is absent.
   * Declared as `unknown` on purpose: the element belongs to the bridge's own
   * React tree, and the page only places it.
   */
  readonly renderChannelPanel: () => unknown
}

export function MobilePage(props: PropsRuntime<'main'> & MobileInjected): ReactNode {
  const { t, renderChannelPanel } = props
  const [panel, setPanel] = useState<ReactNode>(null)

  useEffect(() => {
    try {
      setPanel((renderChannelPanel() ?? null) as ReactNode)
    } catch {
      setPanel(null)
    }
  }, [renderChannelPanel])

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        <p className={css.subtitle}>{t('subtitle')}</p>
      </header>
      <section className={css.stage}>
        {panel === null ? <p className={css.hint}>{t('missing')}</p> : panel}
      </section>
    </div>
  )
}
