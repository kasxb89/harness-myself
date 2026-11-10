/** Full Settings model directory with explicit account-bound capacity preferences. */
import { useId, useMemo, useState } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelCatalogModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelCatalogState } from './catalog.ts'
import { CapacityEditor, type CapacityField } from './CapacityEditor.tsx'
import type { CapacityWriteRequest, CapacityWriteResult } from './settings-capacity.ts'
import { orderModelProviders } from './provider-order.ts'
import css from './SettingsModelCatalog.module.css'

/** Registration-owned sources and the only directory/parameter operations. */
export interface SettingsModelCatalogInjected {
  hooks: { catalog: HostObservable<ModelCatalogState>; settings: HostObservable<SettingsMirrorSnapshot> }
  /** Refresh the shared Host catalog without changing settings or a chat selection. */
  reload: () => void
  /** Save one explicit account-bound capacity record, or clear it to follow the platform. */
  writeLimits: (request: CapacityWriteRequest) => Promise<CapacityWriteResult>
}

interface CapacityDraft {
  values: Record<CapacityField, string>
  revision: number
  busy: boolean
  error?: 'changed' | 'readOnly' | 'conflict' | 'failed'
}

/** Keep account/provider/model identities opaque, including IDs containing separators. */
function draftKey(provider: string, model: ModelCatalogModel): string {
  return JSON.stringify([model.limits?.managedScope, provider, model.id])
}

/** A blank capacity inherits; every explicit capacity is a positive whole-token count. */
function tokenValue(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (!/^\d+$/u.test(trimmed)) return Number.NaN
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN
}

type SettingsModelCatalogProps = PropsRuntime<'settings.models.catalog'>
  & InjectFace<SettingsModelCatalogInjected> & PropsLocale<'model'>

/**
 * Render all successfully loaded models, keeping parameter drafts outside reloadable rows.
 * @param props - renderer-bound catalog hook, refresh callback and locale seat.
 * @returns the catalog card, or its loading/error state.
 */
