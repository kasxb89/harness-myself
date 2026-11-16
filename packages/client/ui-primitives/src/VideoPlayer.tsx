/** Native video playback with one browser-owned seek timeline. */
import { useEffect, useState, type ReactNode, type VideoHTMLAttributes } from 'react'
import type { MediaProgressLabels } from './MediaProgress.tsx'

/** Standard video attributes for the shared native player. */
export interface VideoPlayerProps extends VideoHTMLAttributes<HTMLVideoElement> {
  /** Accepted for older callers; playback controls are localized by the browser. */
  readonly progressLabels?: MediaProgressLabels
}

/**
 * Keep a single set of native controls and stop playback on replacement.
 * @param props - Native video properties.
 * @returns A native player with browser-managed pointer and keyboard seeking.
 */
export function VideoPlayer({ progressLabels: _progressLabels, ...props }: VideoPlayerProps): ReactNode {
  const [media, setMedia] = useState<HTMLVideoElement | null>(null)
  useEffect(() => () => {
    if (media === null) return
    media.pause()
    media.removeAttribute('src')
    media.load()
  }, [media])
  return <video {...props} ref={setMedia} controls />
}
