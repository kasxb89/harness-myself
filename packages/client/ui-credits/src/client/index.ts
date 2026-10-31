/**
 * Sidebar Credits entry and page, browser half: one row in the global panel
 * list, one keyed main panel behind it. The balance comes from
 * `@deepseek-ai/dsh-credits-index` over `/credits/api/summary`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { CreditsPage, type CreditsPageInjected } from './CreditsPage.tsx'
import { FooterAction, type FooterInjected } from './FooterAction.tsx'
import { RechargePage, type RechargePageInjected } from './RechargePage.tsx'
import { en, NS, zh, type CreditsKey } from './locales.ts'
import { WorkspaceGuide, WorkspaceGuideToast } from './WorkspaceGuide.tsx'
import { createWorkspaceGuide } from './workspace-guide-store.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { createCreditsSessionSource, type CreditsSnapshot } from './session-store.ts'
import { SessionModelCredits, TurnModelCredits, type ModelCreditsInjected } from './ModelCredits.tsx'
import { BalanceNotice, type BalanceNoticeInjected } from './BalanceNotice.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared product account snapshot; subscribing retains account refresh. */
    creditsSession: ObservableSnapshot<CreditsSnapshot>
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Credits panel copy. */
    'credits': CreditsKey
  }
}

/** The panel id this plugin owns, shared by its sidebar row and its page. */
export const PANEL_ID = 'credits' as MainPanelId

/** The top-up page's own panel: the sidebar's top-up entry lands here directly. */
export const RECHARGE_PANEL_ID = 'recharge' as MainPanelId

/** Required services: the slot registries, the dictionary registry, and the
 * layout service the footer row uses to open its page. */
export const inject = ['slots', 'locale', 'layout']

/** Deadlines for account operations and read-only reply-credit statistics. */
export interface Config {
  /** Client read timeout in milliseconds; configure above the owning Host's statistics timeout. */
  chatUsageReadTimeoutMs?: number
  /** Total client timeout for logout and confirmation that local credentials were cleared. */
  signOutTimeoutMs?: number
}

/** Validate account-operation deadlines before activating the UI. */
export const Config: z<Config> = z.object({
  chatUsageReadTimeoutMs: z.natural().min(1000).max(120_000).default(20_000),
  signOutTimeoutMs: z.natural().min(1000).max(120_000).default(20_000),
})

/**
 * Client plugin body: register the dictionaries, the sidebar entry, and the page.
 * @param ctx - client root context.
 * @param config - Loader-validated account-operation deadlines.
 */
export function apply(ctx: ClientContext, config: Config = {}): void {
  const resolved = Config(config) as Required<Config>
  ctx.provide('creditsSession', createCreditsSessionSource())
  ctx.inject(['quotaNotices'], (scope) => {
    scope.effect(() => scope.quotaNotices.registerBalanceScope((owner) => {
      const session = scope.creditsSession.getSnapshot().session
      return session?.signedIn === true && session.accountOwner === owner
    }), 'ui-credits: product balance scope')
  })
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-credits: dictionaries')
  ctx.slots.inject('shell.quota-notice', () => ctx.slots.register({
    name: 'shell.quota-notice', locale: NS,
    select: owner => owner.code === 'INSUFFICIENT_BALANCE' ? owner : null,
    inject: (): BalanceNoticeInjected => ({ hooks: { creditsSession: ctx.creditsSession },
      openRecharge: () => { ctx.layout.selectPanel(RECHARGE_PANEL_ID) } }),
  }, BalanceNotice))
  const modelCredits = (): ModelCreditsInjected => ({ hooks: { creditsSession: ctx.creditsSession },
    readTimeoutMs: resolved.chatUsageReadTimeoutMs,
    openBalance: () => { ctx.layout.selectPanel(PANEL_ID) } })
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'usage', order: 1, locale: NS, inject: modelCredits,
  }, SessionModelCredits))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'model-credits', order: 10, locale: NS, inject: modelCredits,
  }, TurnModelCredits))
  const guide = createWorkspaceGuide()
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'workspace-guide', order: 100, locale: NS,
    inject: () => guide,
  }, WorkspaceGuide))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'workspace-guide-notice', locale: NS,
    inject: () => guide,
  }, WorkspaceGuideToast))
  const face: CreditsPageInjected & RechargePageInjected = {
    signOutTimeoutMs: resolved.signOutTimeoutMs,
    t: (key, values) => t(key as Parameters<typeof t>[0], values),
    openRecharge: () => { ctx.layout.selectPanel(RECHARGE_PANEL_ID) },
    openBalance: () => { ctx.layout.selectPanel(PANEL_ID) },
    completeSignIn: () => {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) ctx.layout.selectPanel(null)
    },
  }
  ctx.slots.inject('main', () => {
    const unregister = ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: (): CreditsPageInjected => face,
    }, CreditsPage)
    // Consume the native welcome's launch request once, after its page exists.
    const url = new URL(window.location.href)
    if (url.searchParams.get('panel') === PANEL_ID) {
      ctx.layout.selectPanel(PANEL_ID)
      url.searchParams.delete('panel')
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    }
    return unregister
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: RECHARGE_PANEL_ID,
    locale: NS,
    inject: (): RechargePageInjected => face,
  }, RechargePage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: PANEL_ID,
    order: 40,
    label: () => t('panel'),
    locale: NS,
    inject: (): FooterInjected => ({
      label: t('panel'),
      rechargeLabel: t('rechargeTitle'),
      customLabel: t('custom'),
      open: () => { ctx.layout.selectPanel(PANEL_ID) },
      openRecharge: () => { ctx.layout.selectPanel(RECHARGE_PANEL_ID) },
    }),
  }, FooterAction))
}
