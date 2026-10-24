/** Durable submission identity for native and nested session-message tools. */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

/**
 * Capture original root calls before nested executions can outlive a later model step.
 * @param ctx - Plugin context owning capture and disposal.
 * @returns Stable submission-id lookup for an admitted execution.
 */
export function captureSubmissionIds(ctx: Context): (exec: ToolExecution) => string {
  const roots = new Map<ToolExecutionToken, number>()
  ctx.effect(() => () => { roots.clear() })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const root = exec.parent === undefined
      ? exec.agent === undefined ? undefined : ctx.sessionController.peerToolCallSeq(exec.agent, exec.rootCallId)
      : roots.get(exec.parent)
    if (root !== undefined) roots.set(exec.token, root)
    try { return await next() } catch (error) { roots.delete(exec.token); throw error }
  }, { prepend: true })
  ctx.on('tools/result', (exec) => { roots.delete(exec.token) })
  return (exec) => {
    const root = roots.get(exec.token)
    if (root === undefined) {
      throw new HarnessError(
        'No current human-authorized submission is available. Messages from another chat cannot authorize an automatic reply.',
        'SESSION_RELAY_NO_SUBMISSION',
      )
    }
    return `${root}:${exec.callId}`
  }
}
