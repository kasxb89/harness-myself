/** Trusted Host-only artifact output contracts; never a model tool. @module */
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** Producer-declared purpose of an exact saved video; absence never implies a shot. */
export type ArtifactVideoRole = 'final' | 'shot'

/** Producer-declared purpose of an exact saved image; absence never implies a storyboard. */
export type ArtifactImageRole = 'final' | 'storyboard'

/** Exact generating conversation location, supplied by the trusted producer. */
export interface ArtifactOrigin {
  readonly sessionId: SessionId
  readonly turn: number
  /** Logged generating event when the producer already has its stable sequence. */
  readonly eventSeq?: SessionSeq
  readonly toolCallId?: ToolCallId
}

/** A validated output directory captured before an operation starts. */
export interface ArtifactDestination {
  readonly directory: string
}

/** One exclusively created output file. */
export interface ArtifactWriteResult {
  readonly path: string
}

/** Byte output supplied by a trusted Host producer. */
export interface ArtifactWriteRequest {
  readonly destination: ArtifactDestination
  readonly filename: string
  readonly bytes: Uint8Array
  readonly signal: AbortSignal
  readonly origin?: ArtifactOrigin
  readonly videoRole?: ArtifactVideoRole
  readonly imageRole?: ArtifactImageRole
}

/** Existing finished output copied by a trusted Host producer; source remains intact. */
export interface ArtifactPublishRequest {
  readonly destination: ArtifactDestination
  readonly sourcePath: string
  readonly filename: string
  readonly signal: AbortSignal
  readonly origin?: ArtifactOrigin
  readonly videoRole?: ArtifactVideoRole
  readonly imageRole?: ArtifactImageRole
}

/** Optional shared output capability consumed by account media generators. */
export interface ArtifactStorageService {
  /**
   * Validate writability and retain this exact directory for an in-flight operation.
   * @param signal - Caller lifetime while checking local output availability.
   * @returns The currently selected canonical output directory.
   */
  capture(signal: AbortSignal): Promise<ArtifactDestination>
  /**
   * Check a retained destination again before resuming any further paid work.
   * @param destination - Original approved directory from the durable operation.
   * @param signal - Caller lifetime while checking local output availability.
   * @returns Resolves only when the original directory remains approved and writable.
   */
  validate(destination: ArtifactDestination, signal: AbortSignal): Promise<void>
  /**
   * Create an exclusive output; never replace an existing user file.
   * @param request - Captured destination, portable filename, bytes and caller lifetime.
   * @returns The complete exclusively published output path.
   */
  write(request: ArtifactWriteRequest): Promise<ArtifactWriteResult>
  /**
   * Copy a finished file without replacing a destination or removing its source.
   * @param request - Captured destination, finished source, portable filename and caller lifetime.
   * @returns The complete exclusively published copy path.
   */
  publish(request: ArtifactPublishRequest): Promise<ArtifactWriteResult>
}

/** Current output preference and all retained browsing roots. */
export interface ArtifactStorageInfo {
  readonly directory: string
  readonly defaultDirectory: string
  readonly revision: number
  readonly roots: readonly string[]
}
