/** Image creation workspace driven by the deployment's existing media catalog. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconCloseOutlineRegular,
  IconPlusOutlineRegular, IconSearchOutlineRegular, IconSendOutlineRegular,
  IconSettingsOutlineRegular, IconSparkleRegular, ImageLightbox, SegmentedTabs, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRenderFactories, PropsRuntime, PropsStore, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-prompt-assist/client'
import type { Context } from '@deepseek-ai/cordis'
import type { LocalizedText } from '@deepseek-ai/dsh-client-creation-content/client'
import type { createImageDraftStore, ImageDraft } from './draft-store.ts'
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
  if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
  return await response.json() as Envelope<T>
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
    references, uploading, generationStartedAt, sessionInvalid, message, failure, resultPaths: result,
  } = draft
  const running = generationStartedAt !== null
  const locked = running || uploading || draft.promptAssisting
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
    actions.patch({ references: [] })
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
    const limit = 6
    const slots = Math.max(0, limit - current.references.length)
    if (slots === 0) { setFailure(t('referenceLimit', { n: String(limit) })); return }
    actions.patch({ uploading: true, failure: null })
    try {
      let files: readonly File[]
      if ('path' in source) {
        const response = await fetch(rawUrl(source))
        if (!isCurrent()) return
        if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
        const blob = await response.blob()
        if (!isCurrent()) return
        files = [new File([blob], source.path.split(/[\\/]/).pop() ?? 'image.png', { type: blob.type || 'image/png' })]
      } else files = source
      if (files.length > slots) setMessage(t('referenceLimit', { n: String(limit) }))
      for (const file of files.slice(0, slots)) {
        if (!isCurrent()) return
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
          setFailure(t('uploadFailed', { message: t('unsupportedType') })); continue
        }
        if (file.size === 0 || file.size > 6 * 1024 * 1024) {
          setFailure(t('uploadFailed', { message: t('fileSizeLimit') })); continue
        }
        const beforeUpload = readDraft()
        if (beforeUpload.references.length >= limit) break
        if (beforeUpload.references.reduce((sum, item) => sum + item.bytes, 0) + file.size > 12 * 1024 * 1024) {
          setFailure(t('referenceTotalLimit')); break
        }
        const response = await fetch('/credits/api/assets', {
          method: 'POST',
          headers: {
            'content-type': file.type, 'x-file-name': encodeURIComponent(file.name),
            'x-idempotency-key': `dsh-asset-${globalThis.crypto.randomUUID()}`, accept: 'application/json',
          },
          body: file,
        })
        if (!isCurrent()) return
        if (!response.ok) throw new Error(`HTTP_${String(response.status)}`)
        const answer = await response.json() as Envelope<never> & { asset?: { assetId: string | null } | null }
        if (!isCurrent()) return
        if (answer.sessionInvalid === true) { acceptAccount({ signedIn: false }); actions.patch({ sessionInvalid: true, failure: t('noAuth') }); break }
        const assetId = answer.asset?.assetId
        if (!answer.ok || assetId === null || assetId === undefined) {
          setFailure(t('uploadFailed', { message: answer.message ?? answer.code ?? t('unknown') })); continue
        }
        const latest = readDraft()
        if (latest.references.length >= limit) break
        actions.appendReference({ assetId, name: file.name, url: createReferencePreview(file), bytes: file.size })
      }
    } catch (_error) {
      if (isCurrent()) setFailure(t('uploadFailed', { message: t('connectionFailure') }))
    } finally {
      if (isCurrent()) actions.patch({ uploading: false })
    }
  }, [acceptAccount, accountIdentity, actions, createReferencePreview, models, readDraft, setFailure, setMessage, signedIn, t])

  const generate = useCallback(async (): Promise<void> => {
    const current = readDraft()
    if (current.uploading || current.generationStartedAt !== null || current.promptAssisting || current.sessionInvalid || signedIn !== true
      || accountIdentity === null || current.referenceAccountId !== accountIdentity) return
    if (sessionId === undefined) { setFailure(t('sessionRequired')); return }
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
      if (!answer.ok || answer.payload === undefined) {
        setFailure(answer.code === 'INSUFFICIENT_POINTS' ? t('insufficient') : t('failed', { message: answer.message ?? answer.code ?? t('unknown') }))
        return
      }
      actions.patch({ resultPaths: answer.payload.paths ?? [answer.payload.path], message: t('done') })
      await Promise.all([loadBalance(), loadHistory()])
    } catch (_error) {
      // A disconnected request may have completed upstream; never retry it automatically.
      if (readDraft().referenceEpoch === current.referenceEpoch) setFailure(t('generationConnectionLost'))
      void loadHistory()
    } finally {
      actions.patch({ generationStartedAt: null })
    }
  }, [acceptAccount, accountIdentity, actions, loadBalance, loadHistory, models, readDraft, setFailure, sessionId, signedIn, t])

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
              <input ref={fileField} type="file" aria-label={t('addReference')} accept="image/png,image/jpeg,image/webp" multiple hidden
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
            <Tooltip label={running ? t('runningShort') : t('submit')} side="top" portal>
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
