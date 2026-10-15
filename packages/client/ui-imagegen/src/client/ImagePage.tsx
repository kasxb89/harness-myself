/**
 * The AI image page: text-to-image and editing through the local new-api relay,
 * sharing the product's sign-in and balance.
 *
 * Every control here comes from the selected model's own capability: sizes,
 * count, quality, background, format, moderation and the reference limit are
 * whatever the deployment declared for that model. Pick a model that offers no
 * background choice and the control is simply not there — nothing is guessed
 * from a fixed list, and nothing is shown that the gateway would refuse.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ImagePage.module.css'

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
export interface ImagegenInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
  /** Open this module's video mode, which is the sibling package's panel. */
  readonly openVideo: () => void
}

interface Envelope<T> {
  readonly ok: boolean
  readonly code?: string | null
  readonly message?: string | null
  readonly sessionInvalid?: boolean
  readonly retryAfterSeconds?: number | null
  readonly payload?: T
}

interface SessionInfo {
  readonly signedIn: boolean
  readonly creditsPerYuan: number
}

interface Balance {
  readonly balance_points: number
}

/** One image model's parameter menu, as the deployment declares it. */
interface ImageModel {
  readonly id: string
  readonly displayName: string
  readonly groups: readonly string[]
  readonly verified: boolean
  readonly route: string
  readonly params: {
    readonly sizes: readonly string[]
    readonly maxCount: number
    readonly maxEdits: number
    readonly qualities: readonly string[]
    readonly backgrounds: readonly string[]
    readonly formats: readonly string[]
    readonly moderations: readonly string[]
    readonly seed: boolean
  }
  readonly source: string
}

interface Catalog {
  readonly group: string | null
  readonly image: readonly ImageModel[]
}

/** One entry of the artifacts index, used for the recent-work strip. */
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

/**
 * Style intents: the row only carries the keys — the visible label and the
 * suffix each one appends to the prompt live in the dictionaries
 * (`preset_<key>` / `preset_text_<key>`).
 */
const PRESETS: readonly string[] = ['photo', 'illustration', '3d', 'cinematic', 'minimal', 'poster']

/**
 * "你想做什么?" starters: one tap fills the composer with a working brief, so
 * a first image does not require knowing how to phrase one. The copy lives in
 * the dictionaries (name / hint / prompt per key) — these rows carry only the
 * key and the glyph.
 */
const TEMPLATES: readonly { readonly key: string }[] = [
  { key: 'product' },
  { key: 'poster' },
  { key: 'portrait' },
  { key: 'scene' },
  { key: 'illustration' },
  { key: 'render3d' },
]

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

/** One template card's glyph, drawn from the same 20px frame for all six. */
function TemplateGlyph({ name }: { name: string }): ReactNode {
  const paths: Record<string, ReactNode> = {
    product: <path d="M4.6 7.4 10 4.6l5.4 2.8v5.2L10 15.4l-5.4-2.8V7.4Zm0 0L10 10.2l5.4-2.8M10 10.2v5.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />,
    poster: <><rect x="4.2" y="3.6" width="11.6" height="12.8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M7 7.2h6M7 10h6M7 12.8h3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>,
    portrait: <><circle cx="10" cy="8.2" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M5.2 15.4c.7-2.4 2.5-3.6 4.8-3.6s4.1 1.2 4.8 3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>,
    scene: <><path d="M4.2 13.6 8 9.4l2.6 2.8 2-2 3.2 3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><circle cx="7.4" cy="6.6" r="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="3.6" y="4.2" width="12.8" height="11.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" /></>,
    illustration: <path d="M10 3.4c3.4 0 6.4 2.4 6.4 5.6 0 2-1.6 3.2-3.4 3.2h-1.2c-.8 0-1.4.6-1.4 1.4 0 .4.2.8.4 1.2.2.3.4.7.4 1.1 0 .8-.7 1.5-1.6 1.5-3.4 0-6.6-2.9-6.6-6.6s3.6-7.4 7-7.4Zm-2.8 6.2a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />,
    render3d: <path d="M10 3.6 16 7v6l-6 3.4L4 13V7l6-3.4Zm0 0V10m6-3L10 10 4 7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />,
  }
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      {paths[name] ?? paths.product}
    </svg>
  )
}

