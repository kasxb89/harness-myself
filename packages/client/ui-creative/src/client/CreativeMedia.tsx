/** Actual saved media, localized facts and explicit generation states. */
import { useEffect, useState, type ReactNode } from 'react'
import { appPath, ImageLightbox, StateDot, VideoPlayer, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CreativeOutput, CreativeStatus } from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'
import type {} from './locales.ts'
import css from './CreativeBody.module.css'
type Translate = TranslateNS<'creative'>

function dot(status: CreativeStatus): StateDotState {
  switch (status) {
    case 'completed': return 'done'
    case 'running': case 'saving': case 'editing': return 'ongoing'
    case 'failed': return 'error'
    case 'interrupted': case 'unknown': return 'warning'
    case 'planned': case 'cancelled': return 'idle'
  }
}
export function Status({ value, compact = false, t }: { value: CreativeStatus; compact?: boolean; t: Translate }): ReactNode {
  return <span className={css.status} role="status" aria-label={compact ? t(`status.${value}`) : undefined}>
    <StateDot state={dot(value)} />{!compact && t(`status.${value}`)}</span>
}
export function Facts({ entries, t }: { entries: readonly (readonly [string, string])[]; t: Translate }): ReactNode {
  return <dl className={css.facts}>{entries.map(([label, value]) => <div key={label}>
    <dt>{label}</dt><dd>{value || t('notSpecified')}</dd>
  </div>)}</dl>
}
export function timecode(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000)
  const minutes = Math.floor(milliseconds / 60_000)
  const rest = (milliseconds % 60_000) / 1000
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`
}
export function SavedMedia({ output, visible, t }: { output: CreativeOutput; visible: boolean; t: Translate }): ReactNode {
  const [failed, setFailed] = useState(false)
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null)
  const frames = output.kind === 'video' ? output.frames ?? [] : []
  useEffect(() => { setFailed(false); setPreview(null) }, [output.url])
  useEffect(() => { if (!visible) setPreview(null) }, [visible])
  return <figure className={css.media} data-creative-output={output.kind}>
    {failed ? <p className={css.notice}>{t('mediaFailed')}</p>
      : output.kind === 'image'
        ? <button type="button" className={css.imageButton} aria-label={t('preview')}
          onClick={() => { setPreview({ url: output.url, name: output.name }) }}>
          <img src={appPath(output.url)} alt={output.name} loading="lazy" onError={() => { setFailed(true) }} />
        </button>
        : output.kind === 'video'
          ? <VideoPlayer progressLabels={{ seek: t('playback.seek'), unavailable: t('playback.waiting'), failed: t('playback.failed') }} controls preload="metadata" src={appPath(output.url)} poster={output.posterUrl === undefined ? undefined : appPath(output.posterUrl)} aria-label={output.name}
            onError={() => { setFailed(true) }} />
          : <audio controls preload="metadata" src={appPath(output.url)} aria-label={output.name} onError={() => { setFailed(true) }} />}
    <figcaption className={css.mediaFooter}>
      <span className={css.mediaName}>{output.name}</span>
      <a className={css.download} href={appPath(output.url)} download={output.name}>{t('download')}</a>
    </figcaption>
    {output.kind === 'video' && (frames.length > 0 ? <>
      <h4 className={css.frameTitle}>{t('frames')}</h4>
      <div className={css.frames}>{frames.map((frame, index) => <figure className={css.frame} key={`${index}:${frame.url}`}>
        <button type="button" className={css.imageButton} aria-label={t('frame', { name: output.name, time: timecode(frame.timeSeconds) })}
          onClick={() => { setPreview({ url: frame.url, name: t('frame', { name: output.name, time: timecode(frame.timeSeconds) }) }) }}>
          <img src={appPath(frame.url)} loading="lazy" alt={t('frame', { name: output.name, time: timecode(frame.timeSeconds) })} />
        </button><figcaption>{timecode(frame.timeSeconds)}</figcaption>
      </figure>)}</div>
    </> : <p className={css.notice}>{t(output.previewUnavailable === true ? 'framesUnavailable' : 'framePending')}</p>)}
    {preview !== null && <ImageLightbox src={appPath(preview.url)} alt={preview.name}
      labels={{ dialog: t('preview'), close: t('close') }} onClose={() => { setPreview(null) }} />}
  </figure>
}
