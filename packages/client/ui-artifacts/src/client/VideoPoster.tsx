/** Local asynchronous poster state and visibility-owned row leases. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArtifactEntry } from './ArtifactsPage.tsx'
import { videoPosterKey, type ReadVideoPoster } from './video-poster.ts'
import css from './ArtifactsPage.module.css'

type Poster = { key: string; state: 'idle' | 'loading' | 'ready' | 'failed'; url?: string }

/** Only component-private work is mirrored here; the page supplies a cancellable plain callback. */
export function useVideoPoster(entry: ArtifactEntry, read: ReadVideoPoster | undefined, visible: boolean): Poster {
  const key = videoPosterKey(entry)
  const [poster, setPoster] = useState<Poster>({ key, state: 'idle' })
  useEffect(() => {
    if (!visible || read === undefined || entry.kind !== 'video') { setPoster({ key, state: 'idle' }); return }
    const controller = new AbortController()
    setPoster({ key, state: 'loading' })
    void read(entry, controller.signal).then((url) => {
      if (!controller.signal.aborted) setPoster(url === null ? { key, state: 'failed' } : { key, state: 'ready', url })
    }).catch(() => { if (!controller.signal.aborted) setPoster({ key, state: 'failed' }) })
    return () => { controller.abort() }
  }, [key, read, visible, entry.kind])
  return poster.key === key ? poster : { key, state: 'idle' }
}

/** Decode rows only while intersecting their nearest scroll viewport. */
export function VideoThumbnail({ entry, read }: { entry: ArtifactEntry; read: ReadVideoPoster }): ReactNode {
  const target = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const poster = useVideoPoster(entry, read, visible)
  useEffect(() => {
    const element = target.current
    if (element === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      for (const observed of entries) if (observed.target === element) setVisible(observed.isIntersecting)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])
  return <span ref={target} className={css.thumb} data-video-poster={poster.state} data-video-path={entry.path}>
    {poster.url === undefined ? <FileTypeIcon path={entry.name} size={18} /> : <img className={css.thumbImage} src={poster.url} alt="" />}
  </span>
}
