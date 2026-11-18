/** Real administrator-published profiles, with local viewing filters only. */
import { useState, type ReactNode } from 'react'
import { Button, Input, Pill, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemandPageState } from './types.ts'
import { DemandEmpty, DemandSkeleton, EngineerAvatar, EngineerPresence, engineerName, type DemandTranslate } from './DemandUI.tsx'
import css from './DemandPage.module.css'

/**
 * Filter actual people without adding sample profiles to an empty deployment.
 * @param props - Published profiles, start callback and localized labels.
 * @returns Searchable engineer profiles or the appropriate list state.
 */
export function EngineerDirectory(props: {
  state: DemandPageState
  start: (id: string) => void
  t: DemandTranslate
}): ReactNode {
  const { state, start, t } = props
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const selectedCategory = state.categories.some(row => row.id === category) ? category : ''
  const search = query.trim().toLocaleLowerCase()
  const visible = state.engineers.filter((engineer) => {
    if (selectedCategory !== '' && !engineer.categoryIds.includes(selectedCategory)) return false
    const domains = state.categories.filter(row => engineer.categoryIds.includes(row.id)).map(row => row.label)
    return [engineer.displayName, engineer.introduction, ...engineer.skills, ...domains].join(' ').toLocaleLowerCase().includes(search)
  })
  const initialLoading = state.availability === 'loading' && state.engineers.length === 0
  return <div className={css.directory}>
    <div className={css.directoryToolbar}>
      <div className={css.searchField}>
        <Input type="search" value={query} aria-label={t('searchEngineers')} placeholder={t('searchEngineers')}
          onChange={(event) => { setQuery(event.target.value) }} icon={<IconSearchOutlineRegular size={16} />} />
        {query === '' ? null : <Button size="sm" onClick={() => { setQuery('') }}>{t('clearSearch')}</Button>}
      </div>
      {initialLoading || (state.engineers.length === 0 && state.availability !== 'ready') ? null
        : <span className={css.resultCount} aria-live="polite">{t('engineerCount', { count: visible.length })}</span>}
    </div>
    {state.categories.length === 0 ? null : <div className={css.filters}>
      <Pill active={selectedCategory === ''} onClick={() => { setCategory('') }} aria-pressed={selectedCategory === ''}>
        {t('allCategories')}
      </Pill>
      {state.categories.map(row => <Pill key={row.id} active={selectedCategory === row.id}
        aria-pressed={selectedCategory === row.id} onClick={() => { setCategory(row.id) }}>{row.label}</Pill>)}
    </div>}
    {initialLoading ? <DemandSkeleton label={t('loading')} /> : null}
    {visible.length === 0 ? null : <ul className={css.engineerGrid}>
      {visible.map((engineer) => {
        const name = engineerName(engineer, t)
        const domains = state.categories.filter(row => engineer.categoryIds.includes(row.id)).map(row => row.label)
        const skills = [...new Set([...domains, ...engineer.skills])]
        return <li key={engineer.id} className={css.engineerCard}>
          <div className={css.engineerIdentity}><EngineerAvatar engineer={engineer} />
            <div><h2>{name}</h2><EngineerPresence engineer={engineer} t={t} /></div>
          </div>
          {engineer.introduction.trim() === '' ? null : <p className={css.engineerIntro}>{engineer.introduction}</p>}
          {skills.length === 0 ? null : <div className={css.skills}>{skills.map(skill => <span key={skill}>{skill}</span>)}</div>}
          <div className={css.engineerAction}>
            {engineer.canStart || !engineer.unavailableReason ? null : <p>{engineer.unavailableReason}</p>}
            <Button variant="outline" disabled={!engineer.canStart} aria-label={t('startRequestNamed', { name })}
              onClick={() => { start(engineer.id) }}>{t(engineer.canStart ? 'startRequest' : 'notAccepting')}</Button>
          </div>
        </li>
      })}
    </ul>}
    {initialLoading || visible.length > 0 || (state.availability !== 'ready' && state.engineers.length === 0) ? null
      : <DemandEmpty people title={t(state.engineers.length === 0 ? 'noEngineers' : 'noMatches')}
        detail={t(state.engineers.length === 0 ? 'noEngineersHint' : 'noMatchesHint')} />}
  </div>
}
