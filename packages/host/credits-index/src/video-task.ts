/** One video submission with durable acceptance and read-only recovery. @module */
import { setTimeout as delay } from 'node:timers/promises'
import type { ArtifactOrigin } from '@deepseek-ai/dsh-artifacts-index'
import type { CreativeVideoReceipt } from './creative-types.ts'
import { accountBalanceFailure, isAccountBalanceRejectionText } from './account-balance.ts'
import { hasMediaSubmissionReceipt, mediaSubmissionTaskId, hasMediaSubmissionUnknown, mediaSubmissionUnknownTaskId } from './media-submission-receipt.ts'
import {
  h3SubmissionRejection, h3SubmissionQueryRejection, hasH3SubmissionReceipt, h3ProviderTerminalRejection, hasH3ProviderTerminal,
  VideoSubmissionRejection,
} from './video-submission-result.ts'
import { creationTaskActivity } from './creation-activity.ts'
import type { CreationActivityOutcome, CreationTaskObserver } from './creation-activity.ts'

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
  /** Content-free local phases; ending local observation does not stop an accepted remote task. */
  activity?: CreationTaskObserver
  origin?: ArtifactOrigin
  model: string
  route: string
  backendFingerprint: string
  signal: AbortSignal
  submitTimeoutMs: number
  taskTimeoutMs: number
  /** Optional foreground status-read budget after acceptance; never limits submission or saving. */
  foregroundWaitMs?: number
  queryTimeoutMs: number
  pollIntervalMs: number
  queryRetryLimit: number
  prepare?(this: void, signal: AbortSignal): Promise<void>
  submitting?(this: void): Promise<void>
  /** Last local validation after the receipt is durable and before a POST has begun. */
  beforeSubmit?(this: void, signal: AbortSignal): Promise<void>
  received?(this: void, receipt: CreativeVideoReceipt): Promise<void>
  resumeReceipt?: CreativeVideoReceipt
  submit(this: void, signal: AbortSignal): Promise<Response>
  read(this: void, taskId: string, signal: AbortSignal, canonical?: boolean): Promise<Response>
  save(this: void, taskId: string, signal: AbortSignal): Promise<string>
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

function progress(value: string | undefined): 'queued' | 'generating' | undefined {
  if (['not_start', 'pending', 'queued', 'in_queue', 'created', 'submitted'].includes(value ?? '')) return 'queued'
  if (['running', 'processing', 'in_progress', 'generating'].includes(value ?? '')) return 'generating'
  return undefined
}

async function readText(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const stop = (): void => {
    void reader.cancel(signal.reason).catch((_closedBody: unknown) => { /* The original read still reports cancellation. */ })
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    signal.throwIfAborted()
    let text = ''
    for (;;) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) return text + decoder.decode()
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    signal.removeEventListener('abort', stop)
    reader.releaseLock()
  }
}

/**
 * Persist before dispatch and before the first status read. Recovery never calls submit.
 * @param options - Account-bound HTTP, save and receipt operations with complete deadlines.
 * @returns A saved path or a retained pending/unknown receipt safe to query again.
 */
