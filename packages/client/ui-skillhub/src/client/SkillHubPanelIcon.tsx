/** Local storefront glyph shared by the sidebar and catalog heading. */
import type { ReactNode } from 'react'

/**
 * Render the skill store without remote artwork or community brand claims.
 * @returns The store's decorative icon.
 */
export function SkillHubPanelIcon(): ReactNode {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 9.5h14v10H5zM4 9.5l2-5h12l2 5M8.5 4.5l-.75 5m7.75-5 .75 5M4 9.5h16M9.5 19.5v-5h5v5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
  </svg>
}
