/** Current-chat creation details; paid work is staged in the ordinary chat draft. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconRefreshOutlineRegular, IconSparkleRegular,
  Menu, Modal, SegmentedControl, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CreativeAssetView, CreativeCharacter, CreativePlanChange, CreativeProjectView, CreativeShotView,
} from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'
import type { CreativeSnapshot } from './controller.ts'
import type { CreativeRecoverResult, CreativeSaveResult, CreativeUploadResult } from './api.ts'
import { Facts, SavedMedia, Status } from './CreativeMedia.tsx'
import { CreativeTasks, StoryboardTimeline, thumbnail } from './CreativePanels.tsx'
import { newPlanEdit, PlanEditor, type PlanEdit } from './PlanEditor.tsx'
import type {} from './locales.ts'
import css from './CreativeBody.module.css'

/** Plain operations and one framework-bound project source owned by this registration. */
export interface CreativeInjected {
  readonly hooks: { readonly creative: HostObservable<CreativeSnapshot> }
  /** @param id - retained project to select across this conversation's creation views. */
  readonly selectProject: (id: string) => void
  /** @param id - shot in the selected project to reveal across this conversation's creation views. */
  readonly selectShot: (id: string) => void
  readonly refresh: () => void
  /** Free, revision-checked plan mutation shared by all creation surfaces. */
  readonly save: (projectId: string, revision: string, change: CreativePlanChange, signal: AbortSignal) => Promise<CreativeSaveResult>
  readonly upload: (file: File, signal: AbortSignal) => Promise<CreativeUploadResult>
  /** Query the retained original task; never submit generation. */
  readonly recover: (projectId: string, operationId: string, signal: AbortSignal) => Promise<CreativeRecoverResult>
  /** @param visible - official tab visibility. @param signal - occurrence lifetime. @returns visibility release. */
  readonly watch: (visible: boolean, signal: AbortSignal) => () => void
  /** @param success - whether revision-guarded insertion was admitted. */
  readonly reportDraft: (success: boolean) => void
  readonly reportSaved: () => void
}

/** Official session/tab props plus localized, injected project reads. */
export type CreativeBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'creative'> & InjectFace<CreativeInjected>
type Translate = TranslateNS<'creative'>
type Section = 'characters' | 'assets' | 'shots' | 'outputs'
type CreativeEdit =
  | { readonly kind: 'shot'; readonly value: CreativeShotView }
  | { readonly kind: 'character'; readonly value: CreativeCharacter }
  | { readonly kind: 'asset'; readonly value: CreativeAssetView }

function editCopy(editing: CreativeEdit, t: Translate): { title: string; label: string; placeholder: string } {
  switch (editing.kind) {
    case 'shot': return { title: t('edit.title', { title: editing.value.title }), label: t('edit.label'), placeholder: t('edit.placeholder') }
    case 'character': return { title: t('character.edit.title', { title: editing.value.name }),
      label: t('character.edit.label'), placeholder: t('character.edit.placeholder') }
    case 'asset': return { title: t('asset.edit.title', { title: editing.value.name }),
      label: t('asset.edit.label'), placeholder: t('asset.edit.placeholder') }
  }
}

function revisionDraft(project: CreativeProjectView, editing: CreativeEdit, changes: string, t: Translate): string {
  switch (editing.kind) {
    case 'shot': return t('draft.edit', { projectId: project.id, shotId: editing.value.id, title: editing.value.title, changes })
    case 'character': return t('draft.character', { projectId: project.id, characterId: editing.value.id,
      title: editing.value.name, referenceIds: JSON.stringify(editing.value.referenceAssetIds), changes })
    case 'asset': {
      const material = project.assets.find(asset => asset.id === editing.value.id) ?? editing.value
      return t('draft.asset', { projectId: project.id, assetId: material.id, title: material.name,
        kind: material.kind, source: JSON.stringify(material.sourcePathOrAssetId),
        references: JSON.stringify((material.outputs ?? []).filter(output => output.kind === 'image').map(output => output.id).reverse()),
        changes })
    }
  }
}

function ReferenceNames({ ids, project, kind }: {
  ids: readonly string[]
  project: CreativeProjectView
  kind: 'assets' | 'characters'
}): string {
  return ids.map(id => project[kind].find(item => item.id === id)?.name ?? id).join(' · ')
}

