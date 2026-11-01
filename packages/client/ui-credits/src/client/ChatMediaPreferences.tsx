/** One compact composer entry for the two saved media defaults. */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconCloseOutlineRegular, IconSettingsOutlineRegular, Input, MenuSurface, SegmentedTabs, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MediaPreferenceChoices, MediaPreferencesInjected } from './media-preferences-controller.ts'
import { preferenceFields, validPreferenceSelection, type MediaSelection, type PreferenceFailure, type PreferenceFieldKey, type PreferenceKind, type PreferenceScalar } from './media-preferences.ts'
import type { CreditsKey } from './locales.ts'
import { mediaPreferencePrice, type MediaPreferencePrice } from './media-preference-prices.ts'
import { formatCreditUnitPrice } from './price-comparisons.ts'
import css from './ChatMediaPreferences.module.css'

/** Per-composer availability is independent of running generation tasks. */
export interface ChatMediaPreferencesInjected extends MediaPreferencesInjected { readonly available: boolean }
type Props = PropsRuntime<'conversation.input.right'> & InjectFace<ChatMediaPreferencesInjected> & PropsLocale<'credits'>
type EditorProps = Pick<Props, 'useMediaPreferences' | 'loadCatalog' | 'savePreferences' | 't'>
interface EditorDraft { readonly choices: MediaPreferenceChoices; readonly baseline: MediaPreferenceChoices; readonly revision: string }
const kinds = ['image', 'video'] as const
const names: Record<PreferenceKind, CreditsKey> = { image: 'media.image', video: 'media.video' }
const labels: Record<PreferenceFieldKey, CreditsKey> = { size: 'media.param.size', resolution: 'media.param.resolution', seconds: 'media.param.seconds', ratio: 'media.param.ratio', quality: 'media.param.quality', mode: 'media.param.mode', count: 'media.param.count', background: 'media.param.background', format: 'media.param.format', moderation: 'media.param.moderation', audio: 'media.param.audio', watermark: 'media.param.watermark', seed: 'media.param.seed' }
const errors: Record<PreferenceFailure, CreditsKey> = { account: 'media.error.account', conflict: 'media.error.conflict', model: 'media.error.model', parameters: 'media.error.parameters', network: 'media.error.network', timeout: 'media.error.timeout', unavailable: 'media.error.unavailable' }

function equalSelection(left: MediaSelection | null, right: MediaSelection | null): boolean {
  if (left === null || right === null) return left === right
  return left.model === right.model && Object.keys(left.parameters).length === Object.keys(right.parameters).length
    && Object.entries(left.parameters).every(([key, value]) => right.parameters[key] === value)
}

function priceLabel(value: MediaPreferencePrice, kind: PreferenceKind, t: Props['t']): string {
  const unit = t(kind === 'image' ? 'media.price.unit.image' : 'media.price.unit.video')
  if (value.kind === 'unknown') return t('media.price.unknown', { unit })
  const minimum = formatCreditUnitPrice(value.points.minimum, t('media.price.locale'))
  const maximum = formatCreditUnitPrice(value.points.maximum, t('media.price.locale'))
  if (value.kind === 'from') return t('media.price.from', { value: minimum, unit })
  return value.kind === 'exact' || minimum === maximum ? t('media.price.exact', { value: minimum, unit })
    : t('media.price.range', { min: minimum, max: maximum, unit })
}

/**
 * Keep the composer toolbar to one media-settings button.
 * @param props - Root preferences source, current Session and localized actions.
 * @returns A compact editor entry, absent on addressed subagents or removed Sessions.
 */
export function ChatMediaPreferences(props: Props) {
  const removed = props.useSession(value => value.removed)
  const identity = props.useMediaPreferences(value => value.identity)
  if (!props.available || removed || identity === null) return null
  return <MediaPreferenceEditor key={identity} {...props} />
}

