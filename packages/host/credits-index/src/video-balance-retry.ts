/** Retain verified unsubmitted funding failures separately from accepted or unknown attempts. @module */
import type { VideoGenerationIntent } from './video-generation-intent.ts'

/** Real logged human input captured by the Host, never supplied by tool arguments. */
export interface VideoSubmissionRevision { readonly messageId: string; readonly seq: number }

/** Safe facts produced only after validating a complete gateway rejection or a local pre-dispatch refusal. */
export interface VideoBalanceRejection {
  readonly code: 'INSUFFICIENT_BALANCE'
  readonly submissionState: 'not_submitted'
  readonly taskId?: string
}

/**
 * Resolve the captured human revision, falling back to the intent's logged grant.
 * @param intent - Logged execution attribution.
 * @returns Its current real human revision, or undefined without an intent.
 */
export function videoSubmissionRevision(intent: VideoGenerationIntent | undefined): VideoSubmissionRevision | undefined {
  return intent === undefined ? undefined : intent.humanRevision ?? { messageId: intent.grant.messageId, seq: intent.grant.sourceSeq }
}

/**
 * Validate persisted human message and sequence coordinates.
 * @param value - Durable JSON field.
 * @returns Validated coordinates, or undefined for invalid data.
 */
export function parseVideoSubmissionRevision(value: unknown): VideoSubmissionRevision | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => key !== 'messageId' && key !== 'seq') || typeof item.messageId !== 'string'
    || item.messageId.length === 0 || item.messageId.length > 256 || /[\u0000-\u001f]/u.test(item.messageId)
    || typeof item.seq !== 'number' || !Number.isSafeInteger(item.seq) || item.seq < 0) return undefined
  return { messageId: item.messageId, seq: item.seq }
}

/**
 * Validate persisted facts for an unsubmitted insufficient-balance rejection.
 * @param value - Durable JSON field.
 * @returns Validated rejection facts, or undefined for invalid data.
 */
export function parseVideoBalanceRejection(value: unknown): VideoBalanceRejection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !['code', 'submissionState', 'taskId'].includes(key))
    || item.code !== 'INSUFFICIENT_BALANCE' || item.submissionState !== 'not_submitted'
    || item.taskId !== undefined && (typeof item.taskId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.taskId) || /^(?:sk-|nap_)/iu.test(item.taskId))) return undefined
  return { code: item.code, submissionState: item.submissionState,
    ...typeof item.taskId === 'string' ? { taskId: item.taskId } : {} }
}

/**
 * Require a greater sequence and a different message identifier than the previous revision.
 * @param current - Captured new human input.
 * @param previous - Original or last consumed human input.
 * @returns Whether this is a later independent reply.
 */
export function isLaterVideoSubmissionRevision(current: VideoSubmissionRevision, previous: VideoSubmissionRevision | undefined): boolean {
  return previous !== undefined && current.seq > previous.seq && current.messageId !== previous.messageId
}
