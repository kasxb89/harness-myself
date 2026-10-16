/** Live product-account authorization for the Harness model route. */
import type {} from '@deepseek-ai/cordis'

/** Session-owned relay credentials never fall back to environment layers. */
export interface HarnessAccount {
  /** Product provider route owned by this account controller. */
  readonly provider: string
  /**
   * Resolve the current signed-in account after checking its backend and expiry.
   * @param baseURL - Exact model API root being requested.
   * @returns The current relay key, or undefined when no live session authorizes the request.
   */
  resolveRelayKey(baseURL: string): Promise<string | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    harnessAccount: HarnessAccount
  }
}
