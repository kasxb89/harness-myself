/** Chat project navigation and actual operation outputs. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconSparkleRegular, productFailureKind } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CreativeOutput, CreativeProjectView, CreativeShotView, CreativeStatus, CreativeTaskView,
} from '@deepseek-ai/dsh-credits-index/src/creative-types.ts'
import { Facts, SavedMedia, Status, timecode } from './CreativeMedia.tsx'
import type { CreativeInjected } from './CreativeBody.tsx'
import type {} from './locales.ts'
import css from './CreativeBody.module.css'

type Translate = TranslateNS<'creative'>
/**
 * Choose a real image or extracted frame; prompts are never substitute previews.
 * @param outputs - saved outputs in creation order.
 * @returns a thumbnail URL when an actual preview exists.
 */
export function thumbnail(outputs: readonly CreativeOutput[]): string | undefined {
  for (const output of [...outputs].reverse()) {
    if (output.kind === 'image') return output.url
    if (output.posterUrl !== undefined) return output.posterUrl
    if (output.frames?.[0] !== undefined) return output.frames[0].url
  }
  return undefined
}

/** Ordered thumbnail timeline, using explicitly planned rather than measured timings. */
export function StoryboardTimeline({ shots, selected, select, move, busy, t }: {
  shots: readonly CreativeShotView[]
  selected: string | null
  select: (id: string) => void
  move: (id: string, direction: -1 | 1) => void
  busy: boolean
  t: Translate
}): ReactNode {
  let elapsed: number | null = 0
  const ordered = [...shots].sort((a, b) => a.order - b.order)
  return <div className={css.storyboard}>
    <div className={css.sectionHeading}><h3>{t('timeline.title')}</h3><span className={css.status}>{t('timeline.planned')}</span></div>
    <div className={css.timeline} role="list" aria-label={t('timeline.title')}>
      {ordered.map((shot, index) => {
        const start = elapsed
        elapsed = elapsed === null || shot.durationSeconds === undefined ? null : elapsed + shot.durationSeconds
        const poster = thumbnail(shot.outputs)
        return <div key={shot.id} className={css.timelineItem} role="listitem" data-selected={selected === shot.id}>
          <button type="button" className={css.timelineSelect} aria-pressed={selected === shot.id}
            aria-label={t('timeline.select', { title: shot.title })} onClick={() => { select(shot.id) }}>
            <div className={css.shotThumbnail}>{poster === undefined ? <IconSparkleRegular size={24} />
              : <img src={poster} alt="" loading="lazy" />}
            <span className={css.shotNumber}>{index + 1}</span>
            <span className={css.shotState}><Status value={shot.status} compact t={t} /></span>
            </div>
            <span className={css.timelineName}>{shot.title}</span>
            <span className={css.timeRange}>{start === null ? t('notSpecified') : timecode(start)} — {elapsed === null
              ? t('notSpecified') : timecode(elapsed)}</span>
            <span className={css.status}>{shot.durationSeconds === undefined ? t('notSpecified')
              : t('duration', { seconds: shot.durationSeconds })}</span>
          </button>
          <div className={css.timelineActions}>
            <Button variant="ghost" size="sm" disabled={busy || index === 0}
              aria-label={t('timeline.previous', { title: shot.title })} onClick={() => { move(shot.id, -1) }}>{t('timeline.moveUp')}</Button>
            <Button variant="ghost" size="sm" disabled={busy || index === ordered.length - 1}
              aria-label={t('timeline.next', { title: shot.title })} onClick={() => { move(shot.id, 1) }}>{t('timeline.moveDown')}</Button>
          </div>
        </div>
      })}
    </div>
  </div>
}

