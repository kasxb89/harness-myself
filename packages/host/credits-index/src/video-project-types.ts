/** Private video-project records and provider callbacks; no credential is persisted. @module */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ArtifactStorageService } from '@deepseek-ai/dsh-artifacts-index'
import type { VideoEditor } from './video-edit.ts'

/** JSON request data reconstructed exactly when a known task is resumed. */
export type VideoRequestValue = string | number | boolean | null | VideoRequestValue[] | { [key: string]: VideoRequestValue }
/** Provider request saved before its one submission attempt. */
export type VideoProjectRequest = { [key: string]: VideoRequestValue }

/** Product account and login generation owning a new project. */
export interface VideoProjectIdentity {
  /** Stable backend account id. */
  accountId: string
  /** Non-secret login generation; never an access token. */
  sessionFingerprint: string
}

/** Optional media and output parameters shared by every generated shot. */
export interface VideoProjectInput {
  /** Main brief, retained in the private project record. */
  prompt: string
  /** Requested final duration, in whole seconds. */
  totalDurationSeconds: number
  /** Shot prompts, one for each planned clip; omitted repeats the brief with sequence context. */
  shotPrompts?: readonly string[]
  /** Account-visible model id; omission lets the provider select. */
  model?: string
  /** Validated by the selected provider model. */
  resolution?: string
  /** Validated by the selected provider model. */
  ratio?: string
  /** Requested audio state; fixed native audio is accepted without inventing a provider switch. */
  audio?: boolean
  /** Existing uploaded first/last-frame ids or workspace image paths. */
  frameImages?: readonly string[]
  /** Existing uploaded subject/style ids or workspace image paths. */
  referenceImages?: readonly string[]
  /** Existing uploaded video ids or workspace video paths. */
  referenceVideos?: readonly string[]
  /** Existing uploaded audio ids or workspace WAV/MP3 paths. */
  referenceAudios?: readonly string[]
}

/** One live account-bound relay adapter, captured without storing its key. */
export interface VideoProjectProvider {
  /** Account and login generation against which later charges are checked. */
  readonly identity: VideoProjectIdentity
  /**
   * Refuse new paid submissions after sign-out, expiry, or account/login change.
   * @returns Resolves only while the captured product login remains current.
   */
  assertCurrent(): Promise<void>
  /**
   * Resolve the account-visible model and its actual positive integer duration menu.
   * @param model - Explicit user-selected model, or undefined for account selection.
   * @param signal - Cancels model lookup.
   * @param resolution - Explicit output resolution whose duration menu governs planning.
   * @returns Model id and supported whole-second durations.
   */
  model(model: string | undefined, signal: AbortSignal, resolution?: string): Promise<{ id: string; durations: readonly number[] }>
  /**
   * Validate and materialize one request without making a paid submission.
   * @param input - Original project brief, references, and parameters.
   * @param model - Resolved model id.
   * @param prompt - Exact shot prompt.
   * @param durationSeconds - Planned supported clip duration.
   * @param signal - Cancels reference reading and request preparation.
   * @returns Credential-free JSON saved before submission.
   */
  build(input: VideoProjectInput, model: string, prompt: string, durationSeconds: number, signal: AbortSignal): Promise<VideoProjectRequest>
  /**
   * Submit once; a throw means the outcome is unknown and must never trigger automatic resubmission.
   * @param request - Exact prepared request.
   * @param signal - Cancels the submission; cancellation does not establish whether it was accepted.
   * @returns Provider-issued task id.
   */
  submit(request: VideoProjectRequest, signal: AbortSignal): Promise<{ taskId: string }>
  /**
   * Read only a previously persisted task id. No method may submit from here.
   * @param taskId - Previously accepted upstream task.
   * @param request - Original request identifying its provider route.
   * @param signal - Cancels this read.
   * @returns Current terminal or running task state.
   */
  check(taskId: string, request: VideoProjectRequest, signal: AbortSignal): Promise<{ status: 'running' | 'succeeded' | 'failed'; message?: string }>
  /**
   * Save an already completed task inside its private project cache; no paid generation.
   * @param taskId - Completed upstream task id.
   * @param request - Original request identifying its provider route.
   * @param destination - Exclusive owned project clip path.
   * @param signal - Cancels transfer and waits for stream cleanup.
   * @returns Resolves after the complete clip is atomically saved.
   */
  download(taskId: string, request: VideoProjectRequest, destination: string, signal: AbortSignal): Promise<void>
}

/** Deployment choices supplied by the owning credits plugin configuration. */
export interface VideoProjectOptions {
  /** Private durable records, outside public artifact directories. */
  stateDirectory: string
  /** Workspace-relative artifact directory; resolved against each calling agent's cwd. */
  outputDirectory: string
  /** Optional trusted publication service; composition remains confined to the workspace. */
  publication?: Pick<ArtifactStorageService, 'capture' | 'validate' | 'publish'> | undefined
  /** Maximum accepted final seconds. */
  maxTotalSeconds: number
  /** Maximum billable requests per project. */
  maxSegments: number
  /** Interval between reads of a known provider task. */
  pollIntervalMs: number
  /** Deadline for each clip including provider polling and saving. */
  taskTimeoutMs: number
  /**
   * Local editor with preflight, path validation, probe, and composition.
   * @param workspaceRoot - Calling session workspace.
   * @param session - Session whose filesystem and sandbox policy apply.
   * @param ownedMediaRoots - Exact authorized project clip roots, never all account state.
   * @returns An editor confined to these inputs and workspace outputs.
   */
  editor(workspaceRoot: string, session: Session, ownedMediaRoots?: readonly string[]): VideoEditor
  /**
   * Bind a provider to the currently signed-in product account; no fallback deployment key.
   * @param workspaceRoot - Workspace in which reference paths must be readable.
   * @param session - Session whose reference-read policy applies.
   * @returns Captured account adapter without exposing its credentials.
   */
  acquireProvider(workspaceRoot: string, session: Session): Promise<VideoProjectProvider>
}
