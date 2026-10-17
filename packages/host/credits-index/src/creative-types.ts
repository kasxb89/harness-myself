/** Browser-safe, credential-free projections of retained chat creation projects. @module */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Owner-issued opaque project identifier. */
export type CreativeProjectId = Branded<'CreativeProjectId'>
/** Owner-issued opaque saved-output identifier. */
export type CreativeOutputId = Branded<'CreativeOutputId'>

/** Requested output category. */
export type CreativeKind = 'image' | 'video'

/** Committed operation state; interrupted never implies an active background job. */
export type CreativeStatus = 'planned' | 'running' | 'saving' | 'editing' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'

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

/** Persisted planning data joined to actual generation and local editing facts. */
export interface CreativeProjectView {
  readonly id: CreativeProjectId
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
  readonly errorCode?: string
}

/** Successful local creation-project listing payload. */
export interface CreativeProjectsPayload {
  readonly accountId: string
  readonly projects: readonly CreativeProjectView[]
}
