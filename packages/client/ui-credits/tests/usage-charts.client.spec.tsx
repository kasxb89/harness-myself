// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageCharts, type UsageChartsLabels, type UsageChartsProps } from '../src/client/UsageCharts.tsx'

const labels: UsageChartsLabels = {
  trendTitle: 'Daily usage',
  modelTitle: 'Model spending',
  metricLabel: 'Usage metric',
  consumed: 'Credits consumed',
  records: 'Billing records',
  tokens: 'Total tokens',
  day: 'Day',
  model: 'Model',
  unknownModel: 'Unknown model',
  pointsUnit: 'credits',
  dailyDetails: 'Daily details',
  modelDetails: 'Model details',
  empty: 'No usage recorded',
  chartHint: 'Hover or focus a point to inspect it',
  pointLabel: (day, metric, value) => `${day}: ${metric} ${value}`,
  modelSummary: (records, tokens) => `${records} billing records · ${tokens} tokens`,
}

const daily: UsageChartsProps['daily'] = [
  { day: '2026-10-01', consumedPoints: 0, billingRecords: 1, totalTokens: 20 },
  { day: '2026-10-02', consumedPoints: 4, billingRecords: 2, totalTokens: 40 },
  { day: '2026-10-05', consumedPoints: 12, billingRecords: 3, totalTokens: 60 },
]

const models: UsageChartsProps['models'] = [
  { model: 'small-model', consumedPoints: 4, billingRecords: 2, totalTokens: 40 },
  { model: '', consumedPoints: 12, billingRecords: 4, totalTokens: 80 },
]

function renderCharts(overrides: Partial<UsageChartsProps> = {}) {
  return render(<UsageCharts
    daily={daily}
    models={models}
    labels={labels}
    formatPoints={value => String(value)}
    formatCount={value => String(value)}
    formatDay={day => day}
    {...overrides}
  />)
}

afterEach(cleanup)

describe('UsageCharts', () => {
  it('switches the observed trend between credits, billing records, and tokens', () => {
    const view = renderCharts()
    const panel = view.getByRole('tabpanel')
    expect(within(panel).getByText('Credits consumed')).toBeDefined()
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe('2026-10-05Credits consumed12')
    expect(view.getByRole('img', { name: '2026-10-01: Credits consumed 0' })).toBeDefined()

    fireEvent.click(view.getByRole('tab', { name: 'Billing records' }))
    expect(view.getByRole('tab', { name: 'Billing records' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getByRole('img', { name: '2026-10-05: Billing records 3' })).toBeDefined()

    fireEvent.keyDown(view.getByRole('tab', { name: 'Billing records' }), { key: 'ArrowRight' })
    expect(view.getByRole('tab', { name: 'Total tokens' }).getAttribute('aria-selected')).toBe('true')
    expect(view.getByRole('img', { name: '2026-10-05: Total tokens 60' })).toBeDefined()
  })

  it('positions sparse calendar days by elapsed days and leaves missing days disconnected', () => {
    const view = renderCharts({ daily: [daily[2]!, daily[0]!, daily[1]!] })
    const points = view.getAllByRole('img')
    const x = points.map(point => Number(point.getAttribute('cx')))
    expect((x[2]! - x[1]!) / (x[1]! - x[0]!)).toBe(3)
    expect(Number(points[0]!.getAttribute('cy'))).toBeGreaterThan(Number(points[2]!.getAttribute('cy')))
    const observedSegments = view.getByRole('group', { name: labels.trendTitle }).querySelectorAll('line[aria-hidden="true"]')
    expect(observedSegments).toHaveLength(1)
    expect(view.queryByRole('img', { name: /2026-10-03/ })).toBeNull()
  })

  it('shows the same observations through hover and arrow-key focus', () => {
    const view = renderCharts()
    const first = view.getByRole('img', { name: '2026-10-01: Credits consumed 0' })
    const second = view.getByRole('img', { name: '2026-10-02: Credits consumed 4' })
    const last = view.getByRole('img', { name: '2026-10-05: Credits consumed 12' })
    const live = view.container.querySelector('[aria-live="polite"]')!

    fireEvent.mouseEnter(second)
    expect(live.textContent).toBe('2026-10-02Credits consumed4')
    act(() => { first.focus() })
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(second)
    expect(live.textContent).toBe('2026-10-02Credits consumed4')
    fireEvent.keyDown(second, { key: 'End' })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Home' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(document.activeElement).toBe(first)
  })

  it('offers equivalent daily and model tables and ranks models by consumed credits', () => {
    const view = renderCharts()
    const ranking = within(view.getByRole('region', { name: labels.modelTitle })).getAllByRole('listitem')
    expect(ranking.map(item => item.textContent)).toEqual([
      'Unknown model12 credits4 billing records · 80 tokens',
      'small-model4 credits2 billing records · 40 tokens',
    ])
    fireEvent.click(view.getByText(labels.dailyDetails))
    fireEvent.click(view.getByText(labels.modelDetails))
    const dailyTable = within(view.getByRole('table', { name: labels.dailyDetails }))
    const modelTable = within(view.getByRole('table', { name: labels.modelDetails }))
    expect(dailyTable.getByRole('row', { name: '2026-10-02 4 2 40' })).toBeDefined()
    expect(modelTable.getByRole('row', { name: 'Unknown model 12 4 80' })).toBeDefined()
  })

  it('keeps zero observations at the baseline and presents empty data without a plot', () => {
    const view = renderCharts({
      daily: [{ day: '2026-10-15', consumedPoints: 0, billingRecords: 1, totalTokens: 0 }],
      models: [{ model: 'image-model', consumedPoints: 0, billingRecords: 1, totalTokens: 0 }],
    })
    expect(view.getByRole('img', { name: '2026-10-15: Credits consumed 0' }).getAttribute('cy')).toBe('168')
    expect(view.getByText('1 billing records · 0 tokens')).toBeDefined()
    view.rerender(<UsageCharts
      daily={[]}
      models={[]}
      labels={labels}
      formatPoints={String}
      formatCount={String}
      formatDay={String}
    />)
    expect(view.getAllByText(labels.empty)).toHaveLength(2)
    expect(view.queryByRole('group', { name: labels.trendTitle })).toBeNull()
  })

  it.each([
    { count: 1, maximum: 2, midpoint: 1, y: '90' },
    { count: 3, maximum: 4, midpoint: 2, y: '51' },
  ])('uses exact integer ticks and matching point heights for a count of $count', ({ count, maximum, midpoint, y }) => {
    const integerFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
    const view = renderCharts({
      daily: [{ day: '2026-10-15', consumedPoints: 1, billingRecords: count, totalTokens: count }],
      formatCount: value => integerFormat.format(value),
    })
    for (const metric of [labels.records, labels.tokens]) {
      fireEvent.click(view.getByRole('tab', { name: metric }))
      const panel = within(view.getByRole('tabpanel'))
      expect(panel.getByText(String(maximum))).toBeDefined()
      expect(panel.getAllByText(String(midpoint))).toHaveLength(count === midpoint ? 2 : 1)
      expect(view.getByRole('img', { name: `2026-10-15: ${metric} ${count}` }).getAttribute('cy')).toBe(y)
    }
  })
})
