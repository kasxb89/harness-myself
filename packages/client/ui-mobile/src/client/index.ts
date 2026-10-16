/**
 * Sidebar Mobile entry and page, browser half.
 *
 * The page deliberately owns no channel logic: binding, status, and the QR all
 * belong to the IM bridge, which publishes them as the client service
 * `dshImClient`. This package only gives that front a standing home in the
 * global panel list, with the WeChat section selected by default.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { MobilePage, type MobileInjected } from './MobilePage.tsx'
import { FooterAction, type FooterInjected } from './FooterAction.tsx'
import { en, NS, zh, type MobileKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Mobile panel copy. */
    'mobile': MobileKey
  }
}

/** The panel id this plugin owns, shared by its sidebar row and its page. */
export const PANEL_ID = 'mobile' as MainPanelId

/** Required services: the slot registries, the dictionary registry, and the
 * layout service the footer row uses to open its page. */
export const inject = ['slots', 'locale', 'layout']

/** The section the bridge's panel opens on: its WeChat channel. */
const WECHAT_SECTION_ID = 'weixin'

/** The client-service face the IM bridge publishes, as far as this page needs it. */
interface ImBridgeClient {
  readonly render?: (props: { readonly preferredSectionId?: string }) => unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional channel panel published by the separately composed IM bridge. */
    dshImClient?: ImBridgeClient
  }
}

/**
 * Read the bridge's client service without declaring a dependency on its
 * package: it may be absent, and the page has a hint for exactly that case.
 */
function readImBridge(ctx: ClientContext): ImBridgeClient | undefined {
  try {
    return ctx.get('dshImClient')
  } catch (_error) {
    // An unavailable bridge leaves the page's existing hint visible.
    return undefined
  }
}

/**
 * Client plugin body: register the dictionaries, the sidebar entry, and the page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mobile: dictionaries')
  const face: MobileInjected = {
    t: (key, values) => t(key as Parameters<typeof t>[0], values),
    renderChannelPanel: () => {
      const bridge = readImBridge(ctx)
      if (bridge?.render === undefined) return null
      return bridge.render({ preferredSectionId: WECHAT_SECTION_ID }) ?? null
    },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: (): MobileInjected => face,
  }, MobilePage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: PANEL_ID,
    order: 30,
    label: () => t('panel'),
    locale: NS,
    inject: (): FooterInjected => ({
      label: t('panel'),
      open: () => { ctx.layout.selectPanel(PANEL_ID) },
    }),
  }, FooterAction))
}
