/**
 * The Plaza page: the plugin market's own panel, mounted inside this frame.
 *
 * The market ships as a profile plugin and hands its panel out through its
 * client face (`ctx.market.render()`, the same element its settings section
 * draws), so this page owns nothing but the seat: the market keeps its chrome,
 * its locale and its theme wiring. Until that face answers — the market's
 * apply lands after ours — the page shows where the market would be.
 */
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PlazaPage.module.css'

/**
 * The market plugin's client control face (`ctx.market`, version 1). Declared
 * locally: the market is a profile plugin, so its own types are not in this
 * program, and the page only needs the panel builder.
 */
export interface MarketControl {
  readonly version: number
  render: (props?: { readonly preferredSubsectionId?: string }) => ReactNode
}

/** What the plugin injects into the page. */
export interface PlazaInjected {
  /** The external provider's opaque UI face, owned by this plugin activation. */
  hooks: { marketControl: SnapshotStore<MarketControl | null> }
}

/** Framework-bound market snapshot and locale-owned page copy. */
export type PlazaPageProps = PropsRuntime<'main'> & PropsLocale<'plaza'> & InjectFace<PlazaInjected>

/**
 * Frame the provider's original panel without taking over its controls or scrolling.
 * @param props - Framework-bound market control and localized unavailable-state copy.
 * @returns The current market panel or an unavailable state.
 */
export function PlazaPage({ useMarketControl, t }: PlazaPageProps): ReactNode {
  const market = useMarketControl(value => value)
  return <section className={css.page} aria-label={t('panel')}>
    <div className={css.content}>
      {market === null ? <div className={css.missing} role="status">
        <h1>{t('missingTitle')}</h1>
        <p>{t('missing')}</p>
      </div> : market.render({})}
    </div>
  </section>
}