function CharacterCards({ project, edit, manage, locked, t }: {
  project: CreativeProjectView
  edit: (character: CreativeCharacter) => void
  manage: (edit: PlanEdit) => void
  locked: boolean
  visible: boolean
  t: Translate
}): ReactNode {
  const [query, setQuery] = useState('')
  if (project.characters.length === 0) return <p className={css.hint}>{t('noCharacters')}</p>
  return <div className={css.cards}><input className={css.fieldInput} type="search" aria-label={t('library.search')}
    placeholder={t('library.search')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
  {project.characters.filter(item => `${item.name} ${item.appearance}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(character => <article key={character.id} className={css.card}>
    <div className={css.cardContent}>
      <div className={css.cardHeader}><h3>{character.name}</h3></div>
      <p className={css.compactCaption}>{character.appearance || t('notSpecified')}</p>
      {character.referenceAssetIds.length > 0 && <p className={css.compactCaption}>
        {t('references')} · {ReferenceNames({ ids: character.referenceAssetIds, project, kind: 'assets' })}</p>}
      <details className={css.details}><summary>{t('details')}</summary><Facts t={t} entries={[
        [t('clothing'), character.clothing], [t('personality'), character.personality], [t('voice'), character.voice],
        [t('references'), ReferenceNames({ ids: character.referenceAssetIds, project, kind: 'assets' })],
      ]} /></details>
      <div className={css.actions}><Button variant="outline" size="sm" disabled={locked}
        onClick={() => { manage({ kind: 'character', value: character, adding: false }) }}>{t('plan.uploadCharacter')}</Button>
      <Button variant="outline" size="sm" disabled={locked}
        onClick={() => { manage({ kind: 'character', value: character, adding: false }) }}>{t('plan.edit')}</Button>
      <Button variant="ghost" size="sm" disabled={locked}
        onClick={() => { edit(character) }}>{t('character.edit')}</Button></div>
    </div>
    <div className={css.referenceStrip}>{project.assets.filter(asset => character.referenceAssetIds.includes(asset.id)).map((asset) => {
      const url = thumbnail(asset.outputs ?? []) ?? asset.referenceUrl
      return url === undefined ? null : <img key={asset.id} src={url} alt={asset.name} loading="lazy" />
    })}</div>
  </article>)}</div>
}
function AssetCards({ project, edit, manage, locked, visible, t }: {
  project: CreativeProjectView
  edit: (asset: CreativeAssetView) => void
  manage: (edit: PlanEdit) => void
  locked: boolean
  visible: boolean
  t: Translate
}): ReactNode {
  const [query, setQuery] = useState('')
  if (project.assets.length === 0) return <p className={css.hint}>{t('noAssets')}</p>
  return <div className={css.cards}><input className={css.fieldInput} type="search" aria-label={t('library.search')}
    placeholder={t('library.search')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
  {project.assets.filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(asset => <article key={asset.id} className={css.card}>
    <div className={css.cardContent}><div className={css.cardHeader}><h3>{asset.name}</h3>
      {asset.status !== undefined && <Status value={asset.status} t={t} />}</div>
    <p className={css.compactCaption}>{asset.description || t('notSpecified')}</p>
    {project.characters.some(character => character.referenceAssetIds.includes(asset.id)) && <p className={css.compactCaption}>
      {t('plan.boundCharacters', { names: project.characters.filter(character => character.referenceAssetIds.includes(asset.id))
        .map(character => character.name).join(' · ') })}</p>}
    <details className={css.details}><summary>{t('details')}</summary><Facts t={t} entries={[
      [t('role'), asset.role], [t('source'), asset.sourcePathOrAssetId],
    ]} /></details>
    <div className={css.actions}><Button variant="outline" size="sm" disabled={locked}
      onClick={() => { manage({ kind: 'asset', value: asset, adding: false }) }}>{t('plan.upload')}</Button>
    <Button variant="outline" size="sm" disabled={locked}
      onClick={() => { manage({ kind: 'asset', value: asset, adding: false }) }}>{t('plan.edit')}</Button>
    <Button variant="ghost" size="sm" disabled={locked}
      onClick={() => { edit(asset) }}>{t('asset.edit')}</Button></div>
    </div>
    {(asset.outputs?.length ?? 0) > 0 && <details className={css.details}><summary>{t('library.versions')}</summary>
      {(asset.outputs ?? []).map(output => <SavedMedia key={output.id} output={output} visible={visible} t={t} />)}</details>}
    {(thumbnail(asset.outputs ?? []) ?? asset.referenceUrl) !== undefined && <img className={css.assetThumbnail}
      src={thumbnail(asset.outputs ?? []) ?? asset.referenceUrl} alt={asset.name} loading="lazy" />}
    {asset.status !== undefined && (asset.outputs?.length ?? 0) === 0 && <p className={css.notice}>{t('noOutputs')}</p>}
  </article>)}</div>
}
function ShotCards({ project, edit, manage, redo, locked, visible, t }: {
  project: CreativeProjectView
  edit: (shot: CreativeShotView) => void
  manage: (edit: PlanEdit) => void
  redo: (shot: CreativeShotView) => void
  locked: boolean
  visible: boolean
  t: Translate
}): ReactNode {
  if (project.shots.length === 0) return <p className={css.hint}>{t('noShots')}</p>
  return <div className={css.cards}>{[...project.shots].sort((a, b) => a.order - b.order).map(shot => <article key={shot.id}
    className={css.card} data-creative-shot={shot.id}>
    <div className={css.cardContent}>
      <div className={css.cardHeader}><h3>{t('shot', { order: shot.order })} · {shot.title}</h3><Status value={shot.status} t={t} /></div>
      {shot.durationSeconds !== undefined && <span className={css.status}>{t('duration', { seconds: shot.durationSeconds })}</span>}
      <p className={css.caption}>{shot.scene || shot.action || t('notSpecified')}</p>
      <details className={css.details}><summary>{t('details')}</summary><Facts t={t} entries={[
        [t('camera'), shot.camera], [t('action'), shot.action], [t('prompt'), shot.prompt],
        [t('dialogue'), shot.dialogue], [t('subtitles'), shot.subtitles],
        [t('characters'), ReferenceNames({ ids: shot.characterIds, project, kind: 'characters' })],
        [t('materials'), ReferenceNames({ ids: shot.assetIds, project, kind: 'assets' })],
      ]} /></details>
      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={locked} onClick={() => {
          const { status: _status, outputs: _outputs, actualDurationSeconds: _actual, ...value } = shot
          manage({ kind: 'shot', value, adding: false })
        }}>{t('plan.edit')}</Button>
        <Button variant="outline" size="sm" disabled={locked} onClick={() => { edit(shot) }}>{t('edit')}</Button>
        <Button variant="ghost" size="sm" disabled={locked} onClick={() => { redo(shot) }}>{t('redo')}</Button>
      </div>
    </div>
    {shot.outputs.length === 0 ? <p className={css.notice}>{t('noOutputs')}</p>
      : shot.outputs.map(output => <SavedMedia key={output.id} output={output} visible={visible} t={t} />)}
  </article>)}<p className={css.hint}>{t('draft.notice')}</p></div>
}

/** Plain project workspace: business state stays in the shared controller. */
interface WorkspaceProps {
  readonly sessionId: string | undefined
  readonly snapshot: CreativeSnapshot
  readonly visible: boolean
  readonly locked: boolean
  readonly selectProject: (id: string) => void
  readonly selectShot: (id: string) => void
  readonly refresh: () => void
  readonly save: CreativeInjected['save']
  readonly upload: CreativeInjected['upload']
  readonly recover: CreativeInjected['recover']
  readonly reportSaved: CreativeInjected['reportSaved']
  readonly append: (text: string) => void
  readonly t: Translate
}

function CreativeWorkspace({ sessionId, snapshot, visible, locked, refresh, save, upload, recover,
  reportSaved, selectProject, selectShot, append, t,
}: WorkspaceProps): ReactNode {
  const [section, setSection] = useState<Section>('shots')
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState<CreativeEdit | null>(null)
  const [changes, setChanges] = useState('')
  const [planEdit, setPlanEdit] = useState<{ edit: PlanEdit; project: CreativeProjectView } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailure, setSaveFailure] = useState<string | null>(null)
  const operation = useRef<AbortController | null>(null)
  const tabsId = useId()
  const inputId = useId()
  const project = snapshot.projects.find(item => item.id === snapshot.selectedProjectId) ?? snapshot.projects[0]
  const shot = project?.shots.find(item => item.id === snapshot.selectedShotId)
    ?? [...(project?.shots ?? [])].sort((a, b) => a.order - b.order)[0]
  const dialog = editing === null ? null : editCopy(editing, t)
  useEffect(() => {
    operation.current?.abort(); operation.current = null
    setEditing(null); setChanges(''); setMenu(false); setPlanEdit(null); setSaving(false); setSaveFailure(null)
  }, [sessionId])
  useEffect(() => {
    operation.current?.abort(); operation.current = null
    setEditing(null); setChanges(''); setPlanEdit(null); setSaving(false); setSaveFailure(null)
  }, [project?.id])
  useEffect(() => () => { operation.current?.abort() }, [])
  useEffect(() => { if (!visible) { setEditing(null); setMenu(false) } }, [visible])
  const manage = (edit: PlanEdit): void => {
    if (project === undefined || saving) return
    setSaveFailure(null); setPlanEdit({ edit, project })
  }
  const commit = async (change: CreativePlanChange, base = planEdit?.project ?? project): Promise<void> => {
    if (base === undefined || saving || operation.current !== null) return
    const abort = new AbortController()
    operation.current = abort
    setSaving(true); setSaveFailure(null)
    const result = await save(base.id, base.planRevision, change, abort.signal)
    if (abort.signal.aborted || operation.current !== abort) return
    operation.current = null
    setSaving(false)
    if (result.ok) { setPlanEdit(null); reportSaved() }
    else setSaveFailure(t(result.code === 'stale' ? 'plan.stale' : 'plan.failed'))
  }
  const move = (id: string, direction: -1 | 1): void => {
    if (project === undefined) return
    const ids = [...project.shots].sort((a, b) => a.order - b.order).map(item => item.id)
    const index = ids.indexOf(id)
    const other = index + direction
    const target = ids[other]
    if (index < 0 || target === undefined) return
    ids[other] = id; ids[index] = target
    void commit({ kind: 'reorder', shotIds: ids }, project)
  }
  const redo = (value: CreativeShotView): void => {
    if (project !== undefined) append(t('draft.redo', { projectId: project.id, shotId: value.id, title: value.title }))
  }
  const error = snapshot.failure === 'invalid' ? 'invalid' : 'failed'
  return <div className={css.root} data-creative-session={sessionId}>
    <header className={css.header}><IconSparkleRegular className={css.headerIcon} /><h2 className={css.heading}>{t('title')}</h2>
      <Tooltip label={t('refresh')}><Button variant="toolbar" aria-label={t('refresh')} disabled={snapshot.refreshing}
        onClick={refresh}><IconRefreshOutlineRegular /></Button></Tooltip>
    </header>
    {sessionId === undefined ? <div className={css.empty}><p>{t('chooseSession')}</p></div>
      : snapshot.phase === 'signed-out' ? <div className={css.empty}><p>{t('signedOut')}</p></div>
        : project === undefined ? <div className={css.empty}>
          {snapshot.refreshing ? <StateDot state="ongoing" /> : snapshot.phase === 'failed'
            ? <><p role="alert">{t(error)}</p><Button variant="outline" onClick={refresh}>{t('retry')}</Button></>
            : <><IconSparkleRegular size={28} /><h3>{t('empty.title')}</h3><p>{t('empty.description')}</p></>}
        </div> : <div className={css.body}>
          {snapshot.failure !== null && <p className={css.notice} role="alert">{t(error)}</p>}
          <div className={css.projectPicker}>
            {snapshot.projects.length > 1 ? <Menu open={menu} portal autoFocus selectedId={project.id} onClose={() => { setMenu(false) }}
              items={snapshot.projects.map(item => ({ id: item.id, label: item.title }))}
              onSelect={(id) => {
                const chosen = snapshot.projects.find(item => item.id === id)
                if (chosen !== undefined) selectProject(chosen.id)
                setMenu(false)
              }}
              anchor={<Button variant="ghost" className={css.projectButton} aria-label={t('projects')} onClick={() => { setMenu(!menu) }}>
                <span className={css.truncate}>{project.title}</span><IconChevronDownOutlineRegular /></Button>} />
              : <h3 className={css.heading}>{project.title}</h3>}
            <Status value={project.status} t={t} />
          </div>
          {project.errorCode === 'ARTIFACT_PUBLISH_FAILED' && <p className={css.notice} role="alert">
            {t('artifactPublishFailed')}</p>}
          <details className={css.summary}><summary>{t('brief')}</summary><p>{project.brief}</p><Facts t={t} entries={[[t('style'), project.style]]} /></details>
          <SegmentedControl id={tabsId} className={css.segments} label={t('sections')} value={section} onChange={setSection}
            options={(['shots', 'characters', 'assets', 'outputs'] as const).map(value => ({ value,
              label: value === 'outputs' && project.kind === 'image' ? t('section.images') : t(`section.${value}`) }))} />
          {saveFailure !== null && planEdit === null && <p className={css.notice} role="alert">{saveFailure}</p>}
          <section role="tabpanel" id={`${tabsId}-${section}-panel`} aria-labelledby={`${tabsId}-${section}`}>
            {(section === 'characters' || section === 'assets') && <p className={css.libraryHint}>
              {t(section === 'characters' ? 'plan.characterGuide' : 'plan.assetGuide')}</p>}
            {section !== 'outputs' && <div className={css.libraryToolbar}><Button variant="outline" size="sm" disabled={saving}
              onClick={() => {
                const kind = section === 'shots' ? 'shot' : section === 'characters' ? 'character' : 'asset'
                manage(newPlanEdit(kind, project.shots.length + 1))
              }}>
              {t(section === 'shots' ? 'plan.add.shot' : section === 'characters' ? 'plan.add.character' : 'plan.add.asset')}</Button></div>}
            {section === 'characters' ? <CharacterCards project={project} locked={locked || saving} visible={visible} t={t} manage={manage}
              edit={(value) => { setEditing({ kind: 'character', value }); setChanges('') }} />
              : section === 'assets' ? <AssetCards project={project} locked={locked || saving} visible={visible} t={t} manage={manage}
                edit={(value) => { setEditing({ kind: 'asset', value }); setChanges('') }} />
                : section === 'shots' ? <div className={css.cards}>
                  <StoryboardTimeline shots={project.shots} selected={shot?.id ?? null} select={selectShot}
                    move={move} busy={saving} t={t} />
                  <ShotCards project={{ ...project, shots: shot === undefined ? [] : [shot] }} locked={locked || saving}
                    visible={visible} t={t}
                    manage={manage} edit={(value) => { setEditing({ kind: 'shot', value }); setChanges('') }} redo={redo} />
                </div> : <CreativeTasks key={project.id} project={project} visible={visible} recover={recover} t={t} />}
          </section>
        </div>}
    {planEdit !== null && project !== undefined && <PlanEditor key={`${planEdit.project.id}:${planEdit.edit.kind}:${planEdit.edit.value.id}`}
      project={planEdit.project} edit={planEdit.edit} upload={upload} saving={saving} failure={saveFailure} t={t}
      save={(change) => { void commit(change) }} close={() => { setPlanEdit(null); setSaveFailure(null) }} />}
    {editing !== null && dialog !== null && project !== undefined && <Modal open headless title={dialog.title}
      onClose={() => { setEditing(null) }}>
      <div className={css.editDialog}><h2>{dialog.title}</h2><label htmlFor={inputId}>{dialog.label}</label>
        <textarea id={inputId} data-modal-autofocus className={css.editInput} value={changes} disabled={locked}
          placeholder={dialog.placeholder} onChange={(event) => { setChanges(event.target.value) }} />
        <p className={css.hint}>{t('draft.notice')}</p><div className={css.dialogActions}>
          <Button variant="ghost" onClick={() => { setEditing(null) }}>{t('cancel')}</Button>
          <Button disabled={locked || changes.trim() === ''} onClick={() => {
            append(revisionDraft(project, editing, changes.trim(), t)); setEditing(null)
          }}>{t('edit.apply')}</Button></div>
      </div></Modal>}
  </div>
}

function stageDraft(text: string, locked: boolean, actions: CreativeBodyProps['inputActions'] | undefined,
  report: CreativeInjected['reportDraft']): void {
  const admitted = !locked && actions !== undefined && actions.insertText(`\n\n${text}\n`, actions.captureInsertion())
  if (admitted) actions.persistDraft()
  report(admitted)
}

/** Current-chat sidebar adapter using official tab visibility and ordinary draft actions. */
export function CreativeBody({ sessionId, useTabInfo, useCreative, useInput, inputActions, refresh, save, upload, recover, watch,
  reportDraft, reportSaved, selectProject, selectShot, t,
}: CreativeBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const snapshot = useCreative(value => value)
  const locked = useInput(input => input.phase !== 'plain')
  useEffect(() => watch(tab.visible, tab.signal), [watch, tab.visible, tab.signal])
  useEffect(() => tab.actions.bindCommands({ refresh }), [tab.actions, refresh])
  const append = (text: string): void => { stageDraft(text, locked, inputActions, reportDraft) }
  return <CreativeWorkspace sessionId={sessionId} snapshot={snapshot} visible={tab.visible} locked={locked}
    refresh={refresh} save={save} upload={upload} recover={recover} reportSaved={reportSaved}
    selectProject={selectProject} selectShot={selectShot} append={append} t={t} />
}

/** Tab title shared by the docked strip and floating-window heading. */
export function CreativeTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <><IconSparkleRegular className={css.headerIcon} />{tab.title}</>
}
