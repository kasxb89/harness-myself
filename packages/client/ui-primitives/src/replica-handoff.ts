import { appPath } from './app-path.ts'
import type { ReplicaDraftRequest, ReplicaDraftOutcome } from './replica-prompt.ts'

/** Plain navigation callbacks supplied by the owning creation plugin. */
export interface ReplicaDraftNavigation {
  /**
   * Hold a target Session through asynchronous account confirmation without revealing it.
   * @param confirm - Awaited final account check and synchronous acceptance/reveal.
   * @returns Completion, including a navigation superseded before confirmation.
   */
  withTarget(confirm: () => Promise<void>): Promise<void>
  /**
   * Read the current window account epoch and navigation lifetime synchronously.
   * @param owner - Host login scope observed by the immediately preceding session read.
   * @returns Whether that login and the captured window epoch still own this handoff.
   */
  isCurrent(owner: string | null): boolean
  /**
   * Accept files while the selected Session generation remains retained.
   * @param prompt - Unsent draft text.
   * @param files - Ordered browser files.
   * @returns Whether the empty composer accepted the complete draft.
   */
  accept(prompt: string, files: readonly File[]): boolean
  /** Reveal the retained target synchronously after successful acceptance. */
  reveal(): void
}
interface ReplicaAccount { readonly id: string; readonly owner: string | null }
async function currentAccount(signal: AbortSignal): Promise<ReplicaAccount | null> {
  const response = await fetch(appPath('/credits/api/session'), { headers: { accept: 'application/json' }, signal })
  const data: unknown = await response.json()
  if (!response.ok || data === null || typeof data !== 'object' || !('ok' in data) || data.ok !== true || !('payload' in data)
    || data.payload === null || typeof data.payload !== 'object' || !('signedIn' in data.payload)
    || data.payload.signedIn !== true || !('account' in data.payload) || data.payload.account === null
    || typeof data.payload.account !== 'object' || !('id' in data.payload.account)
    || (typeof data.payload.account.id !== 'string' && typeof data.payload.account.id !== 'number')) return null
  const owner = 'accountOwner' in data.payload ? data.payload.accountOwner : null
  if (owner !== null && typeof owner !== 'string') return null
  return { id: String(data.payload.account.id), owner }
}
/**
 * Recheck the Host login before connecting and immediately before atomic draft acceptance.
 * @param request - Expected account, ordered files, prompt and navigation cancellation.
 * @param navigation - Caller-owned target lifetime, synchronous account epoch and draft acceptance.
 * @returns Draft acceptance only; never submits a chat message or generation request.
 */
export async function prepareReplicaDraft(request: ReplicaDraftRequest, navigation: ReplicaDraftNavigation): Promise<ReplicaDraftOutcome> {
  request.signal.throwIfAborted()
  const account = await currentAccount(request.signal)
  request.signal.throwIfAborted()
  if (account === null || account.id !== request.accountKey || !navigation.isCurrent(account.owner)) return 'unavailable'
  const refused = new Error('Replica chat draft was preserved'), changed = new Error('Replica account changed')
  const result: { outcome: ReplicaDraftOutcome } = { outcome: 'unavailable' }
  try {
    await navigation.withTarget(async () => {
      const confirmed = await currentAccount(request.signal)
      request.signal.throwIfAborted()
      if (confirmed === null || confirmed.id !== account.id || confirmed.owner !== account.owner
        || !navigation.isCurrent(confirmed.owner)) throw changed
      if (!navigation.accept(request.prompt, request.files)) throw refused
      navigation.reveal()
      result.outcome = 'ready'
    })
  } catch (error) {
    if (error === refused) return 'preserved'
    if (error === changed) return 'unavailable'
    throw error
  }
  return result.outcome
}
