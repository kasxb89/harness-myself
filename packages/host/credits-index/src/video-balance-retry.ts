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

/** @param intent - Logged execution attribution. @returns Its current real human revision, when available. */
export function videoSubmissionRevision(intent: VideoGenerationIntent | undefined): VideoSubmissionRevision | undefined {
  return intent === undefined ? undefined : intent.humanRevision ?? { messageId: intent.grant.messageId, seq: intent.grant.sourceSeq }
}

/** @param value - Durable JSON field. @returns Validated real-human coordinates, or absence for invalid data. */
export function parseVideoSubmissionRevision(value: unknown): VideoSubmissionRevision | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => key !== 'messageId' && key !== 'seq') || typeof item.messageId !== 'string'
    || item.messageId.length === 0 || item.messageId.length > 256 || /[\u0000-\u001f]/u.test(item.messageId)
    || typeof item.seq !== 'number' || !Number.isSafeInteger(item.seq) || item.seq < 0) return undefined
  return { messageId: item.messageId, seq: item.seq }
}

/** @param value - Durable JSON field. @returns Validated safe rejection facts, or absence for invalid data. */
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
 * @param current - Captured new human input.
 * @param previous - Original or last consumed human input.
 * @returns Whether this is a later independent reply.
 */
export function isLaterVideoSubmissionRevision(current: VideoSubmissionRevision, previous: VideoSubmissionRevision | undefined): boolean {
  return previous !== undefined && current.seq > previous.seq && current.messageId !== previous.messageId
}
