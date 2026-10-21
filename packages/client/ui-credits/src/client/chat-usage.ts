/** Read account-owned model settlements without deriving prices from model counters. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'

/** One exact, account-scoped receipt selection owned by the Host. */
export interface ChatUsageQuery {
  readonly sessionId: SessionIdOf
  readonly accountId: string
  readonly turn?: number
}

/** Verified model-request accounting; only settled readings carry points. */
export type ChatUsage = {
  readonly accountId: string
  readonly settledRequests: number
  readonly totalRequests: number
} & ({ readonly status: 'settled'; readonly points: number } | { readonly status: 'pending' | 'unavailable' })

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Read this selection once; network, HTTP and malformed responses remain unavailable.
 * @param query - Current attached conversation, optional turn and captured account.
 * @param signal - Component lifetime, identity change or read timeout cancellation.
 * @returns Only verified receipt fields, or null; no raw diagnostics escape to the UI.
 */
export async function readChatUsage(query: ChatUsageQuery, signal: AbortSignal): Promise<ChatUsage | null> {
  const params = new URLSearchParams({ session_id: query.sessionId, account_id: query.accountId })
  if (query.turn !== undefined) params.set('turn', String(query.turn))
  const cancelled = (): boolean => signal.aborted
  try {
    const response = await fetch(appPath(`/credits/api/chat-usage?${params.toString()}`), {
      headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal,
    })
    if (!response.ok || signal.aborted) return null
    const value: unknown = await response.json()
    if (cancelled() || !record(value) || value.ok !== true || !record(value.payload)) return null
    const data = value.payload
    if (data.scope !== 'chat-model' || data.accountId !== query.accountId
      || !count(data.settledRequests) || !count(data.totalRequests) || data.settledRequests > data.totalRequests) return null
    const shared = { accountId: data.accountId, settledRequests: data.settledRequests, totalRequests: data.totalRequests }
    if (data.status === 'settled') {
      if (typeof data.points !== 'number' || !Number.isFinite(data.points) || data.points < 0
        || data.totalRequests === 0 || data.settledRequests !== data.totalRequests) return null
      return { ...shared, status: 'settled', points: data.points }
    }
    if ((data.status === 'pending' || data.status === 'unavailable') && data.points === undefined) {
      return { ...shared, status: data.status }
    }
    return null
  } catch (_readFailed) { return null }
}
