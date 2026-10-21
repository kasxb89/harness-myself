/** Durable, account-bound multi-clip generation and local composition. @module */

import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import * as nativePaths from 'node:path'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ArtifactOrigin } from '@deepseek-ai/dsh-artifacts-index'
import { parseArtifactOrigin } from './artifact-origin.ts'
import { VideoEditError, type VideoEditor } from './video-edit.ts'
import { VideoRelayError } from './video-project-provider.ts'
import type { VideoProjectIdentity, VideoProjectInput, VideoProjectOptions, VideoProjectProvider, VideoProjectRequest, VideoRequestValue } from './video-project-types.ts'

/** Complete private-record parser limit, including prompt and per-clip metadata. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const MAX_PROMPT_LENGTH = 7000

const runningProjects = new Set<string>()
const recoveringProjects = new Map<string, Promise<VideoProjectRead>>()

/** An opaque project identifier, validated before selecting its private record. */
export type VideoProjectId = Branded<'VideoProjectId'>

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
  if (error instanceof VideoProjectError || error instanceof VideoRelayError) return { code: error.code, message: error.message }
  if (error instanceof VideoEditError) {
    const messages = {
      VIDEO_EDIT_RUNTIME_UNAVAILABLE: '本地视频工具尚未准备好，请重新启动客户端完成工具准备后重试；已生成的片段保留。',
      VIDEO_EDIT_SANDBOX_DENIED: '工作区未允许本地视频处理，请检查文件夹写入权限后重试；原始片段保留。',
      VIDEO_EDIT_INVALID_INPUT: '视频片段或裁剪设置无效，请检查文件路径、裁剪范围及输出位置；原始片段保留。',
      VIDEO_EDIT_FAILED: '本地视频剪辑失败，原始片段保留。可重试剪辑，无需重新付费生成。',
      VIDEO_EDIT_CANCELLED: '本地视频剪辑已停止，原始片段保留。',
      VIDEO_EDIT_OUTPUT_INVALID: '剪辑结果未通过校验，未作为成片交付；原始片段保留，可重新剪辑。',
    } satisfies Record<VideoEditError['code'], string>
    return { code: error.code, message: messages[error.code] }
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
 * @returns Real published path, or the unchanged legacy workspace path.
 */
export async function publishVideoOutput(
  options: VideoProjectOptions, sourcePath: string, directory: string | undefined, signal: AbortSignal,
  origin?: ArtifactOrigin,
): Promise<string> {
  if (directory === undefined) return sourcePath
  const publication = options.publication
  if (publication === undefined) throw new VideoProjectError('ARTIFACT_STORAGE_UNAVAILABLE', '产物保存服务尚未准备好，本地成片仍保留，请恢复服务后继续保存，无需重新生成。')
  try {
    const filename = `${basename(dirname(sourcePath))}-${randomUUID()}-${basename(sourcePath)}`
    return (await publication.publish({ destination: { directory }, sourcePath, filename, signal,
      ...origin === undefined ? {} : { origin: Object.freeze({ ...origin }) } })).path
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
  if (manifest.publicationDirectory !== undefined) {
    segment.publishedPath = await publishVideoOutput(options, source, manifest.publicationDirectory, signal, manifest.origin)
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
    const path = join(destination, `clip-${String(segment.index).padStart(3, '0')}-${randomUUID()}.mp4`)
    signal.throwIfAborted()
    await copyFile(source, path, constants.COPYFILE_EXCL)
    if (signal.aborted) { await unlink(path); signal.throwIfAborted() }
    segment.publishedPath = path
  }
  const publishedPath = segment.publishedPath
  const updatedAt = manifest.updatedAt
  let publishedFile: Stats | undefined
  try {
    publishedFile = await lstat(publishedPath)
    await persist(options, manifest)
  } catch (error) {
    delete segment.publishedPath
    manifest.updatedAt = updatedAt
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
  manifest.updatedAt = new Date().toISOString()
  const directory = join(options.stateDirectory, manifest.id)
  const temporary = join(directory, `.manifest-${randomUUID()}.json`)
  const encoded = JSON.stringify(manifest)
  if (Buffer.byteLength(encoded) > MAX_MANIFEST_BYTES) throw new VideoProjectError('VIDEO_PROJECT_INPUT_LIMIT', '视频项目记录过大，已停止后续提交；请减少参考素材或分镜数量。')
  await writeFile(temporary, encoded, { mode: 0o600, flag: 'wx' })
  await rename(temporary, join(directory, 'manifest.json'))
}

/** Parse retained JSON rather than asserting a durable file into trusted types. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new VideoProjectError('INVALID_RECORD', '视频项目记录损坏，已停止操作。')
  return value as Record<string, unknown>
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
function shotControls(input: Record<string, unknown>): Pick<VideoProjectInput, 'shotDurations' | 'shotReferenceImages'> {
  const durations = input.shotDurations
  if (durations !== undefined && (!Array.isArray(durations) || durations.length === 0 || durations.length > 1024
    || !durations.every((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0))) {
    throw new VideoProjectError('INVALID_RECORD', '视频项目分镜时长记录损坏，已停止操作。')
  }
  const references = input.shotReferenceImages
  if (references !== undefined && (!Array.isArray(references) || references.length > 1024
    || !references.every((value): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')))) {
    throw new VideoProjectError('INVALID_RECORD', '视频项目分镜素材记录损坏，已停止操作。')
  }
  return {
    ...durations === undefined ? {} : { shotDurations: durations },
    ...references === undefined ? {} : { shotReferenceImages: references },
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
  const optionalInput = Object.fromEntries(['model', 'resolution', 'ratio'].flatMap(key => input[key] === undefined ? [] : [[key, text(input, key)]]))
  const parsedInput: VideoProjectInput = {
    prompt: text(input, 'prompt'), totalDurationSeconds: positive(input, 'totalDurationSeconds'), ...optionalInput,
    ...shotControls(input),
    ...input.shotPrompts === undefined ? {} : { shotPrompts: strings(input, 'shotPrompts') },
    ...input.frameImages === undefined ? {} : { frameImages: strings(input, 'frameImages') },
    ...input.referenceImages === undefined ? {} : { referenceImages: strings(input, 'referenceImages') },
    ...input.referenceVideos === undefined ? {} : { referenceVideos: strings(input, 'referenceVideos') },
    ...input.referenceAudios === undefined ? {} : { referenceAudios: strings(input, 'referenceAudios') },
    ...input.audio === undefined ? {} : { audio: input.audio },
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
      ...segment.taskId === undefined ? {} : { taskId: text(segment, 'taskId') },
      ...segment.path === undefined ? {} : { path: text(segment, 'path') },
      ...segment.publishedPath === undefined ? {} : { publishedPath: text(segment, 'publishedPath') },
    }
  })
  if (parsedInput.shotDurations !== undefined && (parsedInput.shotDurations.length !== segments.length
    || parsedInput.shotDurations.some((duration, index) => duration !== segments[index]?.durationSeconds)
    || parsedInput.shotDurations.reduce((sum, duration) => sum + duration, 0) !== parsedInput.totalDurationSeconds)) {
    throw new VideoProjectError('INVALID_RECORD', '视频项目分镜时长与已保存请求不一致，已停止操作。')
  }
  if (parsedInput.shotReferenceImages !== undefined && parsedInput.shotReferenceImages.length !== segments.length) {
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
  const model = await provider.model(input.model, signal, input.resolution)
  const durations = input.shotDurations === undefined
    ? planVideoDurations(input.totalDurationSeconds, model.durations, options.maxSegments) : [...input.shotDurations]
  if (input.shotDurations !== undefined && durations.some(duration => !model.durations.includes(duration))) {
    throw new VideoProjectError('SHOT_DURATION_UNSUPPORTED', `当前模型不支持时间轴中的分镜时长，请从 ${model.durations.join('、')} 秒中选择；尚未提交生成。`)
  }
  if (input.shotPrompts !== undefined && input.shotPrompts.length !== durations.length) throw new VideoProjectError('SHOT_COUNT_MISMATCH', `该时长需要 ${String(durations.length)} 个分镜，请提供相同数量的分镜说明。`)
  if (input.shotReferenceImages !== undefined && input.shotReferenceImages.length !== durations.length) {
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
  for (const [index, { durationSeconds, prompt }] of planned.entries()) {
    signal.throwIfAborted()
    const requestInput = input.shotReferenceImages === undefined ? input : {
      ...input, referenceImages: [...new Set([...input.referenceImages ?? [], ...input.shotReferenceImages[index] ?? []])],
    }
    const request = await provider.build(requestInput, model.id, prompt, durationSeconds, signal)
    segments.push({ index: index + 1, durationSeconds, prompt, request, status: 'pending' })
  }
  const manifest: VideoProjectManifest = {
    version: 1, id, ownerSessionId, workspaceRoot, identity: { ...provider.identity }, input, model: model.id,
    status: 'prepared', segments, outputDirectory,
    ...publicationDirectory === undefined ? {} : { publicationDirectory },
    ...capturedOrigin === undefined ? {} : { origin: capturedOrigin },
    updatedAt: new Date().toISOString(),
  }
  // Reserve all later task/path fields before the first billable request.
  const growthReserve = segments.reduce((size, segment) => size + Buffer.byteLength(JSON.stringify({
    taskId: 't'.repeat(256), path: join(options.stateDirectory, id, 'clips', `clip-${String(segment.index)}-${randomUUID()}.mp4`),
    publishedPath: join(publicationDirectory ?? outputDirectory, `clips-${randomUUID()}-clip-${String(segment.index)}-${randomUUID()}.mp4`),
  })), 4096 + Buffer.byteLength(JSON.stringify({
    finalPath: join(publicationDirectory ?? outputDirectory, `${id}-final-${randomUUID()}.mp4`),
    ...publicationDirectory === undefined ? {} : { composedPath: join(outputDirectory, `final-${randomUUID()}.mp4`), composedDurationSeconds: input.totalDurationSeconds },
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

/** Keep local waiting cancellation-owned instead of sleeping after a killed job. */
async function waitForTask(
  options: VideoProjectOptions, provider: VideoProjectProvider, segment: VideoProjectSegment, signal: AbortSignal,
): Promise<void> {
  const taskId = segment.taskId
  if (taskId === undefined) throw new VideoProjectError('INVALID_RECORD', '视频任务编号缺失，已停止操作。')
  for (;;) {
    signal.throwIfAborted()
    const state = await provider.check(taskId, segment.request, signal)
    if (state.status === 'succeeded') return
    if (state.status === 'failed') throw new VideoProjectError('PROVIDER_TASK_FAILED', '上游视频片段生成失败；已生成的其他片段保留，未重新提交任务。')
    await delay(options.pollIntervalMs, undefined, { signal })
  }
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
  try {
    const retained = await readVideoProject(options, manifest.id, manifest.ownerSessionId, manifest.workspaceRoot, provider.identity)
    if (retained.origin === undefined) delete manifest.origin
    Object.assign(manifest, retained)
    if (manifest.status === 'completed') {
      signal.throwIfAborted()
      await provider.assertCurrent()
      return { status: 'completed', result: JSON.stringify({ status: 'succeeded', project_id: manifest.id,
        final_path: manifest.finalPath, duration_seconds: manifest.finalDurationSeconds,
        clip_paths: manifest.segments.map(segment => segment.publishedPath ?? savedPath(segment)) }) }
    }
    return await executeVideoProject(options, manifest, provider, editor, job, signal)
  } catch (error) {
    const failure = videoProjectFailure(error)
    return { status: signal.aborted ? 'killed' : 'failed', detail: signal.aborted ? 'CANCELLED' : failure.code,
      result: JSON.stringify({ status: signal.aborted ? 'cancelled' : 'failed', ...failure }) }
  } finally { runningProjects.delete(key) }
}

/** Run exclusively with respect to local clip recovery for this exact private project. */
async function executeVideoProject(
  options: VideoProjectOptions, manifest: VideoProjectManifest, provider: VideoProjectProvider, editor: VideoEditor,
  job: JobHandle, signal: AbortSignal,
): Promise<JobOutcome> {
  let upstreamMayContinue = false
  try {
    if (manifest.identity.accountId !== provider.identity.accountId) throw new VideoProjectError('PROJECT_ACCESS_DENIED', '该视频项目不属于当前登录账号。')
    for (const segment of manifest.segments) {
      if (segment.status !== 'saved') continue
      signal.throwIfAborted()
      await provider.assertCurrent()
      await editor.probe(savedPath(segment), signal)
      await publishSegment(options, manifest, segment, signal)
    }
    if (manifest.segments.some(segment => segment.status === 'unknown' || segment.status === 'submitting' && segment.taskId === undefined)) throw new VideoProjectError('SUBMISSION_UNKNOWN', '有一次视频提交结果未知，可能已计费。请先在后台核对任务，系统不会自动重提。')
    if (manifest.segments.some(segment => segment.status === 'failed')) throw new VideoProjectError('PROVIDER_TASK_FAILED', '项目中有失败的上游任务，已生成片段保留；请使用 edit_video 编辑已保存片段，或明确创建新项目。')
    await editor.preflight(signal, manifest.outputDirectory)
    manifest.identity = { ...provider.identity }
    manifest.status = 'running'
    delete manifest.failureCode
    await persist(options, manifest)
    if (manifest.composedPath === undefined) {
      for (const segment of manifest.segments) {
        signal.throwIfAborted()
        if (segment.status === 'saved') {
          await editor.probe(savedPath(segment), signal)
          continue
        }
        job.updateProgress(`生成分镜 ${String(segment.index)}/${String(manifest.segments.length)}`)
        const clipSignal = AbortSignal.any([signal, AbortSignal.timeout(options.taskTimeoutMs)])
        if (segment.taskId === undefined) {
          await validatePublication(options, manifest.publicationDirectory, clipSignal)
          await provider.assertCurrent()
          clipSignal.throwIfAborted()
          segment.status = 'submitting'
          await persist(options, manifest)
          upstreamMayContinue = true
          let task: { taskId: string }
          try { task = await provider.submit(segment.request, clipSignal) }
          catch (error) {
            if (error instanceof VideoRelayError && error.code === 'INSUFFICIENT_BALANCE') {
              // The gateway can also reject an adjusted cost after upstream
              // acceptance. Preserve the unknown-submission resume barrier.
              segment.status = 'unknown'
              throw error
            }
            segment.status = 'unknown'
            throw new VideoProjectError('SUBMISSION_UNKNOWN', '视频提交结果未知，可能已计费；已停止后续生成，不会自动重提。请先在后台核对任务。', { cause: error })
          }
          if (task.taskId.trim() === '') {
            segment.status = 'unknown'
            throw new VideoProjectError('SUBMISSION_UNKNOWN', '上游未返回可查询的视频任务编号，可能已计费；已停止后续生成，请先在后台核对。')
          }
          segment.taskId = task.taskId
          segment.status = 'running'
          await persist(options, manifest)
          job.append(`分镜 ${String(segment.index)} 已提交，任务 ${task.taskId}。\n`)
        } else upstreamMayContinue = true
        try { await waitForTask(options, provider, segment, clipSignal) }
        catch (error) {
          if (error instanceof VideoProjectError && error.code === 'PROVIDER_TASK_FAILED') {
            segment.status = 'failed'
            upstreamMayContinue = false
          }
          throw error
        }
        upstreamMayContinue = false
        job.updateProgress(`保存分镜 ${String(segment.index)}/${String(manifest.segments.length)}`)
        const path = join(options.stateDirectory, manifest.id, 'clips', `clip-${String(segment.index).padStart(3, '0')}-${randomUUID()}.mp4`)
        await provider.download(segment.taskId, segment.request, path, clipSignal)
        segment.path = path
        const probe = await editor.probe(path, clipSignal)
        if (probe.durationSeconds + 0.25 < segment.durationSeconds) {
          segment.status = 'failed'
          throw new VideoProjectError('CLIP_TOO_SHORT', '上游片段短于所需时长，已保留文件并停止拼接，请检查该任务。')
        }
        segment.path = path
        segment.status = 'saved'
        await persist(options, manifest)
        await publishSegment(options, manifest, segment, signal)
        await options.saved?.(manifest, segment.index, signal)
        job.append(`分镜 ${String(segment.index)} 已保存：${segment.publishedPath ?? path}\n`)
      }
    }
    signal.throwIfAborted()
    manifest.status = 'editing'
    await persist(options, manifest)
    job.updateProgress('自动剪辑并拼接视频')
    let result: { path: string; durationSeconds: number }
    if (manifest.composedPath !== undefined && manifest.composedDurationSeconds !== undefined) {
      const checked = await editor.probe(manifest.composedPath, signal)
      if (Math.abs(checked.durationSeconds - manifest.composedDurationSeconds) > 0.25) throw new VideoProjectError('INVALID_RECORD', '保留的本地成片时长已变化，请检查文件；未重新提交生成任务。')
      result = { path: manifest.composedPath, durationSeconds: manifest.composedDurationSeconds }
    } else {
      result = await editor.compose({
        clips: manifest.segments.map(segment => ({ path: savedPath(segment) })), outputPath: join(manifest.outputDirectory, `final-${randomUUID()}.mp4`),
        totalDurationSeconds: manifest.input.totalDurationSeconds, signal,
        onProgress: (progress) => { job.updateProgress(progress.stage === 'normalizing' ? `整理片段 ${String(progress.completedClips)}/${String(progress.totalClips)}` : progress.stage === 'assembling' ? '拼接并剪辑视频' : '校验最终视频') },
      })
      if (manifest.publicationDirectory !== undefined) {
        manifest.composedPath = result.path
        manifest.composedDurationSeconds = result.durationSeconds
        await persist(options, manifest)
      }
    }
    manifest.finalPath = await publishVideoOutput(options, result.path, manifest.publicationDirectory, signal, manifest.origin)
    manifest.finalDurationSeconds = result.durationSeconds
    manifest.status = 'completed'
    await persist(options, manifest)
    await options.saved?.(manifest, undefined, signal)
    const summary = JSON.stringify({ status: 'succeeded', project_id: manifest.id, final_path: manifest.finalPath, duration_seconds: result.durationSeconds, clip_paths: manifest.segments.map(segment => segment.publishedPath ?? savedPath(segment)), message: '视频已实际保存。请调用 present 展示 final_path，并在回复中提供可点击的产物链接。' })
    job.append(`${summary}\n`)
    return { status: 'completed', result: summary }
  } catch (error) {
    manifest.status = signal.aborted ? 'cancelled' : 'failed'
    const reported = videoProjectFailure(error)
    manifest.failureCode = signal.aborted ? 'CANCELLED' : reported.code
    const message = signal.aborted ? '视频项目已停止，已保存的片段保留。' : reported.message
    const warning = upstreamMayContinue ? ' 已提交的上游任务无法由本地取消，可能继续运行并计费。' : ''
    try { await persist(options, manifest) }
    catch (storageError) {
      // Storage failure is independently reported; its raw path/error is not model-visible.
      void storageError
      job.append('项目状态保存失败；已停止后续提交。最后一次提交可能未记录，请先在后台核对任务，勿直接重试。\n', { channel: 'stderr' })
      return { status: signal.aborted ? 'killed' : 'failed', detail: 'PROJECT_STORAGE_FAILED', result: JSON.stringify({ status: 'failed', project_id: manifest.id, code: 'PROJECT_STORAGE_FAILED', message: `项目记录保存失败。${warning}`, clip_paths: manifest.segments.flatMap(segment => segment.path === undefined ? [] : [segment.publishedPath ?? segment.path]) }) }
    }
    const result = JSON.stringify({ status: signal.aborted ? 'cancelled' : 'failed', project_id: manifest.id, code: manifest.failureCode, message: message + warning, clip_paths: manifest.segments.flatMap(segment => segment.path === undefined ? [] : [segment.publishedPath ?? segment.path]), task_ids: manifest.segments.flatMap(segment => segment.taskId === undefined ? [] : [segment.taskId]) })
    job.append(`${result}\n`, { channel: 'stderr' })
    return { status: signal.aborted ? 'killed' : 'failed', detail: manifest.failureCode, result }
  }
}
