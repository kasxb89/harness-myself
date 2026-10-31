/** Strict, opt-in server video admission with original-ID recovery and no repeated create POST. @module */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { VideoProjectAttemptId } from './video-project.ts'
import type { VideoProjectRequest, VideoProjectSubmission } from './video-project-types.ts'
import { apiUrl, normalizeApiBaseUrl } from './api-url.ts'
import { accountBalanceFailure, isAccountBalanceRejection, type AccountBalanceFailure } from './account-balance.ts'

const BODY_LIMIT = 65_536
const STATUS_LIMIT = 1_048_576
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const TASK_ID = /^task_[A-Za-z0-9]{32}$/u
const CAPABILITY = {
  schema_version: 1, enabled: true, create_path: '/v1/video/queue',
  retrieve_path_template: '/v1/video/queue/:queue_id', cancel_path_template: '/v1/video/queue/:queue_id/cancel',
  max_count_per_item: 1, body_max_bytes: BODY_LIMIT, poll_interval_seconds: 15,
  client_generated_id: true, queued_charge_reserved: false, lost_ack_recovery_method: 'GET',
} as const

/** Deterministic private queue identity derived from an already persisted clip attempt. */
export type VideoServerQueueId = Branded<'VideoServerQueueId'>
/** Canonical gateway task mapped immutably to one queue item. */
export type VideoServerGatewayTaskId = Branded<'VideoServerGatewayTaskId'>

/** Queue state never turns an unknown submission or observation timeout into a provider failure. */
export type VideoServerQueueState = 'queued' | 'dispatching' | 'running' | 'unknown' | 'canceled' | 'failed' | 'succeeded'

/** Fully validated facts about the original durable gateway operation. */
export interface VideoServerQueueItem {
  readonly queueId: VideoServerQueueId
  readonly operationId: VideoProjectAttemptId
  readonly model: string
  readonly count: 1
  readonly durationSeconds: number
  readonly gatewayTaskId: VideoServerGatewayTaskId
  readonly state: VideoServerQueueState
  readonly submissionState: 'not_submitted' | 'dispatching' | 'unknown' | 'accepted'
  readonly cancelable: boolean
  readonly observationTimedOut: boolean
  readonly createdAt: number
  readonly updatedAt: number
  /** Confirmed funding category only; raw failure_reason and provider diagnostics are not retained. */
  readonly failure?: AccountBalanceFailure
}

/** Safe queue errors retain only a stable original queue ID, never an upstream message or credential. */
export class VideoServerQueueError extends Error {
  /**
   * @param code - Stable queue failure.
   * @param message - Safe summary and recovery action.
   * @param queueId - Original queue identity.
   * @param failure - Safe funding category, independent of queue acceptance.
   */
  constructor(readonly code: string, message: string, readonly queueId?: string, readonly failure?: AccountBalanceFailure) {
    super(message); this.name = 'VideoServerQueueError'
  }
}

/** Current account I/O; the queue does not retain a relay key. */
export interface VideoServerQueueOptions {
  /** Configured API root, including its reverse-proxy prefix. */
  readonly origin: string
  /** Independent request and complete acknowledgement-read deadline. */
  readonly timeoutMs: number
  /** Launcher-derived diagnostic source; never grants queue or model authority. */
  readonly clientSource?: 'desktop' | undefined
  /** Recheck current account/login and obtain its current relay key before each private request. */
  key(this: void): Promise<string>
  /** Optional instance-local transport for isolated tests. */
  readonly fetch?: typeof globalThis.fetch
}

