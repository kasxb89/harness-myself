/** Schema-owned media creation and processing, with receipt-first browser recovery. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { appPath } from './app-path.ts'
import { VideoPlayer } from './VideoPlayer.tsx'
import { mediaV2En, mediaV2Zh, type MediaV2Labels } from './media-v2-locales.ts'
import { mediaV2AssetLimit, mediaV2Available, mediaV2Choices, mediaV2Defaults, mediaV2Fields, mediaV2FormIssues, type MediaV2SelectedAsset } from './media-v2-form.ts'
import { isMediaV2Value, mediaV2Data, mediaV2Object, mediaV2QuoteBatchValid, mediaV2TaskComplete, readMediaV2Batch, readMediaV2Quantity,
  readMediaV2SpecificationPricing, parseMediaV2Asset, parseMediaV2Catalog, parseMediaV2Record,
  type MediaV2Kind, type MediaV2Intent, type MediaV2Model, type MediaV2Record, type MediaV2Request, type MediaV2Transport, type MediaV2Value } from './media-v2-types.ts'
import css from './MediaV2Composer.module.css'

/** The carrier supplies identity only; all relay credentials stay inside the Host. */
export interface MediaV2ComposerProps {
  readonly kind: MediaV2Kind
  readonly accountKey: string | null
  readonly language?: 'zh' | 'en'
  readonly onExit: () => void
  readonly transport?: MediaV2Transport
}
interface SavedArtifact { readonly key: string; readonly path: string }
interface ViewRecord { readonly record: MediaV2Record; readonly saved: readonly SavedArtifact[] }
const PREFIX = '/credits/api/media-v2'
const defaultTransport: MediaV2Transport = async (path, init) => {
  const headers = new Headers(init?.headers)
  headers.set('accept', 'application/json')
  const response = await fetch(appPath(path), { ...init, headers })
  const value: unknown = await response.json()
  return value
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const recordView = (value: unknown): ViewRecord => {
  const record = parseMediaV2Record(value), data = mediaV2Object(value)
  const saved = Array.isArray(data?.saved) ? data.saved.flatMap((item) => {
    const entry = mediaV2Object(item)
    return typeof entry?.key === 'string' && typeof entry.path === 'string' ? [{ key: entry.key, path: entry.path }] : []
  }) : []
  return { record, saved }
}
function fieldName(model: MediaV2Model, name: string, language: 'zh' | 'en', labels: MediaV2Labels): string {
  const native = mediaV2Fields(model).find(field => field.name === name)?.native
  const label = mediaV2Object(native?.label)
  return typeof label?.[language] === 'string' ? label[language] : typeof label?.zh === 'string' ? label.zh : name === 'prompt' ? labels.prompt : name.replaceAll('_', ' ')
}
function draftKey(kind: MediaV2Kind, accountKey: string): string { return `dsh:media-v2:draft-v1:${kind}:${accountKey}` }
function restoreAssets(value: unknown): MediaV2SelectedAsset[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = mediaV2Object(entry)
    if (typeof row?.clientId !== 'string' || typeof row.model !== 'string' || typeof row.field !== 'string' || typeof row.name !== 'string') return []
    let asset: ReturnType<typeof parseMediaV2Asset> | undefined
    try { if (row.asset !== undefined) asset = parseMediaV2Asset(row.asset) }
    catch { /* An unreadable receipt retains its original queryable ID. */ }
    return [{ clientId: row.clientId, model: row.model, field: row.field, name: row.name,
      role: row.role === 'writing' ? 'writing' as const : 'generation' as const, state: asset === undefined ? 'unknown' as const : 'ready' as const,
      ...asset === undefined ? {} : { asset } }]
  })
}

/** Advanced controls retain complete JSON while ordinary native controls remain compact. */
function JsonParameter({ label, value, disabled, invalid, onChange, onValidity }: {
  readonly label: string
  readonly value: MediaV2Value | undefined
  readonly disabled: boolean
  readonly invalid: string
  readonly onChange: (value: MediaV2Value | undefined) => void
  readonly onValidity: (valid: boolean) => void
}): ReactNode {
  const canonical = value === undefined ? '' : JSON.stringify(value, null, 2)
  const [draft, setDraft] = useState(canonical), [valid, setValid] = useState(true)
  const committed = useRef(canonical)
  useEffect(() => {
    if (canonical !== committed.current) { committed.current = canonical; setDraft(canonical); setValid(true); onValidity(true) }
  }, [canonical, onValidity])
  return <><label>{label}<textarea className={css.json} value={draft} disabled={disabled} rows={5} aria-invalid={!valid}
    onChange={(event) => {
      const text = event.target.value
      setDraft(text)
      let parsed: MediaV2Value | undefined
      try {
        const candidate: unknown = text.trim() === '' ? undefined : JSON.parse(text)
        if (candidate !== undefined && !isMediaV2Value(candidate)) throw new Error('MEDIA_V2_JSON_INVALID')
        parsed = candidate
      } catch { setValid(false); onValidity(false); return }
      committed.current = parsed === undefined ? '' : JSON.stringify(parsed, null, 2)
      setValid(true); onValidity(true); onChange(parsed)
    }} /></label>{!valid && <p className={css.error}>{invalid}</p>}</>
}
/**
 * Offer only declared controls and retain original operation and upload IDs before I/O.
 * @param props - Current signed-in account, media kind and carrier-local transport.
 * @returns One composer in the existing creation workspace, never a new sidebar entry.
 */
