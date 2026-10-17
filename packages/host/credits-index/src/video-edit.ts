/** Workspace-confined hard-cut video editing through the bundled FFmpeg executables. */

import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** Safe failures consumed by the project tool, without raw process output. */
export type VideoEditErrorCode = 'VIDEO_EDIT_RUNTIME_UNAVAILABLE' | 'VIDEO_EDIT_SANDBOX_DENIED'
  | 'VIDEO_EDIT_INVALID_INPUT' | 'VIDEO_EDIT_FAILED' | 'VIDEO_EDIT_CANCELLED' | 'VIDEO_EDIT_OUTPUT_INVALID'

/** An edit failed before publication; input clips remain untouched. */
export class VideoEditError extends Error {
  /**
   * @param code - Stable handling identity.
   * @param message - Safe operation summary, excluding child output.
   * @param options - Original failure retained for trusted diagnostics.
   */
  constructor(readonly code: VideoEditErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VideoEditError'
  }
}

/** One workspace clip and its optional half-open trim interval. */
export interface VideoEditClip {
  readonly path: string
  readonly startSeconds?: number
  readonly endSeconds?: number
}

/** Local assembly progress, containing no private filesystem paths. */
export interface VideoEditProgress {
  readonly stage: 'normalizing' | 'assembling' | 'verifying'
  readonly completedClips: number
  readonly totalClips: number
}

/** A new MP4 destination; existing files are never replaced. */
export interface VideoComposeRequest {
  readonly clips: readonly VideoEditClip[]
  readonly outputPath: string
  readonly totalDurationSeconds?: number
  readonly signal: AbortSignal
  readonly onProgress?: (progress: VideoEditProgress) => void
}

/** Verified, published edit result. */
export interface VideoEditResult {
  readonly path: string
  readonly durationSeconds: number
}

/** Deployment settings and the calling session whose policy owns the edit. */
export interface VideoEditorOptions {
  readonly session: Session
  readonly workspaceRoot: string
  /** Host directory carrying bin/ffmpeg and bin/ffprobe, without a PATH fallback. */
  readonly runtimeRoot?: string
  /** Authorized projects' exact clip directories; never a whole account state directory. */
  readonly ownedMediaRoots?: readonly string[]
  /** Explicit canvas override; absent dimensions follow the first clip. */
  readonly width?: number
  readonly height?: number
  readonly fps: number
  /** One complete edit or inspection budget, including subprocess settlement. */
  readonly timeoutMs: number
}

/** Private editor used by the project tools; it neither generates nor bills for media. */
export interface VideoEditor {
  /**
   * Verify bundled executables, required encoders and writable session policy before generation.
   * @param signal - Cancels preflight and awaits every started child.
   * @param outputDirectory - Exact workspace output tree to test; omission tests the workspace root.
   * @returns Resolves only when local editing and writing into the selected output tree succeed.
   */
  preflight(signal: AbortSignal, outputDirectory?: string): Promise<void>
  /**
   * Inspect an existing workspace video without modifying it.
   * @param path - Workspace input path.
   * @param signal - Cancels inspection and awaits its child.
   * @returns Positive finite container duration.
   */
  probe(path: string, signal: AbortSignal): Promise<{ durationSeconds: number }>
  /**
   * Extract three representative JPEG frames from a real saved clip without generation.
   * @param path - Read-authorized saved video.
   * @param outputDirectory - Workspace-contained private preview directory.
   * @param signal - Cancels every owned extraction process.
   * @returns Verified local frames and exact sampling times.
   */
  preview?(path: string, outputDirectory: string, signal: AbortSignal): Promise<readonly { path: string; timeSeconds: number }[]>
  /**
   * Normalize sizes, frame rates and audio, then hard-cut clips into a new MP4.
   * @param request - Clip order, trims, optional final cut and exclusive destination.
   * @returns Published path and independently probed duration; failures leave originals intact.
   */
  compose(request: VideoComposeRequest): Promise<VideoEditResult>
}