/** Discovered queue operations; no polling or paid request starts during discovery. */
export interface VideoServerQueue {
  /** Exact advertised interval for reads of an accepted queue ID. */
  readonly pollIntervalMs: number
  /**
   * Check whether a prepared request can be sent without private multipart or inline reference carriers.
   * @param request - Immutable prepared provider request.
   * @param submission - Optional persisted clip identity; omitted only during pre-submission request preparation.
   * @returns Whether a first queue submission is supported; false never authorizes a fallback after a POST began.
   */
  supports(this: void, request: VideoProjectRequest, submission?: VideoProjectSubmission): boolean
  /**
   * Submit once, then recover a missing or invalid acknowledgement only by the original queue GET.
   * @param request - Validated provider request with an explicit duration.
   * @param submission - Clip attempt persisted by its owner before this call.
   * @param signal - Cancels this operation and awaits response cleanup; remote work may remain accepted.
   * @returns Validated original queue and gateway task identities.
   */
  submit(this: void, request: VideoProjectRequest, submission: VideoProjectSubmission, signal: AbortSignal): Promise<VideoServerQueueItem>
  /**
   * Read the original deterministic queue identity without creating or dispatching work.
   * @param queueId - Original queue ID retained in the project.
   * @param request - Original request whose model and duration must match.
   * @param signal - Cancels the bounded read and awaits response cleanup.
   * @returns Validated queue facts, retaining unknown and observation timeout separately.
   */
  read(this: void, queueId: string, request: VideoProjectRequest, signal: AbortSignal): Promise<VideoServerQueueItem>
  /**
   * Cancel only the original not-yet-dispatched server queue item.
   * @param queueId - Original queue identity.
   * @param request - Original model and duration.
   * @param signal - Cancels the request without claiming that remote cancellation succeeded.
   * @returns A verified canceled, unsubmitted original item; dispatch conflicts remain failures.
   */
  cancel(this: void, queueId: string, request: VideoProjectRequest, signal: AbortSignal): Promise<VideoServerQueueItem>
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function safeTask(value: unknown): value is VideoServerGatewayTaskId {
  return typeof value === 'string' && TASK_ID.test(value) && !/^(?:sk-|nap_)/iu.test(value)
}
function queueAttempt(queueId: string): VideoProjectAttemptId | undefined {
  return queueId.startsWith('vq_') && UUID.test(queueId.slice(3)) ? queueId.slice(3) as VideoProjectAttemptId : undefined
}
function duration(request: VideoProjectRequest): number | undefined {
  const value = request.seconds
  const seconds = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9]\d{0,3}$/u.test(value) ? Number(value) : undefined
  if (seconds === undefined || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) return undefined
  if (request.duration !== undefined && request.duration !== seconds && request.duration !== String(seconds)) return undefined
  return seconds
}
function referenceUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value !== value.trim() || !value.startsWith('https://')) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
  } catch (_invalidReferenceUrl: unknown) { return false }
}
function references(value: unknown): boolean {
  if (Array.isArray(value)) return value.length <= 32 && value.every(references)
  if (typeof value === 'string') return referenceUrl(value)
  const nested = object(value)
  return nested !== undefined && Object.keys(nested).length === 1 && referenceUrl(nested.url)
}
function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 16) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 32_768 && !/^data:/iu.test(value.trim())
  if (Array.isArray(value)) return value.length <= 32 && value.every(child => safeJson(child, depth + 1))
  const source = object(value)
  if (source === undefined || Object.keys(source).length > 128) return false
  return Object.entries(source).every(([key, child]) => {
    const normalized = key.toLowerCase().replaceAll(/[_-]/gu, '')
    if (key.startsWith('_') || normalized.includes('base64') || normalized === 'b64json'
      || ['authorization', 'apikey', 'bearer', 'token', 'headers', 'base64', 'files'].includes(normalized)) return false
    if (['n', 'count', 'videocount', 'batchsize'].includes(normalized) && child !== 1) return false
    if (normalized === 'url' && !referenceUrl(child)) return false
    if (['firstframeimage', 'lastframeimage', 'referenceimages', 'referenceimage', 'referencevideo', 'referencevideos',
      'referenceaudio', 'referenceaudios', 'imageurl', 'videourl', 'audiourl'].includes(normalized) && !references(child)) return false
    return safeJson(child, depth + 1)
  })
}
function prepared(request: VideoProjectRequest, submission?: VideoProjectSubmission): boolean {
  const seconds = duration(request)
  if (seconds === undefined || typeof request.model !== 'string' || request.model.length < 1 || request.model.length > 191
    || request.model.trim() !== request.model || /[\u0000-\u0020\u007f]/u.test(request.model)
    || typeof request.prompt !== 'string' || request.prompt.trim() === '' || !safeJson(request)) return false
  if (submission !== undefined && (!UUID.test(submission.attemptId)
    || submission.durationSeconds !== seconds)) return false
  const body = { schema_version: 1, queue_id: submission === undefined ? '' : `vq_${submission.attemptId}`,
    operation_id: submission?.attemptId ?? '', count: 1, request }
  const pendingIdentityBytes = submission === undefined ? 39 + 36 : 0
  return Buffer.byteLength(JSON.stringify(body)) + pendingIdentityBytes <= BODY_LIMIT
}
function invalid(queueId?: string): VideoServerQueueError {
  return new VideoServerQueueError('VIDEO_QUEUE_RESPONSE_INVALID', '视频排队回执尚未通过核对；请保留原队列编号继续查询，不要重新生成。', queueId)
}

