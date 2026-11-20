/** Private demand navigation and account-owned human-engineer conversations. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createDemandController } from './controller.ts'
import { createCommunityController } from './community-controller.ts'
import { createForumController } from './forum-controller.ts'
import { DemandPage } from './DemandPage.tsx'
import { DemandPanelIcon } from './DemandPanelIcon.tsx'
import { en, NS, zh, type DemandLocaleKey } from './locales.ts'
import type { DemandWorkspaceFace } from './types.ts'
import { type Config, DEMANDS_CONFIG_GLOBAL, publicDemandConfig } from '../config.ts'

// Browser Loader has no Host options; defaults must be applied after its public bootstrap is merged.
export type { Config } from '../config.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Human-engineer catalog, demand chat and delivery copy. */
    demands: DemandLocaleKey
  }
}

const PANEL_ID = 'demands' as MainPanelId

/** Runtime dependencies retain the existing shared product login. */
export const inject = ['slots', 'locale', 'layout', 'creditsSession']

/**
 * Register the demand page and enabled sidebar entry without changing AI sessions.
 * @param ctx - Client composition with the shared account, locale and slot services.
 * @param config - Validated carrier timeouts and refresh cadence.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const page = globalThis as Partial<Record<typeof DEMANDS_CONFIG_GLOBAL, unknown>>
  const bootstrap = publicDemandConfig(page[DEMANDS_CONFIG_GLOBAL] ?? {})
  const resolved = publicDemandConfig({
    enabled: config.enabled ?? bootstrap.enabled,
    requestTimeoutMs: config.requestTimeoutMs ?? bootstrap.requestTimeoutMs,
    uploadTimeoutMs: config.uploadTimeoutMs ?? bootstrap.uploadTimeoutMs,
    foregroundPollMs: config.foregroundPollMs ?? bootstrap.foregroundPollMs,
    backgroundPollMs: config.backgroundPollMs ?? bootstrap.backgroundPollMs,
    listPollMs: config.listPollMs ?? bootstrap.listPollMs,
    showcaseItems: config.showcaseItems ?? bootstrap.showcaseItems,
  })
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-demands: dictionaries')
  const { start, dispose, setVisible, ...face } = createDemandController(ctx.creditsSession, resolved, {
    translate: t,
    openLogin: () => { ctx.layout.selectPanel('credits' as MainPanelId) },
  })
  const { start: startCommunity, dispose: disposeCommunity, setVisible: setCommunityVisible,
    hooks: communityHooks, ...community } = createCommunityController(ctx.creditsSession, resolved)
  const { start: startForum, dispose: disposeForum, setVisible: setForumVisible,
    hooks: forumHooks, ...forum } = createForumController(ctx.creditsSession, resolved)
  let workspaceView: Parameters<DemandWorkspaceFace['setWorkspaceView']>[0] = 'other'
  const visibility = (): void => {
    const foreground = ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID
      && document.visibilityState !== 'hidden' && document.hasFocus()
    setVisible(foreground && workspaceView === 'legacy')
    setCommunityVisible(foreground && workspaceView === 'community')
    setForumVisible(foreground && workspaceView === 'forum')
  }
  const setWorkspaceView: DemandWorkspaceFace['setWorkspaceView'] = (view) => { workspaceView = view; visibility() }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS,
    inject: () => ({ ...face, hooks: { ...face.hooks, ...communityHooks, ...forumHooks }, community, forum,
      setWorkspaceView, showcaseItems: resolved.showcaseItems }),
  }, DemandPage))
  if (resolved.enabled) ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 35, label: () => t('panelLabel'), locale: NS,
    inject: () => ({ hooks: forumHooks }),
  }, DemandPanelIcon))
  ctx.effect(() => {
    const stop = start()
    const stopCommunity = startCommunity()
    const stopForum = startForum()
    const unsubscribe = ctx.layout.panelInfo.subscribe(visibility)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('focus', visibility)
    window.addEventListener('blur', visibility)
    visibility()
    return async () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('focus', visibility)
      window.removeEventListener('blur', visibility)
      stop()
      stopCommunity()
      stopForum()
      await Promise.all([dispose(), disposeCommunity(), disposeForum()])
    }
  }, 'ui-demands: account-bound message and upload lifecycle')
}
