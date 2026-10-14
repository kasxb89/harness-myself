/**
 * The sidebar footer row that opens the Credits page, carrying the live points
 * balance so the operator sees what is left without opening the page.
 *
 * The number is read from the platform (whose ledger the local new-api backs),
 * never computed here; the row re-reads it on the same heartbeat the page uses.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CreditsPanelIcon } from './CreditsPanelIcon.tsx'
import css from './FooterAction.module.css'

/** What the plugin injects into the footer row. */
export interface FooterInjected {
  /** Label for the row. */
  readonly label: string
  /** Open the Credits page in the main column. */
  readonly open: () => void
}

export function FooterAction(props: PropsRuntime<'sidebar.footer.action'> & FooterInjected): ReactNode {
  const { wide, label, open } = props
  const [points, setPoints] = useState<number | null>(null)

  const load = useCallback(() => {
    void fetch('/credits/api/summary', { headers: { accept: 'application/json' } })
      .then(async response => await response.json() as { payload?: { balance_points?: number } })
      .then(answer => {
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

  return (
    <button
      type="button"
      className={wide ? css.row : `${css.row} ${css.rail}`}
      title={label}
      aria-label={label}
      onClick={open}
    >
      <CreditsPanelIcon size={16} active={false} />
      {wide && <span className={css.label}>{label}</span>}
      {points !== null && (
        <span className={css.badge}>{points.toLocaleString('zh-CN')}</span>
      )}
    </button>
  )
}
