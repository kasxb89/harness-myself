/** Schema-aware reasoning controls shared by both model entries and their Session directory. */
import type { ModelCatalogModel, ModelReasoning } from '@deepseek-ai/dsh-api-session-controller/types'

/**
 * Distinguish an adjustable strength from reasoning that merely stays enabled.
 * @param model - Exact catalog row, or no current row.
 * @returns Whether its mode declares usable controls without fabricating a switch.
 */
export function reasoningControlsAllowed(model: ModelCatalogModel | undefined): boolean {
  const capabilities = model?.textCapabilities
  if (model?.executionCapabilities?.reasoning === false
    || capabilities?.schemaVersion !== 2 && capabilities?.reasoning === false) return false
  if (capabilities?.schemaVersion !== 2) return true
  if (capabilities.reasoningMode === 'configurable') return true
  return capabilities.reasoningMode === 'always_on'
    && (capabilities.reasoningControls?.properties.reasoning_effort?.enum.length ?? 0) > 0
}

/**
 * Keep Host choices exact; an always-on enum adjusts strength without adding Off.
 * @param model - Current catalog row.
 * @returns Advertised choices, or no selector; Auto remains an omitted request field.
 */
export function selectableModelReasoning(model: ModelCatalogModel | undefined): ModelReasoning | undefined {
  if (!reasoningControlsAllowed(model)) return undefined
  const reasoning = model?.reasoning
  const capabilities = model?.textCapabilities
  if (reasoning === undefined || capabilities?.schemaVersion !== 2 || capabilities.reasoningMode !== 'always_on') return reasoning
  const declared = capabilities.reasoningControls?.properties.reasoning_effort?.enum ?? []
  const efforts = reasoning.efforts.filter(value => declared.includes(value.id))
  return efforts.length === 0 ? undefined : { efforts }
}
