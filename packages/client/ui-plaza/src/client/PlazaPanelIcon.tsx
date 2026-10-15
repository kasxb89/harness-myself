/** The sidebar glyph for the Plaza column. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export function PlazaPanelIcon(_props: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2.5 6.2V12a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V6.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M1.8 4.6 3 2.9a1.2 1.2 0 0 1 1-.5h8a1.2 1.2 0 0 1 1 .5l1.2 1.7a2 2 0 0 1-3.4 2.1 2 2 0 0 1-3.6 0 2 2 0 0 1-3.6 0 2 2 0 0 1-3.4-2.1Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M6.4 9.4h3.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