async function json(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  if (response.body === null) throw invalid()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let cancellation: Promise<void> | undefined
  const cancel = (): void => {
    cancellation ??= reader.cancel().catch((_closedReader: unknown) => { /* Original read failure remains authoritative. */ })
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    for (;;) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw invalid()
      chunks.push(chunk.value)
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    try { return JSON.parse(text) } catch (_invalidJson: unknown) { throw invalid() }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel(); await cancellation
    reader.releaseLock()
  }
}

function item(value: unknown, queueId: string, request: VideoProjectRequest): VideoServerQueueItem {
  const source = object(value)
  const data = object(source?.data)
  const recovery = object(source?.recovery)
  const attempt = queueAttempt(queueId)
  const seconds = duration(request)
  const states = ['queued', 'dispatching', 'running', 'unknown', 'canceled', 'failed', 'succeeded'] as const
  const submissions = ['not_submitted', 'dispatching', 'unknown', 'accepted'] as const
  if (attempt === undefined || seconds === undefined || source?.schema_version !== 1 || source.object !== 'video_queue_item'
    || source.accepted !== true || data?.id !== queueId || data.operation_id !== attempt || data.model !== request.model
    || data.count !== 1 || data.duration_seconds !== seconds || !safeTask(data.task_id)
    || typeof data.state !== 'string' || !states.some(state => state === data.state)
    || typeof data.submission_state !== 'string' || !submissions.some(state => state === data.submission_state)
    || typeof source.cancelable !== 'boolean' || typeof source.observation_timed_out !== 'boolean'
    || recovery?.method !== 'GET' || recovery.path !== `/v1/video/queue/${queueId}`
    || Object.keys(recovery).some(key => key !== 'method' && key !== 'path')
    || !Number.isSafeInteger(data.created_at) || Number(data.created_at) < 0
    || !Number.isSafeInteger(data.updated_at) || Number(data.updated_at) < Number(data.created_at)
    || Object.keys(source).some(key => !['schema_version', 'object', 'accepted', 'data', 'cancelable',
      'observation_timed_out', 'recovery'].includes(key))
    || data.error_code !== undefined && (typeof data.error_code !== 'string' || !/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(data.error_code))
    || data.failure_code !== undefined && (typeof data.failure_code !== 'string'
      || data.failure_code !== '' && !/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(data.failure_code))
    || data.failure_reason !== undefined && (typeof data.failure_reason !== 'string' || data.failure_reason.length > 4096)
    || Object.keys(data).some(key => !['id', 'operation_id', 'model', 'count', 'duration_seconds', 'task_id', 'state',
      'submission_state', 'error_code', 'failure_code', 'failure_reason', 'created_at', 'updated_at'].includes(key))) throw invalid(queueId)
  const state = states.find(state => state === data.state)
  const submissionState = submissions.find(state => state === data.submission_state)
  if (state === undefined || submissionState === undefined) throw invalid(queueId)
  if (state === 'queued' && (submissionState !== 'not_submitted' || !source.cancelable || source.observation_timed_out)
    || state === 'canceled' && (submissionState !== 'not_submitted' || source.cancelable || source.observation_timed_out)
    || state === 'running' && submissionState !== 'accepted'
    || state === 'succeeded' && (submissionState !== 'accepted' || source.observation_timed_out)
    || state === 'failed' && (submissionState !== 'not_submitted' && submissionState !== 'accepted' || source.observation_timed_out)
    || state === 'dispatching' && submissionState !== 'dispatching' && submissionState !== 'unknown'
    || state === 'unknown' && submissionState !== 'unknown'
    || state !== 'queued' && source.cancelable
    || source.observation_timed_out && state !== 'dispatching' && state !== 'unknown') throw invalid(queueId)
  const failure = accountBalanceFailure(data.failure_code ?? data.error_code)
  return { queueId: queueId as VideoServerQueueId, operationId: attempt, model: String(data.model), count: 1, durationSeconds: seconds,
    gatewayTaskId: data.task_id, state, submissionState, cancelable: source.cancelable,
    observationTimedOut: source.observation_timed_out, createdAt: Number(data.created_at), updatedAt: Number(data.updated_at),
    ...failure === undefined ? {} : { failure } }
}

