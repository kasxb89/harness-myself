/** Native media playback shared by the document slot and optional legacy viewers. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { resolveMediaSource } from './source.ts'
import type {} from './locales.ts'
import common from '../TextPreview.module.css'
import css from './MediaBody.module.css'

/** Host-resolved source metadata and the addressed Session's optional Workspace. */
export interface MediaFile {
  readonly absolutePath: string
  readonly version: string
  readonly workspaceId: WorkspaceId | undefined
}

/** Player preparation and callbacks belong to one caller-owned revision. */
export interface MediaPlayerProps extends PropsLocale<'sidebarMedia'> {
  readonly name: string
  readonly revision: string
  readonly signal: AbortSignal
  readonly file: MediaFile | undefined
  readonly pending: boolean
  readonly loaded: (version: string) => void
  readonly failed: () => void
  readonly reload: () => void
}

interface Source {
  readonly key: string
  readonly url?: string
  readonly version: string
  readonly failure?: 'unavailable' | 'failed'
}

/**
 * Authorize and play one media revision, releasing native playback on cancellation.
 * @param props - Host metadata, localized labels, and caller-owned lifetime.
 * @returns Native controls, loading status, or a retryable local failure.
 */
export function MediaPlayer(props: MediaPlayerProps): ReactNode {
  const key = props.revision
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
  const hasSource = current !== undefined
  const hasFile = props.file !== undefined
  useEffect(() => {
    if (hasSource || props.signal.aborted || props.pending) return
    if (props.file === undefined) {
      setSource({ key, version: '', failure: 'unavailable' })
      props.failed()
      return
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, props.signal])
    const { absolutePath, version, workspaceId } = props.file
    void resolveMediaSource(absolutePath, version, workspaceId, signal).then((url) => {
      if (signal.aborted) return
      setSource({ key, version, ...url === undefined ? { failure: 'unavailable' as const } : { url } })
      if (url === undefined) props.failed()
    })
    return () => { controller.abort() }
  }, [key, hasFile, hasSource, props.pending, props.signal, props.file?.workspaceId])
  useEffect(() => {
    const close = (): void => { setSource(undefined) }
    props.signal.addEventListener('abort', close, { once: true })
    return () => { props.signal.removeEventListener('abort', close) }
  }, [props.signal])

  if (props.signal.aborted) return null
  const video = /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(props.name)
  if (current?.failure !== undefined) return <div className={common.empty}>
    <FileTypeIcon path={props.name} size={36} />
    <p className={common.emptyLine} role="alert">{props.t(current.failure)}</p>
    <Button size="sm" onClick={props.reload}>{props.t('retry')}</Button>
  </div>
  const loaded = (): void => {
    if (current === undefined || props.signal.aborted) return
    setReadyKey(key)
    props.loaded(current.version)
  }
  const failed = (): void => {
    if (current === undefined || props.signal.aborted) return
    setSource({ ...current, failure: 'failed' })
    props.failed()
  }
  return <div className={css.frame}>
    {current?.url === undefined ? null : video
      ? <video key={key} ref={bindMedia} className={css.video} src={current.url}
        controls playsInline preload="metadata" aria-label={props.t('preview', { name: props.name })}
        onLoadedMetadata={loaded} onError={failed} />
      : <audio key={key} ref={bindMedia} className={css.audio} src={current.url}
        controls preload="metadata" aria-label={props.t('preview', { name: props.name })}
        onLoadedMetadata={loaded} onError={failed} />}
    {readyKey === key ? null : <div className={css.loading}><LoadingIndicator label={props.t('loading')} /></div>}
  </div>
}
