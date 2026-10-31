/** Durable, account-bound multi-clip generation and local composition. @module */

import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import * as nativePaths from 'node:path'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ArtifactOrigin, ArtifactVideoRole } from '@deepseek-ai/dsh-artifacts-index'
import { parseArtifactOrigin } from './artifact-origin.ts'
import { VideoEditError, type VideoEditor } from './video-edit.ts'
import { VideoRelayError } from './video-project-provider.ts'
import { VideoSubmissionRejection } from './video-submission-result.ts'
import { DEFAULT_VIDEO_PROJECT_PARALLELISM } from './video-concurrency.ts'
import { videoShotInput } from './video-shot-references.ts'
import { creationTaskActivity, notifyCreationActivity } from './creation-activity.ts'
import { mediaFilename, MAX_MEDIA_FILENAME_BYTES, type MediaFilenameOptions } from './media-filename.ts'
import type { CreationActivityOutcome } from './creation-activity.ts'
import type { VideoProjectIdentity, VideoProjectInput, VideoProjectOptions, VideoProjectProvider, VideoProjectRequest, VideoRequestValue } from './video-project-types.ts'

/** Complete private-record parser limit, including prompt and per-clip metadata. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const MAX_PROMPT_LENGTH = 7000

const runningProjects = new Set<string>()
const recoveringProjects = new Map<string, Promise<VideoProjectRead>>()
const manifestWrites = new WeakMap<VideoProjectManifest, Promise<void>>()

/** An opaque project identifier, validated before selecting its private record. */
export type VideoProjectId = Branded<'VideoProjectId'>

/** One retained clip submission identity, independent of each local observation run. */
export type VideoProjectAttemptId = Branded<'VideoProjectAttemptId'>

/** Actionable failures whose messages are safe for the model and user. */
export class VideoProjectError extends Error {
  /** Stable failure discriminator. */
  readonly code: string
  /**
   * @param code - Stable failure discriminator.
   * @param message - Safe operation summary and recovery action.
   * @param options - Trusted cause retained outside model output.
   */
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VideoProjectError'
    this.code = code
  }
}

/**
 * Produce safe Chinese operation errors, keeping process output and unknown exceptions private.
 * @param error - Declared video error or untrusted infrastructure exception.
 * @returns Stable failure code and an actionable summary without raw exception data.
 */
export function videoProjectFailure(error: unknown): { code: string; message: string } {
  if (error instanceof VideoProjectError || error instanceof VideoRelayError || error instanceof VideoSubmissionRejection) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof VideoEditError) {
    const messages = {
      VIDEO_EDIT_RUNTIME_UNAVAILABLE: '本地视频工具尚未准备好，请重新启动客户端完成工具准备后重试；已生成的片段保留。',
      VIDEO_EDIT_SANDBOX_DENIED: '工作区未允许本地视频处理，请检查文件夹写入权限后重试；原始片段保留。',
      VIDEO_EDIT_INVALID_INPUT: '视频片段或裁剪设置无效，请检查文件路径、裁剪范围及输出位置；原始片段保留。',
      VIDEO_EDIT_FAILED: '本地视频剪辑失败，原始片段保留。可重试剪辑，无需重新付费生成。',
      VIDEO_EDIT_CANCELLED: '本地视频剪辑已停止，原始片段保留。',
      VIDEO_EDIT_OUTPUT_INVALID: '剪辑结果未通过校验，未作为成片交付；原始片段保留，可重新剪辑。',
    } satisfies Record<VideoEditError['code'], string>
    const diagnostic = error.diagnostic
    const reference = diagnostic === undefined ? '' : ` 本地诊断：${[
      diagnostic.tool, diagnostic.stage,
      ...diagnostic.exitCode === undefined ? [] : [`exit=${String(diagnostic.exitCode)}`],
      ...diagnostic.signal === undefined || diagnostic.signal === null ? [] : [diagnostic.signal],
      ...diagnostic.interruption === undefined ? [] : [diagnostic.interruption],
    ].join('/')}。`
    const message = diagnostic?.interruption === 'deadline'
      ? '本地视频处理超时已停止，原始片段保留。可重试剪辑，无需重新付费生成。'
      : messages[error.code]
    return { code: error.code, message: message + reference }
  }
  return { code: 'VIDEO_OPERATION_UNAVAILABLE', message: '视频操作未完成，请查看项目状态并检查工作区权限。已保存片段保留，不要重复提交结果未知的生成任务。' }
}

/** One saved clip and the exact request sent, or intended to be sent, upstream. */
export interface VideoProjectSegment {
  /** One-based shot order. */
  index: number
  /** Requested upstream seconds; the final edit may trim surplus. */
  durationSeconds: number
  /** Exact model-visible shot brief. */
  prompt: string
  /** Validated request, without credentials. */
  request: VideoProjectRequest
  /** Original submission identity; absent only in records written before activity reporting. */
  attemptId?: VideoProjectAttemptId
  /** submitting without a task id is an unknown outcome and cannot be retried. */
  status: 'pending' | 'submitting' | 'running' | 'saved' | 'failed' | 'unknown'
  /** Present only after the provider identifies its accepted task. */
  taskId?: string
  /** Private local original retained after a successful probe. */
  path?: string
  /** Artifact-library copy; the private original remains available for resume and composition. */
  publishedPath?: string
}

/** Versioned private project state, never used as an in-memory jobs substitute. */
export interface VideoProjectManifest {
  /** Private-record parser version. */
  version: 1
  /** Immutable project identifier. */
  id: VideoProjectId
  /** Agent session owning this record. */
  ownerSessionId: string
  /** Absolute workspace owning source files and sandboxed composition. */
  workspaceRoot: string
  /** Signed-in product identity; contains no token or relay key. */
  identity: VideoProjectIdentity
  /** Exact original tool input. */
  input: VideoProjectInput
  /** Resolved provider model. */
  model: string
  /** Operation state persisted at each externally meaningful step. */
  status: 'prepared' | 'running' | 'editing' | 'completed' | 'failed' | 'cancelled'
  /** Plan and reusable generation results. */
  segments: VideoProjectSegment[]
  /** Directory under the original workspace, chosen before paid work. */
  outputDirectory: string
  /** Approved output captured before generation; absent in older workspace-only projects. */
  publicationDirectory?: string
  /** Original generating tool location; absent in legacy records and retained unchanged during resume. */
  origin?: ArtifactOrigin
  /** Verified workspace edit retained when publishing to the captured directory fails. */
  composedPath?: string
  /** Duration of the retained workspace edit, checked again before publishing on recovery. */
  composedDurationSeconds?: number
  /** Updated after every atomic state replacement. */
  updatedAt: string
  /** Set only after composition and output probing succeed. */
  finalPath?: string
  /** Validated resulting duration, not a requested duration reported as success. */
  finalDurationSeconds?: number
  /** Stable failure for a stopped operation. */
  failureCode?: string
}

/** Authorized retained state plus a retryable local publication warning, never persisted as generation failure. */
export interface VideoProjectRead extends VideoProjectManifest {
  /** Existing outputs remain available when their artifact-library copy cannot currently be saved. */
  readonly publicationErrorCode?: 'ARTIFACT_PUBLISH_FAILED'
}

/** Local copy or disk failures leave authorized historical projections readable. */
function retryablePublicationFailure(error: unknown): boolean {
  if (error instanceof VideoProjectError) return error.code === 'ARTIFACT_PUBLISH_FAILED' || error.code === 'ARTIFACT_STORAGE_UNAVAILABLE'
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    && ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ENOTDIR', 'EROFS', 'EIO', 'EBUSY', 'EMFILE', 'ENFILE'].includes(error.code)
}

/**
 * Plan the smallest number of accepted upstream durations, then minimize excess seconds.
 * @param totalSeconds - positive whole final seconds.
 * @param durations - actual provider duration menu.
 * @param maxSegments - configured paid-request cap.
 * @returns longest-first planned clip durations; final composition trims any surplus.
 */
