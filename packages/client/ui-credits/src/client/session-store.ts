/**
 * The signed-in state both Credits pages read: one session read, one balance
 * read, one heartbeat, shared so the balance page and the top-up page can never
 * disagree about who is signed in or what is left.
 *
 * The points live on the platform (backed by new-api), so this module re-reads
 * them on a fixed interval instead of trying to account locally.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { get, newKey, post } from './api.ts'

/** The signed-in account as the session route reports it. */
export interface SessionInfo {
  readonly signedIn: boolean
  readonly creditsPerYuan: number
  readonly account?: { readonly id: string; readonly phone: string }
  readonly expiresAt?: string
  readonly statePath?: string
}

/** One balance read. */
export interface BalanceResponse {
  readonly balance_points: number
  readonly as_of: string
}

/** What the pages observe. */
export interface CreditsSnapshot {
  /** Changes only when the observed signed-in identity changes, including a logout and return. */
  readonly accountEpoch: number
  /** Latest session, absent until the first read answers. */
  readonly session: SessionInfo | null
  /** Latest balance, absent while signed out or before the first read. */
  readonly balance: BalanceResponse | null
  /** Whether the session read has answered at least once. */
  readonly loaded: boolean
  /** Last read failure, cleared by a successful read. */
  readonly failure: string | null
}

const UNSIGNED: SessionInfo = { signedIn: false, creditsPerYuan: 1000 }
const HEARTBEAT_MS = 60_000

let snapshot: CreditsSnapshot = { accountEpoch: 0, session: null, balance: null, loaded: false, failure: null }
const listeners = new Set<() => void>()
let heartbeats = 0
let heartbeat: ReturnType<typeof setInterval> | null = null
let sessionReadGeneration = 0
let heartbeatRead: AbortController | undefined

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Replace the snapshot and wake every reader. */
function publish(next: Partial<CreditsSnapshot>): void {
  const identity = (session: SessionInfo | null): string | null => session?.signedIn === true ? session.account?.id ?? null : null
  const changed = next.session !== undefined && identity(next.session) !== identity(snapshot.session)
  snapshot = { ...snapshot, ...next, accountEpoch: snapshot.accountEpoch + Number(changed) }
  for (const listener of listeners) listener()
}

/**
 * Read the current balance.
 * @param signal - optional owner cancellation.
 */
export async function refreshBalance(signal?: AbortSignal): Promise<void> {
  const session = snapshot.session
  const answer = await get<BalanceResponse>('/credits/api/summary', signal)
  if (signal?.aborted === true || snapshot.session !== session) return
  if (answer.sessionInvalid === true) {
    publish({ session: { ...UNSIGNED, creditsPerYuan: snapshot.session?.creditsPerYuan ?? 1000 }, balance: null })
    return
  }
  if (answer.payload !== undefined) publish({ balance: answer.payload, failure: null })
  else if (answer.code !== null && answer.code !== undefined) publish({ failure: answer.message ?? answer.code })
}

/**
 * Re-read the session itself, not only the balance: a sign-in completed outside
 * these pages (the login API, another window) must reach them.
 * @param signal - optional owner cancellation.
 */
export async function refreshCredits(signal?: AbortSignal): Promise<void> {
  const generation = ++sessionReadGeneration
  const answer = await get<SessionInfo>('/credits/api/session', signal)
  if (signal?.aborted === true || generation !== sessionReadGeneration) return
  const info = answer.payload ?? UNSIGNED
  publish({ session: info, loaded: true, failure: null })
  if (info.signedIn) await refreshBalance(signal)
  else publish({ balance: null })
}

/** Sign out: revoke on the platform, clear locally. */
export async function signOutCredits(): Promise<void> {
  sessionReadGeneration += 1
  heartbeatRead?.abort()
  publish({ session: { ...UNSIGNED, creditsPerYuan: snapshot.session?.creditsPerYuan ?? 1000 }, balance: null })
  try {
    await post('/credits/api/session/logout', { idempotencyKey: newKey('logout') })
  } catch (_error) {
    // Locally cleared regardless; 503 does not prove the revoke did not happen.
  }
}

/**
 * Keep the session fresh while at least one page is mounted. The interval and
 * the focus listener belong to the module, not to one page, so switching
 * panels neither restarts nor duplicates the read.
 */
function retainHeartbeat(): void {
  heartbeats += 1
  if (heartbeat !== null) return
  const refresh = (): void => {
    heartbeatRead?.abort()
    const controller = new AbortController()
    heartbeatRead = controller
    const pending = refreshCredits(controller.signal)
    const generation = sessionReadGeneration
    void pending.catch((_readFailed: unknown) => {
      if (!controller.signal.aborted && generation === sessionReadGeneration) publish({ loaded: true, failure: 'ACCOUNT_UNAVAILABLE' })
    }).finally(() => {
      if (heartbeatRead === controller) heartbeatRead = undefined
    })
  }
  refresh()
  const onFocus = refresh
  window.addEventListener('focus', onFocus)
  heartbeat = setInterval(refresh, HEARTBEAT_MS)
  heartbeatCleanup = () => { window.removeEventListener('focus', onFocus) }
}

let heartbeatCleanup: (() => void) | null = null

function releaseHeartbeat(): void {
  heartbeats -= 1
  if (heartbeats > 0 || heartbeat === null) return
  clearInterval(heartbeat)
  heartbeat = null
  heartbeatRead?.abort()
  heartbeatRead = undefined
  heartbeatCleanup?.()
  heartbeatCleanup = null
}

/**
 * Expose the existing account snapshot to injected client consumers.
 * @returns an identity-stable source whose subscriptions retain the shared heartbeat.
 */
export function createCreditsSessionSource(): ObservableSnapshot<CreditsSnapshot> {
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      const unsubscribe = subscribe(listener)
      retainHeartbeat()
      return () => { unsubscribe(); releaseHeartbeat() }
    },
  }
}

/**
 * Subscribe to Credits session and balance changes while retaining the heartbeat.
 * @returns the shared signed-in state and latest balance read.
 */
export function useCreditsSnapshot(): CreditsSnapshot {
  useEffect(() => {
    retainHeartbeat()
    return () => { releaseHeartbeat() }
  }, [])
  return useSyncExternalStore(subscribe, () => snapshot)
}
