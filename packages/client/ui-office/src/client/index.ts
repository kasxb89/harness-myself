/**
 * Sidebar Office entry and page, browser half: one row in the global panel list
 * and one keyed main panel behind it.
 *
 * The workspace belongs to the office plugin, which registers conversation and
 * settings surfaces but no place in the panel list. This plugin is that place.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { OfficePage, type OfficeInjected } from './OfficePage.tsx'
import { OfficePanelIcon } from './OfficePanelIcon.tsx'
import { en, NS, zh, type OfficeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Office panel copy. */
    'office': OfficeKey
  }
}

/** The panel id this plugin owns, shared by its sidebar row and its page. */
export const PANEL_ID = 'office' as MainPanelId

/** Required services: the slot registries and the dictionary registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries, the sidebar entry, and the page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-office: dictionaries')
  const face: OfficeInjected = { t: (key, values) => t(key as Parameters<typeof t>[0], values as never) }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: (): OfficeInjected => face }, OfficePage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 70, label: () => t('panel'), locale: NS }, OfficePanelIcon))
}