export function SettingsModelCatalog({ useCatalog, useSettings, reload, writeLimits, t }: SettingsModelCatalogProps) {
  const state = useCatalog(value => value)
  const settings = useSettings(value => value)
  const [query, setQuery] = useState('')
  const [drafts, setDrafts] = useState<ReadonlyMap<string, CapacityDraft>>(() => new Map())
  const [activeKey, setActiveKey] = useState<string | undefined>()
  const titleId = useId()
  const catalog = state.status === 'ready' ? state.value : null
  const ready = catalog !== null
  const groups = useMemo(() => orderModelProviders(catalog?.groups ?? []), [catalog])
  const count = groups.reduce((total, group) => total + group.models.length, 0)
  const search = query.trim().toLocaleLowerCase()
  const filtered = groups.map(group => ({
    ...group,
    models: group.models.filter(model => !search || [group.name, model.name, model.id]
      .some(value => value.toLocaleLowerCase().includes(search))),
  })).filter(group => group.models.length > 0)
  const failures = catalog?.failures ?? []
  const loading = state.status === 'idle' || state.status === 'loading'
  const choices = groups.flatMap(group => group.models.map(model => ({ provider: group.id, model, key: draftKey(group.id, model) })))
  const active = choices.find(choice => choice.key === activeKey)
  const draft = active === undefined ? undefined : drafts.get(active.key)
  const limits = active?.model.limits
  const namespaceFor = (model: ModelCatalogModel) => settings.view?.namespaces.find(value => value.ns === model.limitSettings?.settingsNs)
  const editable = (model: ModelCatalogModel): boolean => settings.status === 'ready' && settings.view?.writable === true
    && namespaceFor(model) !== undefined && model.limitSettings !== undefined && model.limits?.managedScope !== undefined
    && model.limits.platform.contextWindow !== undefined && model.limits.platform.maxOutputTokens !== undefined
  const contextWindow = tokenValue(draft?.values.contextWindow ?? '')
  const maxTokens = tokenValue(draft?.values.maxTokens ?? '')
  const validation = Number.isNaN(contextWindow) || Number.isNaN(maxTokens) ? 'capacity.invalid'
    : contextWindow !== undefined && limits?.platform.contextWindow !== undefined && contextWindow > limits.platform.contextWindow
      || maxTokens !== undefined && limits?.platform.maxOutputTokens !== undefined && maxTokens > limits.platform.maxOutputTokens
      ? 'capacity.exceeded'
      : maxTokens !== undefined && maxTokens > (contextWindow ?? limits?.platform.contextWindow ?? Number.POSITIVE_INFINITY)
        ? 'capacity.outputExceeded' : undefined
  const openParameters = (provider: string, model: ModelCatalogModel): void => {
    const namespace = namespaceFor(model)
    if (!editable(model) || namespace === undefined) return
    const key = draftKey(provider, model)
    setDrafts(previous => previous.has(key) ? previous : new Map(previous).set(key, {
      values: {
        contextWindow: model.limits?.override?.contextWindow === undefined ? '' : String(model.limits.override.contextWindow),
        maxTokens: model.limits?.override?.maxOutputTokens === undefined ? '' : String(model.limits.override.maxOutputTokens),
      }, revision: namespace.revision, busy: false,
    }))
    setActiveKey(key)
  }
  const persist = async (reset: boolean): Promise<void> => {
    if (active === undefined || draft === undefined || limits?.managedScope === undefined || draft.busy
      || !editable(active.model) || !reset && validation !== undefined) return
    const { key, provider, model } = active
    const { error: _previousError, ...withoutError } = draft
    setDrafts(previous => new Map(previous).set(key, { ...withoutError, busy: true }))
    const values = reset || contextWindow === undefined && maxTokens === undefined ? undefined : {
      ...contextWindow === undefined ? {} : { contextWindow }, ...maxTokens === undefined ? {} : { maxTokens },
    }
    let outcome: CapacityWriteResult
    try {
      outcome = await writeLimits({ provider, model: model.id, scope: limits.managedScope, expectedRevision: draft.revision,
        ...values === undefined ? {} : { values } })
    } catch {
      outcome = { ok: false, reason: 'failed' }
    }
    if (outcome.ok) {
      setDrafts((previous) => { const next = new Map(previous); next.delete(key); return next })
      setActiveKey(current => current === key ? undefined : current)
    } else {
      const failure = outcome
      setDrafts(previous => new Map(previous).set(key, {
        ...draft, busy: false, error: failure.reason, revision: failure.revision ?? draft.revision,
      }))
    }
  }

  return <section className={css.card} aria-labelledby={titleId} aria-busy={loading}>
    <div className={css.header}>
      <h3 id={titleId} className={css.title}>{t('catalog.title')}</h3>
      {ready && <span className={css.count}>{t(failures.length > 0 ? 'catalog.loadedCount' : 'catalog.count', { count })}</span>}
      <Button size="sm" variant="outline" disabled={loading} onClick={reload}>
        {t(state.status === 'error' || failures.length > 0 ? 'catalog.retry' : 'catalog.refresh')}
      </Button>
    </div>
    {loading && <div className={css.state} role="status" aria-label={t('status.loading')}><StateDot state="ongoing" /></div>}
    {!loading && !ready && <p className={css.notice} role="alert">{t('option.loadError')}</p>}
    {ready && <>
      {failures.length > 0 && <div className={css.notice} role="alert">
        {failures.map(failure => <p key={failure.id}>{t('warning.groupLoad', { name: failure.name })}</p>)}
      </div>}
      {count > 0 && <Input type="search" value={query} onChange={(event) => { setQuery(event.target.value) }}
        placeholder={t('catalog.search')} aria-label={t('catalog.search')} />}
      {count === 0 && failures.length > 0 ? null : filtered.length === 0 ? <p className={css.empty} role="status">{t(count === 0 ? 'empty.models' : 'search.empty')}</p>
        : <div className={css.groups}>
          {filtered.map(group => <section key={group.id} aria-label={group.name}>
            <h4 className={css.provider}>{group.name}</h4>
            <ul className={css.models}>
              {group.models.map(model => <li key={model.id} className={css.model}>
                <span className={css.identity}>
                  <span className={css.name}>{model.name}</span>
                  <code className={css.modelId}>{model.id}</code>
                </span>
                {model.limits === undefined ? null : <span className={css.capacity}>{t('capacity.summary', {
                  context: model.limits.contextWindow, output: model.limits.maxOutputTokens,
                })}</span>}
                {model.limitSettings === undefined ? null : <Button size="sm" disabled={!editable(model)}
                  aria-label={t('capacity.parametersAria', { model: `${group.name} / ${model.name}` })}
                  onClick={() => { openParameters(group.id, model) }}>{t('capacity.parameters')}</Button>}
              </li>)}
            </ul>
          </section>)}
        </div>}
    </>}
    {active === undefined || draft === undefined || limits === undefined ? null : <CapacityEditor
      open={ready} model={`${active.model.name} · ${active.model.id}`} values={draft.values}
      maxima={{ ...limits.platform.contextWindow === undefined ? {} : { contextWindow: limits.platform.contextWindow },
        ...limits.platform.maxOutputTokens === undefined ? {} : { maxTokens: limits.platform.maxOutputTokens } }}
      busy={draft.busy} disabled={!editable(active.model)} invalid={validation !== undefined}
      error={validation === undefined ? draft.error === undefined ? undefined : t(`capacity.${draft.error}`) : t(validation)}
      onChange={(field, value) => {
        const { error: _previousError, ...withoutError } = draft
        setDrafts(previous => new Map(previous).set(active.key, { ...withoutError, values: { ...draft.values, [field]: value } }))
      }}
      onSave={() => { void persist(false) }} onReset={() => { void persist(true) }}
      onClose={() => { setActiveKey(undefined) }} t={t} />}
  </section>
}