export function planVideoDurations(totalSeconds: number, durations: readonly number[], maxSegments: number): number[] {
  if (!Number.isSafeInteger(totalSeconds) || totalSeconds < 1) throw new VideoProjectError('INVALID_DURATION', '视频总时长必须是正整数秒。')
  const menu = [...new Set(durations)].sort((a, b) => b - a)
  if (menu.length === 0 || menu.some(value => !Number.isSafeInteger(value) || value < 1 || value > 86_400)) {
    throw new VideoProjectError('DURATION_MENU_UNAVAILABLE', '当前模型没有有效的时长选项，请选择其他视频模型。')
  }
  const largest = menu[0]
  if (largest === undefined) throw new VideoProjectError('DURATION_MENU_UNAVAILABLE', '当前模型没有时长选项。')
  const count = Math.ceil(totalSeconds / largest)
  if (count > maxSegments) throw new VideoProjectError('TOO_MANY_SEGMENTS', '所需视频片段超过当前项目上限，请缩短时长或更换模型。')
  let sums = new Map<number, number[]>([[0, []]])
  for (let index = 0; index < count; index += 1) {
    const next = new Map<number, number[]>()
    for (const [sum, values] of sums) {
      for (const duration of menu) {
        const target = sum + duration
        if (target > totalSeconds + largest || next.has(target)) continue
        next.set(target, [...values, duration])
      }
    }
    sums = next
  }
  const accepted = [...sums.keys()].filter(sum => sum >= totalSeconds).sort((a, b) => a - b)[0]
  if (accepted === undefined) throw new VideoProjectError('DURATION_PLAN_FAILED', '无法按当前模型的时长选项完成该视频。')
  const planned = sums.get(accepted)
  if (planned === undefined) throw new Error('video duration plan lost its accepted sum')
  return planned.sort((a, b) => b - a)
}

/** Validate an untrusted tool-selected project id before filesystem access. */
function projectId(value: string): VideoProjectId {
  if (!/^vp_[a-f0-9-]{36}$/u.test(value)) throw new VideoProjectError('INVALID_PROJECT_ID', '视频项目编号无效。')
  return value as VideoProjectId
}

/**
 * Resolve a workspace-relative video destination without crossing its parent on either platform.
 * @param workspaceRoot - Absolute calling workspace.
 * @param outputDirectory - Configured relative output subtree.
 * @param paths - Filesystem path rules; native by default, explicit for portable configuration validation.
 * @returns Absolute contained destination; the editor also checks canonical filesystem containment.
 */
export function resolveVideoOutputDirectory(
  workspaceRoot: string, outputDirectory: string,
  paths: Pick<typeof nativePaths, 'isAbsolute' | 'resolve' | 'relative' | 'sep'> = nativePaths,
): string {
  if (paths.isAbsolute(outputDirectory)) throw new VideoProjectError('INVALID_OUTPUT_DIRECTORY', '视频输出目录必须位于当前工作区内。')
  const result = paths.resolve(workspaceRoot, outputDirectory)
  const difference = paths.relative(workspaceRoot, result)
  if (difference === '' || difference === '..' || difference.startsWith('..' + paths.sep) || paths.isAbsolute(difference)) {
    throw new VideoProjectError('INVALID_OUTPUT_DIRECTORY', '视频输出目录必须位于当前工作区内。')
  }
  return result
}

/** Restrict retained prompt and reference input before persisting provider requests. */
function validateInput(input: VideoProjectInput, maxTotalSeconds: number): void {
  if (input.prompt.trim() === '' || input.prompt.length > MAX_PROMPT_LENGTH) throw new VideoProjectError('INVALID_PROMPT', '请提供 1 至 7000 字符的视频说明。')
  if (input.title !== undefined && (input.title.trim() === '' || input.title.length > 256)
    || input.shotTitles?.some(title => title.trim() === '' || title.length > 256)) {
    throw new VideoProjectError('INVALID_TITLE', '视频和分镜名称须为 1 至 256 字符，尚未提交生成。')
  }
  if (!Number.isSafeInteger(input.totalDurationSeconds) || input.totalDurationSeconds < 1 || input.totalDurationSeconds > maxTotalSeconds) {
    throw new VideoProjectError('INVALID_DURATION', `视频总时长须为 1 至 ${String(maxTotalSeconds)} 秒的整数。`)
  }
  if (input.shotPrompts?.some(prompt => prompt.trim() === '' || prompt.length > MAX_PROMPT_LENGTH)) throw new VideoProjectError('INVALID_SHOTS', '每个分镜说明须为 1 至 7000 字符。')
  if (input.shotDurations !== undefined && (input.shotDurations.length === 0
    || input.shotDurations.some(value => !Number.isSafeInteger(value) || value < 1))) {
    throw new VideoProjectError('INVALID_SHOT_DURATION', '每个分镜时长必须是正整数秒，尚未提交生成。')
  }
}

/** Retain the complete brief while limiting this clip's actions and speech to its own shot. */
function segmentPrompt(input: VideoProjectInput, model: string, index: number, count: number, durationSeconds: number): string {
  const parts = [
    `全局剧情与约束（保留原文，仅作全片上下文）：\n${input.prompt}`,
    `当前分镜 ${String(index + 1)}/${String(count)}，本片时长 ${String(durationSeconds)} 秒：\n${input.shotPrompts?.[index]
      ?? '按主说明有序推进当前片段，承接前镜并自然过渡到后镜，不从头重复全片剧情。'}`,
    '仅执行当前分镜的剧情、动作与分配台词；其他分镜只作上下文，不要在每段复述整篇或重复其他镜头的对白。',
    '保持主体、风格、色彩与前后分镜连贯。',
    '仅当主说明或当前分镜明确要求对白、演唱或旁白时才生成人声；尊重静音、无对白、无旁白和关闭音轨的要求，不强行配音。',
    '同一发声角色跨分镜固定使用同一个说话人标识（S1、S2），保持身份、音色与语言一致；不为从未发声的角色添加说话人标识。',
    '只朗读本镜分配的台词，逐字保留用户原文、标点和语言，不改写、不翻译、不补造台词。',
    '镜内人物发声时，其嘴部开合跟随对应语音；其他未说话角色不跟口型。画外旁白发声时，对应画内角色嘴唇保持闭合，不作说话口型。',
    '对白、环境声与背景配乐分别安排；仅执行用户要求的声音，音乐不能替代或盖过用户要求的对白。',
    '仅在主说明或当前分镜明确要求字幕时显示本镜对应字幕，并按发声时序同步；逐字保留原文和标点，不擅自添加或翻译字幕。',
  ]
  if (model === 'MiniMax-H3') {
    parts.push('MiniMax-H3 原生音画表达：integrated_multimodal_description 描述本镜画面、动作和对白；overall_soundscape 只描述环境与非语言声音；non_diegetic_music 只描述背景配乐。')
    parts.push('仅对本镜明确要求发声的原句使用 <d>[原语言]原句</d>，中文台词使用 <d>[Chinese]原句</d>；原句与标点逐字保留，已有标签不重复包裹。说话人标识、动作和语气放在 <d> 外。')
    parts.push('画外旁白使用 says in an off-screen voiceover，并在对应 <d> 后明确画内角色嘴唇保持闭合；需要显示的字幕用英文双引号括起原文，不翻译。')
  }
  return parts.join('\n\n')
}

/**
 * Publish an already verified clip or workspace edit without changing the editor's filesystem authority.
 * @param options - Optional trusted Host publisher.
 * @param sourcePath - Verified private clip or successfully composed workspace video.
 * @param directory - Captured output; absence preserves legacy workspace-only delivery.
 * @param signal - Cancellation for the copy.
 * @param origin - Original generating location retained before generation or local editing.
 * @param videoRole - Explicit finished-video or storyboard-clip purpose.
 * @param naming - Saved plan, shot or original-input label used only for the new file name.
 * @returns Real published path, or the unchanged legacy workspace path.
 */
export async function publishVideoOutput(
  options: VideoProjectOptions, sourcePath: string, directory: string | undefined, signal: AbortSignal,
  origin?: ArtifactOrigin, videoRole?: ArtifactVideoRole,
  naming?: Omit<MediaFilenameOptions, 'extension'>,
): Promise<string> {
  if (directory === undefined) return sourcePath
  const publication = options.publication
  if (publication === undefined) throw new VideoProjectError('ARTIFACT_STORAGE_UNAVAILABLE', '产物保存服务尚未准备好，本地成片仍保留，请恢复服务后继续保存，无需重新生成。')
  try {
    const filename = mediaFilename({ ...naming ?? { prompt: basename(sourcePath, '.mp4'), role: videoRole ?? 'video' }, extension: 'mp4' })
    return (await publication.publish({ destination: { directory }, sourcePath, filename, signal,
      ...origin === undefined ? {} : { origin: Object.freeze({ ...origin }) }, ...videoRole === undefined ? {} : { videoRole } })).path
  } catch (cause) {
    signal.throwIfAborted()
    throw new VideoProjectError('ARTIFACT_PUBLISH_FAILED', '产物保存失败，本地成片和已生成片段仍保留，请检查保存位置后继续项目，无需重新生成。', { cause })
  }
}

