/** Stop automatic video retries only for the exact human submission that ran out of balance. @module */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobActionRequired, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { videoGenerationIntentOf } from './video-generation-intent.ts'

/** Safe balance failure retained for repeated calls without another provider submission. */
export interface ChatVideoBalanceFailure {
  status: string
  code: 'INSUFFICIENT_BALANCE'
  message: string
  actionRequired: JobActionRequired
}

interface SubmissionFailure {
  key: string
  revision: number
  value?: ChatVideoBalanceFailure
}

const failures = new WeakMap<Agent, SubmissionFailure>()

/** Operation-local balance handling captured before asynchronous work loses its tool attribution. */
export interface ChatVideoBalanceStop {
  /** Return the original same-submission failure and conclude this call without dispatching generation. */
  stopped(): ChatVideoBalanceFailure | undefined
  /** Preserve a structured tool result, marking only a confirmed balance rejection as requiring user action. */
  result<T extends { code?: string; message?: string }>(value: T): T & { actionRequired?: JobActionRequired }
  /** Preserve the failed producer outcome and suppress automatic model continuation for a balance rejection. */
  outcome(value: JobOutcome): JobOutcome
}

/** Parse the producer's own JSON result only to retain its original recovery coordinates. */
function outcomeResult(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : undefined
  } catch (_nonJsonProducerResult: unknown) {
    // The generic outcome still retains its original result and structured action marker.
    return undefined
  }
}

/**
 * Capture exact logged user ownership, independently of wording, requested quantity, or tool-call ids.
 * @param exec - Calling native or nested PTC execution, before it settles.
 * @param scope - Non-secret product login/account scope captured by the producer.
 * @returns Handling for this submission only; later real messages and other agents remain independent.
 */
export function captureChatVideoBalanceStop(exec: ToolRunContext, scope?: string): ChatVideoBalanceStop {
  const agent = exec.agent
  const intent = videoGenerationIntentOf(exec)
  const key = intent === undefined ? undefined : JSON.stringify([scope, intent.grant.messageId, intent.grant.sourceSeq,
    intent.humanRevision?.messageId, intent.humanRevision?.seq])
  const revision = intent?.humanRevision?.seq ?? intent?.grant.sourceSeq
  if (agent !== undefined && key !== undefined && revision !== undefined) {
    const active = failures.get(agent)
    if (active === undefined || active.revision <= revision && active.key !== key) failures.set(agent, { key, revision })
  }
  const actionRequired: JobActionRequired = { code: 'INSUFFICIENT_BALANCE', ...scope === undefined ? {} : { scope } }
  const retain = (value: Record<string, unknown>): ChatVideoBalanceFailure => {
    const retained: ChatVideoBalanceFailure = { ...value, status: typeof value.status === 'string' ? value.status : 'failed',
      code: 'INSUFFICIENT_BALANCE', message: typeof value.message === 'string' ? value.message : '余额不足，请充值', actionRequired }
    if (agent !== undefined && key !== undefined) {
      const active = failures.get(agent)
      // A late old job keeps its own failure, but cannot arm a newer human request.
      if (active?.key === key) active.value = retained
    }
    return retained
  }
  return {
    stopped() {
      const active = agent === undefined ? undefined : failures.get(agent)
      if (key === undefined || active?.key !== key || active.value === undefined) return undefined
      exec.concludeTurn()
      return active.value
    },
    result(value) {
      if (value.code !== 'INSUFFICIENT_BALANCE') return value
      retain({ ...value })
      exec.concludeTurn()
      return { ...value, actionRequired }
    },
    outcome(value) {
      if (value.status !== 'failed' || value.detail !== 'INSUFFICIENT_BALANCE') return value
      const original = outcomeResult(value.result)
      const retained = retain(original ?? {})
      const jobActionRequired = { ...actionRequired,
        ...intent === undefined ? {} : { requestSeq: SessionSeq(intent.grant.sourceSeq) } }
      return { ...value, actionRequired: jobActionRequired,
        ...original === undefined ? {} : { result: JSON.stringify({ ...original, actionRequired: retained.actionRequired }) } }
    },
  }
}
