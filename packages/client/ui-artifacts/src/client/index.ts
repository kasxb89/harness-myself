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
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ArtifactsInjected } from './ArtifactsPage.tsx'
import { ArtifactsMain, type ArtifactsMainInjected } from './ArtifactsMain.tsx'
import { ArtifactsPanelIcon } from './ArtifactsPanelIcon.tsx'
import { OperationToast, type ArtifactNotice, type ArtifactNoticeInjected } from './OperationToast.tsx'
import { readArtifacts, readRootDirectory, readStorage, readTrash, readWorkspace, renameArtifact, restoreArtifact, saveStorage, trashArtifact, type ArtifactResult } from './api.ts'
import { en, NS, zh, type ArtifactsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Standalone PDF presentation for an already authorized artifact URL. */
    'artifacts.preview.pdf': {
      kind: 'keyed'
      scope: 'root'
      owner: { readonly url: string; readonly name: string }
    }
  }
  interface LocaleNamespaceMap {
    /** Artifacts panel copy. */
    'artifacts': ArtifactsKey
  }
}

/** The panel id this plugin owns, shared by its sidebar row and its page. */
export const PANEL_ID = 'artifacts' as MainPanelId

/** Required services: the slot registries and the dictionary registry. */
export const inject = ['slots', 'locale', 'uiSession', 'remote', 'remote.session']

/**
 * Client plugin body: register the dictionaries, the sidebar entry, and the page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-artifacts: dictionaries')
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() }, 'ui-artifacts: operations')
  const notice = createSnapshotStore<ArtifactNotice | null>(null)
  let seq = 0
  let mutating = false
  const report = async <T>(operation: () => Promise<ArtifactResult<T>>,
    successKey: 'notice.saved' | 'notice.renamed' | 'notice.trashed' | 'notice.restored' | 'notice.revealed'): Promise<ArtifactResult<T>> => {
    if (mutating) return { ok: false, code: 'ARTIFACT_OPERATION_UNKNOWN' }
    mutating = true
    try {
      const result = await operation()
      if (!lifetime.signal.aborted) notice.set({ seq: ++seq, success: result.ok,
        text: result.ok ? t(successKey) : t(`error.${result.code}`) })
      return result
    } finally { mutating = false }
  }
  const desktop = (globalThis as { __DSH_DIRECTORY_PICKER__?: { pick: () => Promise<string | null> } }).__DSH_DIRECTORY_PICKER__
  const face: ArtifactsInjected = {
    t: (key, values) => t(key as Parameters<typeof t>[0], values),
    readListing: readArtifacts, readStorage, readTrash, readWorkspace, readRootDirectory,
    readDesktop: async () => {
      try { const value = await ctx.remote.session.canOpenWorkspacePath(); return value.ok && value.value }
      catch { return false }
    },
    saveStorage: (directory, revision) => report(() => saveStorage(directory, revision, lifetime.signal), 'notice.saved'),
    rename: (entry, name) => report(() => renameArtifact(entry.path, name, { size: entry.size, mtimeMs: entry.mtimeMs },
      lifetime.signal, entry.workspaceId), 'notice.renamed'),
    trash: entry => report(() => trashArtifact(entry.path, { size: entry.size, mtimeMs: entry.mtimeMs },
      lifetime.signal, entry.workspaceId), 'notice.trashed'),
    restore: id => report(() => restoreArtifact(id, lifetime.signal), 'notice.restored'),
    reveal: path => report(async () => {
      try {
        const result = await ctx.remote.session.openWorkspacePath({ path, action: 'reveal' }, lifetime.signal)
        return result.ok ? { ok: true as const, value: null } : { ok: false as const, code: 'ARTIFACT_OPEN_FAILED' as const }
      } catch { return { ok: false as const, code: 'ARTIFACT_OPEN_FAILED' as const } }
    }, 'notice.revealed'),
    ...desktop === undefined ? {} : { pickDirectory: () => desktop.pick() },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    children: { 'artifacts.preview.pdf': { kind: 'keyed', scope: 'root' } },
    inject: (): ArtifactsMainInjected => ({ ...face, hooks: { artifactSession: ctx.uiSession.adapter.current } }),
  }, ArtifactsMain))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => t('panel'),
    locale: NS,
  }, ArtifactsPanelIcon))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'artifacts.operation-toast',
    inject: (): ArtifactNoticeInjected => ({ hooks: { notice }, dismiss: () => { notice.set(null) } }),
  }, OperationToast))
}
