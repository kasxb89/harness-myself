/** Localized model guidance for the two model pickers, independent of selection. */
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** One model row's display-only guidance. */
export interface ModelGuidance {
  readonly badge?: string
  readonly detail?: string
}

function inheritedGuidance(
  provider: string, model: ModelProviderGroup['models'][number], t: TranslateNS<'model'>,
): ModelGuidance {
  if (provider === 'yunshu-local' && model.id === 'yunshu-flash') {
    return { badge: t('guidance.flagship'), detail: t('guidance.yunshuFlash') }
  }
  if (provider === 'yunshu-local' || provider === 'deepseek-official' || provider === 'deepseek-account') {
    if (model.id === 'deepseek-flash') return { detail: t('guidance.general') }
    if (model.id === 'deepseek-v4-pro') return { detail: t('guidance.reasoning') }
  }
  return { detail: model.description?.trim() || t('guidance.unspecified') }
}

/**
 * Apply plain backend display text, then inherit existing provider/product guidance per absent field.
 * @param provider - Exact available catalog provider ID.
 * @param model - Available model and its provider-authored description.
 * @param t - Model dictionary translator.
 * @returns Display guidance with explicitly empty fields suppressed, independent of model selection.
 */
export function modelGuidance(
  provider: string, model: ModelProviderGroup['models'][number], t: TranslateNS<'model'>,
): ModelGuidance {
  const inherited = inheritedGuidance(provider, model, t)
  const badge = model.presentation?.badge ?? inherited.badge
  const description = model.presentation?.description ?? inherited.detail
  const capabilities = model.textCapabilities
  const verified = capabilities?.schemaVersion === 2
    ? capabilities.verification ?? { tools: 'unverified' as const, vision: 'unverified' as const, reasoning: 'unverified' as const }
    : undefined
  const capabilityFacts = verified === undefined ? [] : [
    t(`guidance.tools.${verified.tools}`), t(`guidance.vision.${verified.vision}`), t(`guidance.reasoning.${verified.reasoning}`),
    ...capabilities?.reasoningMode === 'always_on' ? [t('guidance.reasoningAlwaysOn')] : [],
    ...capabilities?.reasoningMode === 'automatic' ? [t('guidance.reasoningAutomatic')] : [],
    ...capabilities?.operationalStatus === 'fixed_lane_unavailable' ? [t('guidance.routeUnavailable')] : [],
    ...capabilities?.visionConfig?.operationalStatus === 'temporarily_unavailable' ? [t('guidance.visionTemporarilyUnavailable')] : [],
  ]
  const constraints = capabilities === undefined ? [] : [
    ...capabilityFacts,
    ...verified === undefined && !capabilities.tools && !capabilities.vision ? [t('guidance.textOnly')] : [],
    ...verified === undefined && !capabilities.tools ? [t('guidance.noTools')] : [],
    ...verified === undefined && !capabilities.vision ? [t('guidance.noVision')] : [],
    t('guidance.inputLimit', { tokens: capabilities.maxInputTokens.toLocaleString('en-US') }),
  ]
  const detail = [description, ...constraints].filter(value => value !== undefined && value !== '').join(' · ')
  return {
    ...badge === undefined || badge === '' ? {} : { badge },
    ...detail === '' ? {} : { detail },
  }
}
