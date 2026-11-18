/** Sidebar mark for private requests to human engineers. */
import type { ReactNode } from 'react'
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render a request-list glyph distinct from the chat entry.
 * @param _props - Framework-owned panel-list inputs.
 * @returns The decorative request icon.
 */
export function DemandPanelIcon(_props: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconChecklistOutlineRegular size={18} />
}
