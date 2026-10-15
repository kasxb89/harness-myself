/** Video composer, camera-script templates and real generated clips. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconPlayOutlineRegular, IconPlusOutlineRegular, Menu, Modal, SegmentedTabs, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { createVideoDraftStore, Category, Reference, Slot, Workflow } from './draft-store.ts'
import type { VideogenKey } from './locales.ts'
import { requestJson } from './transport.ts'
import css from './VideoPage.module.css'

/** Values supplied by this package's slot registration. */
export interface VideogenInjected {
  readonly t: (key: VideogenKey, values?: Record<string, string>) => string
  readonly openImage: () => void
  readonly createPreview: (file: File) => string
  readonly releasePreview: (url: string) => void
}

/** Parameter menus supplied by the existing media catalog. */
interface VideoModel {
  readonly id: string
  readonly displayName: string
  readonly verified: boolean
  readonly source: string
  readonly params: {
    readonly durations: readonly number[]
    readonly resolutions: readonly string[]
    readonly ratios: readonly string[]
    readonly frameSlots: number
    readonly maxReferenceImages: number
    readonly maxReferenceVideos: number
    readonly audio: boolean
    readonly audioToggle: boolean
    readonly modes: readonly string[]
    readonly seed: boolean
  }
}
interface Catalog { readonly video: readonly VideoModel[] }
interface ArtifactItem { readonly path: string; readonly name: string; readonly kind: string; readonly mtimeMs?: number }

type TemplateId = 'product' | 'detail' | 'story' | 'travel' | 'orbit' | 'city'
const TEMPLATES: readonly { id: TemplateId; category: Category }[] = [
  { id: 'product', category: 'commerce' }, { id: 'detail', category: 'commerce' },
  { id: 'story', category: 'story' }, { id: 'travel', category: 'story' },
  { id: 'orbit', category: 'cinematic' }, { id: 'city', category: 'cinematic' },
]
const CATEGORIES: readonly Category[] = ['all', 'commerce', 'story', 'cinematic']
const PRESETS = ['push', 'orbit', 'track', 'aerial', 'sunset', 'neon'] as const
const SLOT_TYPES: Record<Slot, { readonly accept: string; readonly types: readonly string[] }> = {
  image: { accept: 'image/png,image/jpeg,image/webp', types: ['image/png', 'image/jpeg', 'image/webp'] },
  video: { accept: 'video/mp4,video/quicktime', types: ['video/mp4', 'video/quicktime'] },
}
const SLOT_LABELS = { image: 'referenceImages', video: 'referenceVideos' } as const
const SLOT_HINTS = { image: 'dropImages', video: 'dropVideos' } as const
const WORKFLOW_LABELS = { text: 'workflow.text', image: 'workflow.image', frames: 'workflow.frames', reference: 'workflow.reference' } as const
const WORKFLOW_HINTS = { text: 'workflow.text.hint', image: 'workflow.image.hint', frames: 'workflow.frames.hint', reference: 'workflow.reference.hint' } as const
const rawUrl = (path: string): string => `/artifacts/api/raw?path=${encodeURIComponent(path)}`

/**
 * Render the video mode with window-retained drafts and capability-owned inputs.
 * @param props - renderer-owned runtime/store seats and package callbacks.
 * @returns the video creation page.
 */
