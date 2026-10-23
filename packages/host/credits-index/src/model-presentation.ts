/** Deployment preferences applied only to a caller's authorized model directory. */
import type { ModelCatalogModel } from '@deepseek-ai/dsh-api-session-controller/types'

/** Exact-model display text; empty strings intentionally suppress local descriptions or badges. */
export type ProductModelDisplay = NonNullable<ModelCatalogModel['presentation']>

/** Deployment display entries, separate from default-model and ordering preferences. */
export type ProductModelDisplayMap = Readonly<Record<string, ProductModelDisplay>>

/** Deployment default and ordering preferences applied only to authorized model ids. */
export interface ProductModelPresentation {
  readonly defaultChatModel: string | null
  readonly modelOrder: readonly string[]
}

/**
 * Compare only display fields of already authorized models, independently of remote object-key order.
 * @param ids - Ordered current account model ids.
 * @param displays - Last validated public display entries; absence inherits local text.
 * @returns A stable signature which distinguishes explicit empty fields from inherited fields.
 */
export function productModelDisplaySignature(ids: readonly string[], displays: ProductModelDisplayMap | undefined): string {
  return JSON.stringify(ids.map((id) => {
    const entry = displays !== undefined && Object.hasOwn(displays, id) ? displays[id] : undefined
    return [id, entry?.description ?? null, entry?.badge ?? null]
  }))
}

/**
 * Order existing model ids without adding entries or rearranging unranked peers.
 * @param ids - model ids already authorized for the current account.
 * @param policy - deployment display preferences.
 * @returns a detached array with ranked models first and all other models stable.
 */
export function orderProductModels(ids: readonly string[], policy: ProductModelPresentation): string[] {
  const rank = new Map(policy.modelOrder.map((id, index) => [id, index]))
  const last = rank.size
  return [...ids].sort((left, right) => (rank.get(left) ?? last) - (rank.get(right) ?? last))
}

/**
 * Select a default only from the account's available chat models.
 * @param chatIds - authorized chat ids with media generators already excluded.
 * @param policy - deployment default and ordering preferences.
 * @returns the available preferred chat, the first ordered chat, or no selection.
 */
export function preferredProductModel(chatIds: readonly string[], policy: ProductModelPresentation): string | undefined {
  return policy.defaultChatModel !== null && chatIds.includes(policy.defaultChatModel)
    ? policy.defaultChatModel : orderProductModels(chatIds, policy)[0]
}
