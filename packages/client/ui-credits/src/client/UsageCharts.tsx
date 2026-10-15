/** Usage visualizations over the account's observed calendar-day aggregates. */
import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UsageDailyPoint, UsageModelPoint } from './usage-analytics.ts'
import css from './UsageCharts.module.css'

/** Complete localized copy for the usage charts and their numeric alternatives. */
export interface UsageChartsLabels {
  readonly trendTitle: string
  readonly modelTitle: string
  readonly metricLabel: string
  readonly consumed: string
  readonly records: string
  readonly tokens: string
  readonly day: string
  readonly model: string
  readonly unknownModel: string
  readonly pointsUnit: string
  readonly dailyDetails: string
  readonly modelDetails: string
  readonly empty: string
  readonly chartHint: string
  readonly pointLabel: (day: string, metric: string, value: string) => string
  readonly modelSummary: (records: string, tokens: string) => string
}

/** Ready usage data and the account page's localized formatting functions. */
export interface UsageChartsProps {
  readonly daily: readonly UsageDailyPoint[]
  readonly models: readonly UsageModelPoint[]
  readonly labels: UsageChartsLabels
  readonly formatPoints: (value: number) => string
  readonly formatCount: (value: number) => string
  readonly formatDay: (day: string) => string
}

type UsageMetric = 'consumed' | 'records' | 'tokens'

const metricFields = {
  consumed: 'consumedPoints',
  records: 'billingRecords',
  tokens: 'totalTokens',
} as const

const plotWidth = 680
const plotHeight = 180
const plotInset = 12
const dayMilliseconds = 86_400_000

/** Calendar keys are compared in UTC solely to measure whole-day distances. */
function dayPosition(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / dayMilliseconds
}