function MediaPreferenceEditor({ useMediaPreferences, loadCatalog, savePreferences, t }: EditorProps) {
  const state = useMediaPreferences(value => value)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<PreferenceKind>('image')
  const [editor, setEditor] = useState<EditorDraft | null>(null)
  const [search, setSearch] = useState({ image: '', video: '' })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const position = useAnchoredPosition({ open, anchorRef: triggerRef, panelRef, side: 'top', align: 'end', gap: 8, margin: 12 })
  const saved: MediaPreferenceChoices = { image: state.saved?.image ?? null, video: state.saved?.video ?? null }
  const choices = editor?.choices ?? saved
  const changed = { image: !equalSelection(choices.image, saved.image), video: !equalSelection(choices.video, saved.video) }
  const valid = (target: PreferenceKind): boolean => choices[target] === null || state.catalog !== null
    && validPreferenceSelection(state.catalog[target].find(model => model.id === choices[target]?.model), choices[target])
  const invalid = { image: !valid('image'), video: !valid('video') }
  const blocked = kinds.find(target => changed[target] && invalid[target])
  const dirty = changed.image || changed.video
  const selection = choices[kind]
  const models = state.catalog?.[kind] ?? []
  const currentModel = models.find(model => model.id === selection?.model)
  const defaultModel = state.catalog?.defaults[kind]
  const defaultCapability = defaultModel?.available === true ? models.find(model => model.id === defaultModel.model) : undefined
  const defaultName = defaultCapability?.displayName ?? defaultModel?.model
  const currentPrice = priceLabel(mediaPreferencePrice(selection === null ? defaultCapability : currentModel,
    selection?.parameters), kind, t)
  const defaultPrice = priceLabel(mediaPreferencePrice(defaultCapability), kind, t)
  const close = (): void => { setOpen(false); setEditor(null); triggerRef.current?.focus() }
  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const outside = (event: PointerEvent): void => {
      if (!state.saving && event.target instanceof Node && !panelRef.current?.contains(event.target)
        && !triggerRef.current?.contains(event.target)) { setOpen(false); setEditor(null) }
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !state.saving) {
        event.stopPropagation(); setOpen(false); setEditor(null); triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [open, state.saving])
  useEffect(() => {
    const latest = state.saved
    if (!open || latest === null) return
    const next = { image: latest.image, video: latest.video }
    setEditor((previous) => {
      if (previous?.revision === latest.revision) return previous
      return { revision: latest.revision, baseline: next, choices: previous === null ? next : {
        image: equalSelection(previous.choices.image, previous.baseline.image) ? next.image : previous.choices.image,
        video: equalSelection(previous.choices.video, previous.baseline.video) ? next.video : previous.choices.video,
      } }
    })
  }, [open, state.saved])
  const choose = (value: MediaSelection | null): void => {
    const baseline = editor?.baseline ?? saved
    setEditor({ revision: editor?.revision ?? state.saved?.revision ?? '', baseline, choices: { ...choices, [kind]: value } })
  }
  const change = (key: string, value: PreferenceScalar | undefined): void => {
    if (selection === null) return
    const parameters = Object.fromEntries(Object.entries(selection.parameters).filter(([name]) => name !== key))
    if (value !== undefined) parameters[key] = value
    choose({ model: selection.model, parameters })
  }
  const save = async (): Promise<void> => { if (await savePreferences(choices)) close() }
  const tabLabel = (target: PreferenceKind) => <span className={css.tabLabel}>{t(names[target])}
    {changed[target] && <span aria-hidden="true" className={css.dirty}>•</span>}
    {state.catalog !== null && invalid[target] && <small aria-hidden="true">{t(changed[target] ? 'media.needsAdjustment' : 'media.unavailableShort')}</small>}
  </span>
  return <>
    <button ref={triggerRef} type="button" className={css.trigger} aria-label={t('media.entryAria')}
      aria-haspopup="dialog" aria-expanded={open} disabled={state.saving}
      onClick={() => {
        if (open) { close(); return }
        setEditor(state.saved === null ? null : { revision: state.saved.revision, baseline: saved, choices: saved })
        setSearch({ image: '', video: '' }); setOpen(true); void loadCatalog()
      }}><IconSettingsOutlineRegular size={14} /><span>{t('media.entry')}</span></button>
    {open && createPortal(<MenuSurface ref={panelRef} className={css.panel} role="dialog" aria-modal="false" aria-labelledby={titleId}
      style={position ?? { visibility: 'hidden' }}>
      <div className={css.header}><strong id={titleId}>{t('media.title')}</strong>
        <Button size="sm" aria-label={t('media.close')} disabled={state.saving} onClick={close}><IconCloseOutlineRegular size={14} /></Button></div>
      <SegmentedTabs<PreferenceKind> label={t('media.tabs')} className={css.tabs} value={kind} onChange={setKind} items={[
        { value: 'image', label: tabLabel('image'), id: `${titleId}-image`, panelId: `${titleId}-image-panel` },
        { value: 'video', label: tabLabel('video'), id: `${titleId}-video`, panelId: `${titleId}-video-panel` },
      ]} />
      <div className={css.body} role="tabpanel" id={`${titleId}-${kind}-panel`} aria-labelledby={`${titleId}-${kind}`}>
        {state.failure !== null && <div className={css.warning} role="alert"><span>{t(errors[state.failure])}</span>
          <Button size="sm" onClick={() => { void loadCatalog() }} disabled={state.loading || state.saving}>{t('media.retry')}</Button></div>}
        {state.loading && <p className={css.note} role="status">{t('media.loading')}</p>}
        <Input ref={searchRef} value={search[kind]} onChange={(event) => { setSearch({ ...search, [kind]: event.target.value }) }}
          placeholder={t('media.search')} aria-label={t('media.search')} disabled={state.saving} />
        <div className={css.models} role="group" aria-label={t('media.chooseModel')}>
          <button type="button" className={css.model} aria-pressed={selection === null} disabled={state.saving}
            onClick={() => { choose(null) }}><span className={css.modelLine}>
              <span>{t('media.followDefault')}</span><span className={css.price}>{defaultPrice}</span></span>
            {defaultName != null && <small>{defaultName}</small>}</button>
          {models.filter(model => `${model.displayName} ${model.id}`.toLowerCase().includes(search[kind].toLowerCase().trim())).map((model, index) =>
            <button key={model.id} type="button" className={css.model} aria-label={`${model.displayName} ${model.id}`}
              aria-describedby={`${titleId}-price-${index}`} aria-pressed={selection?.model === model.id} disabled={state.saving}
              onClick={() => { choose({ model: model.id, parameters: {} }) }}>
              <span className={css.modelLine}><span>{model.displayName}</span><span className={css.price} id={`${titleId}-price-${index}`}>
                {priceLabel(mediaPreferencePrice(model, selection?.model === model.id ? selection.parameters : {}), kind, t)}
              </span></span><small>{model.id}</small>
            </button>)}
          {models.length > 0 && !models.some(model => `${model.displayName} ${model.id}`.toLowerCase().includes(search[kind].toLowerCase().trim())) && <p className={css.note}>{t('media.noResults')}</p>}
          {state.catalog !== null && models.length === 0 && <p className={css.note}>{t('media.noModels')}</p>}
        </div>
        <p className={css.currentPrice} role="status">{currentPrice}</p>
        {selection !== null && currentModel === undefined && <p className={css.warning} role="status">{t('media.unavailable', { model: selection.model })}</p>}
        {currentModel !== undefined && selection !== null && <div className={css.parameters}>
          {preferenceFields(currentModel, selection.parameters).map(field => <label key={field.key} className={css.field}>
            <span>{t(labels[field.key])}</span>
            {field.key === 'seed' || field.key === 'count' ? <Input type="number"
              min={field.key === 'count' ? 1 : Number.MIN_SAFE_INTEGER} max={field.maximum ?? Number.MAX_SAFE_INTEGER} step={1}
              value={typeof selection.parameters[field.key] === 'number' ? Number(selection.parameters[field.key]) : ''}
              aria-label={t(labels[field.key])} placeholder={field.maximum === 1 ? t('media.fixed', { value: 1 }) : t('media.unspecified')}
              disabled={state.saving || field.maximum === 1 && selection.parameters[field.key] === undefined}
              onChange={(event) => { change(field.key, event.target.value === '' ? undefined : Number(event.target.value)) }} />
              : <select aria-label={t(labels[field.key])} value={selection.parameters[field.key] === undefined ? '' : JSON.stringify(selection.parameters[field.key])}
                disabled={state.saving || field.values.length === 1 && selection.parameters[field.key] === undefined}
                onChange={(event) => {
                  const option = field.values.find(value => JSON.stringify(value) === event.target.value)
                  change(field.key, option)
                }}>
                <option value="">{field.values.length === 1 ? t('media.fixed', { value: String(field.values[0]) }) : t('media.unspecified')}</option>
                {field.values.map(value => <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{typeof value === 'boolean' ? t(value ? 'media.enabled' : 'media.disabled') : field.key === 'seconds' ? t('media.seconds', { value }) : String(value)}</option>)}
                {selection.parameters[field.key] !== undefined && !field.values.some(value => value === selection.parameters[field.key]) && <option value={JSON.stringify(selection.parameters[field.key])}>{t('media.invalidValue', { value: String(selection.parameters[field.key]) })}</option>}
              </select>}
          </label>)}
          <Button size="sm" disabled={state.saving} onClick={() => { choose({ model: currentModel.id, parameters: {} }) }}>{t('media.clearParameters')}</Button>
        </div>}
      </div>
      <div className={css.footer}>
        {blocked !== undefined && <p className={css.invalid} role="alert">{t('media.adjustTab', { kind: t(names[blocked]) })}</p>}
        <span className={css.note}>{t('media.price.note')}</span>
        <div className={css.actions}><Button size="sm" disabled={state.saving} onClick={close}>{t('media.cancel')}</Button>
          <Button size="sm" variant="primary" disabled={!dirty || blocked !== undefined || state.saving || state.loading || state.saved === null}
            onClick={() => { void save() }}>{t(state.saving ? 'media.saving' : 'media.save')}</Button></div>
      </div>
    </MenuSurface>, document.body)}
  </>
}
