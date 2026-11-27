/** Reference-first media planning through the ordinary unsent chat composer. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button.tsx'
import { IconCloseOutlineRegular, IconInspectOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular } from './icons/index.tsx'
import { ImageLightbox } from './ImageLightbox.tsx'
import { VideoPlayer } from './VideoPlayer.tsx'
import { replicaEn, replicaZh } from './replica-locales.ts'
import { replicaPrompt, type ReplicaDraftOutcome, type ReplicaDraftRequest } from './replica-prompt.ts'
import css from './ReplicaWorkbench.module.css'

interface Media { readonly file: File; readonly url: string; readonly id: number }
/** Real draft preparation is supplied by each creation page's existing Conversation services. */
export interface ReplicaWorkbenchProps {
  readonly kind: 'image' | 'video'
  readonly language: 'zh' | 'en'
  readonly accountKey: string | null
  readonly onExit: () => void
  readonly onPrepareDraft: (request: ReplicaDraftRequest) => Promise<ReplicaDraftOutcome>
}
const matches = (file: File, kind: 'image' | 'video'): boolean => kind === 'image'
  ? file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif|heic|heif|bmp|tiff?)$/i.test(file.name)
  : file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name)

/**
 * Preview role-separated files and prepare an analysis-only normal chat draft.
 * @param props - Current account, localized media kind and real draft consumer.
 * @returns A creation-page workbench; selecting files or preparing a draft never sends a message.
 */
