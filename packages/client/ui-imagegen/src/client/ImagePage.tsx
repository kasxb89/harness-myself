/** Image creation workspace driven by the deployment's existing media catalog. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconCloseOutlineRegular,
  IconPlusOutlineRegular, IconSearchOutlineRegular, IconSendOutlineRegular,
  IconSettingsOutlineRegular, IconSparkleRegular, ImageLightbox, productFailureKind, SegmentedTabs, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRenderFactories, PropsRuntime, PropsStore, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-prompt-assist/client'
import type { Context } from '@deepseek-ai/cordis'
import type { LocalizedText } from '@deepseek-ai/dsh-client-creation-content/client'
import type { createImageDraftStore, ImageDraft, ImageUploadResult } from './draft-store.ts'
import { queryImageSubmission, readImageSubmission, submissionFromAnswer, submissionKey } from './image-submission.ts'
import css from './ImagePage.module.css'

/** Plain callbacks injected by this plugin's registration. */
export interface ImagegenInjected {
  readonly t: (key: string, values?: Record<string, string>) => string
  readonly openVideo: () => void
  readonly readDraft: () => ImageDraft
  readonly createReferencePreview: (file: File) => string
  readonly releaseReferencePreview: (url: string) => void
  readonly refreshContent: () => void
  readonly hooks: { readonly creationContent: Context['creationContent']; readonly locale: Context['locale']; readonly creationSession: HostObservable<StandardSourceBinding> }
}

interface Envelope<T> {
  readonly ok: boolean
  readonly code?: string | null
  readonly message?: string | null
  readonly sessionInvalid?: boolean
  readonly payload?: T
  readonly plan_id?: string | null
  readonly operation_id?: string | null
  readonly task_id?: string | null
  readonly request_id?: string | null
  readonly submission_state?: 'not-submitted' | 'pending' | 'unknown' | 'failed' | 'completed' | null
}

interface SessionInfo {
  readonly signedIn: boolean
  readonly creditsPerYuan: number
  readonly account?: { readonly id?: string | number } | null
}
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
interface ArtifactLocation {
  readonly path: string
  readonly workspaceId?: string
}
interface ArtifactItem extends ArtifactLocation {
  readonly name: string
  readonly kind: string
  readonly mtimeMs?: number
}

type ImagePageProps = PropsRuntime<'main'> & PropsRenderFactories & PropsStore<ReturnType<typeof createImageDraftStore>> & InjectFace<ImagegenInjected>

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
  const answer = await response.json() as Envelope<T>
  return response.ok ? answer : { ...answer, ok: false }
}

