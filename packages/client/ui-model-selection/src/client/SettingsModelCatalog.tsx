/** Read-only Settings view of the same live catalog used by chat model selection. */
import { useId, useMemo, useState } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { ModelCatalogState } from './catalog.ts'
import { orderModelProviders } from './provider-order.ts'
import css from './SettingsModelCatalog.module.css'

/** Registration-owned source and the sole read-only catalog operation. */
export interface SettingsModelCatalogInjected {
  hooks: { catalog: HostObservable<ModelCatalogState> }
  /** Refresh the shared Host catalog without changing settings or a chat selection. */
  reload: () => void
}

type SettingsModelCatalogProps = PropsRuntime<'settings.models.catalog'>
  & InjectFace<SettingsModelCatalogInjected> & PropsLocale<'model'>

/**
 * Render all successfully loaded models, grouped by provider, without adopting a local override.
 * @param props - renderer-bound catalog hook, refresh callback and locale seat.
 * @returns the catalog card, or its loading/error state.
 */
export function SettingsModelCatalog({ useCatalog, reload, t }: SettingsModelCatalogProps) {
  const state = useCatalog(value => value)
  const [query, setQuery] = useState('')
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
                <span className={css.name}>{model.name}</span>
                <code className={css.modelId}>{model.id}</code>
              </li>)}
            </ul>
          </section>)}
        </div>}
    </>}
  </section>
}
