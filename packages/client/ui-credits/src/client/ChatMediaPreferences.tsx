/** Saved future-generation controls at the ordinary chat composer. */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconChevronDownOutlineRegular, IconCloseOutlineRegular, Input, MenuSurface, Tooltip, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MediaPreferencesInjected } from './media-preferences-controller.ts'
import { preferenceFields, validPreferenceSelection, type MediaSelection, type PreferenceFailure, type PreferenceFieldKey, type PreferenceKind, type PreferenceScalar } from './media-preferences.ts'
import type { CreditsKey } from './locales.ts'
import { mediaPreferencePrice, type MediaPreferencePrice } from './media-preference-prices.ts'
import { formatCreditUnitPrice } from './price-comparisons.ts'
import css from './ChatMediaPreferences.module.css'

/** Per-composer availability is independent of running generation tasks. */
export interface ChatMediaPreferencesInjected extends MediaPreferencesInjected { readonly available: boolean }
type Props = PropsRuntime<'conversation.input.right'> & InjectFace<ChatMediaPreferencesInjected> & PropsLocale<'credits'>
type PickerProps = Pick<Props, 'useMediaPreferences' | 'loadCatalog' | 'savePreference' | 't'> & { readonly kind: PreferenceKind; readonly removed: boolean }
const names: Record<PreferenceKind, CreditsKey> = { image: 'media.image', video: 'media.video' }
const titles: Record<PreferenceKind, CreditsKey> = { image: 'media.imageTitle', video: 'media.videoTitle' }
const labels: Record<PreferenceFieldKey, CreditsKey> = { size: 'media.param.size', resolution: 'media.param.resolution', seconds: 'media.param.seconds', ratio: 'media.param.ratio', quality: 'media.param.quality', mode: 'media.param.mode', count: 'media.param.count', background: 'media.param.background', format: 'media.param.format', moderation: 'media.param.moderation', audio: 'media.param.audio', watermark: 'media.param.watermark', seed: 'media.param.seed' }
const errors: Record<PreferenceFailure, CreditsKey> = { account: 'media.error.account', conflict: 'media.error.conflict', model: 'media.error.model', parameters: 'media.error.parameters', network: 'media.error.network', timeout: 'media.error.timeout', unavailable: 'media.error.unavailable' }

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
 * Render image and video selectors for ordinary, live conversations.
 * @param props - Root preferences source, current Session, and localized actions.
 * @returns Two compact controls, absent on addressed subagents or removed Sessions.
 */
export function ChatMediaPreferences(props: Props) {
  const removed = props.useSession(value => value.removed)
  const identity = props.useMediaPreferences(value => value.identity)
  if (!props.available || removed || identity === null) return null
  return <span className={css.controls}>
    <MediaPreferencePicker key={`image:${identity}`} kind="image" removed={removed} {...props} />
    <MediaPreferencePicker key={`video:${identity}`} kind="video" removed={removed} {...props} />
  </span>
}

