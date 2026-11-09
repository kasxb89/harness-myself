/** Detached evidence vocabulary; HTTP origin and request binding remain adapter-owned checks. */
import { ProviderRequestId } from './brand.ts'
import type { LlmTextReselectionProof } from './types.ts'

/**
 * Validate own data properties without executing provider-defined accessors.
 * @param value - serializable evidence carried by an adapter failure.
 * @returns a detached frozen snapshot, or no recovery evidence.
 * @internal
 */
export function textReselectionSnapshot(value: unknown): LlmTextReselectionProof | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const read = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
    }
    const model = read('model')
    const requestId = read('requestId')
    const origin = read('origin')
    const managedScope = read('managedScope')
    const clean = (input: unknown, maximum: number): input is string => typeof input === 'string'
      && input.length > 0 && input.length <= maximum && input.trim() === input && !/[\u0000-\u001f\u007f]/u.test(input)
    if (read('schemaVersion') !== 1 || read('submissionState') !== 'not_submitted'
      || read('upstreamSubmitted') !== false || read('billingReserved') !== false || read('reason') !== 'model_unavailable'
      || !clean(model, 1024) || !clean(requestId, 256) || !clean(origin, 2048) || !clean(managedScope, 512)) return undefined
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.origin !== origin) return undefined
    return Object.freeze({
      schemaVersion: 1, model, requestId: ProviderRequestId(requestId), origin, managedScope,
      submissionState: 'not_submitted', upstreamSubmitted: false, billingReserved: false, reason: 'model_unavailable',
    })
  } catch {
    return undefined
  }
}
