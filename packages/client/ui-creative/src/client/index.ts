/** Register the session-owned creation tab inside the existing right sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { readCreativeProjects } from './api.ts'
import { CreativeController } from './controller.ts'
import { CreativeBody, CreativeProjects, CreativeTitle, type CreativeInjected } from './CreativeBody.tsx'
import { CreativeDraftNotice, type CreativeDraftNoticeInjected } from './CreativeDraftNotice.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en, NS, zh, type CreativeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Session-owned workbench shared by image and video creation pages. */
    'creation.projects': {
      scope: 'session-maybe'
      props: { readonly refreshKey?: string; readonly generationPending?: boolean }
      inject: CreativeInjected
      locale: 'creative'
    }
  }
  interface LocaleNamespaceMap {
    /** Character, storyboard, real file progress and editable-draft controls. */
    creative: CreativeKey
  }
}

/** Read cadence only; this plugin never issues paid generation requests. */
export interface Config {
  /** Visible active-project refresh interval in milliseconds. */
  pollIntervalMs?: number
}

/** Validate deployment-owned supervision cadence before the plugin activates. */
export const Config: z<Config> = z.object({ pollIntervalMs: z.natural().min(500).max(60_000).default(2000) })

/** Client dependencies provide the ordinary tab, account and Session lifetimes. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'uiSession', 'sessions', 'creditsSession']

const ID = '@deepseek-ai/dsh-client-ui-creative'
const KIND = 'creative'

/**
 * Register account-safe project reads, keyed tab presentation and durable shell feedback.
 * @param ctx - declared client services only.
 * @param config - Loader-validated read cadence.
 */
export function apply(ctx: Context, config: Config): void {
  const t = ctx.locale.bind(NS)
  const controller = new CreativeController(readCreativeProjects, {
    pollIntervalMs: (config as Required<Config>).pollIntervalMs,
    reveal: (sessionId) => {
      if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return false
      ctx.sidebarRight.openTab(KIND)
      return true
    },
  })
  ctx.effect(() => () => controller.dispose(), 'ui-creative: supervised reads')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-creative: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID, kind: KIND, priority: 'builtin', title: () => t('title'),
    guide: [{ id: KIND, order: 25, title: () => t('title'), description: () => t('guide.description'), icon: IconSparkleRegular }],
  }), 'ui-creative: tab type')

  ctx.effect(() => {
    const account = (): void => {
      const snapshot = ctx.creditsSession.getSnapshot()
      controller.accountChanged(snapshot.loaded && snapshot.session?.signedIn === true
        ? snapshot.session.account?.id ?? null : null)
    }
    const dispose = ctx.creditsSession.subscribe(account)
    account()
    return dispose
  }, 'ui-creative: authoritative account')
  ctx.effect(() => {
    let binding: SessionBinding | undefined
    let releaseFeed = (): void => {}
    const select = (): void => {
      const id = ctx.uiSession.adapter.current.getSnapshot().key as SessionId | undefined
      controller.select(id)
      const next = id === undefined ? undefined : ctx.sessions.binding(id)
      if (next === binding) return
      releaseFeed()
      binding = next
      if (next === undefined) { releaseFeed = () => {}; return }
      let revision = next.eventSource.getSnapshot().revision
      releaseFeed = next.eventSource.subscribe(() => {
        const window = next.eventSource.getSnapshot()
        if (window.revision === revision) return
        revision = window.revision
        if (window.change.kind === 'replace') { void controller.refresh(next.sessionId); return }
        if (window.change.kind !== 'append') return
        for (const entry of window.change.entries) {
          if (entry.type !== 'event') continue
          const event = entry.event
          if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'turn/end') {
            controller.observe(next.sessionId, event)
          }
        }
      })
    }
    const releaseSelection = ctx.uiSession.adapter.current.subscribe(select)
    const releaseBindings = ctx.sessions.list.subscribe(select)
    select()
    return () => { releaseFeed(); releaseSelection(); releaseBindings(); controller.select(undefined) }
  }, 'ui-creative: current conversation feed')
  ctx.on('connection/reset', () => {
    const id = ctx.uiSession.adapter.current.getSnapshot().key as SessionId | undefined
    if (id !== undefined) void controller.refresh(id)
  })
  if (typeof document !== 'undefined') ctx.effect(() => {
    const visible = (): void => { controller.setForeground(document.visibilityState !== 'hidden') }
    const focused = (): void => {
      visible()
      const id = ctx.uiSession.adapter.current.getSnapshot().key as SessionId | undefined
      if (id !== undefined) void controller.refresh(id)
    }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('focus', focused)
    visible()
    return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', focused) }
  }, 'ui-creative: page visibility')

  const notice = createSnapshotStore<{ seq: number; success: boolean; kind: 'draft' | 'plan' } | null>(null)
  let sequence = 0
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID, locale: NS,
    inject: (sessionId): CreativeInjected => ({
      hooks: { creative: controller.source(sessionId) },
      selectProject: (id) => { controller.selectProject(sessionId, id) },
      selectShot: (id) => { controller.selectShot(sessionId, id) },
      refresh: () => { void controller.refresh(sessionId) },
      save: (projectId, revision, change, signal) => controller.save(sessionId, projectId, revision, change, signal),
      upload: (file, signal) => controller.upload(sessionId, file, signal),
      watch: (visible, signal, pending) => controller.watch(sessionId, visible, signal, pending),
      reportDraft: (success) => { notice.set({ seq: ++sequence, success, kind: 'draft' }) },
      reportSaved: () => { notice.set({ seq: ++sequence, success: true, kind: 'plan' }) },
    }),
  }, CreativeBody)), 'ui-creative: tab body')
  const absent = createSnapshotStore({ phase: 'idle', projects: [], refreshing: false, failure: null } as const)
  ctx.slots.registerFactory({ name: 'creation.projects', scope: 'session-maybe', locale: NS,
    inject: (sessionId): CreativeInjected => ({
      hooks: { creative: sessionId === undefined ? absent : controller.source(sessionId) },
      selectProject: (id) => { if (sessionId !== undefined) controller.selectProject(sessionId, id) },
      selectShot: (id) => { if (sessionId !== undefined) controller.selectShot(sessionId, id) },
      refresh: () => { if (sessionId !== undefined) void controller.refresh(sessionId) },
      save: (projectId, revision, change, signal) => sessionId === undefined
        ? Promise.resolve({ ok: false, code: 'signed-out' }) : controller.save(sessionId, projectId, revision, change, signal),
      upload: (file, signal) => sessionId === undefined ? Promise.resolve({ ok: false }) : controller.upload(sessionId, file, signal),
      watch: (visible, signal, pending) => sessionId === undefined ? () => {} : controller.watch(sessionId, visible, signal, pending),
      reportDraft: (success) => { notice.set({ seq: ++sequence, success, kind: 'draft' }) },
      reportSaved: () => { notice.set({ seq: ++sequence, success: true, kind: 'plan' }) },
    }),
  }, CreativeProjects)
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: ID,
  }, CreativeTitle)), 'ui-creative: tab title')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: `${ID}/draft-notice`, locale: NS,
    inject: (): CreativeDraftNoticeInjected => ({ hooks: { notice }, dismiss: () => { notice.set(null) } }),
  }, CreativeDraftNotice)), 'ui-creative: draft feedback')
}
