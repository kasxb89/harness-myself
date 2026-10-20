/** Industry employees from the native preset roster, opening ordinary chat drafts. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconSearchOutlineRegular, IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentPresetSettingsState } from './settings-store.ts'
import { isBuiltInPreset } from './locales.ts'
import css from './EmployeePage.module.css'

/** Shared roster and the existing conversation's new-draft action. */
export interface EmployeePageInjected {
  /** The same host roster displayed by the conversation preset picker. */
  hooks: {
    /** Native preset roster shared with conversation controls. */
    agentPresets: SnapshotStore<AgentPresetSettingsState>
    /** Whether the installed editor has registered its actual settings section. */
    customEmployeeAvailable: ObservableSnapshot<boolean>
  }
  /** Reload the native preset roster without changing session settings. */
  load: () => Promise<void>
  /** Stage this employee for a blank chat; preserve unsent drafts and send no message. */
  startEmployeeDraft: (id: string) => void
  /** Open the installed employee editor's actual settings section, without creating or copying a preset. */
  openCustomEmployee: () => void
}

/** Main-panel context, native roster actions, and locale-owned page copy. */
export type EmployeePageProps = PropsRuntime<'main'> & PropsLocale<'settings.agentPreset'> & InjectFace<EmployeePageInjected>

/**
 * Browse and search employee presets while keeping their execution in the existing chat flow.
 * @param props - Bound roster snapshot, loading action, new-draft action and translations.
 * @returns Searchable employee cards or the loading, retry or empty state.
 */
export function EmployeePage({
  useAgentPresets, useCustomEmployeeAvailable, load, startEmployeeDraft, openCustomEmployee, t,
}: EmployeePageProps) {
  const state = useAgentPresets(value => value)
  const customEmployeeAvailable = useCustomEmployeeAvailable(value => value)
  const [query, setQuery] = useState('')
  useEffect(() => { void load() }, [load])
  const employees = state.options.filter(preset => !isBuiltInPreset(preset))
  const search = query.trim().toLocaleLowerCase()
  const visible = employees.filter(preset => `${preset.name ?? preset.id} ${preset.description ?? ''}`.toLocaleLowerCase().includes(search))
  const loading = state.status === 'idle' || state.status === 'loading'
  const failed = state.status === 'error'
  const groups = [
    { title: t('employeesBuiltIn'), rows: visible.filter(preset => preset.id.startsWith('employee-')) },
    { title: t('employeesMine'), rows: visible.filter(preset => !preset.id.startsWith('employee-')) },
  ]
  return <section className={css.page} aria-label={t('employeesTitle')} aria-busy={loading}>
    <div className={css.content}>
      <header className={css.header}>
        <span className={css.pageIcon} aria-hidden="true"><IconUsersOutlineRegular size={28} /></span>
        <div className={css.headingCopy}>
          <h1>{t('employeesTitle')}</h1>
          <p>{t('employeesIntro')}</p>
        </div>
        {!customEmployeeAvailable ? null
          : <Button className={css.customize} onClick={openCustomEmployee}>{t('employeesCustomize')}</Button>}
      </header>
      <p className={css.capabilities}>{t('employeesCapabilities')}</p>
      <label className={css.search}>
        <IconSearchOutlineRegular size={16} />
        <input type="search" value={query} aria-label={t('employeesSearch')}
          placeholder={t('employeesSearch')} onChange={(event) => { setQuery(event.target.value) }} />
      </label>
      {failed ? <div className={css.notice} role="alert">
        <span>{t('employeesLoadFailed')}</span>
        <Button variant="ghost" onClick={() => { void load() }}>{t('employeesRetry')}</Button>
      </div> : null}
      {loading && employees.length === 0 ? <div role="status" aria-label={t('employeesLoading')}>
        <div className={css.cards} aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className={css.skeleton} />)}
        </div>
      </div> : null}
      {visible.length > 0 ? <div role="group" aria-label={t('employeesList')}>
        {groups.filter(group => group.rows.length > 0).map(group => <section className={css.group} key={group.title}>
          <h2 className={css.groupTitle}>{group.title}</h2>
          <ul className={css.cards} aria-label={group.title}>
            {group.rows.map((employee) => {
              const name = employee.name ?? employee.id
              return <li key={employee.id} className={css.card}>
                <div className={css.cardHeading}>
                  <span className={css.employeeIcon} aria-hidden="true"><IconUsersOutlineRegular size={20} /></span>
                  <h3 title={name}>{name}</h3>
                </div>
                <p className={css.description} title={employee.description}>{employee.description ?? t('noDescription')}</p>
                <Button className={css.start} aria-label={t('employeesStartNamed', { name })}
                  onClick={() => { startEmployeeDraft(employee.id) }}>{t('employeesStart')}</Button>
              </li>
            })}
          </ul>
        </section>)}
      </div> : null}
      {!loading && !failed && visible.length === 0 ? <div className={css.empty} role="status">
        <IconUsersOutlineRegular size={28} />
        <h2>{t(employees.length === 0 ? 'employeesEmpty' : 'employeesNoResults')}</h2>
        <p>{t(employees.length === 0 ? 'employeesEmptyHint' : 'employeesNoResultsHint')}</p>
      </div> : null}
    </div>
  </section>
}

/**
 * Use the shared people glyph for the employee sidebar entry.
 * @param _props - Sidebar panel-list context supplied by the shell.
 * @returns The existing people icon.
 */
export function EmployeePanelIcon(_props: PropsRuntime<'sidebar.panellist'>) {
  return <IconUsersOutlineRegular size={18} />
}
