/** Dated model-price references are independent from the top-up amount and payment lifecycle. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal, Tag, IconSparkleRegular, IconNewChatOutlineRegular, IconPlayOutlineRegular, IconMicrophoneOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { get, type Envelope } from './api.ts'
import { comparisonDiscount, comparisonModels, type ComparisonKind, type ComparisonModel, type ComparisonRow } from './price-comparisons.ts'
import { creditsReadFailure, creditsRetrySeconds, type CreditsReadFailure } from './read-failure.ts'
import css from './PriceComparison.module.css'

interface PriceComparisonProps {
  readonly accountId: string
  readonly accountOwner: string
  readonly accountEpoch: number
  readonly t: (key: string, values?: Record<string, string>) => string
}
interface Reading {
  readonly owner: string
  readonly models: readonly ComparisonModel[]
  readonly failure: CreditsReadFailure | null
  readonly busy: boolean
}
const kinds = ['all', 'text', 'image', 'video', 'audio'] as const
const parameterKeys = ['aspect_ratio', 'count', 'duration', 'mode', 'quality', 'resolution', 'response_format',
  'size', 'speed', 'thinking_level', 'voice', 'audio', 'seconds', 'ratio', 'n'] as const

function comparisonReadFailure(answer: Envelope<unknown>): CreditsReadFailure {
  const failure = creditsReadFailure(answer, 'PRICE_COMPARISONS_UNAVAILABLE')
  return answer.code === 'PRICE_COMPARISONS_NETWORK' ? { ...failure, kind: 'network' } : failure
}

function unitLabel(unit: string, t: PriceComparisonProps['t']): string {
  const units: Readonly<Record<string, string>> = {
    'CNY / million tokens': 'millionTokens', 'CNY / second': 'second', 'CNY / image': 'image',
  }
  const key = units[unit]
  return key === undefined ? unit : t(`comparison.unit.${key}`)
}

const modeKeys: Readonly<Record<string, string>> = {
  'text-to-video': 'textToVideo', 'text-to-image': 'textToImage',
  'image-to-video': 'imageToVideo', 'image-to-image': 'imageToImage',
}

function specification(row: ComparisonRow, t: PriceComparisonProps['t']): string {
  const fields = parameterKeys.flatMap((key) => {
    const value = row.params[key]
    if (value === undefined) return []
    const mode = key === 'mode' && typeof value === 'string' ? modeKeys[value] : undefined
    const label = mode !== undefined ? t(`comparison.mode.${mode}`) : typeof value === 'boolean' ? t(`comparison.boolean.${String(value)}`)
      : (key === 'duration' || key === 'seconds') && (typeof value === 'number' || /^\d+$/u.test(String(value)))
        ? t('comparison.seconds', { value: String(value) }) : String(value)
    return [`${t(`comparison.param.${key}`)} ${label}`]
  })
  if (row.direction !== undefined) fields.unshift(t(`comparison.direction.${row.direction}`))
  return fields.length === 0 ? t('comparison.standard') : fields.join(' · ')
}
/** Decorative shared glyphs distinguish the public reference categories. */
function CategoryIcon({ kind }: { readonly kind: ComparisonKind }): ReactNode {
  const Icon = { text: IconNewChatOutlineRegular, image: IconSparkleRegular,
    video: IconPlayOutlineRegular, audio: IconMicrophoneOutlineRegular }[kind]
  return <Icon size={20} />
}

