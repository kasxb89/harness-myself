/** Sidebar entry glyph for the AI image page. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** @param props - the sidebar.panellist entry share, naming only the glyph size. */
export function ImagePanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
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
      <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4" stroke="currentColor" />
      <path d="M2.6 10.4l3-2.6 2.3 1.9 2.6-2.9 3 3.6" stroke="currentColor" strokeLinejoin="round" />
      <circle cx="6.1" cy="6.2" r="1" stroke="currentColor" />
    </svg>
  )
}
