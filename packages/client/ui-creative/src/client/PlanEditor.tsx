/** Free structured plan editing; saving never submits a media generation. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CreativeAsset, CreativeCharacter, CreativePlanChange, CreativeProjectView, CreativeShotPlan,
} from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'
import type { CreativeUploadResult } from './api.ts'
import type {} from './locales.ts'
import css from './CreativeBody.module.css'

type Translate = TranslateNS<'creative'>
/** The selected record and its original CAS revision stay stable while the user edits. */
export type PlanEdit =
  | { readonly kind: 'shot'; readonly value: CreativeShotPlan; readonly adding: boolean }
  | { readonly kind: 'character'; readonly value: CreativeCharacter; readonly adding: boolean }
  | { readonly kind: 'asset'; readonly value: CreativeAsset; readonly adding: boolean }

interface Props {
  readonly project: CreativeProjectView
  readonly edit: PlanEdit
  readonly upload: (file: File, signal: AbortSignal) => Promise<CreativeUploadResult>
  readonly saving: boolean
  readonly failure: string | null
  readonly save: (change: CreativePlanChange) => void
  readonly close: () => void
  readonly t: Translate
}

/**
 * Create a stable id once when the explicit add action opens an editor.
 * @param kind - record the user chose to add.
 * @param order - planned position used only for a new shot.
 * @returns an unsaved record that must pass the editor's required-field checks.
 */
export function newPlanEdit(kind: PlanEdit['kind'], order: number): PlanEdit {
  const id = `${kind}_${randomUUID().replaceAll('-', '')}`
  switch (kind) {
    case 'shot': return { kind, adding: true, value: { id, order, title: '', camera: '', scene: '', action: '',
      prompt: '', dialogue: '', subtitles: '', characterIds: [], assetIds: [] } }
    case 'character': return { kind, adding: true, value: { id, name: '', appearance: '', clothing: '',
      personality: '', voice: '', referenceAssetIds: [] } }
    case 'asset': return { kind, adding: true, value: { id, name: '', kind: 'image', role: '', description: '', sourcePathOrAssetId: '' } }
  }
}

function References({ label, items, selected, disabled, change }: {
  label: string
  items: readonly { id: string; name: string; thumbnail?: string }[]
  selected: readonly string[]
  disabled: boolean
  change: (ids: readonly string[]) => void
}): ReactNode {
  return <fieldset className={css.referenceGroup} disabled={disabled}><legend>{label}</legend>
    {items.map(item => <label className={css.referenceOption} key={item.id}>
      <input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => {
        change(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))
      }} />
      {item.thumbnail !== undefined && <img src={item.thumbnail} alt="" loading="lazy" />}
      <span>{item.name}</span>
    </label>)}
  </fieldset>
}