/** Publish a saved clip once; legacy projects keep their copies inside their original workspace. */
async function publishSegment(options: VideoProjectOptions, manifest: VideoProjectManifest, segment: VideoProjectSegment,
  signal: AbortSignal): Promise<void> {
  if (segment.publishedPath !== undefined || segment.status !== 'saved') return
  const source = savedPath(segment)
  if (dirname(await realpath(source)) !== await realpath(join(options.stateDirectory, manifest.id, 'clips'))) {
    throw new VideoProjectError('INVALID_RECORD', '已保存的视频片段不在该项目目录中，已停止保存。')
  }
  const title = manifest.input.shotTitles?.[segment.index - 1] ?? manifest.input.title
  const naming: Omit<MediaFilenameOptions, 'extension'> = {
    ...title === undefined ? {} : { title },
    prompt: manifest.input.shotPrompts?.[segment.index - 1] ?? manifest.input.prompt, role: 'shot', index: segment.index,
  }
  if (manifest.publicationDirectory !== undefined) {
    segment.publishedPath = await publishVideoOutput(options, source, manifest.publicationDirectory, signal, manifest.origin, 'shot', naming)
  } else {
    const workspace = await realpath(manifest.workspaceRoot)
    resolveVideoOutputDirectory(manifest.workspaceRoot, nativePaths.relative(manifest.workspaceRoot, manifest.outputDirectory))
    let ancestor = manifest.outputDirectory
    for (;;) {
      try { ancestor = await realpath(ancestor); break } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
        ancestor = dirname(ancestor)
      }
    }
    const ancestorRelative = nativePaths.relative(workspace, ancestor)
    if (ancestorRelative === '..' || ancestorRelative.startsWith('..' + nativePaths.sep) || nativePaths.isAbsolute(ancestorRelative)) {
      throw new VideoProjectError('INVALID_OUTPUT_DIRECTORY', '视频保存目录已离开原工作区，已停止保存；原始片段仍保留。')
    }
    await mkdir(manifest.outputDirectory, { recursive: true })
    const destination = await realpath(manifest.outputDirectory)
    const relative = nativePaths.relative(workspace, destination)
    if (relative === '' || relative === '..' || relative.startsWith('..' + nativePaths.sep) || nativePaths.isAbsolute(relative)) {
      throw new VideoProjectError('INVALID_OUTPUT_DIRECTORY', '视频保存目录已离开原工作区，已停止保存；原始片段仍保留。')
    }
    const path = join(destination, mediaFilename({ ...naming, extension: 'mp4' }))
    signal.throwIfAborted()
    await copyFile(source, path, constants.COPYFILE_EXCL)
    if (signal.aborted) { await unlink(path); signal.throwIfAborted() }
    segment.publishedPath = path
  }
  const publishedPath = segment.publishedPath
  let publishedFile: Stats | undefined
  try {
    publishedFile = await lstat(publishedPath)
    await persist(options, manifest)
  } catch (error) {
    delete segment.publishedPath
    try {
      const current = await lstat(publishedPath)
      if (publishedFile === undefined || current.isSymbolicLink() || current.dev !== publishedFile.dev || current.ino !== publishedFile.ino
        || current.size !== publishedFile.size || current.mtimeMs !== publishedFile.mtimeMs || current.ctimeMs !== publishedFile.ctimeMs) {
        throw new VideoProjectError('ARTIFACT_PUBLISH_ROLLBACK_FAILED', '产物副本已发生变化，未删除该文件；请检查保存目录后重试。')
      }
      await unlink(publishedPath)
    } catch (rollbackError) {
      if (!(rollbackError instanceof Error) || !('code' in rollbackError) || rollbackError.code !== 'ENOENT') {
        throw new VideoProjectError('ARTIFACT_PUBLISH_ROLLBACK_FAILED', '产物副本的保存状态无法确认，未删除未确认的文件；请检查保存目录后重试。', { cause: rollbackError })
      }
    }
    throw error
  }
}

/**
 * Make previously saved clips discoverable without generation, provider reads, or rerunning composition.
 * @param options - Original private state and trusted artifact publisher.
 * @param id - Exact retained project selected through an owned creation record.
 * @param ownerSessionId - Original owning chat.
 * @param workspaceRoot - Original owning workspace.
 * @param identity - Current signed-in account.
 * @param signal - Owning Host lifetime.
 * @param assertCurrent - Recheck the captured login before each local publication.
 * @returns Latest authorized record with clip copies or a retryable local publication warning; authorization failures still reject.
 */
export async function recoverVideoProjectOutputs(options: VideoProjectOptions, id: string, ownerSessionId: string,
  workspaceRoot: string, identity: VideoProjectIdentity, signal: AbortSignal,
  assertCurrent: () => Promise<void>): Promise<VideoProjectRead> {
  const key = join(options.stateDirectory, projectId(id))
  signal.throwIfAborted()
  await assertCurrent()
  const owned = await readVideoProject(options, id, ownerSessionId, workspaceRoot, identity)
  signal.throwIfAborted()
  if (runningProjects.has(key)
    || !owned.segments.some(segment => segment.status === 'saved' && segment.publishedPath === undefined)) return owned
  const existing = recoveringProjects.get(key)
  if (existing !== undefined) {
    const result = await existing
    signal.throwIfAborted()
    await assertCurrent()
    return result
  }
  const work = (async () => {
    const manifest = await readVideoProject(options, id, ownerSessionId, workspaceRoot, identity)
    let publicationFailed = false
    for (const segment of manifest.segments) {
      signal.throwIfAborted()
      await assertCurrent()
      try { await publishSegment(options, manifest, segment, signal) } catch (error) {
        signal.throwIfAborted()
        if (!retryablePublicationFailure(error)) throw error
        publicationFailed = true
      }
      await assertCurrent()
    }
    return publicationFailed ? { ...manifest, publicationErrorCode: 'ARTIFACT_PUBLISH_FAILED' as const } : manifest
  })()
  recoveringProjects.set(key, work)
  try { return await work } finally { recoveringProjects.delete(key) }
}

/** Recheck a retained destination before any additional paid clip submission. */
async function validatePublication(options: VideoProjectOptions, directory: string | undefined, signal: AbortSignal): Promise<void> {
  if (directory === undefined) return
  const publication = options.publication
  if (publication === undefined) throw new VideoProjectError('ARTIFACT_STORAGE_UNAVAILABLE', '产物保存服务尚未准备好，已停止后续生成；请恢复服务后继续项目。')
  try { await publication.validate({ directory }, signal) } catch (cause) {
    signal.throwIfAborted()
    throw new VideoProjectError('ARTIFACT_DESTINATION_UNAVAILABLE', '项目原保存目录不可写，已停止后续生成；请恢复该目录后继续项目，已保存片段仍保留。', { cause })
  }
}

/** Atomically replace an owner-only record before exposing its new state. */
async function persist(options: VideoProjectOptions, manifest: VideoProjectManifest): Promise<void> {
  const previous = manifestWrites.get(manifest) ?? Promise.resolve()
  const write = previous.catch((_previousWriteFailed: unknown) => {
    // A later receipt must still be retained when an earlier local write failed.
  }).then(async () => {
    const updatedAt = new Date().toISOString()
    const directory = join(options.stateDirectory, manifest.id)
    const temporary = join(directory, `.manifest-${randomUUID()}.json`)
    const encoded = JSON.stringify({ ...manifest, updatedAt })
    if (Buffer.byteLength(encoded) > MAX_MANIFEST_BYTES) throw new VideoProjectError('VIDEO_PROJECT_INPUT_LIMIT', '视频项目记录过大，已停止后续提交；请减少参考素材或分镜数量。')
    await writeFile(temporary, encoded, { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(directory, 'manifest.json'))
    manifest.updatedAt = updatedAt
  })
  manifestWrites.set(manifest, write)
  try { await write }
  finally { if (manifestWrites.get(manifest) === write) manifestWrites.delete(manifest) }
}

/** Parse retained JSON rather than asserting a durable file into trusted types. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new VideoProjectError('INVALID_RECORD', '视频项目记录损坏，已停止操作。')
  return value as Record<string, unknown>
}

/** Accept only the UUID form issued for individual clip attempts. */
function videoAttemptId(value: unknown): VideoProjectAttemptId {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) {
    throw new VideoProjectError('INVALID_RECORD', '视频片段提交标识无效，已停止操作。')
  }
  return value as VideoProjectAttemptId
}

/** Validate the credential-free recursive provider request in a durable record. */
function requestValue(value: unknown, depth = 0): VideoRequestValue {
  if (depth > 32) throw new VideoProjectError('INVALID_RECORD', '视频项目请求记录过深，已停止操作。')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(item => requestValue(item, depth + 1))
  const source = record(value)
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, requestValue(item, depth + 1)]))
}

