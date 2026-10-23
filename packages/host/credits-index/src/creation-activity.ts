/** Process-local creation observations; no content or provider credentials are reported. @module */

import type { CreativeOperation } from './creative-store.ts'

/** Local preparation and provider states remain distinct from an unknown submission. */
export type CreationActivityStage = 'preparing' | 'submitting' | 'accepted' | 'queued' | 'generating' | 'saving' | 'editing' | 'unknown'

/** Ending local observation does not establish the outcome of an accepted upstream task. */
export type CreationActivityOutcome = 'completed' | 'failed' | 'stopped' | 'unknown'

/** Structured execution phases, independent of localized progress copy. */
export type CreationTaskActivity =
  | { readonly type: 'stage'; readonly stage: CreationActivityStage }
  | { readonly type: 'end'; readonly stage: CreationActivityStage; readonly outcome: CreationActivityOutcome }

/** A synchronous observer; failures are contained by the execution owner. */
export type CreationTaskObserver = (event: CreationTaskActivity) => void

/** Exact live invocation; persisted running records do not create this notification. */
export interface CreationOperationActivity {
  readonly operation: CreativeOperation
  readonly kind: 'image' | 'video'
  readonly videoProjectId?: string
  readonly active: boolean
}

/** One project phase or clip phase, attributed to its original owning chat. */
export type VideoProjectActivity = CreationTaskActivity & {
  readonly projectId: string
  readonly ownerSessionId: string
  readonly accountId: string
  readonly sessionFingerprint: string
  /** Absent for local project preparation/editing; present for one billable clip. */
  readonly shotId?: string
  /** Durable identity of this clip's original submission attempt, retained across explicit resume. */
  readonly attemptId?: string
}

/**
 * Deliver an optional synchronous observation without affecting the creation result.
 * @param observer - Process-local statistics consumer.
 * @param event - Content-free lifecycle notification.
 */
export function notifyCreationActivity<T>(observer: ((event: T) => unknown) | undefined, event: T): void {
  if (observer === undefined) return
  try {
    void Promise.resolve(observer(event)).catch((_observerFailure: unknown) => {
      console.warn('Creation activity observer failed')
    })
  } catch (_observerFailure: unknown) { console.warn('Creation activity observer failed') }
}

/**
 * Own one observer's final phase and single local settlement.
 * @param observer - Optional process-local lifecycle consumer.
 * @returns Synchronous phase and idempotent end writers.
 */
export function creationTaskActivity(observer: CreationTaskObserver | undefined): {
  stage(stage: CreationActivityStage): void
  end(outcome: CreationActivityOutcome): void
} {
  let last: CreationActivityStage = 'preparing'
  let started = false
  let ended = false
  return {
    stage(stage) {
      if (ended) return
      if (started && last === stage) return
      started = true
      last = stage
      notifyCreationActivity(observer, { type: 'stage', stage })
    },
    end(outcome) {
      if (ended) return
      ended = true
      notifyCreationActivity(observer, { type: 'end', stage: last, outcome })
    },
  }
}