function Discount({ row, t }: { readonly row: ComparisonRow; readonly t: PriceComparisonProps['t'] }): ReactNode {
  const discount = comparisonDiscount(row)
  return discount.kind === 'lower'
    ? <span className={css.discount}><Tag tone="success">{t('comparison.discount', discount)}</Tag>
      <span>{t('comparison.saving', discount)}</span></span>
    : <span className={css.note}>{t(`comparison.${discount.kind}`)}</span>
}
function PriceRow({ row, t }: { readonly row: ComparisonRow; readonly t: PriceComparisonProps['t'] }): ReactNode {
  const reference = row.official_reference
  return <div className={css.row}>
    <div className={css.specification}>{specification(row, t)}</div>
    <dl className={css.prices}>
      <div className={css.retail}><dt>{t('comparison.retail')}</dt><dd>¥{row.retail_cny}</dd></div>
      <div className={css.official}><dt>{t('comparison.official')}</dt><dd>¥{reference.official_cny}</dd></div>
      <div className={css.comparison}><dt>{t('comparison.ratio')}</dt><dd><Discount row={row} t={t} /></dd></div>
    </dl>
    <p className={css.note}>{t('comparison.unit', { unit: unitLabel(row.unit, t) })}</p>
    {row.retail_total_cny !== undefined && reference.official_total_cny !== undefined && <p className={css.note}>
      {t('comparison.total', { retail: row.retail_total_cny, official: reference.official_total_cny })}
    </p>}
    <p className={css.note}>{t('comparison.referenceModel', { model: reference.model })}</p>
    <p className={css.note}>{reference.conditions.replaceAll(
      '非5秒值按厂商同规格5秒例与Token公式折算', t('comparison.scaledReference'))}</p>
    <div className={css.source}>
      <span>{t('comparison.checked', { date: reference.checked_at })}</span>
      {reference.source_currency === 'USD' && reference.usd_cny !== undefined && <span>
        {t('comparison.exchangeRate', { rate: reference.usd_cny })}
      </span>}
      <a href={reference.source_url} target="_blank" rel="noopener noreferrer">{t('comparison.source')}</a>
    </div>
  </div>
}

/**
 * Read public comparisons for the displayed login without affecting recharge or generation.
 * @param props - Current account coordinates and the plugin's typed locale seat.
 * @returns A scrollable model-card grid with same-specification details in a modal; unverified data stays absent.
 */
