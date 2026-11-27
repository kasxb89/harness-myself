/**
 * Sidebar Video entry and page, browser half: one row in the global panel list
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
import { prepareReplicaDraft } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-credits/client'
import { VideoPage, type VideogenInjected } from './VideoPage.tsx'
import { createVideoDraftStore } from './draft-store.ts'
import { en, NS, zh, type VideogenKey } from './locales.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Retained, unrevealed target of a creation-page chat draft handoff. */
    replicaDraft: unknown
  }
}

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

/** Required services: slots, dictionaries, layout and the creation publication. */
export const inject = ['slots', 'locale', 'layout', 'creationContent', 'uiSession', 'sessions', 'workspaces', 'uiWorkspace', 'conversation', 'creditsSession']

/**
 * Client plugin body: register the dictionaries, the sidebar entry, and the page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-videogen: dictionaries')
  const handle = createVideoDraftStore(), instance = handle.create()
  const store: typeof handle = { ...handle, create: () => instance }
  const previews = new Set<string>()
  ctx.effect(() => () => { for (const url of previews) URL.revokeObjectURL(url); previews.clear() }, 'ui-videogen: previews')
  const face: VideogenInjected = {
    hooks: { creationContent: ctx.creationContent, locale: ctx.locale, creationSession: ctx.uiSession.adapter.current },
    refreshContent: () => { void ctx.creationContent.refresh() },
    prepareReplicaDraft: async (request) => {
      const currentId = ctx.uiSession.adapter.current.getSnapshot().key
      const workspaces = ctx.workspaces.list.getSnapshot().items
      const workspace = workspaces.find(item => item.sessionIds.some(id => id === currentId)) ?? workspaces[0]
      if (workspace === undefined) return 'unavailable'
      const account = ctx.creditsSession.getSnapshot()
      let target: SessionBinding | undefined, navigation: AbortSignal | undefined
      return prepareReplicaDraft(request, {
        withTarget: async (confirm) => {
          navigation = AbortSignal.any([request.signal, ctx.layout.beginNavigation()])
          const id = await ctx.uiWorkspace.connectWorkspace(workspace.workspaceId)
          if (navigation.aborted) return
          await ctx.sessions.using(id, { source: 'replicaDraft', signal: navigation }, async (reference) => {
            target = reference.binding
            await confirm()
          })
        },
        isCurrent: (owner) => {
          const current = ctx.creditsSession.getSnapshot()
          return navigation?.aborted !== true && current.loaded && current.accountEpoch === account.accountEpoch
            && current.session?.signedIn === true && current.session.account?.id === request.accountKey
            && (current.session.accountOwner ?? null) === owner
        },
        accept: (prompt, files) => target !== undefined && ctx.conversation.acceptDraft(target, prompt, files),
        reveal: () => { if (target !== undefined) ctx.uiWorkspace.openSession(target.sessionId) },
      })
    },

    t: (key, values) => t(key, values),
    openAudio: () => { ctx.layout.selectPanel('audiogen' as MainPanelId) },
    openImage: () => { ctx.layout.selectPanel(IMAGE_PANEL_ID) },
    createPreview: (file) => { const url = URL.createObjectURL(file); previews.add(url); return url },
    releasePreview: (url) => { URL.revokeObjectURL(url); previews.delete(url) },
    readDraft: () => instance.getSnapshot(),
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    store,
    inject: (): VideogenInjected => face,
  }, VideoPage))
}