/** The widest common ratio for one pixel size, or null for `auto`. */
function ratioOf(size: string): string | null {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/.exec(size.trim())
  if (match === null) return null
  const width = Number(match[1])
  const height = Number(match[2])
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b)
  const divisor = gcd(width, height)
  const left = Math.round(width / divisor)
  const right = Math.round(height / divisor)
  // Only真 ratios read as ratios; 1536x1024 reduces to 3:2, 1024x1024 to 1:1.
  if (left > 40 || right > 40) return null
  return `${String(left)}:${String(right)}`
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

export function ImagePage(props: PropsRuntime<'main'> & ImagegenInjected): ReactNode {
  const { t, openVideo } = props
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [creditsPerYuan, setCreditsPerYuan] = useState(1000)
  const [balance, setBalance] = useState<number | null>(null)
  const [models, setModels] = useState<readonly ImageModel[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [modelId, setModelId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('')
  const [quality, setQuality] = useState('')
  const [background, setBackground] = useState('')
  const [format, setFormat] = useState('')
  const [compression, setCompression] = useState(90)
  const [moderation, setModeration] = useState('')
  const [seed, setSeed] = useState('')
  const [count, setCount] = useState(1)
  const [advanced, setAdvanced] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'running' | 'saving' | 'done'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [result, setResult] = useState<{ paths: readonly string[] } | null>(null)
  const [references, setReferences] = useState<Reference[]>([])
  const [uploading, setUploading] = useState(false)
  const [history, setHistory] = useState<readonly ArtifactItem[]>([])
  const startedAt = useRef<number>(0)
  /** The composer's field: a template's brief lands here, under the cursor. */
  const promptField = useRef<HTMLTextAreaElement | null>(null)

  const model = useMemo(() => models.find(entry => entry.id === modelId) ?? models[0] ?? null, [modelId, models])
  const params = model?.params ?? null
  const sizes = params?.sizes ?? []
  const qualities = params?.qualities ?? []
  const backgrounds = params?.backgrounds ?? []
  const formats = params?.formats ?? []
  const moderations = params?.moderations ?? []
  const maxEdits = params?.maxEdits ?? 0
  const maxCount = params?.maxCount ?? 1
  const compressible = formats.some(item => item === 'jpeg' || item === 'webp') && format !== '' && format !== 'png'

  /** Follow the deployment's image menu; keep the current pick when it survives. */
  const loadModels = useCallback(async (): Promise<void> => {
    const answer = await get<Catalog>('/credits/api/media/catalog')
    const catalog = answer.payload
    if (catalog === undefined) {
      setModelsError(answer.message ?? answer.code ?? 'unavailable')
      return
    }
    setModelsError(null)
    setModels(catalog.image)
    setModelId(current => current !== '' && catalog.image.some(entry => entry.id === current)
      ? current
      : catalog.image[0]?.id ?? '')
  }, [])

  const loadBalance = useCallback(async () => {
    const answer = await get<Balance>('/credits/api/summary')
    if (answer.sessionInvalid === true) { setSignedIn(false); setBalance(null); return }
    const points = answer.payload?.balance_points
    if (typeof points === 'number') setBalance(points)
    else setBalance(null)
  }, [])

  /** The newest generated images, for the strip under the form. */
  const loadHistory = useCallback(async (): Promise<void> => {
    // The artifacts index answers bare (`{ roots, items }`) while the credits
    // routes answer wrapped; accept either so a change on one side cannot
    // leave the strip silently empty.
    const answer = await fetch('/artifacts/api/list', { headers: { accept: 'application/json' } })
      .then(async response => await response.json())
      .catch(() => null) as { items?: readonly ArtifactItem[]; payload?: { items?: readonly ArtifactItem[] } } | null
    const items = answer?.items ?? answer?.payload?.items ?? []
    const images = items
      .filter(item => item.kind === 'image' && item.path.includes('/credits/media/'))
      .sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0))
      .slice(0, 12)
    setHistory(images)
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
   * it while it is open: signing in from the Credits column unlocks generation
   * here without reopening the panel, and a sign-out takes the balance away.
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

  /** Snap every pick to the selected model's menu. */
  useEffect(() => {
    if (params === null) return
    setSize(current => params.sizes.includes(current) ? current : params.sizes[0] ?? '')
    setQuality(current => params.qualities.includes(current) ? current : '')
    setBackground(current => params.backgrounds.includes(current) ? current : '')
    setFormat(current => params.formats.includes(current) ? current : '')
    setModeration(current => params.moderations.includes(current) ? current : '')
    setCount(current => current > params.maxCount ? params.maxCount : current)
    setReferences(current => current.slice(0, params.maxEdits))
  }, [params])

  useEffect(() => {
    if (phase !== 'running') return undefined
    const timer = setInterval(() => { setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)) }, 1000)
    return () => { clearInterval(timer) }
  }, [phase])

  /** Upload one reference image as raw bytes; the host keeps it on this machine. */
  const uploadReference = useCallback(async (file: File): Promise<void> => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setFailure(t('uploadFailed', { message: t('unsupportedType') }))
      return
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
    if (answer.sessionInvalid === true) { setSignedIn(false); setFailure(t('noAuth')); return }
    const assetId = answer.asset?.assetId
    if (!answer.ok || assetId === null || assetId === undefined) {
      setFailure(t('uploadFailed', { message: answer.message ?? answer.code ?? t('unknown') }))
      return
    }
    setReferences(current => [...current, { assetId, name: file.name, url: URL.createObjectURL(file) }])
  }, [t])

  const pickReferences = useCallback(async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return
    setFailure(null)
    setUploading(true)
    try {
      for (const file of [...files].slice(0, Math.max(0, maxEdits - references.length))) await uploadReference(file)
    } finally {
      setUploading(false)
    }
  }, [maxEdits, references.length, uploadReference])

  const generate = useCallback(async () => {
    setFailure(null)
    setMessage(null)
    setResult(null)
    if (prompt.trim() === '') { setFailure(t('promptPlaceholder')); return }
    setPhase('running')
    startedAt.current = Date.now()
    setElapsed(0)
    const answer = await post<{ path: string; paths?: readonly string[]; model?: string }>(
      '/credits/api/image/generate',
      {
        prompt: prompt.trim(),
        model: model?.id ?? '',
        ...size === '' ? {} : { size },
        ...quality === '' ? {} : { quality },
        ...background === '' ? {} : { background },
        ...format === '' ? {} : { format },
        ...moderation === '' ? {} : { moderation },
        ...compressible ? { compression } : {},
        ...seed.trim() === '' || !Number.isInteger(Number(seed)) ? {} : { seed: Number(seed) },
        count,
        references: references.map(item => item.assetId),
      },
    )
    if (answer.sessionInvalid === true) { setSignedIn(false); setPhase('idle'); setFailure(t('noAuth')); return }
    if (!answer.ok || answer.payload === undefined) {
      setPhase('idle')
      if (answer.code === 'INSUFFICIENT_POINTS') setFailure(t('insufficient'))
      else setFailure(t('failed', { message: answer.message ?? answer.code ?? t('unknown') }))
      return
    }
    setPhase('saving')
    setResult({ paths: answer.payload.paths ?? [answer.payload.path] })
    setPhase('done')
    setMessage(t('done'))
    await Promise.all([loadBalance(), loadHistory()])
  }, [
    prompt, model, size, quality, background, format, moderation, compressible, compression,
    count, references, loadBalance, loadHistory, t,
  ])

  const rawUrl = (path: string): string => `/artifacts/api/raw?path=${encodeURIComponent(path)}`

  /** Fill the composer from a starter, then leave the cursor in the words. */
  const applyTemplate = useCallback((key: string): void => {
    setPrompt(t(`tpl_${key}_prompt`))
    promptField.current?.focus()
  }, [t])

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        <ModeTabs mode='image' t={t} onOther={openVideo} />
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

            {sizes.length > 0 && (
              <div className={css.field}>
                <span className={css.label}>{t('ratio')}</span>
                <div className={css.ratios}>
                  {sizes.map((option) => {
                    const ratio = ratioOf(option)
                    return (
                      <button
                        key={option}
                        type="button"
                        className={option === size ? `${css.ratio} ${css.ratioActive}` : css.ratio}
                        onClick={() => { setSize(option) }}
                      >
                        <span className={css.ratioShape} style={ratio === null ? undefined : { aspectRatio: ratio.replace(':', ' / ') }} />
                        <span className={css.ratioText}>{ratio ?? t('sizeAuto')}</span>
                        <span className={css.ratioPixels}>{option === 'auto' ? t('sizeFollowPrompt') : option}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className={css.grid}>
              {qualities.length > 0 && (
                <div className={css.field}>
                  <span className={css.label}>{t('quality')}</span>
                  <div className={css.segmented}>
                    <button
                      type="button"
                      className={quality === '' ? `${css.segment} ${css.segmentActive}` : css.segment}
                      onClick={() => { setQuality('') }}
                    >
                      {t('inherit')}
                    </button>
                    {qualities.map(option => (
                      <button
                        key={option}
                        type="button"
                        className={quality === option ? `${css.segment} ${css.segmentActive}` : css.segment}
                        onClick={() => { setQuality(option) }}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {maxCount > 1 && (
                <label className={css.field}>
                  <span className={css.label}>{t('count')}</span>
                  <select className={css.select} value={String(count)} onChange={(event) => { setCount(Number(event.target.value)) }}>
                    {Array.from({ length: maxCount }, (_, index) => index + 1)
                      .map(item => <option key={item} value={String(item)}>{String(item)}</option>)}
                  </select>
                </label>
              )}
            </div>

            {(backgrounds.length > 0 || formats.length > 0 || moderations.length > 0 || params?.seed === true) && (
              <div className={css.advancedWrap}>
                <button type="button" className={css.ghost} onClick={() => { setAdvanced(current => !current) }}>
                  {advanced ? t('advancedHide') : t('advancedShow')}
                </button>
                {advanced && (
                  <div className={css.grid}>
                    {backgrounds.length > 0 && (
                      <div className={css.field}>
                        <span className={css.label}>{t('background')}</span>
                        <div className={css.segmented}>
                          <button
                            type="button"
                            className={background === '' ? `${css.segment} ${css.segmentActive}` : css.segment}
                            onClick={() => { setBackground('') }}
                          >
                            {t('inherit')}
                          </button>
                          {backgrounds.map(option => (
                            <button
                              key={option}
                              type="button"
                              className={background === option ? `${css.segment} ${css.segmentActive}` : css.segment}
                              onClick={() => { setBackground(option) }}
                            >
                              {t(`bg_${option}`)}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {formats.length > 0 && (
                      <div className={css.field}>
                        <span className={css.label}>{t('format')}</span>
                        <div className={css.segmented}>
                          <button
                            type="button"
                            className={format === '' ? `${css.segment} ${css.segmentActive}` : css.segment}
                            onClick={() => { setFormat('') }}
                          >
                            {t('inherit')}
                          </button>
                          {formats.map(option => (
                            <button
                              key={option}
                              type="button"
                              className={format === option ? `${css.segment} ${css.segmentActive}` : css.segment}
                              onClick={() => { setFormat(option) }}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {compressible && (
                      <label className={css.field}>
                        <span className={css.label}>{t('compression', { n: String(compression) })}</span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={compression}
                          onChange={(event) => { setCompression(Number(event.target.value)) }}
                        />
                      </label>
                    )}
                    {params?.seed === true && (
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
                    {moderations.length > 0 && (
                      <div className={css.field}>
                        <span className={css.label}>{t('moderation')}</span>
                        <div className={css.segmented}>
                          <button
                            type="button"
                            className={moderation === '' ? `${css.segment} ${css.segmentActive}` : css.segment}
                            onClick={() => { setModeration('') }}
                          >
                            {t('inherit')}
                          </button>
                          {moderations.map(option => (
                            <button
                              key={option}
                              type="button"
                              className={moderation === option ? `${css.segment} ${css.segmentActive}` : css.segment}
                              onClick={() => { setModeration(option) }}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {maxEdits > 0 && (
              <div className={css.field}>
                <span className={css.label}>{t('reference')}<span className={css.count}>{references.length}/{maxEdits}</span></span>
                <label className={css.dropzone}>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    hidden
                    onChange={(event) => {
                      void pickReferences(event.target.files)
                      event.target.value = ''
                    }}
                  />
                  <span>{uploading ? t('uploading') : t('dropHint')}</span>
                </label>
                {references.length > 0 && (
                  <ul className={css.thumbs}>
                    {references.map(item => (
                      <li key={item.assetId} className={css.thumb}>
                        <img src={item.url} alt={item.name} />
                        <button
                          type="button"
                          className={css.remove}
                          onClick={() => { setReferences(current => current.filter(entry => entry.assetId !== item.assetId)) }}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

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
              <span className={css.mode}>
                {references.length === 0 ? t('modeGenerate') : t('modeEdit', { count: String(references.length) })}
              </span>
              {params !== null && (
                <ul className={css.badges}>
                  {sizes.length > 0 && <li className={css.badge}>{t('badgeSizes', { n: String(sizes.length) })}</li>}
                  {maxCount > 1 && <li className={css.badge}>{t('badgeCount', { n: String(maxCount) })}</li>}
                  <li className={css.badge}>
                    {maxEdits > 0 ? t('badgeEdits', { n: String(maxEdits) }) : t('badgeNoEdits')}
                  </li>
                  {qualities.length > 0 && <li className={css.badge}>{t('badgeQuality')}</li>}
                </ul>
              )}
              <button
                type="button"
                className={css.send}
                aria-label={phase === 'running' ? t('runningShort') : t('submit')}
                title={phase === 'running' ? t('runningShort') : t('submit')}
                onClick={() => { void generate() }}
                disabled={phase === 'running' || phase === 'saving' || model === null}
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

          <section className={css.templates}>
            <header className={css.templatesHead}>
              <h2 className={css.templatesTitle}>{t('templatesTitle')}</h2>
              <span className={css.templatesHint}>{t('templatesHint')}</span>
            </header>
            <ul className={css.templateGrid}>
              {TEMPLATES.map(template => (
                <li key={template.key}>
                  <button
                    type="button"
                    className={css.templateCard}
                    onClick={() => { applyTemplate(template.key) }}
                  >
                    <span className={css.templateGlyph}><TemplateGlyph name={template.key} /></span>
                    <span className={css.templateName}>{t(`tpl_${template.key}`)}</span>
                    <span className={css.templateHint}>{t(`tpl_${template.key}_hint`)}</span>
                  </button>
                </li>
              ))}
            </ul>
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
              <h2 className={css.cardTitle}>{t('preview')}</h2>
              <div className={css.gallery}>
                {result.paths.map(path => (
                  <figure key={path} className={css.figure}>
                    <img className={css.figureImg} src={rawUrl(path)} alt={t('preview')} />
                    <figcaption className={css.figureMeta}>
                      <a className={css.link} href={rawUrl(path)} target="_blank" rel="noreferrer">{t('open')}</a>
                      <a className={css.link} href={rawUrl(path)} download={path.split('/').pop() ?? 'image.png'}>{t('download')}</a>
                      {maxEdits > 0 && (
                        <button
                          type="button"
                          className={css.link}
                          onClick={() => {
                            void (async () => {
                              const blob = await (await fetch(rawUrl(path))).blob()
                              await uploadReference(new File([blob], path.split('/').pop() ?? 'image.png', { type: blob.type || 'image/png' }))
                            })()
                          }}
                        >
                          {t('useAsReference')}
                        </button>
                      )}
                    </figcaption>
                  </figure>
                ))}
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
                      <img src={rawUrl(item.path)} alt={item.name} />
                      <span className={css.historyName}>{item.name}</span>
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
