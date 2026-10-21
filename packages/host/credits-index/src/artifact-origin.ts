/** Capture exact generating tool locations and validate optional durable source records. @module */
import type { ArtifactOrigin } from '@deepseek-ai/dsh-artifacts-index'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-session-projection'

/**
 * Capture the calling tool's open Turn without looking at any selected or recent chat.
 * @param exec - Exact tool execution, including its owning Agent and root call.
 * @returns Immutable generating coordinates, or absence outside an open Agent Turn.
 */
export function artifactOriginOf(exec: ToolRunContext): ArtifactOrigin | undefined {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const boundary = agent.ctx.get('sessionProjections')?.stateOf(agent.session, 'turnBoundary')
  if (boundary === undefined || boundary.openTurnStartSeq === null) return undefined
  return Object.freeze({ sessionId: agent.session.id, turn: boundary.lastTurn,
    eventSeq: boundary.openTurnStartSeq, toolCallId: exec.rootCallId })
}

/**
 * Validate optional source coordinates when reading an account task or video-project record.
 * @param value - Durable JSON field; older records omit it.
 * @param sessionId - Optional owning project Session that a stored source must match.
 * @returns Validated copied coordinates, undefined for legacy absence, or null for damaged or mismatched records.
 */
export function parseArtifactOrigin(value: unknown, sessionId?: string): ArtifactOrigin | undefined | null {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || !('sessionId' in value) || typeof value.sessionId !== 'string'
    || value.sessionId === '' || sessionId !== undefined && value.sessionId !== sessionId
    || !('turn' in value) || typeof value.turn !== 'number' || !Number.isSafeInteger(value.turn) || value.turn < 0
    || 'eventSeq' in value && (typeof value.eventSeq !== 'number' || !Number.isSafeInteger(value.eventSeq) || value.eventSeq < 0)
    || 'toolCallId' in value && (typeof value.toolCallId !== 'string' || value.toolCallId === '')) return null
  return { sessionId: value.sessionId as SessionId, turn: value.turn,
    ...'eventSeq' in value ? { eventSeq: value.eventSeq as SessionSeq } : {},
    ...'toolCallId' in value ? { toolCallId: value.toolCallId as ToolCallId } : {} }
}
