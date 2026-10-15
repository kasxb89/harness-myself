/** Image creation workspace driven by the deployment's existing media catalog. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconCloseOutlineRegular, IconCopyOutlineRegular, IconEditOutlineRegular,
  IconPlusOutlineRegular, IconSearchOutlineRegular, IconSendOutlineRegular,
  IconSettingsOutlineRegular, IconSparkleRegular, ImageLightbox, SegmentedTabs, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createImageDraftStore, ImageDraft } from './draft-store.ts'
import css from './ImagePage.module.css'

/** Plain callbacks injected by this plugin's registration. */
export interface ImagegenInjected {
  readonly t: (key: string, values?: Record<string, string>) => string
  readonly openVideo: () => void
  readonly readDraft: () => ImageDraft
  readonly createReferencePreview: (file: File) => string
  readonly releaseReferencePreview: (url: string) => void
}

interface Envelope<T> {
  readonly ok: boolean
  readonly code?: string | null
  readonly message?: string | null
  readonly sessionInvalid?: boolean
  readonly payload?: T
}

interface SessionInfo { readonly signedIn: boolean; readonly creditsPerYuan: number }
interface Balance { readonly balance_points: number }
interface ImageModel {
  readonly id: string
  readonly displayName: string
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
}
interface Catalog { readonly image: readonly ImageModel[] }
interface ArtifactItem {
  readonly path: string
  readonly name: string
  readonly kind: string
  readonly mtimeMs?: number
}

type ImagePageProps = PropsRuntime<'main'> & PropsStore<ReturnType<typeof createImageDraftStore>> & ImagegenInjected

const PRESETS = ['photo', 'illustration', '3d', 'cinematic', 'minimal', 'poster'] as const
const CATEGORIES = ['all', 'commerce', 'design', 'lifestyle'] as const
const TEMPLATES = [
  { key: 'recreate', category: 'commerce', glyph: 'copy' },
  { key: 'details', category: 'commerce', glyph: 'edit' },
  { key: 'campaign', category: 'commerce', glyph: 'sparkle' },
  { key: 'product', category: 'commerce', glyph: 'sparkle' },
  { key: 'poster', category: 'design', glyph: 'edit' },
  { key: 'portrait', category: 'lifestyle', glyph: 'copy' },
  { key: 'scene', category: 'lifestyle', glyph: 'sparkle' },
  { key: 'illustration', category: 'design', glyph: 'edit' },
  { key: 'render3d', category: 'design', glyph: 'copy' },
] as const

async function get<T>(path: string): Promise<Envelope<T>> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
  return await response.json() as Envelope<T>
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<Envelope<T>> {
  const response = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
  return await response.json() as Envelope<T>
}

function rawUrl(path: string): string {
  return `/artifacts/api/raw?path=${encodeURIComponent(path)}`
}

/**
 * Render the image mode and retain its draft when the video mode is selected.
 * @param props - framework runtime/store shares and localized plugin callbacks.
 * @returns the image creation workspace.
 */
