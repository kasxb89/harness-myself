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
import type { PhoneRecovery } from './phone-sign-in.ts'
import { creditsReadFailure, creditsRetrySeconds, type CreditsReadFailure } from './read-failure.ts'

/** The signed-in account as the session route reports it. */
export interface SessionInfo {
  readonly signedIn: boolean
  readonly creditsPerYuan: number
  readonly account?: { readonly id: string; readonly phone: string }
  /** Stable login scope supplied by the Host; absent on older read-only-compatible Hosts. */
  readonly accountOwner?: string
  readonly expiresAt?: string
  readonly statePath?: string
  readonly phoneRecoveryAvailable?: boolean
  readonly phoneRecovery?: PhoneRecovery | null
}

/** One balance read. */
export interface BalanceResponse {
  readonly balance_points: number
  readonly as_of?: string
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
  /** Safe read classification; a failed refresh retains this account's last successful balance. */
  readonly readFailure?: CreditsReadFailure | null
  /** One current-account balance request is in progress. */
  readonly refreshing?: boolean
}

const UNSIGNED: SessionInfo = { signedIn: false, creditsPerYuan: 1000 }
const HEARTBEAT_MS = 60_000

let snapshot: CreditsSnapshot = { accountEpoch: 0, session: null, balance: null,
  loaded: false, failure: null, readFailure: null, refreshing: false }
const listeners = new Set<() => void>()
let heartbeats = 0
let heartbeat: ReturnType<typeof setInterval> | null = null
let sessionReadGeneration = 0
let heartbeatRead: AbortController | undefined
let balanceReadGeneration = 0
let balanceRead: { epoch: number; signal?: AbortSignal; promise: Promise<void> } | undefined

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Replace the snapshot and wake every reader. */
function publish(next: Partial<CreditsSnapshot>): void {
  const identity = (session: SessionInfo | null): string | null => session?.signedIn === true
    ? JSON.stringify([session.account?.id ?? null, session.accountOwner ?? null]) : null
  const changed = next.session !== undefined && identity(next.session) !== identity(snapshot.session)
  snapshot = { ...snapshot, ...changed ? { balance: null, failure: null, readFailure: null, refreshing: false } : {},
    ...next, accountEpoch: snapshot.accountEpoch + Number(changed) }
  for (const listener of listeners) listener()
}

/**
 * Read the current balance.
 * @param signal - optional owner cancellation.
 */
export async function refreshBalance(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true || snapshot.session?.signedIn !== true || creditsRetrySeconds(snapshot.readFailure) > 0) return
  const epoch = snapshot.accountEpoch
  const accountId = snapshot.session.account?.id
  const accountOwner = snapshot.session.accountOwner
  if (balanceRead?.epoch === epoch && balanceRead.signal?.aborted !== true) return balanceRead.promise
  const generation = ++balanceReadGeneration
  const current = (): boolean => signal?.aborted !== true && generation === balanceReadGeneration && snapshot.accountEpoch === epoch
  publish({ refreshing: true })
  const operation = (async () => {
    try {
      const answer = await get<BalanceResponse | null>('/credits/api/summary', signal)
      if (!current()) return
      if (!answer.ok || answer.sessionInvalid === true) {
        const failure = creditsReadFailure(answer.sessionInvalid === true ? { code: 'SESSION_INVALID' } : answer, 'BALANCE_UNAVAILABLE')
        publish({ failure: failure.code, readFailure: failure })
        return
      }
      if (answer.payload == null || typeof answer.payload.balance_points !== 'number'
        || !Number.isFinite(answer.payload.balance_points) || answer.payload.balance_points < 0) {
        const failure = creditsReadFailure(undefined, 'BALANCE_INVALID_RESPONSE')
        publish({ failure: failure.code, readFailure: failure })
        return
      }
      if (answer.account !== undefined && answer.account?.id !== accountId
        || answer.accountOwner !== undefined && answer.accountOwner !== accountOwner) {
        const failure = creditsReadFailure({ code: 'ACCOUNT_CHANGED' }, 'ACCOUNT_CHANGED')
        publish({ failure: failure.code, readFailure: failure })
        return
      }
      publish({ balance: answer.payload, failure: null, readFailure: null })
    } catch (error) {
      if (!current()) return
      const failure = creditsReadFailure(error, 'BALANCE_UNAVAILABLE')
      publish({ failure: failure.code, readFailure: failure })
    } finally {
      if (generation === balanceReadGeneration && snapshot.accountEpoch === epoch) publish({ refreshing: false })
    }
  })()
  const read = { epoch, ...signal === undefined ? {} : { signal }, promise: operation }
  balanceRead = read
  try { await operation } finally { if (balanceRead === read) balanceRead = undefined }
}