/** Read one required durable string. */
function text(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value === '') throw new VideoProjectError('INVALID_RECORD', '视频项目记录缺少必要信息，已停止操作。')
  return value
}

/** Read a durable optional string list. */
function strings(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) throw new VideoProjectError('INVALID_RECORD', '视频项目引用记录损坏，已停止操作。')
  return value
}

/** Read optional per-shot controls added without changing existing v1 records. */
function shotControls(input: Record<string, unknown>): Pick<VideoProjectInput,
  'shotDurations' | 'shotReferenceImages' | 'shotReferenceVideos' | 'shotReferenceAudios'> {
  const durations = input.shotDurations
  if (durations !== undefined && (!Array.isArray(durations) || durations.length === 0 || durations.length > 1024
    || !durations.every((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0))) {
    throw new VideoProjectError('INVALID_RECORD', '视频项目分镜时长记录损坏，已停止操作。')
  }
  const references: Pick<VideoProjectInput, 'shotReferenceImages' | 'shotReferenceVideos' | 'shotReferenceAudios'> = {}
  for (const key of ['shotReferenceImages', 'shotReferenceVideos', 'shotReferenceAudios'] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.length > 1024
      || !value.every((items): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string'))) {
      throw new VideoProjectError('INVALID_RECORD', '视频项目分镜素材记录损坏，已停止操作。')
    }
    references[key] = value
  }
  return {
    ...durations === undefined ? {} : { shotDurations: durations },
    ...references,
  }
}

/** Read one required positive durable number. */
function positive(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new VideoProjectError('INVALID_RECORD', '视频项目时长记录损坏，已停止操作。')
  return value
}

/** Validate all fields used to resume a durable operation. */
function parseManifest(value: unknown): VideoProjectManifest {
  const source = record(value)
  const identity = record(source.identity)
  const input = record(source.input)
  if (source.version !== 1 || !Array.isArray(source.segments) || source.segments.length > 1024) throw new VideoProjectError('INVALID_RECORD', '不支持该视频项目记录，已停止操作。')
  const status = source.status
  if (status !== 'prepared' && status !== 'running' && status !== 'editing' && status !== 'completed' && status !== 'failed' && status !== 'cancelled') throw new VideoProjectError('INVALID_RECORD', '视频项目状态无效，已停止操作。')
  if (status === 'completed' && (source.finalPath === undefined || source.finalDurationSeconds === undefined)) {
    throw new VideoProjectError('INVALID_RECORD', '已完成的视频项目缺少真实成片信息，无法作为成功结果交付。')
  }
  if (input.audio !== undefined && typeof input.audio !== 'boolean') throw new VideoProjectError('INVALID_RECORD', '视频项目音轨设置损坏，已停止操作。')
  const optionalInput = Object.fromEntries(['model', 'resolution', 'size', 'ratio', 'quality', 'mode', 'title'].flatMap(key => input[key] === undefined ? [] : [[key, text(input, key)]]))
  const parsedInput: VideoProjectInput = {
    prompt: text(input, 'prompt'), totalDurationSeconds: positive(input, 'totalDurationSeconds'), ...optionalInput,
    ...shotControls(input),
    ...input.shotPrompts === undefined ? {} : { shotPrompts: strings(input, 'shotPrompts') },
    ...input.shotTitles === undefined ? {} : { shotTitles: strings(input, 'shotTitles') },
    ...input.frameImages === undefined ? {} : { frameImages: strings(input, 'frameImages') },
    ...input.referenceImages === undefined ? {} : { referenceImages: strings(input, 'referenceImages') },
    ...input.referenceVideos === undefined ? {} : { referenceVideos: strings(input, 'referenceVideos') },
    ...input.referenceAudios === undefined ? {} : { referenceAudios: strings(input, 'referenceAudios') },
    ...input.audio === undefined ? {} : { audio: input.audio },
  }
  if (parsedInput.title !== undefined && (parsedInput.title.trim() === '' || parsedInput.title.length > 256)
    || parsedInput.shotTitles !== undefined && (parsedInput.shotTitles.length !== source.segments.length
      || parsedInput.shotTitles.some(title => title.trim() === '' || title.length > 256))) {
    throw new VideoProjectError('INVALID_RECORD', '视频项目名称记录损坏，已停止操作。')
  }
  if (source.publicationDirectory !== undefined && (typeof source.publicationDirectory !== 'string' || !nativePaths.isAbsolute(source.publicationDirectory) || /[\u0000-\u001f]/u.test(source.publicationDirectory))) throw new VideoProjectError('INVALID_RECORD', '视频项目保存目录损坏，已停止操作。')
  if ((source.composedPath === undefined) !== (source.composedDurationSeconds === undefined)) throw new VideoProjectError('INVALID_RECORD', '视频项目本地成片记录不完整，已停止操作。')
  if (source.composedPath !== undefined && (typeof source.composedPath !== 'string' || !nativePaths.isAbsolute(source.composedPath))) throw new VideoProjectError('INVALID_RECORD', '视频项目本地成片路径损坏，已停止操作。')
  const segments: VideoProjectSegment[] = source.segments.map((value) => {
    const segment = record(value)
    const status = segment.status
    if (status !== 'pending' && status !== 'submitting' && status !== 'running' && status !== 'saved' && status !== 'failed' && status !== 'unknown') throw new VideoProjectError('INVALID_RECORD', '视频片段状态无效，已停止操作。')
    const request = requestValue(segment.request)
    if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new VideoProjectError('INVALID_RECORD', '视频片段请求无效，已停止操作。')
    return {
      index: positive(segment, 'index'), durationSeconds: positive(segment, 'durationSeconds'), prompt: text(segment, 'prompt'), request, status,
      ...segment.attemptId === undefined ? {} : { attemptId: videoAttemptId(segment.attemptId) },
      ...segment.taskId === undefined ? {} : { taskId: text(segment, 'taskId') },
      ...segment.path === undefined ? {} : { path: text(segment, 'path') },
      ...segment.publishedPath === undefined ? {} : { publishedPath: text(segment, 'publishedPath') },
    }
  })
  const attempts = segments.flatMap(segment => segment.attemptId === undefined ? [] : [segment.attemptId])
  if (new Set(attempts).size !== attempts.length) throw new VideoProjectError('INVALID_RECORD', '视频片段提交标识重复，已停止操作。')
  if (parsedInput.shotDurations !== undefined && (parsedInput.shotDurations.length !== segments.length
    || parsedInput.shotDurations.some((duration, index) => duration !== segments[index]?.durationSeconds)
    || parsedInput.shotDurations.reduce((sum, duration) => sum + duration, 0) !== parsedInput.totalDurationSeconds)) {
    throw new VideoProjectError('INVALID_RECORD', '视频项目分镜时长与已保存请求不一致，已停止操作。')
  }
  if ([parsedInput.shotReferenceImages, parsedInput.shotReferenceVideos, parsedInput.shotReferenceAudios]
    .some(references => references !== undefined && references.length !== segments.length)) {
    throw new VideoProjectError('INVALID_RECORD', '视频项目分镜素材数量与已保存请求不一致，已停止操作。')
  }
  if (source.composedPath !== undefined && (source.publicationDirectory === undefined || segments.some(segment => segment.status !== 'saved'))) throw new VideoProjectError('INVALID_RECORD', '视频项目本地成片没有完整的已保存分镜记录，已停止操作。')
  if (segments.length === 0 || segments.some((segment, index) => segment.index !== index + 1 || (segment.status === 'running' && segment.taskId === undefined) || (segment.status === 'saved' && segment.path === undefined))) throw new VideoProjectError('INVALID_RECORD', '视频片段记录不完整，已停止操作。')
  if (segments.some(segment => segment.publishedPath !== undefined && (segment.status !== 'saved' || !nativePaths.isAbsolute(segment.publishedPath)))) {
    throw new VideoProjectError('INVALID_RECORD', '视频片段的产物保存记录损坏，已停止操作。')
  }
  const origin = parseArtifactOrigin(source.origin, text(source, 'ownerSessionId'))
  if (origin === null) throw new VideoProjectError('INVALID_RECORD', '视频项目生成来源损坏，已停止操作。')
  return {
    version: 1, id: projectId(text(source, 'id')), ownerSessionId: text(source, 'ownerSessionId'), workspaceRoot: text(source, 'workspaceRoot'),
    identity: { accountId: text(identity, 'accountId'), sessionFingerprint: text(identity, 'sessionFingerprint') }, input: parsedInput,
    model: text(source, 'model'), status, segments, outputDirectory: text(source, 'outputDirectory'),
    ...source.publicationDirectory === undefined ? {} : { publicationDirectory: source.publicationDirectory },
    ...origin === undefined ? {} : { origin },
    ...source.composedPath === undefined ? {} : { composedPath: source.composedPath, composedDurationSeconds: positive(source, 'composedDurationSeconds') },
    updatedAt: text(source, 'updatedAt'),
    ...source.finalPath === undefined ? {} : { finalPath: text(source, 'finalPath') },
    ...source.finalDurationSeconds === undefined ? {} : { finalDurationSeconds: positive(source, 'finalDurationSeconds') },
    ...source.failureCode === undefined ? {} : { failureCode: text(source, 'failureCode') },
  }
}

/**
 * Load a project after checking its agent, workspace, and signed-in account ownership.
 * @param options - configured private record directory.
 * @param id - tool-provided project id.
 * @param ownerSessionId - live calling agent session.
 * @param workspaceRoot - live calling workspace.
 * @param identity - live signed-in product account.
 * @returns parsed private record; it does not revive an old in-memory job.
 */
export async function readVideoProject(
  options: VideoProjectOptions, id: string, ownerSessionId: string, workspaceRoot: string, identity: VideoProjectIdentity,
): Promise<VideoProjectManifest> {
  const path = join(options.stateDirectory, projectId(id), 'manifest.json')
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new VideoProjectError('INVALID_RECORD', '视频项目记录过大或不可读取，已停止操作。')
  const manifest = parseManifest(JSON.parse(await readFile(path, 'utf8')))
  if (manifest.id !== id || manifest.ownerSessionId !== ownerSessionId || manifest.workspaceRoot !== workspaceRoot || manifest.identity.accountId !== identity.accountId) throw new VideoProjectError('PROJECT_ACCESS_DENIED', '该视频项目不属于当前账号、聊天或工作区。')
  return manifest
}

/**
 * Validate every request and local prerequisite, then save a project before paid work.
 * @param options - deployment settings and private records.
 * @param input - validated tool input.
 * @param ownerSessionId - initiating agent session.
 * @param workspaceRoot - initiating workspace.
 * @param provider - captured current account adapter.
 * @param editor - session-bound local editor.
 * @param signal - foreground preparation cancellation.
 * @param origin - Exact generating tool location captured before preparing paid work.
 * @returns prepared record containing the exact generation plan and requests.
 */
export async function prepareVideoProject(
  options: VideoProjectOptions, input: VideoProjectInput, ownerSessionId: string, workspaceRoot: string,
  provider: VideoProjectProvider, editor: VideoEditor, signal: AbortSignal,
  origin?: ArtifactOrigin,
): Promise<VideoProjectManifest> {
  const capturedOrigin = origin === undefined ? undefined : Object.freeze({ ...origin })
  validateInput(input, options.maxTotalSeconds)
  if (input.shotDurations !== undefined) {
    if (input.shotDurations.length > options.maxSegments) throw new VideoProjectError('TOO_MANY_SEGMENTS', '分镜数量超过当前项目上限，尚未提交生成。')
    if (input.shotDurations.reduce((sum, value) => sum + value, 0) !== input.totalDurationSeconds) {
      throw new VideoProjectError('SHOT_DURATION_MISMATCH', '分镜时长之和必须等于视频总时长，请修改时间轴后重试；尚未提交生成。')
    }
  }
  const id = `vp_${randomUUID()}` as VideoProjectId
  const outputDirectory = join(resolveVideoOutputDirectory(workspaceRoot, options.outputDirectory), id)
  await editor.preflight(signal, outputDirectory)
  let publicationDirectory: string | undefined
  try { publicationDirectory = (await options.publication?.capture(signal))?.directory } catch (cause) {
    signal.throwIfAborted()
    throw new VideoProjectError('ARTIFACT_DESTINATION_UNAVAILABLE', '产物保存目录不可写，请在产物页检查保存位置后重试；尚未提交生成。', { cause })
  }
  await provider.assertCurrent()
  const model = await provider.model(input.model, signal, input.resolution, input.quality, input.mode, input.ratio, input.size)
  const durations = input.shotDurations === undefined
    ? planVideoDurations(input.totalDurationSeconds, model.durations, options.maxSegments) : [...input.shotDurations]
  if (input.shotDurations !== undefined && durations.some(duration => !model.durations.includes(duration))) {
    throw new VideoProjectError('SHOT_DURATION_UNSUPPORTED', `当前模型不支持时间轴中的分镜时长，请从 ${model.durations.join('、')} 秒中选择；尚未提交生成。`)
  }
  if (input.shotPrompts !== undefined && input.shotPrompts.length !== durations.length) throw new VideoProjectError('SHOT_COUNT_MISMATCH', `该时长需要 ${String(durations.length)} 个分镜，请提供相同数量的分镜说明。`)
  if (input.shotTitles !== undefined && input.shotTitles.length !== durations.length) throw new VideoProjectError('SHOT_COUNT_MISMATCH', '分镜名称须与实际生成分镜一一对应，尚未提交生成。')
  if ([input.shotReferenceImages, input.shotReferenceVideos, input.shotReferenceAudios]
    .some(references => references !== undefined && references.length !== durations.length)) {
    throw new VideoProjectError('SHOT_COUNT_MISMATCH', '分镜参考素材须与实际生成分镜一一对应，尚未提交生成。')
  }
  const planned = durations.map((durationSeconds, index) => {
    const prompt = segmentPrompt(input, model.id, index, durations.length, durationSeconds)
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new VideoProjectError('INVALID_PROMPT', '完整分镜提示词超过 7000 字符，尚未提交生成；请精简主说明或分镜，原文未截断。')
    }
    return { durationSeconds, prompt }
  })
  const segments: VideoProjectSegment[] = []
  let generationInput = input
  if (input.title !== undefined || input.shotTitles !== undefined) {
    generationInput = { ...input }
    delete generationInput.title
    delete generationInput.shotTitles
  }
  for (const [index, { durationSeconds, prompt }] of planned.entries()) {
    signal.throwIfAborted()
    const requestInput = videoShotInput(generationInput, index)
    const request = await provider.build(requestInput, model.id, prompt, durationSeconds, signal)
    segments.push({ index: index + 1, durationSeconds, prompt, request, status: 'pending', attemptId: videoAttemptId(randomUUID()) })
  }
  const manifest: VideoProjectManifest = {
    version: 1, id, ownerSessionId, workspaceRoot, identity: { ...provider.identity }, input, model: model.id,
    status: 'prepared', segments, outputDirectory,
    ...publicationDirectory === undefined ? {} : { publicationDirectory },
    ...capturedOrigin === undefined ? {} : { origin: capturedOrigin },
    updatedAt: new Date().toISOString(),
  }
  // Reserve all later task/path fields before the first billable request.
  const maximumFilename = 'f'.repeat(MAX_MEDIA_FILENAME_BYTES)
  const growthReserve = segments.reduce((size, segment) => size + Buffer.byteLength(JSON.stringify({
    taskId: 't'.repeat(256),
    path: join(options.stateDirectory, id, 'clips', `clip-${String(segment.index).padStart(3, '0')}-${'f'.repeat(36)}.mp4`),
    publishedPath: join(publicationDirectory ?? outputDirectory, maximumFilename),
  })), 4096 + Buffer.byteLength(JSON.stringify({
    finalPath: join(publicationDirectory ?? outputDirectory, maximumFilename),
    ...publicationDirectory === undefined ? {} : {
      composedPath: join(outputDirectory, maximumFilename), composedDurationSeconds: input.totalDurationSeconds,
    },
  })))
  if (Buffer.byteLength(JSON.stringify(manifest)) + growthReserve > MAX_MANIFEST_BYTES) {
    throw new VideoProjectError('VIDEO_PROJECT_INPUT_LIMIT', '视频项目素材和记录过大，尚未提交生成；请减少参考素材或分镜数量。')
  }
  signal.throwIfAborted()
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
  await mkdir(join(options.stateDirectory, id), { mode: 0o700 })
  await mkdir(join(options.stateDirectory, id, 'clips'), { mode: 0o700 })
  await persist(options, manifest)
  return manifest
}