interface ProbedVideo {
  readonly durationSeconds: number
  readonly hasAudio: boolean
  readonly width: number
  readonly height: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseProbe(text: string): ProbedVideo {
  let value: unknown
  try { value = JSON.parse(text) } catch (cause) {
    throw new VideoEditError('VIDEO_EDIT_OUTPUT_INVALID', 'Video inspection returned invalid metadata.', { cause })
  }
  if (!isRecord(value) || !isRecord(value.format) || !Array.isArray(value.streams)) {
    throw new VideoEditError('VIDEO_EDIT_OUTPUT_INVALID', 'Video inspection returned incomplete metadata.')
  }
  const durationSeconds = typeof value.format.duration === 'string' ? Number(value.format.duration) : Number.NaN
  const streams: unknown[] = value.streams
  const video = streams.find(stream => isRecord(stream) && stream.codec_type === 'video')
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0
    || !isRecord(video) || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height)
    || typeof video.width !== 'number' || typeof video.height !== 'number'
    || video.width < 2 || video.height < 2 || video.width > 8192 || video.height > 8192) {
    throw new VideoEditError('VIDEO_EDIT_OUTPUT_INVALID', 'The input has no usable video duration or video stream.')
  }
  return { durationSeconds, width: video.width, height: video.height,
    hasAudio: streams.some(stream => isRecord(stream) && stream.codec_type === 'audio') }
}

/**
 * Bind an editor to the current execution world and session policy. The caller validates deployment settings.
 * @param ctx - Filesystem, subprocess and sandbox capabilities from the active profile.
 * @param options - Session, workspace and explicit normalization settings.
 * @returns An editor with no shell execution, network retrieval or system-PATH fallback.
 */