export function ImagePage(props: ImagePageProps): ReactNode {
  const { t, openVideo, createReferencePreview, releaseReferencePreview, readDraft, actions } = props
  const draft = props.useStore(state => state)
  const {
    prompt, modelId, size, quality, background, format, compression, moderation, seed, count,
    references, uploading, generationStartedAt, sessionInvalid, message, failure, resultPaths: result,
  } = draft
  const running = generationStartedAt !== null
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [creditsPerYuan, setCreditsPerYuan] = useState(1000)
  const [balance, setBalance] = useState<number | null>(null)
  const [models, setModels] = useState<readonly ImageModel[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [stateError, setStateError] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const setMessage = useCallback((message: string | null): void => { actions.patch({ message }) }, [actions])
  const setFailure = useCallback((failure: string | null): void => { actions.patch({ failure }) }, [actions])
  const [dragging, setDragging] = useState(false)
  const [history, setHistory] = useState<readonly ArtifactItem[]>([])
  const [historyError, setHistoryError] = useState(false)
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(null)
  const [category, setCategory] = useState<string>('all')
  const [search, setSearch] = useState('')
  const promptField = useRef<HTMLTextAreaElement | null>(null)
  const fileField = useRef<HTMLInputElement | null>(null)

  const model = useMemo(() => models.find(entry => entry.id === modelId) ?? models[0] ?? null, [modelId, models])
  const params = model?.params ?? null
  const maxEdits = params?.maxEdits ?? 0
  const isSignedIn = signedIn === true && !sessionInvalid
  const canUpload = isSignedIn && maxEdits > references.length && !uploading && !running
  const visibleTemplates = TEMPLATES.filter((template) => {
    const words = `${t(`tpl_${template.key}`)} ${t(`tpl_${template.key}_hint`)}`.toLocaleLowerCase()
    return (category === 'all' || template.category === category) && words.includes(search.trim().toLocaleLowerCase())
  })
  const works = useMemo(() => {
    const recent = new Map<string, { path: string; name: string }>()
    for (const path of result) recent.set(path, { path, name: path.split('/').pop() ?? path })
    for (const item of history) if (!recent.has(item.path)) recent.set(item.path, item)
    return [...recent.values()]
  }, [history, result])

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const answer = await get<Catalog>('/credits/api/media/catalog')
      if (!answer.ok || answer.payload === undefined) {
        setModelsError(answer.message ?? answer.code ?? t('unknown'))
        return
      }
      const items = answer.payload.image
      setModels(items)
      setModelsError(items.length === 0 ? t('noModels') : null)
    } catch (_error) {
      // Catalog errors leave the last readable model choices visible.
      setModelsError(t('connectionFailure'))
    }
  }, [t])

  const loadBalance = useCallback(async (): Promise<void> => {
    try {
      const answer = await get<Balance>('/credits/api/summary')
      if (answer.sessionInvalid === true) { actions.patch({ sessionInvalid: true }); setBalance(null); return }
      setBalance(answer.payload?.balance_points ?? null)
    } catch (_error) {
      // A balance read must not turn a successfully saved image into a failure.
      setBalance(null)
    }
  }, [actions])

  const loadHistory = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/artifacts/api/list', { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
      const answer = await response.json() as { items?: readonly ArtifactItem[]; payload?: { items?: readonly ArtifactItem[] } }
      const items = answer.items ?? answer.payload?.items
      if (items === undefined) throw new Error('INVALID_ARTIFACT_LIST')
      setHistory(items.filter(item => item.kind === 'image' && item.path.includes('/credits/media/'))
        .sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0)).slice(0, 24))
      setHistoryError(false)
    } catch (_error) {
      // Retain the visible works while the index is temporarily unavailable.
      setHistoryError(true)
    }
  }, [])

  const refreshState = useCallback(async (): Promise<void> => {
    const startedWithInvalidSession = readDraft().sessionInvalid
    try {
      const answer = await get<SessionInfo>('/credits/api/session')
      if (!answer.ok || answer.payload === undefined) throw new Error('SESSION_UNAVAILABLE')
      const info = answer.payload
      setCreditsPerYuan(info.creditsPerYuan)
      setSignedIn(info.signedIn)
      if (!info.signedIn) actions.patch({ sessionInvalid: true })
      else if (startedWithInvalidSession) actions.patch({ sessionInvalid: false })
      setStateError(false)
      if (info.signedIn) await Promise.all([loadBalance(), loadModels()])
      else setBalance(null)
    } catch (_error) {
      setStateError(true)
    }
  }, [actions, loadBalance, loadModels, readDraft])

  useEffect(() => { void refreshState(); void loadHistory() }, [refreshState, loadHistory])
  useEffect(() => {
    const revisit = (): void => { void refreshState() }
    const timer = setInterval(revisit, 30_000)
    window.addEventListener('focus', revisit)
    return () => { clearInterval(timer); window.removeEventListener('focus', revisit) }
  }, [refreshState])

  useEffect(() => {
    if (params === null || model === null) return
    const current = readDraft()
    const kept = current.references.slice(0, params.maxEdits)
    for (const item of current.references.slice(params.maxEdits)) releaseReferencePreview(item.url)
    if (kept.length !== current.references.length) setMessage(t('referencesAdjusted', { n: String(params.maxEdits) }))
    actions.patch({
      modelId: model.id, referenceLimit: params.maxEdits,
      size: params.sizes.includes(current.size) ? current.size : params.sizes[0] ?? '',
      quality: params.qualities.includes(current.quality) ? current.quality : '',
      background: params.backgrounds.includes(current.background) ? current.background : '',
      format: params.formats.includes(current.format) ? current.format : '',
      moderation: params.moderations.includes(current.moderation) ? current.moderation : '',
      count: Math.max(1, Math.min(current.count, params.maxCount)),
      seed: params.seed ? current.seed : '', references: kept,
    })
  }, [params, model, actions, releaseReferencePreview, readDraft, setMessage, t])

  useEffect(() => {
    if (generationStartedAt === null) { void loadHistory(); return undefined }
    const tick = (): void => { setElapsed(Math.floor((Date.now() - generationStartedAt) / 1000)) }
    tick()
    const timer = setInterval(tick, 1000)
    return () => { clearInterval(timer) }
  }, [generationStartedAt, loadHistory])

  const removeReference = useCallback((assetId: string): void => {
    const current = readDraft()
    if (current.uploading || current.generationStartedAt !== null) return
    const removed = current.references.find(item => item.assetId === assetId)
    if (removed !== undefined) releaseReferencePreview(removed.url)
    actions.removeReference(assetId)
  }, [actions, readDraft, releaseReferencePreview])

  const clearReferences = useCallback((): void => {
    const current = readDraft()
    if (current.uploading || current.generationStartedAt !== null) return
    for (const item of current.references) releaseReferencePreview(item.url)
    actions.patch({ references: [] })
  }, [actions, readDraft, releaseReferencePreview])

  const addReferences = useCallback(async (source: readonly File[] | { readonly path: string }): Promise<void> => {
    const current = readDraft()
    if (current.uploading || current.generationStartedAt !== null || current.sessionInvalid || signedIn !== true) return
    const selected = models.find(entry => entry.id === current.modelId)
    const limit = Math.min(selected?.params.maxEdits ?? 0, current.referenceLimit)
    const slots = Math.max(0, limit - current.references.length)
    if (slots === 0 || selected === undefined) { setFailure(t('referenceLimit', { n: String(limit) })); return }
    actions.patch({ uploading: true, failure: null })
    try {
      let files: readonly File[]
      if ('path' in source) {
        const response = await fetch(rawUrl(source.path))
        if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
        const blob = await response.blob()
        files = [new File([blob], source.path.split('/').pop() ?? 'image.png', { type: blob.type || 'image/png' })]
      } else files = source
      if (files.length > slots) setMessage(t('referenceLimit', { n: String(limit) }))
      for (const file of files.slice(0, slots)) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
          setFailure(t('uploadFailed', { message: t('unsupportedType') })); continue
        }
        if (file.size === 0 || file.size > 32 * 1024 * 1024) {
          setFailure(t('uploadFailed', { message: t('fileSizeLimit') })); continue
        }
        const beforeUpload = readDraft()
        if (beforeUpload.modelId !== selected.id || beforeUpload.references.length >= beforeUpload.referenceLimit) break
        const response = await fetch('/credits/api/assets', {
          method: 'POST',
          headers: {
            'content-type': file.type, 'x-file-name': encodeURIComponent(file.name),
            'x-idempotency-key': `dsh-asset-${globalThis.crypto.randomUUID()}`, accept: 'application/json',
          },
          body: file,
        })
        if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
        const answer = await response.json() as Envelope<never> & { asset?: { assetId: string | null } | null }
        if (answer.sessionInvalid === true) { actions.patch({ sessionInvalid: true, failure: t('noAuth') }); break }
        const assetId = answer.asset?.assetId
        if (!answer.ok || assetId === null || assetId === undefined) {
          setFailure(t('uploadFailed', { message: answer.message ?? answer.code ?? t('unknown') })); continue
        }
        const latest = readDraft()
        if (latest.modelId !== selected.id || latest.references.length >= Math.min(limit, latest.referenceLimit)) break
        actions.appendReference({ assetId, name: file.name, url: createReferencePreview(file) }, selected.id, limit)
      }
    } catch (_error) {
      setFailure(t('uploadFailed', { message: t('connectionFailure') }))
    } finally {
      actions.patch({ uploading: false })
    }
  }, [actions, createReferencePreview, models, readDraft, setFailure, setMessage, signedIn, t])

  const generate = useCallback(async (): Promise<void> => {
    const current = readDraft()
    if (current.uploading || current.generationStartedAt !== null || current.sessionInvalid || signedIn !== true) return
    const selected = models.find(entry => entry.id === current.modelId)
    if (selected === undefined) return
    const accepted = selected.params
    if (current.prompt.trim() === '') { setFailure(t('promptRequired')); promptField.current?.focus(); return }
    if (accepted.seed && current.seed.trim() !== '' && !Number.isSafeInteger(Number(current.seed))) {
      setFailure(t('seedInvalid')); return
    }
    actions.patch({ generationStartedAt: Date.now(), failure: null, message: null })
    setElapsed(0)
    try {
      const answer = await post<{ path: string; paths?: readonly string[] }>('/credits/api/image/generate', {
        prompt: current.prompt.trim(), model: selected.id, count: Math.max(1, Math.min(current.count, accepted.maxCount)),
        ...accepted.sizes.includes(current.size) ? { size: current.size } : {},
        ...accepted.qualities.includes(current.quality) ? { quality: current.quality } : {},
        ...accepted.backgrounds.includes(current.background) ? { background: current.background } : {},
        ...accepted.formats.includes(current.format) ? { format: current.format } : {},
        ...accepted.moderations.includes(current.moderation) ? { moderation: current.moderation } : {},
        ...accepted.formats.includes(current.format) && (current.format === 'jpeg' || current.format === 'webp') ? { compression: current.compression } : {},
        ...accepted.seed && current.seed.trim() !== '' ? { seed: Number(current.seed) } : {},
        references: current.references.slice(0, accepted.maxEdits).map(item => item.assetId),
      })
      if (answer.sessionInvalid === true) { actions.patch({ sessionInvalid: true, failure: t('noAuth') }); return }
      if (!answer.ok || answer.payload === undefined) {
        setFailure(answer.code === 'INSUFFICIENT_POINTS' ? t('insufficient') : t('failed', { message: answer.message ?? answer.code ?? t('unknown') }))
        return
      }
      actions.patch({ resultPaths: answer.payload.paths ?? [answer.payload.path], message: t('done') })
      await Promise.all([loadBalance(), loadHistory()])
    } catch (_error) {
      // A disconnected request may have completed upstream; never retry it automatically.
      setFailure(t('generationConnectionLost'))
      void loadHistory()
    } finally {
      actions.patch({ generationStartedAt: null })
    }
  }, [actions, loadBalance, loadHistory, models, readDraft, setFailure, signedIn, t])

  const applyTemplate = useCallback((key: string): void => {
    actions.patch({ prompt: t(`tpl_${key}_prompt`) })
    setMessage(t('templateApplied'))
    promptField.current?.focus()
  }, [actions, setMessage, t])

  return (
    <div className={css.page} id="imagegen" role="tabpanel" aria-labelledby="gen-mode-image">
      <div className={css.content}>
        <header className={css.header}>
          <h1 className={css.title}>{t('title')}</h1>
          <SegmentedTabs
            className={css.modeTabs}
            items={[
              { value: 'image', label: t('tab.image'), id: 'gen-mode-image', panelId: 'imagegen' },
              { value: 'video', label: t('tab.video'), id: 'gen-mode-video', panelId: 'videogen' },
            ]}
            value="image" onChange={(next) => { if (next === 'video') openVideo() }} label={t('mode.label')}
          />
          {isSignedIn && balance !== null && <span className={css.balance}>{t('balance', { points: balance.toLocaleString(), yuan: (balance / creditsPerYuan).toFixed(2) })}</span>}
        </header>

        <section className={`${css.composer} ${dragging ? css.dragging : ''}`}
          aria-label={t('composer')}
          onDragOver={(event) => { if (canUpload) { event.preventDefault(); setDragging(true) } }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void addReferences([...event.dataTransfer.files]) }}
        >
          <div className={css.composerBody}>
            <div className={css.referenceColumn}>
              <Tooltip label={maxEdits === 0 ? t('badgeNoEdits') : t('dropHint')} side="bottom" portal>
                <button type="button" className={css.addReference} aria-label={t('addReference')} disabled={!canUpload}
                  onClick={() => { fileField.current?.click() }}>
                  <IconPlusOutlineRegular size={22} />
                  <span>{uploading ? t('uploadingShort') : t('reference')}</span>
                </button>
              </Tooltip>
              <input ref={fileField} type="file" aria-label={t('addReference')} accept="image/png,image/jpeg,image/webp" multiple hidden
                disabled={!canUpload} onChange={(event) => { void addReferences([...event.target.files ?? []]); event.target.value = '' }} />
            </div>
            <label className={css.promptField}>
              <textarea ref={promptField} className={css.textarea} rows={4} value={prompt} aria-label={t('prompt')}
                placeholder={t('promptPlaceholder')} onChange={(event) => { actions.patch({ prompt: event.target.value }) }} />
              <span className={css.characterCount} aria-hidden="true">{prompt.length}</span>
            </label>
          </div>
          {references.length > 0 && <div className={css.referenceTray}>
            <ul className={css.thumbs} aria-label={t('reference')}>
              {references.map(item => <li key={item.assetId} className={css.thumb}>
                <img src={item.url} alt={item.name} />
                <Tooltip label={t('removeReference', { name: item.name })} side="top" portal>
                  <button type="button" className={css.remove} aria-label={t('removeReference', { name: item.name })} disabled={uploading || running}
                    onClick={() => { removeReference(item.assetId) }}><IconCloseOutlineRegular size={12} /></button>
                </Tooltip>
              </li>)}
            </ul>
            <span className={css.hint}>{references.length}/{maxEdits}</span>
            <button type="button" className={css.textAction} onClick={clearReferences} disabled={uploading || running}>{t('clearReferences')}</button>
          </div>}
          <div className={css.composerBar}>
            <label className={css.modelInline}>
              <select className={css.select} value={model?.id ?? ''} aria-label={t('model')} disabled={running || uploading || models.length === 0}
                onChange={(event) => { actions.patch({ modelId: event.target.value }) }}>
                {models.length === 0 && <option value="">{t('noModelsShort')}</option>}
                {models.map(entry => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
              </select>
            </label>
            {params !== null && <button type="button" className={css.parameterButton} aria-expanded={advanced} aria-controls="image-parameters"
              onClick={() => { setAdvanced(current => !current) }}><IconSettingsOutlineRegular size={14} /><span>{size || t('parameters')}{count > 1 ? ` · ${String(count)}` : ''}</span></button>}
            <span className={css.mode}>{references.length === 0 ? t('modeGenerate') : t('modeEdit', { count: String(references.length) })}</span>
            <Tooltip label={running ? t('runningShort') : t('submit')} side="top" portal>
              <button type="button" className={css.send} aria-label={running ? t('runningShort') : t('submit')}
                disabled={running || uploading || model === null || !isSignedIn || prompt.trim() === ''}
                onClick={() => { void generate() }}>
                {running ? <span className={css.spinner} /> : <IconSendOutlineRegular size={19} />}
              </button>
            </Tooltip>
          </div>
          {advanced && params !== null && <div className={css.parameters} id="image-parameters">
            {params.sizes.length > 0 && <label className={css.field}><span>{t('ratio')}</span><select className={css.select} value={size} disabled={running}
              onChange={(event) => { actions.patch({ size: event.target.value }) }}>{params.sizes.map(value => <option key={value} value={value}>{value === 'auto' ? t('sizeAuto') : value}</option>)}</select></label>}
            {params.maxCount > 1 && <label className={css.field}><span>{t('count')}</span><select className={css.select} value={count} disabled={running}
              onChange={(event) => { actions.patch({ count: Number(event.target.value) }) }}>
              {Array.from({ length: params.maxCount }, (_, i) => i + 1).map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>}
            {([
              { key: 'quality', values: params.qualities, value: quality },
              { key: 'background', values: params.backgrounds, value: background },
              { key: 'format', values: params.formats, value: format },
              { key: 'moderation', values: params.moderations, value: moderation },
            ] as const).filter(field => field.values.length > 0).map(field => <label className={css.field} key={field.key}>
              <span>{t(field.key)}</span><select className={css.select} value={field.value} disabled={running}
                onChange={(event) => { actions.patch({ [field.key]: event.target.value }) }}><option value="">{t('inherit')}</option>
                {field.values.map(value => <option key={value} value={value}>{field.key === 'background' && ['auto', 'transparent', 'opaque'].includes(value) ? t(`bg_${value}`) : value}</option>)}
              </select></label>)}
            {(format === 'jpeg' || format === 'webp') && <label className={css.field}><span>{t('compression', { n: String(compression) })}</span>
              <input type="range" min={0} max={100} value={compression} disabled={running} onChange={(event) => { actions.patch({ compression: Number(event.target.value) }) }} /></label>}
            {params.seed && <label className={css.field}><span>{t('seed')}</span><input className={css.select} inputMode="numeric" value={seed} placeholder={t('seedHint')} disabled={running}
              onChange={(event) => { actions.patch({ seed: event.target.value.replace(/[^0-9]/g, '') }) }} /></label>}
            <p className={css.parameterHint}>{maxEdits > 0 ? t('referenceHelp', { n: String(maxEdits) }) : t('badgeNoEdits')}</p>
          </div>}
        </section>
        <div className={css.feedback} aria-live="polite">
          {stateError && <p className={css.error}>{t('stateFailed')} <button type="button" className={css.textAction} onClick={() => { void refreshState() }}>{t('retry')}</button></p>}
          {(signedIn === false || sessionInvalid) && <p className={css.hint}>{t('signedOut')}</p>}
          {modelsError !== null && <p className={css.error}>{t('modelsFailed', { message: modelsError })} <button type="button" className={css.textAction} onClick={() => { void loadModels() }}>{t('retry')}</button></p>}
          {running && <p className={css.notice}><span className={css.statusDot} />{t('running', { seconds: String(elapsed) })}</p>}
          {failure !== null && <p className={css.error} role="alert">{failure}</p>}
          {message !== null && <p className={css.notice}>{message}</p>}
        </div>

        <section className={css.templates} aria-label={t('templatesTitle')}>
          <header className={css.sectionHead}><h2>{t('templatesTitle')}</h2><span className={css.hint}>{t('templatesHint')}</span></header>
          <div className={css.templateToolbar}>
            <div className={css.categories} role="group" aria-label={t('categories')}>
              {CATEGORIES.map(value => <button key={value} type="button" aria-pressed={category === value} className={`${css.category} ${category === value ? css.categoryActive : ''}`}
                onClick={() => { setCategory(value) }}>{t(`category_${value}`)}</button>)}
            </div>
            <label className={css.search}><IconSearchOutlineRegular size={14} /><input type="search" aria-label={t('searchTemplates')} placeholder={t('searchTemplates')}
              value={search} onChange={(event) => { setSearch(event.target.value) }} /></label>
          </div>
          <ul className={css.templateGrid}>
            {visibleTemplates.map(template => <li key={template.key}><button type="button" className={css.templateCard} onClick={() => { applyTemplate(template.key) }}>
              <span className={css.templateCopy}><span className={css.templateGlyph}>{template.glyph === 'copy' ? <IconCopyOutlineRegular size={18} /> : template.glyph === 'edit' ? <IconEditOutlineRegular size={18} /> : <IconSparkleRegular size={18} />}</span>
                <span className={css.templateName}>{t(`tpl_${template.key}`)}</span><span className={css.templateHint}>{t(`tpl_${template.key}_hint`)}</span></span>
              <span className={`${css.templateVisual} ${css[`visual_${template.key}`]}`} aria-hidden="true"><i /><i /><i /><b /></span>
            </button></li>)}
          </ul>
          {visibleTemplates.length === 0 && <p className={css.empty}>{t('noTemplates')} <button type="button" className={css.textAction} onClick={() => { setSearch(''); setCategory('all') }}>{t('resetFilters')}</button></p>}
          <div className={css.styles} role="group" aria-label={t('styles')}><span className={css.hint}>{t('styles')}</span>{PRESETS.map(preset => <button key={preset} type="button" className={css.styleChip}
            onClick={() => { const suffix = t(`preset_text_${preset}`); actions.patch({ prompt: prompt.includes(suffix) ? prompt : `${prompt}${suffix}` }); promptField.current?.focus() }}>{t(`preset_${preset}`)}</button>)}</div>
        </section>

        <section className={css.works} aria-label={t('history')}>
          <header className={css.sectionHead}><h2>{t('history')}</h2><button type="button" className={css.textAction} onClick={() => { void loadHistory() }}>{t('refreshWorks')}</button></header>
          {historyError && <p className={css.error}>{t('historyFailed')}</p>}
          {works.length === 0 ? <div className={css.emptyWorks}><IconSparkleRegular size={24} /><p>{t('historyEmpty')}</p><span>{t('historyEmptyHint')}</span></div> :
            <ul className={css.worksGrid}>{works.map(item => <li key={item.path} className={css.workCard}>
              <button type="button" className={css.workImage} aria-label={t('previewNamed', { name: item.name })} onClick={() => { setPreview(item) }}>
                <img src={rawUrl(item.path)} alt={item.name} loading="lazy" />
              </button>
              <div className={css.workMeta}><span className={css.workName}>{item.name}</span><div className={css.workActions}>
                <a className={css.textAction} href={rawUrl(item.path)} download={item.name}>{t('download')}</a>
                {maxEdits > 0 && <button type="button" className={css.textAction} disabled={!canUpload} onClick={() => { void addReferences({ path: item.path }) }}>{t('useAsReference')}</button>}
              </div></div>
            </li>)}</ul>}
        </section>
      </div>
      {preview !== null && <ImageLightbox src={rawUrl(preview.path)} alt={preview.name} labels={{ dialog: t('preview'), close: t('closePreview') }} onClose={() => { setPreview(null) }} />}
    </div>
  )
}