function UsageTable({ rows, kind, labels, formatPoints, formatCount, formatDay }: {
  rows: readonly UsageDailyPoint[] | readonly UsageModelPoint[]
  kind: 'daily' | 'model'
  labels: UsageChartsLabels
  formatPoints: (value: number) => string
  formatCount: (value: number) => string
  formatDay: (day: string) => string
}): ReactNode {
  const title = kind === 'daily' ? labels.dailyDetails : labels.modelDetails
  return (
    <details className={css.details}>
      <summary>{title}</summary>
      <div className={css.tableScroll}>
        <table className={css.table} aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{kind === 'daily' ? labels.day : labels.model}</th>
              <th scope="col">{labels.consumed}</th>
              <th scope="col">{labels.records}</th>
              <th scope="col">{labels.tokens}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const name = 'day' in row ? formatDay(row.day) : row.model || labels.unknownModel
              return (
                <tr key={'day' in row ? row.day : row.model}>
                  <th scope="row">{name}</th>
                  <td>{formatPoints(row.consumedPoints)}</td>
                  <td>{formatCount(row.billingRecords)}</td>
                  <td>{formatCount(row.totalTokens)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </details>
  )
}

/**
 * Render daily trends and model spending without filling unobserved days.
 * @param props - Observed day/model totals, complete copy, and display formatters.
 * @returns Two charts with keyboard-readable observations and numeric details.
 */
export function UsageCharts(props: UsageChartsProps): ReactNode {
  const { daily, models, labels, formatPoints, formatCount, formatDay } = props
  const [metric, setMetric] = useState<UsageMetric>('consumed')
  const [activeDay, setActiveDay] = useState<string | null>(null)
  const pointRefs = useRef<Array<SVGCircleElement | null>>([])
  const id = useId()
  const orderedDays = useMemo(() => [...daily].sort((left, right) => left.day.localeCompare(right.day)), [daily])
  const orderedModels = useMemo(() => [...models].sort((left, right) =>
    right.consumedPoints - left.consumedPoints || left.model.localeCompare(right.model)), [models])
  const metricLabels = { consumed: labels.consumed, records: labels.records, tokens: labels.tokens }
  const formatMetric = metric === 'consumed' ? formatPoints : formatCount
  const field = metricFields[metric]
  const maxValue = Math.max(0, ...orderedDays.map(point => point[field]))
  const scaleMaximum = metric === 'consumed'
    ? (maxValue === 0 ? 1 : maxValue)
    : Math.max(2, Math.ceil(maxValue / 2) * 2)
  const firstDay = orderedDays[0]
  const lastDay = orderedDays[orderedDays.length - 1]
  const firstPosition = firstDay === undefined ? 0 : dayPosition(firstDay.day)
  const lastPosition = lastDay === undefined ? 0 : dayPosition(lastDay.day)
  const daySpan = lastPosition - firstPosition
  const xOf = (point: UsageDailyPoint): number => daySpan === 0
    ? plotWidth / 2
    : plotInset + (dayPosition(point.day) - firstPosition) / daySpan * (plotWidth - plotInset * 2)
  const yOf = (point: UsageDailyPoint): number => plotHeight - plotInset
    - point[field] / scaleMaximum * (plotHeight - plotInset * 2)
  const selected = orderedDays.find(point => point.day === activeDay) ?? lastDay
  const largestModelSpend = orderedModels[0]?.consumedPoints ?? 0

  const walkPoint = (event: KeyboardEvent<SVGCircleElement>, index: number): void => {
    let next: number
    if (event.key === 'ArrowLeft') next = Math.max(0, index - 1)
    else if (event.key === 'ArrowRight') next = Math.min(orderedDays.length - 1, index + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = orderedDays.length - 1
    else return
    event.preventDefault()
    pointRefs.current[next]?.focus()
  }

  return (
    <div className={css.charts}>
      <section className={css.card} aria-labelledby={`${id}-trend-title`}>
        <div className={css.heading}>
          <h3 className={css.title} id={`${id}-trend-title`}>{labels.trendTitle}</h3>
          <SegmentedControl
            id={`${id}-metric`}
            label={labels.metricLabel}
            value={metric}
            options={([
              { value: 'consumed', label: labels.consumed },
              { value: 'records', label: labels.records },
              { value: 'tokens', label: labels.tokens },
            ] as const)}
            onChange={setMetric}
            className={css.metricControl}
          />
        </div>
        <div
          id={`${id}-metric-${metric}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-metric-${metric}`}
        >
          {orderedDays.length === 0 ? <p className={css.empty}>{labels.empty}</p> : (
            <>
              <div className={css.chartCanvas}>
                <div className={css.axisY} aria-hidden="true">
                  <span>{formatMetric(scaleMaximum)}</span>
                  <span>{formatMetric(scaleMaximum / 2)}</span>
                  <span>{formatMetric(0)}</span>
                </div>
                <div className={css.chartBody}>
                  <svg
                    className={css.plot}
                    viewBox={`0 0 ${plotWidth} ${plotHeight}`}
                    preserveAspectRatio="none"
                    role="group"
                    aria-label={labels.trendTitle}
                    aria-describedby={`${id}-chart-hint`}
                  >
                    {[plotInset, plotHeight / 2, plotHeight - plotInset].map(y => (
                      <line key={y} className={css.gridLine} x1={0} x2={plotWidth} y1={y} y2={y} />
                    ))}
                    {orderedDays.map((previous, index) => {
                      const point = orderedDays[index + 1]
                      if (point === undefined || dayPosition(point.day) - dayPosition(previous.day) !== 1) return null
                      return (
                        <line
                          key={point.day}
                          className={css.trendLine}
                          x1={xOf(previous)}
                          y1={yOf(previous)}
                          x2={xOf(point)}
                          y2={yOf(point)}
                          aria-hidden="true"
                        />
                      )
                    })}
                    {orderedDays.map((point, index) => {
                      const name = labels.pointLabel(formatDay(point.day), metricLabels[metric], formatMetric(point[field]))
                      return (
                        <g key={point.day}>
                          <path className={css.point} d={`M ${xOf(point)} ${yOf(point)} l .01 0`} aria-hidden="true" />
                          <circle
                            ref={(element) => { pointRefs.current[index] = element }}
                            className={css.pointTarget}
                            cx={xOf(point)}
                            cy={yOf(point)}
                            r={12}
                            tabIndex={0}
                            role="img"
                            aria-label={name}
                            onMouseEnter={() => { setActiveDay(point.day) }}
                            onFocus={() => { setActiveDay(point.day) }}
                            onKeyDown={(event) => { walkPoint(event, index) }}
                          />
                        </g>
                      )
                    })}
                  </svg>
                  <div className={css.axisX} aria-hidden="true">
                    <span>{firstDay === undefined ? null : formatDay(firstDay.day)}</span>
                    {lastDay !== undefined && lastDay.day !== firstDay?.day && <span>{formatDay(lastDay.day)}</span>}
                  </div>
                </div>
              </div>
              <div className={css.selection} aria-live="polite" aria-atomic="true">
                {selected !== undefined && <>
                  <span>{formatDay(selected.day)}</span>
                  <span>{metricLabels[metric]}</span>
                  <span className={css.selectionValue}>{formatMetric(selected[field])}</span>
                </>}
              </div>
              <p className={css.hint} id={`${id}-chart-hint`}>{labels.chartHint}</p>
            </>
          )}
        </div>
        <UsageTable {...props} rows={orderedDays} kind="daily" />
      </section>

      <section className={css.card} aria-labelledby={`${id}-models-title`}>
        <div className={css.heading}>
          <h3 className={css.title} id={`${id}-models-title`}>{labels.modelTitle}</h3>
          <span className={css.hint}>{labels.consumed}</span>
        </div>
        {orderedModels.length === 0 ? <p className={css.empty}>{labels.empty}</p> : (
          <ol className={css.ranking}>
            {orderedModels.map(model => (
              <li key={model.model} className={css.modelRow}>
                <div className={css.modelHeading}>
                  <span className={css.modelName}>{model.model || labels.unknownModel}</span>
                  <span className={css.modelValue}>{formatPoints(model.consumedPoints)} {labels.pointsUnit}</span>
                </div>
                <div className={css.barTrack} aria-hidden="true">
                  <div
                    className={css.barFill}
                    style={{ '--usage-share': `${largestModelSpend === 0 ? 0 : model.consumedPoints / largestModelSpend * 100}%` } as CSSProperties}
                  />
                </div>
                <span className={css.modelStats}>
                  {labels.modelSummary(formatCount(model.billingRecords), formatCount(model.totalTokens))}
                </span>
              </li>
            ))}
          </ol>
        )}
        <UsageTable {...props} rows={orderedModels} kind="model" />
      </section>
    </div>
  )
}