function createQueueClient(options: VideoServerQueueOptions) {
  const origin = normalizeApiBaseUrl(options.origin)
  const transport = options.fetch ?? globalThis.fetch
  const fetchJson = async (path: string, method: 'GET' | 'POST', operationSignal: AbortSignal, body?: string, privateRead = true,
    started?: () => void) => {
    const requestSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(options.timeoutMs)])
    requestSignal.throwIfAborted()
    const key = privateRead ? await options.key() : undefined
    requestSignal.throwIfAborted()
    const url = apiUrl(origin, path)
    started?.()
    const response = await transport(url, { method, redirect: 'error', signal: requestSignal,
      headers: { accept: 'application/json', ...key === undefined ? {} : { authorization: `Bearer ${key}` },
        ...!privateRead || options.clientSource === undefined ? {} : { 'x-yunshu-client': options.clientSource },
        ...body === undefined ? {} : { 'content-type': 'application/json' } }, ...body === undefined ? {} : { body } })
    if (!privateRead && response.status === 404
      || privateRead && method === 'GET' && (response.status === 408 || response.status === 429 || response.status >= 500)) {
      await response.body?.cancel().catch((_closedBody: unknown) => { /* The original response status remains authoritative. */ })
      return { status: response.status, value: undefined }
    }
    const value = await json(response, requestSignal, privateRead ? BODY_LIMIT : STATUS_LIMIT)
    return { status: response.status, value }
  }
  const gatewayTasks = new Map<string, string>()
  const observe = (value: unknown, queueId: string, request: VideoProjectRequest): VideoServerQueueItem => {
    const result = item(value, queueId, request)
    const previous = gatewayTasks.get(queueId)
    if (previous !== undefined && previous !== result.gatewayTaskId) throw invalid(queueId)
    gatewayTasks.set(queueId, result.gatewayTaskId)
    return result
  }
  const read = async (queueId: string, request: VideoProjectRequest, operationSignal: AbortSignal): Promise<VideoServerQueueItem> => {
    if (queueAttempt(queueId) === undefined || !prepared(request)) throw invalid(queueId)
    try {
      const result = await fetchJson(`/v1/video/queue/${queueId}`, 'GET', operationSignal)
      if (result.status === 408 || result.status === 429 || result.status >= 500) {
        throw new VideoServerQueueError('VIDEO_QUEUE_READ_UNAVAILABLE', '原视频队列状态暂不可用，请保留队列编号稍后继续查询；不会重新提交。', queueId)
      }
      if (result.status !== 200) {
        const failure = isAccountBalanceRejection(result.value, result.status) ? accountBalanceFailure('insufficient_user_quota') : undefined
        if (failure !== undefined) throw new VideoServerQueueError(failure.code,
          `${failure.message}；原视频队列状态尚未确认，请保留原编号继续查询，不要重新生成。`, queueId, failure)
        throw invalid(queueId)
      }
      return observe(result.value, queueId, request)
    } catch (error) {
      operationSignal.throwIfAborted()
      if (error instanceof VideoServerQueueError) throw error
      throw new VideoServerQueueError('VIDEO_QUEUE_READ_UNAVAILABLE', '暂时无法读取原视频队列，请保留队列编号稍后继续查询；不会重新提交。', queueId)
    }
  }
  const queue: VideoServerQueue = {
    pollIntervalMs: CAPABILITY.poll_interval_seconds * 1000,
    supports: (request, submission) => prepared(request, submission),
    async submit(request, submission, operationSignal) {
      if (!prepared(request, submission)) {
        throw new VideoServerQueueError('VIDEO_QUEUE_REQUEST_UNSUPPORTED', '当前参考素材或视频参数不支持服务端排队，尚未提交；请使用已支持的上传素材或核对参数。')
      }
      const queueId = `vq_${submission.attemptId}`
      const dispatch = { started: false }
      try {
        operationSignal.throwIfAborted()
        const result = await fetchJson(CAPABILITY.create_path, 'POST', operationSignal,
          JSON.stringify({ schema_version: 1, queue_id: queueId, operation_id: submission.attemptId, count: 1, request }), true,
          () => { dispatch.started = true })
        if (result.status !== 200 && result.status !== 202) {
          const failure = isAccountBalanceRejection(result.value, result.status) ? accountBalanceFailure('insufficient_user_quota') : undefined
          if (failure !== undefined) throw new VideoServerQueueError(failure.code, failure.message, queueId, failure)
          throw invalid(queueId)
        }
        return observe(result.value, queueId, request)
      } catch (error) {
        let failure = error instanceof VideoServerQueueError ? error.failure : undefined
        if (!dispatch.started) throw new VideoServerQueueError('VIDEO_QUEUE_SUBMISSION_NOT_STARTED',
          '视频尚未发送，请检查当前登录和连接后再恢复原项目；本次没有提交新的生成请求。')
        if (!operationSignal.aborted) {
          try { return await read(queueId, request, operationSignal) }
          catch (unconfirmedOriginal: unknown) {
            if (failure === undefined && unconfirmedOriginal instanceof VideoServerQueueError) failure = unconfirmedOriginal.failure
          }
        }
        throw new VideoServerQueueError(failure?.code ?? 'VIDEO_QUEUE_SUBMISSION_UNKNOWN',
          (failure === undefined ? '' : `${failure.message}；`)
            + '视频排队受理结果尚未确认；请保留原队列编号，仅查询原队列，不要重新生成。', queueId, failure)
      }
    },
    read,
    async cancel(queueId, request, operationSignal) {
      if (queueAttempt(queueId) === undefined || !prepared(request)) throw invalid(queueId)
      try {
        const result = await fetchJson(`/v1/video/queue/${queueId}/cancel`, 'POST', operationSignal)
        if (result.status === 409) {
          if (object(object(result.value)?.error)?.code !== 'video_queue_already_dispatching') throw invalid(queueId)
          throw new VideoServerQueueError('VIDEO_QUEUE_ALREADY_DISPATCHING', '该视频已进入派发或生成，未确认取消；原任务可能继续运行和计费，请继续查询原队列。', queueId)
        }
        if (result.status !== 200) throw invalid(queueId)
        const canceled = observe(result.value, queueId, request)
        if (canceled.state !== 'canceled' || canceled.submissionState !== 'not_submitted') throw invalid(queueId)
        return canceled
      } catch (error) {
        operationSignal.throwIfAborted()
        if (error instanceof VideoServerQueueError) throw error
        throw new VideoServerQueueError('VIDEO_QUEUE_CANCEL_UNCONFIRMED', '视频队列取消结果尚未确认；请继续查询原队列，不要据此重新生成或认定已退款。', queueId)
      }
    },
  }
  return { queue, fetchJson }
}

