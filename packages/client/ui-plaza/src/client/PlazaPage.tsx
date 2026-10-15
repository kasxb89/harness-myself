/**
 * The Plaza page: the plugin market's own panel, mounted inside this frame.
 *
 * The market ships as a profile plugin and hands its panel out through its
 * client face (`ctx.market.render()`, the same element its settings section
 * draws), so this page owns nothing but the seat: the market keeps its chrome,
 * its locale and its theme wiring. Until that face answers — the market's
 * apply lands after ours — the page shows where the market would be.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
}

/** The market face as it arrives; the market's apply may land after ours. */
let control: MarketControl | null = null
const listeners = new Set<() => void>()

/** Record the market face and wake the mounted page. */
export function setMarketControl(next: MarketControl): void {
  control = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function snapshot(): MarketControl | null {
  return control
}

export function PlazaPage(props: PropsRuntime<'main'> & PlazaInjected): ReactNode {
  const { t } = props
  const market = useSyncExternalStore(subscribe, snapshot)
  if (market === null) {
    return <p className={css.missing}>{t('missing')}</p>
  }
  return <div className={css.page}>{market.render({})}</div>
}
