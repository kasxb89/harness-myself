/** Account-scoped usage queries, period filters and the balance page's analysis. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { appPath, Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { UsageCharts } from './UsageCharts.tsx'
import { aggregateUsage, getUsageWindow, parseUsagePayload, type UsagePayload, type UsageRange } from './usage-analytics.ts'
import css from './UsageOverview.module.css'

type Translate = (key: string, values?: Record<string, string>) => string

/**
 * Render usage for the signed-in account; the caller keys this component by account.
 * @param props - localized copy and the account's current points-to-yuan rate.
 * @returns period controls, reported totals, charts and their query states.
 */
export function UsageOverview({ t, creditsPerYuan }: { t: Translate; creditsPerYuan: number }): ReactNode {
  const [range, setRange] = useState<UsageRange>('7d')
  const [revision, setRevision] = useState(0)
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [payload, setPayload] = useState<UsagePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<'unavailable' | 'auth' | 'access' | 'failed' | null>(null)
  const window = useMemo(() => getUsageWindow(range), [range, revision])
  const analysis = useMemo(() => payload === null ? null : aggregateUsage(payload, selectedModel), [payload, selectedModel])
  const locale = t('usage.locale')
  const countFormat = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), [locale])
  const pointFormat = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }), [locale])
  const scientificFormat = useMemo(() => new Intl.NumberFormat(locale, {
    notation: 'scientific', maximumSignificantDigits: 15,
  }), [locale])
  const dayFormat = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai',
  }), [locale])
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai',
  }), [locale])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setFailure(null)
    setPayload(previous => previous?.start === window.start ? previous : null)
    const read = async (): Promise<void> => {
      try {
        const query = new URLSearchParams({ start: String(window.start), end: String(window.end) })
        const response = await fetch(appPath(`/credits/api/usage?${query.toString()}`), {
          headers: { accept: 'application/json' }, signal: controller.signal,
        })
        const answer: unknown = await response.json()
        if (!active) return
        if (answer === null || typeof answer !== 'object' || !('ok' in answer) || answer.ok !== true || !response.ok) {
          const code = answer !== null && typeof answer === 'object' && 'code' in answer ? answer.code : null
          setFailure(code === 'SESSION_REQUIRED' || code === 'SESSION_INVALID' ? 'auth'
            : code === 'USAGE_ACCESS_DENIED' ? 'access'
              : code === 'USAGE_UNAVAILABLE' || code === 'USAGE_CONVERSION_UNAVAILABLE' || response.status === 404 ? 'unavailable' : 'failed')
          return
        }
        if (!('payload' in answer)) { setFailure('failed'); return }
        const next = parseUsagePayload(answer.payload)
        if (next.start !== window.start || next.end !== window.end) { setFailure('failed'); return }
        aggregateUsage(next, null)
        setPayload(next)
      } catch {
        if (active) setFailure('failed')
      } finally {
        if (active) setLoading(false)
      }
    }
    void read()
    return () => { active = false; controller.abort() }
  }, [window])

  const formatCount = (value: number): string => countFormat.format(value)
  const formatPoints = (value: number): string => (value > 0 && value < 0.000001 || value >= 1e15)
    ? scientificFormat.format(value) : pointFormat.format(value)
  const formatDay = (day: string): string => dayFormat.format(new Date(`${day}T00:00:00+08:00`))
  const equivalent = (points: number): string => {
    const amount = points / creditsPerYuan
    if (amount > 0 && amount < 0.01) return t('usage.yuanSmall')
    if (amount >= 1e15) return t('yuanInline', { amount: scientificFormat.format(amount) })
    return t('yuanInline', { amount: new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) })
  }
  const selectRange = (next: UsageRange): void => {
    if (next === range) return
    setPayload(null)
    setFailure(null)
    setLoading(true)
    setRange(next)
  }
  const modelOptions = analysis?.availableModels ?? []
  const visibleModels = selectedModel !== null && !modelOptions.includes(selectedModel)
    ? [selectedModel, ...modelOptions] : modelOptions

  return (
    <section className={css.overview} aria-label={t('usage.title')} aria-busy={loading}>
      <div className={css.heading}>
        <div>
          <h2 className={css.title}>{t('usage.title')}</h2>
          <p className={css.caption}>{t('usage.rangeCaption', { start: window.startDay, end: window.endDay })}</p>
        </div>
        <div className={css.controls}>
          <div className={css.ranges} role="group" aria-label={t('usage.period')}>
            {(['today', '7d', '30d'] as const).map(value => (
              <button key={value} type="button" className={range === value ? css.rangeActive : css.range}
                aria-pressed={range === value} onClick={() => { selectRange(value) }}>{t(`usage.range.${value}`)}</button>
            ))}
          </div>
          <label className={css.modelFilter}>
            <span className={css.visuallyHidden}>{t('usage.modelFilter')}</span>
            <select value={selectedModel === null ? 'all' : `model:${selectedModel}`}
              disabled={payload === null} onChange={(event) => { setSelectedModel(event.target.value === 'all' ? null : event.target.value.slice(6)) }}>
              <option value="all">{t('usage.allModels')}</option>
              {visibleModels.map(model => <option key={model} value={`model:${model}`}>{model || t('usage.unknownModel')}</option>)}
            </select>
          </label>
          <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular />} disabled={loading}
            onClick={() => { setRevision(value => value + 1) }}>{t('usage.refresh')}</Button>
        </div>
      </div>

      {failure !== null && (
        <div className={css.error} role="alert">
          <span>{t(`usage.error.${failure}`)}</span>
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => { setRevision(value => value + 1) }}>{t('usage.retry')}</Button>
        </div>
      )}
      {loading && payload === null && (
        <div className={css.loading} role="status"><span className={css.spinner} aria-hidden="true" /><span>{t('usage.loading')}</span></div>
      )}

      {analysis !== null && payload !== null && (
        <>
          <div className={css.metrics}>
            <article className={css.metric} aria-label={t('usage.consumed')}>
              <span className={css.metricLabel}>{t('usage.consumed')}</span>
              <div className={css.metricValue}>{formatPoints(analysis.totals.consumedPoints)}<span>{t('points')}</span></div>
              <span className={css.metricHint}>{equivalent(analysis.totals.consumedPoints)}</span>
            </article>
            <article className={css.metric} aria-label={t('usage.records')}>
              <span className={css.metricLabel}>{t('usage.records')}</span>
              <div className={css.metricValue}>{formatCount(analysis.totals.billingRecords)}<span>{t('usage.recordsUnit')}</span></div>
              <span className={css.metricHint}>{t('usage.recordsHint')}</span>
            </article>
            <article className={css.metric} aria-label={t('usage.tokens')}>
              <span className={css.metricLabel}>{t('usage.tokens')}</span>
              <div className={css.metricValue}>{formatCount(analysis.totals.totalTokens)}<span>{t('usage.tokenUnit')}</span></div>
              <span className={css.metricHint}>{t('usage.tokensHint')}</span>
            </article>
          </div>
          <div className={css.freshness}>
            <span>{t('usage.updatedAt', { time: timeFormat.format(new Date(payload.asOf)) })}</span>
            <span>{payload.delayMinutes === 0 ? t('usage.billingFreshness')
              : t('usage.delay', { minutes: String(payload.delayMinutes) })}</span>
          </div>
          {analysis.models.length === 0 ? (
            <div className={css.empty}><h3>{t('usage.emptyTitle')}</h3><p>{t('usage.emptyHint')}</p></div>
          ) : (
            <UsageCharts daily={analysis.daily} models={analysis.models}
              formatPoints={formatPoints} formatCount={formatCount} formatDay={formatDay}
              labels={{
                trendTitle: t('usage.trendTitle'), modelTitle: t('usage.modelTitle'), metricLabel: t('usage.metricLabel'),
                consumed: t('usage.consumed'), records: t('usage.records'), tokens: t('usage.tokens'),
                day: t('usage.day'), model: t('usage.model'), pointsUnit: t('points'),
                dailyDetails: t('usage.dailyDetails'), modelDetails: t('usage.modelDetails'), empty: t('usage.emptyTitle'),
                unknownModel: t('usage.unknownModel'), chartHint: t('usage.chartHint'),
                pointLabel: (day, metric, value) => t('usage.pointLabel', { day, metric, value }),
                modelSummary: (records, tokens) => t('usage.modelSummary', { records, tokens }),
              }} />
          )}
          <p className={css.note}>{t('usage.scopeNote')}</p>
        </>
      )}
    </section>
  )
}
