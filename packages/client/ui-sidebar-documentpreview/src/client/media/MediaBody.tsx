/** Session-addressed media uses existing artifact authorization without buffering the whole file. */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../index.ts'
import { hostFileOf } from '../rpc.ts'
import { MediaPlayer } from './MediaPlayer.tsx'
import type {} from './locales.ts'

/** Native player props receive Session, Workspace, and file resources through standard hooks. */
export type MediaBodyProps = DocumentPreviewProps & PropsLocale<'sidebarMedia'>

/**
 * Project the document slot's Host metadata and lifetime into the shared player.
 * @param props - Renderer revision and standard file/Workspace hooks.
 * @returns An audio/video player, preparation status, or a retryable local failure.
 */
export function MediaBody(props: MediaBodyProps): ReactNode {
  const { tab } = props.useTabInfo()
  const file = hostFileOf(props.resourceAddress)
  const metadata = props.useResource<'file'>(props.resourceAddress)
  const workspaceId = props.useWorkspaces(snapshot => snapshot.items.find(workspace =>
    workspace.sessionIds.some(sessionId => sessionId === file.sessionId))?.workspaceId)
  const workspacesSettled = props.useWorkspaces(snapshot => snapshot.phase === 'ready' || snapshot.state === 'error')
  if (props.content.kind !== 'renderer') return null
  const request = props.content
  const metadataFailed = metadata.failure !== undefined || metadata.status === 'none'
  return <MediaPlayer name={pathPartsOf(file.path).name} revision={`${props.resourceAddress}:${request.revision}`}
    signal={tab.signal} file={metadata.value === undefined ? undefined : { ...metadata.value, workspaceId }}
    pending={metadata.value === undefined ? !metadataFailed : !workspacesSettled}
    t={props.t} loaded={request.loaded} failed={request.failed} reload={request.reload} />
}