export function PriceComparison({ accountId, accountOwner, accountEpoch, t }: PriceComparisonProps): ReactNode {
  const owner = JSON.stringify([accountId, accountOwner, accountEpoch])
  const current = useRef(owner)
  current.current = owner
  const [reading, setReading] = useState<Reading | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<{ readonly owner: string; readonly id: string } | null>(null)
  const [filter, setFilter] = useState<'all' | ComparisonKind>('all')
  const [query, setQuery] = useState('')
  const [retrySeconds, setRetrySeconds] = useState(0)
  const active = reading?.owner === owner ? reading : null
  useEffect(() => {
    const failure = active?.failure
    const tick = (): void => { setRetrySeconds(creditsRetrySeconds(failure)) }
    tick()
    if (creditsRetrySeconds(failure) === 0) return undefined
    const timer = setInterval(tick, 1000)
    return () => { clearInterval(timer) }
  }, [active?.failure])
  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    const timeout = setTimeout(() => { controller.abort(new DOMException('Price read timed out', 'TimeoutError')) }, 12_000)
    const alive = (): boolean => !disposed && current.current === owner
    setReading(previous => ({ owner, models: previous?.owner === owner ? previous.models : [],
      failure: previous?.owner === owner ? previous.failure : null, busy: true }))
    const load = async (): Promise<void> => {
      try {
        const result = await get<unknown>('/credits/api/price-comparisons', controller.signal)
        if (!alive()) return
        if (controller.signal.aborted) throw controller.signal.reason
        if (result.account?.id !== undefined && result.account.id !== accountId
          || result.accountOwner !== undefined && result.accountOwner !== accountOwner) {
          setReading({ owner, models: [], failure: null, busy: false }); return
        }
        if (!result.ok) {
          if (result.httpStatus === 404 || result.code === 'PRICE_COMPARISONS_UNSUPPORTED'
            || result.code === 'ACCOUNT_CHANGED' || result.code === 'SESSION_REFRESH_REQUIRED') {
            setReading({ owner, models: [], failure: null, busy: false }); return
          }
          setReading(previous => ({ owner, models: previous?.owner === owner ? previous.models : [],
            failure: comparisonReadFailure(result), busy: false }))
          return
        }
        setReading({ owner, models: comparisonModels(result.payload), failure: null, busy: false })
      } catch (error) {
        if (!alive()) return
        setReading(previous => ({ owner, models: previous?.owner === owner ? previous.models : [],
          failure: creditsReadFailure(controller.signal.aborted ? controller.signal.reason : error, 'PRICE_COMPARISONS_UNAVAILABLE'), busy: false }))
      } finally { clearTimeout(timeout) }
    }
    void load()
    return () => { disposed = true; clearTimeout(timeout); controller.abort() }
  }, [accountId, accountOwner, owner, refresh])

  const models = active?.models ?? []
  if (models.length === 0 && active?.failure == null) return null
  const selectedModel = selected?.owner === owner ? models.find(model => model.id === selected.id) : undefined
  const search = query.trim().toLocaleLowerCase()
  const visible = models.filter(model => (filter === 'all' || model.kind === filter)
    && `${model.id} ${model.name} ${model.rows.map(row => row.official_reference.model).join(' ')}`.toLocaleLowerCase().includes(search))
  return <section className={css.card} aria-label={t('comparison.title')}>
    <div className={css.header}><div className={css.heading}><span className={css.headingIcon}><IconSparkleRegular size={20} /></span>
      <h2>{t('comparison.title')}</h2></div>
    {models.length > 0 && <span className={css.note}>{t('comparison.modelCount', { count: String(models.length) })}</span>}
    </div>
    <p className={css.note}>{t('comparison.basis')}</p>
    {models.some(model => model.kind === 'text') && <p className={css.note}>{t('comparison.textBasis')}</p>}
    {active?.failure !== null && active?.failure !== undefined && <div className={css.failure} role="status">
      <span>{t(active.failure.kind === 'network' ? 'comparison.network' : active.failure.kind === 'timeout'
        ? 'comparison.timeout' : 'comparison.failed')}</span>
      <Button size="sm" variant="ghost" disabled={active.busy || retrySeconds > 0}
        onClick={() => { setRefresh(value => value + 1) }}>{t('comparison.retry')}</Button>
      {retrySeconds > 0 && <span>{t('read.retryAfter', { seconds: String(retrySeconds) })}</span>}
    </div>}
    {models.length > 0 && <>
      <div className={css.toolbar}><div className={css.filters} role="group" aria-label={t('comparison.category')}>
        {kinds.map(kind => <Button key={kind} size="sm" variant={filter === kind ? 'outline' : 'ghost'}
          data-kind={kind} aria-pressed={filter === kind} onClick={() => { setFilter(kind) }}>{t(`comparison.kind.${kind}`)}</Button>)}
      </div>
      <Input value={query} aria-label={t('comparison.search')} placeholder={t('comparison.search')}
        onChange={(event) => { setQuery(event.target.value) }} /></div>
      <div className={css.modelsViewport} role="region" aria-label={t('comparison.modelList')} tabIndex={0}>
        <div className={css.models}>
          {visible.length === 0 && <p className={css.empty}>{t('comparison.empty')}</p>}
          {visible.map((model) => {
            const sample = model.rows[0]
            if (sample === undefined) return null
            return <button key={model.id} type="button" className={css.modelCard} data-kind={model.kind}
              aria-label={t('comparison.openModel', { model: model.name })} aria-haspopup="dialog"
              onClick={() => { setSelected({ owner, id: model.id }) }}>
              <span className={css.modelHeader}><span className={css.categoryIcon}><CategoryIcon kind={model.kind} /></span>
                <span className={css.modelKind}>{t(`comparison.kind.${model.kind}`)}</span></span>
              <span className={css.sampleModel}>{model.name}</span>
              <span className={css.sampleSpec}>{specification(sample, t)}</span>
              <span className={css.samplePrice}><strong>¥{sample.retail_cny}</strong><span>{unitLabel(sample.unit, t)}</span></span>
              <span className={css.sampleOfficial}>{t('comparison.official')} ¥{sample.official_reference.official_cny}</span>
              <Discount row={sample} t={t} />
              <span className={css.viewDetails}>{t('comparison.viewPrices')} · {t('comparison.rowCount', { count: String(model.rows.length) })}</span>
            </button>
          })}
        </div>
      </div>
    </>}
    {selectedModel !== undefined && <Modal open title={t('comparison.detailsTitle', { model: selectedModel.name })}
      closeLabel={t('comparison.closeDetails')} onClose={() => { setSelected(null) }}
      className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''}
      footer={<Button size="sm" variant="outline" onClick={() => { setSelected(null) }}>{t('comparison.done')}</Button>}>
      <div className={css.detailRows} data-kind={selectedModel.kind}>
        <p className={css.note}>{t('comparison.basis')}</p>
        {selectedModel.kind === 'text' && <p className={css.note}>{t('comparison.textBasis')}</p>}
        {selectedModel.rows.map((row, index) => <PriceRow key={index} row={row} t={t} />)}
      </div>
    </Modal>}
  </section>
}
