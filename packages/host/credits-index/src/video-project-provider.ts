/** Account-bound video relay requests; task content never follows provider-supplied URLs. @module */
import { randomBytes } from 'node:crypto'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { VideoProjectRequest } from './video-project-types.ts'
import { apiUrl, normalizeApiBaseUrl } from './api-url.ts'
import { isAccountBalanceRejection } from './account-balance.ts'
import { videoSubmission } from './video-submission.ts'
import { hasMediaSubmissionReceipt, mediaSubmissionTaskId, hasMediaSubmissionUnknown, mediaSubmissionUnknownTaskId } from './media-submission-receipt.ts'
import {
  h3SubmissionRejection, h3SubmissionQueryRejection, hasH3SubmissionReceipt, h3ProviderTerminalRejection, hasH3ProviderTerminal,
} from './video-submission-result.ts'

/** Stable relay failure safe for project records and model-visible reports. */
export class VideoRelayError extends Error {
  /** Coherent original platform identity, never inferred from a request header or conflicting response. */
  readonly taskId: string | undefined
  /** @param code - Stable failure identity. @param message - Safe summary without upstream data. @param options - Internal error cause. */
  constructor(readonly code: string, message: string, options?: ErrorOptions & { taskId?: string }) {
    super(message, options); this.name = 'VideoRelayError'; this.taskId = options?.taskId
  }
}

/** Host-owned limits and a fresh credential resolver; no key enters durable project data. */
export interface VideoRelayOptions {
  /** API root including the deployment's reverse-proxy prefix. */
  origin: string
  timeoutMs: number
  /** Complete single-submit deadline; defaults to at least 180 seconds. */
  submitTimeoutMs?: number
  /** Complete content-transfer deadline; defaults to the ordinary request deadline. */
  downloadTimeoutMs?: number
  maxDownloadBytes: number
  /** Host-owned private project cache; downloads never write directly into the workspace. */
  cacheRoot: string
  /** Launcher-derived video traffic label, absent outside Desktop; it grants no authority. */
  clientSource?: 'desktop' | undefined
  /** Recheck the original account/login before every request. */
  key(): Promise<string>
}

/** Account-authorized operations against one configured video relay API root. */
export interface VideoProjectRelay {
  /** @param signal - Cancels the catalog read. @returns Account-visible model identifiers. */
  modelIds(signal: AbortSignal): Promise<readonly string[]>
  /**
   * @param body - Exact prepared generation request; private snapshots are serialized as multipart files.
   * @param route - Selected model's generation path.
   * @param signal - Cancels dispatch.
   * @returns Accepted upstream task identifier.
   */
  submit(body: VideoProjectRequest, route: string, signal: AbortSignal): Promise<{ taskId: string }>
  /**
   * @param taskId - Previously accepted task.
   * @param route - Original model's generation path.
   * @param signal - Cancels polling.
   * @returns Normalized upstream status, preserving accepted queue admission separately from generation.
   */
  check(taskId: string, route: string, signal: AbortSignal, model?: string): Promise<{ status: 'queued' | 'running' | 'succeeded' | 'failed'; message?: string }>
  /** @param taskId - Completed task. @param destination - New private clip path. @param signal - Cancels transfer. */
  download(taskId: string, destination: string, signal: AbortSignal): Promise<void>
}

const JSON_LIMIT = 262_144
const TASK_ID = /^[A-Za-z0-9._:-]{1,256}$/u

function isTaskId(value: string): boolean { return value !== '.' && value !== '..' && TASK_ID.test(value) }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: Record<string, unknown> | undefined, key: string): string | undefined {
  return typeof value?.[key] === 'string' ? value[key] : undefined
}

function baseOf(raw: string): string {
  try { return normalizeApiBaseUrl(raw) } catch (_invalidBaseUrl: unknown) {
    throw new VideoRelayError('VIDEO_RELAY_CONFIG', '视频服务地址无效，请联系管理员')
  }
}

