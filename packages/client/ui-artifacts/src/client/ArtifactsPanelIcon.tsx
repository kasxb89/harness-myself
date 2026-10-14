/** Sidebar entry glyph for the Artifacts page. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** @param props - the sidebar.panellist entry share, naming only the glyph size. */
export function ArtifactsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth="1"
    >
      <path d="M2.6 3.4h4.1l1.2 1.6h5.5v7.6H2.6z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M5.2 7.1h5.6M5.2 9.3h3.4" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}
