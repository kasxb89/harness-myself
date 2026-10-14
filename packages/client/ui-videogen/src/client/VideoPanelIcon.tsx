/** Sidebar entry glyph for the Video page. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** @param props - the sidebar.panellist entry share, naming only the glyph size. */
export function VideoPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
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
      <rect x="1.9" y="3.6" width="9.4" height="8.8" rx="1.4" stroke="currentColor" />
      <path d="M11.6 8.2l2.6-1.9v5.4l-2.6-1.9z" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  )
}
