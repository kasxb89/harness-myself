/** Resolve and verify an explicit generation location in the opened Session log. */
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ArtifactOrigin } from './api.ts'

/**
 * Prefer the generating Turn's start so its tool card is present even for a late result event.
 * @param origin - Exact producer-owned location.
 * @param outline - Host whole-log Turn outline, validated at this wire read.
 * @returns A safe history coordinate, or absence requiring the beginning of the log.
 */
export function generationSequence(origin: ArtifactOrigin, outline: unknown): number | undefined {
  if (Array.isArray(outline)) {
    const entries: readonly unknown[] = outline
    for (const entry of entries) {
      if (entry !== null && typeof entry === 'object' && 'turn' in entry && entry.turn === origin.turn
        && 'seq' in entry && typeof entry.seq === 'number' && Number.isSafeInteger(entry.seq) && entry.seq >= 0) return entry.seq
    }
  }
  return origin.eventSeq
}

/**
 * Verify the actual generating Turn and optional root tool identity before changing the user's selection.
 * @param origin - Explicit source supplied by the producer, never derived from filenames.
 * @param entries - Opened history loaded through the generating Turn.
 * @returns Whether the exact recorded source still exists.
 */
export function hasGeneratingEvent(origin: ArtifactOrigin, entries: readonly SessionEventLikeEntry[]): boolean {
  return entries.some(({ event }) => {
    if (origin.toolCallId !== undefined) return event.type === 'tool/call'
      && event.data.callId === origin.toolCallId && event.data.turn === origin.turn
    if (origin.eventSeq !== undefined) return event.seq === origin.eventSeq
      && 'turn' in event.data && event.data.turn === origin.turn
    return event.type === 'turn/start' && event.data.turn === origin.turn
  })
}
