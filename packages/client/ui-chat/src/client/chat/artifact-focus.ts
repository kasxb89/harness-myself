/** Parse producer-owned artifact focus and resolve only within its verified generating Turn. */
import type { ChatSnapshot } from '../contract/snapshot.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'

interface ArtifactFocus { turn: number; eventSeq?: number; toolCallId?: string }

/**
 * Parse the Chat-owned focus identity received through Conversation View requests.
 * @param focus - Opaque View focus string.
 * @returns An exact generating location or absence for unrelated and malformed requests.
 */
export function artifactFocus(focus: string): ArtifactFocus | undefined {
  if (!focus.startsWith('artifact:')) return undefined
  let value: unknown
  try { value = JSON.parse(focus.slice('artifact:'.length)) } catch { return undefined }
  if (value === null || typeof value !== 'object' || !('turn' in value) || typeof value.turn !== 'number'
    || !Number.isSafeInteger(value.turn) || value.turn < 0
    || 'eventSeq' in value && (typeof value.eventSeq !== 'number' || !Number.isSafeInteger(value.eventSeq) || value.eventSeq < 0)
    || 'toolCallId' in value && (typeof value.toolCallId !== 'string' || value.toolCallId === '')) return undefined
  return { turn: value.turn,
    ...'eventSeq' in value ? { eventSeq: value.eventSeq as number } : {},
    ...'toolCallId' in value ? { toolCallId: value.toolCallId as string } : {} }
}

/**
 * Resolve an exact generating card; Turn-only sources resolve to that Turn's answer.
 * @param focus - Parsed generating coordinates.
 * @param snapshot - Already loaded Chat snapshot with constrained per-Turn lookup.
 * @returns The generating card, or absence without selecting an unrelated Node.
 */
export function artifactFocusNode(focus: ArtifactFocus, snapshot: Pick<ChatSnapshot, 'locations' | 'nodes'>): ChatNode | undefined {
  const nodes = snapshot.locations.getTurn(focus.turn).flatMap((key) => {
    const node = snapshot.nodes.get(key)
    return node === undefined ? [] : [node as ChatNode]
  })
  if (focus.toolCallId !== undefined) return nodes.find(node => node.kind === 'tool-call' && node.data.root.callId === focus.toolCallId)
  if (focus.eventSeq !== undefined) return nodes.find(node => node.anchorSeq === focus.eventSeq
    || node.kind === 'tool-call' && 'seq' in node.data.root && node.data.root.seq === focus.eventSeq
    || node.kind === 'assistant-step' && node.data.finalNode?.seq === focus.eventSeq)
  return nodes.findLast(node => node.kind === 'assistant-step') ?? nodes.find(node => node.kind === 'user')
}