/** Read and cancel an original queue without discovering or enabling any new admission capability. */
export type VideoServerQueueRecovery = Pick<VideoServerQueue, 'pollIntervalMs' | 'read' | 'cancel'>

/**
 * Bind fixed same-origin recovery routes even when new server admissions are disabled.
 * @param options - Original API root, bounded I/O and current account credential resolver.
 * @returns Only original-ID reads and cancellation; no create POST is exposed.
 */
export function bindVideoServerQueueRecovery(options: VideoServerQueueOptions): VideoServerQueueRecovery {
  const { queue } = createQueueClient(options)
  return { pollIntervalMs: queue.pollIntervalMs, read: queue.read, cancel: queue.cancel }
}

/**
 * Discover exact server queue support once; missing or disabled capabilities safely retain the legacy path.
 * @param options - API root, bounded I/O and current account credential resolver.
 * @param signal - Cancels discovery and awaits its response reader cleanup.
 * @returns Supported queue operations, otherwise undefined; discovery never starts background polling.
 */
export async function discoverVideoServerQueue(options: VideoServerQueueOptions,
  signal: AbortSignal): Promise<VideoServerQueue | undefined> {
  const { queue, fetchJson } = createQueueClient(options)
  try {
    const result = await fetchJson('/api/status', 'GET', signal, undefined, false)
    signal.throwIfAborted()
    if (result.status === 404) return undefined
    if (result.status !== 200) {
      throw new VideoServerQueueError('VIDEO_QUEUE_CAPABILITY_UNAVAILABLE', '无法核实视频排队服务能力，尚未提交；请恢复连接或登录后重试。')
    }
    const status = object(result.value)
    const data = object(status?.data)
    if (data === undefined) throw invalid()
    if (!Object.hasOwn(data, 'video_queue')) return undefined
    const capability = object(data.video_queue)
    if (capability?.enabled === false) return undefined
    if (capability === undefined || Object.keys(capability).length !== Object.keys(CAPABILITY).length
      || Object.entries(CAPABILITY).some(([key, expected]) => capability[key] !== expected)) {
      throw new VideoServerQueueError('VIDEO_QUEUE_CAPABILITY_INVALID', '视频排队服务配置无法核对，尚未提交；请联系管理员核对服务版本。')
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof VideoServerQueueError && error.code.startsWith('VIDEO_QUEUE_CAPABILITY_')) throw error
    throw new VideoServerQueueError('VIDEO_QUEUE_CAPABILITY_UNAVAILABLE', '无法完整读取视频排队服务能力，尚未提交；请检查连接后重试。')
  }
  return queue
}
