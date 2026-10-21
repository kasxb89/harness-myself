/** One video submission with durable acceptance and read-only recovery. @module */
import { setTimeout as delay } from 'node:timers/promises'
import type { CreativeVideoReceipt } from './creative-types.ts'
import { isAccountBalanceRejectionText } from './account-balance.ts'

/** Local waiting never implies that an accepted remote task stopped. */
export interface VideoTaskOutcome {
  ok: boolean
  submissionState: 'not-submitted' | 'pending' | 'unknown' | 'failed' | 'completed'
  model: string
  code?: string
  message?: string
  videoReceipt?: CreativeVideoReceipt
  taskId?: string
  requestId?: string
  path?: string
}

/** Account-owned I/O boundaries; only submit may create a billable request. */
export interface VideoTaskOptions {
  model: string
  route: string
  backendFingerprint: string
  signal: AbortSignal
  submitTimeoutMs: number
  taskTimeoutMs: number
  queryTimeoutMs: number
  pollIntervalMs: number
  prepare?(signal: AbortSignal): Promise<void>
  submitting?(): Promise<void>
  received?(receipt: CreativeVideoReceipt): Promise<void>
  resumeReceipt?: CreativeVideoReceipt
  submit(signal: AbortSignal): Promise<Response>
  read(taskId: string, signal: AbortSignal): Promise<Response>
  save(taskId: string, signal: AbortSignal): Promise<string>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
    && !/^(?:sk-|nap_)/iu.test(value) ? value : undefined
}
function status(value: Record<string, unknown> | undefined): string | undefined {
  const field = value?.status ?? value?.task_status ?? record(value?.data)?.status ?? record(value?.data)?.task_status
  return typeof field === 'string' ? field.toLowerCase() : undefined
}

/**
 * Persist before dispatch and before the first status read. Recovery never calls submit.
 * @param options - Account-bound HTTP, save and receipt operations with complete deadlines.
 * @returns A saved path or a retained pending/unknown receipt safe to query again.
 */