export function createVideoEditor(ctx: Context, options: VideoEditorOptions): VideoEditor {
  const fs = ctx.get('fs')
  const subprocess = ctx.get('subprocess')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (fs === undefined || subprocess === undefined || sandboxPolicy === undefined) {
    throw new VideoEditError('VIDEO_EDIT_RUNTIME_UNAVAILABLE', 'The workspace filesystem, process or video policy service is unavailable.')
  }
  const runtimeRoot = options.runtimeRoot ?? process.env.DSH_VIDEO_RUNTIME_ROOT
  const policy = (): SandboxExecutionPolicy => sandboxPolicy.resolve({ session: options.session })
  const withBudget = (signal: AbortSignal): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
  const executable = async (name: 'ffmpeg' | 'ffprobe', signal: AbortSignal): Promise<string> => {
    if (runtimeRoot === undefined || !isAbsolute(runtimeRoot)) {
      throw new VideoEditError('VIDEO_EDIT_RUNTIME_UNAVAILABLE', 'The bundled video editor is unavailable. Prepare or reinstall the desktop runtime.')
    }
    const path = fs.processPathFromHostPath(join(runtimeRoot, 'bin', process.platform === 'win32' ? `${name}.exe` : name))
    if (path === undefined) throw new VideoEditError('VIDEO_EDIT_RUNTIME_UNAVAILABLE', 'The bundled editor is not available in this workspace execution environment.')
    try { return await subprocess.resolveExecutable(path, {}, signal) } catch (cause) {
      throw new VideoEditError('VIDEO_EDIT_RUNTIME_UNAVAILABLE', 'A bundled video executable is missing or cannot run. Prepare or reinstall the desktop runtime.', { cause })
    }
  }
  const checkedPath = async (path: string, signal: AbortSignal, exists: boolean): Promise<string> => {
    const root = await fs.resolve(options.workspaceRoot, { signal })
    const target = await fs.resolve(path, { cwd: options.workspaceRoot, signal })
    if (!fs.contains(root, target)) {
      if (!exists) throw new VideoEditError('VIDEO_EDIT_INVALID_INPUT', 'Video files must stay inside the current workspace.')
      const canonical = fs.processPath(target)
      const original = resolve(options.workspaceRoot, path)
      let ownedRoot: string | undefined
      for (const candidate of options.ownedMediaRoots ?? []) {
        const owned = await fs.resolve(candidate, { signal })
        const ownedRelative = relative(candidate, original)
        if (fs.contains(owned, target) && canonical !== fs.processPath(owned) && ownedRelative !== '..'
          && !ownedRelative.startsWith(`..${sep}`) && !isAbsolute(ownedRelative)) {
          ownedRoot = candidate
          break
        }
      }
      if (ownedRoot === undefined) throw new VideoEditError('VIDEO_EDIT_INVALID_INPUT', 'The generated clip is outside its authorized project directories.')
      let current = ownedRoot
      for (const component of ['', ...relative(ownedRoot, original).split(sep)]) {
        current = component === '' ? current : join(current, component)
        const info = await fs.lstat(current, undefined, signal)
        if (info === undefined || info.type === 'symlink') {
          throw new VideoEditError('VIDEO_EDIT_INVALID_INPUT', 'Generated clips cannot use filesystem links.')
        }
      }
    }
    const info = await fs.stat(target, signal)
    if (exists ? info?.type !== 'file' : info !== undefined) {
      throw new VideoEditError('VIDEO_EDIT_INVALID_INPUT', exists ? 'A video clip is missing or is not a regular file.' : 'The output already exists. Choose a new MP4 filename.')
    }
    return fs.processPath(target)
  }
  const writable = (): SandboxExecutionPolicy => {
    const current = policy()
    if (current.mode === 'read-only') throw new VideoEditError('VIDEO_EDIT_SANDBOX_DENIED', 'Video editing needs permission to write in this workspace.')
    return current
  }
  const run = async (argv: readonly string[], current: SandboxExecutionPolicy, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    let command: readonly string[] = argv
    if (current.mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox')
      if (sandbox === undefined) throw new VideoEditError('VIDEO_EDIT_SANDBOX_DENIED', 'The workspace process sandbox service is unavailable.')
      try { command = (await sandbox.confine(argv, { ...current, mode: current.mode }, signal)).argv } catch (cause) {
        throw new VideoEditError('VIDEO_EDIT_SANDBOX_DENIED', 'The workspace sandbox could not start the video operation.', { cause })
      }
    }
    let child: SubprocessHandle | undefined
    let outcome: SubprocessOutcome
    try {
      child = subprocess.spawn({ argv: command, cwd: options.workspaceRoot, env: {}, signal, graceMs: 2_000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 131_072 }, stderr: { maxBytes: 65_536 } } })
      // The provider's abort procedure kills its managed process range; done observes its settlement.
      outcome = await child.done
      if (signal.aborted || outcome.exitCode !== 0 || outcome.signal !== null) child.terminate()
      await child.waitForExit()
    } catch (cause) {
      if (child !== undefined) {
        child.terminate()
        await child.waitForExit()
      }
      if (signal.aborted) throw new VideoEditError('VIDEO_EDIT_CANCELLED', 'Video editing stopped before publication.', { cause })
      throw new VideoEditError('VIDEO_EDIT_FAILED', 'The local video process could not finish. Original clips are still available.', { cause })
    }
    if (signal.aborted) throw new VideoEditError('VIDEO_EDIT_CANCELLED', 'Video editing stopped before publication.', { cause: signal.reason })
    if (outcome.exitCode !== 0 || outcome.signal !== null) throw new VideoEditError('VIDEO_EDIT_FAILED', 'The local video operation failed. Original clips are still available.')
    const output = child.collected.stdout?.readFrom(0)
    if (output === undefined || output.lossy) throw new VideoEditError('VIDEO_EDIT_OUTPUT_INVALID', 'Video inspection exceeded its output limit.')
    return output.text
  }
  const inspect = async (path: string, signal: AbortSignal): Promise<ProbedVideo> => parseProbe(await run([
    await executable('ffprobe', signal), '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', path,
  ], policy(), signal))
  const preflight = async (signal: AbortSignal, outputDirectory?: string): Promise<void> => {
    const current = writable()
    const root = await fs.resolve(options.workspaceRoot, { signal })
    if (current.mode === 'workspace-write' && !fs.contains(await fs.resolve(current.workspaceRoot, { signal }), root)) {
      throw new VideoEditError('VIDEO_EDIT_SANDBOX_DENIED', 'The current workspace is outside the session’s writable directory.')
    }
    const checkPath = await checkedPath(join(outputDirectory ?? fs.processPath(root), `.video-preflight-${randomUUID()}`, 'check.mp4'), signal, false)
    const scratch = dirname(checkPath)
    const binary = await executable('ffmpeg', signal)
    const version = await run([binary, '-version'], current, signal)
    const probeVersion = await run([await executable('ffprobe', signal), '-version'], current, signal)
    if (!version.startsWith('ffmpeg version ') || !probeVersion.startsWith('ffprobe version ')) {
      throw new VideoEditError('VIDEO_EDIT_RUNTIME_UNAVAILABLE', 'The bundled video executables returned invalid version information.')
    }
    try {
      const marker = await checkedPath(join(scratch, 'write-check.txt'), signal, false)
      const markerTarget = await fs.resolve(marker, { signal })
      await fs.writeText(markerTarget, '', { kind: 'createIfAbsent' }, signal, current)
      await run([binary, '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=10:d=0.1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', '0.1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', checkPath], current, signal)
    } catch (cause) {
      if (cause instanceof VideoEditError && cause.code === 'VIDEO_EDIT_CANCELLED') throw cause
      throw new VideoEditError('VIDEO_EDIT_RUNTIME_UNAVAILABLE', 'The bundled editor cannot encode H.264/AAC in the selected output directory. Check runtime installation, output permissions and available disk space.', { cause })
    } finally {
      try { await rm(scratch, { recursive: true, force: true }) } catch (error) {
        ctx.logger('video-edit').warn('Video preflight temporary files could not be removed.', error)
      }
    }
  }
  return {
    preflight: (signal, outputDirectory) => preflight(withBudget(signal), outputDirectory),
    async probe(path, signal) { return inspect(await checkedPath(path, signal, true), withBudget(signal)) },
    async preview(path, outputDirectory, cancellation) {
      const signal = withBudget(cancellation)
      const current = writable()
      const input = await checkedPath(path, signal, true)
      const info = await inspect(input, signal)
      const parent = dirname(await checkedPath(join(outputDirectory, `preview-${randomUUID()}.jpg`), signal, false))
      await mkdir(parent, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(parent, 'frames-'))
      try {
        const frames: { path: string; timeSeconds: number }[] = []
        for (const [index, timeSeconds] of [0, info.durationSeconds / 2, Math.max(0, info.durationSeconds - 0.25)].entries()) {
          const destination = join(directory, `frame-${String(index)}.jpg`)
          await run([await executable('ffmpeg', signal), '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
            '-protocol_whitelist', 'file,pipe', '-ss', String(timeSeconds), '-i', input, '-frames:v', '1',
            '-vf', 'scale=480:-2:force_original_aspect_ratio=decrease', '-q:v', '3', destination], current, signal)
          const frame = await fs.resolve(destination, { signal })
          const bytes = await fs.readBytes(frame, signal, 4 * 1024 * 1024)
          if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new VideoEditError('VIDEO_EDIT_OUTPUT_INVALID', 'The extracted preview frame is not a complete JPEG.')
          frames.push({ path: destination, timeSeconds })
        }
        return frames
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    },
    async compose(request) {
      const signal = withBudget(request.signal)
      const current = writable()
      if (request.clips.length === 0 || request.clips.length > 32 || !request.outputPath.toLowerCase().endsWith('.mp4')) {
        throw new VideoEditError('VIDEO_EDIT_INVALID_INPUT', 'Provide one to 32 clips and a new MP4 output filename.')
      }
      if (request.totalDurationSeconds !== undefined
        && (!Number.isFinite(request.totalDurationSeconds) || request.totalDurationSeconds <= 0)) {
        throw new VideoEditError('VIDEO_EDIT_INVALID_INPUT', 'The final duration must be a positive number of seconds.')
      }
      await preflight(signal, dirname(request.outputPath))
      const output = await checkedPath(request.outputPath, signal, false)
      const clips: { path: string; start: number; duration: number; hasAudio: boolean; width: number; height: number }[] = []
      for (const clip of request.clips) {
        const path = await checkedPath(clip.path, signal, true)
        const info = await inspect(path, signal)
        const start = clip.startSeconds ?? 0
        const end = clip.endSeconds ?? info.durationSeconds
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > info.durationSeconds + 1 / options.fps) {
          throw new VideoEditError('VIDEO_EDIT_INVALID_INPUT', 'A clip trim falls outside its available duration.')
        }
        clips.push({ path, start, duration: Math.min(end, info.durationSeconds) - start,
          hasAudio: info.hasAudio, width: info.width, height: info.height })
      }
      const available = clips.reduce((sum, clip) => sum + clip.duration, 0)
      const duration = request.totalDurationSeconds ?? available
      if (duration > available + 1 / options.fps) throw new VideoEditError('VIDEO_EDIT_INVALID_INPUT', 'The clips do not contain enough video for the requested final duration.')
      const firstClip = clips[0]
      if (firstClip === undefined) throw new VideoEditError('VIDEO_EDIT_INVALID_INPUT', 'No clips are available for editing.')
      const width = Math.floor((options.width ?? firstClip.width) / 2) * 2
      const height = Math.floor((options.height ?? firstClip.height) / 2) * 2
      // Canonical identities above constrain these trusted mutations to the writable workspace.
      await mkdir(dirname(output), { recursive: true, mode: 0o700 })
      const temporary = await mkdtemp(join(dirname(output), '.video-edit-'))
      try {
        const binary = await executable('ffmpeg', signal)
        const normalized: string[] = []
        let remaining = duration
        for (const [index, clip] of clips.entries()) {
          if (remaining <= 0) break
          const segmentDuration = Math.min(clip.duration, remaining)
          const destination = join(temporary, `clip-${String(index)}.mp4`)
          const filter = `[0:v:0]scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease,pad=${String(width)}:${String(height)}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${String(options.fps)},format=yuv420p[v];[${clip.hasAudio ? '0:a:0' : '1:a:0'}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[a]`
          await run([binary, '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe',
            '-ss', String(clip.start), '-i', clip.path,
            ...clip.hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'],
            '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-t', String(segmentDuration),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', destination], current, signal)
          normalized.push(destination)
          remaining -= segmentDuration
          request.onProgress?.({ stage: 'normalizing', completedClips: normalized.length, totalClips: clips.length })
        }
        request.onProgress?.({ stage: 'assembling', completedClips: normalized.length, totalClips: clips.length })
        const final = join(temporary, 'final.mp4')
        const inputs = normalized.flatMap(path => ['-i', path])
        const concat = `${normalized.map((_path, index) => `[${String(index)}:v:0][${String(index)}:a:0]`).join('')}concat=n=${String(normalized.length)}:v=1:a=1[v][a]`
        await run([binary, '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', ...inputs,
          '-filter_complex', concat, '-map', '[v]', '-map', '[a]', '-t', String(duration),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final], current, signal)
        request.onProgress?.({ stage: 'verifying', completedClips: normalized.length, totalClips: clips.length })
        const result = await inspect(final, signal)
        if (Math.abs(result.durationSeconds - duration) > Math.max(0.1, 2 / options.fps)) {
          throw new VideoEditError('VIDEO_EDIT_OUTPUT_INVALID', 'The assembled video did not match the requested duration. Original clips are still available.')
        }
        signal.throwIfAborted()
        await checkedPath(output, signal, false)
        // A same-volume hard link publishes atomically and rejects a destination created concurrently.
        await link(final, output)
        return { path: output, durationSeconds: result.durationSeconds }
      } finally {
        try { await rm(temporary, { recursive: true, force: true }) } catch (error) {
          ctx.logger('video-edit').warn('Temporary video files could not be removed; original clips and any published output are retained.', error)
        }
      }
    },
  }
}