export function MediaV2Composer({ kind, accountKey, language = 'zh', onExit, transport = defaultTransport }: MediaV2ComposerProps): ReactNode {
  const labels = language === 'en' ? mediaV2En : mediaV2Zh
  const [models, setModels] = useState<readonly MediaV2Model[]>([])
  const [modelId, setModelId] = useState('')
  const [intent, setIntent] = useState<MediaV2Intent>('text')
  const [parameters, setParameters] = useState<Record<string, MediaV2Value>>({})
  const [assets, setAssets] = useState<readonly MediaV2SelectedAsset[]>([])
  const [records, setRecords] = useState<readonly ViewRecord[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [originalIds, setOriginalIds] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(true)
  const [configurationRequote, setConfigurationRequote] = useState(false)
  const [explicitRequote, setExplicitRequote] = useState(false)
  const [nativeVideoBatch, setNativeVideoBatch] = useState(false)
  const [pollAfterMs, setPollAfterMs] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now() / 1000)
  const [invalidJson, setInvalidJson] = useState<Readonly<Record<string, boolean>>>({})
  const [uploadLimit, setUploadLimit] = useState(50 * 1024 * 1024)
  const epoch = useRef(0), inFlight = useRef(false)
  const model = models.find(item => item.id === modelId) ?? null
  const current = records.find(item => item.record.request.client_operation_id === currentId)
  const missingOriginalIds = [...new Set([...originalIds, ...currentId === null ? [] : [currentId]])]
    .filter(id => !records.some(item => item.record.request.client_operation_id === id))
  const quotedVersion = current?.record.quote?.model_version ?? current?.record.request.model_version
  const configurationChanged = current?.record.state === 'quoted' && model !== null
    && current.record.request.model === model.id && quotedVersion !== model.model_version
  const configurationRequoteAllowed = configurationRequote || explicitRequote
  const originalUnsettled = currentId !== null && (current === undefined || current.record.state !== 'quoted')
  const locked = busy || originalUnsettled
  const issues = useMemo(() => model === null ? [] : [...mediaV2FormIssues(model, intent, parameters, assets, now, nativeVideoBatch),
    ...Object.keys(invalidJson).filter(name => invalidJson[name]).map(field => ({ field, reason: 'invalid' as const }))],
  [model, intent, parameters, assets, now, invalidJson, nativeVideoBatch])
  const indicativePricing = model === null ? undefined : readMediaV2SpecificationPricing(model.pricing)
  const priceParameters = Object.entries(parameters).filter(([name]) => name !== 'prompt' && name !== 'negative_prompt')
  const indicativePrice = assets.some(item => item.role === 'generation') ? undefined : indicativePricing?.specification_rows?.find(row =>
    Object.keys(row.parameters).length === priceParameters.length
      && priceParameters.every(([name, value]) => row.parameters[name] === value))
  const fields = model === null ? [] : mediaV2Fields(model)
  const replaceRecord = useCallback((value: ViewRecord): void => {
    const id = value.record.request.client_operation_id
    setRecords((previous) => {
      const retained = previous.filter(item => item.record.request.client_operation_id !== id)
      return value.record.task === undefined || value.record.task.kind === kind ? [...retained, value] : retained
    })
  }, [kind])
  const persist = useCallback((value: {
    modelId: string
    intent: MediaV2Intent
    parameters: Readonly<Record<string, MediaV2Value>>
    assets: readonly MediaV2SelectedAsset[]
    currentId: string | null
    originalIds: readonly string[]
  }): void => {
    if (accountKey !== null) sessionStorage.setItem(draftKey(kind, accountKey), JSON.stringify(value))
  }, [accountKey, kind])
  const saveDraft = useCallback((patch: {
    modelId?: string
    intent?: MediaV2Intent
    parameters?: Record<string, MediaV2Value>
    assets?: readonly MediaV2SelectedAsset[]
    currentId?: string | null
    originalIds?: readonly string[]
  }): void => {
    persist({ modelId: patch.modelId ?? modelId, intent: patch.intent ?? intent, parameters: patch.parameters ?? parameters,
      assets: patch.assets ?? assets, currentId: patch.currentId === undefined ? currentId : patch.currentId,
      originalIds: patch.originalIds ?? originalIds })
  }, [persist, modelId, intent, parameters, assets, currentId, originalIds])
  const load = useCallback(async (): Promise<void> => {
    const captured = epoch.current
    if (accountKey === null) { setLoading(false); return }
    setLoading(true)
    try {
      const restored = mediaV2Object(JSON.parse(sessionStorage.getItem(draftKey(kind, accountKey)) ?? 'null'))
      const retained = Array.isArray(restored?.originalIds) ? restored.originalIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
      setOriginalIds([...new Set([...retained, ...typeof restored?.currentId === 'string' ? [restored.currentId] : []])])
      const [catalogAnswer, operationsAnswer] = await Promise.all([transport(`${PREFIX}/models`), transport(`${PREFIX}/operations`)])
      const catalog = parseMediaV2Catalog(mediaV2Data(catalogAnswer)), operations = mediaV2Object(mediaV2Data(operationsAnswer))
      if (!Array.isArray(operations?.operations)) throw new Error('MEDIA_V2_OPERATIONS_INVALID')
      const views = operations.operations.map(recordView).filter((item) => {
        if (item.record.task !== undefined) return item.record.task.kind === kind
        const declared = catalog.models.find(model => model.id === item.record.request.model)
        return declared === undefined || declared.kind === kind
      })
      if (captured !== epoch.current) return
      setPollAfterMs(catalog.poll_after_ms)
      setUploadLimit(catalog.capabilities.max_upload_bytes ?? 50 * 1024 * 1024)
      setConfigurationRequote(catalog.capabilities.same_operation_configuration_requote)
      setExplicitRequote(catalog.capabilities.explicit_requote_v1 === true)
      setNativeVideoBatch(catalog.capabilities.native_video_batch_v1 === true)
      setModels(catalog.models.filter(item => item.kind === kind && item.enabled))
      setRecords(views)
      const selected = catalog.models.find(item => item.kind === kind && item.id === restored?.modelId)
        ?? catalog.models.find(item => item.kind === kind && item.enabled)
      if (selected !== undefined) {
        setModelId(selected.id)
        const savedValues = mediaV2Object(restored?.parameters)
        const values: Record<string, MediaV2Value> = mediaV2Defaults(selected)
        if (savedValues !== null) for (const [key, value] of Object.entries(savedValues)) {
          if (isMediaV2Value(value)) values[key] = value
        }
        setParameters(values)
        setIntent(restored?.intent === 'reference' || restored?.intent === 'frames' || restored?.intent === 'transform' ? restored.intent : 'text')
        setAssets(restoreAssets(restored?.assets))
        setCurrentId(typeof restored?.currentId === 'string' ? restored.currentId : null)
      }
      setError(null)
    } catch { if (captured === epoch.current) setError(labels.requestFailure) }
    finally { if (captured === epoch.current) setLoading(false) }
  }, [accountKey, kind, labels.requestFailure, transport])
  useEffect(() => {
    epoch.current += 1
    setModels([]); setRecords([]); setAssets([]); setCurrentId(null); setOriginalIds([]); setModelId(''); setParameters({}); setPollAfterMs(undefined)
    setBusy(false); setConfigurationRequote(false); setExplicitRequote(false); setNativeVideoBatch(false); setInvalidJson({})
    void load()
    return () => { epoch.current += 1 }
  }, [load])
  useEffect(() => {
    if (current?.record.quote === undefined) return undefined
    const timer = setInterval(() => { setNow(Date.now() / 1000) }, 1000)
    return () => { clearInterval(timer) }
  }, [current?.record.quote])
  const update = (name: string, value: MediaV2Value | undefined): void => {
    if (locked) return
    const next = value === undefined ? Object.fromEntries(Object.entries(parameters).filter(([key]) => key !== name))
      : { ...parameters, [name]: value }
    saveDraft({ parameters: next, currentId: null }); setParameters(next); setCurrentId(null); setError(null)
  }
  const changeAssets = (next: readonly MediaV2SelectedAsset[]): void => {
    saveDraft({ assets: next, currentId: null }); setAssets(next); setCurrentId(null); setError(null)
  }
  const recoverAsset = async (selected: MediaV2SelectedAsset): Promise<void> => {
    if (inFlight.current) return
    const captured = epoch.current
    inFlight.current = true; setBusy(true)
    try {
      const asset = parseMediaV2Asset(mediaV2Data(await transport(`${PREFIX}/assets/by-client-id/${encodeURIComponent(selected.clientId)}?model=${encodeURIComponent(selected.model)}`)))
      if (captured !== epoch.current || asset.client_asset_id !== selected.clientId || asset.model !== selected.model) return
      const next = assets.map(item => item.clientId === selected.clientId ? { ...item, state: 'ready' as const, asset } : item)
      changeAssets(next)
    } catch { if (captured === epoch.current) setError(labels.unknownAsset) }
    finally { inFlight.current = false; if (captured === epoch.current) setBusy(false) }
  }
  const upload = async (field: string, files: readonly File[]): Promise<void> => {
    if (model === null || locked || inFlight.current || files.length === 0) return
    const captured = epoch.current, selectedModel = model
    const role = model.asset_fields.find(item => item.name === field)
    if (role === undefined) return
    const constraints = { ...fields.find(item => item.name === field)?.native, ...role.constraints }
    const byteLimit = typeof constraints.max_bytes === 'number' ? Math.min(uploadLimit, constraints.max_bytes) : uploadLimit
    if (files.some(file => file.size <= 0 || file.size > byteLimit || !role.mime_types.includes(file.type))
      || assets.filter(item => item.field === field && item.role === 'generation').length + files.length > mediaV2AssetLimit(role.max_items, constraints, parameters)) {
      setError(labels.limit); return
    }
    let selectedAssets = assets
    inFlight.current = true; setBusy(true)
    try {
      for (const file of files) {
        if (captured !== epoch.current) return
        const clientId = randomUUID()
        const pending: MediaV2SelectedAsset = { clientId, model: selectedModel.id, field, name: file.name, role: 'generation', state: 'uploading' }
        selectedAssets = [...selectedAssets, pending]
        // Commit the original key before starting a request. A failed response never triggers a repeated POST.
        saveDraft({ assets: selectedAssets, currentId: null }); setAssets(selectedAssets); setCurrentId(null)
        try {
          const asset = parseMediaV2Asset(mediaV2Data(await transport(`${PREFIX}/assets?model=${encodeURIComponent(selectedModel.id)}&client_asset_id=${encodeURIComponent(clientId)}&field=${encodeURIComponent(field)}`, {
            method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
          })))
          if (captured !== epoch.current) return
          if (asset.client_asset_id !== clientId || asset.model !== selectedModel.id) throw new Error('MEDIA_V2_ASSET_INVALID')
          selectedAssets = selectedAssets.map(item => item.clientId === clientId ? { ...item, state: 'ready' as const, asset } : item)
        } catch {
          selectedAssets = selectedAssets.map(item => item.clientId === clientId ? { ...item, state: 'unknown' as const } : item)
          if (captured === epoch.current) setError(labels.uploadFailed)
        }
        if (captured !== epoch.current) return
        saveDraft({ assets: selectedAssets, currentId: null }); setAssets(selectedAssets)
      }
    } catch { if (captured === epoch.current) setError(labels.requestFailure) }
    finally { inFlight.current = false; if (captured === epoch.current) setBusy(false) }
  }
  const quote = async (): Promise<void> => {
    if (model === null || locked || inFlight.current || issues.length > 0 || configurationChanged && !configurationRequoteAllowed) return
    const clientId = current?.record.state === 'quoted' ? current.record.request.client_operation_id : randomUUID()
    const captured = epoch.current
    const bindings: Record<string, string[]> = {}
    for (const selected of assets.filter(item => item.role === 'generation')) {
      if (selected.asset !== undefined) (bindings[selected.field] ??= []).push(selected.asset.asset_id)
    }
    const request: MediaV2Request = configurationChanged
      ? { ...current.record.request, model_version: model.model_version }
      : { client_operation_id: clientId, model: model.id, model_version: model.model_version,
        intent, parameters: { ...parameters }, assets: bindings }
    inFlight.current = true; setBusy(true); setError(null)
    try {
      saveDraft({ currentId: clientId }); setCurrentId(clientId)
      const init = post(request)
      if (explicitRequote && current?.record.state === 'quoted') {
        init.headers = { 'content-type': 'application/json', 'X-Yunshu-Media-Requote': '1' }
      }
      const view = recordView(mediaV2Data(await transport(`${PREFIX}/quotes`, init)))
      if (view.record.request.client_operation_id !== clientId) throw new Error('MEDIA_V2_RECORD_INVALID')
      if (captured === epoch.current) {
        replaceRecord(view)
        if (view.record.state === 'quote-rejected') setError(view.record.quote_failure?.message ?? labels.quoteRejected)
      }
    } catch {
      if (captured === epoch.current) {
        try {
          // A free-quote refusal is editable only when the Host confirms its original record.
          const view = recordView(mediaV2Data(await transport(`${PREFIX}/operations/${encodeURIComponent(clientId)}`)))
          if (view.record.request.client_operation_id !== clientId) throw new Error('MEDIA_V2_RECORD_INVALID')
          if (captured === epoch.current) {
            replaceRecord(view)
            setError(view.record.state === 'quote-rejected' ? view.record.quote_failure?.message ?? labels.quoteRejected
              : view.record.state === 'quoted' || view.record.state === 'accepted' ? null : labels.unknown)
          }
        } catch {
          if (captured === epoch.current) {
            if (current !== undefined) replaceRecord({ ...current, record: { ...current.record, state: 'unknown' } })
            setError(labels.unknown)
          }
        }
      }
    }
    finally { inFlight.current = false; if (captured === epoch.current) setBusy(false) }
  }
  const recover = useCallback(async (id: string, signal?: AbortSignal): Promise<void> => {
    if (inFlight.current) return
    const captured = epoch.current
    inFlight.current = true; setBusy(true)
    try {
      const view = recordView(mediaV2Data(await transport(`${PREFIX}/operations/${encodeURIComponent(id)}`, signal === undefined ? undefined : { signal })))
      if (view.record.request.client_operation_id !== id) throw new Error('MEDIA_V2_RECORD_INVALID')
      if (captured === epoch.current) { replaceRecord(view); setError(null) }
    } catch { if (captured === epoch.current && signal?.aborted !== true) setError(labels.unknown) }
    finally { inFlight.current = false; if (captured === epoch.current) setBusy(false) }
  }, [labels.unknown, replaceRecord, transport])
  const pollingIds = records.filter(item => ['submitting', 'accepted', 'unknown'].includes(item.record.state)
    && (item.record.task?.is_final !== true || item.record.task.status === 'succeeded' && !mediaV2TaskComplete(item.record))).map(item => item.record.request.client_operation_id).sort().join('\n')
  useEffect(() => {
    if (pollAfterMs === undefined || pollingIds === '' || accountKey === null) return undefined
    const controller = new AbortController(), captured = epoch.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopped = (): boolean => controller.signal.aborted || captured !== epoch.current
    const tick = async (): Promise<void> => {
      if (stopped()) return
      for (const id of pollingIds.split('\n')) {
        if (stopped()) return
        if (!inFlight.current) await recover(id, controller.signal)
      }
      if (!stopped()) {
        timer = setTimeout(() => { void tick() }, pollAfterMs)
      }
    }
    timer = setTimeout(() => { void tick() }, pollAfterMs)
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [accountKey, pollAfterMs, pollingIds, recover])
  const submit = async (): Promise<void> => {
    if (current?.record.state !== 'quoted' || current.record.quote === undefined || current.record.quote.expires_at <= Date.now() / 1000 || inFlight.current || issues.length > 0
      || configurationChanged || !mediaV2QuoteBatchValid(current.record, kind)) return
    const id = current.record.request.client_operation_id, captured = epoch.current
    inFlight.current = true; setBusy(true)
    // Lock this original operation before waiting for an HTTP response.
    replaceRecord({ ...current, record: { ...current.record, state: 'submitting' } })
    try {
      const view = recordView(mediaV2Data(await transport(`${PREFIX}/tasks`, post({ client_operation_id: id }))))
      if (view.record.request.client_operation_id !== id) throw new Error('MEDIA_V2_RECORD_INVALID')
      if (captured === epoch.current) replaceRecord(view)
    } catch { if (captured === epoch.current) { replaceRecord({ ...current, record: { ...current.record, state: 'unknown' } }); setError(labels.unknown) } }
    finally { inFlight.current = false; if (captured === epoch.current) setBusy(false) }
  }
  const save = async (view: ViewRecord): Promise<void> => {
    if (inFlight.current || (view.record.quote?.batch !== undefined || view.record.task?.batch !== undefined)
      && !mediaV2TaskComplete(view.record)) return
    const captured = epoch.current
    inFlight.current = true; setBusy(true)
    try {
      const answer = recordView(mediaV2Data(await transport(`${PREFIX}/save`, post({ client_operation_id: view.record.request.client_operation_id }))))
      if (captured === epoch.current) replaceRecord(answer)
    } catch { if (captured === epoch.current) setError(labels.requestFailure) }
    finally { inFlight.current = false; if (captured === epoch.current) setBusy(false) }
  }
  const issueText = (reason: ReturnType<typeof mediaV2FormIssues>[number]['reason']): string => reason === 'intent' ? labels.intentError : reason === 'unknown' ? labels.unknownAsset : labels[reason]
  const moveAsset = (selected: MediaV2SelectedAsset, direction: -1 | 1): void => {
    if (locked) return
    const group = assets.filter(item => item.field === selected.field)
    const index = group.findIndex(item => item.clientId === selected.clientId), other = group[index + direction]
    if (other === undefined) return
    const next = [...assets], first = next.indexOf(selected), second = next.indexOf(other)
    next[first] = other; next[second] = selected
    changeAssets(next)
  }
  const renderAsset = (selected: MediaV2SelectedAsset): ReactNode => <li key={selected.clientId} className={css.asset}>
    <span className={css.assetName}>{selected.name}</span>
    <span className={css.hint}>{selected.asset === undefined ? labels.unknownAsset : `${(selected.asset.bytes / 1024 / 1024).toFixed(2)} MB${selected.asset.duration_seconds === undefined ? '' : ` · ${selected.asset.duration_seconds}s`}`}</span>
    <select aria-label={`${selected.name}: ${labels.intent}`} value={selected.role} disabled={locked} onChange={(event) => { changeAssets(assets.map(item => item.clientId === selected.clientId ? { ...item, role: event.target.value === 'writing' ? 'writing' : 'generation' } : item)) }}>
      <option value="generation">{labels.generation}</option><option value="writing">{labels.writing}</option>
    </select>
    {assets.filter(item => item.field === selected.field).length > 1 && <span className={css.order}>
      <button type="button" disabled={locked || assets.find(item => item.field === selected.field)?.clientId === selected.clientId} aria-label={`${labels.moveUp}: ${selected.name}`} onClick={() => { moveAsset(selected, -1) }}>↑</button>
      <button type="button" disabled={locked || assets.filter(item => item.field === selected.field).at(-1)?.clientId === selected.clientId} aria-label={`${labels.moveDown}: ${selected.name}`} onClick={() => { moveAsset(selected, 1) }}>↓</button>
    </span>}
    {selected.state !== 'ready' && <button type="button" disabled={busy} onClick={() => { void recoverAsset(selected) }}>{labels.recoverAsset}</button>}
    <button type="button" disabled={locked} aria-label={`${labels.remove}: ${selected.name}`} onClick={() => { changeAssets(assets.filter(item => item.clientId !== selected.clientId)) }}>{labels.remove}</button>
  </li>
  return <section className={css.composer} aria-label={labels.title}>
    <header className={css.header}><div><h2>{labels.title}</h2><p className={css.hint}>{labels.retainedHint}</p></div><button type="button" onClick={onExit}>{labels.back}</button></header>
    {loading ? <p role="status">{labels.loading}</p> : model === null ? <p>{labels.noModels}</p> : <>
      <div className={css.selectors}>
        <label>{labels.model}<select value={model.id} disabled={locked} onChange={(event) => {
          const next = models.find(item => item.id === event.target.value)
          if (next === undefined) return
          const defaults = mediaV2Defaults(next)
          saveDraft({ modelId: next.id, parameters: defaults, currentId: null })
          setModelId(next.id); setParameters(defaults); setCurrentId(null); setError(null); setInvalidJson({})
        }}>{models.map(item => <option key={item.id} value={item.id}>{item.display_name}{item.pricing.display === '' ? '' : ` · ${item.pricing.display}`}</option>)}</select></label>
        <label>{labels.intent}<select value={intent} disabled={locked} onChange={(event) => {
          const next = event.target.value
          if (next !== 'text' && next !== 'reference' && next !== 'frames' && next !== 'transform') return
          saveDraft({ intent: next, currentId: null }); setIntent(next); setCurrentId(null); setError(null)
        }}>{!model.intents.some(item => item.id === intent) && <option value={intent}>{labels[intent === 'text' ? 'intentText' : intent === 'reference' ? 'intentReference' : intent === 'frames' ? 'intentFrames' : 'intentTransform']}</option>}{model.intents.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      </div>
      {model.description !== undefined && <p className={css.hint}>{model.description}</p>}
      <div className={css.fields}>{fields.filter(field => !model.asset_fields.some(asset => asset.name === field.name)).map((field) => {
        const value = parameters[field.name], choices = mediaV2Choices(field, parameters, model, assets, now)
        const available = mediaV2Available(field.native.available_when, parameters)
        const quantityMaximum = model.kind === 'video' && field.name === 'count'
          ? nativeVideoBatch ? readMediaV2Quantity(model.quantity)?.maximum ?? 1 : 1 : undefined
        const label = fieldName(model, field.name, language, labels), fieldIssues = issues.filter(issue => issue.field === field.name)
        const multiple = field.schema.type === 'array' || field.native.type === 'multi_enum'
        return <div key={field.name} className={`${css.field} ${field.name === 'prompt' ? css.wide : ''}`}>
          {field.schema.type === 'boolean' && choices.length === 0 ? <label className={css.boolean}><input type="checkbox" checked={value === true} disabled={locked || !available} onChange={(event) => { update(field.name, event.target.checked) }} />{label}</label>
            : choices.length > 0 ? multiple ? <fieldset disabled={locked || !available}><legend>{label}</legend><div className={css.choices}>{choices.map(choice => <label key={`${typeof choice.value}:${String(choice.value)}`}><input type="checkbox" checked={Array.isArray(value) && value.includes(choice.value)} disabled={!choice.available} onChange={(event) => {
              const selected = Array.isArray(value) ? value.filter(isMediaV2Value) : []
              update(field.name, event.target.checked ? [...selected, choice.value] : selected.filter(item => item !== choice.value))
            }} />{choice.label}</label>)}</div></fieldset>
              : <label>{label}<select value={typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''} disabled={locked || !available} onChange={(event) => { update(field.name, event.target.value === '' ? undefined : choices.find(choice => String(choice.value) === event.target.value)?.value) }}><option value="">{labels.empty}</option>{choices.map(choice => <option key={`${typeof choice.value}:${String(choice.value)}`} value={String(choice.value)} disabled={!choice.available || quantityMaximum !== undefined && typeof choice.value === 'number' && choice.value > quantityMaximum}>{choice.label}</option>)}</select></label>
              : field.schema.type === 'object' || field.schema.type === 'array' || field.schema.properties !== undefined ? <JsonParameter label={label} value={value} disabled={locked || !available} invalid={labels.invalidJson}
                onChange={(next) => { update(field.name, next) }} onValidity={(valid) => {
                  setInvalidJson(previous => previous[field.name] === !valid ? previous : { ...previous, [field.name]: !valid })
                }} />
                : field.name === 'prompt' || field.native.ui_widget === 'textarea' ? <label>{label}<textarea value={typeof value === 'string' ? value : ''} rows={4} disabled={locked || !available} onChange={(event) => { update(field.name, event.target.value) }} /></label>
                  : <label>{label}<input type={field.schema.type === 'number' || field.schema.type === 'integer' ? 'number' : 'text'} value={typeof value === 'number' || typeof value === 'string' ? value : ''}
                    min={typeof field.schema.minimum === 'number' ? field.schema.minimum : undefined} max={quantityMaximum === undefined ? typeof field.schema.maximum === 'number' ? field.schema.maximum : undefined : Math.min(typeof field.schema.maximum === 'number' ? field.schema.maximum : quantityMaximum, quantityMaximum)} step={field.schema.type === 'integer' ? 1 : 'any'}
                    disabled={locked || !available} onChange={(event) => { update(field.name, event.target.value === '' ? undefined : field.schema.type === 'integer' || field.schema.type === 'number' ? Number(event.target.value) : event.target.value) }} /></label>}
          {typeof field.schema.description === 'string' && <p className={css.hint}>{field.schema.description}</p>}
          {fieldIssues.map((issue, index) => <p key={index} className={css.error}>{issueText(issue.reason)}</p>)}
          {value !== undefined && (!available || fieldIssues.length > 0) && <button type="button" disabled={locked} onClick={() => { update(field.name, undefined) }}>{labels.clear}</button>}
        </div>
      })}</div>
      {Object.keys(parameters).filter(name => !fields.some(field => field.name === name) || model.asset_fields.some(field => field.name === name)).map(name => <div key={name} className={css.field}><span>{name}</span><p className={css.error}>{labels.unavailable}</p><button type="button" disabled={locked} onClick={() => { update(name, undefined) }}>{labels.clear}</button></div>)}
      <div className={css.materials}>{model.asset_fields.map(field => <section key={field.name} className={css.materialField}>
        <div className={css.row}><h3>{fieldName(model, field.name, language, labels)}</h3><label className={css.upload}>{labels.add}<input type="file" aria-label={`${labels.add}: ${fieldName(model, field.name, language, labels)}`} accept={field.mime_types.join(',')} multiple={field.native_shape === 'multiple'} disabled={locked} onChange={(event) => { void upload(field.name, [...event.target.files ?? []]); event.target.value = '' }} /></label></div>
        <p className={css.hint}>{field.media_kind} · {field.min_items}–{mediaV2AssetLimit(field.max_items, field.constraints, parameters)} · {Math.floor(Math.min(uploadLimit, typeof field.constraints.max_bytes === 'number' ? field.constraints.max_bytes : uploadLimit) / 1024 / 1024)} MiB · {field.mime_types.join(', ')}</p>
        <ul className={css.assets}>{assets.filter(item => item.field === field.name).map(renderAsset)}</ul>
        {issues.filter(issue => issue.field === field.name).map((issue, index) =>
          <p key={index} className={css.error}>{issueText(issue.reason)}</p>)}
      </section>)}</div>
      {assets.some(item => !model.asset_fields.some(field => field.name === item.field)) && <section className={css.materialField}>
        <h3>{labels.retained}</h3>
        <ul className={css.assets}>
          {assets.filter(item => !model.asset_fields.some(field => field.name === item.field)).map(renderAsset)}
        </ul>
      </section>}
      {issues.filter(issue => issue.field === 'intent' || issue.field === 'parameters').map((issue, index) => <p key={index} className={css.error}>{issueText(issue.reason)}</p>)}
      {indicativePrice !== undefined && <p className={css.hint}>{labels.referenceUnitPrice}: ¥{indicativePrice.unit_price_cny}/{indicativePrice.billing_unit === 'per_video' ? labels.perVideo : labels.perSecond} · {labels.referenceTotal}: ¥{indicativePrice.total_cny}</p>}
      {configurationChanged && <p className={css.error} role="alert">{configurationRequoteAllowed
        ? labels.configurationChanged : labels.configurationRequoteUnsupported}</p>}
      <div className={css.actions}>
        <button type="button" disabled={locked || issues.length > 0 || accountKey === null
          || configurationChanged && !configurationRequoteAllowed} onClick={() => { void quote() }}>
          {busy && currentId !== null && current === undefined ? labels.quoting : labels.quote}
        </button>
        {current?.record.quote !== undefined && <div className={css.price}>
          <strong>{labels.price}: {current.record.quote.credits.toLocaleString()} {labels.credits}</strong>
          <span>¥{current.record.quote.retail_cny}</span>
          {readMediaV2Batch(current.record.quote.batch, 'quote') !== null && <span>{labels.batchCount}: {readMediaV2Batch(current.record.quote.batch, 'quote')?.requested_output_count}</span>}
          {current.record.quote.expires_at <= now && current.record.state === 'quoted' && <span className={css.error}>{labels.expires}</span>}</div>}
        {current?.record.state === 'quoted' && !mediaV2QuoteBatchValid(current.record, kind) && <p className={css.error}>{labels.batchUnknown}</p>}
        {current?.record.state === 'quoted' && <button type="button" className={css.primary} disabled={busy || issues.length > 0 || current.record.quote === undefined || current.record.quote.expires_at <= now || configurationChanged || !mediaV2QuoteBatchValid(current.record, kind)} onClick={() => { void submit() }}>{labels.submit}</button>}
      </div>
    </>}
    {error !== null && <p className={css.error} role="alert">{error}</p>}
    <div className={css.actions}><button type="button" className={css.textButton} disabled={busy || loading} onClick={() => { void load() }}>{labels.reload}</button>
      {originalUnsettled && current?.record.state !== 'quote-rejected' && current?.record.task?.is_final !== true && <button type="button" disabled={busy || loading} onClick={() => {
        if (inFlight.current) return
        const retained = [...new Set([...originalIds, currentId])]
        saveDraft({ currentId: null, originalIds: retained }); setOriginalIds(retained); setCurrentId(null); setError(null)
      }}>{labels.newWork}</button>}</div>
    {(records.length > 0 || missingOriginalIds.length > 0) && <section className={css.operations} aria-label={labels.operations}>
      <h3>{labels.operations}</h3>
      {missingOriginalIds.map(id => <article key={id} className={css.operation}>
        <p className={css.operationId}>{labels.originalId}: {id}</p><p>{labels.unknown}</p>
        <button type="button" disabled={busy} onClick={() => { void recover(id) }}>{labels.recover}</button>
      </article>)}
      {[...records].reverse().map((view) => {
        const record = view.record, task = record.task
        const batchPresent = record.quote?.batch !== undefined || task?.batch !== undefined
        const batch = readMediaV2Batch(task?.batch, 'task'), complete = mediaV2TaskComplete(record)
        const state = task === undefined ? record.state === 'quoted' ? labels.quoted
          : record.state === 'quote-rejected' ? labels.quoteRejected : labels.unknown : batchPresent && task.status === 'succeeded' && !complete ? labels.unknown : labels[task.status === 'pending' ? 'queued' : task.status === 'unknown' ? 'unknown' : task.status]
        return <article key={record.request.client_operation_id} className={css.operation}>
          <div className={css.row}>
            <strong>{models.find(item => item.id === record.request.model)?.display_name ?? record.request.model}</strong>
            <span>{state}</span>
          </div>
          <p className={css.operationId}>{labels.originalId}: {record.request.client_operation_id}</p>
          {record.quote_failure !== undefined && <p className={css.error}>{record.quote_failure.message}</p>}
          {task?.failure !== undefined && <p className={css.error}>{task.failure.message}</p>}
          {task !== undefined && batchPresent && <p className={complete ? css.hint : css.error} role="status">
            {batch === null ? labels.batchUnknown : `${labels.batchReceived}: ${String(batch.received_main_output_count)} / ${String(batch.expected_main_output_count)} · ${complete ? labels.batchComplete : batch.completeness === 'partial' ? labels.batchPartial : batch.completeness === 'mismatch' ? labels.batchMismatch : labels.batchPending}`}
          </p>}
          <div className={css.actions}><button type="button" disabled={busy} onClick={() => { void recover(record.request.client_operation_id) }}>{labels.recover}</button>
            {task?.is_final === true && task.artifacts.length > 0 && <button type="button" disabled={busy || batchPresent && !complete} onClick={() => { void save(view) }}>{labels.save}</button>}
            {currentId === record.request.client_operation_id && (record.state === 'quoted' || record.state === 'quote-rejected' || task?.is_final === true) && <button type="button" disabled={busy} onClick={() => { saveDraft({ currentId: null }); setCurrentId(null); setError(null) }}>{labels.newDraft}</button>}
          </div>
          {task !== undefined && task.artifacts.length > 0 && <div className={css.results} aria-label={labels.results}>
            {[...task.artifacts].sort((a, b) => a.order - b.order).map((artifact) => {
              const url = appPath(`${PREFIX}/tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifact.key)}/content`)
              const index = artifact.output_index
              const role = artifact.role === 'main' ? artifact.type === 'video' ? labels.mainVideo : labels.mainArtifact
                : artifact.role === 'preview' ? labels.previewArtifact : artifact.role === 'auxiliary' ? labels.auxiliaryArtifact
                  : artifact.role === 'duplicate' ? labels.duplicateArtifact : artifact.role === 'layer' ? labels.layerArtifact : undefined
              const group = typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && index < 64
                && artifact.output_id === `main-${String(index + 1)}` && role !== undefined
                ? `${labels.outputNumber.replace('{number}', String(index + 1))} · ${role}` : null
              return <figure key={artifact.key} className={css.artifact}>
                {artifact.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(artifact.mime_type) ? <img src={url} alt={artifact.filename ?? artifact.key} loading="lazy" />
                  : artifact.type === 'video' ? <VideoPlayer src={url} preload="metadata" /> : artifact.type === 'audio' ? <audio src={url} controls preload="metadata" /> : null}
                <figcaption><span>{artifact.filename ?? artifact.key}</span>{group !== null && <span className={css.hint}>{group}</span>}<a href={`${url}?download=1`} download>{labels.download}</a></figcaption>
              </figure>
            })}</div>}
          {view.saved.length > 0 && <ul className={css.saved} aria-label={labels.saved}>
            {view.saved.map(item => <li key={item.key}>{item.path}</li>)}
          </ul>}
        </article>
      })}</section>}
  </section>
}
