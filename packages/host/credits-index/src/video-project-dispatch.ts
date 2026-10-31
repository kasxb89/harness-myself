/** Select one project admission transport while recovering every original task by its fixed identity. @module */
import type { VideoProjectProvider, VideoProjectRequest } from './video-project-types.ts'
import { VideoRelayError, type VideoProjectRelay } from './video-project-provider.ts'
import {
  bindVideoServerQueueRecovery, discoverVideoServerQueue, VideoServerQueueError,
  type VideoServerQueue, type VideoServerQueueItem, type VideoServerQueueOptions,
} from './video-server-queue.ts'

/** Project-only task operations, independent of planning, credentials and local composition. */
export type VideoProjectDispatch = Required<Pick<VideoProjectProvider,
  'submissionMode' | 'pollIntervalMs' | 'prepareSubmissions' | 'submit' | 'check' | 'cancel' | 'download'>>

/** Current account-bound transports and exact legacy route lookup for new submissions. */
export interface VideoProjectDispatchOptions {
  /** Existing same-origin task and content relay. */
  readonly relay: VideoProjectRelay
  /** Fixed API root and original login checks for every queue operation. */
  readonly queue: VideoServerQueueOptions
  /** Resolve a model route only for new legacy work or noncanonical historical task IDs. */
  route(request: VideoProjectRequest): Promise<string>
}

/**
 * Bind original task reads independently from availability of new server queue admission.
 * @param options - Current account transports; keys never enter the returned project records.
 * @returns One project transport chosen before its first POST, with no fallback after queue submission starts.
 */
export function createVideoProjectDispatch(options: VideoProjectDispatchOptions): VideoProjectDispatch {
  const recovery = bindVideoServerQueueRecovery(options.queue)
  let queue: VideoServerQueue | undefined
  let prepared = false
  let eligible = true
  let recoveringQueue = false
  return {
    get submissionMode() { return prepared && eligible && queue !== undefined ? 'queued' : undefined },
    get pollIntervalMs() {
      return eligible && queue !== undefined ? queue.pollIntervalMs : recoveringQueue ? recovery.pollIntervalMs : undefined
    },
    async prepareSubmissions(requests, signal) {
      if (!prepared) {
        try { queue = await discoverVideoServerQueue(options.queue, signal) }
        catch (error) {
          if (error instanceof VideoServerQueueError) throw new VideoRelayError(error.code, error.message, { cause: error })
          throw error
        }
      }
      const discovered = queue
      eligible = eligible && (discovered === undefined || requests.every(request => discovered.supports(request)))
      prepared = true
    },
    async submit(request, signal, submission) {
      if (!prepared) throw new VideoRelayError('VIDEO_REQUEST_INVALID', '视频提交方式尚未核对，未提交新的生成请求。')
      if (!eligible || queue === undefined) return options.relay.submit(request, await options.route(request), signal)
      if (submission === undefined || !queue.supports(request, submission)) {
        throw new VideoRelayError('VIDEO_REQUEST_INVALID', '视频排队参数尚未核对，未提交新的生成请求。')
      }
      try {
        const item = await queue.submit(request, submission, signal)
        return { taskId: item.queueId }
      } catch (error) {
        if (error instanceof VideoServerQueueError && error.code === 'VIDEO_QUEUE_SUBMISSION_NOT_STARTED') {
          throw new VideoRelayError('VIDEO_SUBMIT_NOT_STARTED', error.message, { cause: error })
        }
        if (error instanceof VideoServerQueueError && error.queueId !== undefined) {
          throw new VideoRelayError(error.failure?.code ?? 'VIDEO_SUBMIT_UNKNOWN',
            (error.failure === undefined ? '' : `${error.failure.message}；`)
              + '原视频排队回执尚未确认，已保留原队列编号；请继续查询原项目，不要重新生成。', { taskId: error.queueId, cause: error })
        }
        throw error
      }
    },
    async check(taskId, request, signal) {
      if (!taskId.startsWith('vq_')) {
        // A saved gateway task remains readable after its model disappears from the new-work catalog.
        const route = /^task_[A-Za-z0-9]{32}$/u.test(taskId) ? '/v1/tasks' : await options.route(request)
        return options.relay.check(taskId, route, signal, typeof request.model === 'string' ? request.model : undefined)
      }
      recoveringQueue = true
      let item: VideoServerQueueItem
      try { item = await (queue ?? recovery).read(taskId, request, signal) }
      catch (error) {
        if (error instanceof VideoServerQueueError) {
          throw new VideoRelayError(error.failure?.code
            ?? (error.code === 'VIDEO_QUEUE_READ_UNAVAILABLE' ? 'VIDEO_READ_UNAVAILABLE' : 'VIDEO_STATUS_INVALID'),
          (error.failure === undefined ? '' : `${error.failure.message}；`)
            + '原视频队列状态暂未确认；请保留原编号继续查询，不要重新生成。', { taskId, cause: error })
        }
        throw error
      }
      if (item.observationTimedOut || item.submissionState === 'unknown' || item.state === 'unknown') {
        throw new VideoRelayError(item.failure?.code ?? 'VIDEO_READ_UNAVAILABLE',
          (item.failure === undefined ? '' : `${item.failure.message}；`)
            + '原视频任务仍需核对，状态查询超时不代表生成失败；请保留原编号，不要重新生成。', { taskId })
      }
      if (item.state === 'queued' || item.state === 'dispatching') return { status: 'queued' }
      if (item.state === 'running') return { status: 'running' }
      if (item.state === 'succeeded') return { status: 'succeeded' }
      if (item.state === 'failed' && item.failure !== undefined) return { status: 'failed', ...item.failure }
      return { status: 'failed', message: item.state === 'canceled' ? '原队列任务已在发送上游前取消。' : '原视频任务已由服务器确认未完成；保留原任务记录。' }
    },
    async cancel(taskId, request, signal) {
      if (!taskId.startsWith('vq_')) return { canceled: false }
      const item = await (queue ?? recovery).cancel(taskId, request, signal)
      return { canceled: item.state === 'canceled' && item.submissionState === 'not_submitted' }
    },
    async download(taskId, request, destination, signal) {
      if (!taskId.startsWith('vq_')) return options.relay.download(taskId, destination, signal)
      const item = await (queue ?? recovery).read(taskId, request, signal)
      if (item.state !== 'succeeded' || item.submissionState !== 'accepted' || item.observationTimedOut) {
        throw new VideoRelayError('VIDEO_STATUS_INVALID', '原视频尚无可确认的完成记录，请继续查询原项目。', { taskId })
      }
      await options.relay.download(item.gatewayTaskId, destination, signal)
    },
  }
}
