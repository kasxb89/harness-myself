/**
 * The one hand-off between the sidebar's top-up entry and the Credits page.
 *
 * The page owns the amount it will charge; the sidebar only says which amount a
 * click asked for, and the page applies it when it mounts or updates. Keeping
 * the request outside React state means a click that opens the panel still
 * reaches a page that mounts afterwards.
 */
import { useSyncExternalStore } from 'react'

/** One top-up the sidebar asked for; a null amount means the free-form field. */
export interface RechargeRequest {
  /** Amount in yuan, or null for "let me type it". */
  readonly amount: number | null
  /** Distinguishes two requests for the same amount. */
  readonly nonce: number
}

let current: RechargeRequest | null = null
const listeners = new Set<() => void>()

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const snapshot = (): RechargeRequest | null => current

/**
 * Ask the Credits page for one top-up.
 * @param amount - amount in yuan, or null for the free-form field.
 */
export function requestRecharge(amount: number | null): void {
  current = { amount, nonce: (current?.nonce ?? 0) + 1 }
  for (const listener of listeners) listener()
}

/** Drop the applied request so a later visit does not replay it. */
export function clearRechargeRequest(): void {
  if (current === null) return
  current = null
  for (const listener of listeners) listener()
}

/** @returns the pending top-up request, if the sidebar asked for one. */
export function useRechargeRequest(): RechargeRequest | null {
  return useSyncExternalStore(subscribe, snapshot)
}
