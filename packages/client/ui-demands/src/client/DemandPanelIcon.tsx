/** Sidebar mark for private requests to human engineers. */
import { IconNewChatOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render the existing message glyph in the sidebar's icon seat.
 * @param _props - Framework-owned panel-list inputs.
 * @returns The decorative request icon.
 */
export function DemandPanelIcon(_props: PropsRuntime<'sidebar.panellist'>) {
  return <IconNewChatOutlineRegular size={18} />
}