function OutputGallery({ outputs, visible, t }: { outputs: readonly CreativeOutput[]; visible: boolean; t: Translate }): ReactNode {
  const [selected, setSelected] = useState<string | null>(null)
  const output = outputs.find(item => item.id === selected) ?? outputs[0]
  return <div className={css.cards}>
    <div className={css.outputGrid}>{outputs.map((item) => {
      const poster = thumbnail([item])
      return <button type="button" key={item.id} className={css.outputTile} aria-pressed={output?.id === item.id}
        aria-label={t('tasks.selectOutput', { name: item.name })} onClick={() => { setSelected(item.id) }}>
        <div className={css.outputThumbnail}>{poster === undefined ? <IconSparkleRegular size={24} />
          : <img src={poster} alt="" loading="lazy" />}</div>
        <span className={css.timelineName}>{item.name}</span><span className={css.status}>{t(`kind.${item.kind}`)}</span>
      </button>
    })}</div>
    {output !== undefined && <article className={css.card}><SavedMedia output={output} visible={visible} t={t} /></article>}
  </div>
}

function TaskCard({ task, order, project, kind, visible, recover, t }: {
  task: CreativeTaskView
  order: number
  project: CreativeProjectView
  kind: CreativeOutput['kind'] | 'all'
  visible: boolean
  recover: CreativeInjected['recover']
  t: Translate
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [querying, setQuerying] = useState(false)
  const [queryFailed, setQueryFailed] = useState(false)
  const receipt = task.imageReceipt ?? task.videoReceipt
  const query = useRef<AbortController | null>(null)
  useEffect(() => () => { query.current?.abort(); query.current = null }, [])
  useEffect(() => {
    if (!visible) { query.current?.abort(); query.current = null; setQuerying(false); setQueryFailed(false) }
  }, [visible])
  const recoverOriginal = async (): Promise<void> => {
    if (task.canQuery !== true || query.current !== null) return
    const abort = new AbortController()
    query.current = abort
    setQuerying(true); setQueryFailed(false)
    try {
      const result = await recover(project.id, task.id, abort.signal)
      if (!abort.signal.aborted) setQueryFailed(!result.ok)
    } catch (_queryFailure) {
      if (!abort.signal.aborted) setQueryFailed(true)
    } finally {
      if (query.current === abort) { query.current = null; setQuerying(false) }
    }
  }
  const publicationFailed = task.errorCode === 'ARTIFACT_PUBLISH_FAILED'
  const failureKind = productFailureKind(task.errorCode)
  const failureText = failureKind === 'insufficient-credits' ? t('creditsRequired')
    : failureKind === 'sign-in' || failureKind === 'signed-out' ? t('signedOut')
      : failureKind === 'cancelled' ? t('status.cancelled') : t('serverBusy')
  const outputs = task.outputs.filter(output => kind === 'all' || output.kind === kind)
  const names = task.shotIds.map(id => project.shots.find(shot => shot.id === id)?.title ?? t('tasks.removedShot'))
  const material = task.assetId === undefined ? t('tasks.project')
    : project.assets.find(asset => asset.id === task.assetId)?.name ?? t('tasks.removedAsset')
  return <article className={css.card} data-creative-task={task.id}>
    <div className={css.cardContent}>
      <div className={css.cardHeader}><h3>{t('tasks.operation', { order })}</h3><Status value={task.status} t={t} /></div>
      <p className={css.compactCaption}>{names.join(' · ') || material}</p>
      <div className={css.sectionHeading}>
        {task.totalShots > 0 && <span className={css.status}>
          {t('tasks.progress', { completed: task.completedShots, total: task.totalShots })}</span>}
        <span className={css.status}>{t('tasks.outputCount', { count: task.outputs.length })}</span>
      </div>
      {task.totalShots > 0 && <progress max={task.totalShots} value={task.completedShots}
        aria-label={t('tasks.progress', { completed: task.completedShots, total: task.totalShots })} />}
      {publicationFailed ? <p className={css.notice} role="alert">{t('artifactPublishFailed')}</p>
        : task.status === 'failed' && <p className={css.hint}>{failureText} {t('tasks.failed')}</p>}
      {task.status === 'unknown' && <p className={css.notice}>{t(receipt?.phase === 'accepted'
        ? 'tasks.acceptedUnconfirmed' : receipt?.phase === 'completed' ? 'tasks.resultUnsaved' : 'tasks.unknownNoReceipt')}</p>}
      {task.canQuery === true && <div className={css.actions}><Button variant="outline" size="sm" disabled={querying}
        onClick={() => { void recoverOriginal() }}>{t(querying ? 'tasks.querying' : 'tasks.queryOriginal')}</Button></div>}
      {queryFailed && <p className={css.notice} role="alert">{t('tasks.queryFailed')}</p>}
      <details className={css.details} onToggle={(event) => { setExpanded(event.currentTarget.open) }}>
        <summary>{t('details')}</summary>
        <p className={css.caption}>{task.model ?? receipt?.model ?? t('notSpecified')}</p><code className={css.caption}>{task.id}</code>
        {receipt !== undefined && <Facts t={t} entries={[
          [t('tasks.receipt.phase'), t(`tasks.receipt.${receipt.phase}`)],
          ...receipt.taskId === undefined ? [] : [[t('tasks.receipt.taskId'), receipt.taskId] as const],
          ...receipt.requestId === undefined ? [] : [[t('tasks.receipt.requestId'), receipt.requestId] as const],
        ]} />}
        {expanded && outputs.length > 0 && <OutputGallery outputs={outputs} visible={visible} t={t} />}
      </details>
    </div>
  </article>
}

/** Filter actual invocation records and saved outputs without inventing percentage progress. */
export function CreativeTasks({ project, visible, recover, t }: {
  project: CreativeProjectView
  visible: boolean
  recover: CreativeInjected['recover']
  t: Translate
}): ReactNode {
  const [filter, setFilter] = useState<CreativeStatus | 'all'>('all')
  const [kind, setKind] = useState<CreativeOutput['kind'] | 'all'>('all')
  const tasks = project.tasks.filter(task => filter === 'all' || task.status === filter)
  const outputs = project.outputs.filter(output => kind === 'all' || output.kind === kind)
  return <div className={css.cards}>
    <div className={css.filters}>
      <label className={css.field}><span>{t('tasks.status')}</span><select className={css.fieldInput} value={filter}
        onChange={(event) => {
          const value = event.target.value
          if (value === 'all' || value === 'planned' || value === 'running' || value === 'saving' || value === 'editing'
            || value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'interrupted'
            || value === 'unknown') setFilter(value)
        }}><option value="all">{t('tasks.all')}</option>
        {(['planned', 'running', 'saving', 'editing', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'] as const)
          .map(status => <option value={status} key={status}>{t(`status.${status}`)}</option>)}
      </select></label>
      <label className={css.field}><span>{t('plan.kind')}</span><select className={css.fieldInput} value={kind}
        onChange={(event) => {
          const value = event.target.value
          if (value === 'all' || value === 'image' || value === 'video' || value === 'audio') setKind(value)
        }}><option value="all">{t('tasks.all')}</option>
        {(['image', 'video', 'audio'] as const).map(value => <option value={value} key={value}>{t(`kind.${value}`)}</option>)}
      </select></label>
    </div>
    {project.kind === 'video' && <div className={css.verification}><p>{t('verify.pending')}</p><p>{t('verify.description')}</p></div>}
    <div className={css.sectionHeading}><h3>{t('tasks.title')}</h3><span className={css.status}>
      {project.totalShots > 0 ? t('tasks.progress', { completed: project.completedShots, total: project.totalShots })
        : t('tasks.outputCount', { count: project.outputs.length })}</span></div>
    {tasks.length === 0 ? <p className={css.hint}>{t('tasks.empty')}</p> : tasks.map(task => <TaskCard key={task.id}
      task={task} order={project.tasks.indexOf(task) + 1} project={project} kind={kind} visible={visible} recover={recover} t={t} />)}
    <h3 className={css.subheading}>{t('tasks.outputs')}</h3>
    {outputs.length === 0 ? <p className={css.hint}>{t('noOutputs')}</p>
      : <OutputGallery outputs={outputs} visible={visible} t={t} />}
  </div>
}
