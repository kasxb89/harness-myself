/** Live routed output reservations and default-only capacity scaling for compaction. @module */
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import type { ResolvedTargetPolicy } from './types.ts'

/**
 * Match the next request's output reservation against current model metadata.
 * @param header - Last logged request; adapter-default markers must not freeze stale defaults.
 * @param model - Live exact route metadata, including its optional hard output cap.
 * @returns Effective output reserve, or zero when no output limit is declared.
 */
export function reservedCompletionTokens(header: EpochHeader | undefined, model: Readonly<LlmResolvedModelInfo>): number {
  const sameRoute = header?.config.provider === model.provider && header.config.model === model.id
  const explicit = sameRoute && header.adapterDefaults?.maxTokens !== true ? header.config.maxTokens : undefined
  const proposed = explicit ?? model.defaultMaxTokens ?? model.maxOutputTokens ?? 0
  return model.maxOutputTokens === undefined ? proposed : Math.min(proposed, model.maxOutputTokens)
}

/**
 * Resolve additional headroom without changing explicitly configured token counts.
 * @param policy - Validated policy with a marker only when headroom was omitted.
 * @param messageBudgetTokens - Live context capacity minus the effective routed output reservation.
 * @returns Exact explicit headroom, or at most the default ceiling and the threshold's remaining window fraction.
 */
export function resolvedHeadroomTokens(
  policy: Pick<ResolvedTargetPolicy, 'headroomTokens' | 'headroomTokensDefaulted' | 'thresholdRatio'>,
  messageBudgetTokens: number,
): number {
  return policy.headroomTokensDefaulted === true
    ? Math.min(policy.headroomTokens, Math.max(1, Math.floor(messageBudgetTokens * (1 - policy.thresholdRatio))))
    : policy.headroomTokens
}
