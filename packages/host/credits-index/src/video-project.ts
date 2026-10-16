/** Durable, account-bound multi-clip generation and local composition. @module */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import * as nativePaths from 'node:path'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { VideoEditError, type VideoEditor } from './video-edit.ts'
import { VideoRelayError } from './video-project-provider.ts'
import type { VideoProjectIdentity, VideoProjectInput, VideoProjectOptions, VideoProjectProvider, VideoProjectRequest, VideoRequestValue } from './video-project-types.ts'

/** Complete private-record parser limit, including prompt and per-clip metadata. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024

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
  /** Real local file, published only after a successful probe. */
  path?: string
}

/** Versioned private project state, never used as an in-memory jobs substitute. */
export interface VideoProjectManifest {
  /** Private-record parser version. */
  version: 1
  /** Immutable project identifier. */
  id: VideoProjectId
  /** Agent session owning this record. */
  ownerSessionId: string
  /** Absolute workspace owning source files and the final result. */
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
  /** Updated after every atomic state replacement. */
  updatedAt: string
  /** Set only after composition and output probing succeed. */
  finalPath?: string
  /** Validated resulting duration, not a requested duration reported as success. */
  finalDurationSeconds?: number
  /** Stable failure for a stopped operation. */
  failureCode?: string
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
  if (input.prompt.trim() === '' || input.prompt.length > 7000) throw new VideoProjectError('INVALID_PROMPT', '请提供 1 至 7000 字符的视频说明。')
  if (!Number.isSafeInteger(input.totalDurationSeconds) || input.totalDurationSeconds < 1 || input.totalDurationSeconds > maxTotalSeconds) {
    throw new VideoProjectError('INVALID_DURATION', `视频总时长须为 1 至 ${String(maxTotalSeconds)} 秒的整数。`)
  }
  if (input.shotPrompts?.some(prompt => prompt.trim() === '' || prompt.length > 7000)) throw new VideoProjectError('INVALID_SHOTS', '每个分镜说明须为 1 至 7000 字符。')
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
  const optionalInput = Object.fromEntries(['model', 'resolution', 'ratio'].flatMap(key => input[key] === undefined ? [] : [[key, text(input, key)]]))
  const parsedInput: VideoProjectInput = {
    prompt: text(input, 'prompt'), totalDurationSeconds: positive(input, 'totalDurationSeconds'), ...optionalInput,
    ...input.shotPrompts === undefined ? {} : { shotPrompts: strings(input, 'shotPrompts') },
    ...input.frameImages === undefined ? {} : { frameImages: strings(input, 'frameImages') },
    ...input.referenceImages === undefined ? {} : { referenceImages: strings(input, 'referenceImages') },
    ...input.referenceVideos === undefined ? {} : { referenceVideos: strings(input, 'referenceVideos') },
  }
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
    }
  })
  if (segments.length === 0 || segments.some((segment, index) => segment.index !== index + 1 || (segment.status === 'running' && segment.taskId === undefined) || (segment.status === 'saved' && segment.path === undefined))) throw new VideoProjectError('INVALID_RECORD', '视频片段记录不完整，已停止操作。')
  return {
    version: 1, id: projectId(text(source, 'id')), ownerSessionId: text(source, 'ownerSessionId'), workspaceRoot: text(source, 'workspaceRoot'),
    identity: { accountId: text(identity, 'accountId'), sessionFingerprint: text(identity, 'sessionFingerprint') }, input: parsedInput,
    model: text(source, 'model'), status, segments, outputDirectory: text(source, 'outputDirectory'), updatedAt: text(source, 'updatedAt'),
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
 * @returns prepared record containing the exact generation plan and requests.
 */
export async function prepareVideoProject(
  options: VideoProjectOptions, input: VideoProjectInput, ownerSessionId: string, workspaceRoot: string,
  provider: VideoProjectProvider, editor: VideoEditor, signal: AbortSignal,
): Promise<VideoProjectManifest> {
  validateInput(input, options.maxTotalSeconds)
  const id = `vp_${randomUUID()}` as VideoProjectId
  const outputDirectory = join(resolveVideoOutputDirectory(workspaceRoot, options.outputDirectory), id)
  await editor.preflight(signal, outputDirectory)
  await provider.assertCurrent()
  const model = await provider.model(input.model, signal, input.resolution)
  const durations = planVideoDurations(input.totalDurationSeconds, model.durations, options.maxSegments)
  if (input.shotPrompts !== undefined && input.shotPrompts.length !== durations.length) throw new VideoProjectError('SHOT_COUNT_MISMATCH', `该时长需要 ${String(durations.length)} 个分镜，请提供相同数量的分镜说明。`)
  const segments: VideoProjectSegment[] = []
  for (const [index, durationSeconds] of durations.entries()) {
    signal.throwIfAborted()
    const prompt = input.shotPrompts?.[index] ?? `${input.prompt}\n分镜 ${String(index + 1)}/${String(durations.length)}：保持主体、风格、色彩与前后分镜连贯。`
    const request = await provider.build(input, model.id, prompt, durationSeconds, signal)
    segments.push({ index: index + 1, durationSeconds, prompt, request, status: 'pending' })
  }
  const manifest: VideoProjectManifest = {
    version: 1, id, ownerSessionId, workspaceRoot, identity: { ...provider.identity }, input, model: model.id,
    status: 'prepared', segments, outputDirectory, updatedAt: new Date().toISOString(),
  }
  // Reserve all later task/path fields before the first billable request.
  const growthReserve = segments.reduce((size, segment) => size + Buffer.byteLength(JSON.stringify({
    taskId: 't'.repeat(256), path: join(options.stateDirectory, id, 'clips', `clip-${String(segment.index)}-${randomUUID()}.mp4`),
  })), 4096 + Buffer.byteLength(JSON.stringify({ finalPath: join(outputDirectory, `final-${randomUUID()}.mp4`) })))
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
  let upstreamMayContinue = false
  try {
    if (manifest.identity.accountId !== provider.identity.accountId) throw new VideoProjectError('PROJECT_ACCESS_DENIED', '该视频项目不属于当前登录账号。')
    if (manifest.segments.some(segment => segment.status === 'unknown' || segment.status === 'submitting' && segment.taskId === undefined)) throw new VideoProjectError('SUBMISSION_UNKNOWN', '有一次视频提交结果未知，可能已计费。请先在后台核对任务，系统不会自动重提。')
    if (manifest.segments.some(segment => segment.status === 'failed')) throw new VideoProjectError('PROVIDER_TASK_FAILED', '项目中有失败的上游任务，已生成片段保留；请使用 edit_video 编辑已保存片段，或明确创建新项目。')
    await editor.preflight(signal, manifest.outputDirectory)
    manifest.identity = { ...provider.identity }
    manifest.status = 'running'
    delete manifest.failureCode
    await persist(options, manifest)
    for (const segment of manifest.segments) {
      signal.throwIfAborted()
      if (segment.status === 'saved') {
        await editor.probe(savedPath(segment), signal)
        continue
      }
      job.updateProgress(`生成分镜 ${String(segment.index)}/${String(manifest.segments.length)}`)
      const clipSignal = AbortSignal.any([signal, AbortSignal.timeout(options.taskTimeoutMs)])
      if (segment.taskId === undefined) {
        await provider.assertCurrent()
        clipSignal.throwIfAborted()
        segment.status = 'submitting'
        await persist(options, manifest)
        upstreamMayContinue = true
        let task: { taskId: string }
        try { task = await provider.submit(segment.request, clipSignal) }
        catch (error) {
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
      job.append(`分镜 ${String(segment.index)} 已保存：${path}\n`)
    }
    signal.throwIfAborted()
    manifest.status = 'editing'
    await persist(options, manifest)
    job.updateProgress('自动剪辑并拼接视频')
    const result = await editor.compose({
      clips: manifest.segments.map(segment => ({ path: savedPath(segment) })), outputPath: join(manifest.outputDirectory, `final-${randomUUID()}.mp4`),
      totalDurationSeconds: manifest.input.totalDurationSeconds, signal,
      onProgress: (progress) => { job.updateProgress(progress.stage === 'normalizing' ? `整理片段 ${String(progress.completedClips)}/${String(progress.totalClips)}` : progress.stage === 'assembling' ? '拼接并剪辑视频' : '校验最终视频') },
    })
    manifest.finalPath = result.path
    manifest.finalDurationSeconds = result.durationSeconds
    manifest.status = 'completed'
    await persist(options, manifest)
    const summary = JSON.stringify({ status: 'succeeded', project_id: manifest.id, final_path: result.path, duration_seconds: result.durationSeconds, clip_paths: manifest.segments.map(segment => savedPath(segment)), message: '视频已实际保存。请调用 present 展示 final_path，并在回复中提供可点击的产物链接。' })
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
      return { status: signal.aborted ? 'killed' : 'failed', detail: 'PROJECT_STORAGE_FAILED', result: JSON.stringify({ status: 'failed', project_id: manifest.id, code: 'PROJECT_STORAGE_FAILED', message: `项目记录保存失败。${warning}`, clip_paths: manifest.segments.flatMap(segment => segment.path === undefined ? [] : [segment.path]) }) }
    }
    const result = JSON.stringify({ status: signal.aborted ? 'cancelled' : 'failed', project_id: manifest.id, code: manifest.failureCode, message: message + warning, clip_paths: manifest.segments.flatMap(segment => segment.path === undefined ? [] : [segment.path]), task_ids: manifest.segments.flatMap(segment => segment.taskId === undefined ? [] : [segment.taskId]) })
    job.append(`${result}\n`, { channel: 'stderr' })
    return { status: signal.aborted ? 'killed' : 'failed', detail: manifest.failureCode, result }
  }
}
