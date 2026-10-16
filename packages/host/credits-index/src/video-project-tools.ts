/** Model tools for durable long-video generation and sandboxed local editing. @module */

import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import { prepareVideoProject, readVideoProject, resolveVideoOutputDirectory, runVideoProject, videoProjectFailure, VideoProjectError } from './video-project.ts'
import type { VideoProjectManifest } from './video-project.ts'
import type { VideoProjectInput, VideoProjectOptions } from './video-project-types.ts'

declare module '@deepseek-ai/dsh-jobs/view' {
  interface JobKindMap {
    /** Account-billed ordered video generation followed by local composition. */
    'video-project': 'video-project'
    /** Local existing-clip reordering and trimming, without new generation. */
    'video-edit': 'video-edit'
  }
}

/** Canonical output shared by generation, durable status, and local edit calls. */
interface VideoToolResult {
  status: string
  message: string
  project_id?: string
  job_id?: string
  code?: string
  plan_seconds?: number[]
  clip_paths?: string[]
  task_ids?: string[]
  final_path?: string
  duration_seconds?: number
}

/** All fields are programmatically available; prose never carries the only job id. */
const output = {
  schema: {
    type: 'object', properties: {
      status: { type: 'string', required: true }, message: { type: 'string', required: true },
      project_id: { type: 'string' }, job_id: { type: 'string' }, code: { type: 'string' },
      plan_seconds: { type: 'array', items: { type: 'number' } }, clip_paths: { type: 'array', items: { type: 'string' } },
      task_ids: { type: 'array', items: { type: 'string' } }, final_path: { type: 'string' }, duration_seconds: { type: 'number' },
    }, additionalProperties: false,
  },
  render: (_args: unknown, value: VideoToolResult) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/** Preserve only safe declared failures; infrastructure messages may contain secrets. */
function failure(error: unknown): VideoToolResult {
  return { status: 'failed', ...videoProjectFailure(error) }
}

/** Bind an execution to its existing workspace and session rather than the host cwd. */
function caller(exec: ToolRunContext): { workspaceRoot: string; session: Session } {
  if (exec.agent === undefined) throw new VideoProjectError('AGENT_REQUIRED', '请在工作区聊天中创建或编辑视频。')
  const session = exec.agent.session
  const workspaceRoot = session.header.cwd
  if (workspaceRoot === undefined || !isAbsolute(workspaceRoot)) throw new VideoProjectError('WORKSPACE_REQUIRED', '请先选择工作区文件夹，再创建或编辑视频。')
  return { workspaceRoot, session }
}

/** Project only replayable, committed durable facts to the model. */
function statusOf(manifest: VideoProjectManifest, running: boolean): VideoToolResult {
  return {
    status: running ? 'running' : manifest.status === 'running' || manifest.status === 'editing' ? 'interrupted' : manifest.status,
    project_id: manifest.id, plan_seconds: manifest.segments.map(segment => segment.durationSeconds),
    clip_paths: manifest.segments.flatMap(segment => segment.path === undefined ? [] : [segment.path]),
    task_ids: manifest.segments.flatMap(segment => segment.taskId === undefined ? [] : [segment.taskId]),
    ...manifest.finalPath === undefined ? {} : { final_path: manifest.finalPath },
    ...manifest.finalDurationSeconds === undefined ? {} : { duration_seconds: manifest.finalDurationSeconds },
    ...manifest.failureCode === undefined ? {} : { code: manifest.failureCode },
    message: running ? '项目正在后台处理，可用 job_output 查看进度，job_kill 停止本地工作和后续提交。'
      : manifest.status === 'completed' ? '视频已保存，请调用 present 展示 final_path，并在回复中提供产物链接。'
        : '这是保留的项目记录；重启不会自动恢复后台任务。可显式调用 resume_video_project 读取已知任务并继续；未知提交绝不会自动重提。',
  }
}

/**
 * Register generation, durable status/resume, and local edit tools with owned background jobs.
 * @param ctx - credits plugin context with tools and an optional configured jobs provider.
 * @param options - validated deployment limits, account callbacks, and local editor factory.
 */
export function registerVideoProjectTools(ctx: Context, options: VideoProjectOptions): void {
  const lifetime = new AbortController()
  const activeProjects = new Set<string>()
  const operations = new Set<{ abort: AbortController; done: Promise<JobOutcome> }>()
  ctx.effect(() => async () => {
    lifetime.abort()
    for (const operation of operations) operation.abort.abort()
    await Promise.all([...operations].map(operation => operation.done))
  }, 'video project operations')

  /** Allocate the cancellation lifetime only after jobs admission succeeds. */
  function start(exec: ToolRunContext, kind: 'video-project' | 'video-edit', label: string, run: (job: JobHandle, signal: AbortSignal) => Promise<JobOutcome>, project?: string): string {
    exec.signal.throwIfAborted()
    lifetime.signal.throwIfAborted()
    const agent = exec.agent
    if (agent === undefined) throw new VideoProjectError('AGENT_REQUIRED', '请在工作区聊天中操作视频。')
    const jobs = ctx.get('jobs')
    if (jobs === undefined) throw new VideoProjectError('JOBS_UNAVAILABLE', '当前工作区没有启用后台任务管理，暂不能生成长视频。')
    if (project !== undefined && activeProjects.has(project)) throw new VideoProjectError('PROJECT_ALREADY_RUNNING', '该项目已经在后台运行，请查看已有任务。')
    if (project !== undefined) activeProjects.add(project)
    try {
      return jobs.start({
        kind, label, owner: agent.id,
        run: (job) => {
          const abort = new AbortController()
          const done = run(job, abort.signal).catch((error: unknown): JobOutcome => ({ status: 'failed', detail: 'VIDEO_OPERATION_FAILED', result: JSON.stringify(failure(error)) }))
          const operation = { abort, done }
          operations.add(operation)
          void done.then(() => {
            operations.delete(operation)
            if (project !== undefined) activeProjects.delete(project)
          })
          return { cancel: () =>{  abort.abort() }, done }
        },
      })
    } catch (error) {
      if (project !== undefined) activeProjects.delete(project)
      throw error
    }
  }

  ctx.tools.register(defineTool({
    name: 'generate_video_project',
    description: 'Create a finished video longer than one model clip from a natural-language brief. For requests such as a 40-second video, plan the fewest supported clips (for a 15-second limit: 15+15+10, or three 15-second clips trimmed to 40), generate them in order using the signed-in account, then automatically normalize, trim, and join them locally. All local tools and every request are checked before billing. Returns a background job_id and durable project_id; read job_output for progress and call present on the completed final_path. Never claim completion before the job reports a saved final_path. Already submitted provider tasks may continue billing after local cancellation. If a current user-supplied chat attachment is outside the workspace, first copy that read-authorized attachment into this workspace with the existing file tools, then pass the copied path; do not copy unrelated files.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The complete video brief, visual continuity, story, and desired editing.' },
      total_duration_seconds: { type: 'number', required: true, description: 'Desired final length in whole seconds; this may exceed the model single-clip limit.' },
      shot_prompts: { type: 'array', items: { type: 'string' }, description: 'Optional exact shot briefs, one per planned clip; omit to use the main brief with ordered continuity instructions.' },
      model: { type: 'string', description: 'Only specify a model when requested; otherwise use an available account model.' },
      resolution: { type: 'string' }, ratio: { type: 'string' },
      frame_images: { type: 'array', items: { type: 'string' }, description: 'Existing uploaded ma_ first/last frame ids or workspace image paths. For a user-supplied chat attachment outside the workspace, first copy the read-authorized attachment into the workspace with existing file tools and pass its copied path.' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Existing uploaded ma_ subject/style image ids or workspace image paths. For a user-supplied chat attachment outside the workspace, first copy the read-authorized attachment into the workspace with existing file tools and pass its copied path.' },
      reference_videos: { type: 'array', items: { type: 'string' }, description: 'Existing uploaded ma_ video reference ids or workspace video paths. For a user-supplied chat attachment outside the workspace, first copy the read-authorized attachment into the workspace with existing file tools and pass its copied path.' },
    }, output,
    presentCall: args => ({ card: 'generic', title: '生成并剪辑视频', kind: 'edit', content: [{ type: 'text', text: `${String(args.total_duration_seconds)} 秒 · ${args.prompt}` }] }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '视频项目未开始' : '视频项目', content: result.content }),
    async execute(args, exec): Promise<VideoToolResult> {
      try {
        const { workspaceRoot, session } = caller(exec)
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        signal.throwIfAborted()
        const provider = await options.acquireProvider(workspaceRoot, session)
        const editor = options.editor(workspaceRoot, session)
        const input: VideoProjectInput = {
          prompt: args.prompt, totalDurationSeconds: args.total_duration_seconds,
          ...args.shot_prompts === undefined ? {} : { shotPrompts: args.shot_prompts },
          ...args.model === undefined ? {} : { model: args.model },
          ...args.resolution === undefined ? {} : { resolution: args.resolution },
          ...args.ratio === undefined ? {} : { ratio: args.ratio },
          ...args.frame_images === undefined ? {} : { frameImages: args.frame_images },
          ...args.reference_images === undefined ? {} : { referenceImages: args.reference_images },
          ...args.reference_videos === undefined ? {} : { referenceVideos: args.reference_videos },
        }
        const manifest = await prepareVideoProject(options, input, session.id, workspaceRoot, provider, editor, signal)
        const runEditor = options.editor(workspaceRoot, session, [join(options.stateDirectory, manifest.id, 'clips')])
        const jobId = start(exec, 'video-project', `${String(input.totalDurationSeconds)} 秒视频`, (job, signal) => runVideoProject(options, manifest, provider, runEditor, job, signal), manifest.id)
        return { status: 'background', job_id: jobId, project_id: manifest.id, plan_seconds: manifest.segments.map(segment => segment.durationSeconds), message: '视频项目已开始。使用 job_output 查看进度，完成后将 final_path 交给 present 展示；停止本地任务后，已提交的上游任务仍可能继续计费。' }
      } catch (error) { return failure(error) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_project_status',
    description: 'Read a durable video project owned by this account, workspace, and chat. This does not restart generation or spend credits. After an app restart, an interrupted project is a saved record, not a live job. Inspect clip_paths and task_ids before explicitly resuming.',
    parameters: { project_id: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: '查看视频项目', kind: 'read', content: [{ type: 'text', text: args.project_id }] }),
    async execute(args, exec): Promise<VideoToolResult> {
      try {
        const { workspaceRoot, session } = caller(exec)
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        signal.throwIfAborted()
        const provider = await options.acquireProvider(workspaceRoot, session)
        const manifest = await readVideoProject(options, args.project_id, session.id, workspaceRoot, provider.identity)
        return statusOf(manifest, activeProjects.has(manifest.id))
      } catch (error) { return failure(error) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resume_video_project',
    description: 'Explicitly continue a retained project for the same account, workspace, and chat. Reuse saved clips and query already known provider task ids before submitting any remaining never-submitted clips. Refuse unknown submissions, failed provider tasks, and a second live run; never automatically resubmit a charge whose outcome is unknown. Local cancellation cannot cancel already accepted upstream billing.',
    parameters: { project_id: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: '继续视频项目', kind: 'edit', content: [{ type: 'text', text: args.project_id }] }),
    async execute(args, exec): Promise<VideoToolResult> {
      try {
        const { workspaceRoot, session } = caller(exec)
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        signal.throwIfAborted()
        const provider = await options.acquireProvider(workspaceRoot, session)
        const manifest = await readVideoProject(options, args.project_id, session.id, workspaceRoot, provider.identity)
        if (manifest.status === 'completed') return statusOf(manifest, false)
        const editor = options.editor(workspaceRoot, session, [join(options.stateDirectory, manifest.id, 'clips')])
        await editor.preflight(signal, manifest.outputDirectory)
        const jobId = start(exec, 'video-project', `继续 ${String(manifest.input.totalDurationSeconds)} 秒视频`, (job, signal) => runVideoProject(options, manifest, provider, editor, job, signal), manifest.id)
        return { status: 'background', project_id: manifest.id, job_id: jobId, plan_seconds: manifest.segments.map(segment => segment.durationSeconds), message: '已开始读取原任务和已保存片段。使用 job_output 查看结果；未知提交不会重新计费提交。' }
      } catch (error) { return failure(error) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'edit_video',
    description: 'Edit existing local videos without generating new media or spending model credits. Order clips as supplied, optionally trim each start/end in seconds, normalize and concatenate them, and optionally trim the final length. Input files must be readable inside this workspace or an owned generated-video project. Returns a background job_id; wait for the real final_path, then call present and include the artifact link. This performs ordered cuts and joins; it does not synthesize unseen footage, music, subtitles, or effects. If current user-supplied chat attachments are outside the workspace, first copy only those read-authorized attachments into this workspace with existing file tools, then edit the copied paths.',
    parameters: {
      clips: { type: 'array', required: true, items: { type: 'object', properties: { path: { type: 'string', required: true }, start_seconds: { type: 'number' }, end_seconds: { type: 'number' } }, additionalProperties: false }, description: 'Local clip paths in final playback order, with optional per-clip trim positions. Copy current user-supplied, read-authorized chat attachments from outside the workspace into the workspace with existing file tools before passing their copied paths.' },
      total_duration_seconds: { type: 'number', description: 'Optional final duration after assembling clips; cannot exceed the available trimmed footage.' },
    }, output,
    presentCall: args => ({ card: 'generic', title: '剪辑并拼接视频', kind: 'edit', content: [{ type: 'text', text: `${String(args.clips.length)} 个片段` }], locations: args.clips.map(clip => ({ path: clip.path })) }),
    async execute(args, exec): Promise<VideoToolResult> {
      try {
        const { workspaceRoot, session } = caller(exec)
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        signal.throwIfAborted()
        if (args.clips.length < 1 || args.clips.length > options.maxSegments) throw new VideoProjectError('INVALID_CLIP_COUNT', `请选择 1 至 ${String(options.maxSegments)} 个视频片段。`)
        if (args.total_duration_seconds !== undefined && (!Number.isFinite(args.total_duration_seconds) || args.total_duration_seconds <= 0 || args.total_duration_seconds > options.maxTotalSeconds)) throw new VideoProjectError('INVALID_DURATION', '剪辑总时长超出当前项目允许范围。')
        for (const clip of args.clips) {
          if (clip.path.trim() === '' || clip.start_seconds !== undefined && (!Number.isFinite(clip.start_seconds) || clip.start_seconds < 0) || clip.end_seconds !== undefined && (!Number.isFinite(clip.end_seconds) || clip.end_seconds <= (clip.start_seconds ?? 0))) throw new VideoProjectError('INVALID_TRIM', '片段路径或裁剪起止时间无效。')
        }
        const root = resolveVideoOutputDirectory(workspaceRoot, options.outputDirectory)
        const ownedMediaRoots: string[] = []
        for (const clip of args.clips) {
          const fromPrivate = relative(options.stateDirectory, resolve(workspaceRoot, clip.path))
          if (fromPrivate.startsWith('..') || isAbsolute(fromPrivate)) continue
          const match = /^(vp_[a-f0-9-]{36})[\\/]clips[\\/]/u.exec(fromPrivate)
          if (match === null) throw new VideoProjectError('PROJECT_ACCESS_DENIED', '私有视频文件必须属于当前账号、聊天和工作区中的已保存项目。')
          const provider = await options.acquireProvider(workspaceRoot, session)
          const manifest = await readVideoProject(options, match[1] ?? '', session.id, workspaceRoot, provider.identity)
          if (!manifest.segments.some(segment => segment.path === resolve(workspaceRoot, clip.path))) throw new VideoProjectError('PROJECT_ACCESS_DENIED', '该文件没有已保存的视频项目记录。')
          const ownedRoot = join(options.stateDirectory, manifest.id, 'clips')
          if (!ownedMediaRoots.includes(ownedRoot)) ownedMediaRoots.push(ownedRoot)
        }
        const editor = options.editor(workspaceRoot, session, ownedMediaRoots)
        await editor.preflight(signal, root)
        const clips = args.clips.map(clip => ({
          path: clip.path,
          ...clip.start_seconds === undefined ? {} : { startSeconds: clip.start_seconds },
          ...clip.end_seconds === undefined ? {} : { endSeconds: clip.end_seconds },
        }))
        for (const clip of clips) await editor.probe(clip.path, signal)
        const outputPath = join(root, `edit-${randomUUID()}`, 'final.mp4')
        const jobId = start(exec, 'video-edit', `剪辑 ${String(clips.length)} 个视频片段`, async (job, signal) => {
          try {
            const result = await editor.compose({ clips, outputPath, ...args.total_duration_seconds === undefined ? {} : { totalDurationSeconds: args.total_duration_seconds }, signal, onProgress: (progress) =>{  job.updateProgress(`剪辑 ${String(progress.completedClips)}/${String(progress.totalClips)}`) } })
            const value: VideoToolResult = { status: 'succeeded', final_path: result.path, duration_seconds: result.durationSeconds, message: '剪辑视频已实际保存。请调用 present 展示 final_path，并在回复中提供产物链接。' }
            return { status: 'completed', result: JSON.stringify(value) }
          } catch (error) {
            return { status: signal.aborted ? 'killed' : 'failed', result: JSON.stringify(failure(error)) }
          }
        })
        return { status: 'background', job_id: jobId, message: '本地剪辑已开始，不会提交新的计费生成任务。使用 job_output 查看进度，完成后用 present 展示 final_path。' }
      } catch (error) { return failure(error) }
    },
  }))
}
