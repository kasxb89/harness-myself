/** Browser-safe, credential-free projections of retained chat creation projects. @module */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ArtifactOrigin } from '@deepseek-ai/dsh-artifacts-index/types'

/** Owner-issued opaque project identifier. */
export type CreativeProjectId = Branded<'CreativeProjectId'>
/** Owner-issued opaque saved-output identifier. */
export type CreativeOutputId = Branded<'CreativeOutputId'>

/** Requested output category. */
export type CreativeKind = 'image' | 'video'

/** Trusted generation entry recorded by the Host; absent on older invocations. */
export type CreativeSource = 'chat' | 'ai-creation'

/** Committed operation state; interrupted never implies an active background job. */
export type CreativeStatus = 'planned' | 'running' | 'saving' | 'editing' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'

/** Credential-free submission identity retained for querying the original media task. */
export interface CreativeSubmissionReceipt {
  readonly route: string
  readonly model: string
  readonly phase: 'submitting' | 'accepted' | 'completed'
  readonly taskId?: string
  readonly requestId?: string
  readonly backendFingerprint: string
  readonly origin?: ArtifactOrigin
}

/** Original image task identity; never a new-generation instruction. */
export type CreativeImageReceipt = CreativeSubmissionReceipt
/** Original video task identity; never a new-generation instruction. */
export type CreativeVideoReceipt = CreativeSubmissionReceipt

/** A retained character description supplied through the logged planning tool. */
export interface CreativeCharacter {
  readonly id: string
  readonly name: string
  readonly appearance: string
  readonly clothing: string
  readonly personality: string
  readonly voice: string
  readonly referenceAssetIds: readonly string[]
}

/** One explicitly identified input, never inferred from unrelated workspace files. */
export interface CreativeAsset {
  readonly id: string
  readonly name: string
  readonly kind: 'image' | 'video' | 'audio' | 'document' | 'other'
  readonly role: string
  readonly description: string
  readonly sourcePathOrAssetId: string
}

/** Source material descriptions joined to their explicitly generated versions. */
export interface CreativeAssetView extends CreativeAsset {
  /** Owner-checked preview of a retained uploaded image reference. */
  readonly referenceUrl?: string
  readonly status?: CreativeStatus
  readonly outputs?: readonly CreativeOutput[]
}

/** A frame extracted from an actual saved clip. */
export interface CreativeFrame {
  readonly url: string
  readonly timeSeconds: number
}

/** A real saved file exposed through an owner-checked media URL. */
export interface CreativeOutput {
  readonly id: CreativeOutputId
  readonly kind: 'image' | 'video' | 'audio'
  readonly name: string
  readonly url: string
  readonly posterUrl?: string
  readonly frames?: readonly CreativeFrame[]
  /** Preview extraction failed; the original generated file is still usable. */
  readonly previewUnavailable?: boolean
}

/** One planned shot and its independently saved outputs. */
export interface CreativeShotView {
  readonly id: string
  readonly order: number
  readonly title: string
  readonly durationSeconds?: number
  /** Duration submitted for the latest generated clip, separate from editable timing. */
  readonly actualDurationSeconds?: number
  readonly camera: string
  readonly scene: string
  readonly action: string
  readonly prompt: string
  /** Exact dialogue instructions; not a claim that speech has been verified. */
  readonly dialogue: string
  /** Requested subtitle wording/timing; not a verification result. */
  readonly subtitles: string
  readonly characterIds: readonly string[]
  readonly assetIds: readonly string[]
  readonly status: CreativeStatus
  readonly outputs: readonly CreativeOutput[]
}

/** Editable shot fields, without generated execution state. */
export type CreativeShotPlan = Omit<CreativeShotView, 'status' | 'outputs' | 'actualDurationSeconds'>

/** Explicit plan edit supplied by the authenticated creation interface. */
export type CreativePlanChange =
  | { readonly kind: 'shot'; readonly id: string; readonly patch: Partial<Omit<CreativeShotPlan, 'id' | 'order'>> }
  | { readonly kind: 'reorder'; readonly shotIds: readonly string[] }
  | { readonly kind: 'character'
    readonly value: CreativeCharacter
    /** Newly uploaded image materials saved atomically with their character reference bindings. */
    readonly assets?: readonly CreativeAsset[] }
  | { readonly kind: 'asset'; readonly value: CreativeAsset }
  | { readonly kind: 'remove-character' | 'remove-asset' | 'remove-shot'; readonly id: string }
  | { readonly kind: 'add-shot'; readonly value: CreativeShotPlan }

/** One retained invocation, without provider requests, credentials or local paths. */
export interface CreativeTaskView {
  readonly id: string
  /** Initiating entry, independent of the shared account, chat and editable plan. */
  readonly source?: CreativeSource
  readonly status: CreativeStatus
  readonly shotIds: readonly string[]
  readonly assetId?: string
  readonly model?: string
  readonly videoProjectId?: string
  readonly outputs: readonly CreativeOutput[]
  readonly errorCode?: string
  readonly imageReceipt?: CreativeImageReceipt
  readonly videoReceipt?: CreativeVideoReceipt
  /** Querying the original task is available without another paid submission. */
  readonly canQuery?: boolean
  readonly completedShots: number
  readonly totalShots: number
}

/** Persisted planning data joined to actual generation and local editing facts. */
export interface CreativeProjectView {
  readonly id: CreativeProjectId
  readonly sessionId: string
  /** Hash of normalized planning fields; execution progress never changes it. */
  readonly planRevision: string
  readonly kind: CreativeKind
  readonly title: string
  readonly brief: string
  readonly style: string
  readonly status: CreativeStatus
  readonly updatedAt: string
  readonly characters: readonly CreativeCharacter[]
  readonly assets: readonly CreativeAssetView[]
  readonly shots: readonly CreativeShotView[]
  readonly outputs: readonly CreativeOutput[]
  readonly tasks: readonly CreativeTaskView[]
  readonly completedShots: number
  readonly totalShots: number
  readonly errorCode?: string
}

/** Successful local creation-project listing payload. */
export interface CreativeProjectsPayload {
  readonly accountId: string
  readonly projects: readonly CreativeProjectView[]
}