/** Read a committed clip path; a missing durable field must stop dependent editing. */
function savedPath(segment: VideoProjectSegment): string {
  if (segment.path === undefined) throw new VideoProjectError('INVALID_RECORD', '已保存的视频路径缺失，已停止剪辑。')
  return segment.path
}

/** A failed status read owns only the task whose response established it. */
class VideoProjectTaskFailure extends VideoProjectError {
  /** @param taskId - Original failed task. @param failure - Safe provider-owned summary, without raw upstream content. */
  constructor(readonly taskId: string, failure?: { code?: string; message?: string }) {
    super(failure?.code ?? 'PROVIDER_TASK_FAILED', failure?.message
      ?? '上游视频片段生成失败；已生成的其他片段保留，未重新提交任务。')
  }
}

/** Keep local waiting cancellation-owned instead of sleeping after a killed job. */
async function waitForTask(
  options: VideoProjectOptions, provider: VideoProjectProvider, segment: VideoProjectSegment,
  progress: (status: 'queued' | 'running' | 'retrying', seconds: number) => void | Promise<void>, signal: AbortSignal,
): Promise<void> {
  const taskId = segment.taskId
  if (taskId === undefined) throw new VideoProjectError('INVALID_RECORD', '视频任务编号缺失，已停止操作。')
  const startedAt = performance.now()
  let failures = 0
  const elapsed = (): number => Math.max(0, Math.floor((performance.now() - startedAt) / 1000))
  for (;;) {
    signal.throwIfAborted()
    await provider.assertCurrent()
    const deadline = AbortSignal.timeout(options.taskTimeoutMs)
    const querySignal = AbortSignal.any([signal, deadline])
    let state: Awaited<ReturnType<VideoProjectProvider['check']>>
    try { state = await provider.check(taskId, segment.request, querySignal) }
    catch (cause) {
      signal.throwIfAborted()
      const timedOut = deadline.aborted
      const transient = timedOut || cause instanceof VideoRelayError
        && (cause.code === 'VIDEO_READ_UNAVAILABLE' || cause.code === 'VIDEO_READ_RETRYABLE')
      if (!transient) throw cause
      if (failures >= (options.queryRetryLimit ?? 0)) {
        throw new VideoProjectError(timedOut ? 'VIDEO_TASK_OBSERVATION_TIMEOUT' : 'VIDEO_TASK_OBSERVATION_UNAVAILABLE',
          '原视频任务的状态查询暂不可用，已暂停查询并保留原任务编号；这不代表生成失败。请继续查询原项目，不要重新提交。', { cause })
      }
      await progress('retrying', elapsed())
      const retryInterval = Math.max(options.pollIntervalMs, provider.pollIntervalMs ?? 0) * 2 ** failures
      await delay(Math.min(retryInterval, options.taskTimeoutMs), undefined, { signal })
      failures += 1
      continue
    }
    failures = 0
    if (state.status === 'succeeded') return
    if (state.status === 'failed') throw new VideoProjectTaskFailure(taskId, state)
    await progress(state.status, elapsed())
    await delay(Math.max(options.pollIntervalMs, provider.pollIntervalMs ?? 0), undefined, { signal })
  }
}

