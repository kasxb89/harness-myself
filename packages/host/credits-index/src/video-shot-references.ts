/** Resolve one shot's explicitly shared and shot-bound media identically for quotes and generation. @module */
import type { VideoProjectInput } from './video-project-types.ts'

/**
 * Merge only the current shot's references, retaining shared-reference order and removing duplicate inputs.
 * @param input - Typed prepared project input; parsing and material permissions belong to its owning callers.
 * @param index - Zero-based position in the already validated shot sequence.
 * @returns The unchanged input when no shot-specific references exist, otherwise its shot-local media view.
 */
export function videoShotInput(input: VideoProjectInput, index: number): VideoProjectInput {
  if (input.shotReferenceImages === undefined && input.shotReferenceVideos === undefined
    && input.shotReferenceAudios === undefined) return input
  return {
    ...input,
    ...input.shotReferenceImages === undefined ? {} : {
      referenceImages: [...new Set([...input.referenceImages ?? [], ...input.shotReferenceImages[index] ?? []])],
    },
    ...input.shotReferenceVideos === undefined ? {} : {
      referenceVideos: [...new Set([...input.referenceVideos ?? [], ...input.shotReferenceVideos[index] ?? []])],
    },
    ...input.shotReferenceAudios === undefined ? {} : {
      referenceAudios: [...new Set([...input.referenceAudios ?? [], ...input.shotReferenceAudios[index] ?? []])],
    },
  }
}
