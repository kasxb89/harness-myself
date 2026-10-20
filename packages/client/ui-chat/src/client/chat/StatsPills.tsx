/** Composer activity counts and response/tool timing; billing belongs to account settlement. */

import { memo, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconGaugeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the sessionStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { ChatViewSlotProps, PerformanceUsageInjected } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { assistantStepReading } from '../contract/turn-metrics.ts'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './StatsPills.module.css'
import dialogCss from './stat-dialog.module.css'

interface WindowStats {
  turns: number
  steps: number
  /** Summed request wall time (step/start → assistant/message); 0 when no node carries timing. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result); 0 when no pair is in-window. */
  toolMs: number
  /** Summed first-token latency over `ttftSteps`; 0 when no step records it. */
  ttftMs: number
  /** Steps carrying a recorded TTFT. */
  ttftSteps: number
  /** Summed decode wall time over steps that also report output tokens. */
  decodeMs: number
  /** Summed output tokens over the same decode-timed steps. */
  decodeTokens: number
}

/**
 * Fold assistant and tool-result nodes into window-scoped display totals —
 * the FALLBACK for assemblies without the `sessionStats` projection.
 *
 * Every displayed figure rides that durable whole-log projection (and token
 * accounting rides `tokenUsage`) because the window is paged and compaction
 * rewrites it; this fold answers "what is on screen" only when no projection
 * value is served. Its field names deliberately mirror the projection's so
 * the two swap wholesale.
 * @param nodes - snapshot nodes.
 * @returns fallback counts and summed wall times.
 */
export function deriveStats(nodes: ChatSnapshot['legacy']['nodes']): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) {
      ttftMs += reading.ttftMs
      ttftSteps += 1
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      decodeMs += reading.decodeMs
      decodeTokens += reading.outputTokens
    }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number, t: ChatViewSlotProps['t']): string {
  const s = ms / 1_000
  if (s < 60) return t('duration.compactSeconds', { seconds: Math.round(s * 10) / 10 })
  const whole = Math.round(s)
  return t('duration.compactMinutes', {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
  })
}

type Translate = ChatViewSlotProps['t']

/** Props shared by every composer stats pill: the conversation-snapshot selector plus the projection read seat. */
export interface StatPillProps extends InjectFace<PerformanceUsageInjected> {
  useChat: SnapshotSelectorHook<ChatSnapshot>
  useProjection: UseProjection
  /** The owning dock's locale seat. */
  t: Translate
}

/** Dock entry id carried as `data-composer-stat` on each pill. */
type StatId = 'activity'

interface PillContent {
  stat: StatId
  icon: ReactNode
  label: ReactNode
}

// Every figure rides the durable sessionStats projection, so paging and
// compaction cannot change any of them; an assembly without the unit falls
// back to the window-scoped fold wholesale (same field names), paid only
// while no projection value is served.
function useSessionStats(useChat: StatPillProps['useChat'], useProjection: UseProjection): WindowStats {
  const settledNodes = useChat(s => s.legacy.nodes)
  const projected = useProjection('sessionStats')
  return useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
}

/** A static reading: used when the pill has no dialog rows or the mode is Compact. */
function PlainPill({ stat, icon, label }: PillContent) {
  return (
    <span className={css.anchor} data-composer-stat={stat}>
      <span className={css.pill}>
        {icon}
        <span className={css.label}>{label}</span>
      </span>
    </span>
  )
}

/**
 * A pill button opening its own portaled dialog. Each pill owns its open
 * state; useStatDialog closes it on Escape or an outside pointerdown or click,
 * so at most one dialog is open across the dock.
 */
function DialogPill({ stat, icon, label, ariaLabel, title, children }: PillContent & {
  ariaLabel: string
  title: string
  children: ReactNode
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
  return (
    <span ref={rootRef} className={css.anchor} data-composer-stat={stat}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => { setOpen(!open) }}
      >
        {icon}
        <span className={css.label}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={title}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              {icon}
              {title}
            </span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          {children}
        </div>,
        document.body,
      )}
    </span>
  )
}

/** Turn and step counts; Detailed adds a dialog for observed response and tool timing. */
export const ActivityPill = memo(function ActivityPill({ useChat, useProjection, usePerformanceUsage, t }: StatPillProps) {
  const mode = usePerformanceUsage(value => value)
  const stats = useSessionStats(useChat, useProjection)
  if (stats.steps === 0) return null
  const counts = t('stats.counts', { turns: stats.turns, steps: stats.steps })
  const content: PillContent = { stat: 'activity', icon: <IconGaugeOutlineRegular />, label: counts }
  if (mode === 'compact' || stats.llmMs <= 0 && stats.toolMs <= 0 && stats.ttftSteps <= 0) return <PlainPill {...content} />
  return (
    <DialogPill {...content} ariaLabel={counts} title={t('stats.dialog.title')}>
      <dl className={dialogCss.details} data-session-stats-details>
        {stats.llmMs > 0 && <><dt>{t('stats.dialog.llmTime')}</dt><dd>{formatDuration(stats.llmMs, t)}</dd></>}
        {stats.toolMs > 0 && <><dt>{t('stats.dialog.toolTime')}</dt><dd>{formatDuration(stats.toolMs, t)}</dd></>}
        {stats.ttftSteps > 0 && <><dt>{t('stats.dialog.ttft')}</dt><dd>{formatDuration(stats.ttftMs / stats.ttftSteps, t)}</dd></>}
      </dl>
    </DialogPill>
  )
})
