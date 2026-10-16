/** Existing skill glyph reused by the store's sidebar row. */
import type { ReactNode } from 'react'
import { IconSkillOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the store glyph without adding separate artwork.
 * @returns The existing skill icon.
 */
export function SkillHubPanelIcon(): ReactNode {
  return <IconSkillOutlineRegular />
}
