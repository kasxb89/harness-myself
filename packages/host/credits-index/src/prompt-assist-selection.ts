/** Resolve prompt writing from the same catalog and durable selection as the chat composer. */

import type { ModelCatalog, ModelSelection, SessionProjectionsValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { promptAssistFailure, type PromptAssistFailure } from './prompt-assist.ts'

/** Host-owned readers for one account-authorized prompt-writing selection. */
export interface PromptAssistSelectionOptions {
  readonly sessionId: SessionId | null
  readonly expectedSelection: ModelSelection | null
  readonly hasReferences: boolean
  readonly provider: string
  readonly signal: AbortSignal
  readonly readCatalog: () => Promise<ModelCatalog>
  readonly readProjections: (sessionId: SessionId, signal: AbortSignal) => Promise<SessionProjectionsValue>
  readonly readModelInfo: (provider: string, model: string, signal: AbortSignal) => Promise<Pick<LlmResolvedModelInfo, 'inputModalities'>>
}

/** An exact provider/model/effort identity; no model-name aliasing is permitted. */
export type PromptAssistSelectionResult = { readonly ok: true; readonly selection: ModelSelection } | PromptAssistFailure

/**
 * Compare both provider and model, including the selected reasoning effort.
 * @param left - Previously resolved selection.
 * @param right - Current selection.
 * @returns Whether both selections address the same request configuration.
 */
export function samePromptAssistSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left === null || right === null ? left === right
    : left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/**
 * Recheck the local chat identity without another provider catalog request.
 * @param options - Captured selection and the same Host default and Session readers used by chat.
 * @returns Whether this request still belongs to the current chat model.
 */
export async function isPromptAssistSelectionCurrent(options: {
  readonly sessionId: SessionId | null
  readonly selection: ModelSelection
  readonly signal: AbortSignal
  readonly readProjections: PromptAssistSelectionOptions['readProjections']
  readonly readDefaultSelection: () => ModelSelection
}): Promise<boolean> {
  options.signal.throwIfAborted()
  let selection: ModelSelection | null = null
  if (options.sessionId !== null) {
    const projections = await options.readProjections(options.sessionId, options.signal)
    if (projections === null || projections.kind !== 'sequenced' || projections.values.modelSelection === undefined) return false
    selection = projections.values.modelSelection.next
  }
  return samePromptAssistSelection(selection ?? options.readDefaultSelection(), options.selection)
}

/**
 * Resolve the current chat route and require the signed-in product provider and advertised image capability.
 * @param options - Current session, untrusted expected identity and Host-owned catalog readers.
 * @returns An exact permitted selection, or a safe failure before a billed completion.
 */
export async function resolvePromptAssistSelection(options: PromptAssistSelectionOptions): Promise<PromptAssistSelectionResult> {
  options.signal.throwIfAborted()
  const catalog = await options.readCatalog()
  let selected: ModelSelection | null = null
  if (options.sessionId !== null) {
    const projections = await options.readProjections(options.sessionId, options.signal)
    if (projections === null || projections.kind !== 'sequenced' || projections.values.modelSelection === undefined) {
      return promptAssistFailure('PROMPT_ASSIST_MODEL_UNAVAILABLE')
    }
    selected = projections.values.modelSelection.next
  }
  if (!samePromptAssistSelection(selected, options.expectedSelection)) return promptAssistFailure('PROMPT_ASSIST_SELECTION_CHANGED')
  const selection = selected ?? catalog.default
  if (selection.provider !== options.provider || !catalog.groups.some(group => group.id === selection.provider
    && group.models.some(model => model.id === selection.model))) return promptAssistFailure('PROMPT_ASSIST_MODEL_UNAVAILABLE')
  const info = await options.readModelInfo(selection.provider, selection.model, options.signal)
  options.signal.throwIfAborted()
  if (options.hasReferences && !info.inputModalities?.includes('image')) return promptAssistFailure('PROMPT_ASSIST_VISION_REQUIRED')
  return { ok: true, selection: { ...selection } }
}
