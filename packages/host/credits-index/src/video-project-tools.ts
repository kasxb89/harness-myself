/** Model tools for durable long-video generation and sandboxed local editing. @module */

import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import { prepareVideoProject, publishVideoOutput, readVideoProject, recoverVideoProjectOutputs, resolveVideoOutputDirectory, runVideoProject, videoProjectFailure, VideoProjectError } from './video-project.ts'
import type { VideoProjectManifest } from './video-project.ts'
import type { VideoProjectOptions, VideoProjectProvider } from './video-project-types.ts'
import { CreativeError, type CreativeOperation } from './creative-store.ts'
import { creativeOwner } from './creative-tools.ts'
import { resolveCreationVideoInput } from './creation-plan-execution.ts'
import { artifactOriginOf } from './artifact-origin.ts'

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
  plan_id?: string
}

/** All fields are programmatically available; prose never carries the only job id. */
const output = {
  schema: {
    type: 'object', properties: {
      status: { type: 'string', required: true }, message: { type: 'string', required: true },
      project_id: { type: 'string' }, job_id: { type: 'string' }, code: { type: 'string' },
      plan_seconds: { type: 'array', items: { type: 'number' } }, clip_paths: { type: 'array', items: { type: 'string' } },
      task_ids: { type: 'array', items: { type: 'string' } }, final_path: { type: 'string' }, duration_seconds: { type: 'number' },
      plan_id: { type: 'string' },
    }, additionalProperties: false,
  },
  render: (_args: unknown, value: VideoToolResult) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/** Preserve only safe declared failures; infrastructure messages may contain secrets. */
function failure(error: unknown): VideoToolResult {
  if (error instanceof CreativeError) return { status: 'failed', code: error.code, message: error.message }
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
    clip_paths: manifest.segments.flatMap(segment => segment.path === undefined ? [] : [segment.publishedPath ?? segment.path]),
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
  /** Optional previews observe committed files and cannot fail the main generation. */
  function runOptions(operation: CreativeOperation | undefined, session: Session, workspaceRoot: string): VideoProjectOptions {
    if (operation === undefined || options.creative === undefined) return options
    const creative = options.creative
    return { ...options, async saved(manifest, index, signal) {
      const path = index === undefined ? manifest.finalPath : manifest.segments[index - 1]?.path
      if (path === undefined) return
      const id = `${operation.operationId}_${index === undefined ? 'final' : `clip_${String(index)}`}`
      try {
        await creative.preview(operation, path, async () => {
          const previewEditor = options.editor(workspaceRoot, session, [join(options.stateDirectory, manifest.id, 'clips'), dirname(path)])
          if (previewEditor.preview === undefined) throw new CreativeError('CREATIVE_PREVIEW_UNAVAILABLE', 503, '本地视频预览工具暂时不可用。')
          return previewEditor.preview(path, join(workspaceRoot, '.yunshu-creative', 'previews', operation.operationId), signal)
        }, id)
      } catch (error) { ctx.logger.warn('Video saved; optional creation preview was not recorded.', error) }
    } }
  }
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
    description: 'Default fixed background workflow for every new chat video, including a single short clip and a finished video longer than one model clip. For a simple single-clip brief without an explicit duration, call this tool directly with prompt and any requested model or references; omit total_duration_seconds so the Host resolves actual defaults in one call. Do not load directing skills, write a long storyboard or call list_video_models first for that simple case. For explicit timing or complex plans, read list_video_models for actual controls; never discover support by paid retries or silently replace an explicitly named model. Use the yunshu-video-director skill for story, character/reference continuity, dialogue and subtitles, then call this native workflow; do not write polling, download or assembly scripts or manually repeat generate_video for each visual cut. One paid clip can contain several camera beats. For requests such as a 40-second video, plan the fewest supported clips (for a 15-second limit: 15+15+10, or three 15-second clips trimmed to 40), generate independent clips with gateway-approved bounded parallelism using the signed-in account, then normalize, trim, and join them in timeline order. Older gateways remain serial; the API owns shared account capacity. Do not launch a separate agent or generation-tool call for every clip. For a catalog with H3 single clips limited to 4–15 seconds, 60 seconds means four 15-second clips, never one 30-second clip. All local tools and every request are checked before billing. Returns a background job_id and durable project_id; read job_output at measured intervals for queued/generating progress and call present on the completed final_path. A busy response without an accepted task id is unknown, not confirmed queue admission. Use job_kill when the user stops; accepted provider tasks may continue billing. A query deadline retains task ids for explicit resume, never a fresh submission. Never claim completion before the job reports a saved final_path. If a current user-supplied chat attachment is outside the workspace, first copy that read-authorized attachment into this workspace with the existing file tools, then pass the copied path; do not copy unrelated files.',
    parameters: {
      plan_id: { type: 'string', description: 'Explicit update_creation_plan id. Also supply shot_ids in generation order.' },
      shot_ids: { type: 'array', items: { type: 'string' }, description: 'Exact shot ids belonging to plan_id, one per actual supported model clip and in the saved timeline order. Multiple visual cuts may share one paid clip; do not create an unsupported paid clip for each camera beat.' },
      prompt: { type: 'string', required: true, description: 'The complete video brief, visual continuity, story, and desired editing. Before calling, script user-delegated narrative or dialogue scenes with stable character ids, language and brief exact lines, identifying on-screen speakers versus narration; preserve user-supplied wording. Assign each line and its timing to a shot in shot_prompts. Do not reduce a story requiring voices to a music montage. Respect silent/no-dialogue requests and do not add dialogue or subtitles to unrelated nonverbal videos. Include requested lip-sync and subtitle requirements. These request native model generation, not separate speech, lip-sync or subtitle processing; verify the rendered result before claiming they are met.' },
      total_duration_seconds: { type: 'number', description: 'Desired final length in whole seconds; this may exceed the model single-clip limit. For a simple single clip with no plan or explicit shot arrays, omit to use the selected model’s actual default duration. The Host reads the real catalog itself; no separate list_video_models call is needed. Required for explicit plans and shot arrays; never omit a user-specified duration.' },
      shot_prompts: { type: 'array', items: { type: 'string' }, description: 'Exact shot briefs, one per planned clip. With plan_id and shot_ids, omit to use each saved shot’s scene, camera, action, prompt, exact dialogue/subtitles and associated character definitions without another model call. Explicit values remain verbatim. Otherwise allocate delegated narrative lines and timing to stable speakers, distinguishing on-screen speech from narration. Respect silent/no-dialogue requests.' },
      shot_durations_seconds: { type: 'array', items: { type: 'number' }, description: 'Exact model-supported whole seconds per clip, in shot_ids or shot_prompts order. Their sum must equal total_duration_seconds. When omitted for an explicit creation plan, use its saved shot durations; do not silently change timeline timing.' },
      model: { type: 'string', description: 'Exact id from list_video_models. Preserve an explicitly requested model; never silently switch it. Otherwise choose an available account model using its returned duration, dimension and audio declarations.' },
      resolution: { type: 'string' }, ratio: { type: 'string' },
      audio: { type: 'boolean', description: 'Optional requested audio state from list_video_models, not a capability probe. Sent as a switch only when the chosen model declares one; fixed native audio accepts only its declared state. No switch does not mean silent output; an undeclared audio state remains unknown. Do not blindly send true, and do not promise speech, lip-sync, subtitles or silence without checking the media.' },
      frame_images: { type: 'array', items: { type: 'string' }, description: 'Existing uploaded ma_ first/last frame ids or workspace image paths. For a user-supplied chat attachment outside the workspace, first copy the read-authorized attachment into the workspace with existing file tools and pass its copied path.' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Shared uploaded ma_ subject/style image ids or workspace image paths used by every shot. With plan_id, each shot’s saved image materials and character references are added only to that shot; do not duplicate unrelated character references here. For a user-supplied chat attachment outside the workspace, first copy the read-authorized attachment into the workspace with existing file tools and pass its copied path.' },
      reference_videos: { type: 'array', items: { type: 'string' }, description: 'Existing uploaded ma_ video reference ids or workspace video paths. For a user-supplied chat attachment outside the workspace, first copy the read-authorized attachment into the workspace with existing file tools and pass its copied path.' },
      reference_audios: { type: 'array', items: { type: 'string' }, description: 'Existing uploaded ma_ audio reference ids or workspace WAV/MP3 paths, only when the chosen model supports audio references. For a user-supplied chat attachment outside the workspace, first copy the read-authorized attachment into the workspace with existing file tools and pass its copied path. A reference does not guarantee copied speech, matching mouth movements or subtitles.' },
    }, output,
    presentCall: args => ({ card: 'generic', title: '生成并剪辑视频', kind: 'edit', content: [{ type: 'text', text: `${args.total_duration_seconds === undefined ? '模型默认时长' : `${String(args.total_duration_seconds)} 秒`} · ${args.prompt}` }] }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '视频项目未开始' : '视频项目', content: result.content }),
    async execute(args, exec): Promise<VideoToolResult> {
      let creation: CreativeOperation | undefined
      try {
        const { workspaceRoot, session } = caller(exec)
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        signal.throwIfAborted()
        let provider = await options.acquireProvider(workspaceRoot, session)
        let duration = args.total_duration_seconds
        let model = args.model
        if (duration === undefined) {
          if (args.plan_id !== undefined || args.shot_ids !== undefined
            || args.shot_prompts !== undefined || args.shot_durations_seconds !== undefined) {
            throw new VideoProjectError('INVALID_DURATION', '已有创作计划或分镜时须提供明确总时长；尚未提交生成。')
          }
          const original = provider
          const selected = await original.model(model, signal, args.resolution)
          if (model !== undefined && selected.id !== model) {
            throw new VideoProjectError('VIDEO_MODEL_UNAVAILABLE', '所选视频型号与服务返回不一致，尚未提交生成；请重新选择型号。')
          }
          duration = selected.defaultDuration ?? selected.durations[0]
          if (duration === undefined || !Number.isSafeInteger(duration) || !selected.durations.includes(duration) || duration < 1) {
            throw new VideoProjectError('DURATION_MENU_UNAVAILABLE', '当前模型没有合法的默认时长，请选择视频时长后重试；尚未提交生成。')
          }
          model = selected.id
          const prepared: VideoProjectProvider = {
            identity: original.identity, assertCurrent: () => original.assertCurrent(),
            parallelism: async (id, preparedSignal) => {
              if (original.parallelism === undefined) return 1
              return await original.parallelism(id, preparedSignal)
            },
            model: async (id, preparedSignal, resolution) => {
              preparedSignal.throwIfAborted()
              await original.assertCurrent()
              return id === selected.id && resolution === args.resolution ? selected : await original.model(id, preparedSignal, resolution)
            },
            build: (...values) => original.build(...values), submit: (...values) => original.submit(...values),
            check: (...values) => original.check(...values), download: (...values) => original.download(...values),
          }
          provider = prepared
        }
        const editor = options.editor(workspaceRoot, session)
        const images = async (values: readonly string[]): Promise<string[]> => {
          const normalized: string[] = []
          for (const value of values) {
            const owned = args.plan_id === undefined ? undefined
              : await options.creativeImageReference?.(creativeOwner(exec, provider.identity), args.plan_id, value)
            normalized.push(owned ?? value)
          }
          return normalized
        }
        const { input, planRevision } = await resolveCreationVideoInput(options, creativeOwner(exec, provider.identity), {
          prompt: args.prompt, totalDurationSeconds: duration,
          ...args.shot_prompts === undefined ? {} : { shotPrompts: args.shot_prompts },
          ...args.shot_durations_seconds === undefined ? {} : { shotDurations: args.shot_durations_seconds },
          ...model === undefined ? {} : { model },
          ...args.resolution === undefined ? {} : { resolution: args.resolution },
          ...args.ratio === undefined ? {} : { ratio: args.ratio },
          ...args.audio === undefined ? {} : { audio: args.audio },
          ...args.frame_images === undefined ? {} : { frameImages: await images(args.frame_images) },
          ...args.reference_images === undefined ? {} : { referenceImages: await images(args.reference_images) },
          ...args.reference_videos === undefined ? {} : { referenceVideos: args.reference_videos },
          ...args.reference_audios === undefined ? {} : { referenceAudios: args.reference_audios },
        }, args.plan_id, args.shot_ids)
        const manifest = await prepareVideoProject(options, input, session.id, workspaceRoot,
          provider, editor, signal, artifactOriginOf(exec))
        creation = await options.creative?.begin(creativeOwner(exec, provider.identity), {
          kind: 'video', prompt: input.prompt, model: manifest.model,
          shots: manifest.segments.map(segment => ({ prompt: segment.prompt, durationSeconds: segment.durationSeconds })),
          videoProjectId: manifest.id,
          ...args.plan_id === undefined ? {} : { planId: args.plan_id }, ...args.shot_ids === undefined ? {} : { shotIds: args.shot_ids },
          ...planRevision === undefined ? {} : { expectedRevision: planRevision },
        })
        const runEditor = options.editor(workspaceRoot, session, [join(options.stateDirectory, manifest.id, 'clips')])
        const linked = creation
        const jobId = start(exec, 'video-project', `${String(input.totalDurationSeconds)} 秒视频`, async (job, signal) => {
          try { return await runVideoProject(runOptions(linked, session, workspaceRoot), manifest, provider, runEditor, job, signal) }
          finally { if (linked !== undefined) options.creative?.release(linked) }
        }, manifest.id)
        return { status: 'background', job_id: jobId, project_id: manifest.id, ...creation === undefined ? {} : { plan_id: creation.projectId }, plan_seconds: manifest.segments.map(segment => segment.durationSeconds), message: '视频项目已开始。使用 job_output 查看进度，完成后将 final_path 交给 present 展示；停止本地任务后，已提交的上游任务仍可能继续计费。' }
      } catch (error) { if (creation !== undefined) options.creative?.release(creation); return failure(error) }
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
        const manifest = await recoverVideoProjectOutputs(options, args.project_id, session.id, workspaceRoot, provider.identity,
          signal, () => provider.assertCurrent())
        return statusOf(manifest, activeProjects.has(manifest.id))
      } catch (error) { return failure(error) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resume_video_project',
    description: 'Explicitly continue a retained project for the same account, workspace, and chat. Reuse saved clips and query already known provider task ids before submitting any remaining never-submitted clips. Unknown or failed clips block new submissions, while other already accepted task ids remain recoverable for download. Never repeat unknown or failed submissions, and refuse a second live run. Local cancellation cannot cancel already accepted upstream billing.',
    parameters: { project_id: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: '继续视频项目', kind: 'edit', content: [{ type: 'text', text: args.project_id }] }),
    async execute(args, exec): Promise<VideoToolResult> {
      let creation: CreativeOperation | undefined
      try {
        const { workspaceRoot, session } = caller(exec)
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        signal.throwIfAborted()
        const provider = await options.acquireProvider(workspaceRoot, session)
        const manifest = await readVideoProject(options, args.project_id, session.id, workspaceRoot, provider.identity)
        if (manifest.status === 'completed') return statusOf(manifest, false)
        if (activeProjects.has(manifest.id)) throw new VideoProjectError('PROJECT_ALREADY_RUNNING', '该项目已经在后台运行，请查看已有任务。')
        const editor = options.editor(workspaceRoot, session, [join(options.stateDirectory, manifest.id, 'clips')])
        await editor.preflight(signal, manifest.outputDirectory)
        creation = await options.creative?.resumeVideo(creativeOwner(exec, provider.identity), manifest)
        const linked = creation
        const jobId = start(exec, 'video-project', `继续 ${String(manifest.input.totalDurationSeconds)} 秒视频`, async (job, signal) => {
          try { return await runVideoProject(runOptions(linked, session, workspaceRoot), manifest, provider, editor, job, signal) }
          finally { if (linked !== undefined) options.creative?.release(linked) }
        }, manifest.id)
        return { status: 'background', project_id: manifest.id, job_id: jobId, plan_seconds: manifest.segments.map(segment => segment.durationSeconds), message: '已开始读取原任务和已保存片段。使用 job_output 查看结果；未知提交不会重新计费提交。' }
      } catch (error) { if (creation !== undefined) options.creative?.release(creation); return failure(error) }
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
        const publicationDirectory = (await options.publication?.capture(signal))?.directory
        const origin = artifactOriginOf(exec)
        const outputPath = join(root, `edit-${randomUUID()}`, 'final.mp4')
        const jobId = start(exec, 'video-edit', `剪辑 ${String(clips.length)} 个视频片段`, async (job, signal) => {
          try {
            const result = await editor.compose({ clips, outputPath, ...args.total_duration_seconds === undefined ? {} : { totalDurationSeconds: args.total_duration_seconds }, signal, onProgress: (progress) =>{  job.updateProgress(`剪辑 ${String(progress.completedClips)}/${String(progress.totalClips)}`) } })
            const finalPath = await publishVideoOutput(options, result.path, publicationDirectory, signal, origin)
            const value: VideoToolResult = { status: 'succeeded', final_path: finalPath, duration_seconds: result.durationSeconds, message: '剪辑视频已实际保存。请调用 present 展示 final_path，并在回复中提供产物链接。' }
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
