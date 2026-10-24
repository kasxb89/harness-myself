/** Reconstruct peer-message authority and accepted identities from existing Session events. */

import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

const humanSchema = z.object({ id: z.string(), seq: z.number().int().nonnegative() })
const rootSchema = z.object({ callId: z.string(), humanId: z.string(), turn: z.number().int().nonnegative() })
const stateSchema = z.object({
  inherited: z.number().int().nonnegative(), turn: z.number().int().nonnegative(), open: z.boolean(),
  human: humanSchema.optional(), roots: z.record(z.string(), rootSchema), receipts: z.record(z.string(), z.string()),
})
type PeerSessionState = z.infer<typeof stateSchema>

/**
 * Hash complete accepted message content for exact-replay comparisons.
 * @param content - ordered complete message blocks.
 * @returns deterministic SHA256 without retaining message text in the authority projection.
 */
export function peerMessageDigest(content: readonly ContentBlock[]): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

/** Host-only authority and acceptance state; no new durable Session vocabulary. */
export const peerSessionProjection = {
  key: 'peerSessionRelay', stateVersion: 1, stateSchema,
  init: (_header, inherited) => ({ inherited, turn: 0, open: false, roots: {}, receipts: {} }),
  apply(state, event) {
    if (event.seq < state.inherited) return state
    if (event.type === 'turn/start') return { ...state, turn: event.data.turn, open: true, human: undefined, roots: {} }
    if (event.type === 'turn/end') return { ...state, open: false, human: undefined }
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'user') return { ...state, human: { id: event.data.id, seq: event.seq } }
      if (source.kind === 'agent-message') return { ...state, human: undefined,
        receipts: { ...state.receipts, [event.data.id]: peerMessageDigest(event.data.content) } }
    }
    if (event.type === 'tool/call' && state.open && state.human !== undefined && event.data.turn === state.turn) {
      return { ...state, roots: { ...state.roots, [event.seq]: {
        callId: event.data.callId, humanId: state.human.id, turn: state.turn,
      } } }
    }
    if (event.type === 'agent/inbox/spliced') {
      let receipts = state.receipts
      for (const message of event.data.inserted) {
        if (message.source.kind !== 'agent-message') continue
        receipts = { ...receipts, [message.id]: peerMessageDigest(message.content) }
      }
      return receipts === state.receipts ? state : { ...state, receipts }
    }
    return state
  },
} satisfies ProjectionDefinition<'peerSessionRelay', PeerSessionState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host-only live human authority and durable inbox acceptance fingerprints. */
    peerSessionRelay: PeerSessionState
  }
}
