/**
 * The Video page: text-to-video, image-to-video and reference-driven
 * generation through the local new-api relay, on the product's sign-in and
 * balance.
 *
 * The form is assembled from the selected model's declared capability, so a
 * model that has no reference-video input never shows that slot and a model
 * that cannot mix first/last frames with reference media says so instead of
 * failing upstream. Duration, resolution and ratio are the model's own menus.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './VideoPage.module.css'

/** The merged module's mode switch: one rail entry, these two modes behind it. */
function ModeTabs({ mode, t, onOther }: {
  mode: 'image' | 'video'
  t: (key: string) => string
  /** Open the mode this page is not: the module's other panel. */
  onOther: () => void
}): ReactNode {
  return (
    <SegmentedTabs
      className={css.modeTabs}
      items={[
        { value: 'image', label: t('tab.image'), id: 'gen-mode-image', panelId: 'imagegen' },
        { value: 'video', label: t('tab.video'), id: 'gen-mode-video', panelId: 'videogen' },
      ]}
      value={mode}
      onChange={(next) => { if (next !== mode) onOther() }}
      label={t('mode.label')}
    />
  )
}


/** What the plugin injects into the page. */
export interface VideogenInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
  /** Open this module's image mode, which is the sibling package's panel. */
  readonly openImage: () => void
}

interface Envelope<T> {
  readonly ok: boolean
  readonly code?: string | null
  readonly message?: string | null
  readonly sessionInvalid?: boolean
  readonly payload?: T
}

interface SessionInfo {
  readonly signedIn: boolean
  readonly creditsPerYuan: number
}

interface Balance {
  readonly balance_points: number
}

/** One video model's parameter menu, as the deployment declares it. */
interface VideoModel {
  readonly id: string
  readonly displayName: string
  readonly groups: readonly string[]
  readonly verified: boolean
  readonly route: string
  readonly params: {
    readonly durations: readonly number[]
    readonly minDuration: number
    readonly maxDuration: number
    readonly resolutions: readonly string[]
    readonly ratios: readonly string[]
    readonly maxFrameImages: number
    readonly maxReferenceImages: number
    readonly maxReferenceVideos: number
    readonly maxReferenceAudios: number
    readonly frameSlots: number
    readonly audio: boolean
    readonly audioToggle: boolean
    readonly watermark: boolean
    readonly modes: readonly string[]
    readonly seed: boolean
    readonly mixFramesAndReferences: boolean
  }
  readonly source: string
}

interface Catalog {
  readonly group: string | null
  readonly video: readonly VideoModel[]
}

interface ArtifactItem {
  readonly path: string
  readonly name: string
  readonly kind: string
  readonly mtimeMs?: number
}

interface Reference {
  readonly assetId: string
  readonly name: string
  readonly url: string
}

type Slot = 'image' | 'video' | 'audio'