/** Transient observations never replace the durable submission or saved-file facts. */
function segmentProgress(segment: VideoProjectSegment, stopped: boolean): string {
  switch (segment.status) {
    case 'pending': return '尚未提交'
    case 'submitting': return '提交结果待确认，请核对原任务'
    case 'running': return stopped ? '查询已暂停，保留原任务' : '已受理，等待查询'
    case 'saved': return '已保存'
    case 'failed': return '失败'
    case 'unknown': return '提交结果待确认，勿重新提交'
  }
}

/** Keep every clip visible; terminal jobs retain one bounded summary in ordinary output. */
function videoProjectProgress(manifest: VideoProjectManifest, job: JobHandle) {
  const observations = new Map<number, string>()
  const upstreamCompleted = new Set<number>()
  let stage = '准备分镜'
  let previous: string | undefined
  const render = (): string => {
    const count = String(manifest.segments.length)
    const saved = manifest.segments.filter(segment => segment.status === 'saved').length
    return [`视频项目：${stage} · 已保存 ${String(saved)}/${count} 段`, ...manifest.segments.map(segment =>
      `分镜 ${String(segment.index)}/${count} ${observations.get(segment.index) ?? segmentProgress(segment, false)}`)].join('\n')
  }
  const emit = (): void => {
    const value = render()
    if (value === previous) return
    previous = value
    job.updateProgress(value)
  }
  const stopped = (segment: VideoProjectSegment): string => segment.status === 'running' && upstreamCompleted.has(segment.index)
    ? '上游已完成，保存未完成' : segmentProgress(segment, true)
  return {
    stage(value: string): void { stage = value; emit() },
    segment(segment: VideoProjectSegment, value: string): void { observations.set(segment.index, value); emit() },
    saving(segment: VideoProjectSegment): void {
      upstreamCompleted.add(segment.index)
      observations.set(segment.index, '上游已完成，正在保存')
      emit()
    },
    stopped(segment: VideoProjectSegment): void { observations.set(segment.index, stopped(segment)); emit() },
    finish(value: string, failed = false): void {
      stage = value
      for (const segment of manifest.segments) observations.set(segment.index, stopped(segment))
      emit()
      job.append(`${render()}\n`, failed ? { channel: 'stderr' } : undefined)
    },
  }
}

type VideoProjectProgress = ReturnType<typeof videoProjectProgress>

/** A retained accepted task may still run after local cancellation or failure. */
function segmentActivityOutcome(segment: VideoProjectSegment): CreationActivityOutcome {
  switch (segment.status) {
    case 'saved': return 'completed'
    case 'failed': return 'failed'
    case 'pending': return 'stopped'
    case 'submitting':
    case 'running':
    case 'unknown': return 'unknown'
  }
}

/** Carry only identities and typed phases into optional process-local statistics. */
function projectActivity(options: VideoProjectOptions, manifest: VideoProjectManifest,
  identity: VideoProjectIdentity, segment?: VideoProjectSegment) {
  return creationTaskActivity((event) => {
    notifyCreationActivity(options.activity, { ...event,
      projectId: manifest.id, ownerSessionId: manifest.ownerSessionId,
      accountId: identity.accountId, sessionFingerprint: identity.sessionFingerprint,
      ...segment === undefined ? {} : { shotId: String(segment.index),
        ...segment.attemptId === undefined ? {} : { attemptId: segment.attemptId } },
    })
  })
}

/**
 * Run or explicitly resume a durable project; never retry an unknown submission.
 * @param options - configuration and private record storage.
 * @param manifest - prepared or explicitly authorized retained project.
 * @param provider - current account adapter, checked before every paid request.
 * @param editor - initiating session's sandbox-aware local editor.
 * @param job - registered job output and progress writer.
 * @param signal - job-owned cancellation, not the completed tool call's signal.
 * @returns a non-rejecting terminal outcome after all owned work has stopped.
 */
export async function runVideoProject(
  options: VideoProjectOptions, manifest: VideoProjectManifest, provider: VideoProjectProvider, editor: VideoEditor,
  job: JobHandle, signal: AbortSignal,
): Promise<JobOutcome> {
  const key = join(options.stateDirectory, manifest.id)
  for (;;) {
    if (runningProjects.has(key)) return { status: 'failed', detail: 'PROJECT_ALREADY_RUNNING',
      result: JSON.stringify({ status: 'failed', code: 'PROJECT_ALREADY_RUNNING' }) }
    const recovery = recoveringProjects.get(key)
    if (recovery === undefined) break
    try { await recovery } catch (error) { void error /* Explicit resume rechecks authorization and publication independently. */ }
  }
  runningProjects.add(key)
  const activity = projectActivity(options, manifest, provider.identity)
  let activityOutcome: CreationActivityOutcome = 'unknown'
  activity.stage('preparing')
  try {
    const retained = await readVideoProject(options, manifest.id, manifest.ownerSessionId, manifest.workspaceRoot, provider.identity)
    if (retained.origin === undefined) delete manifest.origin
    Object.assign(manifest, retained)
    const progress = videoProjectProgress(manifest, job)
    if (manifest.status === 'completed') {
      signal.throwIfAborted()
      await provider.assertCurrent()
      progress.finish('视频已完成')
      activityOutcome = 'completed'
      return { status: 'completed', result: JSON.stringify({ status: 'succeeded', project_id: manifest.id,
        final_path: manifest.finalPath, duration_seconds: manifest.finalDurationSeconds,
        clip_paths: manifest.segments.map(segment => segment.publishedPath ?? savedPath(segment)) }) }
    }
    const outcome = await executeVideoProject(options, manifest, provider, editor, job, signal, progress, activity)
    activityOutcome = outcome.status === 'completed' ? 'completed'
      : manifest.segments.some(segment => segmentActivityOutcome(segment) === 'unknown') ? 'unknown'
        : outcome.status === 'killed' ? 'stopped' : 'failed'
    return outcome
  } catch (error) {
    const failure = videoProjectFailure(error)
    activityOutcome = manifest.segments.some(segment => segmentActivityOutcome(segment) === 'unknown') ? 'unknown'
      : signal.aborted ? 'stopped' : 'failed'
    return { status: signal.aborted ? 'killed' : 'failed', detail: signal.aborted ? 'CANCELLED' : failure.code,
      result: JSON.stringify({ status: signal.aborted ? 'cancelled' : 'failed', ...failure }) }
  } finally {
    runningProjects.delete(key)
    if (activityOutcome === 'unknown') activity.stage('unknown')
    activity.end(activityOutcome)
  }
}