/** Dialog for editable directions and real registered reference bindings. */
export function PlanEditor({ project, edit, upload, saving, failure, save, close, t }: Props): ReactNode {
  const [draft, setDraft] = useState(edit)
  const id = useId()
  const [uploading, setUploading] = useState(false)
  const [uploadFailures, setUploadFailures] = useState<readonly { name: string; code: string }[]>([])
  const [uploaded, setUploaded] = useState<Extract<CreativeUploadResult, { ok: true }> | null>(null)
  const [references, setReferences] = useState<readonly { asset: CreativeAsset; result: Extract<CreativeUploadResult, { ok: true }> }[]>([])
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => { pending.current?.abort() }, [])
  const uploadFiles = async (files: readonly File[]): Promise<void> => {
    if (draft.kind === 'shot' || pending.current !== null) return
    const abort = new AbortController()
    pending.current = abort
    setUploading(true); setUploadFailures([])
    for (const file of files) {
      let result: CreativeUploadResult
      try { result = await upload(file, abort.signal) } catch (_uploadFailed) {
        result = { ok: false, code: 'IMAGE_UPLOAD_FAILED' }
      }
      if (abort.signal.aborted || pending.current !== abort) return
      if (!result.ok) {
        const code = result.code ?? 'IMAGE_UPLOAD_FAILED'
        setUploadFailures(current => [...current, { name: file.name, code }]); continue
      }
      if (draft.kind === 'character') {
        if (result.kind !== 'image') {
          setUploadFailures(current => [...current, { name: file.name, code: 'IMAGE_FORMAT_UNSUPPORTED' }]); continue
        }
        const asset: CreativeAsset = { id: `asset_${randomUUID().replaceAll('-', '')}`, name: file.name,
          kind: 'image', role: '', description: '', sourcePathOrAssetId: result.assetId }
        setReferences(current => [...current, { asset, result }])
        setDraft(current => current.kind !== 'character' ? current : { ...current, value: { ...current.value,
          name: current.value.name.trim() || file.name,
          referenceAssetIds: [...current.value.referenceAssetIds, asset.id] } })
      } else {
        setUploaded(result)
        setDraft(current => current.kind !== 'asset' ? current : { ...current, value: { ...current.value,
          sourcePathOrAssetId: result.assetId, kind: result.kind, name: current.value.name.trim() || file.name } })
      }
    }
    pending.current = null
    setUploading(false)
  }
  const failureReason = (code: string): string => {
    switch (code) {
      case 'IMAGE_EMPTY': return t('plan.uploadEmpty')
      case 'IMAGE_INPUT_TOO_LARGE': return t('plan.uploadSize')
      case 'IMAGE_FORMAT_UNSUPPORTED': return t('plan.uploadFormat')
      case 'IMAGE_DECODE_FAILED': return t('plan.uploadDecode')
      case 'IMAGE_CONVERSION_FAILED':
      case 'IMAGE_DECODER_UNAVAILABLE': return t('plan.uploadConvert')
      case 'IMAGE_PIXEL_LIMIT': return t('plan.uploadPixels')
      case 'IMAGE_OUTPUT_TOO_LARGE': return t('plan.uploadOutputSize')
      case 'IMAGE_STORAGE_FAILED': return t('plan.uploadStorage')
      case 'IMAGE_RESPONSE_INVALID': return t('plan.uploadResponse')
      default: return t('plan.uploadFailed')
    }
  }
  const busy = saving || uploading
  const field = (key: string, label: string, value: string, change: (value: string) => void, multiline = false): ReactNode =>
    <label className={css.field} htmlFor={`${id}-${key}`}><span>{label}</span>
      {multiline ? <textarea id={`${id}-${key}`} className={css.fieldInput} rows={3} value={value} disabled={busy} required={key === 'prompt'}
        maxLength={7000} onChange={(event) => { change(event.target.value) }} />
        : <input id={`${id}-${key}`} className={css.fieldInput} value={value} disabled={busy}
          maxLength={key === 'name' || key === 'title' ? 256 : key === 'sourcePathOrAssetId' ? 32_768 : 1000} onChange={(event) => { change(event.target.value) }} />}
    </label>
  const assets = [...project.assets.map((asset) => {
    const output = (asset.outputs ?? []).find(item => item.kind === 'image')
    const url = output?.url ?? asset.referenceUrl
    return { id: asset.id, name: asset.name, ...(url === undefined ? {} : { thumbnail: url }) }
  }), ...references.map(({ asset, result }) => ({ id: asset.id, name: asset.name,
    ...result.previewUrl === undefined ? {} : { thumbnail: result.previewUrl } }))]
  const title = draft.kind === 'shot' ? draft.value.title : draft.value.name
  const durationRequired = edit.kind === 'shot' && edit.value.durationSeconds !== undefined
  const valid = title.trim() !== '' && (draft.kind !== 'shot' || draft.value.prompt.trim() !== '')
    && (draft.kind !== 'shot'
    || (draft.value.durationSeconds === undefined ? !durationRequired
      : Number.isFinite(draft.value.durationSeconds) && draft.value.durationSeconds > 0 && draft.value.durationSeconds <= 86_400))
  const submit = (): void => {
    if (!valid || busy) return
    switch (draft.kind) {
      case 'shot':
        if (draft.adding) save({ kind: 'add-shot', value: draft.value })
        else {
          const { id: shotId, order: _order, ...patch } = draft.value
          save({ kind: 'shot', id: shotId, patch })
        }
        break
      case 'character': save({ kind: 'character', value: draft.value,
        ...references.length === 0 ? {} : { assets: references.map(item => item.asset) } }); break
      case 'asset': {
        const { id: assetId, name, kind, role, description, sourcePathOrAssetId } = draft.value
        save({ kind: 'asset', value: { id: assetId, name, kind, role, description, sourcePathOrAssetId } })
        break
      }
    }
  }
  return <Modal open headless title={t(draft.adding ? `plan.add.${draft.kind}` : 'plan.edit')} onClose={() => { if (!saving) close() }}>
    <form className={css.planDialog} onSubmit={(event) => { event.preventDefault(); submit() }}>
      <h2>{t(draft.adding ? `plan.add.${draft.kind}` : 'plan.edit')}</h2>
      <p className={css.hint}>{t('plan.free')}</p>
      {draft.kind === 'shot' ? <>
        {field('title', t('plan.name'), draft.value.title,
          (value) => { setDraft({ ...draft, value: { ...draft.value, title: value } }) })}
        <label className={css.field} htmlFor={`${id}-duration`}><span>{t('plan.duration')}</span>
          <input id={`${id}-duration`} type="number" min="0.1" max="86400" required={durationRequired} step="0.1" value={draft.value.durationSeconds ?? ''}
            disabled={busy} className={css.fieldInput} onChange={(event) => {
              const { durationSeconds: _duration, ...rest } = draft.value
              setDraft({ ...draft, value: event.target.value === '' ? rest : { ...rest, durationSeconds: Number(event.target.value) } })
            }} />
        </label>
        {(['scene', 'camera', 'action', 'dialogue', 'subtitles'] as const).map(key =>
          <div key={key}>{field(key, t(key), draft.value[key], (value) => {
            setDraft({ ...draft, value: { ...draft.value, [key]: value } })
          }, true)}</div>)}
        {field('prompt', t('plan.requiredPrompt'), draft.value.prompt,
          (value) => { setDraft({ ...draft, value: { ...draft.value, prompt: value } }) }, true)}
        <References label={t('characters')} items={project.characters} selected={draft.value.characterIds} disabled={busy}
          change={(ids) => { setDraft({ ...draft, value: { ...draft.value, characterIds: ids } }) }} />
        <References label={t('materials')} items={assets} selected={draft.value.assetIds} disabled={busy}
          change={(ids) => { setDraft({ ...draft, value: { ...draft.value, assetIds: ids } }) }} />
      </> : draft.kind === 'character' ? <>
        <label className={css.field}><span>{t(uploading ? 'plan.uploading' : 'plan.uploadCharacter')}</span>
          <input type="file" multiple accept=".png,.jpg,.jpeg,.jfif,.webp,.avif,.gif,.bmp,.tif,.tiff,.heic,.heif,image/*"
            disabled={busy} onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              if (files.length > 0) void uploadFiles(files)
            }} />
        </label><p className={css.hint}>{t('plan.uploadCharacterHint')}</p>
        {(['name', 'appearance', 'clothing', 'personality', 'voice'] as const).map(key =>
          <div key={key}>{field(key, key === 'name' ? t('plan.name') : t(key), draft.value[key], (value) => {
            setDraft({ ...draft, value: { ...draft.value, [key]: value } })
          }, key !== 'name')}</div>)}
        <References label={t('references')} items={assets.filter(asset => references.some(item => item.asset.id === asset.id)
          || project.assets.some(value => value.id === asset.id && value.kind === 'image'))} selected={draft.value.referenceAssetIds} disabled={busy}
        change={(ids) => { setDraft({ ...draft, value: { ...draft.value, referenceAssetIds: ids } }) }} />
        {references.some(item => item.result.converted === true) && <p className={css.hint}>{t('plan.uploadConverted')}</p>}
        {references.some(item => item.result.firstFrameOnly === true) && <p className={css.hint}>{t('plan.uploadFirstFrame')}</p>}
      </> : <>
        <label className={css.field}><span>{t(uploading ? 'plan.uploading' : 'plan.upload')}</span>
          <input type="file"
            accept=".png,.jpg,.jpeg,.jfif,.webp,.avif,.gif,.bmp,.tif,.tiff,.heic,.heif,image/*,video/mp4,video/webm,audio/*"
            disabled={busy} onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) void uploadFiles([file])
            }} />
        </label><p className={css.hint}>{t('plan.uploadHint')}</p>
        {field('name', t('plan.name'), draft.value.name,
          (value) => { setDraft({ ...draft, value: { ...draft.value, name: value } }) })}
        <label className={css.field} htmlFor={`${id}-kind`}><span>{t('plan.kind')}</span>
          <select id={`${id}-kind`} className={css.fieldInput} value={draft.value.kind} disabled={busy} onChange={(event) => {
            const kind = event.target.value
            if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'document' || kind === 'other') {
              setDraft({ ...draft, value: { ...draft.value, kind } })
            }
          }}>{(['image', 'video', 'audio', 'document', 'other'] as const).map(kind =>
              <option value={kind} key={kind}>{t(`kind.${kind}`)}</option>)}</select>
        </label>
        {(['role', 'description', 'sourcePathOrAssetId'] as const).map(key =>
          <div key={key}>{field(key, t(key === 'sourcePathOrAssetId' ? 'source' : key), draft.value[key], (value) => {
            setDraft({ ...draft, value: { ...draft.value, [key]: value } })
          }, key === 'description')}</div>)}
        <p className={css.hint}>{t('plan.sourceHint')}</p>
        {uploaded !== null && uploaded.assetId === draft.value.sourcePathOrAssetId && <>
          {uploaded.previewUrl !== undefined && <img className={css.assetThumbnail} src={uploaded.previewUrl} alt={draft.value.name} />}
          {uploaded.converted === true && <p className={css.hint}>{t('plan.uploadConverted')}</p>}
          {uploaded.firstFrameOnly === true && <p className={css.hint}>{t('plan.uploadFirstFrame')}</p>}
        </>}
      </>}
      {uploadFailures.map((failure, index) => <p key={index} className={css.notice} role="alert">
        {t('plan.uploadFileFailed', { name: failure.name, reason: failureReason(failure.code) })}
      </p>)}
      {failure !== null && <p className={css.notice} role="alert">{failure}</p>}
      <div className={css.dialogActions}><Button type="button" variant="ghost" disabled={busy} onClick={close}>{t('cancel')}</Button>
        <Button type="submit" disabled={!valid || busy}>{t(saving ? 'plan.saving' : 'plan.save')}</Button></div>
    </form>
  </Modal>
}
