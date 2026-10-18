/** Video composer, camera-script templates and real generated clips. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconPlayOutlineRegular, IconPlusOutlineRegular, IconSettingsOutlineRegular, Menu, Modal, SegmentedTabs, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, InjectFace, PropsRenderFactories, PropsRuntime, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-prompt-assist/client'
import type {} from '@deepseek-ai/dsh-client-ui-creative/client'
import type { Context } from '@deepseek-ai/cordis'
import type { LocalizedText } from '@deepseek-ai/dsh-client-creation-content/client'
import type { createVideoDraftStore, Reference, Slot, VideoDraft, Workflow } from './draft-store.ts'
import type { VideogenKey } from './locales.ts'
import { requestJson } from './transport.ts'
import css from './VideoPage.module.css'

/** Values supplied by this package's slot registration. */
export interface VideogenInjected {
  readonly t: (key: VideogenKey, values?: Record<string, string>) => string
  readonly openImage: () => void
  readonly createPreview: (file: File) => string
  readonly releasePreview: (url: string) => void
  readonly readDraft: () => VideoDraft
  readonly refreshContent: () => void
  readonly hooks: { readonly creationContent: Context['creationContent']; readonly locale: Context['locale']; readonly creationSession: HostObservable<StandardSourceBinding> }
}

/** Parameter menus supplied by the existing media catalog. */
interface VideoModel {
  readonly id: string
  readonly displayName: string
  readonly verified: boolean
  readonly source: string
  readonly params: {
    readonly durations: readonly number[]
    readonly durationByResolution?: Readonly<Record<string, readonly number[]>>
    readonly resolutions: readonly string[]
    readonly ratios: readonly string[]
    readonly frameSlots: number
    readonly maxReferenceImages: number
    readonly maxReferenceVideos: number
    readonly maxReferenceAudios: number
    readonly audio: boolean
    readonly audioToggle: boolean
    readonly modes: readonly string[]
    readonly seed: boolean
  }
}
interface Catalog { readonly video: readonly VideoModel[] }
interface SessionInfo {
  readonly signedIn: boolean
  readonly creditsPerYuan: number
  readonly account?: { readonly id?: string | number } | null
}
interface ArtifactLocation { readonly path: string; readonly workspaceId?: string }
interface ArtifactItem extends ArtifactLocation { readonly name: string; readonly kind: string; readonly mtimeMs?: number }

/** Admit the artifact fields consumed by clip history from the JSON listing. */
function isArtifactItem(value: unknown): value is ArtifactItem {
  return value !== null && typeof value === 'object'
    && 'path' in value && typeof value.path === 'string'
    && 'name' in value && typeof value.name === 'string'
    && 'kind' in value && typeof value.kind === 'string'
    && (!('mtimeMs' in value) || typeof value.mtimeMs === 'number')
    && (!('workspaceId' in value) || typeof value.workspaceId === 'string')
}

