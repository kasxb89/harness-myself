import type { ReplicaLabels } from './replica-locales.ts'

/** Ordered browser files and constraints prepared for a normal unsent chat draft. */
export interface ReplicaDraftRequest {
  readonly prompt: string
  readonly files: readonly File[]
  readonly accountKey: string
  readonly signal: AbortSignal
}
/** A draft handoff reports acceptance only, never a sent message or generation. */
export type ReplicaDraftOutcome = 'ready' | 'preserved' | 'unavailable'

/**
 * Create an analysis-only request whose attachment ordinals keep media roles unambiguous.
 * @param labels - Complete locale-owned request text.
 * @param input - Ordered source/subject files and user constraints.
 * @returns Plain text for the existing Conversation composer.
 */
export function replicaPrompt(labels: ReplicaLabels, input: {
  readonly kind: 'image' | 'video'
  readonly source: File
  readonly subjects: readonly File[]
  readonly keep: string
  readonly change: string
  readonly specifications: string
  readonly count: string
}): string {
  const files = [input.source, ...input.subjects]
  return [labels.promptIntro, input.kind === 'image' ? labels.promptImage : labels.promptVideo,
    labels.promptAttachments,
    ...files.map((file, index) => `${String(index + 1)}. [${file.type || (index === 0 ? input.kind : 'image')}] ${index === 0 ? labels.promptSource : labels.promptSubject} | ${JSON.stringify(file.name)}`),
    `${labels.promptKeep}: ${input.keep.trim() || labels.promptDefault}`,
    `${labels.promptChange}: ${input.change.trim() || labels.promptDefault}`,
    `${labels.promptSpecs}: ${input.specifications.trim() || labels.promptDefault}`,
    `${labels.promptCount}: ${input.count}`, labels.promptRules].join('\n\n')
}
