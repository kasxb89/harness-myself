/** Account-bound capacities disclosed by the product model endpoint. */
import { createHash } from 'node:crypto'

/** Verified positive token capacities for one exact public model id. */
export interface ProductModelLimits {
  /** Maximum combined request and response window. */
  contextWindow?: number
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

/**
 * Read the public endpoint's explicit capacity fields without inferring aliases.
 * @param record - one untrusted model-list entry.
 * @returns independently valid capacities, or no update for an inconsistent pair.
 */
export function readProductModelLimits(record: Readonly<Record<string, unknown>>): ProductModelLimits {
  const contextWindow = tokenCapacity(record.context_window)
  const maxTokens = tokenCapacity(record.max_output_tokens)
  if (contextWindow !== undefined && maxTokens !== undefined && maxTokens > contextWindow) return {}
  return { ...contextWindow === undefined ? {} : { contextWindow }, ...maxTokens === undefined ? {} : { maxTokens } }
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
 * Refresh automatic capacities while retaining each missing or invalid field for the same owner.
 * @param previous - the model's previously persisted managed metadata.
 * @param incoming - valid fields from the current successful model listing.
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
  return contextWindow === undefined && maxTokens === undefined ? undefined
    : { scope, ...contextWindow === undefined ? {} : { contextWindow }, ...maxTokens === undefined ? {} : { maxTokens } }
}
