/**
 * The sidebar foot's wallet block: the balance row that opens the Credits page,
 * then the top-up entry under it.
 *
 * The number is read from the platform (whose ledger the local new-api backs),
 * never computed here; the block re-reads it on the same heartbeat the page
 * uses. Top-up carries the preset amounts an operator actually buys, in one
 * row of chips, with the free amount last as the escape hatch. A chip never
 * pays by itself: it opens the page with that amount ready, so an accidental
 * click cannot create an order.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { appPath, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CreditsPanelIcon } from './CreditsPanelIcon.tsx'
import { cx } from './class-names.ts'
import { QUICK_AMOUNTS_YUAN } from './recharge-amounts.ts'
import { requestRecharge } from './recharge-request.ts'
import css from './FooterAction.module.css'

/** What the plugin injects into the footer block. */
export interface FooterInjected {
  /** Label for the balance row. */
  readonly label: string
  /** Label for the top-up entry. */
  readonly rechargeLabel: string
  /** Label for the free-amount chip. */
  readonly customLabel: string
  /** Open the balance page in the main column. */
  readonly open: () => void
  /** Open the top-up page in the main column. */
  readonly openRecharge: () => void
}

export function FooterAction(props: PropsRuntime<'sidebar.footer.action'> & FooterInjected): ReactNode {
  const { wide, label, rechargeLabel, customLabel, open, openRecharge } = props
  const [points, setPoints] = useState<number | null>(null)

  const load = useCallback(() => {
    void fetch(appPath('/credits/api/summary'), { headers: { accept: 'application/json' } })
      .then(async response => await response.json() as { payload?: { balance_points?: number } } | null)
      .then((answer) => {
        const value = answer?.payload?.balance_points
        setPoints(typeof value === 'number' ? value : null)
      })
      .catch(() => { /* A signed-out or offline read simply leaves the badge empty. */ })
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 60_000)
    const onFocus = (): void => { load() }
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [load])

  /** Open the top-up page with `amount` waiting in its field; null clears it. */
  const start = (amount: number | null): void => {
    requestRecharge(amount)
    openRecharge()
  }

  if (!wide) {
    return (
      <>
        <button
          type="button"
          className={cx(css.row, css.rail)}
          title={label}
          aria-label={label}
          onClick={open}
        >
          <CreditsPanelIcon size={20} />
          <span className={css.railLabel}>{label}</span>
        </button>
        <button
          type="button"
          className={cx(css.row, css.rail)}
          title={rechargeLabel}
          aria-label={rechargeLabel}
          onClick={() => { start(null) }}
        >
          <IconPlusOutlineRegular size={20} />
          <span className={css.railLabel}>{rechargeLabel}</span>
        </button>
      </>
    )
  }

  return (
    <div className={css.block}>
      <button
        type="button"
        className={css.row}
        title={label}
        aria-label={label}
        onClick={open}
      >
        <CreditsPanelIcon size={16} />
        <span className={css.label}>{label}</span>
        {points !== null && (
          <span className={css.badge}>{points.toLocaleString('zh-CN')}</span>
        )}
      </button>
      <button
        type="button"
        className={css.recharge}
        aria-label={rechargeLabel}
        onClick={() => { start(null) }}
      >
        <IconPlusOutlineRegular size={14} />
        {rechargeLabel}
      </button>
      <div className={css.quick}>
        {QUICK_AMOUNTS_YUAN.map(value => (
          <button
            key={value}
            type="button"
            className={css.chip}
            onClick={() => { start(value) }}
          >
            {value.toLocaleString('zh-CN')}
          </button>
        ))}
        <button
          type="button"
          className={cx(css.chip, css.custom)}
          onClick={() => { start(null) }}
        >
          {customLabel}
        </button>
      </div>
    </div>
  )
}
