/** Match authorized model rows to the exact published prices and capacities. @module */
import { readModelConfigVersion, type ModelConfigVersion } from './model-config-version.ts'
import { readProductModelLimits, type ProductModelLimits } from './model-limits.ts'

/** Metadata changed during free directory reads; no generation has been submitted. */
export class ModelCatalogChangedError extends Error {
  /** Free directory reads disagree; never permission to resend a paid operation. */
  readonly code = 'MODEL_CONFIG_CHANGED'
  constructor() { super('Model configuration changed; refresh the model directory before submitting') }
}

/**
 * Index exact model versions, refusing conflicting duplicate declarations.
 * @param rows - Wire rows from one model or pricing response.
 * @param field - Endpoint-owned identifier field.
 * @returns All declared identifiers, including legacy version absence.
 */
export function modelCatalogVersions(rows: readonly unknown[], field: 'id' | 'model_name'): ReadonlyMap<string, ModelConfigVersion | undefined> {
  const versions = new Map<string, ModelConfigVersion | undefined>()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const id = record[field]
    if (typeof id !== 'string' || id === '') continue
    const version = readModelConfigVersion(record)
    if (versions.has(id) && versions.get(id) !== version) throw new ModelCatalogChangedError()
    versions.set(id, version)
  }
  return versions
}

/**
 * Require matching row versions and complete text capacity pairs across endpoints.
 * @param visible - Exact versions from the account-authorized directory.
 * @param pricing - Public pricing rows; extra unauthorized models grant no access.
 * @param limits - Text capacities from the same authorized response.
 * @returns Nothing when the intersection is consistent; legacy omission remains supported.
 * @throws {ModelCatalogChangedError} When a published row disappeared or changed between reads.
 */
export function assertModelCatalogConsistent(visible: ReadonlyMap<string, ModelConfigVersion | undefined>, pricing: readonly unknown[],
  limits: ReadonlyMap<string, ProductModelLimits>): void {
  const prices = modelCatalogVersions(pricing, 'model_name')
  for (const [id, version] of visible) {
    const priceVersion = prices.get(id)
    if (version !== priceVersion || version !== undefined && !prices.has(id)) throw new ModelCatalogChangedError()
    const modelLimits = limits.get(id)
    if (!limits.has(id) || version === undefined && modelLimits?.defaultMaxTokens === undefined) continue
    const row = pricing.find(value => value !== null && typeof value === 'object' && 'model_name' in value && value.model_name === id)
    if (row === undefined || row === null || typeof row !== 'object') throw new ModelCatalogChangedError()
    const priceLimits = readProductModelLimits(row as Record<string, unknown>)
    if (priceLimits.contextWindow !== modelLimits?.contextWindow || priceLimits.maxTokens !== modelLimits?.maxTokens
      || priceLimits.defaultMaxTokens !== modelLimits?.defaultMaxTokens) {
      throw new ModelCatalogChangedError()
    }
  }
}
