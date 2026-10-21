/** Deployment preferences applied only to a caller's authorized model directory. */
export interface ProductModelPresentation {
  readonly defaultChatModel: string | null
  readonly modelOrder: readonly string[]
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
