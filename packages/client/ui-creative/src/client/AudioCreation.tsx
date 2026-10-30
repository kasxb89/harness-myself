/** Account- and chat-scoped speech creation with explicit price confirmation and original-task recovery. @module */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { appPath, Button, IconChevronDownOutlineRegular, Menu, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AudioQuote, AudioRequest } from '@deepseek-ai/dsh-credits-index/src/audio-generation.ts'
import { generateAudio, quoteAudio, readAudioModels, readAudioSubmissions, recoverAudio,
  type AudioModel, type AudioSubmission } from './audio-api.ts'
import type {} from './locales.ts'
import css from './AudioCreation.module.css'

type Translate = TranslateNS<'creative'>

function Choice({ label, value, choices, change, disabled, labels }: {
  label: string
  value: string
  choices: readonly string[]
  change: (value: string) => void
  disabled?: boolean
  labels?: Readonly<Record<string, string>>
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open} portal autoFocus selectedId={value} onClose={() => { setOpen(false) }}
    items={choices.map(item => ({ id: item, label: labels?.[item] ?? item }))}
    onSelect={(id) => { change(id); setOpen(false) }}
    anchor={<Button variant="outline" size="sm" disabled={disabled} aria-label={label} aria-expanded={open}
      onClick={() => { setOpen(!open) }}>{labels?.[value] ?? value}<IconChevronDownOutlineRegular /></Button>} />
}
function errorKey(code: string): 'audio.failed' | 'audio.network' | 'audio.timeout' | 'audio.busy' | 'audio.permission' | 'audio.balance' | 'audio.invalid' | 'audio.notReady' | 'audio.storage' {
  switch (code) {
    case 'AUDIO_LOCAL_STORAGE': return 'audio.storage'
    case 'AUDIO_NETWORK': return 'audio.network'
    case 'AUDIO_TIMEOUT': return 'audio.timeout'
    case 'AUDIO_BUSY': return 'audio.busy'
    case 'AUDIO_PERMISSION': return 'audio.permission'
    case 'AUDIO_BALANCE': return 'audio.balance'
    case 'AUDIO_INVALID_REQUEST': case 'AUDIO_RESPONSE_INVALID': return 'audio.invalid'
    case 'AUDIO_NOT_READY': return 'audio.notReady'
    default: return 'audio.failed'
  }
}

/**
 * Present speech only when ordinary public discovery publishes audio models.
 * @param props - Explicit chat and localized copy; the parent unmounts this component on account changes.
 * @returns Independent speech form and durable submissions, or no entry when audio is undeclared.
 */
