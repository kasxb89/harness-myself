/** Private demand navigation and account-owned human-engineer conversations. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createDemandController } from './controller.ts'
import { DemandPage } from './DemandPage.tsx'
import { DemandPanelIcon } from './DemandPanelIcon.tsx'
import { en, NS, zh, type DemandLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Human-engineer catalog, demand chat and delivery copy. */
    demands: DemandLocaleKey
  }
}

const PANEL_ID = 'demands' as MainPanelId

/** Runtime dependencies retain the existing shared product login. */
export const inject = ['slots', 'locale', 'layout', 'creditsSession']

/** Client transport deadlines and refresh cadence; service publication is owned by the backend. */
export interface Config {
  /** Local transport availability, independent of the backend's new-demand switch. */
  enabled?: boolean
  /** Complete deadline for one metadata request or bounded upload chunk. */
  requestTimeoutMs?: number
  /** Complete deadline for one resumable binary upload slice on slower connections. */
  uploadTimeoutMs?: number
  /** Delay between message reads while this panel is in the foreground. */
  foregroundPollMs?: number
  /** Delay between background message reads; background views never mark messages read. */
  backgroundPollMs?: number
  /** Delay between demand-list refreshes. */
  listPollMs?: number
}

/** Validate the local carrier settings before account reads or timers start. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  requestTimeoutMs: z.natural().min(1000).max(300_000).default(20_000),
  uploadTimeoutMs: z.natural().min(1000).max(3_600_000).default(120_000),
  foregroundPollMs: z.natural().min(1000).max(300_000).default(3000),
  backgroundPollMs: z.natural().min(1000).max(300_000).default(15_000),
  listPollMs: z.natural().min(1000).max(300_000).default(15_000),
})

/**
 * Register the demand page and its dynamic sidebar entry without changing AI sessions.
 * @param ctx - Client composition with the shared account, locale and slot services.
 * @param config - Validated carrier timeouts and refresh cadence.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = Config(config) as Required<Config>
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-demands: dictionaries')
  const { start, dispose, setVisible, ...face } = createDemandController(ctx.creditsSession, resolved, {
    translate: t,
    openLogin: () => { ctx.layout.selectPanel('credits' as MainPanelId) },
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS, inject: () => face,
  }, DemandPage))
  ctx.slots.inject('sidebar.panellist', () => {
    let unregister: (() => void) | undefined
    const reconcile = (): void => {
      const state = face.hooks.demands.getSnapshot()
      const visible = state.availability === 'ready' || state.requests.length > 0 || state.conversation !== null
      if (visible && unregister === undefined) {
        unregister = ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 35, label: () => t('panelLabel'), locale: NS,
        }, DemandPanelIcon)
      } else if (!visible && unregister !== undefined) {
        unregister()
        unregister = undefined
      }
    }
    const unsubscribe = face.hooks.demands.subscribe(reconcile)
    reconcile()
    return () => { unsubscribe(); unregister?.() }
  })
  ctx.effect(() => {
    const stop = start()
    const visibility = (): void => {
      setVisible(ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID
        && document.visibilityState !== 'hidden' && document.hasFocus())
    }
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
      await dispose()
    }
  }, 'ui-demands: account-bound message and upload lifecycle')
}
