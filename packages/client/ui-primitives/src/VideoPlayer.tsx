/** Native video playback with a permanently visible seek timeline. */
import { useEffect, useState, type ReactNode, type VideoHTMLAttributes } from 'react'
import { MediaProgress, type MediaProgressLabels } from './MediaProgress.tsx'
import css from './MediaProgress.module.css'

/** Standard video attributes and locale-owned timeline copy. */
export interface VideoPlayerProps extends VideoHTMLAttributes<HTMLVideoElement> {
  readonly progressLabels: MediaProgressLabels
}

/**
 * Keep seeking available in narrow previews and stop playback on replacement.
 * @param props - Native video properties and localized timeline labels.
 * @returns A native player and visible pointer/keyboard timeline.
 */
export function VideoPlayer({ progressLabels, ...props }: VideoPlayerProps): ReactNode {
  const [media, setMedia] = useState<HTMLVideoElement | null>(null)
  useEffect(() => () => {
    if (media === null) return
    media.pause()
    media.removeAttribute('src')
    media.load()
  }, [media])
  return <div className={css.player}>
    <video {...props} ref={setMedia} controls />
    <MediaProgress media={media} labels={progressLabels} />
  </div>
}