export function ReplicaWorkbench({ kind, language, accountKey, onExit, onPrepareDraft }: ReplicaWorkbenchProps): ReactNode {
  const labels = language === 'en' ? replicaEn : replicaZh
  const prefix = useId(), sequence = useRef(0), urls = useRef(new Set<string>())
  const inFlight = useRef<AbortController | null>(null), accepted = useRef(false)
  const [source, setSource] = useState<Media | null>(null), [subjects, setSubjects] = useState<readonly Media[]>([])
  const [keep, setKeep] = useState(''), [change, setChange] = useState(''), [specifications, setSpecifications] = useState('')
  const [count, setCount] = useState('1'), [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<ReplicaDraftOutcome | 'invalidFile' | null>(null)
  const [reviewedAccount, setReviewedAccount] = useState(accountKey), [preview, setPreview] = useState<Media | null>(null)
  const sourceInput = useRef<HTMLInputElement>(null), subjectsInput = useRef<HTMLInputElement>(null)
  const countValid = /^\d+$/.test(count.trim()) && /[1-9]/.test(count)
  const accountChanged = reviewedAccount !== accountKey
  useEffect(() => {
    inFlight.current?.abort()
    inFlight.current = null
    setBusy(false)
    accepted.current = false
  }, [accountKey])
  useEffect(() => () => { inFlight.current?.abort(); for (const url of urls.current) URL.revokeObjectURL(url) }, [])
  const release = (media: Media): void => { URL.revokeObjectURL(media.url); urls.current.delete(media.url) }
  const media = (file: File): Media => {
    const url = URL.createObjectURL(file)
    urls.current.add(url)
    return { file, url, id: ++sequence.current }
  }
  const pick = (files: readonly File[], role: 'source' | 'subject'): void => {
    if (busy || accepted.current) return
    if (files.some(file => !matches(file, role === 'source' ? kind : 'image'))) { setMessage('invalidFile'); return }
    setMessage(null)
    if (role === 'source') {
      const first = files[0]
      if (first === undefined) return
      if (source !== null) release(source)
      setSource(media(first))
    } else setSubjects(previous => [...previous, ...files.map(media)])
  }
  const prepare = async (): Promise<void> => {
    if (source === null || !countValid || accountKey === null || accountChanged || inFlight.current !== null || accepted.current) return
    const controller = new AbortController()
    inFlight.current = controller
    setBusy(true); setMessage(null)
    try {
      const outcome = await onPrepareDraft({
        prompt: replicaPrompt(labels, { kind, source: source.file, subjects: subjects.map(item => item.file), keep, change, specifications, count: count.trim().replace(/^0+/, '') }),
        files: [source.file, ...subjects.map(item => item.file)], accountKey, signal: controller.signal,
      })
      if (controller.signal.aborted) return
      accepted.current = outcome === 'ready'
      setMessage(outcome)
    } catch (_error) {
      // A failed handoff leaves the browser files and form available for review.
      if (!controller.signal.aborted) setMessage('unavailable')
    } finally {
      if (inFlight.current === controller) { inFlight.current = null; setBusy(false) }
    }
  }
  const renderMedia = (item: Media, role: 'source' | 'subject'): ReactNode => <li key={item.id} className={css.media}>
    <div className={css.preview}>
      {role === 'source' && kind === 'video' ? <VideoPlayer src={item.url} className={css.video} />
        : <button type="button" className={css.previewButton} aria-label={`${labels.preview}: ${item.file.name}`} onClick={() => { setPreview(item) }}><img src={item.url} alt={item.file.name} /></button>}
    </div>
    <div className={css.caption}><span>{item.file.name}</span><Button size="sm" aria-label={`${labels.remove}: ${item.file.name}`} disabled={busy || accepted.current}
      onClick={() => { release(item); if (role === 'source') setSource(null); else setSubjects(previous => previous.filter(entry => entry.id !== item.id)); setMessage(null) }}><IconCloseOutlineRegular size={14} /></Button></div>
  </li>
  return <section className={css.workbench} aria-label={labels.title}>
    <header className={css.header}><div><p className={css.eyebrow}><IconSparkleRegular size={16} />{labels.eyebrow}</p><h1>{labels.title}</h1><p className={css.intro}>{labels.intro}</p></div><Button variant="outline" onClick={onExit}>{labels.back}</Button></header>
    <ol className={css.steps} aria-label={labels.title}>{labels.steps.map((step, index) => <li key={step} aria-current={index === 0 ? 'step' : undefined}><span>{String(index + 1).padStart(2, '0')}</span>{step}</li>)}</ol>
    <div className={css.materials}>
      <section className={css.material}><div className={css.materialTitle}><span className={css.role}>{kind === 'image' ? labels.sourceImage : labels.sourceVideo}</span><span className={css.pending}>{labels.pending}</span></div><p>{labels.sourceHint}</p>
        {source === null ? <button type="button" className={css.dropzone} disabled={busy || accepted.current} onClick={() => { sourceInput.current?.click() }}><IconInspectOutlineRegular size={32} /><span>{labels.addSource}</span></button> : <><ul className={css.sourceMedia}>{renderMedia(source, 'source')}</ul><Button variant="outline" disabled={busy || accepted.current} onClick={() => { sourceInput.current?.click() }}>{labels.replaceSource}</Button></>}
        <input ref={sourceInput} type="file" aria-label={labels.addSource} accept={kind === 'image' ? 'image/*' : 'video/*'} hidden onChange={(event) => { pick([...event.target.files ?? []], 'source'); event.target.value = '' }} />
      </section>
      <section className={css.material}>
        <div className={css.materialTitle}><span className={css.role}>{labels.subjects}</span>
          <span className={css.pending}>{labels.pending}</span></div><p>{labels.subjectHint}</p>
        <ul className={css.subjectMedia}>{subjects.map(item => renderMedia(item, 'subject'))}<li><button type="button" className={css.addSubject} disabled={busy || accepted.current} onClick={() => { subjectsInput.current?.click() }}><IconPlusOutlineRegular size={24} /><span>{labels.addSubject}</span></button></li></ul>
        <input ref={subjectsInput} type="file" aria-label={labels.addSubject} accept="image/*" multiple hidden onChange={(event) => { pick([...event.target.files ?? []], 'subject'); event.target.value = '' }} />
      </section>
    </div>
    <div className={css.constraints}><label>{labels.keep}<textarea aria-label={labels.keep} value={keep} disabled={busy || accepted.current} placeholder={labels.keepPlaceholder} rows={3} onChange={(event) => { setKeep(event.target.value) }} /></label><label>{labels.change}<textarea aria-label={labels.change} value={change} disabled={busy || accepted.current} placeholder={labels.changePlaceholder} rows={3} onChange={(event) => { setChange(event.target.value) }} /></label><label className={css.specifications}>{labels.specs}<textarea aria-label={labels.specs} value={specifications} disabled={busy || accepted.current} placeholder={labels.specsPlaceholder} rows={2} aria-describedby={`${prefix}-specs`} onChange={(event) => { setSpecifications(event.target.value) }} /><span id={`${prefix}-specs`} className={css.hint}>{labels.specsHint}</span></label><label>{labels.count}<input aria-label={labels.count} value={count} disabled={busy || accepted.current} inputMode="numeric" aria-invalid={!countValid} aria-describedby={`${prefix}-count`} onChange={(event) => { setCount(event.target.value) }} /><span id={`${prefix}-count`} className={countValid ? css.hint : css.error}>{countValid ? labels.countHint : labels.invalidCount}</span></label></div>
    {accountChanged && <div className={css.notice} role="status"><span>{labels.accountChanged}</span>{accountKey !== null && <Button variant="outline" onClick={() => { setReviewedAccount(accountKey); setMessage(null) }}>{labels.confirmAccount}</Button>}</div>}
    {message !== null && <p className={message === 'ready' ? css.notice : css.error} role="status">{labels[message]}</p>}
    <footer className={css.footer}><div><p className={css.hint}>{labels.safety}</p><p className={css.hint} id={`${prefix}-prepare`}>{accountKey === null ? labels.signedOut : source === null ? labels.sourceRequired : ''}</p></div><Button variant="primary" disabled={busy || source === null || !countValid || accountKey === null || accountChanged || accepted.current} aria-describedby={`${prefix}-prepare`} onClick={() => { void prepare() }}>{busy ? labels.preparing : labels.prepare}</Button></footer>
    {preview !== null && <ImageLightbox src={preview.url} alt={preview.file.name}
      onClose={() => { setPreview(null) }} labels={{ dialog: labels.preview, close: labels.back }} />}
  </section>
}
