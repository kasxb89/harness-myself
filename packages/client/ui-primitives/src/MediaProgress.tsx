/** Visible native-media seeking independent of browser control-bar layout. */
import { useEffect, useState, type ReactNode } from 'react'
import css from './MediaProgress.module.css'

/** Locale-owned labels for a media timeline. */
export interface MediaProgressLabels {
  readonly seek: string
  readonly unavailable: string
  readonly failed: string
}

/** A caller-owned media element and its localized timeline copy. */
export interface MediaProgressProps {
  readonly media: HTMLMediaElement | null
  readonly labels: MediaProgressLabels
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const whole = Math.floor(seconds)
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * Show a persistent seek slider while preserving native playback and pause state.
 * @param props - Playback element owned by the surrounding preview.
 * @returns A disabled timeline until duration is known, or pointer/keyboard seeking.
 */
export function MediaProgress({ media, labels }: MediaProgressProps): ReactNode {
  const [position, setPosition] = useState({ time: 0, duration: Number.NaN })
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const update = (): void => {
      setPosition({ time: media?.currentTime ?? 0, duration: media?.duration ?? Number.NaN })
    }
    const reset = (): void => { setFailed(false); update() }
    setFailed(false)
    update()
    if (media === null) return
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked']) media.addEventListener(event, update)
    media.addEventListener('emptied', reset)
    media.addEventListener('loadstart', reset)
    return () => {
      for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked']) media.removeEventListener(event, update)
      media.removeEventListener('emptied', reset)
      media.removeEventListener('loadstart', reset)
    }
  }, [media])
  const available = media !== null && Number.isFinite(position.duration) && position.duration > 0
  const max = available ? position.duration : 1
  const time = Math.max(0, Math.min(Number.isFinite(position.time) ? position.time : 0, max))
  const seek = (seconds: number): void => {
    if (media === null || !Number.isFinite(media.duration) || media.duration <= 0 || !Number.isFinite(seconds)) return
    try {
      media.currentTime = Math.max(0, Math.min(seconds, media.duration))
      setPosition({ time: media.currentTime, duration: media.duration })
      setFailed(false)
    } catch (_error) { setFailed(true) }
  }
  return <div className={css.timeline} data-media-progress>
    <div className={css.row}>
      <input className={css.slider} type="range" min={0} max={max} step={0.1} value={time}
        disabled={!available} aria-label={labels.seek} aria-valuetext={`${clock(time)} / ${clock(position.duration)}`}
        title={available ? labels.seek : labels.unavailable}
        onChange={(event) => { seek(event.currentTarget.valueAsNumber) }} />
      <span className={css.time} aria-hidden="true">{clock(time)} / {clock(position.duration)}</span>
    </div>
    {failed && <span className={css.error} role="alert">{labels.failed}</span>}
  </div>
}
