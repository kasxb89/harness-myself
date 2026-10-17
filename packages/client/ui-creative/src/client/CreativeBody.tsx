/** Current-chat creation details; paid work is staged in the ordinary chat draft. */
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconRefreshOutlineRegular, IconSparkleRegular,
  ImageLightbox, Menu, Modal, SegmentedControl, StateDot, Tooltip, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CreativeAssetView, CreativeCharacter, CreativeOutput, CreativeProjectId, CreativeProjectView, CreativeShotView, CreativeStatus,
} from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'
import type { CreativeSnapshot } from './controller.ts'
import type {} from './locales.ts'
import css from './CreativeBody.module.css'

/** Plain operations and one framework-bound project source owned by this registration. */
export interface CreativeInjected {
  readonly hooks: { readonly creative: HostObservable<CreativeSnapshot> }
  readonly refresh: () => void
  /** @param visible - official tab visibility. @param signal - occurrence lifetime. @returns visibility release. */
  readonly watch: (visible: boolean, signal: AbortSignal) => () => void
  /** @param success - whether revision-guarded insertion was admitted. */
  readonly reportDraft: (success: boolean) => void
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

function dot(status: CreativeStatus): StateDotState {
  switch (status) {
    case 'completed': return 'done'
    case 'running': case 'saving': case 'editing': return 'ongoing'
    case 'failed': return 'error'
    case 'interrupted': case 'unknown': return 'warning'
    case 'planned': case 'cancelled': return 'idle'
  }
}
function Status({ value, t }: { value: CreativeStatus; t: Translate }): ReactNode {
  return <span className={css.status} role="status"><StateDot state={dot(value)} />{t(`status.${value}`)}</span>
}
function Facts({ entries, t }: { entries: readonly (readonly [string, string])[]; t: Translate }): ReactNode {
  return <dl className={css.facts}>{entries.map(([label, value]) => <div key={label}>
    <dt>{label}</dt><dd>{value || t('notSpecified')}</dd>
  </div>)}</dl>
}
function timecode(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000)
  const minutes = Math.floor(milliseconds / 60_000)
  const rest = (milliseconds % 60_000) / 1000
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`
}
function ReferenceNames({ ids, project, kind }: {
  ids: readonly string[]
  project: CreativeProjectView
  kind: 'assets' | 'characters'
}): string {
  return ids.map(id => project[kind].find(item => item.id === id)?.name ?? id).join(' · ')
}

function SavedMedia({ output, visible, t }: { output: CreativeOutput; visible: boolean; t: Translate }): ReactNode {
  const [failed, setFailed] = useState(false)
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null)
  const frames = output.kind === 'video' ? output.frames ?? [] : []
  useEffect(() => { setFailed(false); setPreview(null) }, [output.url])
  useEffect(() => { if (!visible) setPreview(null) }, [visible])
  return <figure className={css.media} data-creative-output={output.kind}>
    {failed ? <p className={css.notice}>{t('mediaFailed')}</p>
      : output.kind === 'image'
        ? <button type="button" className={css.imageButton} aria-label={t('preview')}
          onClick={() => { setPreview({ url: output.url, name: output.name }) }}>
          <img src={output.url} alt={output.name} loading="lazy" onError={() => { setFailed(true) }} />
        </button>
        : output.kind === 'video'
          ? <video controls preload="metadata" src={output.url} poster={output.posterUrl} aria-label={output.name}
            onError={() => { setFailed(true) }} />
          : <audio controls preload="metadata" src={output.url} aria-label={output.name} onError={() => { setFailed(true) }} />}
    <figcaption className={css.mediaFooter}>
      <span className={css.mediaName}>{output.name}</span>
      <a className={css.download} href={output.url} download={output.name}>{t('download')}</a>
    </figcaption>
    {output.kind === 'video' && (frames.length > 0 ? <>
      <h4 className={css.frameTitle}>{t('frames')}</h4>
      <div className={css.frames}>{frames.map((frame, index) => <figure className={css.frame} key={`${index}:${frame.url}`}>
        <button type="button" className={css.imageButton} aria-label={t('frame', { name: output.name, time: timecode(frame.timeSeconds) })}
          onClick={() => { setPreview({ url: frame.url, name: t('frame', { name: output.name, time: timecode(frame.timeSeconds) }) }) }}>
          <img src={frame.url} loading="lazy" alt={t('frame', { name: output.name, time: timecode(frame.timeSeconds) })} />
        </button><figcaption>{timecode(frame.timeSeconds)}</figcaption>
      </figure>)}</div>
    </> : <p className={css.notice}>{t(output.previewUnavailable === true ? 'framesUnavailable' : 'framePending')}</p>)}
    {preview !== null && <ImageLightbox src={preview.url} alt={preview.name}
      labels={{ dialog: t('preview'), close: t('close') }} onClose={() => { setPreview(null) }} />}
  </figure>
}

function CharacterCards({ project, edit, locked, visible, t }: {
  project: CreativeProjectView
  edit: (character: CreativeCharacter) => void
  locked: boolean
  visible: boolean
  t: Translate
}): ReactNode {
  if (project.characters.length === 0) return <p className={css.hint}>{t('noCharacters')}</p>
  return <div className={css.cards}>{project.characters.map(character => <article key={character.id} className={css.card}>
    <div className={css.cardContent}>
      <div className={css.cardHeader}><h3>{character.name}</h3></div>
      <p className={css.caption}>{character.appearance || t('notSpecified')}</p>
      <details className={css.details}><summary>{t('details')}</summary><Facts t={t} entries={[
        [t('clothing'), character.clothing], [t('personality'), character.personality], [t('voice'), character.voice],
        [t('references'), ReferenceNames({ ids: character.referenceAssetIds, project, kind: 'assets' })],
      ]} /></details>
      <div className={css.actions}><Button variant="outline" size="sm" disabled={locked}
        onClick={() => { edit(character) }}>{t('character.edit')}</Button></div>
    </div>
    {project.assets.filter(asset => character.referenceAssetIds.includes(asset.id)).flatMap(asset => (asset.outputs ?? [])
      .filter(output => output.kind === 'image')
      .map(output => <SavedMedia key={`${asset.id}:${output.id}`} output={output} visible={visible} t={t} />))}
  </article>)}</div>
}
function AssetCards({ project, edit, locked, visible, t }: {
  project: CreativeProjectView
  edit: (asset: CreativeAssetView) => void
  locked: boolean
  visible: boolean
  t: Translate
}): ReactNode {
  if (project.assets.length === 0) return <p className={css.hint}>{t('noAssets')}</p>
  return <div className={css.cards}>{project.assets.map(asset => <article key={asset.id} className={css.card}>
    <div className={css.cardContent}><div className={css.cardHeader}><h3>{asset.name}</h3>
      {asset.status !== undefined && <Status value={asset.status} t={t} />}</div>
    <p className={css.caption}>{asset.description || t('notSpecified')}</p>
    <details className={css.details}><summary>{t('details')}</summary><Facts t={t} entries={[
      [t('role'), asset.role], [t('source'), asset.sourcePathOrAssetId],
    ]} /></details>
    <div className={css.actions}><Button variant="outline" size="sm" disabled={locked}
      onClick={() => { edit(asset) }}>{t('asset.edit')}</Button></div>
    </div>
    {(asset.outputs ?? []).map(output => <SavedMedia key={output.id} output={output} visible={visible} t={t} />)}
    {asset.status !== undefined && (asset.outputs?.length ?? 0) === 0 && <p className={css.notice}>{t('noOutputs')}</p>}
  </article>)}</div>
}
function ShotCards({ project, edit, redo, locked, visible, t }: {
  project: CreativeProjectView
  edit: (shot: CreativeShotView) => void
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
        <Button variant="outline" size="sm" disabled={locked} onClick={() => { edit(shot) }}>{t('edit')}</Button>
        <Button variant="ghost" size="sm" disabled={locked} onClick={() => { redo(shot) }}>{t('redo')}</Button>
      </div>
    </div>
    {shot.outputs.length === 0 ? <p className={css.notice}>{t('noOutputs')}</p>
      : shot.outputs.map(output => <SavedMedia key={output.id} output={output} visible={visible} t={t} />)}
  </article>)}<p className={css.hint}>{t('draft.notice')}</p></div>
}

/** Current-chat project browser using only framework-bound observables and ordinary draft insertion. */
export function CreativeBody({
  sessionId, useTabInfo, useCreative, useInput, inputActions, refresh, watch, reportDraft, t,
}: CreativeBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const snapshot = useCreative(value => value)
  const locked = useInput(input => input.phase !== 'plain')
  const [selected, setSelected] = useState<CreativeProjectId | null>(null)
  const [section, setSection] = useState<Section>('shots')
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState<CreativeEdit | null>(null)
  const [changes, setChanges] = useState('')
  const tabsId = useId()
  const inputId = useId()
  useEffect(() => watch(tab.visible, tab.signal), [watch, tab.visible, tab.signal])
  useEffect(() => tab.actions.bindCommands({ refresh }), [tab.actions, refresh])
  useEffect(() => { setSelected(null); setEditing(null); setChanges(''); setMenu(false) }, [sessionId])
  useEffect(() => { if (!tab.visible) { setEditing(null); setMenu(false) } }, [tab.visible])
  const project = snapshot.projects.find(item => item.id === selected) ?? snapshot.projects[0]
  const dialog = editing === null ? null : editCopy(editing, t)
  useEffect(() => { setEditing(null); setChanges('') }, [project?.id])
  const append = (text: string): void => {
    const admitted = !locked && inputActions.insertText(`\n\n${text}\n`, inputActions.captureInsertion())
    if (admitted) inputActions.persistDraft()
    reportDraft(admitted)
  }
  const redo = (shot: CreativeShotView): void => {
    if (project === undefined) return
    append(t('draft.redo', { projectId: project.id, shotId: shot.id, title: shot.title }))
  }
  const error = snapshot.failure === 'invalid' ? 'invalid' : 'failed'
  return <div className={css.root} data-creative-session={sessionId}>
    <header className={css.header}><IconSparkleRegular className={css.headerIcon} /><h2 className={css.heading}>{t('title')}</h2>
      <Tooltip label={t('refresh')}><Button variant="toolbar" aria-label={t('refresh')} disabled={snapshot.refreshing}
        onClick={refresh}><IconRefreshOutlineRegular /></Button></Tooltip>
    </header>
    {snapshot.phase === 'signed-out' ? <div className={css.empty}><p>{t('signedOut')}</p></div>
      : project === undefined
        ? <div className={css.empty}>
          {snapshot.refreshing ? <StateDot state="ongoing" /> : snapshot.phase === 'failed'
            ? <><p role="alert">{t(error)}</p><Button variant="outline" onClick={refresh}>{t('retry')}</Button></>
            : <><IconSparkleRegular size={28} /><h3>{t('empty.title')}</h3><p>{t('empty.description')}</p></>}
        </div>
        : <div className={css.body}>
          {snapshot.failure !== null && <p className={css.notice} role="alert">{t(error)}</p>}
          <div className={css.projectPicker}>
            {snapshot.projects.length > 1
              ? <Menu open={menu} portal autoFocus selectedId={project.id} onClose={() => { setMenu(false) }}
                items={snapshot.projects.map(item => ({ id: item.id, label: item.title }))}
                onSelect={(id) => {
                  const chosen = snapshot.projects.find(item => item.id === id)
                  if (chosen !== undefined) setSelected(chosen.id)
                  setMenu(false)
                  setEditing(null)
                }}
                anchor={<Button variant="ghost" className={css.projectButton} aria-label={t('projects')}
                  onClick={() => { setMenu(!menu) }}>
                  <span className={css.truncate}>{project.title}</span><IconChevronDownOutlineRegular />
                </Button>} />
              : <h3 className={css.heading}>{project.title}</h3>}
            <Status value={project.status} t={t} />
          </div>
          <details className={css.summary}><summary>{t('brief')}</summary>
            <p>{project.brief}</p><Facts t={t} entries={[[t('style'), project.style]]} />
          </details>
          <SegmentedControl id={tabsId} className={css.segments} label={t('sections')} value={section} onChange={setSection}
            options={(['characters', 'assets', 'shots', 'outputs'] as const).map(value => ({
              value, label: value === 'outputs' && project.kind === 'image' ? t('section.images') : t(`section.${value}`),
            }))} />
          <section role="tabpanel" id={`${tabsId}-${section}-panel`} aria-labelledby={`${tabsId}-${section}`}>
            {section === 'characters' ? <CharacterCards project={project} locked={locked} visible={tab.visible} t={t}
              edit={(character) => { setEditing({ kind: 'character', value: character }); setChanges('') }} />
              : section === 'assets' ? <AssetCards project={project} locked={locked} visible={tab.visible} t={t}
                edit={(asset) => { setEditing({ kind: 'asset', value: asset }); setChanges('') }} />
                : section === 'shots' ? <ShotCards project={project} locked={locked} visible={tab.visible} t={t}
                  edit={(shot) => { setEditing({ kind: 'shot', value: shot }); setChanges('') }} redo={redo} />
                  : <div className={css.cards}>
                    {project.kind === 'video' && <div className={css.verification}>
                      <p>{t('verify.pending')}</p><p>{t('verify.description')}</p>
                    </div>}
                    {project.outputs.length === 0 ? <p className={css.hint}>{t('noOutputs')}</p>
                      : project.outputs.map(output => <article className={css.card} key={output.id}>
                        <SavedMedia output={output} visible={tab.visible} t={t} />
                      </article>)}
                  </div>}
          </section>
        </div>}
    {editing !== null && dialog !== null && project !== undefined && <Modal open headless title={dialog.title}
      onClose={() => { setEditing(null) }}>
      <div className={css.editDialog}>
        <h2>{dialog.title}</h2><label htmlFor={inputId}>{dialog.label}</label>
        <textarea id={inputId} data-modal-autofocus className={css.editInput} value={changes} disabled={locked}
          placeholder={dialog.placeholder} onChange={(event) => { setChanges(event.target.value) }} />
        <p className={css.hint}>{t('draft.notice')}</p>
        <div className={css.dialogActions}><Button variant="ghost" onClick={() => { setEditing(null) }}>{t('cancel')}</Button>
          <Button disabled={locked || changes.trim() === ''} onClick={() => {
            append(revisionDraft(project, editing, changes.trim(), t))
            setEditing(null)
          }}>{t('edit.apply')}</Button></div>
      </div>
    </Modal>}
  </div>
}

/** Tab title shared by the docked strip and floating-window heading. */
export function CreativeTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <><IconSparkleRegular className={css.headerIcon} />{tab.title}</>
}
