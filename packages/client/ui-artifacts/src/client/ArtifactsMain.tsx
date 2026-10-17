/** Adapt framework-owned current-session and workspace sources to plain page data. */
import type { HostObservable, PropsHooks, PropsRenderSlots, PropsRuntime, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { ArtifactsPage, type ArtifactsInjected } from './ArtifactsPage.tsx'

/** The existing Session adapter supplies its current binding without creating a new public selection service. */
export interface ArtifactsMainInjected extends ArtifactsInjected {
  hooks: { artifactSession: HostObservable<StandardSourceBinding> }
}

/**
 * Keep framework hooks at the registration boundary and pass ordinary workspace facts to the file browser.
 * @param props - Existing current-session and workspace hooks plus injected file operations.
 * @returns The artifacts page with an explicit current workspace or an unselected scope.
 */
export function ArtifactsMain(props: Omit<ArtifactsMainInjected, 'hooks'> & PropsHooks<ArtifactsMainInjected['hooks']>
  & Pick<PropsRuntime<'main'>, 'useWorkspaces'> & PropsRenderSlots<'artifacts.preview.pdf'>) {
  const workspaces: WorkspaceSnapshot = props.useWorkspaces(value => value)
  const currentSessionKey = props.useArtifactSession(value => value.key ?? null)
  const current = workspaces.items.find(workspace => workspace.sessionIds.some(id => id === currentSessionKey))
  return <ArtifactsPage {...props} workspaces={{
    items: workspaces.items.map(workspace => ({ id: workspace.workspaceId, title: workspace.title, path: workspace.path })),
    currentWorkspaceId: current?.workspaceId ?? null,
    currentSessionKey,
    ready: workspaces.phase === 'ready',
  }} />
}
