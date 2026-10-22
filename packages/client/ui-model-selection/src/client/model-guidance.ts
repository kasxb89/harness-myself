/** Localized model guidance for the two model pickers, independent of selection. */
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** One model row's display-only guidance. */
export interface ModelGuidance {
  readonly badge?: string
  readonly detail: string
}

/**
 * Describe known product routes without inferring performance from model names.
 * @param provider - Exact available catalog provider ID.
 * @param model - Available model and its provider-authored description.
 * @param t - Model dictionary translator.
 * @returns Localized product guidance, or the provider's plain-text description.
 */
export function modelGuidance(
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
