/**
 * Sidebar Artifacts entry and page, browser half.
 *
 * One row in the global panel list (`sidebar.panellist`) and one keyed main
 * panel behind it, so the artifacts view is a standing column of the shell
 * rather than a conversation surface. The listing itself comes from
 * `@deepseek-ai/dsh-artifacts-index` over `/artifacts/api`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the client service merges (`ctx.locale`, `ctx.slots`) and the
// root `sidebar.panellist` list and keyed `main` slot declarations.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ArtifactsPage, type ArtifactsInjected } from './ArtifactsPage.tsx'
import { ArtifactsPanelIcon } from './ArtifactsPanelIcon.tsx'
import { en, NS, zh, type ArtifactsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Artifacts panel copy. */
    'artifacts': ArtifactsKey
  }
}

/** The panel id this plugin owns, shared by its sidebar row and its page. */
export const PANEL_ID = 'artifacts' as MainPanelId

/** Required services: the slot registries and the dictionary registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries, the sidebar entry, and the page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-artifacts: dictionaries')
  const face: ArtifactsInjected = {
    t: (key, values) => t(key as Parameters<typeof t>[0], values),
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: (): ArtifactsInjected => face,
  }, ArtifactsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => t('panel'),
    locale: NS,
  }, ArtifactsPanelIcon))
}