const SLOT_TYPES: Record<Slot, { readonly accept: string; readonly types: readonly string[] }> = {
  image: { accept: 'image/png,image/jpeg,image/webp', types: ['image/png', 'image/jpeg', 'image/webp'] },
  video: { accept: 'video/mp4,video/quicktime', types: ['video/mp4', 'video/quicktime'] },
  audio: { accept: 'audio/mpeg,audio/wav,audio/mp4,audio/x-wav', types: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-wav'] },
}

/**
 * Camera intents: the row only carries the keys — the visible label and the
 * suffix each one appends to the prompt live in the dictionaries
 * (`preset_<key>` / `preset_text_<key>`).
 */
const PRESETS: readonly string[] = ['push', 'orbit', 'track', 'aerial', 'sunset', 'neon']

/** The send control's glyph: an arrow while idle, a ring while working. */
function SendGlyph({ running }: { running: boolean }): ReactNode {
  return running
    ? (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="22 11" strokeLinecap="round" />
      </svg>
    )
    : (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 12.6V3.8M4.2 7.4 8 3.6l3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
}

async function get<T>(path: string): Promise<Envelope<T>> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  return await response.json() as Envelope<T>
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<Envelope<T>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  return await response.json() as Envelope<T>
}

export function VideoPage(props: PropsRuntime<'main'> & VideogenInjected): ReactNode {
  const { t, openImage } = props
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [creditsPerYuan, setCreditsPerYuan] = useState(1000)
  const [balance, setBalance] = useState<number | null>(null)
  const [models, setModels] = useState<readonly VideoModel[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [modelId, setModelId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [durationIndex, setDurationIndex] = useState(0)
  const [resolution, setResolution] = useState('')
  const [ratio, setRatio] = useState('')
  const [mode, setMode] = useState('')
  const [seed, setSeed] = useState('')
  const [audio, setAudio] = useState(true)
  const [firstFrame, setFirstFrame] = useState<Reference | null>(null)
  const [lastFrame, setLastFrame] = useState<Reference | null>(null)
  const [slots, setSlots] = useState<Record<Slot, Reference[]>>({ image: [], video: [], audio: [] })
  const [uploading, setUploading] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'running' | 'saving' | 'done'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [result, setResult] = useState<{ path: string } | null>(null)
  const [history, setHistory] = useState<readonly ArtifactItem[]>([])
  const startedAt = useRef<number>(0)
  /** The composer's field: the row's own ground under the words. */
  const promptField = useRef<HTMLTextAreaElement | null>(null)

  const model = useMemo(() => models.find(entry => entry.id === modelId) ?? models[0] ?? null, [modelId, models])
  const params = model?.params ?? null
  const durations = params?.durations ?? []
  const resolutions = params?.resolutions ?? []
  const ratios = params?.ratios ?? []
  const duration = durations[Math.min(durationIndex, Math.max(0, durations.length - 1))] ?? 0
  const mixed = params !== null && !params.mixFramesAndReferences
    && (firstFrame !== null || lastFrame !== null)
    && (slots.image.length + slots.video.length + slots.audio.length) > 0

  /** Follow the deployment's video menu; keep the current pick when it survives. */
  const loadModels = useCallback(async (): Promise<void> => {
    const answer = await get<Catalog>('/credits/api/media/catalog')
    const catalog = answer.payload
    if (catalog === undefined) {
      setModelsError(answer.message ?? answer.code ?? 'unavailable')
      return
    }
    setModelsError(null)
    setModels(catalog.video)
    setModelId(current => current !== '' && catalog.video.some(entry => entry.id === current)
      ? current
      : catalog.video[0]?.id ?? '')
  }, [])

  const loadBalance = useCallback(async () => {
    const answer = await get<Balance>('/credits/api/summary')
    if (answer.sessionInvalid === true) { setSignedIn(false); setBalance(null); return }
    const points = answer.payload?.balance_points
    if (typeof points === 'number') setBalance(points)
    else setBalance(null)
  }, [])

  /** The newest generated clips, for the strip under the form. */
  const loadHistory = useCallback(async (): Promise<void> => {
    const answer = await fetch('/artifacts/api/list', { headers: { accept: 'application/json' } })
      .then(async response => await response.json())
      .catch(() => null) as { items?: readonly ArtifactItem[]; payload?: { items?: readonly ArtifactItem[] } } | null
    const items = answer?.items ?? answer?.payload?.items ?? []
    setHistory(items
      .filter(item => item.kind === 'video' && item.path.includes('/credits/media/'))
      .sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0))
      .slice(0, 8))
  }, [])

  /** Re-read the product sign-in and everything that depends on it. */
  const refreshState = useCallback(async (): Promise<void> => {
    const session = await get<SessionInfo>('/credits/api/session')
    const info = session.payload
    setCreditsPerYuan(info?.creditsPerYuan ?? 1000)
    setSignedIn(info?.signedIn === true)
    if (info?.signedIn === true) await Promise.all([loadBalance(), loadModels(), loadHistory()])
    else setBalance(null)
  }, [loadBalance, loadHistory, loadModels])

  useEffect(() => { void refreshState() }, [refreshState])

  /**
   * The sign-in belongs to the product, not to this page, so the page follows
   * it while it is open — a sign-in from the Credits column unlocks this page,
   * and a sign-out clears the balance it was showing.
   */
  useEffect(() => {
    const revisit = (): void => { void refreshState() }
    const timer = setInterval(revisit, 30_000)
    window.addEventListener('focus', revisit)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', revisit)
    }
  }, [refreshState])

  useEffect(() => {
    if (phase !== 'running') return undefined
    const timer = setInterval(() => { setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)) }, 1000)
    return () => { clearInterval(timer) }
  }, [phase])

  /** Snap every pick to the selected model's declared menus. */
  useEffect(() => {
    if (params === null) return
    setDurationIndex(current => current < params.durations.length ? current : 0)
    setResolution(current => params.resolutions.includes(current) ? current : params.resolutions[0] ?? '')
    setMode(current => params.modes.includes(current) ? current : '')
    setRatio((current) => {
      if (params.ratios.includes(current) && current !== 'adaptive') return current
      return params.ratios.find(item => item !== 'adaptive') ?? params.ratios[0] ?? ''
    })
    if (params.frameSlots === 0) { setFirstFrame(null); setLastFrame(null) }
    if (params.frameSlots === 1) setLastFrame(null)
    setSlots(current => ({
      image: current.image.slice(0, params.maxReferenceImages),
      video: current.video.slice(0, params.maxReferenceVideos),
      audio: current.audio.slice(0, params.maxReferenceAudios),
    }))
  }, [params])

  /** Upload one reference file as raw bytes; the host keeps it on this machine. */
  const upload = useCallback(async (slot: Slot, file: File): Promise<Reference | null> => {
    const spec = SLOT_TYPES[slot]
    if (!spec.types.includes(file.type)) {
      setFailure(t('uploadFailed', { message: file.type === '' ? t('unknownType') : file.type }))
      return null
    }
    const key = `dsh-asset-${globalThis.crypto?.randomUUID?.() ?? String(Date.now())}`.replace(/[^\x21-\x7e]/g, '')
    const response = await fetch('/credits/api/assets', {
      method: 'POST',
      headers: {
        'content-type': file.type,
        'x-file-name': file.name,
        'x-idempotency-key': key.slice(0, 128),
        accept: 'application/json',
      },
      body: file,
    })
    const answer = await response.json() as {
      ok: boolean
      code?: string | null
      message?: string | null
      sessionInvalid?: boolean
      asset?: { assetId: string | null } | null
    }
    if (answer.sessionInvalid === true) { setSignedIn(false); setFailure(t('noAuth')); return null }
    const assetId = answer.asset?.assetId
    if (!answer.ok || assetId === null || assetId === undefined) {
      setFailure(t('uploadFailed', { message: answer.message ?? answer.code ?? t('unknown') }))
      return null
    }
    return { assetId, name: file.name, url: URL.createObjectURL(file) }
  }, [t])

  const pick = useCallback(async (slot: Slot, files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0 || params === null) return
    setFailure(null)
    setUploading(slot)
    try {
      const ceiling = slot === 'image' ? params.maxReferenceImages
        : slot === 'video' ? params.maxReferenceVideos : params.maxReferenceAudios
      const added: Reference[] = []
      for (const file of [...files].slice(0, Math.max(0, ceiling - slots[slot].length))) {
        const reference = await upload(slot, file)
        if (reference !== null) added.push(reference)
      }
      if (added.length > 0) setSlots(current => ({ ...current, [slot]: [...current[slot], ...added] }))
    } finally {
      setUploading(null)
    }
  }, [params, slots, upload])

  const pickFrame = useCallback(async (which: 'first' | 'last', files: FileList | null): Promise<void> => {
    const file = files?.[0]
    if (file === undefined) return
    setFailure(null)
    setUploading(which)
    try {
      const reference = await upload('image', file)
      if (reference === null) return
      if (which === 'first') setFirstFrame(reference)
      else setLastFrame(reference)
    } finally {
      setUploading(null)
    }
  }, [upload])

  const generate = useCallback(async () => {
    setFailure(null)
    setMessage(null)
    setResult(null)
    if (prompt.trim() === '') { setFailure(t('promptPlaceholder')); return }
    if (model === null) { setFailure(t('noModel')); return }
    setPhase('running')
    startedAt.current = Date.now()
    setElapsed(0)
    const frames = [firstFrame, lastFrame].filter((item): item is Reference => item !== null)
    const answer = await post<{ path: string; taskId?: string }>(
      '/credits/api/video/tasks?source=newapi-generate',
      {
        prompt: prompt.trim(),
        model: model.id,
        durationSeconds: duration,
        ...resolution === '' ? {} : { resolution },
        ...ratio === '' ? {} : { ratio },
        ...mode === '' ? {} : { mode },
        ...seed.trim() === '' || !Number.isInteger(Number(seed)) ? {} : { seed: Number(seed) },
        ...params?.audioToggle === true ? { audio } : {},
        frameImages: frames.map(item => item.assetId),
        referenceImages: slots.image.map(item => item.assetId),
        referenceVideos: slots.video.map(item => item.assetId),
        referenceAudios: slots.audio.map(item => item.assetId),
      },
    )
    if (answer.sessionInvalid === true) { setSignedIn(false); setPhase('idle'); setFailure(t('noAuth')); return }
    if (!answer.ok || answer.payload === undefined) {
      setPhase('idle')
      if (answer.code === 'INSUFFICIENT_POINTS') setFailure(t('insufficient'))
      else if (answer.code === 'TIMEOUT') setMessage(t('timeout'))
      else setFailure(t('failed', { message: answer.message ?? answer.code ?? t('unknown') }))
      return
    }
    setPhase('saving')
    setResult({ path: answer.payload.path })
    setPhase('done')
    setMessage(t('done'))
    await Promise.all([loadBalance(), loadHistory()])
  }, [prompt, model, duration, resolution, ratio, firstFrame, lastFrame, slots, loadBalance, loadHistory, t])

  const rawUrl = (path: string): string => `/artifacts/api/raw?path=${encodeURIComponent(path)}`

  const fileList = (slot: Slot): ReactNode => {
    const entries = slots[slot]
    if (entries.length === 0) return null
    return (
      <ul className={css.files}>
        {entries.map(item => (
          <li key={item.assetId} className={css.fileRow}>
            {slot === 'image'
              ? <img className={css.fileThumb} src={item.url} alt={item.name} />
              : <span className={css.fileIcon}>{slot === 'video' ? '▶' : '♪'}</span>}
            <span className={css.fileName}>{item.name}</span>
            <button
              type="button"
              className={css.link}
              onClick={() => {
                setSlots(current => ({ ...current, [slot]: current[slot].filter(entry => entry.assetId !== item.assetId) }))
              }}
            >
              {t('remove')}
            </button>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        <ModeTabs mode='video' t={t} onOther={openImage} />
        {signedIn === true && balance !== null && (
          <span className={css.balance}>
            {t('balance', { points: balance.toLocaleString('zh-CN'), yuan: (balance / creditsPerYuan).toFixed(2) })}
          </span>
        )}
      </header>

      {signedIn === false && <p className={css.hint}>{t('signedOut')}</p>}

      {signedIn === true && (
        <>
          <section className={css.card}>
            {modelsError !== null && <p className={css.error}>{t('modelsFailed', { message: modelsError })}</p>}
            {models.length === 0 && modelsError === null && <p className={css.hint}>{t('noModel')}</p>}

            {/* The composer: the words own the top of the card, the controls
                share one bar at its foot, and the send control is the round
                primary action on that bar's right edge. */}
            <label className={css.promptField}>
              <textarea
                ref={promptField}
                className={css.textarea}
                rows={5}
                value={prompt}
                aria-label={t('prompt')}
                placeholder={t('promptPlaceholder')}
                onChange={(event) => { setPrompt(event.target.value) }}
              />
              <span className={css.count} aria-hidden="true">{prompt.length}</span>
            </label>
            <div className={css.presets}>
              {PRESETS.map(preset => (
                <button
                  key={preset}
                  type="button"
                  className={css.chip}
                  onClick={() => {
                    const suffix = t(`preset_text_${preset}`)
                    setPrompt(current => current.includes(suffix) ? current : `${current}${suffix}`)
                  }}
                >
                  {t(`preset_${preset}`)}
                </button>
              ))}
            </div>

            {durations.length > 0 && (
              <div className={css.field}>
                <span className={css.label}>{t('duration')}<span className={css.count}>{t('seconds', { n: String(duration) })}</span></span>
                {durations.length === 1
                  ? <p className={css.static}>{t('onlyDuration', { n: String(duration) })}</p>
                  : (
                    <input
                      className={css.range}
                      type="range"
                      min={0}
                      max={durations.length - 1}
                      step={1}
                      value={Math.min(durationIndex, durations.length - 1)}
                      onChange={(event) => { setDurationIndex(Number(event.target.value)) }}
                    />
                  )}
                {durations.length > 1 && (
                  <div className={css.ticks}>
                    <span>{durations[0]}</span>
                    <span>{durations[durations.length - 1]}</span>
                  </div>
                )}
              </div>
            )}

            <div className={css.grid}>
              {resolutions.length > 0 && (
                <div className={css.field}>
                  <span className={css.label}>{t('resolution')}</span>
                  <div className={css.segmented}>
                    {resolutions.map(option => (
                      <button
                        key={option}
                        type="button"
                        className={resolution === option ? `${css.segment} ${css.segmentActive}` : css.segment}
                        onClick={() => { setResolution(option) }}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {ratios.length > 0 && (
              <div className={css.field}>
                <span className={css.label}>{t('ratio')}</span>
                <div className={css.ratios}>
                  {ratios.map(option => (
                    <button
                      key={option}
                      type="button"
                      className={ratio === option ? `${css.ratio} ${css.ratioActive}` : css.ratio}
                      onClick={() => { setRatio(option) }}
                    >
                      <span
                        className={css.ratioShape}
                        style={option === 'adaptive' ? undefined : { aspectRatio: option.replace(':', ' / ') }}
                      />
                      <span className={css.ratioText}>{option === 'adaptive' ? t('ratioAdaptive') : option}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {params !== null && (params.modes.length > 0 || params.seed || params.audioToggle) && (
              <div className={css.grid}>
                {params.modes.length > 0 && (
                  <div className={css.field}>
                    <span className={css.label}>{t('mode')}</span>
                    <div className={css.segmented}>
                      {params.modes.map(option => (
                        <button
                          key={option}
                          type="button"
                          className={mode === option ? `${css.segment} ${css.segmentActive}` : css.segment}
                          onClick={() => { setMode(option) }}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {params.seed && (
                  <label className={css.field}>
                    <span className={css.label}>{t('seed')}</span>
                    <input
                      className={css.select}
                      inputMode="numeric"
                      placeholder={t('seedHint')}
                      value={seed}
                      onChange={(event) => { setSeed(event.target.value.replace(/[^0-9]/g, '')) }}
                    />
                  </label>
                )}
                {params.audioToggle && (
                  <label className={css.field}>
                    <span className={css.label}>{t('audio')}</span>
                    <div className={css.segmented}>
                      <button
                        type="button"
                        className={audio ? `${css.segment} ${css.segmentActive}` : css.segment}
                        onClick={() => { setAudio(true) }}
                      >
                        {t('on')}
                      </button>
                      <button
                        type="button"
                        className={!audio ? `${css.segment} ${css.segmentActive}` : css.segment}
                        onClick={() => { setAudio(false) }}
                      >
                        {t('off')}
                      </button>
                    </div>
                  </label>
                )}
              </div>
            )}

            {params !== null && params.frameSlots > 0 && (
              <div className={css.grid}>
                <div className={css.field}>
                  <span className={css.label}>{t('firstFrame')}</span>
                  <label className={css.dropzone}>
                    <input
                      type="file"
                      accept={SLOT_TYPES.image.accept}
                      hidden
                      onChange={(event) => { void pickFrame('first', event.target.files); event.target.value = '' }}
                    />
                    {firstFrame === null
                      ? <span>{uploading === 'first' ? t('uploading') : t('frameHint')}</span>
                      : <img className={css.frame} src={firstFrame.url} alt={firstFrame.name} />}
                  </label>
                  {firstFrame !== null && (
                    <button type="button" className={css.link} onClick={() => { setFirstFrame(null) }}>{t('remove')}</button>
                  )}
                </div>
                {params.frameSlots > 1 && (
                  <div className={css.field}>
                    <span className={css.label}>{t('lastFrame')}</span>
                    <label className={css.dropzone}>
                      <input
                        type="file"
                        accept={SLOT_TYPES.image.accept}
                        hidden
                        onChange={(event) => { void pickFrame('last', event.target.files); event.target.value = '' }}
                      />
                      {lastFrame === null
                        ? <span>{uploading === 'last' ? t('uploading') : t('frameHint')}</span>
                        : <img className={css.frame} src={lastFrame.url} alt={lastFrame.name} />}
                    </label>
                    {lastFrame !== null && (
                      <button type="button" className={css.link} onClick={() => { setLastFrame(null) }}>{t('remove')}</button>
                    )}
                  </div>
                )}
              </div>
            )}

            {params !== null && params.maxReferenceImages > 0 && (
              <div className={css.field}>
                <span className={css.label}>{t('referenceImages')}<span className={css.count}>{slots.image.length}/{params.maxReferenceImages}</span></span>
                <label className={css.dropzone}>
                  <input
                    type="file"
                    accept={SLOT_TYPES.image.accept}
                    multiple
                    hidden
                    onChange={(event) => { void pick('image', event.target.files); event.target.value = '' }}
                  />
                  <span>{uploading === 'image' ? t('uploading') : t('dropImages')}</span>
                </label>
                {fileList('image')}
              </div>
            )}

            {params !== null && params.maxReferenceVideos > 0 && (
              <div className={css.field}>
                <span className={css.label}>{t('referenceVideos')}<span className={css.count}>{slots.video.length}/{params.maxReferenceVideos}</span></span>
                <label className={css.dropzone}>
                  <input
                    type="file"
                    accept={SLOT_TYPES.video.accept}
                    multiple
                    hidden
                    onChange={(event) => { void pick('video', event.target.files); event.target.value = '' }}
                  />
                  <span>{uploading === 'video' ? t('uploading') : t('dropVideos')}</span>
                </label>
                {fileList('video')}
              </div>
            )}

            {params !== null && params.maxReferenceAudios > 0 && (
              <div className={css.field}>
                <span className={css.label}>{t('referenceAudios')}<span className={css.count}>{slots.audio.length}/{params.maxReferenceAudios}</span></span>
                <label className={css.dropzone}>
                  <input
                    type="file"
                    accept={SLOT_TYPES.audio.accept}
                    multiple
                    hidden
                    onChange={(event) => { void pick('audio', event.target.files); event.target.value = '' }}
                  />
                  <span>{uploading === 'audio' ? t('uploading') : t('dropAudios')}</span>
                </label>
                {fileList('audio')}
              </div>
            )}

            {mixed && <p className={css.error}>{t('mixForbidden')}</p>}

            <div className={css.composerBar}>
              <label className={css.modelInline}>
                <select
                  className={css.select}
                  value={model?.id ?? ''}
                  aria-label={t('model')}
                  onChange={(event) => { setModelId(event.target.value) }}
                >
                  {models.map(entry => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
                </select>
              </label>
              <span className={css.mode}>{t('costHint')}</span>
              {params !== null && (
                <ul className={css.badges}>
                  <li className={css.badge}>{t('badgeDuration', { range: params.durations.length === 1 ? String(params.durations[0]) : `${String(params.minDuration)}–${String(params.maxDuration)}` })}</li>
                  {resolutions.length > 0 && <li className={css.badge}>{t('badgeResolution', { list: resolutions.join(' / ') })}</li>}
                  {params.frameSlots > 0 && <li className={css.badge}>{t('badgeFrames', { n: String(params.frameSlots) })}</li>}
                  {params.maxReferenceImages > 0 && <li className={css.badge}>{t('badgeRefImages', { n: String(params.maxReferenceImages) })}</li>}
                  {params.maxReferenceVideos > 0 && <li className={css.badge}>{t('badgeRefVideos', { n: String(params.maxReferenceVideos) })}</li>}
                  {params.maxReferenceAudios > 0 && <li className={css.badge}>{t('badgeRefAudios', { n: String(params.maxReferenceAudios) })}</li>}
                  {params.audio && <li className={css.badge}>{t('badgeAudio')}</li>}
                </ul>
              )}
              <button
                type="button"
                className={css.send}
                aria-label={phase === 'running' ? t('runningShort') : t('submit')}
                title={phase === 'running' ? t('runningShort') : t('submit')}
                onClick={() => { void generate() }}
                disabled={phase === 'running' || phase === 'saving' || model === null || mixed}
              >
                <SendGlyph running={phase === 'running'} />
              </button>
            </div>
            {model !== null && (
              <p className={css.hint}>
                {model.source === 'fallback' ? t('sourceUnknown') : t('sourceLine', { source: model.source })}
                {!model.verified && ` · ${t('unverified')}`}
              </p>
            )}
          </section>

          {phase === 'running' && (
            <div className={css.progress}>
              <div className={css.bar} />
              <span className={css.notice}>{t('running', { seconds: String(elapsed) })}</span>
            </div>
          )}
          {phase === 'saving' && <p className={css.notice}>{t('saving')}</p>}
          {message !== null && <p className={css.notice}>{message}</p>}
          {failure !== null && <p className={css.error}>{failure}</p>}

          {result !== null && (
            <section className={css.card}>
              <h2 className={css.cardTitle}>{t('result')}</h2>
              <video className={css.video} src={rawUrl(result.path)} controls />
              <div className={css.figureMeta}>
                <a className={css.link} href={rawUrl(result.path)} target="_blank" rel="noreferrer">{t('open')}</a>
                <a className={css.link} href={rawUrl(result.path)} download={result.path.split('/').pop() ?? 'video.mp4'}>{t('download')}</a>
                <code className={css.path}>{result.path}</code>
              </div>
            </section>
          )}

          <section className={css.card}>
            <h2 className={css.cardTitle}>{t('history')}</h2>
            {history.length === 0
              ? <p className={css.hint}>{t('historyEmpty')}</p>
              : (
                <ul className={css.history}>
                  {history.map(item => (
                    <li key={item.path} className={css.historyItem}>
                      <button type="button" className={css.historyButton} onClick={() => { setResult({ path: item.path }) }}>
                        <video className={css.historyThumb} src={rawUrl(item.path)} muted />
                        <span className={css.historyName}>{item.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </>
      )}
    </div>
  )
}