export function VideoPage(props: PropsRuntime<'main'> & PropsStore<ReturnType<typeof createVideoDraftStore>> & VideogenInjected): ReactNode {
  const { t, openImage, actions, createPreview, releasePreview } = props
  const draft = props.useStore(state => state)
  const { prompt, modelId, resolution, ratio, mode, seed, audio, firstFrame, lastFrame, slots,
    phase, uploading, failure, message, result } = draft
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [creditsPerYuan, setCreditsPerYuan] = useState(1000)
  const [balance, setBalance] = useState<number | null>(null)
  const [models, setModels] = useState<readonly VideoModel[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [stateError, setStateError] = useState(false)
  const [history, setHistory] = useState<readonly ArtifactItem[]>([])
  const [historyError, setHistoryError] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [modelMenu, setModelMenu] = useState(false)
  const [preview, setPreview] = useState<TemplateId | null>(null)
  const operation = useRef(false)
  const refreshing = useRef(false)
  const promptField = useRef<HTMLTextAreaElement | null>(null)
  const model = useMemo(() => models.find(entry => entry.id === modelId) ?? models[0] ?? null, [modelId, models])
  const params = model?.params ?? null
  const busy = phase === 'running' || uploading !== null
  const supportsImage = params !== null && (params.frameSlots > 0 || params.maxReferenceImages > 0)
  const workflows: Workflow[] = ['text']
  if (supportsImage) workflows.push('image')
  if (params !== null && params.frameSlots > 1) workflows.push('frames')
  if (params !== null && params.maxReferenceImages + params.maxReferenceVideos > 0) workflows.push('reference')
  const workflow = workflows.includes(draft.workflow) ? draft.workflow : 'text'
  const duration = params?.durations.includes(draft.duration) === true ? draft.duration : params?.durations[0] ?? 0
  const selectedResolution = params?.resolutions.includes(resolution) === true ? resolution : params?.resolutions[0] ?? ''
  const selectedRatio = params?.ratios.includes(ratio) === true ? ratio : params?.ratios.find(item => item !== 'adaptive') ?? params?.ratios[0] ?? ''
  const hasReferences = (params !== null && params.maxReferenceImages > 0 && slots.image.length > 0)
    || (params !== null && params.maxReferenceVideos > 0 && slots.video.length > 0)

  const loadModels = useCallback(async (): Promise<void> => {
    const answer = await requestJson<Catalog>('/credits/api/media/catalog')
    if (!answer.ok || answer.payload === undefined) {
      setModelsError(answer.message ?? answer.code ?? t('unknown'))
      return
    }
    setModelsError(null)
    setModels(answer.payload.video)
  }, [t])

  const loadBalance = useCallback(async (): Promise<void> => {
    const answer = await requestJson<{ balance_points: number }>('/credits/api/summary')
    if (answer.sessionInvalid === true) { setSignedIn(false); setBalance(null); return }
    setBalance(answer.ok ? answer.payload?.balance_points ?? null : null)
  }, [])

  const loadHistory = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/artifacts/api/list', { headers: { accept: 'application/json' } })
      if (!response.ok) { setHistoryError(true); return }
      const answer = await response.json() as { items?: readonly ArtifactItem[]; payload?: { items?: readonly ArtifactItem[] } }
      const items = answer.items ?? answer.payload?.items
      if (!Array.isArray(items)) { setHistoryError(true); return }
      setHistory(items.filter(item => item.kind === 'video' && item.path.includes('/credits/media/'))
        .sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0)).slice(0, 12))
      setHistoryError(false)
    } catch (_error) {
      // Retain existing clips when refreshing the artifact query fails.
      setHistoryError(true)
    }
  }, [])

  const refreshState = useCallback(async (): Promise<void> => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const answer = await requestJson<{ signedIn: boolean; creditsPerYuan: number }>('/credits/api/session')
      if (!answer.ok || answer.payload === undefined) { setStateError(true); return }
      setStateError(false)
      setSignedIn(answer.payload.signedIn)
      setCreditsPerYuan(answer.payload.creditsPerYuan)
      if (answer.payload.signedIn) await Promise.all([loadBalance(), loadModels(), loadHistory()])
      else setBalance(null)
    } finally { refreshing.current = false }
  }, [loadBalance, loadModels, loadHistory])

  useEffect(() => {
    void refreshState()
    const revisit = (): void => { void refreshState() }
    const timer = setInterval(revisit, 30_000)
    window.addEventListener('focus', revisit)
    return () => { clearInterval(timer); window.removeEventListener('focus', revisit) }
  }, [refreshState])

  useEffect(() => {
    if (phase !== 'running') return undefined
    const update = (): void => { setElapsed(Math.floor((Date.now() - draft.startedAt) / 1000)) }
    update()
    const timer = setInterval(update, 1000)
    return () => { clearInterval(timer) }
  }, [phase, draft.startedAt])

  useEffect(() => {
    if (params === null || busy) return
    const nextSlots = {
      image: slots.image.slice(0, params.maxReferenceImages),
      video: slots.video.slice(0, params.maxReferenceVideos),
    }
    const nextFirst = params.frameSlots > 0 ? firstFrame : null
    const nextLast = params.frameSlots > 1 ? lastFrame : null
    const removed = [
      ...slots.image.slice(params.maxReferenceImages),
      ...slots.video.slice(params.maxReferenceVideos),
      ...(firstFrame !== null && nextFirst === null ? [firstFrame] : []),
      ...(lastFrame !== null && nextLast === null ? [lastFrame] : []),
    ]
    if (removed.length === 0) return
    actions.patch({ slots: nextSlots, firstFrame: nextFirst, lastFrame: nextLast, message: t('modelMediaAdjusted') })
    for (const reference of removed) releasePreview(reference.url)
  }, [params, busy, slots, firstFrame, lastFrame, actions, releasePreview, t])

  const upload = useCallback(async (slot: Slot, file: File): Promise<Reference | null> => {
    if (!SLOT_TYPES[slot].types.includes(file.type)) {
      actions.patch({ failure: t('uploadFailed', { message: file.type || t('unknownType') }) })
      return null
    }
    if (file.size === 0 || file.size > 32 * 1024 * 1024) { actions.patch({ failure: t('uploadSize') }); return null }
    try {
      const response = await fetch('/credits/api/assets', {
        method: 'POST', headers: {
          'content-type': file.type, 'x-file-name': file.name,
          'x-idempotency-key': `dsh-asset-${globalThis.crypto.randomUUID()}`, accept: 'application/json',
        }, body: file,
      })
      if (!response.ok) { actions.patch({ failure: t('uploadNetwork') }); return null }
      const answer = await response.json() as {
        ok: boolean
        code?: string
        message?: string
        sessionInvalid?: boolean
        asset?: { assetId?: string }
      }
      if (answer.sessionInvalid === true) { setSignedIn(false); actions.patch({ failure: t('noAuth') }); return null }
      const assetId = answer.asset?.assetId
      if (!answer.ok || typeof assetId !== 'string') {
        actions.patch({ failure: t('uploadFailed', { message: answer.message ?? answer.code ?? t('unknown') }) })
        return null
      }
      return { assetId, name: file.name, url: createPreview(file) }
    } catch (_error) {
      actions.patch({ failure: t('uploadNetwork') })
      return null
    }
  }, [actions, createPreview, t])

  const pick = useCallback(async (slot: Slot, files: FileList | null): Promise<void> => {
    if (busy || operation.current || files === null || files.length === 0 || params === null) return
    const limit = slot === 'image' ? params.maxReferenceImages : params.maxReferenceVideos
    const available = Math.max(0, limit - slots[slot].length)
    if (available === 0) return
    operation.current = true
    actions.patch({ failure: null, uploading: slot })
    try {
      for (const file of Array.from(files).slice(0, available)) {
        const reference = await upload(slot, file)
        if (reference === null) break
        actions.addReferences(slot, [reference], limit)
      }
    } finally { operation.current = false; actions.patch({ uploading: null }) }
  }, [busy, params, slots, upload, actions])

  const pickFrame = useCallback(async (which: 'first' | 'last', files: FileList | null): Promise<void> => {
    const file = files?.[0]
    if (busy || operation.current || file === undefined) return
    operation.current = true
    actions.patch({ failure: null, uploading: which })
    try {
      const reference = await upload('image', file)
      if (reference !== null) {
        const previous = which === 'first' ? firstFrame : lastFrame
        actions.patch(which === 'first' ? { firstFrame: reference } : { lastFrame: reference })
        if (previous !== null) releasePreview(previous.url)
      }
    } finally { operation.current = false; actions.patch({ uploading: null }) }
  }, [busy, upload, actions, firstFrame, lastFrame, releasePreview])

  const generate = useCallback(async (): Promise<void> => {
    if (busy || operation.current || signedIn !== true) return
    actions.patch({ failure: null, message: null })
    if (prompt.trim() === '') { actions.patch({ failure: t('promptRequired') }); promptField.current?.focus(); return }
    if (model === null || params === null) { actions.patch({ failure: t('noModel') }); return }
    if ((workflow === 'image' && (params.frameSlots > 0 ? firstFrame === null : slots.image.length === 0))
      || (workflow === 'frames' && (firstFrame === null || lastFrame === null))
      || (workflow === 'reference' && !hasReferences)) {
      actions.patch({ failure: t('mediaRequired') }); return
    }
    operation.current = true
    setModelMenu(false)
    actions.patch({ phase: 'running', startedAt: Date.now() })
    const frames = workflow === 'frames' ? [firstFrame, lastFrame] : workflow === 'image' && params.frameSlots > 0 ? [firstFrame] : []
    try {
      const answer = await requestJson<{ path: string }>('/credits/api/video/tasks?source=newapi-generate', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(), model: model.id, durationSeconds: duration,
          ...(selectedResolution === '' ? {} : { resolution: selectedResolution }),
          ...(selectedRatio === '' ? {} : { ratio: selectedRatio }),
          ...(params.modes.includes(mode) ? { mode } : {}),
          ...(params.seed && seed.trim() !== '' && Number.isSafeInteger(Number(seed)) ? { seed: Number(seed) } : {}),
          ...(params.audioToggle ? { audio } : {}),
          frameImages: frames.filter((item): item is Reference => item !== null).map(item => item.assetId),
          referenceImages: workflow === 'reference' || (workflow === 'image' && params.frameSlots === 0)
            ? slots.image.slice(0, params.maxReferenceImages).map(item => item.assetId) : [],
          referenceVideos: workflow === 'reference' ? slots.video.slice(0, params.maxReferenceVideos).map(item => item.assetId) : [],
          referenceAudios: [],
        }),
      })
      if (answer.sessionInvalid === true) {
        setSignedIn(false); actions.patch({ failure: t('noAuth') }); return
      }
      if (!answer.ok || typeof answer.payload?.path !== 'string' || answer.payload.path === '') {
        if (answer.code === 'INSUFFICIENT_POINTS') actions.patch({ failure: t('insufficient') })
        else if (answer.ok || answer.code === 'TIMEOUT' || answer.code === 'TRANSPORT'
          || answer.code === 'HTTP' || answer.code === 'RESPONSE_INVALID') {
          actions.patch({ failure: t('outcomeUnknown') })
        }
        else actions.patch({ failure: t('failed', { message: answer.message ?? answer.code ?? t('unknown') }) })
        return
      }
      actions.patch({ result: { path: answer.payload.path }, message: t('done') })
      await Promise.all([loadBalance(), loadHistory()])
    } finally { operation.current = false; actions.patch({ phase: 'idle' }) }
  }, [busy, signedIn, actions, prompt, model, params, workflow, firstFrame, lastFrame, slots, hasReferences,
    duration, selectedResolution, selectedRatio, mode, seed, audio, t, loadBalance, loadHistory])

  const frameField = (which: 'first' | 'last'): ReactNode => {
    const reference = which === 'first' ? firstFrame : lastFrame
    return <div className={css.field}>
      <span className={css.label}>{t(which === 'first' ? 'firstFrame' : 'lastFrame')}</span>
      <label className={css.dropzone}>
        <input type="file" aria-label={t(which === 'first' ? 'firstFrame' : 'lastFrame')} accept={SLOT_TYPES.image.accept}
          onChange={(event) => { void pickFrame(which, event.target.files); event.target.value = '' }} />
        {reference === null ? <><IconPlusOutlineRegular /><span>{uploading === which ? t('uploading') : t('frameHint')}</span></>
          : <img className={css.frame} src={reference.url} alt={reference.name} />}
      </label>
      {reference !== null && <button type="button" className={css.link} onClick={() => {
        actions.patch(which === 'first' ? { firstFrame: null } : { lastFrame: null }); releasePreview(reference.url)
      }}>{t('remove')}</button>}
    </div>
  }

  const referenceField = (slot: Slot): ReactNode => {
    const limit = slot === 'image' ? params?.maxReferenceImages ?? 0
      : params?.maxReferenceVideos ?? 0
    if (limit === 0) return null
    const full = slots[slot].length >= limit
    return <div className={css.field} key={slot}>
      <span className={css.label}>{t(SLOT_LABELS[slot])}
        <span className={css.count}>{slots[slot].length}/{limit}</span>
      </span>
      <label className={css.dropzone} aria-disabled={full}>
        <input type="file" aria-label={t(SLOT_LABELS[slot])} accept={SLOT_TYPES[slot].accept} multiple disabled={full}
          onChange={(event) => { void pick(slot, event.target.files); event.target.value = '' }} />
        <IconPlusOutlineRegular /><span>{uploading === slot ? t('uploading') : full ? t('referenceFull') : t(SLOT_HINTS[slot])}</span>
      </label>
      <ul className={css.files}>{slots[slot].map(item => <li key={item.assetId} className={css.fileRow}>
        {slot === 'image' ? <img className={css.fileThumb} src={item.url} alt={item.name} /> : <IconPlayOutlineRegular />}
        <span className={css.fileName}>{item.name}</span>
        <button type="button" className={css.link} aria-label={t('removeNamed', { name: item.name })} onClick={() => {
          actions.removeReference(slot, item.assetId); releasePreview(item.url)
        }}>{t('remove')}</button>
      </li>)}</ul>
    </div>
  }

  const applyTemplate = (id: TemplateId): void => {
    const script = t(`template_${id}_prompt`)
    actions.patch({ prompt: prompt.trim() === '' ? script : `${prompt}\n\n${script}`, failure: null })
    setPreview(null)
    promptField.current?.focus()
  }

  return <div className={css.page} id="videogen" role="tabpanel" aria-labelledby="gen-mode-video">
    <header className={css.header}>
      <h1 className={css.title}>{t('title')}</h1>
      <SegmentedTabs className={css.modeTabs} items={[
        { value: 'image', label: t('tab.image'), id: 'gen-mode-image', panelId: 'imagegen' },
        { value: 'video', label: t('tab.video'), id: 'gen-mode-video', panelId: 'videogen' },
      ]} value="video" onChange={(next) => { if (next === 'image') openImage() }} label={t('mode.label')} />
      {balance !== null && <span className={css.balance}>{t('balance', { points: balance.toLocaleString(), yuan: (balance / creditsPerYuan).toFixed(2) })}</span>}
    </header>

    <section className={css.composer} aria-label={t('composer')} aria-busy={busy}>
      <fieldset className={css.composerFields} disabled={busy || signedIn !== true}>
        <div className={css.workflowBar}>{workflows.map(entry => <button key={entry} type="button" aria-pressed={workflow === entry}
          className={workflow === entry ? `${css.workflow} ${css.workflowActive}` : css.workflow}
          onClick={() => { actions.patch({ workflow: entry, failure: null }) }}>{t(WORKFLOW_LABELS[entry])}</button>)}</div>
        <div className={css.promptRow}>
          {workflows.length > 1 && <button type="button" className={css.addMedia} onClick={() => {
            actions.patch({ workflow: supportsImage ? 'image' : 'reference' })
          }}><IconPlusOutlineRegular size={24} /><span>{t('addMedia')}</span></button>}
          <label className={css.promptField}>
            <textarea ref={promptField} className={css.textarea} rows={4} value={prompt} aria-label={t('prompt')}
              placeholder={t('promptPlaceholder')} onChange={(event) => { actions.patch({ prompt: event.target.value }) }} />
            <span className={css.count} aria-hidden="true">{prompt.length}</span>
          </label>
        </div>
        <p className={css.hint}>{t(WORKFLOW_HINTS[workflow])}</p>
        {(firstFrame !== null || lastFrame !== null || hasReferences) && <p className={css.hint}>{t('inactiveMediaHint')}</p>}
        {workflow !== 'text' && params !== null && <div className={css.mediaGrid}>
          {workflow === 'image' && (params.frameSlots > 0 ? frameField('first') : referenceField('image'))}
          {workflow === 'frames' && <>{frameField('first')}{frameField('last')}</>}
          {workflow === 'reference' && <>{referenceField('image')}{referenceField('video')}</>}
        </div>}
        <div className={css.presets} aria-label={t('cameraIntents')}>{PRESETS.map(preset => <button key={preset} type="button" className={css.chip}
          onClick={() => { actions.appendPrompt(t(`preset_text_${preset}`)) }}>{t(`preset_${preset}`)}</button>)}</div>
        <div className={css.composerBar}>
          <Menu open={modelMenu} portal selectedId={model?.id} items={models.map(entry => ({ id: entry.id, label: entry.displayName }))}
            onSelect={(id) => { actions.patch({ modelId: id }); setModelMenu(false) }} onClose={() => { setModelMenu(false) }}
            anchor={<button type="button" className={css.modelButton} aria-label={t('model')} aria-expanded={modelMenu}
              disabled={busy || models.length === 0} onClick={() => { setModelMenu(!modelMenu) }}>{model?.displayName ?? t('model')}<span aria-hidden="true">⌄</span></button>} />
          <details className={css.settings}>
            <summary>{t('settingsSummary', { duration: String(duration), resolution: selectedResolution, ratio: selectedRatio === 'adaptive' ? t('ratioAdaptive') : selectedRatio })}</summary>
            <div className={css.settingsBody}>
              {params !== null && params.durations.length > 0 && <div className={css.field}><span className={css.label}>{t('duration')}</span>
                <div className={css.segmented}>{params.durations.map(value => <button key={value} type="button" aria-pressed={duration === value}
                  className={duration === value ? `${css.segment} ${css.segmentActive}` : css.segment} onClick={() => { actions.patch({ duration: value }) }}>{t('seconds', { n: String(value) })}</button>)}</div></div>}
              {params !== null && params.resolutions.length > 0 && <div className={css.field}><span className={css.label}>{t('resolution')}</span>
                <div className={css.segmented}>{params.resolutions.map(value => <button key={value} type="button" aria-pressed={selectedResolution === value}
                  className={selectedResolution === value ? `${css.segment} ${css.segmentActive}` : css.segment} onClick={() => { actions.patch({ resolution: value }) }}>{value}</button>)}</div></div>}
              {params !== null && params.ratios.length > 0 && <div className={css.field}><span className={css.label}>{t('ratio')}</span>
                <div className={css.segmented}>{params.ratios.map(value => <button key={value} type="button" aria-pressed={selectedRatio === value}
                  className={selectedRatio === value ? `${css.segment} ${css.segmentActive}` : css.segment} onClick={() => { actions.patch({ ratio: value }) }}>{value === 'adaptive' ? t('ratioAdaptive') : value}</button>)}</div></div>}
              {params !== null && params.modes.length > 0 && <div className={css.field}><span className={css.label}>{t('mode')}</span>
                <div className={css.segmented}>{params.modes.map(value => <button key={value} type="button" aria-pressed={mode === value}
                  className={mode === value ? `${css.segment} ${css.segmentActive}` : css.segment} onClick={() => { actions.patch({ mode: value }) }}>{value}</button>)}</div></div>}
              {params?.seed === true && <label className={css.field}><span className={css.label}>{t('seed')}</span><input className={css.seed} inputMode="numeric" value={seed}
                placeholder={t('seedHint')} onChange={(event) => { actions.patch({ seed: event.target.value.replace(/[^0-9]/g, '') }) }} /></label>}
              {params?.audioToggle === true && <label className={css.audioToggle}><input type="checkbox" checked={audio} onChange={(event) => { actions.patch({ audio: event.target.checked }) }} />{t('audio')}</label>}
              {params?.audio === true && !params.audioToggle && <p className={css.hint}>{t('badgeAudio')}</p>}
            </div>
          </details>
          <span className={css.cost}>{t('costShort')}</span>
          <Tooltip label={phase === 'running' ? t('runningShort') : t('submit')} portal side="top">
            <button type="button" className={css.send} aria-label={phase === 'running' ? t('runningShort') : t('submit')}
              onClick={() => { void generate() }} disabled={busy || model === null || prompt.trim() === ''}>
              <span className={phase === 'running' ? css.spinner : css.sendArrow} aria-hidden="true">{phase === 'running' ? '' : '↑'}</span>
            </button>
          </Tooltip>
        </div>
      </fieldset>
      <div className={css.feedback} aria-live="polite">
        {phase === 'running' && <p className={css.notice}>{t('running', { seconds: String(elapsed) })}</p>}
        {uploading !== null && <p className={css.notice}>{t('uploading')}</p>}
        {failure !== null && <p className={css.error} role="alert">{failure}</p>}
        {message !== null && <p className={css.notice}>{message}</p>}
        {signedIn === false && <p className={css.hint}>{t('signedOut')}</p>}
        {stateError && <p className={css.error}>{t('stateFailed')} <button type="button" className={css.link} onClick={() => { void refreshState() }}>{t('retry')}</button></p>}
        {modelsError !== null && <p className={css.error}>{t('modelsFailed', { message: modelsError })} <button type="button" className={css.link} onClick={() => { void loadModels() }}>{t('retry')}</button></p>}
        {signedIn === true && models.length === 0 && modelsError === null && <p className={css.hint}>{t('noModel')}</p>}
      </div>
    </section>
    {model !== null && <details className={css.capabilityNote}><summary>{t('modelInfo')}</summary><p className={css.hint}>{t('capabilityHint')}</p></details>}

    <section className={css.templates} aria-label={t('templates')}>
      <div className={css.sectionHeading}><div><h2 className={css.sectionTitle}>{t('templates')}</h2><p className={css.hint}>{t('templatesHint')}</p></div>
        <div className={css.categories} aria-label={t('categories')}>{CATEGORIES.map(category => <button key={category} type="button" aria-pressed={draft.category === category}
          className={draft.category === category ? `${css.category} ${css.categoryActive}` : css.category} onClick={() => { actions.patch({ category }) }}>{t(`category_${category}`)}</button>)}</div>
      </div>
      <div className={css.templateGrid}>{TEMPLATES.filter(template => draft.category === 'all' || template.category === draft.category).map(template => <button type="button" key={template.id}
        className={css.templateCard} onClick={() => { setPreview(template.id) }} aria-label={t('previewNamed', { name: t(`template_${template.id}`) })}>
        <div className={css.storyboard} data-scene={template.id} aria-hidden="true"><span>01</span><span>02</span><span>03</span><i><IconPlayOutlineRegular size={20} /></i></div>
        <div className={css.templateBody}><span className={css.templateBadge}>{t('scriptTemplate')}</span><h3>{t(`template_${template.id}`)}</h3><p>{t(`template_${template.id}_description`)}</p><span className={css.templateLink}>{t('viewScript')}<span aria-hidden="true">↗</span></span></div>
      </button>)}</div>
    </section>

    {result !== null && <section className={css.result} aria-label={t('result')}>
      <div className={css.sectionHeading}><h2 className={css.sectionTitle}>{t('result')}</h2><button type="button" className={css.link} onClick={() => { actions.patch({ result: null }) }}>{t('closePreview')}</button></div>
      <video className={css.video} src={rawUrl(result.path)} controls preload="metadata" />
      <div className={css.figureMeta}><a className={css.link} href={rawUrl(result.path)} target="_blank" rel="noreferrer">{t('open')}</a><a className={css.link} href={rawUrl(result.path)} download={result.path.split('/').pop()}>{t('download')}</a><code className={css.path}>{result.path}</code></div>
    </section>}

    <section className={css.works} aria-label={t('history')}>
      <div className={css.sectionHeading}><div><h2 className={css.sectionTitle}>{t('history')}</h2><p className={css.hint}>{t('historyHint')}</p></div><Button size="sm" onClick={() => { void loadHistory() }}>{t('refresh')}</Button></div>
      {historyError && <p className={css.error} role="alert">{t('historyFailed')}</p>}
      {history.length === 0 ? <div className={css.emptyWorks}><IconPlayOutlineRegular size={30} /><p>{t('historyEmpty')}</p><span>{t('historyEmptyHint')}</span></div>
        : <ul className={css.history}>{history.map(item => <li key={item.path}><button type="button" className={css.historyButton} aria-label={t('previewNamed', { name: item.name })}
          onClick={() => { actions.patch({ result: { path: item.path } }) }}><div className={css.historyVisual}><video src={rawUrl(item.path)} muted preload="metadata" /><span className={css.play}><IconPlayOutlineRegular size={24} /></span></div><span className={css.historyName}>{item.name}</span></button></li>)}</ul>}
    </section>
    <Modal open={preview !== null} title={preview === null ? t('scriptTemplate') : t(`template_${preview}`)} closeLabel={t('closePreview')} onClose={() => { setPreview(null) }}
      footer={<Button variant="primary" disabled={busy} onClick={() => { if (preview !== null) applyTemplate(preview) }}>{t('useScript')}</Button>}>
      <p className={css.hint}>{t('scriptPreviewHint')}</p><p className={css.scriptPreview}>{preview === null ? '' : t(`template_${preview}_prompt`)}</p>
    </Modal>
  </div>
}
