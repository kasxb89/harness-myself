/** The sidebar footer row that opens the Mobile page. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MobilePanelIcon } from './MobilePanelIcon.tsx'
import css from './FooterAction.module.css'

/** What the plugin injects into the footer row. */
export interface FooterInjected {
  /** Label for the row. */
  readonly label: string
  /** Open the Mobile page in the main column. */
  readonly open: () => void
}

export function FooterAction(props: PropsRuntime<'sidebar.footer.action'> & FooterInjected): ReactNode {
  const { wide, label, open } = props
  return (
    <button
      type="button"
      className={wide ? css.row : `${css.row} ${css.rail}`}
      title={label}
      aria-label={label}
      onClick={open}
    >
      <MobilePanelIcon size={wide ? 16 : 20} active={false} />
      <span className={wide ? css.label : css.railLabel}>{label}</span>
    </button>
  )
}
