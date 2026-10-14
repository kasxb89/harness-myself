/** Sidebar entry glyph for the Mobile page. */
import type { ReactNode } from 'react'
/** Geometry the glyph needs, independent of which sidebar slot renders it. */
export interface PanelGlyphProps {
  /** Square edge in pixels. */
  readonly size: number
  /** Whether the owning surface is the active one; the glyph itself ignores it. */
  readonly active?: boolean
}

/** @param props - glyph geometry only. */
export function MobilePanelIcon({ size }: PanelGlyphProps): ReactNode {
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
      <rect x="4.4" y="1.9" width="7.2" height="12.2" rx="1.6" stroke="currentColor" />
      <path d="M6.9 12.3h2.2" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}
