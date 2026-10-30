/**
 * Sidebar Image entry and page, browser half: one row in the global panel list
 * and one keyed main panel behind it. Sign-in and the balance are the Credits
 * plugin's; generation is proxied by `@deepseek-ai/dsh-credits-index`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ImagePage, type ImagegenInjected } from './ImagePage.tsx'
import { ImagePanelIcon } from './ImagePanelIcon.tsx'
import { en, NS, zh, type ImagegenKey } from './locales.ts'
import { createImageDraftStore } from './draft-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** AI image panel copy. */
    'imagegen': ImagegenKey
  }
}

/** The panel id this plugin owns, shared by its sidebar row and its page. */
export const PANEL_ID = 'imagegen' as MainPanelId

/** The same module's video mode, owned by its own plugin package. */
export const VIDEO_PANEL_ID = 'videogen' as MainPanelId

/** Required services: slots, dictionaries, layout and the creation publication. */
export const inject = ['slots', 'locale', 'layout', 'creationContent', 'uiSession']

/**
 * Client plugin body: register the dictionaries, the sidebar entry, and the page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-imagegen: dictionaries')
  const previewUrls = new Set<string>()
  ctx.effect(() => () => { for (const url of previewUrls) URL.revokeObjectURL(url) })
  const face: Omit<ImagegenInjected, 'readDraft'> = {
    hooks: { creationContent: ctx.creationContent, locale: ctx.locale, creationSession: ctx.uiSession.adapter.current },
    refreshContent: () => { void ctx.creationContent.refresh() },
    t: (key, values) => t(key as Parameters<typeof t>[0], values),
    openAudio: () => { ctx.layout.selectPanel('audiogen' as MainPanelId) },
    openVideo: () => { ctx.layout.selectPanel(VIDEO_PANEL_ID) },
    createReferencePreview: (file) => {
      const url = URL.createObjectURL(file)
      previewUrls.add(url)
      return url
    },
    releaseReferencePreview: (url) => {
      URL.revokeObjectURL(url)
      previewUrls.delete(url)
    },
  }
  ctx.slots.inject('main', () => {
    const handle = createImageDraftStore(), instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    return ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      store,
      inject: (): ImagegenInjected => ({ ...face, readDraft: () => instance.getSnapshot() }),
    }, ImagePage)
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: () => t('panel'),
    locale: NS,
  }, ImagePanelIcon))
}