const SLOT_TYPES: Record<Slot, { readonly accept: string; readonly types: readonly string[] }> = {
  image: { accept: 'image/png,image/jpeg,image/webp', types: ['image/png', 'image/jpeg', 'image/webp'] },
  video: { accept: 'video/mp4,video/quicktime', types: ['video/mp4', 'video/quicktime'] },
  audio: { accept: 'audio/mpeg,audio/wav', types: ['audio/mpeg', 'audio/wav'] },
}
const SLOT_LABELS = { image: 'referenceImages', video: 'referenceVideos', audio: 'referenceAudios' } as const
const SLOT_HINTS = { image: 'dropImages', video: 'dropVideos', audio: 'dropAudios' } as const
const WORKFLOW_LABELS = { text: 'workflow.text', image: 'workflow.image', frames: 'workflow.frames', reference: 'workflow.reference' } as const
const WORKFLOW_HINTS = { text: 'workflow.text.hint', image: 'workflow.image.hint', frames: 'workflow.frames.hint', reference: 'workflow.reference.hint' } as const
const rawUrl = (file: ArtifactLocation): string => `/artifacts/api/raw?path=${encodeURIComponent(file.path)}${file.workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(file.workspaceId)}`}`
const fileIdentity = (file: ArtifactLocation): string => JSON.stringify([file.workspaceId ?? null, file.path])

/**
 * Render the video mode with window-retained drafts and capability-owned inputs.
 * @param props - renderer-owned runtime/store seats and package callbacks.
 * @returns the video creation page.
 */
export function VideoPage(props: PropsRuntime<'main'> & PropsRenderFactories & PropsStore<ReturnType<typeof createVideoDraftStore>> & InjectFace<VideogenInjected>): ReactNode {
  const { t, openImage, actions, createPreview, releasePreview, readDraft } = props
  const draft = props.useStore(state => state)
  const sessionId = props.useCreationSession(binding => binding.key)
  const projects = props.renderFactorySlot('creation.projects', { refreshKey: JSON.stringify([draft.phase, draft.result]), generationPending: draft.phase === 'running' && draft.generationSessionId === sessionId })
  const { prompt, modelId, resolution, ratio, mode, seed, audio, firstFrame, lastFrame, slots,
    phase, uploading, failure, message, result } = draft
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [accountIdentity, setAccountIdentity] = useState<string | null>(null)
  const [creditsPerYuan, setCreditsPerYuan] = useState(1000)
  const [balance, setBalance] = useState<number | null>(null)
  const [models, setModels] = useState<readonly VideoModel[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [stateError, setStateError] = useState(false)
  const [history, setHistory] = useState<readonly ArtifactItem[]>([])
  const [historyError, setHistoryError] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [modelMenu, setModelMenu] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const operation = useRef(false)
  const refreshing = useRef(false)
  const sessionSequence = useRef(0)
  useEffect(() => () => { sessionSequence.current += 1 }, [])
  const acceptAccount = useCallback((info: Pick<SessionInfo, 'signedIn' | 'account'>): string | null => {
    const id = info.account?.id
    const accountId = info.signedIn && (typeof id === 'string' || typeof id === 'number') && String(id) !== '' ? String(id) : null
    const current = readDraft()
    if (current.referenceAccountId !== accountId) {
      if (current.uploading !== null) operation.current = false
      actions.setReferenceAccount(accountId)
      const references = [current.firstFrame, current.lastFrame, ...current.slots.image, ...current.slots.video, ...current.slots.audio]
      for (const reference of references) {
        if (reference !== null) releasePreview(reference.url)
      }
    }
    setSignedIn(info.signedIn)
    setAccountIdentity(accountId)
    return accountId
  }, [actions, readDraft, releasePreview])
  const promptField = useRef<HTMLTextAreaElement | null>(null)
  const model = useMemo(() => models.find(entry => entry.id === modelId) ?? models[0] ?? null, [modelId, models])
  const params = model?.params ?? null
  const busy = phase === 'running' || uploading !== null
  const locked = busy || draft.promptAssisting
  const publication = props.useCreationContent(state => state)
  const language = props.useLocale(state => state.active)
  const text = (value: LocalizedText | undefined): string => value === undefined ? '' : language === 'en' ? value.en || value.zh : value.zh
  const content = publication.content?.video
  const contentCategories = [...content?.categories ?? []].filter(item => item.enabled).sort((a, b) => a.sortOrder - b.sortOrder)
  const contentTemplates = [...content?.templates ?? []].filter(item => item.status === 'published'
    && (item.categoryId === null || contentCategories.some(category => category.id === item.categoryId)))
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const contentPresets = [...content?.presets ?? []].filter(item => item.status === 'published').sort((a, b) => a.sortOrder - b.sortOrder)
  const selectedCategory = contentCategories.some(item => item.id === draft.category) ? draft.category : 'all'
  const previewTemplate = contentTemplates.find(item => item.id === preview) ?? null
  const visibleTemplates = contentTemplates.filter(template => selectedCategory === 'all' || template.categoryId === selectedCategory)
  const supportsImage = params !== null && (params.frameSlots > 0 || params.maxReferenceImages > 0)
  const workflows: Workflow[] = ['text']
  if (supportsImage) workflows.push('image')
  if (params !== null && params.frameSlots > 1) workflows.push('frames')
  if (params !== null && params.maxReferenceImages + params.maxReferenceVideos + params.maxReferenceAudios > 0) workflows.push('reference')
  const workflow = workflows.includes(draft.workflow) ? draft.workflow : 'text'
  const selectedResolution = params?.resolutions.includes(resolution) === true ? resolution : params?.resolutions[0] ?? ''
  const durations = params?.durationByResolution === undefined ? params?.durations ?? []
    : Object.hasOwn(params.durationByResolution, selectedResolution) ? params.durationByResolution[selectedResolution] ?? [] : []
  const duration = durations.includes(draft.duration) ? draft.duration : durations[0] ?? 0
  const frameImages = workflow === 'frames' ? [firstFrame, lastFrame]
    : workflow === 'image' && (params?.frameSlots ?? 0) > 0 ? [firstFrame] : []
  const referenceImages = workflow === 'reference' || workflow === 'image' && params?.frameSlots === 0 ? slots.image : []
  const referenceVideos = workflow === 'reference' ? slots.video : []
  const referenceAudios = workflow === 'reference' ? slots.audio : []
  const hasVisualMedia = frameImages.some(item => item !== null)
    || ((params?.maxReferenceImages ?? 0) > 0 && referenceImages.length > 0)
    || ((params?.maxReferenceVideos ?? 0) > 0 && referenceVideos.length > 0)
  const hasReferences = hasVisualMedia || ((params?.maxReferenceAudios ?? 0) > 0 && referenceAudios.length > 0)
  const allowedRatios = params?.ratios.filter(value => value !== 'adaptive' || hasVisualMedia) ?? []
  const selectedRatio = allowedRatios.includes(ratio) ? ratio : allowedRatios[0] ?? ''
  const ratioLabel = selectedRatio === 'adaptive' ? t('ratioAdaptive') : selectedRatio
  const settingsValues = { ratio: ratioLabel, resolution: selectedResolution, duration: String(duration) }
  const modelImageLimit = Math.max(params?.maxReferenceImages ?? 0, params?.frameSlots ?? 0)
  const imageLimit = modelImageLimit > 0 ? modelImageLimit : 6
  const referenceLimit = (slot: Slot): number => slot === 'image' ? imageLimit
    : slot === 'video' ? params?.maxReferenceVideos ?? 0 : params?.maxReferenceAudios ?? 0
  const overReferenceLimit = referenceImages.length > (params?.maxReferenceImages ?? 0)
    || referenceVideos.length > (params?.maxReferenceVideos ?? 0)
    || referenceAudios.length > (params?.maxReferenceAudios ?? 0)
  const settingsInvalid = params !== null && (durations.length === 0 || params.ratios.length > 0 && selectedRatio === '')
  const requestReferenceBytes = [...new Map([...frameImages, ...referenceImages, ...referenceVideos, ...referenceAudios]
    .filter((item): item is Reference => item !== null).map(item => [item.assetId, item])).values()]
    .reduce((total, item) => total + item.bytes, 0)
  const referenceBytesExceeded = requestReferenceBytes > 48 * 1024 * 1024

  useEffect(() => {
    if (params === null || locked) return
    const current = readDraft()
    const updates: Partial<VideoDraft> = {}
    if (current.duration !== duration) updates.duration = duration
    if (current.resolution !== selectedResolution) updates.resolution = selectedResolution
    if (current.ratio !== selectedRatio) updates.ratio = selectedRatio
    if (Object.keys(updates).length === 0) return
    const changedSelection = current.duration !== 0 || current.resolution !== '' || current.ratio !== ''
    actions.patch({ ...updates, ...(changedSelection && !settingsInvalid ? { message: t('settingsAdjusted', {
      ratio: selectedRatio === 'adaptive' ? t('ratioAdaptive') : selectedRatio,
      resolution: selectedResolution, duration: String(duration),
    }) } : settingsInvalid ? { message: null } : {}) })
  }, [actions, duration, locked, params, readDraft, selectedRatio, selectedResolution, settingsInvalid, t])

  const assistReferences = useMemo(() => {
    if (accountIdentity === null || draft.referenceAccountId !== accountIdentity || signedIn !== true) return []
    return [...new Set([firstFrame, lastFrame, ...slots.image]
      .filter((item): item is Reference => item !== null).map(item => item.assetId))]
  }, [accountIdentity, draft.referenceAccountId, signedIn, firstFrame, lastFrame, slots.image])
  const assistReferenceLimitExceeded = assistReferences.length > 6
  const assistGeneration = useMemo(() => ({
    model: model?.id ?? '', workflow, duration: String(duration), resolution: selectedResolution,
    ratio: selectedRatio, mode,
  }), [model, workflow, duration, selectedResolution, selectedRatio, mode])

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
    if (answer.sessionInvalid === true) { acceptAccount({ signedIn: false }); setBalance(null); return }
    setBalance(answer.ok ? answer.payload?.balance_points ?? null : null)
  }, [acceptAccount])

  const loadHistory = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/artifacts/api/list', { headers: { accept: 'application/json' } })
      if (!response.ok) { setHistoryError(true); return }
      const answer: unknown = await response.json()
      if (answer === null || typeof answer !== 'object') { setHistoryError(true); return }
      const payload = 'payload' in answer ? answer.payload : undefined
      const nestedItems = payload !== null && typeof payload === 'object' && 'items' in payload ? payload.items : undefined
      const items: unknown = ('items' in answer ? answer.items : undefined) ?? nestedItems
      if (!Array.isArray(items)) { setHistoryError(true); return }
      const entries: readonly unknown[] = items
      if (!entries.every(isArtifactItem)) { setHistoryError(true); return }
      setHistory(entries.filter(item => item.kind === 'video')
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
    const sequence = ++sessionSequence.current
    try {
      const answer = await requestJson<SessionInfo>('/credits/api/session')
      if (sequence !== sessionSequence.current) return
      if (!answer.ok || answer.payload === undefined) { setStateError(true); return }
      setStateError(false)
      acceptAccount(answer.payload)
      setCreditsPerYuan(answer.payload.creditsPerYuan)
      if (answer.payload.signedIn) await Promise.all([loadBalance(), loadModels(), loadHistory()])
      else setBalance(null)
    } finally { refreshing.current = false }
  }, [acceptAccount, loadBalance, loadModels, loadHistory])

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

  const isReferenceCurrent = useCallback((context: VideoDraft): boolean => {
    const current = readDraft()
    return current.referenceAccountId === context.referenceAccountId && current.referenceEpoch === context.referenceEpoch
  }, [readDraft])

  const upload = useCallback(async (
    slot: Slot, file: File, context: VideoDraft, replacing: Reference | null = null,
  ): Promise<Reference | null> => {
    if (!SLOT_TYPES[slot].types.includes(file.type)) {
      actions.patch({ failure: t('uploadFailed', { message: file.type || t('unknownType') }) })
      return null
    }
    if (file.size === 0 || file.size > (slot === 'image' ? 6 : slot === 'audio' ? 15 : 32) * 1024 * 1024) {
      actions.patch({ failure: t(slot === 'image' ? 'materialLimit' : slot === 'audio' ? 'audioUploadSize' : 'uploadSize', { n: String(imageLimit) }) }); return null
    }
    if (slot === 'image') {
      const images = [...new Map([context.firstFrame, context.lastFrame, ...context.slots.image]
        .filter((item): item is Reference => item !== null && item !== replacing).map(item => [item.assetId, item])).values()]
      if (images.length >= imageLimit || images.reduce((sum, item) => sum + item.bytes, 0) + file.size > 12 * 1024 * 1024) {
        actions.patch({ failure: t('materialLimit', { n: String(imageLimit) }) }); return null
      }
    }
    try {
      const response = await fetch('/credits/api/assets', {
        method: 'POST', headers: {
          'content-type': file.type, 'x-file-name': encodeURIComponent(file.name),
          'x-idempotency-key': `dsh-asset-${globalThis.crypto.randomUUID()}`, accept: 'application/json',
        }, body: file,
      })
      if (!isReferenceCurrent(context)) return null
      if (!response.ok) { actions.patch({ failure: t('uploadNetwork') }); return null }
      const answer = await response.json() as {
        ok: boolean
        code?: string
        message?: string
        sessionInvalid?: boolean
        asset?: { assetId?: string }
      }
      if (!isReferenceCurrent(context)) return null
      if (answer.sessionInvalid === true) { acceptAccount({ signedIn: false }); actions.patch({ failure: t('noAuth') }); return null }
      const assetId = answer.asset?.assetId
      if (!answer.ok || typeof assetId !== 'string') {
        actions.patch({ failure: t('uploadFailed', { message: answer.message ?? answer.code ?? t('unknown') }) })
        return null
      }
      return { assetId, name: file.name, url: createPreview(file), bytes: file.size }
    } catch (_error) {
      if (isReferenceCurrent(context)) actions.patch({ failure: t('uploadNetwork') })
      return null
    }
  }, [acceptAccount, actions, createPreview, imageLimit, isReferenceCurrent, t])

  const pick = useCallback(async (slot: Slot, files: FileList | null): Promise<void> => {
    if (busy || readDraft().promptAssisting || operation.current || files === null || files.length === 0) return
    const context = readDraft()
    if (signedIn !== true || accountIdentity === null || context.referenceAccountId !== accountIdentity) return
    const limit = slot === 'image' ? imageLimit
      : slot === 'video' ? params?.maxReferenceVideos ?? 0 : params?.maxReferenceAudios ?? 0
    const available = Math.max(0, limit - slots[slot].length)
    if (available === 0) return
    operation.current = true
    actions.patch({ failure: null, uploading: slot })
    try {
      for (const file of Array.from(files).slice(0, available)) {
        if (!isReferenceCurrent(context)) return
        const reference = await upload(slot, file, readDraft())
        if (reference === null) break
        if (!isReferenceCurrent(context)) { releasePreview(reference.url); return }
        actions.addReferences(slot, [reference], limit)
      }
    } finally { if (isReferenceCurrent(context)) { operation.current = false; actions.patch({ uploading: null }) } }
  }, [accountIdentity, busy, imageLimit, isReferenceCurrent, params, readDraft, releasePreview, signedIn, slots, upload, actions])

  const pickFrame = useCallback(async (which: 'first' | 'last', files: FileList | null): Promise<void> => {
    const file = files?.[0]
    if (busy || readDraft().promptAssisting || operation.current || file === undefined) return
    const context = readDraft()
    if (signedIn !== true || accountIdentity === null || context.referenceAccountId !== accountIdentity) return
    operation.current = true
    actions.patch({ failure: null, uploading: which })
    try {
      const reference = await upload('image', file, context, which === 'first' ? context.firstFrame : context.lastFrame)
      if (reference !== null) {
        if (!isReferenceCurrent(context)) { releasePreview(reference.url); return }
        const current = readDraft()
        const previous = which === 'first' ? current.firstFrame : current.lastFrame
        actions.patch(which === 'first' ? { firstFrame: reference } : { lastFrame: reference })
        if (previous !== null) releasePreview(previous.url)
      }
    } finally { if (isReferenceCurrent(context)) { operation.current = false; actions.patch({ uploading: null }) } }
  }, [accountIdentity, busy, isReferenceCurrent, readDraft, signedIn, upload, actions, releasePreview])

  const generate = useCallback(async (): Promise<void> => {
    if (busy || readDraft().promptAssisting || operation.current || signedIn !== true) return
    const context = readDraft()
    if (accountIdentity === null || context.referenceAccountId !== accountIdentity) return
    actions.patch({ failure: null, message: null })
    if (sessionId === undefined) { actions.patch({ failure: t('sessionRequired') }); return }
    if (prompt.trim() === '') { actions.patch({ failure: t('promptRequired') }); promptField.current?.focus(); return }
    if (model === null || params === null) { actions.patch({ failure: t('noModel') }); return }
    if ((workflow === 'image' && (params.frameSlots > 0 ? firstFrame === null : slots.image.length === 0))
      || (workflow === 'frames' && (firstFrame === null || lastFrame === null))
      || (workflow === 'reference' && !hasReferences)) {
      actions.patch({ failure: t('mediaRequired') }); return
    }
    if (settingsInvalid || overReferenceLimit || referenceBytesExceeded) return
    operation.current = true
    setModelMenu(false)
    actions.patch({ phase: 'running', generationSessionId: sessionId, startedAt: Date.now() })
    const frames = workflow === 'frames' ? [firstFrame, lastFrame] : workflow === 'image' && params.frameSlots > 0 ? [firstFrame] : []
    try {
      if (frames.some(reference => reference !== null) || hasReferences) {
        const sequence = ++sessionSequence.current
        const session = await requestJson<SessionInfo>('/credits/api/session')
        if (sequence !== sessionSequence.current) return
        if (!session.ok || session.payload === undefined) { actions.patch({ failure: t('stateFailed') }); return }
        if (acceptAccount(session.payload) !== context.referenceAccountId || !isReferenceCurrent(context)) {
          actions.patch({ failure: t('referenceAccountChanged') })
          return
        }
      }
      const answer = await requestJson<ArtifactLocation>('/credits/api/video/tasks?source=newapi-generate', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          session_id: sessionId, account_id: accountIdentity,
          prompt: prompt.trim(), model: model.id, durationSeconds: duration,
          ...(selectedResolution === '' ? {} : { resolution: selectedResolution }),
          ...(selectedRatio === '' ? {} : { ratio: selectedRatio }),
          ...(params.modes.includes(mode) ? { mode } : {}),
          ...(params.seed && seed.trim() !== '' && Number.isSafeInteger(Number(seed)) ? { seed: Number(seed) } : {}),
          ...(params.audioToggle ? { audio } : {}),
          frameImages: frames.filter((item): item is Reference => item !== null).map(item => item.assetId),
          referenceImages: referenceImages.map(item => item.assetId),
          referenceVideos: referenceVideos.map(item => item.assetId),
          referenceAudios: referenceAudios.map(item => item.assetId),
        }),
      })
      if (!isReferenceCurrent(context)) return
      if (answer.sessionInvalid === true) {
        acceptAccount({ signedIn: false }); actions.patch({ failure: t('noAuth') }); return
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
      actions.patch({ result: { path: answer.payload.path, ...answer.payload.workspaceId === undefined ? {} : { workspaceId: answer.payload.workspaceId } }, message: t('done') })
      await Promise.all([loadBalance(), loadHistory()])
    } finally { operation.current = false; actions.patch({ phase: 'idle' }) }
  }, [acceptAccount, accountIdentity, busy, signedIn, actions, prompt, model, params, workflow, firstFrame, lastFrame, slots,
    hasReferences, isReferenceCurrent, readDraft, sessionId,
    duration, settingsInvalid, overReferenceLimit, referenceBytesExceeded,
    referenceImages, referenceVideos, referenceAudios,
    selectedResolution, selectedRatio, mode, seed, audio, t, loadBalance, loadHistory])

  const frameField = (which: 'first' | 'last'): ReactNode => {
    const reference = which === 'first' ? firstFrame : lastFrame
    return <div className={css.field}>
      <span className={css.label}>{t(which === 'first' ? 'firstFrame' : 'lastFrame')}</span>
      <label className={css.dropzone}>
        <input type="file" aria-label={t(which === 'first' ? 'firstFrame' : 'lastFrame')} accept={SLOT_TYPES.image.accept}
          disabled={locked}
          onChange={(event) => { void pickFrame(which, event.target.files); event.target.value = '' }} />
        {reference === null ? <><IconPlusOutlineRegular /><span>{uploading === which ? t('uploading') : t('frameHint')}</span></>
          : <img className={css.frame} src={reference.url} alt={reference.name} />}
      </label>
      {reference !== null && <button type="button" disabled={locked} className={css.link} onClick={() => {
        actions.patch(which === 'first' ? { firstFrame: null } : { lastFrame: null }); releasePreview(reference.url)
      }}>{t('remove')}</button>}
    </div>
  }

  const referenceField = (slot: Slot): ReactNode => {
    const limit = referenceLimit(slot)
    if (limit === 0 && slots[slot].length === 0) return null
    const full = slots[slot].length >= limit
    return <div className={css.field} key={slot}>
      <span className={css.label}>{t(SLOT_LABELS[slot])}
        <span className={css.count}>{slots[slot].length}/{limit}</span>
      </span>
      {limit > 0 ? <label className={css.dropzone} aria-disabled={full}>
        <input type="file" aria-label={t(SLOT_LABELS[slot])} accept={SLOT_TYPES[slot].accept} multiple disabled={full || locked}
          onChange={(event) => { void pick(slot, event.target.files); event.target.value = '' }} />
        <IconPlusOutlineRegular /><span>{uploading === slot ? t('uploading') : full ? t('referenceFull') : t(SLOT_HINTS[slot])}</span>
      </label> : <p className={css.hint}>{t('unsupportedReferencesRetained')}</p>}
      <ul className={css.files}>{slots[slot].map(item => <li key={item.assetId} className={slot === 'audio' ? `${css.fileRow} ${css.audioReference}` : css.fileRow}>
        {slot === 'image' ? <img className={css.fileThumb} src={item.url} alt={item.name} /> : <IconPlayOutlineRegular />}
        <span className={css.fileName}>{item.name}</span>
        <button type="button" disabled={locked} className={css.link} aria-label={t('removeNamed', { name: item.name })} onClick={() => {
          actions.removeReference(slot, item.assetId); releasePreview(item.url)
        }}>{t('remove')}</button>
        {slot === 'audio' && <audio className={css.audioPreview} controls preload="metadata" src={item.url}
          aria-label={t('audioPreview', { name: item.name })} />}
      </li>)}</ul>
    </div>
  }

  const applyTemplate = (id: string): void => {
    if (locked) return
    const template = contentTemplates.find(item => item.id === id)
    if (template === undefined) return
    const script = text(template.prompt)
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
      <fieldset className={css.composerFields} disabled={signedIn !== true}>
        <div className={css.workflowBar}>{workflows.map(entry => <button key={entry} type="button" disabled={locked} aria-pressed={workflow === entry}
          className={workflow === entry ? `${css.workflow} ${css.workflowActive}` : css.workflow}
          onClick={() => { actions.patch({ workflow: entry, failure: null, message: null }) }}>{t(WORKFLOW_LABELS[entry])}</button>)}</div>
        <div className={css.promptRow}>
          <label className={css.addMedia}><IconPlusOutlineRegular size={24} /><span>{t('addMedia')}</span>
            <input type="file" aria-label={t('addMedia')} accept={SLOT_TYPES.image.accept} multiple disabled={locked}
              onChange={(event) => { void pick('image', event.target.files); event.target.value = '' }} />
          </label>
          <label className={css.promptField}>
            <textarea ref={promptField} className={css.textarea} rows={4} value={prompt} aria-label={t('prompt')}
              placeholder={text(content?.promptPlaceholder) || t('promptPlaceholder')} onChange={(event) => { actions.patch({ prompt: event.target.value }) }} />
            <span className={css.count} aria-hidden="true">{prompt.length}</span>
          </label>
        </div>
        {props.renderFactorySlot('creation.prompt.assist', {
          kind: 'video', prompt,
          references: assistReferences, generation: assistGeneration,
          disabled: busy || assistReferenceLimitExceeded, signedIn: signedIn === true, accountIdentity,
          onBusyChange: (value) => {
            const current = readDraft()
            if (current.referenceAccountId === accountIdentity && current.referenceEpoch === draft.referenceEpoch) {
              actions.patch({ promptAssisting: value })
              if (value) setModelMenu(false)
            }
          },
          onPromptChange: (value, expectedPrompt) => {
            const current = readDraft()
            if (signedIn !== true || accountIdentity === null || current.referenceAccountId !== accountIdentity
              || current.referenceEpoch !== draft.referenceEpoch || current.uploading !== null || current.phase === 'running'
              || current.prompt !== expectedPrompt || JSON.stringify([current.modelId, current.workflow, current.duration,
              current.resolution, current.ratio, current.mode, current.seed, current.audio, current.firstFrame,
              current.lastFrame, current.slots]) !== JSON.stringify([modelId, draft.workflow, draft.duration,
              resolution, ratio, mode, seed, audio, firstFrame, lastFrame, slots])) return false
            actions.patch({ prompt: value, failure: null, message: null })
            promptField.current?.focus()
            return true
          },
        })}
        {assistReferenceLimitExceeded && <p className={css.hint} role="status">{t('assistReferenceLimit')}</p>}
        <p className={css.hint}>{t('materialHelp', { n: String(imageLimit) })}</p>
        <div className={css.mediaGrid}>{referenceField('image')}</div>
        <p className={css.hint}>{t(WORKFLOW_HINTS[workflow])}</p>
        {(firstFrame !== null || lastFrame !== null || hasReferences) && <p className={css.hint}>{t('inactiveMediaHint')}</p>}
        {workflow !== 'text' && params !== null && <div className={css.mediaGrid}>
          {workflow === 'image' && params.frameSlots > 0 && frameField('first')}
          {workflow === 'frames' && <>{frameField('first')}{frameField('last')}</>}
          {workflow === 'reference' && <>{referenceField('video')}{referenceField('audio')}</>}
        </div>}
        {contentPresets.length > 0 && <div className={css.presets} aria-label={t('cameraIntents')}>{contentPresets.map(preset => <button key={preset.id} type="button" disabled={locked} className={css.chip}
          onClick={() => { actions.appendPrompt(text(preset.promptSuffix)) }}>{text(preset.label)}</button>)}</div>}
        <div className={css.composerBar}>
          <Menu open={modelMenu} portal selectedId={model?.id} items={models.map(entry => ({ id: entry.id, label: entry.displayName }))}
            onSelect={(id) => { actions.patch({ modelId: id, message: null }); setModelMenu(false) }}
            onClose={() => { setModelMenu(false) }}
            anchor={<button type="button" className={css.modelButton} aria-label={t('model')} aria-expanded={modelMenu}
              disabled={locked || models.length === 0} onClick={() => { setModelMenu(!modelMenu) }}>{model?.displayName ?? t('model')}<span aria-hidden="true">⌄</span></button>} />
          <details className={css.settings}>
            <summary className={css.settingsTrigger} aria-label={params === null || settingsInvalid ? t('settingsUnavailable') : t('settingsTrigger', settingsValues)} aria-disabled={locked || params === null}
              onClick={(event) => { if (locked || params === null) event.preventDefault() }}>
              <span className={css.settingsTitle}><IconSettingsOutlineRegular size={16} /><span>{t('settings')}</span></span>
              <span className={css.settingsValues} aria-hidden="true">{params === null || settingsInvalid ? t('settingsUnavailable') : <><span>{ratioLabel}</span><span>{selectedResolution}</span><span>{t('secondsCompact', { n: String(duration) })}</span></>}</span>
              <IconChevronDownOutlineRegular className={css.settingsChevron} size={14} />
            </summary>
            <div className={css.settingsPanel}>
              <div className={css.settingsHeading}><div><h3>{t('settings')}</h3><p>{t('settingsHint')}</p></div><span className={css.settingsOverview}>{settingsInvalid ? t('settingsUnavailable') : t('settingsSummary', settingsValues)}</span></div>
              <fieldset className={css.settingsBody} aria-label={t('settings')} disabled={locked}>
                {params !== null && params.ratios.length > 0 && <fieldset className={css.settingsGroup}><legend>{t('ratio')}</legend>
                  <div className={css.ratioGrid}>{params.ratios.map((value) => {
                    const [width = 1, height = 1] = value === 'adaptive' ? [4, 3] : value.split(':').map(Number)
                    const scale = Math.min(30 / width, 24 / height)
                    const category = width === height ? 'ratioSquare' : width > height ? 'ratioLandscape' : 'ratioPortrait'
                    return <button key={value} type="button" aria-pressed={selectedRatio === value}
                      aria-label={t('ratioOption', { ratio: value === 'adaptive' ? t('ratioAdaptive') : value })}
                      className={css.ratioCard} disabled={value === 'adaptive' && !hasVisualMedia}
                      onClick={() => { actions.patch({ ratio: value, message: null }) }}>
                      <span className={css.ratioVisual} aria-hidden="true"><span className={css.ratioShape} data-adaptive={value === 'adaptive'}
                        style={{ width: width * scale, height: height * scale }} /></span>
                      <span className={css.ratioValue}>{value === 'adaptive' ? t('ratioAdaptive') : value}</span><span className={css.ratioCaption}>{t(value === 'adaptive' ? 'ratioAdaptiveCaption' : category)}</span>
                    </button>
                  })}</div></fieldset>}
                {params?.ratios.includes('adaptive') === true && !hasVisualMedia
                  && <p className={css.hint}>{t('adaptiveNeedsVisual')}</p>}
                {params !== null && params.resolutions.length > 0 && <fieldset className={css.settingsGroup}><legend>{t('resolution')}</legend>
                  <div className={css.optionGrid}>{params.resolutions.map(value => <button key={value} type="button" aria-pressed={selectedResolution === value}
                    className={css.parameterOption} onClick={() => { actions.patch({ resolution: value, message: null }) }}>
                    {value}</button>,
                  )}</div></fieldset>}
                {params !== null && durations.length > 0 && <fieldset className={css.settingsGroup}><legend>{t('duration')}</legend>
                  <div className={css.durationGrid}>{durations.map(value => <button key={value} type="button" aria-pressed={duration === value}
                    className={css.parameterOption} onClick={() => { actions.patch({ duration: value, message: null }) }}>{t('seconds', { n: String(value) })}</button>)}</div></fieldset>}
                {params !== null && <div className={css.audioRow}><div><span className={css.audioTitle}>{t('audio')}</span>
                  <p>{t(params.audioToggle ? 'audioHint' : params.audio ? 'audioFixedOn' : 'audioFixedOff')}</p></div>
                <div className={css.audioState}><span aria-hidden={params.audioToggle}>{t((params.audioToggle ? audio : params.audio) ? 'on' : 'off')}</span>
                  {params.audioToggle && <Switch checked={audio} onChange={(value) => { actions.patch({ audio: value }) }} label={t('audio')} disabled={locked} className={css.audioSwitch} />}
                </div></div>}
                {params !== null && params.modes.length > 0 && <fieldset className={css.settingsGroup}><legend>{t('mode')}</legend>
                  <div className={css.optionGrid}>{params.modes.map(value => <button key={value} type="button" aria-pressed={mode === value}
                    className={css.parameterOption} onClick={() => { actions.patch({ mode: value }) }}>{value}</button>)}</div></fieldset>}
                {params?.seed === true && <label className={css.field}><span className={css.label}>{t('seed')}</span><input className={css.seed} inputMode="numeric" value={seed}
                  placeholder={t('seedHint')} onChange={(event) => { actions.patch({ seed: event.target.value.replace(/[^0-9]/g, '') }) }} /></label>}
              </fieldset>
            </div>
          </details>
          <span className={css.cost}>{t('costShort')}</span>
          <Tooltip label={phase === 'running' ? t('runningShort') : t('submit')} portal side="top">
            <button type="button" className={css.send} aria-label={phase === 'running' ? t('runningShort') : t('submit')}
              onClick={() => { void generate() }} disabled={locked || model === null || sessionId === undefined || prompt.trim() === '' || settingsInvalid
                || overReferenceLimit || referenceBytesExceeded}>
              <span className={phase === 'running' ? css.spinner : css.sendArrow} aria-hidden="true">{phase === 'running' ? '' : '↑'}</span>
            </button>
          </Tooltip>
        </div>
      </fieldset>
      <div className={css.feedback} aria-live="polite">
        {phase === 'running' && <p className={css.notice}>{t('running', { seconds: String(elapsed) })}</p>}
        {uploading !== null && <p className={css.notice}>{t('uploading')}</p>}
        {overReferenceLimit && <p className={css.error} role="alert">{t('referenceOverLimit')}</p>}
        {settingsInvalid && <p className={css.error} role="alert">{t('settingsUnavailableForModel')}</p>}
        {referenceBytesExceeded && <p className={css.error} role="alert">{t('referenceBytesExceeded')}</p>}
        {failure !== null && <p className={css.error} role="alert">{failure}</p>}
        {message !== null && <p className={css.notice}>{message}</p>}
        {signedIn === false && <p className={css.hint}>{t('signedOut')}</p>}
        {sessionId === undefined && <p className={css.hint}>{t('sessionRequired')}</p>}
        {stateError && <p className={css.error}>{t('stateFailed')} <button type="button" className={css.link} onClick={() => { void refreshState() }}>{t('retry')}</button></p>}
        {modelsError !== null && <p className={css.error}>{t('modelsFailed', { message: modelsError })} <button type="button" className={css.link} onClick={() => { void loadModels() }}>{t('retry')}</button></p>}
        {signedIn === true && models.length === 0 && modelsError === null && <p className={css.hint}>{t('noModel')}</p>}
      </div>
    </section>
    {model !== null && <details className={css.capabilityNote}><summary>{t('modelInfo')}</summary><p className={css.hint}>{t('capabilityHint')}</p></details>}

    <section className={css.works} aria-label={t('projects')}>{projects}</section>

    <section className={css.templates} aria-label={t('templates')}>
      <div className={css.sectionHeading}><div><h2 className={css.sectionTitle}>{text(content?.title) || t('templates')}</h2><p className={css.hint}>{text(content?.description) || t('templatesHint')}</p></div>
        <div className={css.categories} aria-label={t('categories')}>
          <button type="button" className={css.category} aria-pressed={selectedCategory === 'all'} onClick={() => { actions.patch({ category: 'all' }) }}>{t('category_all')}</button>
          {contentCategories.map(category => <button key={category.id} type="button" aria-pressed={selectedCategory === category.id} className={css.category}
            onClick={() => { actions.patch({ category: category.id }) }}>{text(category.label)}</button>)}</div>
      </div>
      {publication.status === 'loading' && <p role="status" className={css.hint}>{t('contentLoading')}</p>}
      {publication.status === 'error' && <p role="alert" className={css.error}>{t('contentFailed')} <Button size="sm" onClick={props.refreshContent}>{t('retry')}</Button></p>}
      <div className={css.templateGrid}>{visibleTemplates.map(template => <button type="button" key={template.id}
        className={css.templateCard} disabled={locked} onClick={() => { setPreview(template.id) }} aria-label={t('previewNamed', { name: text(template.title) })}>
        {template.coverAssetId !== null && <img className={css.templateCover} src={`/credits/api/creation/assets/${encodeURIComponent(template.coverAssetId)}`} alt="" loading="lazy" />}
        <div className={css.templateBody}><span className={css.templateBadge}>{t('scriptTemplate')}</span><h3>{text(template.title)}</h3><p>{text(template.description)}</p><span className={css.templateLink}>{t('viewScript')}<span aria-hidden="true">↗</span></span></div>
      </button>)}</div>
      {publication.status === 'ready' && contentTemplates.length === 0 && <p className={css.hint}>{t('contentEmpty')}</p>}
      {publication.status === 'ready' && contentTemplates.length > 0 && visibleTemplates.length === 0 && <p className={css.hint}>
        {t('noTemplates')} <button type="button" className={css.link} onClick={() => { actions.patch({ category: 'all' }) }}>{t('resetFilters')}</button></p>}
    </section>

    {result !== null && <section className={css.result} aria-label={t('result')}>
      <div className={css.sectionHeading}><h2 className={css.sectionTitle}>{t('result')}</h2><button type="button" className={css.link} onClick={() => { actions.patch({ result: null }) }}>{t('closePreview')}</button></div>
      <video className={css.video} src={rawUrl(result)} controls preload="metadata" />
      <div className={css.figureMeta}><a className={css.link} href={rawUrl(result)} target="_blank" rel="noreferrer">{t('open')}</a><a className={css.link} href={rawUrl(result)} download={result.path.split(/[\\/]/).pop()}>{t('download')}</a><code className={css.path}>{result.path}</code></div>
    </section>}

    <section className={css.works} aria-label={t('history')}>
      <div className={css.sectionHeading}><div><h2 className={css.sectionTitle}>{t('history')}</h2><p className={css.hint}>{t('historyHint')}</p></div><Button size="sm" onClick={() => { void loadHistory() }}>{t('refresh')}</Button></div>
      {historyError && <p className={css.error} role="alert">{t('historyFailed')}</p>}
      {history.length === 0 ? <div className={css.emptyWorks}><IconPlayOutlineRegular size={30} /><p>{t('historyEmpty')}</p><span>{t('historyEmptyHint')}</span></div>
        : <ul className={css.history}>{history.map(item => <li key={fileIdentity(item)}><button type="button" className={css.historyButton} aria-label={t('previewNamed', { name: item.name })}
          onClick={() => { actions.patch({ result: { path: item.path, ...item.workspaceId === undefined ? {} : { workspaceId: item.workspaceId } } }) }}><div className={css.historyVisual}><video src={rawUrl(item)} muted preload="metadata" /><span className={css.play}><IconPlayOutlineRegular size={24} /></span></div><span className={css.historyName}>{item.name}</span></button></li>)}</ul>}
    </section>
    <Modal open={previewTemplate !== null} title={previewTemplate === null ? t('scriptTemplate') : text(previewTemplate.title)} closeLabel={t('closePreview')} onClose={() => { setPreview(null) }}
      footer={<Button variant="primary" disabled={locked} onClick={() => { if (preview !== null) applyTemplate(preview) }}>{t('useScript')}</Button>}>
      {previewTemplate?.demoVideoAssetId !== null && previewTemplate?.demoVideoAssetId !== undefined && <video controls preload="metadata" className={css.video}
        src={`/credits/api/creation/assets/${encodeURIComponent(previewTemplate.demoVideoAssetId)}`} />}
      <p className={css.hint}>{t('scriptPreviewHint')}</p><p className={css.scriptPreview}>{previewTemplate === null ? '' : text(previewTemplate.prompt)}</p>
    </Modal>
  </div>
}
