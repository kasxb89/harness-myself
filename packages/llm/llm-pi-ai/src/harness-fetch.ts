/** HTTP transport confinement for the product's deployed Harness model API. */
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Protect the deployed Harness prefix on its shared production authority.
 * @param baseUrl - Configured model API root.
 * @param onResponse - Optional transport observer, including rejected HTTP responses.
 * @returns A prefix-validating, redirect-refusing fetch for Harness, or the provider's normal transport selection.
 * @throws LlmError when the Harness model root can address the adjacent production service.
 */
export function harnessFetch(baseUrl: string, onResponse?: (response: Response) => void): typeof globalThis.fetch | undefined {
  let base: URL
  try { base = new URL(baseUrl) } catch (_invalidProviderUrl: unknown) {
    // Other providers retain the SDK's endpoint validation and transport behavior.
    return undefined
  }
  if (base.hostname !== '8.133.202.230') return undefined
  if (base.origin !== 'https://8.133.202.230' || base.pathname.replace(/\/+$/u, '') !== '/harness/v1'
    || base.username !== '' || base.password !== '' || baseUrl.includes('@') || baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new LlmError('Harness model endpoint must be https://8.133.202.230/harness/v1', 'INVALID_CONFIG')
  }
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin !== base.origin || !url.pathname.startsWith('/harness/v1/')
      || url.username !== '' || url.password !== '' || url.hash !== '' || /%(?:2f|5c|25)/iu.test(url.pathname)) {
      throw new LlmError('Harness model request escaped its configured API prefix', 'INVALID_REQUEST')
    }
    const response = await globalThis.fetch(input, { ...init, redirect: 'error' })
    onResponse?.(response)
    return response
  }
}
