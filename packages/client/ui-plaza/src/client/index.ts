/**
 * Sidebar Plaza entry and page, browser half: one row in the global panel list
 * and one keyed main panel behind it.
 *
 * The market is a profile plugin: it registers a settings section and hands
 * its panel out through `ctx.market`, but it owns no place in the panel list.
 * This plugin is that place — the product's own 「广场」 column — and the row
 * stays useful without the market by saying so in the page.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PlazaPage, type MarketControl, type PlazaInjected } from './PlazaPage.tsx'
import { PlazaPanelIcon } from './PlazaPanelIcon.tsx'
import { en, NS, zh, type PlazaKey } from './locales.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The market plugin's client control face (`dshmarket`, version 1). */
    market?: {
      readonly version: number
      render: (props?: { readonly preferredSubsectionId?: string }) => unknown
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plaza panel copy. */
    'plaza': PlazaKey
  }
}

/** The panel id this plugin owns, shared by its sidebar row and its page. */
export const PANEL_ID = 'plaza' as MainPanelId

/** Required services: the slot registries and the dictionary registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries, the sidebar entry, the page,
 * and the market face hand-off.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plaza: dictionaries')
  const marketControl = createSnapshotStore<MarketControl | null>(null)
  const face: PlazaInjected = { hooks: { marketControl } }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: (): PlazaInjected => face }, PlazaPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('panel'), locale: NS }, PlazaPanelIcon))
  // The dependency fiber owns this exact face. Withdrawal publishes null;
  // another Context or later provider activation never retains the old face.
  ctx.inject(['market'], (scoped) => {
    const market = scoped.market
    if (market !== undefined) {
      const control: MarketControl = {
        version: market.version,
        render: props => market.render(props) as ReactNode,
      }
      scoped.effect(() => {
        marketControl.set(control)
        return () => {
          if (marketControl.getSnapshot() === control) marketControl.set(null)
        }
      }, 'ui-plaza: market face')
    }
  })
}