export async function executeVideoTask(options: VideoTaskOptions): Promise<VideoTaskOutcome> {
  let receipt = options.resumeReceipt
  let sent = receipt !== undefined
  let path: string | undefined
  let unread: Response | undefined
  const budget = AbortSignal.timeout(options.taskTimeoutMs)
  const signal = AbortSignal.any([options.signal, budget])
  const outcome = (submissionState: VideoTaskOutcome['submissionState'], code?: string, message?: string): VideoTaskOutcome => ({
    ok: submissionState === 'completed', submissionState, model: receipt?.model ?? options.model,
    ...code === undefined ? {} : { code }, ...message === undefined ? {} : { message },
    ...receipt === undefined ? {} : { videoReceipt: receipt, ...receipt.taskId === undefined ? {} : { taskId: receipt.taskId },
      ...receipt.requestId === undefined ? {} : { requestId: receipt.requestId } }, ...path === undefined ? {} : { path },
  })
  const persist = async (next: CreativeVideoReceipt): Promise<void> => { receipt = next; await options.received?.(next) }
  const currentReceipt = (): CreativeVideoReceipt => {
    if (receipt === undefined) throw new Error('Video execution has no retained receipt')
    return receipt
  }
  if (receipt !== undefined && receipt.backendFingerprint !== options.backendFingerprint) {
    return outcome('pending', 'VIDEO_BACKEND_CHANGED', '原视频任务所属服务已变化，请恢复原服务配置后查询；不会重新提交生成。')
  }
  if (receipt !== undefined && receipt.taskId === undefined) return outcome('unknown', 'VIDEO_SUBMISSION_UNKNOWN', '原视频提交尚无可查询任务编号，请先核对任务与计费；不会重新生成。')
  try {
    signal.throwIfAborted()
    await options.prepare?.(signal)
    signal.throwIfAborted()
    if (receipt === undefined) {
      await options.submitting?.()
      signal.throwIfAborted()
      await persist({ model: options.model, route: options.route, backendFingerprint: options.backendFingerprint, phase: 'submitting' })
      signal.throwIfAborted()
      sent = true
      unread = await options.submit(AbortSignal.any([signal, AbortSignal.timeout(options.submitTimeoutMs)]))
      const requestId = identifier(unread.headers.get('x-oneapi-request-id')) ?? identifier(unread.headers.get('x-request-id'))
      if (requestId !== undefined) await persist({ ...currentReceipt(), requestId })
      const response = unread
      const text = await response.text()
      unread = undefined
      let body: Record<string, unknown> | undefined
      try { body = record(JSON.parse(text)) } catch (_invalidResponse: unknown) { /* An unreadable response cannot disprove acceptance. */ }
      const nested = record(body?.data)
      const taskId = identifier(body?.task_id) ?? identifier(body?.id) ?? identifier(nested?.task_id) ?? identifier(nested?.id)
      if (taskId !== undefined) await persist({ ...currentReceipt(), taskId, phase: 'accepted' })
      if (!response.ok) {
        if (taskId !== undefined) return outcome('pending', 'VIDEO_QUERY_PENDING', '原视频任务已受理，请继续查询原任务，不要重复生成。')
        const balance = isAccountBalanceRejectionText(text, response.status)
        if (balance) return outcome('unknown', 'INSUFFICIENT_BALANCE', '余额不足，请充值；提交结果尚未确认，请先检查已有任务，不要重复提交。')
        return response.status >= 400 && response.status < 500 && response.status !== 408
          ? outcome('failed', `HTTP_${String(response.status)}`, '视频请求未被接受，请检查登录状态、素材和模型要求。')
          : outcome('unknown', 'VIDEO_SUBMISSION_UNKNOWN', '视频提交结果尚未确认，请先核对原任务与计费，不要重复生成。')
      }
    }
    const taskId = receipt?.taskId
    if (taskId === undefined) return outcome('unknown', 'NO_TASK_ID', '视频提交已发出，尚未获得可查询任务编号，请先核对原任务与计费，不要重复生成。')
    let first = true
    for (;;) {
      signal.throwIfAborted()
      if (!first) await delay(options.pollIntervalMs, undefined, { signal })
      first = false
      const response = await options.read(taskId, AbortSignal.any([signal, AbortSignal.timeout(options.queryTimeoutMs)]))
      unread = response
      const text = await response.text()
      unread = undefined
      if (!response.ok) return outcome('pending', 'VIDEO_QUERY_UNAVAILABLE', '原视频已受理，当前无法读取状态；请稍后查询原任务，不要重复生成。')
      let body: Record<string, unknown> | undefined
      try { body = record(JSON.parse(text)) } catch (_invalidResponse: unknown) { /* Retain acceptance and stop uncertain polling. */ }
      signal.throwIfAborted()
      const state = status(body)
      if (['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled'].includes(state ?? '')) {
        return outcome('failed', 'TASK_FAILED', '原视频任务已结束且未成功，请检查原任务和计费记录。')
      }
      if (['succeed', 'succeeded', 'success', 'completed'].includes(state ?? '')) {
        path = await options.save(taskId, signal)
        signal.throwIfAborted()
        await persist({ ...currentReceipt(), phase: 'completed' })
        return outcome('completed')
      }
      if (!['not_start', 'pending', 'queued', 'running', 'processing', 'in_progress', 'in_queue', 'created', 'submitted', 'generating'].includes(state ?? '')) {
        return outcome('pending', 'VIDEO_STATUS_INVALID', '原视频状态暂时无法确认，请保留回执并继续查询原任务，不要重复生成。')
      }
    }
  } catch (_stopped: unknown) {
    if (!sent) return outcome('not-submitted', 'VIDEO_PREPARATION_FAILED', '视频尚未提交，请检查素材或保存位置。')
    if (receipt?.taskId !== undefined) return outcome('pending', budget.aborted ? 'VIDEO_TASK_TIMEOUT' : options.signal.aborted ? 'VIDEO_WAIT_STOPPED' : 'VIDEO_QUERY_UNAVAILABLE', '原视频任务已受理，本机等待或保存已停止；上游仍可能继续运行和计费，请查询原任务，不要重新生成。')
    return outcome('unknown', 'VIDEO_SUBMISSION_UNKNOWN', '视频提交结果尚未确认，请先核对原任务与计费，不要重复生成。')
  } finally {
    await unread?.body?.cancel().catch((_closedBody: unknown) => { /* Completion or cancellation already released the response. */ })
  }
}