function validTask(taskId: string): string {
  if (!isTaskId(taskId)) throw new VideoRelayError('VIDEO_TASK_INVALID', '视频任务标识无效，已停止操作')
  return encodeURIComponent(taskId)
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  if (response.body === null) throw new VideoRelayError('VIDEO_RESPONSE_INVALID', '视频服务返回了无效结果')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > JSON_LIMIT) throw new VideoRelayError('VIDEO_RESPONSE_LIMIT', '视频任务响应过大，已停止读取')
      chunks.push(chunk.value)
    }
    let value: unknown
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) {
      throw new VideoRelayError('VIDEO_RESPONSE_INVALID', error instanceof SyntaxError ? '视频服务返回了无效结果' : '无法读取视频任务结果')
    }
    const result = record(value)
    if (result === undefined) throw new VideoRelayError('VIDEO_RESPONSE_INVALID', '视频服务返回了无效结果')
    return result
  } finally {
    await reader.cancel().catch((_closedReader: unknown) => { /* The response may have already ended or been aborted. */ })
    reader.releaseLock()
  }
}

/**
 * Create task submission, status, and bounded content operations for one trusted API root.
 * @param options - Configured API root, byte/deadline limits, and account-owned credential resolver.
 * @returns Operations which never repeat a POST or forward credentials across origins.
 */
