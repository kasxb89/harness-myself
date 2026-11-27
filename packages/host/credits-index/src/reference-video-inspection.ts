/** Workspace-authorized reference evidence, using the configured local editor without generation. @module */
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { VideoEditError } from './video-edit.ts'
import { VideoProjectError, videoProjectFailure } from './video-project.ts'
import type { VideoProjectOptions } from './video-project-types.ts'

interface ReferenceInspection {
  status: 'inspected' | 'failed' | 'cancelled'
  message: string
  source_path?: string
  duration_seconds?: number
  frames?: { path: string; time_seconds: number }[]
  analysis_limits?: string
  code?: string
}

const LIMITS = '仅提取开头、中点与接近结尾的三个静态画面；抽样帧不代表看完全部动作、听过音频，不能据此核实对白、节奏、音效或口型同步。请通过现有图片读取工具查看这些实际帧，并区分观察、推断和未知。'

/**
 * Register synchronous reference inspection and await all owned work on disposal.
 * @param ctx - Tool and workspace filesystem providers owned by the credits plugin.
 * @param options - Existing configured editor and explicit private directories excluded from inspection.
 */
export function registerReferenceVideoInspection(ctx: Context, options: VideoProjectOptions): void {
  const lifetime = new AbortController(), pending = new Set<Promise<ReferenceInspection>>()
  ctx.effect(() => async () => { lifetime.abort(); await Promise.allSettled([...pending]) }, 'reference video inspections')
  const inspect = async (path: string, exec: ToolRunContext): Promise<ReferenceInspection> => {
    const signal = AbortSignal.any([exec.signal, lifetime.signal])
    try {
      signal.throwIfAborted()
      const session = exec.agent?.session, workspaceRoot = session?.header.cwd
      if (session === undefined || workspaceRoot === undefined || !isAbsolute(workspaceRoot)) {
        throw new VideoProjectError('WORKSPACE_REQUIRED', '请先选择工作区，并在工作区聊天中分析参考视频。')
      }
      const fs = ctx.get('fs')
      if (fs === undefined) throw new VideoProjectError('VIDEO_EDIT_SERVICE_UNAVAILABLE', '工作区文件服务尚未准备好，尚未读取参考视频。')
      const root = await fs.resolve(workspaceRoot, { signal }), lexical = resolve(workspaceRoot, path)
      const local = relative(workspaceRoot, lexical)
      const source = await fs.resolve(path, { cwd: workspaceRoot, signal })
      if (path.trim() === '' || local === '' || local === '..' || local.startsWith(`..${sep}`)
        || isAbsolute(local) || !fs.contains(root, source)) {
        throw new VideoProjectError('REFERENCE_VIDEO_ACCESS_DENIED', '仅能分析当前工作区内已授权的视频。聊天附件请先通过现有文件工具正常复制到工作区。')
      }
      for (const denied of [options.stateDirectory, ...options.referenceInspectionDeniedRoots ?? []]) {
        if (fs.contains(await fs.resolve(denied, { signal }), source)) {
          throw new VideoProjectError('REFERENCE_VIDEO_ACCESS_DENIED', '不能将应用私有媒体当作参考素材读取。请使用当前工作区中明确授权的原视频。')
        }
      }
      let current = workspaceRoot
      for (const part of local.split(sep)) {
        current = join(current, part)
        const info = await fs.lstat(current, undefined, signal)
        if (info === undefined || info.type === 'symlink') {
          throw new VideoProjectError('REFERENCE_VIDEO_ACCESS_DENIED', '参考视频路径必须存在且不能经过文件系统链接。')
        }
      }
      if ((await fs.stat(source, signal))?.type !== 'file') {
        throw new VideoProjectError('REFERENCE_VIDEO_INVALID', '参考视频必须是工作区中的普通文件。')
      }
      const sourcePath = fs.processPath(source), editor = options.editor(workspaceRoot, session)
      if (editor.preview === undefined) throw new VideoProjectError('REFERENCE_VIDEO_PREVIEW_UNAVAILABLE', '本地参考视频抽帧尚未准备好，尚未分析画面。')
      let outputDirectory = workspaceRoot
      for (const part of ['.yunshu-creative', 'reference-inspections']) {
        outputDirectory = join(outputDirectory, part)
        if ((await fs.lstat(outputDirectory, undefined, signal))?.type === 'symlink') {
          throw new VideoProjectError('REFERENCE_VIDEO_ACCESS_DENIED', '参考视频抽帧目录不能经过文件系统链接。')
        }
      }
      const { durationSeconds } = await editor.probe(sourcePath, signal)
      const frames = await editor.preview(sourcePath, outputDirectory, signal)
      signal.throwIfAborted()
      return { status: 'inspected', source_path: sourcePath, duration_seconds: durationSeconds,
        frames: frames.map(frame => ({ path: frame.path, time_seconds: frame.timeSeconds })), analysis_limits: LIMITS,
        message: '参考视频的真实时长与抽样帧已读取，原视频未修改，未上传、生成或扣费。请查看返回帧后再分析。' }
    } catch (error) {
      if (signal.aborted || error instanceof VideoEditError && error.code === 'VIDEO_EDIT_CANCELLED') {
        return { status: 'cancelled', code: 'REFERENCE_VIDEO_CANCELLED', message: '参考视频分析已停止，原视频保留，未生成或扣费。' }
      }
      return { status: 'failed', ...error instanceof VideoProjectError || error instanceof VideoEditError
        ? videoProjectFailure(error) : { code: 'REFERENCE_VIDEO_UNAVAILABLE', message: '参考视频尚未完成读取或抽帧，请检查素材和本地视频工具；原视频保留，未生成或扣费。' } }
    }
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'inspect_reference_video',
    description: 'Inspect a real authorized reference video inside the current workspace without uploading, generating or spending credits. Probe its actual duration and extract three static frames with exact sampling times through the configured local video runtime. Read/view the returned frame paths before describing their visual evidence. Sampling does not watch all motion or listen to audio, and cannot verify dialogue, music, pacing or lip synchronization. Analysis-only requests must stop at evidence and a saved creation plan, without quoting, uploading or generating. Load yunshu-reference-replica for reference-image/video reconstruction and motion transfer. Input cannot be an attachment store path, private application media, URL or arbitrary host path; first copy only a current read-authorized chat attachment into this workspace using existing file tools. Original input is never overwritten.',
    parameters: { path: { type: 'string', required: true, description: 'Existing read-authorized workspace video path, including a normally copied current-chat attachment.' } },
    output: { schema: { type: 'object', properties: {
      status: { type: 'string', required: true }, message: { type: 'string', required: true }, code: { type: 'string' },
      source_path: { type: 'string' }, duration_seconds: { type: 'number' }, analysis_limits: { type: 'string' },
      frames: { type: 'array', items: { type: 'object', properties: {
        path: { type: 'string', required: true }, time_seconds: { type: 'number', required: true },
      }, additionalProperties: false } },
    }, additionalProperties: false }, render: (_args: unknown, value: ReferenceInspection) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    presentCall: args => ({ card: 'generic', kind: 'read', title: '分析参考视频',
      content: [{ type: 'text', text: args.path }], locations: [{ path: args.path }] }),
    presentResult: (_args, result) => ({ card: 'generic', title: '参考视频证据', content: result.content }),
    async execute(args, exec): Promise<ReferenceInspection> {
      const work = inspect(args.path, exec)
      pending.add(work)
      try { return await work } finally { pending.delete(work) }
    },
  })), 'reference video inspection tool')
}
