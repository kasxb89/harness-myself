/**
 * The signed-in state both Credits pages read: one session read, one balance
 * read, one heartbeat, shared so the balance page and the top-up page can never
 * disagree about who is signed in or what is left.
 *
 * The points live on the platform (backed by new-api), so this module re-reads
 * them on a fixed interval instead of trying to account locally.
 */
import { useEffect, useSyncExternalStore } from 'react'
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

let snapshot: CreditsSnapshot = { session: null, balance: null, loaded: false, failure: null }
const listeners = new Set<() => void>()
let heartbeats = 0
let heartbeat: ReturnType<typeof setInterval> | null = null

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Replace the snapshot and wake every reader. */
function publish(next: Partial<CreditsSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

/** Read the balance of the current session. */
export async function refreshBalance(): Promise<void> {
  const answer = await get<BalanceResponse>('/credits/api/summary')
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
 */
export async function refreshCredits(): Promise<void> {
  const answer = await get<SessionInfo>('/credits/api/session')
  const info = answer.payload ?? UNSIGNED
  publish({ session: info, loaded: true })
  if (info.signedIn) await refreshBalance()
  else publish({ balance: null })
}

/** Sign out: revoke on the platform, clear locally. */
export async function signOutCredits(): Promise<void> {
  try {
    await post('/credits/api/session/logout', { idempotencyKey: newKey('logout') })
  } catch {
    // Locally cleared regardless; 503 does not prove the revoke did not happen.
  }
  publish({ session: { ...UNSIGNED, creditsPerYuan: snapshot.session?.creditsPerYuan ?? 1000 }, balance: null })
}

/**
 * Keep the session fresh while at least one page is mounted. The interval and
 * the focus listener belong to the module, not to one page, so switching
 * panels neither restarts nor duplicates the read.
 */
function retainHeartbeat(): void {
  heartbeats += 1
  if (heartbeat !== null) return
  void refreshCredits()
  const onFocus = (): void => { void refreshCredits() }
  window.addEventListener('focus', onFocus)
  heartbeat = setInterval(() => { void refreshCredits() }, HEARTBEAT_MS)
  heartbeatCleanup = () => { window.removeEventListener('focus', onFocus) }
}

let heartbeatCleanup: (() => void) | null = null

function releaseHeartbeat(): void {
  heartbeats -= 1
  if (heartbeats > 0 || heartbeat === null) return
  clearInterval(heartbeat)
  heartbeat = null
  heartbeatCleanup?.()
  heartbeatCleanup = null
}

/** @returns the shared signed-in state, keeping the heartbeat alive while mounted. */
export function useCreditsSnapshot(): CreditsSnapshot {
  useEffect(() => {
    retainHeartbeat()
    return () => { releaseHeartbeat() }
  }, [])
  return useSyncExternalStore(subscribe, () => snapshot)
}