/** Own workers and their stop barrier until every late submission receipt has settled. */
async function executeVideoSegments(
  options: VideoProjectOptions, manifest: VideoProjectManifest, provider: VideoProjectProvider, editor: VideoEditor,
  job: JobHandle, signal: AbortSignal, unsettled: Set<number>, onlyAccepted: boolean, progress: VideoProjectProgress,
): Promise<void> {
  let queue = manifest.segments.filter(segment => segment.status !== 'saved' && segment.status !== 'failed'
    && (segment.status !== 'unknown' || segment.taskId !== undefined) && (!onlyAccepted || segment.taskId !== undefined))
    .toSorted((left, right) => Number(right.taskId !== undefined) - Number(left.taskId !== undefined))
  if (queue.length === 0) return
  let hasNewSubmission = !onlyAccepted && queue.some(segment => segment.taskId === undefined)
  let granted = DEFAULT_VIDEO_PROJECT_PARALLELISM
  let admissionFailure: { error: unknown } | undefined
  try {
    if (hasNewSubmission) await provider.prepareSubmissions?.(queue.map(segment => segment.request), signal)
    granted = options.maxConcurrentSegments === 1 || queue.length === 1 ? 1
      : !hasNewSubmission || provider.parallelism === undefined
        ? DEFAULT_VIDEO_PROJECT_PARALLELISM : await provider.parallelism(manifest.model, signal)
  } catch (error) {
    if (signal.aborted || !queue.some(segment => segment.taskId !== undefined)) throw error
    admissionFailure = { error }
    queue = queue.filter(segment => segment.taskId !== undefined)
    hasNewSubmission = false
    progress.stage('新增分镜暂不可提交，继续查询原任务')
  }
  signal.throwIfAborted()
  const concurrency = Math.min(options.maxConcurrentSegments ?? granted, granted, queue.length)
  if (queue.some(segment => segment.attemptId === undefined)) {
    for (const segment of queue) segment.attemptId ??= videoAttemptId(randomUUID())
    await persist(options, manifest)
    signal.throwIfAborted()
  }
  const tasks = queue.map(segment => ({ segment,
    activity: projectActivity(options, manifest, provider.identity, segment) }))
  for (const task of tasks) task.activity.stage('preparing')
  const stop = new AbortController()
  let failure: { error: unknown } | undefined
  let cursor = 0
  const execute = async (segment: VideoProjectSegment, activity: ReturnType<typeof creationTaskActivity>,
    submissionOnly = false): Promise<void> => {
    const clipSignal = AbortSignal.any([signal, AbortSignal.timeout(options.taskTimeoutMs)])
    const observation = AbortSignal.any([signal, stop.signal])
    progress.segment(segment, segment.taskId === undefined ? '准备提交，尚未提交' : '已受理，等待查询')
    if (segment.taskId !== undefined) activity.stage(segment.status === 'unknown' || segment.status === 'submitting' ? 'unknown' : 'accepted')
    if (segment.taskId === undefined) {
      await validatePublication(options, manifest.publicationDirectory, clipSignal)
      await provider.assertCurrent()
      clipSignal.throwIfAborted()
      if (stop.signal.aborted) return
      segment.status = 'submitting'
      try { await persist(options, manifest) }
      catch (error) { segment.status = 'pending'; throw error }
      if (observation.aborted) {
        segment.status = 'pending'
        await persist(options, manifest)
        clipSignal.throwIfAborted()
        return
      }
      unsettled.add(segment.index)
      progress.segment(segment, '提交中')
      activity.stage('submitting')
      let task: { taskId: string }
      try {
        const attemptId = segment.attemptId
        if (attemptId === undefined) throw new VideoProjectError('INVALID_RECORD', '视频片段提交标识缺失，已停止操作。')
        task = await provider.submit(segment.request, clipSignal, { attemptId, durationSeconds: segment.durationSeconds, count: 1 })
      }
      catch (error) {
        if (error instanceof VideoRelayError && error.code === 'VIDEO_SUBMIT_NOT_STARTED') {
          segment.status = 'pending'
          unsettled.delete(segment.index)
          activity.stage('preparing')
          throw error
        }
        if (error instanceof VideoSubmissionRejection) {
          segment.status = 'failed'
          if (error.taskId !== undefined) segment.taskId = error.taskId
          unsettled.delete(segment.index)
          throw error
        }
        segment.status = 'unknown'
        activity.stage('unknown')
        if (error instanceof VideoRelayError && error.taskId !== undefined) segment.taskId = error.taskId
        if (error instanceof VideoRelayError && error.code === 'INSUFFICIENT_BALANCE') throw error
        if (error instanceof VideoRelayError && error.code === 'VIDEO_SUBMIT_BUSY') {
          throw new VideoProjectError('SUBMISSION_UNKNOWN', error.message, { cause: error })
        }
        throw new VideoProjectError('SUBMISSION_UNKNOWN', '视频提交结果未知，可能已计费；已停止后续生成，不会自动重提。请先在后台核对任务。', { cause: error })
      }
      if (task.taskId.trim() === '') {
        segment.status = 'unknown'
        activity.stage('unknown')
        throw new VideoProjectError('SUBMISSION_UNKNOWN', '上游未返回可查询的视频任务编号，可能已计费；已停止后续生成，请先在后台核对。')
      }
      segment.taskId = task.taskId
      segment.status = 'running'
      await persist(options, manifest)
      activity.stage('accepted')
      progress.segment(segment, '已受理，等待查询')
      job.append(`分镜 ${String(segment.index)} 已提交，任务 ${task.taskId}。\n`)
    }
    if (submissionOnly) return
    // Never cancel another in-flight POST merely because one peer failed.
    if (stop.signal.aborted) return
    try { await waitForTask(options, provider, segment, async (status, seconds) => {
      if (status !== 'retrying' && segment.status !== 'running') {
        segment.status = 'running'
        await persist(options, manifest)
      }
      activity.stage(status === 'retrying' ? 'unknown' : status === 'queued' ? 'queued' : 'generating')
      progress.segment(segment, status === 'retrying' ? '状态查询暂不可用，正在重试原任务'
        : `${status === 'queued' ? '排队中' : '生成中'}，已等待 ${String(seconds)} 秒`)
    }, observation) }
    catch (error) {
      // Peer cancellation can carry another clip's rejection as its abort reason.
      if ((error instanceof VideoSubmissionRejection || error instanceof VideoProjectTaskFailure) && error.taskId === segment.taskId) {
        segment.status = 'failed'
        unsettled.delete(segment.index)
      }
      throw error
    }
    unsettled.delete(segment.index)
    if (segment.status !== 'running') { segment.status = 'running'; await persist(options, manifest) }
    progress.saving(segment)
    activity.stage('saving')
    const path = join(options.stateDirectory, manifest.id, 'clips', `clip-${String(segment.index).padStart(3, '0')}-${randomUUID()}.mp4`)
    const saveSignal = AbortSignal.any([observation, AbortSignal.timeout(options.taskTimeoutMs)])
    await provider.download(segment.taskId, segment.request, path, saveSignal)
    segment.path = path
    const probe = await editor.probe(path, saveSignal)
    if (probe.durationSeconds + 0.25 < segment.durationSeconds) {
      segment.status = 'failed'
      throw new VideoProjectError('CLIP_TOO_SHORT', '上游片段短于所需时长，已保留文件并停止拼接，请检查该任务。')
    }
    segment.status = 'saved'
    await persist(options, manifest)
    await publishSegment(options, manifest, segment, saveSignal)
    await options.saved?.(manifest, segment.index, saveSignal)
    progress.segment(segment, '已保存')
    job.append(`分镜 ${String(segment.index)} 已保存：${segment.publishedPath ?? path}\n`)
  }
  const worker = async (submissionOnly = false): Promise<void> => {
    for (;;) {
      if (stop.signal.aborted || signal.aborted) return
      const task = tasks[cursor++]
      if (task === undefined) return
      const { segment, activity } = task
      try { await execute(segment, activity, submissionOnly) }
      catch (error) {
        progress.stopped(segment)
        if (failure === undefined) {
          failure = { error }
          progress.stage('正在停止，保留已有结果')
          stop.abort(error)
        }
        return
      } finally {
        if (!submissionOnly) {
          const outcome = segmentActivityOutcome(segment)
          if (outcome === 'unknown') activity.stage('unknown')
          activity.end(outcome)
        }
      }
    }
  }
  const runWorkers = async (submissionOnly = false): Promise<void> => {
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(submissionOnly))
    await Promise.allSettled(workers)
  }
  if (hasNewSubmission && provider.submissionMode === 'queued') {
    progress.stage('提交分镜至服务端等待队列')
    await runWorkers(true)
    cursor = 0
    if (failure === undefined && !signal.aborted) {
      progress.stage('跟踪已受理分镜')
      await runWorkers()
    }
  } else await runWorkers()
  for (const { segment, activity } of tasks) {
    const outcome = segmentActivityOutcome(segment)
    if (outcome === 'unknown') activity.stage('unknown')
    activity.end(outcome)
  }
  signal.throwIfAborted()
  if (failure !== undefined) throw failure.error
  if (admissionFailure !== undefined) throw admissionFailure.error
}