export function AudioCreation({ sessionId, t, expanded = false }: {
  readonly sessionId: string
  readonly t: Translate
  readonly expanded?: boolean
}): ReactNode {
  const [models, setModels] = useState<readonly AudioModel[]>([])
  const [discovery, setDiscovery] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [refresh, setRefresh] = useState(0)
  const [accountId, setAccountId] = useState('')
  const [modelId, setModelId] = useState('')
  const [input, setInput] = useState('')
  const [voice, setVoice] = useState('')
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav')
  const [speed, setSpeed] = useState<number | undefined>()
  const [instructions, setInstructions] = useState('')
  const [estimate, setEstimate] = useState<{ quote: AudioQuote; requestKey: string; deadlineMs: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [activeSubmissions, setActiveSubmissions] = useState(0)
  const [failure, setFailure] = useState<string | null>(null)
  const [submissions, setSubmissions] = useState<readonly AudioSubmission[]>([])
  const [querying, setQuerying] = useState<string | null>(null)
  const lifetime = useRef<AbortController | null>(null)
  const inFlight = useRef(false)
  const consumedEstimates = useRef(new Set<string>())
  const id = useId()
  const model = models.find(item => item.id === modelId)
  const params = model?.params
  const request: AudioRequest = { model: modelId, input, voice, response_format: format,
    ...(speed === undefined ? {} : { speed }), ...(instructions === '' ? {} : { instructions }) }
  const requestKey = JSON.stringify(request)
  const requestKeyRef = useRef(requestKey)
  requestKeyRef.current = requestKey
  const quoted = estimate !== null && estimate.requestKey === requestKey && estimate.quote.expires_at > Date.now() / 1000
    && estimate.deadlineMs > performance.now()
    ? estimate.quote : null
  const valid = params !== undefined && params.execution !== undefined && input.trim() !== ''
    && Array.from(input).length <= params.maxCharacters && params.voices.includes(voice) && params.formats.includes(format)
    && (instructions === '' || params.instructions && Array.from(instructions).length <= params.maxCharacters)
    && (speed === undefined || params.speedRange !== undefined && Number.isFinite(speed)
      && speed >= params.speedRange.minimum && speed <= params.speedRange.maximum)

  const selectModel = (selected: AudioModel): void => {
    setModelId(selected.id); setVoice(selected.params.voices[0] ?? '')
    setFormat(selected.params.formats[0] === 'mp3' ? 'mp3' : 'wav')
    setSpeed(undefined); setInstructions(''); setEstimate(null); setFailure(null)
  }
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    const current = (): boolean => !abort.signal.aborted
    setDiscovery('loading'); setEstimate(null); setModels([]); setAccountId('')
    void readAudioModels(abort.signal).then(async (result) => {
      if (!current()) return
      if (!result.ok) { setFailure(result.code); setDiscovery('failed'); return }
      setAccountId(result.value.accountId); setModels(result.value.models)
      setDiscovery('ready')
      const first = result.value.models[0]
      if (first !== undefined) selectModel(first)
      const history = await readAudioSubmissions(result.value.accountId, sessionId, abort.signal)
      if (current()) {
        if (history.ok) setSubmissions(history.value)
        else setFailure(history.code)
      }
    })
    return () => { abort.abort(); lifetime.current = null }
  }, [sessionId, refresh])
  useEffect(() => { setEstimate(null) }, [requestKey])
  useEffect(() => {
    if (estimate === null) return
    const timer = setTimeout(() => { setEstimate(null) }, Math.max(0,
      Math.min(estimate.quote.expires_at * 1000 - Date.now(), estimate.deadlineMs - performance.now())))
    return () => { clearTimeout(timer) }
  }, [estimate])

  const replace = (submission: AudioSubmission): void => {
    setSubmissions(before => [submission, ...before.filter(item => item.submissionId !== submission.submissionId)])
  }
  const quote = async (): Promise<void> => {
    if (!valid || inFlight.current || lifetime.current === null) return
    const abort = lifetime.current
    const captured = requestKey
    inFlight.current = true; setBusy(true); setFailure(null); setEstimate(null)
    try {
      const result = await quoteAudio(accountId, sessionId, request, abort.signal)
      if (abort.signal.aborted) return
      if (result.ok && requestKeyRef.current === captured) setEstimate({ quote: result.value, requestKey: captured,
        deadlineMs: performance.now() + Math.max(0, Math.min(60_000, result.value.expires_at * 1000 - Date.now())) })
      else if (!result.ok) setFailure(result.code)
    } finally { inFlight.current = false; if (!abort.signal.aborted) setBusy(false) }
  }
  const generate = async (): Promise<void> => {
    if (!valid || quoted === null || inFlight.current || lifetime.current === null || consumedEstimates.current.has(quoted.quote_id)) return
    if (estimate === null || quoted.expires_at <= Date.now() / 1000 || estimate.deadlineMs <= performance.now()) {
      setEstimate(null)
      return
    }
    const abort = lifetime.current
    const submissionId = randomUUID()
    const captured = request
    consumedEstimates.current.add(quoted.quote_id)
    setActiveSubmissions(value => value + 1); setFailure(null); setEstimate(null)
    replace({ submissionId, model: captured.model, status: 'pending' })
    try {
      const result = await generateAudio(accountId, sessionId, captured, quoted.quote_id, submissionId, abort.signal)
      if (abort.signal.aborted) return
      if (result.ok) replace(result.value)
      else { replace({ submissionId, model: captured.model, status: 'unknown', code: result.code }); setFailure(result.code) }
    } finally { if (!abort.signal.aborted) setActiveSubmissions(value => value - 1) }
  }
  const recover = async (submissionId: string): Promise<void> => {
    if (querying !== null || lifetime.current === null) return
    const abort = lifetime.current
    setQuerying(submissionId); setFailure(null)
    try {
      const result = await recoverAudio(accountId, sessionId, submissionId, abort.signal)
      if (abort.signal.aborted) return
      if (result.ok) replace(result.value)
      else setFailure(result.code)
    } finally { if (!abort.signal.aborted) setQuerying(null) }
  }
  if (!expanded && models.length === 0 && submissions.length === 0) return null
  return <details className={css.root} open={expanded || undefined}>
    <summary>{t('audio.title')}</summary>
    <div className={css.body}>
      {discovery === 'loading' && <StateDot state="ongoing" />}
      {discovery === 'failed' && <Button variant="outline" size="sm" disabled={busy}
        onClick={() => { setFailure(null); setRefresh(value => value + 1) }}>{t('retry')}</Button>}
      {discovery === 'ready' && models.length === 0 && <p className={css.notice}>{t('audio.noModels')}</p>}
      {models.length > 0 && <label className={css.field}>{t('audio.model')}<Choice label={t('audio.model')} value={modelId}
        choices={models.map(item => item.id)} labels={Object.fromEntries(models.map(item => [item.id, item.displayName]))}
        change={(modelId) => {
          const next = models.find(item => item.id === modelId)
          if (next !== undefined) selectModel(next)
        }} /></label>}
      {models.length === 0 ? null : params?.execution === undefined ? <p className={css.notice}>{t('audio.notReady')}</p> : <>
        <label className={css.field} htmlFor={`${id}-input`}>{t('audio.input', { count: params.maxCharacters })}
          <textarea id={`${id}-input`} className={css.input} value={input}
            onChange={(event) => { setInput(event.target.value) }} /></label>
        <div className={css.options}>
          <label className={css.field}>{t('audio.voice')}<Choice label={t('audio.voice')} value={voice}
            choices={params.voices} change={setVoice} /></label>
          <label className={css.field}>{t('audio.format')}<Choice label={t('audio.format')} value={format}
            choices={params.formats} change={(value) => { if (value === 'wav' || value === 'mp3') setFormat(value) }} /></label>
        </div>
        {params.speedRange !== undefined && <label className={css.field} htmlFor={`${id}-speed`}>{t('audio.speed')}
          <input id={`${id}-speed`} className={css.number} type="number" min={params.speedRange.minimum}
            max={params.speedRange.maximum} step="any" value={speed ?? ''}
            onChange={(event) => { setSpeed(event.target.value === '' ? undefined : event.target.valueAsNumber) }} /></label>}
        {params.instructions && <label className={css.field} htmlFor={`${id}-instructions`}>{t('audio.instructions')}
          <textarea id={`${id}-instructions`} className={css.input} value={instructions}
            onChange={(event) => { setInstructions(event.target.value) }} /></label>}
        <p className={css.hint}>{t('audio.quoteHint')}</p>
        <div className={css.actions}><Button variant="outline" size="sm" disabled={!valid || busy} onClick={() => { void quote() }}>
          {t('audio.quote')}</Button>
        <Button variant="primary" size="sm" disabled={!valid || busy || quoted === null} onClick={() => { void generate() }}>
          {quoted === null ? t('audio.generate') : t('audio.confirm', { amount: quoted.estimated_total, currency: quoted.currency })}</Button></div>
      </>}
      {(busy || activeSubmissions > 0) && <p className={css.notice} role="status">{t('audio.working')}</p>}
      {failure !== null && <p className={css.notice} role="alert">{t(errorKey(failure))}</p>}
      {submissions.length > 0 && <section className={css.history} aria-label={t('audio.tasks')}>
        <h3>{t('audio.tasks')}</h3>{submissions.map(item => <article className={css.task} key={item.submissionId}>
          <p>{item.model} · {t(item.status === 'completed' && item.code === 'AUDIO_SAVE_PENDING'
            ? 'audio.status.savePending' : `audio.status.${item.status}`)}</p>
          {item.status === 'completed' && item.mediaUrl !== undefined ? <>
            <audio controls preload="none" src={appPath(item.mediaUrl)} aria-label={t('audio.play')} />
            <a className={css.download} href={appPath(item.mediaUrl)} download={item.filename}>{t('download')}</a>
            {item.code === 'AUDIO_SAVE_PENDING' && <>
              <p className={css.hint}>{t('audio.savePending')}</p>
              <Button variant="outline" size="sm" disabled={querying !== null}
                onClick={() => { void recover(item.submissionId) }}>{t('audio.saveAgain')}</Button>
            </>}
          </> : item.status === 'pending' || item.status === 'unknown' ? <>
            <p className={css.hint}>{t('audio.queryHint')}</p><Button variant="outline" size="sm" disabled={querying !== null}
              onClick={() => { void recover(item.submissionId) }}>{t('audio.query')}</Button>
          </> : <p className={css.hint}>{t('audio.failureBilling')}</p>}
        </article>)}
      </section>}
    </div>
  </details>
}
