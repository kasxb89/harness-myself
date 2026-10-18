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
 * Keep framework hooks at registration and refresh the library after conversation and workspace changes.
 * @param props - Existing current-session and workspace hooks plus injected file operations.
 * @returns One artifact library refreshed when conversation activity or registered workspaces change.
 */
export function ArtifactsMain(props: Omit<ArtifactsMainInjected, 'hooks'> & PropsHooks<ArtifactsMainInjected['hooks']>
  & Pick<PropsRuntime<'main'>, 'useWorkspaces' | 'useSessionStatus' | 'usePanelInfo'> & PropsRenderSlots<'artifacts.preview.pdf'>) {
  const workspaces: WorkspaceSnapshot = props.useWorkspaces(value => value)
  const currentSessionKey = props.useArtifactSession(value => value.key ?? null)
  const activityKey = props.useSessionStatus(value => [...value].map(([id, state]) => `${id}:${String(state.running)}`).sort().join('|'))
  const active = props.usePanelInfo(value => value.activePanelId === 'artifacts')
  const refreshKey = JSON.stringify([currentSessionKey, workspaces.phase,
    workspaces.items.map(workspace => [workspace.workspaceId, workspace.path]), activityKey])
  return <ArtifactsPage {...props} active={active} refreshKey={refreshKey}
    workspaces={workspaces.items.map(workspace => ({ id: workspace.workspaceId, title: workspace.title, path: workspace.path }))} />
}