export function createVideoProjectRelay(options: VideoRelayOptions): VideoProjectRelay {
  const baseUrl = baseOf(options.origin)
  async function request(
    path: string, signal: AbortSignal, body?: VideoProjectRequest, timeoutMs = options.timeoutMs, allowNotFound = false,
  ): Promise<Response> {
    signal.throwIfAborted()
    const key = await options.key()
    signal.throwIfAborted()
    const submission = body === undefined ? undefined : videoSubmission(body)
    let response: Response
    try {
      response = await fetch(apiUrl(baseUrl, path), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + key, accept: body === undefined && path.endsWith('/content') ? 'video/mp4' : 'application/json',
          ...submission?.headers, ...options.clientSource === undefined || path === '/v1/models' ? {} : { 'x-yunshu-client': options.clientSource } },
        ...(submission === undefined ? {} : { body: submission.body }),
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      })
    } catch (_transportFailure: unknown) {
      throw new VideoRelayError(body === undefined ? 'VIDEO_READ_UNAVAILABLE' : 'VIDEO_SUBMIT_UNKNOWN', body === undefined
        ? '无法读取视频任务，请保留项目记录后重试查询'
        : '视频提交结果未知，可能已计费；已停止后续生成，请检查用量和任务记录')
    }
    if (body === undefined && allowNotFound && response.status === 404) return response
    if (!response.ok) {
      let balanceRejected = false
      if (body !== undefined) {
        let rejection: Record<string, unknown> | undefined
        try { rejection = await jsonBody(response) }
        catch (_unreadableRejection: unknown) { /* An invalid response cannot establish whose balance is exhausted. */ }
        const settled = h3SubmissionRejection(body.model, response.status, rejection)
        if (settled !== undefined) throw settled
        if (hasMediaSubmissionReceipt(rejection)) {
          const taskId = mediaSubmissionTaskId(body.model, 'video', rejection)
          throw new VideoRelayError('VIDEO_SUBMIT_UNKNOWN', '原视频回执尚未通过完整核对，请保留已有任务与计费记录，不要重新生成。',
            taskId === undefined ? undefined : { taskId })
        }
        balanceRejected = isAccountBalanceRejection(rejection, response.status)
      } else await response.body?.cancel().catch((_closedBody: unknown) => { /* No upstream error body is exposed or retained. */ })
      if (balanceRejected) throw new VideoRelayError('INSUFFICIENT_BALANCE', '余额不足，请充值')
      if (body !== undefined && response.status === 429) {
        throw new VideoRelayError('VIDEO_SUBMIT_BUSY', '视频服务繁忙，提交结果尚未确认，请先核对原任务，不要重新提交。')
      }
      throw new VideoRelayError(body === undefined ? 'VIDEO_READ_REJECTED' : 'VIDEO_SUBMIT_REJECTED', body === undefined
        ? '视频服务未能返回该任务，请稍后重试查询'
        : '视频服务未接受本次请求，已停止后续生成，请检查模型和账户状态')
    }
    return response
  }
  return {
    async modelIds(signal: AbortSignal): Promise<readonly string[]> {
      const value = await jsonBody(await request('/v1/models', signal))
      if (!Array.isArray(value.data)) throw new VideoRelayError('VIDEO_MODELS_INVALID', '无法读取当前账户可用的视频模型')
      return value.data.flatMap((entry: unknown) => {
        const id = text(record(entry), 'id')
        return id === undefined || id.length === 0 || id.length > 256 ? [] : [id]
      })
    },
    async submit(body: VideoProjectRequest, route: string, signal: AbortSignal): Promise<{ taskId: string }> {
      const response = await request(route, signal, body, options.submitTimeoutMs ?? Math.max(options.timeoutMs, 180_000))
      const value = await jsonBody(response)
      if (hasMediaSubmissionReceipt(value)) {
        const taskId = mediaSubmissionTaskId(body.model, 'video', value)
        throw new VideoRelayError('VIDEO_SUBMIT_UNKNOWN', '原视频回执尚未通过完整核对，请保留已有任务与计费记录，不要重新生成。',
          taskId === undefined ? undefined : { taskId })
      }
      if (hasMediaSubmissionUnknown(value)) {
        const taskId = mediaSubmissionUnknownTaskId(body.model, 'video', response.status, value)
        if (taskId === undefined) throw new VideoRelayError('VIDEO_SUBMIT_UNKNOWN', '视频提交回执无法完整核对，请保留已有记录，不要重新生成。')
        return { taskId }
      }
      const nested = record(value.data)
      const taskId = text(value, 'task_id') ?? text(value, 'id') ?? text(nested, 'task_id') ?? text(nested, 'id')
      if (taskId === undefined || !isTaskId(taskId)) {
        throw new VideoRelayError('VIDEO_SUBMIT_UNKNOWN', '视频已提交但未获得有效任务标识，可能已计费；请勿直接重新生成')
      }
      return { taskId }
    },
    async check(taskId: string, route: string, signal: AbortSignal, model?: string): Promise<{ status: 'queued' | 'running' | 'succeeded' | 'failed'; message?: string }> {
      const canonical = model === 'MiniMax-H3' || taskId.startsWith('task_')
      let response = await request((canonical ? '/v1/tasks' : route) + '/' + validTask(taskId), signal, undefined, options.timeoutMs, canonical)
      if (canonical && response.status === 404 && route !== '/v1/tasks') {
        await response.body?.cancel()
        response = await request(route + '/' + validTask(taskId), signal)
      }
      if (response.status !== 200) {
        await response.body?.cancel()
        throw new VideoRelayError('VIDEO_READ_REJECTED', '视频服务未能返回该任务，请稍后重试查询')
      }
      const value = await jsonBody(response)
      const rejection = h3SubmissionQueryRejection(model, response.status, value, taskId)
      if (rejection !== undefined) throw rejection
      const terminal = h3ProviderTerminalRejection(model, response.status, value, taskId)
      if (terminal !== undefined) throw terminal
      if (hasMediaSubmissionReceipt(value) || hasMediaSubmissionUnknown(value) || model === 'MiniMax-H3' && (hasH3SubmissionReceipt(value) || hasH3ProviderTerminal(value))) {
        throw new VideoRelayError('VIDEO_STATUS_INVALID', '原视频回执尚未通过完整核对，请保留原任务编号，不要重新生成。')
      }
      const nested = record(value.data)
      const status = (text(value, 'task_status') ?? text(value, 'status') ?? text(nested, 'task_status') ?? text(nested, 'status'))?.toLowerCase()
      if (['succeed', 'succeeded', 'success', 'completed'].includes(status ?? '')) return { status: 'succeeded' }
      if (['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled'].includes(status ?? '')) {
        if (model === 'MiniMax-H3') throw new VideoRelayError('VIDEO_STATUS_INVALID', '原视频失败状态尚无完整提交与计费证明，请保留原任务编号继续核对，不要重新生成。')
        return { status: 'failed', message: '上游视频任务未完成，已保留项目和已生成片段' }
      }
      if (['not_start', 'pending', 'queued', 'in_queue', 'created', 'submitted'].includes(status ?? '')) return { status: 'queued' }
      if (['running', 'processing', 'in_progress', 'generating'].includes(status ?? '')) return { status: 'running' }
      throw new VideoRelayError('VIDEO_STATUS_INVALID', '视频任务状态无法确认，已保留任务标识，请稍后继续查询')
    },
    async download(taskId: string, destination: string, signal: AbortSignal): Promise<void> {
      // The pipeline owns this private directory; it creates it before dispatch and never accepts an arbitrary output path.
      const parent = dirname(destination)
      const parentInfo = await lstat(parent)
      const [root, canonicalParent] = await Promise.all([realpath(options.cacheRoot), realpath(parent)])
      const within = relative(root, canonicalParent)
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) {
        throw new VideoRelayError('VIDEO_OUTPUT_UNSAFE', '视频缓存目录不可用，已停止下载')
      }
      const response = await request('/v1/videos/' + validTask(taskId) + '/content', signal, undefined, options.downloadTimeoutMs)
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > options.maxDownloadBytes) {
        await response.body?.cancel()
        throw new VideoRelayError('VIDEO_CONTENT_LIMIT', '视频文件超过本机下载上限，已停止保存')
      }
      if (response.body === null) throw new VideoRelayError('VIDEO_CONTENT_INVALID', '视频服务未返回可下载文件')
      const temporary = join(parent, '.video-' + randomBytes(12).toString('hex') + '.part')
      const file = await open(temporary, 'wx', 0o600).catch(async (error: unknown) => {
        await response.body?.cancel().catch((_closedBody: unknown) => { /* No file exists; release the acquired response too. */ })
        throw error
      })
      const reader = response.body.getReader()
      let bytes = 0
      let signature = Buffer.alloc(0)
      try {
        for (;;) {
          signal.throwIfAborted()
          const chunk = await reader.read().catch((error: unknown) => {
            signal.throwIfAborted()
            throw new VideoRelayError('VIDEO_DOWNLOAD_UNAVAILABLE', '视频下载中断，已保留任务记录；请恢复原项目以重新下载，不要重新生成', { cause: error })
          })
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > options.maxDownloadBytes) throw new VideoRelayError('VIDEO_CONTENT_LIMIT', '视频文件超过本机下载上限，已停止保存')
          if (signature.length < 12) signature = Buffer.concat([signature, chunk.value]).subarray(0, 12)
          await file.writeFile(chunk.value)
        }
        if (bytes < 12 || signature.subarray(4, 8).toString('ascii') !== 'ftyp') {
          throw new VideoRelayError('VIDEO_CONTENT_INVALID', '下载结果不是可确认的视频文件，已保留任务以便重新查询')
        }
        signal.throwIfAborted()
        await file.sync()
        await file.close()
        // Hard-link promotion refuses an existing destination rather than overwriting a saved clip.
        await link(temporary, destination)
      } finally {
        await file.close().catch((_alreadyClosed: unknown) => { /* Promotion closes the descriptor before linking. */ })
        await reader.cancel().catch((_closedReader: unknown) => { /* Completion or cancellation already ended the response. */ })
        reader.releaseLock()
        await unlink(temporary)
      }
    },
  }
}
