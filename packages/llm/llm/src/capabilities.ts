/** Capability evidence and explicit execution-policy interpretation. @module */
import type { LlmTextCapabilities, LlmTextCapability } from './types.ts'

/**
 * Resolve an execution decision without turning absent evidence into a denial.
 * @param value - Current exact-route declaration, or no gateway declaration.
 * @param feature - Feature being admitted.
 * @returns Explicit eligibility, or undefined when support remains unverified.
 */
export function effectiveTextCapability(value: LlmTextCapabilities | undefined, feature: LlmTextCapability): boolean | undefined {
  if (value === undefined) return undefined
  if (value.schemaVersion !== 2) return value[feature]
  const verification = value.verification?.[feature]
  if (verification === undefined || verification === 'unverified') return undefined
  return verification === 'unsupported' ? false : value[feature]
}

/**
 * Describe independently confirmed route availability.
 * @param value - Current route declaration.
 * @returns False only for an explicitly unavailable fixed route.
 */
export function textCapabilityRouteAvailable(value: LlmTextCapabilities | undefined): boolean {
  return value?.operationalStatus !== 'fixed_lane_unavailable'
}

/**
 * Describe localized image-input availability without changing capability verification.
 * @param value - Current route declaration.
 * @returns False only for a declared temporary image-input outage.
 */
export function textCapabilityImageAvailable(value: LlmTextCapabilities | undefined): boolean {
  return value?.visionConfig?.operationalStatus !== 'temporarily_unavailable'
}

/**
 * Detach nested evidence, control schemas and modalities from mutable provider metadata.
 * @param value - Adapter-owned declaration.
 * @returns A complete independent declaration.
 */
export function cloneTextCapabilities(value: LlmTextCapabilities): LlmTextCapabilities { return structuredClone(value) }