export async function executeVideoTask(options: VideoTaskOptions): Promise<VideoTaskOutcome> {
  const activity = creationTaskActivity(options.activity)
  let activityOutcome: CreationActivityOutcome = 'unknown'
  let receipt = options.resumeReceipt
  let canonicalRead = receipt?.taskId?.startsWith('task_') === true
  let sent = receipt !== undefined
  let path: string | undefined
  let unread: Response | undefined
  let phase: 'preparing' | 'submitting' | 'querying' | 'saving' | 'receipt' = 'preparing'
  const currentPhase = (): typeof phase => phase
  const budget = AbortSignal.timeout(options.taskTimeoutMs)
  const signal = AbortSignal.any([options.signal, budget])
  let foreground: AbortSignal | undefined
  let waitingSignal = signal
  let lastProgress: 'queued' | 'generating' | undefined
  const outcome = (submissionState: VideoTaskOutcome['submissionState'], code?: string, message?: string): VideoTaskOutcome => {
    activityOutcome = submissionState === 'completed' ? 'completed' : submissionState === 'failed' ? 'failed'
      : submissionState === 'not-submitted' ? 'stopped' : 'unknown'
    if (activityOutcome === 'unknown') activity.stage('unknown')
    return {
      ok: submissionState === 'completed', submissionState, model: receipt?.model ?? options.model,
      ...code === undefined ? {} : { code }, ...message === undefined ? {} : { message },
      ...receipt === undefined ? {} : { videoReceipt: receipt, ...receipt.taskId === undefined ? {} : { taskId: receipt.taskId },
        ...receipt.requestId === undefined ? {} : { requestId: receipt.requestId } }, ...path === undefined ? {} : { path },
    }
  }
  const persist = async (next: CreativeVideoReceipt): Promise<void> => {
    receipt = next
    const previous = phase
    phase = 'receipt'
    await options.received?.(next)
    phase = previous
    if (next.phase === 'accepted') activity.stage('accepted')
  }
  const currentReceipt = (): CreativeVideoReceipt => {
    if (receipt === undefined) throw new Error('Video execution has no retained receipt')
    return receipt
  }
  const read = async (taskId: string): Promise<{ response: Response; text: string } | undefined> => {
    for (let failures = 0; ; failures += 1) {
      waitingSignal.throwIfAborted()
      try {
        const querySignal = AbortSignal.any([waitingSignal, AbortSignal.timeout(options.queryTimeoutMs)])
        const response = canonicalRead || currentReceipt().route === '/v1/tasks'
          ? await options.read(taskId, querySignal, true) : await options.read(taskId, querySignal)
        unread = response
        if (response.status !== 408 && response.status !== 429 && response.status < 500) {
          const text = await readText(response, querySignal)
          unread = undefined
          return { response, text }
        }
      } catch (error) {
        if (waitingSignal.aborted) throw error
        // Only original-task GET failures may consume the finite retry budget.
      } finally {
        await unread?.body?.cancel().catch((_closedBody: unknown) => { /* The failed read already closed its response. */ })
        unread = undefined
      }
      if (failures >= options.queryRetryLimit) return undefined
      await delay(Math.min(options.pollIntervalMs * 2 ** failures, 30_000), undefined, { signal: waitingSignal })
    }
  }
  if (receipt !== undefined && receipt.backendFingerprint !== options.backendFingerprint) {
    const result = outcome('pending', 'VIDEO_BACKEND_CHANGED', '原视频任务所属服务已变化，请恢复原服务配置后查询；不会重新提交生成。')
    activity.end(activityOutcome)
    return result
  }
  if (receipt !== undefined && receipt.taskId === undefined) {
    const result = outcome('unknown', 'VIDEO_SUBMISSION_UNKNOWN', '原视频提交尚无可查询任务编号，请先核对任务与计费；不会重新生成。')
    activity.end(activityOutcome)
    return result
  }
  try {
    activity.stage('preparing')
    signal.throwIfAborted()
    await options.prepare?.(signal)
    signal.throwIfAborted()
    if (receipt === undefined) {
      await options.submitting?.()
      signal.throwIfAborted()
      await persist({ model: options.model, route: options.route, backendFingerprint: options.backendFingerprint, phase: 'submitting',
        ...options.origin === undefined ? {} : { origin: options.origin } })
      signal.throwIfAborted()
      await options.beforeSubmit?.(signal)
      signal.throwIfAborted()
      phase = 'submitting'
      sent = true
      activity.stage('submitting')
      unread = await options.submit(AbortSignal.any([signal, AbortSignal.timeout(options.submitTimeoutMs)]))
      const requestId = identifier(unread.headers.get('x-oneapi-request-id')) ?? identifier(unread.headers.get('x-request-id'))
      if (requestId !== undefined) await persist({ ...currentReceipt(), requestId })
      const response = unread
      const text = await response.text()
      unread = undefined
      let body: Record<string, unknown> | undefined
      try { body = record(JSON.parse(text)) } catch (_invalidResponse: unknown) { /* An unreadable response cannot disprove acceptance. */ }
      const nested = record(body?.data)
      const marked = hasMediaSubmissionReceipt(body)
      const uncertain = hasMediaSubmissionUnknown(body)
      const canonicalId = uncertain ? mediaSubmissionUnknownTaskId(options.model, 'video', response.status, body) : undefined
      const taskId = marked ? mediaSubmissionTaskId(options.model, 'video', body) : uncertain ? canonicalId
        : identifier(body?.task_id) ?? identifier(body?.id) ?? identifier(nested?.task_id) ?? identifier(nested?.id)
      const rejection = h3SubmissionRejection(options.model, response.status, body)
      if (rejection?.submissionState === 'not_submitted' && rejection.taskId !== undefined) {
        await persist({ ...currentReceipt(), taskId: rejection.taskId })
        return outcome('failed', rejection.code, rejection.message)
      }
      if (taskId !== undefined) {
        canonicalRead = marked || canonicalId !== undefined
        await persist({ ...currentReceipt(), taskId, phase: 'accepted' })
        lastProgress = progress(status(body))
      }
      // This HTTP attempt occurred: "not-submitted" is reserved for preparation before dispatch.
      if (rejection !== undefined) return outcome('failed', rejection.code, rejection.message)
      if (marked) return outcome(taskId === undefined ? 'unknown' : 'pending',
        taskId === undefined ? 'VIDEO_SUBMISSION_UNKNOWN' : 'VIDEO_STATUS_INVALID',
        '原视频回执尚未通过完整核对，请保留已有任务与计费记录，不要重新生成。')
      if (uncertain && canonicalId === undefined) return outcome('unknown', 'VIDEO_SUBMISSION_UNKNOWN',
        '视频提交结果尚未确认，请先核对原任务与计费，不要重复生成。')
      if (!response.ok) {
        const balance = isAccountBalanceRejectionText(text, response.status)
        if (taskId !== undefined) return outcome('pending', balance ? 'INSUFFICIENT_BALANCE' : 'VIDEO_QUERY_PENDING',
          (balance ? '余额不足，请充值；' : '') + '原视频任务已受理，请继续查询原任务，不要重复生成。')
        if (balance) return outcome('unknown', 'INSUFFICIENT_BALANCE', '余额不足，请充值；提交结果尚未确认，请先检查已有任务，不要重复提交。')
        return options.model !== 'MiniMax-H3' && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
          ? outcome('failed', `HTTP_${String(response.status)}`, '视频请求未被接受，请检查登录状态、素材和模型要求。')
          : outcome('unknown', 'VIDEO_SUBMISSION_UNKNOWN', '视频提交结果尚未确认，请先核对原任务与计费，不要重复生成。')
      }
    }
    const taskId = receipt?.taskId
    if (taskId === undefined) return outcome('unknown', 'NO_TASK_ID', '视频提交已发出，尚未获得可查询任务编号，请先核对原任务与计费，不要重复生成。')
    if (options.foregroundWaitMs !== undefined) {
      foreground = AbortSignal.timeout(options.foregroundWaitMs)
      waitingSignal = AbortSignal.any([signal, foreground])
    }
    phase = 'querying'
    activity.stage('accepted')
    let first = true
    for (;;) {
      waitingSignal.throwIfAborted()
      if (!first) await delay(options.pollIntervalMs, undefined, { signal: waitingSignal })
      first = false
      const reply = await read(taskId)
      if (reply === undefined) return outcome('pending', 'VIDEO_QUERY_UNAVAILABLE', '原视频已受理，当前无法读取状态；请稍后查询原任务，不要重复生成。')
      const { response, text } = reply
      if (!response.ok) return isAccountBalanceRejectionText(text, response.status)
        ? outcome('pending', 'INSUFFICIENT_BALANCE', '余额不足，请充值；原视频状态尚未确认，请继续查询原任务，不要重复生成。')
        : outcome('pending', 'VIDEO_QUERY_UNAVAILABLE', '原视频已受理，当前无法读取状态；请稍后查询原任务，不要重复生成。')
      let body: Record<string, unknown> | undefined
      try { body = record(JSON.parse(text)) } catch (_invalidResponse: unknown) { /* Retain acceptance and stop uncertain polling. */ }
      waitingSignal.throwIfAborted()
      const rejection = h3SubmissionQueryRejection(currentReceipt().model, response.status, body, taskId)
      if (rejection !== undefined) return outcome('failed', rejection.code, rejection.message)
      const terminal = h3ProviderTerminalRejection(currentReceipt().model, response.status, body, taskId)
      if (terminal !== undefined) return outcome('failed', terminal.code === 'INSUFFICIENT_BALANCE' ? terminal.code : 'TASK_FAILED', terminal.message)
      if (hasMediaSubmissionReceipt(body) || hasMediaSubmissionUnknown(body) || currentReceipt().model === 'MiniMax-H3' && (hasH3SubmissionReceipt(body) || hasH3ProviderTerminal(body))) {
        return outcome('pending', 'VIDEO_STATUS_INVALID', '原视频回执尚未通过完整核对，请保留原任务编号，不要重新生成。')
      }
      const state = status(body)
      if (['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled'].includes(state ?? '')) {
        const balance = accountBalanceFailure(body?.failure_code ?? record(body?.data)?.failure_code)
        if (currentReceipt().model === 'MiniMax-H3') {
          if (balance !== undefined) return outcome('pending', balance.code,
            `${balance.message}；原视频失败状态尚待完整核对，请保留原任务编号继续查询，不要重新生成。`)
          return outcome('pending', 'VIDEO_STATUS_INVALID', '原视频失败状态尚无完整提交与计费证明，请保留原任务编号继续核对，不要重新生成。')
        }
        if (balance !== undefined) return outcome('failed', balance.code,
          `${balance.message}；原视频任务已结束且未成功，请检查原任务和计费记录。`)
        return outcome('failed', 'TASK_FAILED', '原视频任务已结束且未成功，请检查原任务和计费记录。')
      }
      if (['succeed', 'succeeded', 'success', 'completed'].includes(state ?? '')) {
        phase = 'saving'
        activity.stage('saving')
        path = await options.save(taskId, signal)
        signal.throwIfAborted()
        await persist({ ...currentReceipt(), phase: 'completed' })
        return outcome('completed')
      }
      const nextProgress = progress(state)
      if (nextProgress === undefined) {
        return outcome('pending', 'VIDEO_STATUS_INVALID', '原视频状态暂时无法确认，请保留回执并继续查询原任务，不要重复生成。')
      }
      lastProgress = nextProgress
      activity.stage(nextProgress)
    }
  } catch (_stopped: unknown) {
    if (!sent && _stopped instanceof VideoSubmissionRejection) return outcome('not-submitted', _stopped.code, _stopped.message)
    if (!sent) return outcome('not-submitted', 'VIDEO_PREPARATION_FAILED', '视频尚未提交，请检查素材或保存位置。')
    if (receipt?.taskId !== undefined && foreground?.aborted && !budget.aborted && !options.signal.aborted && currentPhase() === 'querying') {
      return outcome('pending', lastProgress === 'queued' ? 'VIDEO_QUEUE_WAITING' : 'VIDEO_GENERATION_PENDING',
        lastProgress === 'queued' ? '原视频任务正在排队，请稍后继续查询原任务，不要重复提交生成。'
          : lastProgress === 'generating' ? '原视频任务正在生成，请稍后继续查询原任务，不要重复提交生成。'
            : '原视频任务已受理，当前结果待查询；请稍后继续查询原任务，不要重复提交生成。')
    }
    if (receipt?.taskId !== undefined) return outcome('pending', budget.aborted ? 'VIDEO_TASK_TIMEOUT' : options.signal.aborted ? 'VIDEO_WAIT_STOPPED'
      : currentPhase() === 'saving' ? 'VIDEO_DOWNLOAD_UNAVAILABLE' : currentPhase() === 'receipt' ? 'VIDEO_RECEIPT_SAVE_FAILED' : 'VIDEO_QUERY_UNAVAILABLE', '原视频任务已受理，本机等待或保存已停止；上游仍可能继续运行和计费，请查询原任务，不要重新生成。')
    return outcome('unknown', 'VIDEO_SUBMISSION_UNKNOWN', '视频提交结果尚未确认，请先核对原任务与计费，不要重复生成。')
  } finally {
    await unread?.body?.cancel().catch((_closedBody: unknown) => { /* Completion or cancellation already released the response. */ })
    activity.end(activityOutcome)
  }
}
