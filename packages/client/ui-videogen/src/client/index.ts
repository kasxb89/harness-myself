/**
 * Sidebar Video entry and page, browser half: one row in the global panel list
 * and one keyed main panel behind it. Sign-in and the balance are the Credits
 * plugin's; generation is proxied by `@deepseek-ai/dsh-credits-index`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { VideoPage, type VideogenInjected } from './VideoPage.tsx'
import { createVideoDraftStore } from './draft-store.ts'
import { en, NS, zh, type VideogenKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Video panel copy. */
    'videogen': VideogenKey
  }
}

/** The panel id this plugin owns, shared by its sidebar row and its page. */
export const PANEL_ID = 'videogen' as MainPanelId

/** The same module's image mode, owned by its own plugin package. */
export const IMAGE_PANEL_ID = 'imagegen' as MainPanelId

/** Required services: the slot registries and the dictionary registry. */
export const inject = ['slots', 'locale', 'layout']

/**
 * Client plugin body: register the dictionaries, the sidebar entry, and the page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-videogen: dictionaries')
  const store = createVideoDraftStore()
  const previews = new Set<string>()
  ctx.effect(() => () => { for (const url of previews) URL.revokeObjectURL(url); previews.clear() }, 'ui-videogen: previews')
  const face: VideogenInjected = {
    t: (key, values) => t(key as Parameters<typeof t>[0], values as never),
    openImage: () => { ctx.layout.selectPanel(IMAGE_PANEL_ID) },
    createPreview: (file) => { const url = URL.createObjectURL(file); previews.add(url); return url },
    releasePreview: (url) => { URL.revokeObjectURL(url); previews.delete(url) },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    store,
    inject: (): VideogenInjected => face,
  }, VideoPage))
}
