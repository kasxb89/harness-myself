/** Session-addressed media uses existing artifact authorization without buffering the whole file. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { Button, FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../index.ts'
import { hostFileOf } from '../rpc.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { resolveMediaSource } from './source.ts'
import type {} from './locales.ts'
import common from '../TextPreview.module.css'
import css from './MediaBody.module.css'

/** Native player props receive Session, Workspace, and file resources through standard hooks. */
export type MediaBodyProps = DocumentPreviewProps & PropsLocale<'sidebarMedia'>

interface Source {
  readonly key: string
  readonly url?: string
  readonly version: string
  readonly failure?: 'unavailable' | 'failed'
}

/**
 * Play one renderer revision through browser-managed streaming and native controls.
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
  const request = props.content.kind === 'renderer' ? props.content : undefined
  const key = `${props.resourceAddress}:${request?.revision ?? ''}`
  const [source, setSource] = useState<Source>()
  const [readyKey, setReadyKey] = useState<string>()
  const current = source?.key === key ? source : undefined
  const media = useRef<HTMLMediaElement | null>(null)
  const bindMedia = useCallback((next: HTMLMediaElement | null): void => {
    if (media.current !== null && media.current !== next) {
      media.current.pause()
      media.current.removeAttribute('src')
      media.current.load()
    }
    media.current = next
  }, [])
  const hasMetadata = metadata.value !== undefined
  const metadataFailed = metadata.failure !== undefined || metadata.status === 'none'
  const hasSource = current !== undefined
  useEffect(() => {
    if (request === undefined || hasSource || tab.signal.aborted) return
    if (metadata.value === undefined) {
      if (metadataFailed) {
        setSource({ key, version: '', failure: 'unavailable' })
        request.failed()
      }
      return
    }
    if (!workspacesSettled) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, tab.signal])
    const { absolutePath, version } = metadata.value
    void resolveMediaSource(absolutePath, version, workspaceId, signal).then((url) => {
      if (signal.aborted) return
      setSource({ key, version, ...url === undefined ? { failure: 'unavailable' as const } : { url } })
      if (url === undefined) request.failed()
    })
    return () => { controller.abort() }
  }, [key, hasMetadata, metadataFailed, hasSource, workspacesSettled, tab.signal, workspaceId])
  useEffect(() => {
    const close = (): void => { setSource(undefined) }
    tab.signal.addEventListener('abort', close, { once: true })
    return () => { tab.signal.removeEventListener('abort', close) }
  }, [tab.signal])

  if (request === undefined || tab.signal.aborted) return null
  const { name } = pathPartsOf(file.path)
  const video = /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(name)
  if (current?.failure !== undefined) return <div className={common.empty}>
    <FileTypeIcon path={name} size={36} />
    <p className={common.emptyLine} role="alert">{props.t(current.failure)}</p>
    <Button size="sm" onClick={request.reload}>{props.t('retry')}</Button>
  </div>
  const loaded = (): void => {
    if (current === undefined || tab.signal.aborted) return
    setReadyKey(key)
    request.loaded(current.version)
  }
  const failed = (): void => {
    if (current === undefined || tab.signal.aborted) return
    setSource({ ...current, failure: 'failed' })
    request.failed()
  }
  return <div className={css.frame}>
    {current?.url === undefined ? null : video
      ? <video key={key} ref={bindMedia} className={css.video} src={current.url}
        controls playsInline preload="metadata" aria-label={props.t('preview', { name })}
        onLoadedMetadata={loaded} onError={failed} />
      : <audio key={key} ref={bindMedia} className={css.audio} src={current.url}
        controls preload="metadata" aria-label={props.t('preview', { name })}
        onLoadedMetadata={loaded} onError={failed} />}
    {readyKey === key ? null : <div className={css.loading}><LoadingIndicator label={props.t('loading')} /></div>}
  </div>
}
