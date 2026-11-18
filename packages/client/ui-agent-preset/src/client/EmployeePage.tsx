/** Industry employees from the native preset roster, opening ordinary chat drafts. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconAgentPresetOutlineRegular, IconArchiveOutlineRegular, IconChecklistOutlineRegular,
  IconChevronRightOutlineRegular, IconCodeOutlineRegular, IconDataOutlineRegular, IconDatabaseOutlineRegular,
  IconGlobeOutlineRegular, IconGoalOutlineRegular, IconListPenOutlineRegular, IconNewChatOutlineRegular,
  IconPaperPlaneOutlineRegular, IconPersonalizationOutlineRegular, IconPlanOutlineRegular,
  IconPlayOutlineRegular, IconSearchOutlineRegular, IconShieldOutlineRegular, IconSkillOutlineRegular,
  IconUsersOutlineRegular, IconWorkspaceTreeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentPresetSettingsState } from './settings-store.ts'
import { isBuiltInPreset } from './locales.ts'
import employeeMark from './assets/employees-mark.png'
import css from './EmployeePage.module.css'

// Decorative role artwork belongs to this view, not to the Host preset contract.
const employeeArtwork = new Map([
  ['employee-general-assistant', { icon: IconAgentPresetOutlineRegular, tone: 'blue' }],
  ['employee-ecommerce-operations', { icon: IconArchiveOutlineRegular, tone: 'amber' }],
  ['employee-marketing-planner', { icon: IconGoalOutlineRegular, tone: 'green' }],
  ['employee-video-director', { icon: IconPlayOutlineRegular, tone: 'blue' }],
  ['employee-visual-designer', { icon: IconPersonalizationOutlineRegular, tone: 'amber' }],
  ['employee-customer-service', { icon: IconNewChatOutlineRegular, tone: 'green' }],
  ['employee-sales-consultant', { icon: IconPaperPlaneOutlineRegular, tone: 'blue' }],
  ['employee-product-manager', { icon: IconPlanOutlineRegular, tone: 'neutral' }],
  ['employee-software-engineer', { icon: IconCodeOutlineRegular, tone: 'green' }],
  ['employee-data-analyst', { icon: IconDataOutlineRegular, tone: 'blue' }],
  ['employee-human-resources', { icon: IconUsersOutlineRegular, tone: 'amber' }],
  ['employee-administrative-assistant', { icon: IconListPenOutlineRegular, tone: 'neutral' }],
  ['employee-finance-assistant', { icon: IconDatabaseOutlineRegular, tone: 'green' }],
  ['employee-education-research', { icon: IconSkillOutlineRegular, tone: 'amber' }],
  ['employee-restaurant-operations', { icon: IconChecklistOutlineRegular, tone: 'neutral' }],
  ['employee-travel-planner', { icon: IconGlobeOutlineRegular, tone: 'green' }],
  ['employee-real-estate-advisor', { icon: IconWorkspaceTreeOutlineRegular, tone: 'blue' }],
  ['employee-legal-assistant', { icon: IconShieldOutlineRegular, tone: 'neutral' }],
])
const customArtwork = { icon: IconAgentPresetOutlineRegular, tone: 'neutral' }

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
  const searchInput = useRef<HTMLInputElement>(null)
  useEffect(() => { void load() }, [load])
  const employees = state.options.filter(preset => !isBuiltInPreset(preset)).map(preset => ({
    ...preset,
    name: preset.name?.trim() || preset.id,
    description: preset.description?.trim() || '',
  }))
  const search = query.trim().toLocaleLowerCase()
  const visible = employees.filter(preset => `${preset.name} ${preset.description}`.toLocaleLowerCase().includes(search))
  const loading = state.status === 'idle' || state.status === 'loading'
  const failed = state.status === 'error'
  const groups = [
    { title: t('employeesBuiltIn'), rows: visible.filter(preset => preset.id.startsWith('employee-')) },
    { title: t('employeesMine'), rows: visible.filter(preset => !preset.id.startsWith('employee-')) },
  ]
  return <section className={css.page} aria-label={t('employeesTitle')} aria-busy={loading}>
    <div className={css.content}>
      <header className={css.header}>
        <span className={css.pageArtwork} aria-hidden="true"><img src={employeeMark} alt="" width={56} height={56} draggable={false} /></span>
        <div className={css.headingCopy}>
          <h1>{t('employeesTitle')}</h1>
          <p>{t('employeesIntro')}</p>
        </div>
        {!customEmployeeAvailable ? null
          : <Button className={css.customize} onClick={openCustomEmployee}>{t('employeesCustomize')}</Button>}
      </header>
      <div className={css.toolbar}>
        <div className={css.search}>
          <span aria-hidden="true"><IconSearchOutlineRegular size={16} /></span>
          <input ref={searchInput} type="search" value={query} aria-label={t('employeesSearch')}
            placeholder={t('employeesSearch')} onChange={(event) => { setQuery(event.target.value) }} />
          {query.length === 0 ? null : <Button size="sm" className={css.clearSearch} onClick={() => {
            setQuery('')
            searchInput.current?.focus()
          }}>{t('employeesClearSearch')}</Button>}
        </div>
        {(loading || failed) && employees.length === 0 ? null
          : <p className={css.resultCount} aria-live="polite">{t(search ? 'employeesResultCount' : 'employeesCount', { count: visible.length })}</p>}
      </div>
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
          <h2 className={css.groupTitle}>{group.title}<span className={css.groupCount}>{group.rows.length}</span></h2>
          <ul className={css.cards} aria-label={group.title}>
            {group.rows.map((employee) => {
              const name = employee.name
              const description = employee.description || t('noDescription')
              const artwork = employeeArtwork.get(employee.id) ?? customArtwork
              const RoleIcon = artwork.icon
              return <li key={employee.id} className={css.card}>
                <div className={css.cardHeading}>
                  <span className={css.employeeIcon} data-tone={artwork.tone} aria-hidden="true"><RoleIcon size={21} /></span>
                  <h3 title={name}>{name}</h3>
                </div>
                <p className={css.description} title={description}>{description}</p>
                <Button className={css.start} size="sm" variant="outline" aria-label={t('employeesStartNamed', { name })}
                  onClick={() => { startEmployeeDraft(employee.id) }}>{t('employeesStart')}<span aria-hidden="true"><IconChevronRightOutlineRegular size={14} /></span></Button>
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
