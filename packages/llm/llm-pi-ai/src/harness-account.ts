/** Live product-account authorization for the Harness model route. */
import type {} from '@deepseek-ai/cordis'

/** Session-owned relay credentials never fall back to environment layers. */
export interface HarnessAccount {
  /** Product provider route owned by this account controller. */
  readonly provider: string
  /**
   * Refresh the current account's model configuration before listing it.
   * @param baseURL - Exact model API root whose catalog is requested.
   * @returns Current model IDs after configuration is synchronized; empty hides every old model. Unavailable or changed accounts reject.
   */
  refreshModels(baseURL: string): Promise<readonly string[]>
  /**
   * Resolve the current signed-in account after checking its backend and expiry.
   * @param baseURL - Exact model API root being requested.
   * @param expectedModelLimitsScope - Optional account/backend binding captured with prepared model limits;
   * a changed account must refuse it, while ordinary same-account credential renewal keeps it valid.
   * @returns The current relay key, or undefined when no live session authorizes this exact request scope.
   */
  resolveRelayKey(baseURL: string, expectedModelLimitsScope?: string): Promise<string | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    harnessAccount: HarnessAccount
  }
}
