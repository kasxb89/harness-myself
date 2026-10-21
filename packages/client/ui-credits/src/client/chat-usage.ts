/** Read account-owned model settlements without deriving prices from model counters. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'

/** One exact, account-scoped receipt selection owned by the Host. */
export interface ChatUsageQuery {
  readonly sessionId: SessionIdOf
  readonly accountId: string
  readonly turn?: number
}

/** Verified model-request accounting; only fully settled readings carry points. */
export type ChatUsage = {
  readonly accountId: string
  readonly settledRequests: number
  readonly totalRequests: number
} & ({ readonly status: 'settled'; readonly points: number } | { readonly status: 'pending' | 'unavailable' })

/** Safe failure categories support concise retry and sign-in guidance without exposing diagnostics. */
export type ChatUsageReadResult =
  | { readonly ok: true; readonly usage: ChatUsage }
  | { readonly ok: false; readonly reason: 'authorization' | 'rate-limited' | 'unavailable' }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const points = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const authorizationCodes = new Set(['ACCOUNT_CHANGED', 'SESSION_REQUIRED', 'CHAT_USAGE_ACCESS_DENIED', 'CHAT_USAGE_IDENTITY_MISMATCH'])

/**
 * Read this selection once; failures contain only the handling category.
 * @param query - Current attached conversation, optional turn and captured account.
 * @param signal - Component lifetime, identity change or read timeout cancellation.
 * @returns Verified receipt fields or a safe failure reason; no raw diagnostics escape to the UI.
 */
export async function readChatUsage(query: ChatUsageQuery, signal: AbortSignal): Promise<ChatUsageReadResult> {
  const params = new URLSearchParams({ session_id: query.sessionId, account_id: query.accountId })
  if (query.turn !== undefined) params.set('turn', String(query.turn))
  const cancelled = (): boolean => signal.aborted
  if (cancelled()) return { ok: false, reason: 'unavailable' }
  try {
    const response = await fetch(appPath(`/credits/api/chat-usage?${params.toString()}`), {
      headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal,
    })
    if (cancelled()) return { ok: false, reason: 'unavailable' }
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'authorization' }
    if (response.status === 429) return { ok: false, reason: 'rate-limited' }
    const value: unknown = await response.json()
    if (cancelled() || !record(value)) return { ok: false, reason: 'unavailable' }
    if (value.ok === false && typeof value.code === 'string' && authorizationCodes.has(value.code)) {
      return { ok: false, reason: 'authorization' }
    }
    if (!response.ok || value.ok !== true || !record(value.payload)) return { ok: false, reason: 'unavailable' }
    const data = value.payload
    if (typeof data.accountId === 'string' && data.accountId !== query.accountId) return { ok: false, reason: 'authorization' }
    if (data.scope !== 'chat-model' || data.accountId !== query.accountId
      || !count(data.settledRequests) || !count(data.totalRequests) || data.settledRequests > data.totalRequests) {
      return { ok: false, reason: 'unavailable' }
    }
    const shared = { accountId: data.accountId, settledRequests: data.settledRequests, totalRequests: data.totalRequests }
    if (data.status === 'settled') {
      if (!points(data.points) || data.totalRequests === 0 || data.settledRequests !== data.totalRequests) return { ok: false, reason: 'unavailable' }
      return { ok: true, usage: { ...shared, status: 'settled', points: data.points } }
    }
    if ((data.status === 'pending' || data.status === 'unavailable') && data.points === undefined) {
      return { ok: true, usage: { ...shared, status: data.status } }
    }
    return { ok: false, reason: 'unavailable' }
  } catch (_readFailed) { return { ok: false, reason: 'unavailable' } }
}