function MediaPreferencePicker({ kind, removed, useMediaPreferences, loadCatalog, savePreference, t }: PickerProps) {
  const state = useMediaPreferences(value => value)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<MediaSelection | null>(null)
  const [search, setSearch] = useState('')
  const [dirty, setDirty] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const position = useAnchoredPosition({ open, anchorRef: triggerRef, panelRef, side: 'top', align: 'end', gap: 8, margin: 12 })
  const saved = state.saved?.[kind] ?? null
  const models = state.catalog?.[kind] ?? []
  const savedModel = models.find(model => model.id === saved?.model)
  const currentModel = models.find(model => model.id === draft?.model)
  const unavailable = saved !== null && state.catalog !== null && !validPreferenceSelection(savedModel, saved)
  const draftValid = state.catalog !== null && validPreferenceSelection(currentModel, draft)
  const defaultModel = state.catalog?.defaults[kind]
  const defaultCapability = defaultModel?.available === true ? models.find(model => model.id === defaultModel.model) : undefined
  const defaultName = defaultCapability?.displayName ?? defaultModel?.model
  const savedSummary = saved === null ? t('media.followDefault') : savedModel?.displayName ?? saved.model
  const parameters = saved === null ? '' : Object.values(saved.parameters).map(value => typeof value === 'boolean' ? t(value ? 'media.enabled' : 'media.disabled') : String(value)).join(' · ')
  const savedPrice = priceLabel(mediaPreferencePrice(saved === null ? defaultCapability : savedModel, saved?.parameters), kind, t)
  const draftPrice = priceLabel(mediaPreferencePrice(draft === null ? defaultCapability : currentModel, draft?.parameters), kind, t)
  const defaultPrice = priceLabel(mediaPreferencePrice(defaultCapability), kind, t)
  const tooltipModel = saved === null && defaultName != null ? `${savedSummary} · ${defaultName}` : savedSummary
  const tooltip = `${t(names[kind])} · ${tooltipModel}${parameters === '' ? '' : ` · ${parameters}`} · ${savedPrice} · ${t('media.price.note')}`
  const close = (): void => { setOpen(false); triggerRef.current?.focus() }
  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)
        && !triggerRef.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); triggerRef.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [open])
  useEffect(() => { if (open && !dirty) setDraft(saved) }, [open, dirty, saved])
  const change = (key: string, value: PreferenceScalar | undefined): void => {
    if (draft === null) return
    const parameters = Object.fromEntries(Object.entries(draft.parameters).filter(([name]) => name !== key))
    if (value !== undefined) parameters[key] = value
    setDraft({ model: draft.model, parameters }); setDirty(true)
  }
  const save = async (): Promise<void> => {
    if (await savePreference(kind, draft)) { setDirty(false); close() }
  }
  return <>
    <Tooltip label={tooltip} portal side="top">
      <button ref={triggerRef} type="button" className={css.trigger} aria-label={t(titles[kind])} aria-haspopup="dialog" aria-expanded={open}
        disabled={removed}
        onClick={() => {
          if (open) { close(); return }
          setDraft(saved); setDirty(false); setSearch(''); setOpen(true); void loadCatalog()
        }}>
        <span className={css.kind}>{t(names[kind])}</span><span className={css.summary}>{unavailable ? t('media.unavailableShort')
          : `${savedSummary}${parameters === '' ? '' : ` · ${parameters}`}`}</span>
        <span className={css.price}>{savedPrice}</span><IconChevronDownOutlineRegular size={12} />
      </button>
    </Tooltip>
    {open && createPortal(<MenuSurface ref={panelRef} className={css.panel} role="dialog" aria-modal="false" aria-labelledby={titleId}
      style={position ?? { visibility: 'hidden' }}>
      <div className={css.header}><strong id={titleId}>{t(titles[kind])}</strong><Button size="sm" aria-label={t('media.close')} onClick={close}><IconCloseOutlineRegular size={14} /></Button></div>
      <div className={css.body}>
        <p className={css.note}>{t('media.description')}</p>
        <p className={css.note}>{kind === 'video' ? t('media.videoHint') : t('media.imageHint')}</p>
        <p className={css.note}>{t('media.price.note')}</p>
        {unavailable && <p className={css.warning} role="status">{t('media.unavailable', { model: saved.model })}</p>}
        {state.failure !== null && <div className={css.warning} role="alert"><p>{t(errors[state.failure])}</p>
          <Button size="sm" onClick={() => { void loadCatalog() }} disabled={state.loading || state.saving}>{t('media.retry')}</Button></div>}
        {state.loading && <p className={css.note} role="status">{t('media.loading')}</p>}
        <Input ref={searchRef} value={search} onChange={(event) => { setSearch(event.target.value) }} placeholder={t('media.search')} aria-label={t('media.search')} disabled={state.saving} />
        <div className={css.models} role="group" aria-label={t('media.chooseModel')}>
          <button type="button" className={css.model} aria-pressed={draft === null} disabled={state.saving}
            onClick={() => { setDraft(null); setDirty(true) }}><span className={css.modelLine}>
              <span>{t('media.followDefault')}</span><span className={css.price}>{defaultPrice}</span></span>
            <small>{defaultName === null || defaultName === undefined ? t('media.defaultUnknown') : t(defaultModel?.available === true ? 'media.defaultModel' : 'media.defaultUnavailable', { model: defaultName })}</small></button>
          {models.filter(model => `${model.displayName} ${model.id}`.toLowerCase().includes(search.toLowerCase().trim())).map((model, index) =>
            <button key={model.id} type="button" className={css.model} aria-label={`${model.displayName} ${model.id}`}
              aria-describedby={`${titleId}-price-${index}`} aria-pressed={draft?.model === model.id} disabled={state.saving}
              onClick={() => { setDraft({ model: model.id, parameters: {} }); setDirty(true) }}>
              <span className={css.modelLine}><span>{model.displayName}</span><span className={css.price} id={`${titleId}-price-${index}`}>
                {priceLabel(mediaPreferencePrice(model, draft?.model === model.id ? draft.parameters : {}), kind, t)}
              </span></span><small>{model.id}</small>
            </button>)}
          {models.length > 0 && !models.some(model => `${model.displayName} ${model.id}`.toLowerCase().includes(search.toLowerCase().trim())) && <p className={css.note}>{t('media.noResults')}</p>}
          {state.catalog !== null && models.length === 0 && <p className={css.note}>{t('media.noModels')}</p>}
        </div>
        <p className={css.currentPrice} role="status">{t('media.price.current', { price: draftPrice })}</p>
        {draft !== null && currentModel === undefined && <p className={css.warning}>{t('media.unavailable', { model: draft.model })}</p>}
        {currentModel !== undefined && draft !== null && <div className={css.parameters}>
          <h4>{t('media.parameters')}</h4><p className={css.note}>{t('media.parametersHint')}</p>
          {preferenceFields(currentModel, draft.parameters).map(field => <label key={field.key} className={css.field}>
            <span>{t(labels[field.key])}</span>
            {field.key === 'seed' || field.key === 'count' ? <Input type="number"
              min={field.key === 'count' ? 1 : Number.MIN_SAFE_INTEGER}
              max={field.maximum ?? Number.MAX_SAFE_INTEGER} step={1}
              value={typeof draft.parameters[field.key] === 'number' ? Number(draft.parameters[field.key]) : ''}
              aria-label={t(labels[field.key])}
              placeholder={field.maximum === 1 ? t('media.fixed', { value: 1 }) : t('media.unspecified')}
              disabled={state.saving || field.maximum === 1 && draft.parameters[field.key] === undefined}
              onChange={(event) => { change(field.key, event.target.value === '' ? undefined : Number(event.target.value)) }} />
              : <select aria-label={t(labels[field.key])} value={draft.parameters[field.key] === undefined ? '' : JSON.stringify(draft.parameters[field.key])}
                disabled={state.saving || field.values.length === 1 && draft.parameters[field.key] === undefined}
                onChange={(event) => {
                  const option = field.values.find(value => JSON.stringify(value) === event.target.value)
                  change(field.key, option)
                }}>
                <option value="">{field.values.length === 1 ? t('media.fixed', { value: String(field.values[0]) }) : t('media.unspecified')}</option>
                {field.values.map(value => <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{typeof value === 'boolean' ? t(value ? 'media.enabled' : 'media.disabled') : field.key === 'seconds' ? t('media.seconds', { value }) : String(value)}</option>)}
                {draft.parameters[field.key] !== undefined && !field.values.some(value => value === draft.parameters[field.key]) && <option value={JSON.stringify(draft.parameters[field.key])}>{t('media.invalidValue', { value: String(draft.parameters[field.key]) })}</option>}
              </select>}
          </label>)}
          {!draftValid && <p className={css.warning} role="status">{t('media.invalidCombination')}</p>}
          <Button size="sm" disabled={state.saving} onClick={() => { setDraft({ model: currentModel.id, parameters: {} }); setDirty(true) }}>{t('media.clearParameters')}</Button>
        </div>}
      </div>
      <div className={css.footer}><span className={css.note}>{t('media.futureOnly')}</span><Button size="sm" variant="primary" disabled={!draftValid || state.saving || state.loading || state.saved === null} onClick={() => { void save() }}>{t(state.saving ? 'media.saving' : 'media.save')}</Button></div>
    </MenuSurface>, document.body)}
  </>
}
