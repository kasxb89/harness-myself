/** Model-facing typed media operations use the same persisted receipts as the creation UI. @module */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MediaV2Client, MediaV2Error, type MediaV2Account, type MediaV2Record, type MediaV2UploadSource } from './media-v2-client.ts'
import { hasCurrentHumanRequest, videoGenerationIntentOf } from './video-generation-intent.ts'

/** Existing account, file authorization and configured polling used by native tools. */
export interface MediaV2ToolOptions {
  client: MediaV2Client
  pollIntervalMs: number
  taskTimeoutMs: number
  capture(signal: AbortSignal): Promise<MediaV2Account>
  readAsset(path: string, exec: ToolRunContext, maximum: number): Promise<{ filename: string; mime: string } & MediaV2UploadSource>
}
declare module '@deepseek-ai/dsh-jobs/view' { interface JobKindMap { 'media-runtime': 'media-runtime' } }
const output = { schema: { type: 'object' as const, properties: {}, additionalProperties: true },
  render: (_args: unknown, value: Record<string, unknown>) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
function failure(error: unknown): Record<string, unknown> {
  return { status: 'unconfirmed', code: error instanceof MediaV2Error ? error.code : 'operation_unknown',
    message: error instanceof MediaV2Error ? error.message : '原操作结果尚未确认，请查询原编号，不要重复生成。' }
}
/** One identity per human-requested work, independent of model tool-call retries. */
function operationUUID(exec: ToolRunContext, parts: readonly string[]): string {
  const session = exec.agent?.session
  if (!hasCurrentHumanRequest(exec)) throw new MediaV2Error('invalid_request', '本轮没有新的用户创作请求；可查询原任务，不能自动新建生成。', 400)
  if (session === undefined) throw new MediaV2Error('auth_required', '请从工作区聊天发起媒体操作。', 401)
  const source = videoGenerationIntentOf(exec)?.grant.sourceSeq
  if (source === undefined) throw new MediaV2Error('invalid_request', '无法确认当前真人请求，尚未提交媒体操作。', 400)
  const raw = createHash('sha256').update(JSON.stringify([session.id, source, ...parts])).digest('hex')
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`
}
function result(record: MediaV2Record): Record<string, unknown> {
  return { status: record.task?.status ?? record.state, client_operation_id: record.request.client_operation_id,
    model: record.request.model, intent: record.request.intent, ...record.quote === undefined ? {} : { quote: record.quote },
    ...record.task === undefined ? {} : { task: record.task },
    ...record.saved === undefined ? {} : { paths: record.saved.map(item => item.path) },
    message: record.task?.status === 'succeeded' ? '原任务已完成，全部产物保留；查询不会重新生成。'
      : '已保留原操作编号；已受理或未知时只查询原任务，不要重新报价另建操作或改用其他模型。' }
}
/**
 * Register reversible native tools and account-owned original-task background jobs.
 * @param ctx - Owning injected plugin context.
 * @param options - The existing account controller and native runtime dependencies.
 */
export function registerMediaV2Tools(ctx: Context, options: MediaV2ToolOptions): void {
  const lifetime = new AbortController(), producers = new Set<Promise<JobOutcome>>(), active = new Map<string, JobId>()
  ctx.effect(() => async () => { lifetime.abort(); await Promise.allSettled([...producers]) }, 'credits-index: native media background producers')
  const start = async (exec: ToolRunContext, id: string): Promise<Record<string, unknown>> => {
    const jobs = ctx.get('jobs'), agent = exec.agent
    if (jobs === undefined || agent === undefined) throw new MediaV2Error('jobs_unavailable', '后台任务服务未就绪，尚未提交生成。', 503)
    const account = await options.capture(exec.signal), key = `${account.owner}:${id}`
    const previous = active.get(key)
    if (previous !== undefined) return { status: 'background', job_id: previous, client_operation_id: id, message: '原任务已在后台运行，请使用原 job_output，不会重复生成。' }
    const jobId = jobs.start({ kind: 'media-runtime', owner: agent.id, label: '媒体生成与处理', readMode: 'background', backgroundReadConcludesTurn: false,
      run: (job) => {
        const abort = new AbortController()
        const signal = AbortSignal.any([abort.signal, lifetime.signal, AbortSignal.timeout(options.taskTimeoutMs)])
        const done = (async (): Promise<JobOutcome> => {
          try {
            job.updateProgress('提交原媒体操作')
            let record = await options.client.submit(account, id, signal)
            while (record.task?.is_final !== true) {
              job.updateProgress(record.task?.status === 'running' ? '生成或处理中' : '等待原任务结果')
              await delay(options.pollIntervalMs, undefined, { signal })
              record = await options.client.query(account, id, signal)
            }
            if (record.task.status === 'succeeded') {
              job.updateProgress(`保存全部 ${record.task.artifacts.length} 项原产物`)
              record = await options.client.saveArtifacts(account, id, signal)
            }
            return { status: record.task?.status === 'succeeded' ? 'completed' : 'failed', result: JSON.stringify(result(record)) }
          } catch (error) {
            return { status: abort.signal.aborted || lifetime.signal.aborted ? 'killed' : 'failed',
              detail: 'MEDIA_OPERATION_UNCONFIRMED', result: JSON.stringify({ ...failure(error), client_operation_id: id,
                message: '原操作结果尚未完整取回；请用原编号查询或恢复保存，不要重复生成。' }) }
          }
        })()
        producers.add(done)
        void done.finally(() => { producers.delete(done); active.delete(key) })
        return { cancel: () => { abort.abort() }, done }
      } })
    active.set(key, jobId)
    return { status: 'background', job_id: jobId, client_operation_id: id,
      message: '媒体任务已在后台处理，使用原 job_output 查看结果并展示全部返回路径；停止本地等待不会取消上游，不能重复生成。' }
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_media_models_v2',
    description: 'Read executable native image/video/audio generation and processing models, exact operation intents, complete recursive JSON schemas, conditions, asset roles/limits and indicative pricing. This is free. Use this path for motion replication, reference video, lip-sync/avatar, super-resolution, layer decomposition and other native controls not declared by legacy image/video tools. Ordinary mode/quality values remain distinct from text/reference/frames/transform intent. Never discover support through a paid trial. Without model, return a compact overview. Then call again with the exact model ID for its full typed schema and conditions before selecting parameters; preserve nested objects, arrays, ordered frames and declared values exactly, and follow all required/conditional fields; do not put every model schema into chat context. Follow with upload_media_asset for real materials and quote_media_operation for exact product credits.',
    parameters: { kind: { type: 'string', enum: ['image', 'video', 'audio'] }, model: { type: 'string' } }, output,
    async execute(args, exec): Promise<Record<string, unknown>> {
      try { const catalog = await options.client.catalog(await options.capture(exec.signal), exec.signal)
        const models = catalog.models.filter(model => (args.kind === undefined || model.kind === args.kind)
          && (args.model === undefined || model.id === args.model))
        if (args.model !== undefined && models.length === 0) throw new MediaV2Error('model_not_available', '当前账号没有这个型号，请保留所选型号并核对目录。', 404)
        return { status: 'listed', ...catalog, details_included: args.model !== undefined,
          models: args.model !== undefined ? models : models.map(model => ({ id: model.id, display_name: model.display_name,
            kind: model.kind, model_version: model.model_version, enabled: model.enabled,
            ...model.description === undefined ? {} : { description: model.description },
            intents: model.intents, pricing: model.pricing, read_details: { tool: 'list_media_models_v2', model: model.id } })) } }
      catch (error) { return failure(error) }
    },
  })), 'credits-index: V2 media catalog tool')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'upload_media_asset',
    description: 'Upload one real current-chat image or readable workspace image/video/audio as exact original bytes for a V2 model. Read the exact model details first; field is the declared material role receiving this file. Host intersects the server, role and deployment size limits; large authorized workspace files stream without a whole-file memory buffer. Model-specific probing and immutable SHA are performed by the server. Do not supply URLs, old ma_ IDs, invented metadata or unrelated attachments. A repeated call for the same actual human request/model/path recovers the same original upload without another POST. After an unknown upload, preserve client_asset_id and use this same call to query its receipt; do not change the path or create a fresh ID.',
    parameters: { model: { type: 'string', required: true }, path: { type: 'string', required: true }, field: { type: 'string' }, client_asset_id: { type: 'string' } }, output,
    async execute(args, exec): Promise<Record<string, unknown>> {
      let id = args.client_asset_id
      try {
        id ??= operationUUID(exec, ['asset', args.model, args.path])
        const account = await options.capture(exec.signal)
        const asset = args.client_asset_id === undefined
          ? await options.client.upload(account,
            { model: args.model, clientAssetId: id, ...args.field === undefined ? {} : { field: args.field },
              ...await options.readAsset(args.path, exec,
                await options.client.uploadLimit(account, args.model, exec.signal, args.field)) }, exec.signal)
          : await options.client.assetByClientId(account, id, args.model, exec.signal)
        return { status: 'ready', asset }
      } catch (error) { return { ...failure(error), client_asset_id: id, model: args.model } }
    },
  })), 'credits-index: V2 original reference tool')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'quote_media_operation',
    description: 'Obtain an exact free native-media quote before generation. Read list_media_models_v2, preserve every selected field and ordered asset ID, and supply the declared intent. Reference/frames/transform with missing materials is rejected; never substitute text. Parameters contain only fields declared by the exact model schema, including nested objects, arrays, null or prompt only when that schema accepts them. Preserve recursive structure, array order and values; do not stringify objects, flatten frames, truncate arrays or invent fields. Check model conditions and material constraints before quoting; an unsupported reference remains a reference error, never text fallback. Asset bindings are separate exact field -> ordered asset_id arrays, including singleton fields. Omit client_operation_id for the first quote: Host assigns one stable operation for this actual human request/model/work_key. Repeated calls recover the original record even with a different tool-call ID. Reuse that ID for quote correction, generation and recovery. work_key identifies a concrete separately requested output, not an attempt counter; native count belongs in parameters. Do not invent another work_key to retry an unknown or accepted task. No generation or wallet reservation occurs here.',
    parameters: { model: { type: 'string', required: true }, model_version: { type: 'string', required: true },
      intent: { type: 'string', enum: ['text', 'reference', 'frames', 'transform'], required: true },
      parameters: { type: 'object', properties: {}, additionalProperties: true, required: true },
      assets: { type: 'object', properties: {}, additionalProperties: true, required: true },
      client_operation_id: { type: 'string' }, work_key: { type: 'string' } }, output,
    async execute(args, exec): Promise<Record<string, unknown>> {
      let id: string | undefined
      try {
        if (!hasCurrentHumanRequest(exec)) throw new MediaV2Error('invalid_request', '本轮没有新的用户创作请求，请查询原任务。', 400)
        id = args.client_operation_id ?? operationUUID(exec, ['operation', args.model, args.work_key ?? 'primary'])
        return result(await options.client.quote(await options.capture(exec.signal), { client_operation_id: id, model: args.model,
          model_version: args.model_version, intent: args.intent, parameters: args.parameters, assets: args.assets }, exec.signal))
      } catch (error) { return { ...failure(error), ...id === undefined ? {} : { client_operation_id: id } } }
    },
  })), 'credits-index: V2 exact quote tool')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'generate_media_operation',
    description: 'Submit the exact quoted V2 media operation requested by the human, once. Supply only its original client_operation_id; this cannot change the model, references or parameters. Accepted/unknown original records are queried, never resubmitted. A normal pending task returns immediately: use query_media_operation at measured intervals and present all real returned paths. Do not call another generator, provider or new work_key to wait for this result. Every requested output remains part of this original operation, including GIF/layers/processed video.',
    parameters: { client_operation_id: { type: 'string', required: true } }, output,
    async execute(args, exec): Promise<Record<string, unknown>> {
      try {
        if (!hasCurrentHumanRequest(exec)) throw new MediaV2Error('invalid_request', '本轮没有新的用户创作请求，请查询原任务。', 400)
        return await start(exec, args.client_operation_id)
      } catch (error) { return { ...failure(error), client_operation_id: args.client_operation_id } }
    },
  })), 'credits-index: V2 receipt-first generation tool')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'query_media_operation',
    description: 'Read the exact original V2 operation/task and save every original output when ready. This never generates media. Pending, unknown, 404, timeout and partial downloads retain the operation; recover again with the same ID rather than resubmitting. GIF remains animated, vectors are files and every layer/output is returned. No first-output slicing.',
    parameters: { client_operation_id: { type: 'string', required: true } }, output,
    async execute(args, exec): Promise<Record<string, unknown>> {
      try {
        const account = await options.capture(exec.signal)
        let record = await options.client.query(account, args.client_operation_id, exec.signal)
        if (record.task?.status === 'succeeded') record = await options.client.saveArtifacts(account, args.client_operation_id, exec.signal)
        return result(record)
      } catch (error) { return { ...failure(error), client_operation_id: args.client_operation_id } }
    },
  })), 'credits-index: V2 original result query tool')
}