/**
 * Re-read the session itself, not only the balance: a sign-in completed outside
 * these pages (the login API, another window) must reach them.
 * @param signal - optional owner cancellation.
 * @param afterSignIn - An explicit completed sign-in may replace the prior login's cooldown.
 * @returns True only when this invocation verified and retained the current session; a cooldown or failed read returns false.
 */
export async function refreshCredits(signal?: AbortSignal, afterSignIn = false): Promise<boolean> {
  if (signal?.aborted === true || !afterSignIn && creditsRetrySeconds(snapshot.readFailure) > 0) return false
  const generation = ++sessionReadGeneration
  if (afterSignIn) {
    balanceReadGeneration += 1
    publish({ session: null, balance: null, loaded: false, failure: null, readFailure: null, refreshing: false })
  }
  const current = (): boolean => signal?.aborted !== true && generation === sessionReadGeneration
  try {
    const answer = await get<SessionInfo | null>('/credits/api/session', signal)
    if (!current()) return false
    if (!answer.ok) {
      const failure = creditsReadFailure(answer, 'ACCOUNT_UNAVAILABLE')
      publish({ loaded: true, failure: failure.code, readFailure: failure })
      return false
    }
    const info = answer.payload
    if (info == null || typeof info.signedIn !== 'boolean' || typeof info.creditsPerYuan !== 'number'
      || !Number.isFinite(info.creditsPerYuan) || info.creditsPerYuan <= 0
      || info.accountOwner !== undefined && (typeof info.accountOwner !== 'string' || !/^[a-f0-9]{64}$/u.test(info.accountOwner))
      || info.signedIn && (typeof info.account?.id !== 'string' || info.account.id === '' || typeof info.account.phone !== 'string')) {
      const failure = creditsReadFailure(undefined, 'ACCOUNT_INVALID_RESPONSE')
      publish({ loaded: true, failure: failure.code, readFailure: failure })
      return false
    }
    publish({ session: info, loaded: true, ...afterSignIn ? { failure: null, readFailure: null } : {} })
    if (info.signedIn) await refreshBalance(signal)
    else publish({ balance: null, failure: null, readFailure: null })
    return current() && snapshot.session === info
  } catch (error) {
    if (!current()) return false
    const failure = creditsReadFailure(error, 'ACCOUNT_UNAVAILABLE')
    publish({ loaded: true, failure: failure.code, readFailure: failure })
    return false
  }
}

/** Sign out: revoke on the platform, clear locally. */
export async function signOutCredits(): Promise<void> {
  sessionReadGeneration += 1
  balanceReadGeneration += 1
  heartbeatRead?.abort()
  publish({ session: { ...UNSIGNED, creditsPerYuan: snapshot.session?.creditsPerYuan ?? 1000 }, balance: null,
    failure: null, readFailure: null, refreshing: false })
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
    if (heartbeatRead !== undefined) return
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
 * Read the current immutable snapshot inside an account-bound user action; render code uses the shared hook.
 * @returns The current account identity, epoch, confirmed balance and read state.
 */
export function readCreditsSnapshot(): CreditsSnapshot { return snapshot }

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
