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
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ImagePage.module.css'

/** What the plugin injects into the page. */
export interface ImagegenInjected {
  /** Translate one key of this plugin's namespace. */
  readonly t: (key: string, values?: Record<string, string>) => string
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

const PRESETS: readonly { readonly label: string; readonly text: string }[] = [
  { label: 'photo', text: '，35mm 胶片质感，自然光，浅景深，细节丰富' },
  { label: 'illustration', text: '，扁平插画风格，干净的色块，柔和阴影' },
  { label: '3d', text: '，3D 渲染，柔和的全局光照，光滑材质' },
  { label: 'cinematic', text: '，电影感构图，戏剧性打光，低饱和' },
  { label: 'minimal', text: '，极简构图，留白，单一主体' },
  { label: 'poster', text: '，海报版式，主体居中，上方留出标题空间' },
]

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
  const { t } = props
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
      setFailure(t('uploadFailed', { message: 'unsupported type' }))
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
      setFailure(t('uploadFailed', { message: answer.message ?? answer.code ?? 'unknown' }))
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
      else setFailure(t('failed', { message: answer.message ?? answer.code ?? 'unknown' }))
      return
    }
    setPhase('saving')
    setResult({ paths: answer.payload.paths ?? [answer.payload.path] })
    setPhase('done')
    setMessage(t('done'))
    await Promise.all([loadBalance(), loadHistory()])
  }, [prompt, model, size, quality, background, format, moderation, compressible, compression, count, references, loadBalance, loadHistory, t])

  const rawUrl = (path: string): string => `/artifacts/api/raw?path=${encodeURIComponent(path)}`

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
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
            <div className={css.modelRow}>
              <label className={css.field}>
                <span className={css.label}>{t('model')}</span>
                <select className={css.select} value={model?.id ?? ''} onChange={event => { setModelId(event.target.value) }}>
                  {models.map(entry => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
                </select>
              </label>
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
            </div>
            {modelsError !== null && <p className={css.error}>{t('modelsFailed', { message: modelsError })}</p>}

            <label className={css.field}>
              <span className={css.label}>{t('prompt')}<span className={css.count}>{prompt.length}</span></span>
              <textarea
                className={css.textarea}
                rows={4}
                value={prompt}
                placeholder={t('promptPlaceholder')}
                onChange={event => { setPrompt(event.target.value) }}
              />
            </label>
            <div className={css.presets}>
              {PRESETS.map(preset => (
                <button
                  key={preset.label}
                  type="button"
                  className={css.chip}
                  onClick={() => { setPrompt(current => current.includes(preset.text) ? current : `${current}${preset.text}`) }}
                >
                  {t(`preset_${preset.label}`)}
                </button>
              ))}
            </div>

            {sizes.length > 0 && (
              <div className={css.field}>
                <span className={css.label}>{t('ratio')}</span>
                <div className={css.ratios}>
                  {sizes.map(option => {
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
                  <select className={css.select} value={String(count)} onChange={event => { setCount(Number(event.target.value)) }}>
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
                          onChange={event => { setCompression(Number(event.target.value)) }}
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
                          onChange={event => { setSeed(event.target.value.replace(/[^0-9]/g, '')) }}
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
                    onChange={event => {
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

            <div className={css.actions}>
              <button
                type="button"
                className={css.primary}
                onClick={() => { void generate() }}
                disabled={phase === 'running' || phase === 'saving' || model === null}
              >
                {phase === 'running' ? t('runningShort') : t('submit')}
              </button>
              <span className={css.mode}>
                {references.length === 0 ? t('modeGenerate') : t('modeEdit', { count: String(references.length) })}
              </span>
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
