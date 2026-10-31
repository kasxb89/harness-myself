/** Account-bound capacities disclosed by the product model endpoint. */
import { createHash } from 'node:crypto'
import type { LlmTextCapabilities } from '@deepseek-ai/dsh-llm'

/** Current capacity and execution declarations for one exact public model id. */
export interface ProductModelLimits {
  /** Maximum combined request and response window. */
  contextWindow?: number
  /** Explicit execution declarations from this account’s current gateway directory. */
  textCapabilities?: LlmTextCapabilities
  /** Maximum generated output, including any reasoning counted in that output. */
  maxTokens?: number
}

/** Automatically managed capacities, separate from a user's model settings. */
export interface ManagedModelLimits extends ProductModelLimits {
  /** Non-secret fingerprint of the complete backend root and account id. */
  scope: string
}

/** A token capacity fits the gateway's positive signed 32-bit count. */
function tokenCapacity(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
    ? value : undefined
}

/** Invalid gateway execution declarations make the directory update unusable. */
export class ProductModelCapabilitiesError extends Error {}

/** Read a complete declaration without treating malformed or omitted booleans as support. */
function readTextCapabilities(record: Readonly<Record<string, unknown>>): LlmTextCapabilities | undefined {
  const parameters = record.parameters
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)
    || !('x-text-capabilities' in parameters)) return undefined
  const value: unknown = parameters['x-text-capabilities']
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !('tools' in value) || typeof value.tools !== 'boolean'
    || !('vision' in value) || typeof value.vision !== 'boolean'
    || !('reasoning' in value) || typeof value.reasoning !== 'boolean'
    || !('stream' in value) || typeof value.stream !== 'boolean'
    || !('max_input_tokens' in value) || tokenCapacity(value.max_input_tokens) === undefined) {
    throw new ProductModelCapabilitiesError('Invalid gateway text execution declaration')
  }
  return { tools: value.tools, vision: value.vision, reasoning: value.reasoning, stream: value.stream,
    maxInputTokens: Number(value.max_input_tokens) }
}

/**
 * Read the public endpoint's explicit capacity fields without inferring aliases.
 * @param record - one untrusted model-list entry.
 * @returns valid numeric capacities and any complete execution declaration.
 * @throws {ProductModelCapabilitiesError} When an explicit execution declaration is malformed.
 */
export function readProductModelLimits(record: Readonly<Record<string, unknown>>): ProductModelLimits {
  const textCapabilities = readTextCapabilities(record)
  const declared = textCapabilities === undefined ? {} : { textCapabilities }
  const contextWindow = tokenCapacity(record.context_window)
  const maxTokens = tokenCapacity(record.max_output_tokens)
  if (contextWindow !== undefined && maxTokens !== undefined && maxTokens > contextWindow) return declared
  return { ...declared, ...contextWindow === undefined ? {} : { contextWindow }, ...maxTokens === undefined ? {} : { maxTokens } }
}

/**
 * Bind retained capacities to the full deployment root and account without storing credentials.
 * @param baseUrl - normalized API root, including its deployment prefix.
 * @param accountId - the verified product account id.
 * @returns a stable, non-secret scope for this backend and account.
 */
export function productModelLimitsScope(baseUrl: string, accountId: string): string {
  return createHash('sha256').update(JSON.stringify(['product-model-limits-v1', baseUrl, accountId])).digest('hex')
}

/**
 * Refresh same-owner capacities and replace execution policy only after a successful listing.
 * @param previous - the model's previously persisted managed metadata.
 * @param incoming - successful fields; an empty object clears execution policy, while undefined retains it during a pending read.
 * @param scope - current backend and account binding.
 * @returns updated managed metadata, never capacities belonging to another scope.
 */
export function mergeProductModelLimits(
  previous: unknown,
  incoming: ProductModelLimits | undefined,
  scope: string,
): ManagedModelLimits | undefined {
  const record = previous !== null && typeof previous === 'object' && !Array.isArray(previous)
    ? previous as Record<string, unknown> : undefined
  const retained = record?.scope === scope ? record : undefined
  const contextWindow = incoming?.contextWindow ?? tokenCapacity(retained?.contextWindow)
  const maxTokens = incoming?.maxTokens ?? tokenCapacity(retained?.maxTokens)
  const retainedCapabilities = retained?.textCapabilities
  const textCapabilities = incoming === undefined && retainedCapabilities !== undefined
    ? readTextCapabilities({ parameters: { 'x-text-capabilities':
      retainedCapabilities !== null && typeof retainedCapabilities === 'object'
        ? { ...retainedCapabilities,
          max_input_tokens: 'maxInputTokens' in retainedCapabilities ? retainedCapabilities.maxInputTokens : undefined }
        : retainedCapabilities } })
    : incoming?.textCapabilities
  return contextWindow === undefined && maxTokens === undefined && textCapabilities === undefined ? undefined
    : { scope, ...textCapabilities === undefined ? {} : { textCapabilities: { ...textCapabilities } },
      ...contextWindow === undefined ? {} : { contextWindow }, ...maxTokens === undefined ? {} : { maxTokens } }
}
