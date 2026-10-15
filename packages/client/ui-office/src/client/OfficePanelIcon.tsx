/** The sidebar glyph for the Office column. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export function OfficePanelIcon(_props: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2 6h12M6.5 6v7.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}
