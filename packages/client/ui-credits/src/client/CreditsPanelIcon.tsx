/** Sidebar entry glyph for the Credits page. */
import type { ReactNode } from 'react'
/** Geometry the glyph needs, independent of which sidebar slot renders it. */
export interface PanelGlyphProps {
  /** Square edge in pixels. */
  readonly size: number
  /** Whether the owning surface is the active one; the glyph itself ignores it. */
  readonly active?: boolean
}

/** @param props - glyph geometry only. */
export function CreditsPanelIcon({ size }: PanelGlyphProps): ReactNode {
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
      <circle cx="8" cy="8" r="5.4" stroke="currentColor" />
      <path d="M8 4.9v6.2M9.9 6.2c-.5-.6-1.2-.9-1.9-.9-1 0-1.8.6-1.8 1.5 0 1 .9 1.4 1.9 1.6 1.1.2 2 .5 2 1.5 0 .9-.9 1.5-2 1.5-.8 0-1.5-.3-2-.9" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}