function rawUrl(file: ArtifactLocation): string {
  return `/artifacts/api/raw?path=${encodeURIComponent(file.path)}${file.workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(file.workspaceId)}`}`
}

function fileIdentity(file: ArtifactLocation): string { return JSON.stringify([file.workspaceId ?? null, file.path]) }

/**
 * Render the image mode and retain its draft when the video mode is selected.
 * @param props - framework runtime/store shares and localized plugin callbacks.
 * @returns the image creation workspace.
 */
export function ImagePage(props: ImagePageProps): ReactNode {
  const { t, openVideo, createReferencePreview, releaseReferencePreview, readDraft, actions } = props
  const draft = props.useStore(state => state)
  const sessionId = props.useCreationSession(binding => binding.key)
  const {
    prompt, modelId, size, quality, background, format, compression, moderation, seed, count,
    references, uploading, uploadResult, generationStartedAt, sessionInvalid, message, failure, resultPaths: result,
  } = draft
  const running = generationStartedAt !== null
  const publication = props.useCreationContent(state => state)
  const language = props.useLocale(state => state.active)
  const text = (value: LocalizedText | undefined): string => value === undefined ? '' : language === 'en' ? value.en || value.zh : value.zh
  const content = publication.content?.image
  const contentCategories = [...content?.categories ?? []].filter(item => item.enabled).sort((a, b) => a.sortOrder - b.sortOrder)
  const contentTemplates = [...content?.templates ?? []].filter(item => item.status === 'published'
    && (item.categoryId === null || contentCategories.some(category => category.id === item.categoryId)))
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const contentPresets = [...content?.presets ?? []].filter(item => item.status === 'published').sort((a, b) => a.sortOrder - b.sortOrder)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [accountIdentity, setAccountIdentity] = useState<string | null>(null)
  const [submissionCheck, setSubmissionCheck] = useState<'checking' | 'ready' | 'failed'>('checking')
  const [checkedOwner, setCheckedOwner] = useState<string | null>(null)
  const [submissionRevision, setSubmissionRevision] = useState(0)
  const [queryingOriginal, setQueryingOriginal] = useState(false)
  const originalQuery = useRef<AbortController | null>(null)
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
  const [preview, setPreview] = useState<(ArtifactLocation & { name: string }) | null>(null)
  const [category, setCategory] = useState<string>('all')
  const [search, setSearch] = useState('')
  const promptField = useRef<HTMLTextAreaElement | null>(null)
  const fileField = useRef<HTMLInputElement | null>(null)
  const sessionSequence = useRef(0)
  useEffect(() => () => { sessionSequence.current += 1 }, [])

  const acceptAccount = useCallback((info: Pick<SessionInfo, 'signedIn' | 'account'>): string | null => {
    const id = info.account?.id
    const accountId = info.signedIn && (typeof id === 'string' || typeof id === 'number') && String(id) !== '' ? String(id) : null
    const current = readDraft()
    if (current.referenceAccountId !== accountId) {
      actions.setReferenceAccount(accountId)
      for (const reference of current.references) releaseReferencePreview(reference.url)
    }
    setSignedIn(info.signedIn)
    setAccountIdentity(accountId)
    return accountId
  }, [actions, readDraft, releaseReferencePreview])

  const model = useMemo(() => models.find(entry => entry.id === modelId) ?? models[0] ?? null, [modelId, models])
  const params = model?.params ?? null
  const maxEdits = params?.maxEdits ?? 0
  const isSignedIn = signedIn === true && !sessionInvalid
  const ownsReferences = isSignedIn && accountIdentity !== null && draft.referenceAccountId === accountIdentity
  const submissionOwner = accountIdentity === null || sessionId === undefined ? null : { accountId: accountIdentity, sessionId }
  const ownerKey = submissionOwner === null ? null : submissionKey(submissionOwner)
  const originalSubmission = ownerKey === null ? null : draft.unsettled[ownerKey] ?? null
  const locked = running || uploading || draft.promptAssisting || originalSubmission !== null
    || submissionCheck !== 'ready' || checkedOwner !== ownerKey
  const canUpload = ownsReferences && references.length < 6 && !locked
  const assistReferences = useMemo(() => ownsReferences ? references.map(item => item.assetId) : [],
    [references, ownsReferences])
  const assistGeneration = useMemo(() => ({
    model: model?.id ?? '', size, quality, background, count: String(count),
  }), [model, size, quality, background, count])
  const selectedCategory = contentCategories.some(item => item.id === category) ? category : 'all'
  const visibleTemplates = contentTemplates.filter((template) => {
    const words = `${text(template.title)} ${text(template.description)}`.toLocaleLowerCase()
    return (selectedCategory === 'all' || template.categoryId === selectedCategory) && words.includes(search.trim().toLocaleLowerCase())
  })
  const works = useMemo(() => {
    const recent = new Map<string, ArtifactLocation & { name: string }>()
    for (const path of result) {
      const item = { path, name: path.split(/[\\/]/).pop() ?? path }
      recent.set(fileIdentity(item), item)
    }
    for (const item of history) if (!recent.has(fileIdentity(item))) recent.set(fileIdentity(item), item)
    return [...recent.values()]
  }, [history, result])

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const answer = await get<Catalog>('/credits/api/media/catalog')
      if (!answer.ok || answer.payload === undefined) {
        setModelsError(t('serverBusy'))
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
      if (answer.sessionInvalid === true) {
        acceptAccount({ signedIn: false }); actions.patch({ sessionInvalid: true }); setBalance(null); return
      }
      setBalance(answer.payload?.balance_points ?? null)
    } catch (_error) {
      // A balance read must not turn a successfully saved image into a failure.
      setBalance(null)
    }
  }, [acceptAccount, actions])

  const loadHistory = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/artifacts/api/list', { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
      const answer = await response.json() as { items?: readonly ArtifactItem[]; payload?: { items?: readonly ArtifactItem[] } }
      const items = answer.items ?? answer.payload?.items
      if (items === undefined) throw new Error('INVALID_ARTIFACT_LIST')
      setHistory(items.filter(item => item.kind === 'image')
        .sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0)).slice(0, 24))
      setHistoryError(false)
    } catch (_error) {
      // Retain the visible works while the index is temporarily unavailable.
      setHistoryError(true)
    }
  }, [])

  const refreshState = useCallback(async (): Promise<void> => {
    const sequence = ++sessionSequence.current
    const startedWithInvalidSession = readDraft().sessionInvalid
    try {
      const answer = await get<SessionInfo>('/credits/api/session')
      if (sequence !== sessionSequence.current) return
      if (!answer.ok || answer.payload === undefined) throw new Error('SESSION_UNAVAILABLE')
      const info = answer.payload
      setCreditsPerYuan(info.creditsPerYuan)
      acceptAccount(info)
      if (!info.signedIn) actions.patch({ sessionInvalid: true })
      else if (startedWithInvalidSession) actions.patch({ sessionInvalid: false })
      setStateError(false)
      if (info.signedIn) await Promise.all([loadBalance(), loadModels()])
      else setBalance(null)
    } catch (_error) {
      if (sequence === sessionSequence.current) setStateError(true)
    }
  }, [acceptAccount, actions, loadBalance, loadModels, readDraft])

  useEffect(() => {
    if (accountIdentity === null || sessionId === undefined) return undefined
    const owner = { accountId: accountIdentity, sessionId }
    const epoch = readDraft().referenceEpoch
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let readSequence = 0
    const current = (): boolean => !abort.signal.aborted && readDraft().referenceEpoch === epoch
      && readDraft().referenceAccountId === owner.accountId
    const check = async (): Promise<void> => {
      const sequence = ++readSequence
      const retained = readDraft().unsettled[submissionKey(owner)] ?? null
      const result = await readImageSubmission(owner, retained, abort.signal)
      if (!current() || sequence !== readSequence) return
      // An earlier listing must not erase a newly submitted or newly queried task.
      if ((readDraft().unsettled[submissionKey(owner)] ?? null) !== retained) { void check(); return }
      if (!result.ok) { setSubmissionCheck('failed'); return }
      setCheckedOwner(submissionKey(owner))
      setSubmissionCheck('ready')
      if (result.submission !== null) {
        actions.retainSubmission(result.submission)
        if (result.submission.state === 'pending' && !document.hidden) {
          timer = setTimeout(() => { timer = undefined; if (!document.hidden) void check() }, 2000)
        }
      } else {
        actions.clearSubmission(owner.accountId, owner.sessionId)
        if (retained !== null) {
          actions.patch({ failure: result.completed ? null : t('originalFailed'), message: result.completed ? t('done') : null })
          void loadHistory(); void loadBalance()
        }
      }
    }
    setSubmissionCheck('checking')
    void check()
    const revisit = (): void => {
      if (document.hidden) { if (timer !== undefined) clearTimeout(timer); timer = undefined }
      else if (timer === undefined) void check()
    }
    document.addEventListener('visibilitychange', revisit)
    return () => {
      abort.abort(); originalQuery.current?.abort(); originalQuery.current = null
      setQueryingOriginal(false)
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', revisit)
    }
  }, [accountIdentity, sessionId, submissionRevision, actions, loadHistory, loadBalance, readDraft, t])

  const queryOriginal = async (): Promise<void> => {
    if (originalSubmission === null || originalQuery.current !== null) return
    const epoch = readDraft().referenceEpoch
    const abort = new AbortController()
    originalQuery.current = abort
    setQueryingOriginal(true); setFailure(null)
    const answer = await queryImageSubmission(originalSubmission, abort.signal)
    if (!abort.signal.aborted && epoch === readDraft().referenceEpoch) {
      if (!answer.ok) setFailure(t('originalQueryFailed'))
      else {
        if (answer.submission !== null) actions.retainSubmission(answer.submission)
        else {
          actions.clearSubmission(originalSubmission.accountId, originalSubmission.sessionId)
          actions.patch({ message: answer.completed ? t('done') : null, failure: answer.completed ? null : t('originalFailed') })
          void loadHistory(); void loadBalance()
        }
        setSubmissionRevision(value => value + 1)
      }
    }
    if (originalQuery.current === abort) { originalQuery.current = null; setQueryingOriginal(false) }
  }

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
    actions.patch({
      modelId: model.id,
      size: params.sizes.includes(current.size) ? current.size : params.sizes[0] ?? '',
      quality: params.qualities.includes(current.quality) ? current.quality : '',
      background: params.backgrounds.includes(current.background) ? current.background : '',
      format: params.formats.includes(current.format) ? current.format : '',
      moderation: params.moderations.includes(current.moderation) ? current.moderation : '',
      count: Math.max(1, Math.min(current.count, params.maxCount)),
      seed: params.seed ? current.seed : '',
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
    if (current.uploading || current.generationStartedAt !== null || current.promptAssisting) return
    const removed = current.references.find(item => item.assetId === assetId)
    if (removed !== undefined) releaseReferencePreview(removed.url)
    actions.removeReference(assetId)
  }, [actions, readDraft, releaseReferencePreview])

  const clearReferences = useCallback((): void => {
    const current = readDraft()
    if (current.uploading || current.generationStartedAt !== null || current.promptAssisting) return
    for (const item of current.references) releaseReferencePreview(item.url)
    actions.patch({ references: [], uploadResult: null })
  }, [actions, readDraft, releaseReferencePreview])

  const addReferences = useCallback(async (source: readonly File[] | ArtifactLocation): Promise<void> => {
    const current = readDraft()
    if (current.uploading || current.generationStartedAt !== null || current.promptAssisting || current.sessionInvalid || signedIn !== true
      || accountIdentity === null || current.referenceAccountId !== accountIdentity) return
    const owner = current.referenceAccountId
    const epoch = current.referenceEpoch
    const isCurrent = (): boolean => {
      const latest = readDraft()
      return latest.referenceAccountId === owner && latest.referenceEpoch === epoch
    }
    if (!('path' in source) && source.length === 0) return
    let result: ImageUploadResult = { added: 0, converted: 0, firstFrames: 0, failures: [] }
    const reject = (name: string, reason: string): void => {
      result = { ...result, failures: [...result.failures, { name, reason }] }
      if (isCurrent()) actions.patch({ uploadResult: result })
    }
    const failureReason = (code: string | null | undefined): string => {
      switch (code) {
        case 'IMAGE_EMPTY': return t('emptyImage')
        case 'IMAGE_INPUT_TOO_LARGE': return t('fileSizeLimit')
        case 'IMAGE_FORMAT_UNSUPPORTED': return t('unsupportedType')
        case 'IMAGE_DECODE_FAILED': return t('invalidImage')
        case 'IMAGE_CONVERSION_FAILED': return t('conversionFailed')
        case 'IMAGE_DECODER_UNAVAILABLE': return t('decoderUnavailable')
        case 'IMAGE_STORAGE_FAILED': return t('imageStorageFailed')
        case 'IMAGE_UPLOAD_FAILED': return t('connectionFailure')
        case 'IMAGE_PIXEL_LIMIT': return t('imageDimensionsLimit')
        case 'IMAGE_OUTPUT_TOO_LARGE': return t('normalizedSizeLimit')
        default: return t('invalidUploadResponse')
      }
    }
    actions.patch({ uploading: true, failure: null, uploadResult: null })
    try {
      let files: readonly File[]
      if ('path' in source) {
        const response = await fetch(rawUrl(source))
        if (!isCurrent()) return
        if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
        const blob = await response.blob()
        if (!isCurrent()) return
        files = [new File([blob], source.path.split(/[\\/]/).pop() ?? 'image.png', { type: blob.type })]
      } else files = source
      for (const file of files) {
        if (!isCurrent()) return
        if (readDraft().references.length >= 6) { reject(file.name, t('referenceLimit', { n: '6' })); continue }
        if (file.size === 0) { reject(file.name, t('emptyImage')); continue }
        if (file.size > 32 * 1024 * 1024) { reject(file.name, t('fileSizeLimit')); continue }
        try {
          const response = await fetch('/credits/api/assets', {
            method: 'POST',
            headers: {
              'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name),
              'x-idempotency-key': `dsh-asset-${globalThis.crypto.randomUUID()}`, accept: 'application/json',
            },
            body: file,
          })
          if (!isCurrent()) return
          const answer = await response.json() as Envelope<never> & { asset?: {
            assetId: string | null
            contentType?: string
            sizeBytes?: number
            previewUrl?: string
            converted?: boolean
            firstFrameOnly?: boolean
          } | null }
          if (!isCurrent()) return
          if (answer.sessionInvalid === true) {
            reject(file.name, t('noAuth'))
            acceptAccount({ signedIn: false })
            actions.patch({ sessionInvalid: true, failure: t('noAuth') })
            return
          }
          const asset = answer.asset
          if (!response.ok || !answer.ok) { reject(file.name, failureReason(answer.code)); continue }
          if (asset === null || asset === undefined || typeof asset.assetId !== 'string' || asset.assetId === '') {
            reject(file.name, t('invalidUploadResponse')); continue
          }
          const expectedPreview = `/credits/api/assets/preview?asset_id=${encodeURIComponent(asset.assetId)}`
          const legacy = asset.previewUrl === undefined && asset.contentType === undefined && asset.sizeBytes === undefined
            && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && file.size <= 6 * 1024 * 1024
          const bytes = legacy ? file.size : asset.sizeBytes
          if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 6 * 1024 * 1024
            || !legacy && (asset.previewUrl !== expectedPreview || !['image/png', 'image/jpeg'].includes(asset.contentType ?? ''))) {
            reject(file.name, t('invalidUploadResponse')); continue
          }
          const latest = readDraft()
          if (latest.references.length >= 6) { reject(file.name, t('referenceLimit', { n: '6' })); continue }
          if (latest.references.reduce((sum, item) => sum + item.bytes, 0) + bytes > 12 * 1024 * 1024) {
            reject(file.name, t('referenceTotalLimit')); continue
          }
          actions.appendReference({ assetId: asset.assetId, name: file.name,
            url: legacy ? createReferencePreview(file) : expectedPreview, bytes })
          result = { ...result, added: result.added + 1, converted: result.converted + (asset.converted === true ? 1 : 0),
            firstFrames: result.firstFrames + (asset.firstFrameOnly === true ? 1 : 0) }
          actions.patch({ uploadResult: result })
        } catch (_error) {
          if (!isCurrent()) return
          reject(file.name, t('connectionFailure'))
        }
      }
    } catch (_error) {
      if (isCurrent()) reject('path' in source ? source.path.split(/[\\/]/).pop() ?? source.path : '', t('connectionFailure'))
    } finally {
      if (isCurrent()) actions.patch({ uploading: false })
    }
  }, [acceptAccount, accountIdentity, actions, createReferencePreview, readDraft, signedIn, t])

  const generate = useCallback(async (): Promise<void> => {
    const current = readDraft()
    if (current.uploading || current.generationStartedAt !== null || current.promptAssisting || current.sessionInvalid || signedIn !== true
      || accountIdentity === null || current.referenceAccountId !== accountIdentity || submissionCheck !== 'ready') return
    if (sessionId === undefined) { setFailure(t('sessionRequired')); return }
    const owner = { accountId: accountIdentity, sessionId }
    if (checkedOwner !== submissionKey(owner)) return
    if (current.unsettled[submissionKey(owner)] !== undefined) return
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
      if (current.references.length > 0) {
        const sequence = ++sessionSequence.current
        let session: Envelope<SessionInfo>
        try {
          session = await get<SessionInfo>('/credits/api/session')
        } catch (_error) {
          if (sequence === sessionSequence.current) setFailure(t('stateFailed'))
          return
        }
        if (sequence !== sessionSequence.current) return
        if (!session.ok || session.payload === undefined) { setFailure(t('stateFailed')); return }
        const confirmed = acceptAccount(session.payload)
        if (confirmed !== current.referenceAccountId || readDraft().referenceEpoch !== current.referenceEpoch) {
          if (!session.payload.signedIn) actions.patch({ sessionInvalid: true })
          setFailure(t('referenceAccountChanged'))
          return
        }
      }
      actions.retainSubmission({ ...owner, state: 'pending', canQuery: false })
      // Read accepted receipts while this original generation request is still waiting.
      setSubmissionRevision(value => value + 1)
      const answer = await post<{ path: string; paths?: readonly string[] }>('/credits/api/image/generate', {
        session_id: sessionId, account_id: accountIdentity,
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
      if (readDraft().referenceEpoch !== current.referenceEpoch) return
      if (answer.sessionInvalid === true) { acceptAccount({ signedIn: false }); actions.patch({ sessionInvalid: true, failure: t('noAuth') }); return }
      const unsettled = submissionFromAnswer(answer, owner)
      if (unsettled !== null) {
        actions.retainSubmission(unsettled)
        setFailure(answer.submission_state === undefined ? t('generationConnectionLost') : null)
        setSubmissionRevision(value => value + 1)
        return
      }
      actions.clearSubmission(owner.accountId, owner.sessionId)
      if (!answer.ok || answer.payload === undefined) {
        const kind = productFailureKind(answer.code)
        const referenceFailure = answer.code === 'IMAGE_REFERENCE_INVALID' || answer.code === 'IMAGE_REFERENCE_UPLOAD_FAILED'
          || answer.code === 'IMAGE_REFERENCE_UPLOAD_INVALID'
        setFailure(referenceFailure && typeof answer.message === 'string' && answer.message !== '' ? answer.message
          : kind === 'insufficient-credits' ? t('insufficient')
            : kind === 'sign-in' || kind === 'signed-out' ? t('noAuth')
              : kind === 'cancelled' ? t('cancelled')
                : answer.code === 'TIMEOUT' || answer.code === 'TRANSPORT' || answer.code === 'NO_TASK_ID'
                  ? t('generationConnectionLost') : t('serverBusy'))
        return
      }
      actions.patch({ resultPaths: answer.payload.paths ?? [answer.payload.path], message: t('done') })
      await Promise.all([loadBalance(), loadHistory()])
    } catch (_error) {
      // A disconnected request may have completed upstream; never retry it automatically.
      if (readDraft().referenceEpoch === current.referenceEpoch) {
        const retained = readDraft().unsettled[submissionKey(owner)]
        if (retained !== undefined) actions.retainSubmission({ ...retained, state: 'unknown', canQuery: false })
        setFailure(t('generationConnectionLost')); setSubmissionRevision(value => value + 1)
      }
      void loadHistory()
    } finally {
      if (readDraft().referenceEpoch === current.referenceEpoch) actions.patch({ generationStartedAt: null })
    }
  }, [acceptAccount, accountIdentity, actions, checkedOwner, loadBalance, loadHistory, models, readDraft, setFailure,
    sessionId, signedIn, submissionCheck, t])

  const applyTemplate = (value: string): void => {
    if (locked) return
    actions.patch({ prompt: value })
    setMessage(t('templateApplied'))
    promptField.current?.focus()
  }

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
              <Tooltip label={t('dropHint')} side="bottom" portal>
                <button type="button" className={css.addReference} aria-label={t('addReference')} disabled={!canUpload}
                  onClick={() => { fileField.current?.click() }}>
                  <IconPlusOutlineRegular size={22} />
                  <span>{uploading ? t('uploadingShort') : t('addReference')}</span>
                </button>
              </Tooltip>
              <input ref={fileField} type="file" aria-label={t('addReference')} accept="image/*,.png,.jpg,.jpeg,.jfif,.webp,.avif,.gif,.bmp,.tif,.tiff,.heic,.heif" multiple hidden
                disabled={!canUpload} onChange={(event) => { void addReferences([...event.target.files ?? []]); event.target.value = '' }} />
            </div>
            <label className={css.promptField}>
              <textarea ref={promptField} className={css.textarea} rows={4} value={prompt} aria-label={t('prompt')}
                placeholder={text(content?.promptPlaceholder) || t('promptPlaceholder')} onChange={(event) => { actions.patch({ prompt: event.target.value }) }} />
              <span className={css.characterCount} aria-hidden="true">{prompt.length}</span>
            </label>
          </div>
          <p className={css.parameterHint}>{t('materialHelp')} {maxEdits === 0 ? t('generationTextOnly') : t('generationReferences', { n: String(maxEdits) })}</p>
          {references.length > 0 && <div className={css.referenceTray}>
            <ul className={css.thumbs} aria-label={t('reference')}>
              {references.map(item => <li key={item.assetId} className={css.thumb}>
                <img src={item.url} alt={item.name} />
                <Tooltip label={t('removeReference', { name: item.name })} side="top" portal>
                  <button type="button" className={css.remove} aria-label={t('removeReference', { name: item.name })} disabled={locked}
                    onClick={() => { removeReference(item.assetId) }}><IconCloseOutlineRegular size={12} /></button>
                </Tooltip>
              </li>)}
            </ul>
            <span className={css.hint}>{references.length}/6</span>
            <button type="button" className={css.textAction} onClick={clearReferences} disabled={locked}>{t('clearReferences')}</button>
          </div>}
          {uploadResult !== null && <div className={css.uploadResult} aria-live="polite">
            <p className={css.notice}>{t('uploadSummary', { added: String(uploadResult.added), failed: String(uploadResult.failures.length) })}</p>
            {uploadResult.converted > 0 && <p className={css.hint}>{t('uploadConverted', { n: String(uploadResult.converted) })}</p>}
            {uploadResult.firstFrames > 0 && <p className={css.hint}>{t('uploadFirstFrames', { n: String(uploadResult.firstFrames) })}</p>}
            {uploadResult.failures.length > 0 && <ul className={css.uploadFailures} aria-label={t('uploadFailures')}>
              {uploadResult.failures.map((item, index) => <li key={index} className={css.error}>
                <span className={css.uploadFileName}>{item.name}</span><span>{item.reason}</span>
              </li>)}
            </ul>}
          </div>}
          {props.renderFactorySlot('creation.prompt.assist', {
            kind: 'image', prompt, references: assistReferences, generation: assistGeneration,
            disabled: uploading || running, signedIn: isSignedIn, accountIdentity,
            onBusyChange: (value) => {
              const current = readDraft()
              if (current.referenceAccountId === accountIdentity && current.referenceEpoch === draft.referenceEpoch) {
                actions.patch({ promptAssisting: value })
              }
            },
            onPromptChange: (value, expectedPrompt) => {
              const current = readDraft()
              if (!isSignedIn || accountIdentity === null || current.referenceAccountId !== accountIdentity
                || current.referenceEpoch !== draft.referenceEpoch || current.sessionInvalid || current.uploading
                || current.generationStartedAt !== null || current.prompt !== expectedPrompt
                || JSON.stringify([current.references, current.modelId, current.size, current.quality, current.background,
                  current.format, current.compression, current.moderation, current.seed, current.count])
                  !== JSON.stringify([references, modelId, size, quality, background, format, compression, moderation, seed, count])) {
                return false
              }
              actions.patch({ prompt: value, failure: null, message: null })
              promptField.current?.focus()
              return true
            },
          })}
          <div className={css.composerBar}>
            <label className={css.modelInline}>
              <select className={css.select} value={model?.id ?? ''} aria-label={t('model')} disabled={locked || models.length === 0}
                onChange={(event) => { actions.patch({ modelId: event.target.value }) }}>
                {models.length === 0 && <option value="">{t('noModelsShort')}</option>}
                {models.map(entry => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
              </select>
            </label>
            {params !== null && <button type="button" disabled={locked} className={css.parameterButton} aria-expanded={advanced} aria-controls="image-parameters"
              onClick={() => { setAdvanced(current => !current) }}><IconSettingsOutlineRegular size={14} /><span>{size || t('parameters')}{count > 1 ? ` · ${String(count)}` : ''}</span></button>}
            <span className={css.mode}>{maxEdits === 0 || references.length === 0 ? t('modeGenerate') : t('modeEdit', { count: String(Math.min(references.length, maxEdits)) })}</span>
            <Tooltip label={originalSubmission !== null ? t('originalLocked') : running ? t('runningShort') : t('submit')} side="top" portal>
              <button type="button" className={css.send} aria-label={running ? t('runningShort') : t('submit')}
                disabled={locked || model === null || !isSignedIn || sessionId === undefined || prompt.trim() === ''}
                onClick={() => { void generate() }}>
                {running ? <span className={css.spinner} /> : <IconSendOutlineRegular size={19} />}
              </button>
            </Tooltip>
          </div>
          {advanced && params !== null && <div className={css.parameters} id="image-parameters">
            {params.sizes.length > 0 && <label className={css.field}><span>{t('ratio')}</span><select className={css.select} value={size} disabled={locked}
              onChange={(event) => { actions.patch({ size: event.target.value }) }}>{params.sizes.map(value => <option key={value} value={value}>{value === 'auto' ? t('sizeAuto') : value}</option>)}</select></label>}
            {params.maxCount > 1 && <label className={css.field}><span>{t('count')}</span><select className={css.select} value={count} disabled={locked}
              onChange={(event) => { actions.patch({ count: Number(event.target.value) }) }}>
              {Array.from({ length: params.maxCount }, (_, i) => i + 1).map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>}
            {([
              { key: 'quality', values: params.qualities, value: quality },
              { key: 'background', values: params.backgrounds, value: background },
              { key: 'format', values: params.formats, value: format },
              { key: 'moderation', values: params.moderations, value: moderation },
            ] as const).filter(field => field.values.length > 0).map(field => <label className={css.field} key={field.key}>
              <span>{t(field.key)}</span><select className={css.select} value={field.value} disabled={locked}
                onChange={(event) => { actions.patch({ [field.key]: event.target.value }) }}><option value="">{t('inherit')}</option>
                {field.values.map(value => <option key={value} value={value}>{field.key === 'background' && ['auto', 'transparent', 'opaque'].includes(value) ? t(`bg_${value}`) : value}</option>)}
              </select></label>)}
            {(format === 'jpeg' || format === 'webp') && <label className={css.field}><span>{t('compression', { n: String(compression) })}</span>
              <input type="range" min={0} max={100} value={compression} disabled={locked} onChange={(event) => { actions.patch({ compression: Number(event.target.value) }) }} /></label>}
            {params.seed && <label className={css.field}><span>{t('seed')}</span><input className={css.select} inputMode="numeric" value={seed} placeholder={t('seedHint')} disabled={locked}
              onChange={(event) => { actions.patch({ seed: event.target.value.replace(/[^0-9]/g, '') }) }} /></label>}
            <p className={css.parameterHint}>{maxEdits > 0 ? t('referenceHelp', { n: String(maxEdits) }) : t('badgeNoEdits')}</p>
          </div>}
        </section>
        <div className={css.feedback} aria-live="polite">
          {sessionId === undefined && <p className={css.hint}>{t('sessionRequired')}</p>}
          {stateError && <p className={css.error}>{t('stateFailed')} <button type="button" className={css.textAction} onClick={() => { void refreshState() }}>{t('retry')}</button></p>}
          {(signedIn === false || sessionInvalid) && <p className={css.hint}>{t('signedOut')}</p>}
          {modelsError !== null && <p className={css.error}>{t('modelsFailed', { message: modelsError })} <button type="button" className={css.textAction} onClick={() => { void loadModels() }}>{t('retry')}</button></p>}
          {running && <p className={css.notice}><span className={css.statusDot} />{t('running', { seconds: String(elapsed) })}</p>}
          {ownsReferences && submissionCheck === 'failed' && <p className={css.error}>{t('originalCheckFailed')} <button type="button"
            className={css.textAction} onClick={() => { setSubmissionRevision(value => value + 1) }}>{t('originalCheck')}</button></p>}
          {originalSubmission !== null && <div className={css.notice}>
            <p>{t(originalSubmission.taskId === undefined ? 'originalUnknown' : 'originalAccepted')}</p>
            <details><summary>{t('originalReceipt')}</summary>
              {originalSubmission.planId !== undefined && <p>{t('originalPlanId', { id: originalSubmission.planId })}</p>}
              {originalSubmission.operationId !== undefined && <p>{t('originalOperationId', { id: originalSubmission.operationId })}</p>}
              {originalSubmission.taskId !== undefined && <p>{t('originalTaskId', { id: originalSubmission.taskId })}</p>}
              {originalSubmission.requestId !== undefined && <p>{t('originalRequestId', { id: originalSubmission.requestId })}</p>}
            </details>
            {originalSubmission.canQuery && <button type="button" className={css.textAction} disabled={queryingOriginal}
              onClick={() => { void queryOriginal() }}>{t(queryingOriginal ? 'originalQuerying' : 'originalQuery')}</button>}
          </div>}
          {failure !== null && <p className={css.error} role="alert">{failure}</p>}
          {message !== null && <p className={css.notice}>{message}</p>}
        </div>

        <section className={css.templates} aria-label={t('templatesTitle')}>
          <header className={css.sectionHead}><h2>{text(content?.title) || t('templatesTitle')}</h2><span className={css.hint}>{text(content?.description) || t('templatesHint')}</span></header>
          {publication.status === 'loading' && <p role="status" className={css.hint}>{t('contentLoading')}</p>}
          {publication.status === 'error' && <p role="alert" className={css.error}>{t('contentFailed')} <button type="button" className={css.textAction} onClick={props.refreshContent}>{t('retry')}</button></p>}
          <div className={css.templateToolbar}>
            <div className={css.categories} role="group" aria-label={t('categories')}>
              <button type="button" aria-pressed={selectedCategory === 'all'} className={css.category} onClick={() => { setCategory('all') }}>{t('category_all')}</button>
              {contentCategories.map(item => <button key={item.id} type="button" aria-pressed={selectedCategory === item.id} className={css.category}
                onClick={() => { setCategory(item.id) }}>{text(item.label)}</button>)}
            </div>
            <label className={css.search}><IconSearchOutlineRegular size={14} /><input type="search" aria-label={t('searchTemplates')} placeholder={t('searchTemplates')}
              value={search} onChange={(event) => { setSearch(event.target.value) }} /></label>
          </div>
          <ul className={css.templateGrid}>
            {visibleTemplates.map(template => <li key={template.id}><button type="button" className={css.templateCard} disabled={locked} onClick={() => { applyTemplate(text(template.prompt)) }}>
              {template.coverAssetId !== null && <img className={css.templateCover} src={`/credits/api/creation/assets/${encodeURIComponent(template.coverAssetId)}`} alt="" loading="lazy" />}
              <span className={css.templateCopy}><span className={css.templateName}>{text(template.title)}</span>
                <span className={css.templateHint}>{text(template.description)}</span></span>
            </button></li>)}
          </ul>
          {publication.status === 'ready' && contentTemplates.length === 0 && <p className={css.empty}>{t('contentEmpty')}</p>}
          {publication.status === 'ready' && contentTemplates.length > 0 && visibleTemplates.length === 0 && <p className={css.empty}>
            {t('noTemplates')} <button type="button" className={css.textAction} onClick={() => { setSearch(''); setCategory('all') }}>{t('resetFilters')}</button></p>}
          {contentPresets.length > 0 && <div className={css.styles} role="group" aria-label={t('styles')}><span className={css.hint}>{t('styles')}</span>{contentPresets.map(preset => <button key={preset.id} type="button" disabled={locked} className={css.styleChip}
            onClick={() => { const suffix = text(preset.promptSuffix); actions.patch({ prompt: prompt.includes(suffix) ? prompt : `${prompt}${suffix}` }); promptField.current?.focus() }}>{text(preset.label)}</button>)}</div>}
        </section>

        <section className={css.works} aria-label={t('history')}>
          <header className={css.sectionHead}><h2>{t('history')}</h2><button type="button" className={css.textAction} onClick={() => { void loadHistory() }}>{t('refreshWorks')}</button></header>
          {historyError && <p className={css.error}>{t('historyFailed')}</p>}
          {works.length === 0 ? <div className={css.emptyWorks}><IconSparkleRegular size={24} /><p>{t('historyEmpty')}</p><span>{t('historyEmptyHint')}</span></div> :
            <ul className={css.worksGrid}>{works.map(item => <li key={fileIdentity(item)} className={css.workCard}>
              <button type="button" className={css.workImage} aria-label={t('previewNamed', { name: item.name })} onClick={() => { setPreview(item) }}>
                <img src={rawUrl(item)} alt={item.name} loading="lazy" />
              </button>
              <div className={css.workMeta}><span className={css.workName}>{item.name}</span><div className={css.workActions}>
                <a className={css.textAction} href={rawUrl(item)} download={item.name}>{t('download')}</a>
                <button type="button" className={css.textAction} disabled={!canUpload} onClick={() => { void addReferences(item) }}>{t('useAsReference')}</button>
              </div></div>
            </li>)}</ul>}
        </section>
      </div>
      {preview !== null && <ImageLightbox src={rawUrl(preview)} alt={preview.name} labels={{ dialog: t('preview'), close: t('closePreview') }} onClose={() => { setPreview(null) }} />}
    </div>
  )
}