/** Run exclusively with respect to local clip recovery for this exact private project. */
async function executeVideoProject(
  options: VideoProjectOptions, manifest: VideoProjectManifest, provider: VideoProjectProvider, editor: VideoEditor,
  job: JobHandle, signal: AbortSignal, progress: VideoProjectProgress, activity: ReturnType<typeof creationTaskActivity>,
): Promise<JobOutcome> {
  const unsettled = new Set(manifest.segments.filter(segment =>
    segment.status === 'unknown' || segment.status === 'submitting' || segment.status === 'running').map(segment => segment.index))
  try {
    if (manifest.identity.accountId !== provider.identity.accountId) throw new VideoProjectError('PROJECT_ACCESS_DENIED', '该视频项目不属于当前登录账号。')
    progress.stage('检查已保存片段')
    for (const segment of manifest.segments) {
      if (segment.status !== 'saved') continue
      signal.throwIfAborted()
      await provider.assertCurrent()
      await editor.probe(savedPath(segment), signal)
      await publishSegment(options, manifest, segment, signal)
    }
    const blockingFailure = (): VideoProjectError | undefined =>
      manifest.segments.some(segment => segment.status === 'unknown' || segment.status === 'submitting')
        ? new VideoProjectError('SUBMISSION_UNKNOWN', '有一次视频提交结果未知，可能已计费。已知任务仍可查询保存；请先在后台核对未知提交，系统不会自动重提。')
        : manifest.segments.some(segment => segment.status === 'failed')
          ? new VideoProjectError('PROVIDER_TASK_FAILED', '项目中有失败的上游任务，已生成片段保留；其余已知任务仍可查询保存，请使用 edit_video 编辑已保存片段，或明确创建新项目。')
          : undefined
    const blocked = blockingFailure()
    if (blocked !== undefined && !manifest.segments.some(segment => segment.taskId !== undefined
      && (segment.status === 'running' || segment.status === 'unknown' || segment.status === 'submitting'))) throw blocked
    await editor.preflight(signal, manifest.outputDirectory)
    manifest.identity = { ...provider.identity }
    manifest.status = 'running'
    delete manifest.failureCode
    await persist(options, manifest)
    progress.stage('生成分镜')
    if (manifest.composedPath === undefined) {
      await executeVideoSegments(options, manifest, provider, editor, job, signal, unsettled, blocked !== undefined, progress)
    }
    if (blocked !== undefined && manifest.segments.some(segment => segment.status !== 'saved')) {
      const remaining = blockingFailure()
      if (remaining !== undefined) throw remaining
      throw new VideoProjectError('VIDEO_PROJECT_RESUME_REQUIRED',
        '原任务已核对并保存，尚未提交的分镜保留；本轮没有新增生成，请确认后再次恢复项目。')
    }
    signal.throwIfAborted()
    manifest.status = 'editing'
    await persist(options, manifest)
    activity.stage('editing')
    progress.stage('自动剪辑并拼接视频')
    let result: { path: string; durationSeconds: number }
    if (manifest.composedPath !== undefined && manifest.composedDurationSeconds !== undefined) {
      const checked = await editor.probe(manifest.composedPath, signal)
      if (Math.abs(checked.durationSeconds - manifest.composedDurationSeconds) > 0.25) throw new VideoProjectError('INVALID_RECORD', '保留的本地成片时长已变化，请检查文件；未重新提交生成任务。')
      result = { path: manifest.composedPath, durationSeconds: manifest.composedDurationSeconds }
    } else {
      result = await editor.compose({
        clips: manifest.segments.map(segment => ({ path: savedPath(segment) })),
        outputPath: join(manifest.outputDirectory, mediaFilename({
          ...manifest.input.title === undefined ? {} : { title: manifest.input.title },
          prompt: manifest.input.prompt, role: 'final', extension: 'mp4',
        })),
        totalDurationSeconds: manifest.input.totalDurationSeconds, signal,
        onProgress: (value) => { progress.stage(value.stage === 'normalizing' ? `整理片段 ${String(value.completedClips)}/${String(value.totalClips)}` : value.stage === 'assembling' ? '拼接并剪辑视频' : '校验最终视频') },
      })
      if (manifest.publicationDirectory !== undefined) {
        manifest.composedPath = result.path
        manifest.composedDurationSeconds = result.durationSeconds
        await persist(options, manifest)
      }
    }
    manifest.finalPath = await publishVideoOutput(options, result.path, manifest.publicationDirectory, signal, manifest.origin, 'final', {
      ...manifest.input.title === undefined ? {} : { title: manifest.input.title }, prompt: manifest.input.prompt, role: 'final',
    })
    manifest.finalDurationSeconds = result.durationSeconds
    manifest.status = 'completed'
    await persist(options, manifest)
    await options.saved?.(manifest, undefined, signal)
    progress.finish('视频已完成')
    const summary = JSON.stringify({ status: 'succeeded', project_id: manifest.id, final_path: manifest.finalPath, duration_seconds: result.durationSeconds, clip_paths: manifest.segments.map(segment => segment.publishedPath ?? savedPath(segment)), message: '视频已实际保存。请调用 present 展示 final_path，并在回复中提供可点击的产物链接。' })
    job.append(`${summary}\n`)
    return { status: 'completed', result: summary }
  } catch (error) {
    const reported = videoProjectFailure(error)
    const observationPaused = reported.code === 'VIDEO_TASK_OBSERVATION_TIMEOUT' || reported.code === 'VIDEO_TASK_OBSERVATION_UNAVAILABLE'
    manifest.status = signal.aborted ? 'cancelled' : observationPaused ? 'running' : 'failed'
    manifest.failureCode = signal.aborted ? 'CANCELLED' : reported.code
    try { options.failed?.(manifest, manifest.failureCode) }
    catch (_unavailableObserver: unknown) { /* Diagnostics never replace the retained workflow outcome. */ }
    const message = signal.aborted ? '视频项目已停止，已保存的片段保留。' : reported.message
    const warning = unsettled.size > 0 ? ' 已提交的上游任务无法由本地取消，可能继续运行并计费。' : ''
    try { await persist(options, manifest) }
    catch (storageError) {
      // Storage failure is independently reported; its raw path/error is not model-visible.
      void storageError
      progress.finish('项目记录保存失败，已停止', true)
      job.append('项目状态保存失败；已停止后续提交。最后一次提交可能未记录，请先在后台核对任务，勿直接重试。\n', { channel: 'stderr' })
      return { status: signal.aborted ? 'killed' : 'failed', detail: 'PROJECT_STORAGE_FAILED', result: JSON.stringify({ status: 'failed', project_id: manifest.id, code: 'PROJECT_STORAGE_FAILED', message: `项目记录保存失败，请保留已返回的任务编号并在后台核对，勿直接重试。${warning}`, clip_paths: manifest.segments.flatMap(segment => segment.path === undefined ? [] : [segment.publishedPath ?? segment.path]), task_ids: manifest.segments.flatMap(segment => segment.taskId === undefined ? [] : [segment.taskId]) }) }
    }
    progress.finish(signal.aborted ? '项目已停止' : observationPaused ? '等待已暂停，保留原任务' : '项目未完成', true)
    const result = JSON.stringify({ status: signal.aborted ? 'cancelled' : observationPaused ? 'pending' : 'failed', project_id: manifest.id, code: manifest.failureCode, message: message + warning, clip_paths: manifest.segments.flatMap(segment => segment.path === undefined ? [] : [segment.publishedPath ?? segment.path]), task_ids: manifest.segments.flatMap(segment => segment.taskId === undefined ? [] : [segment.taskId]) })
    job.append(`${result}\n`, { channel: 'stderr' })
    return { status: signal.aborted ? 'killed' : 'failed', detail: manifest.failureCode, result }
  }
}
