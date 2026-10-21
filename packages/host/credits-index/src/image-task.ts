/** Single-submission image execution with durable receipts and read-only recovery. @module */
import { setTimeout as delay } from 'node:timers/promises'
import type { CreativeImageReceipt } from './creative-types.ts'
import { isAccountBalanceRejectionText } from './account-balance.ts'
import { VideoProjectError } from './video-project.ts'

/** Billing and provider-task facts remain independent of local waiting or saving. */
export interface ImageTaskOutcome {
  readonly ok: boolean
  readonly submissionState: 'not-submitted' | 'pending' | 'unknown' | 'failed' | 'completed'
  readonly model: string
  readonly code?: string
  readonly message?: string
  readonly imageReceipt?: CreativeImageReceipt
  readonly requestId?: string
  readonly taskId?: string
  readonly path?: string
  readonly paths?: readonly string[]
}

/** Provider operations are supplied by the account-bound Host and never retried as submissions. */
export interface ImageTaskOptions {
  readonly model: string
  readonly route: string
  readonly backendFingerprint: string
  readonly signal: AbortSignal
  readonly submitTimeoutMs: number
  readonly taskTimeoutMs: number
  readonly queryTimeoutMs: number
  readonly pollIntervalMs: number
  readonly queryRetryLimit: number
  readonly prepare?: (signal: AbortSignal) => Promise<void>
  readonly submitting?: () => Promise<void>
  readonly received?: (receipt: CreativeImageReceipt) => Promise<void>
  readonly resumeReceipt?: CreativeImageReceipt
  readonly submit: (signal: AbortSignal) => Promise<Response>
  readonly read: (taskId: string, signal: AbortSignal) => Promise<Response>
  readonly save: (item: Record<string, unknown>, index: number, signal: AbortSignal) => Promise<string | undefined>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
    && !/^(?:sk-|nap_)/iu.test(value) ? value : undefined
}
function taskId(value: Record<string, unknown> | undefined): string | undefined {
  const nested = record(value?.data)
  return identifier(value?.id) ?? identifier(value?.task_id) ?? identifier(nested?.id) ?? identifier(nested?.task_id)
}
function items(value: Record<string, unknown> | undefined): readonly unknown[] {
  const result = record(value?.result) ?? record(record(value?.data)?.result)
  return Array.isArray(value?.data) ? value.data : Array.isArray(result?.data) ? result.data : []
}
function status(value: Record<string, unknown> | undefined): string | undefined {
  const field = value?.status ?? value?.task_status ?? record(value?.data)?.status ?? record(value?.data)?.task_status
  return typeof field === 'string' ? field.toLowerCase() : undefined
}

/**
 * Submit at most once, persist every available receipt before dependent work, and recover only by GET.
 * @param options - Account-owned HTTP, persistence and save operations with complete time budgets.
 * @returns Saved outputs or a safe outcome retaining task identity and possible billing after cancellation or failure.
 */
export async function executeImageTask(options: ImageTaskOptions): Promise<ImageTaskOutcome> {
  let receipt = options.resumeReceipt
  let sent = receipt !== undefined
  const saved: string[] = []
  let unreadResponse: Response | undefined
  let phase: 'preparing' | 'submitting' | 'querying' | 'saving' | 'receipt' = 'preparing'
  const currentPhase = (): typeof phase => phase
  const outcome = (submissionState: ImageTaskOutcome['submissionState'], code?: string, message?: string): ImageTaskOutcome => ({
    ok: submissionState === 'completed', submissionState, model: receipt?.model ?? options.model,
    ...code === undefined ? {} : { code }, ...message === undefined ? {} : { message },
    ...receipt === undefined ? {} : { imageReceipt: receipt, ...receipt.taskId === undefined ? {} : { taskId: receipt.taskId },
      ...receipt.requestId === undefined ? {} : { requestId: receipt.requestId } },
    ...saved.length === 0 ? {} : { path: saved[0], paths: [...saved] },
  })
  if (receipt !== undefined && receipt.backendFingerprint !== options.backendFingerprint) {
    return outcome('pending', 'IMAGE_BACKEND_CHANGED', '原任务所属服务已变化，请恢复原服务配置后查询；不会重新提交生成。')
  }
  if (receipt !== undefined && receipt.taskId === undefined) {
    return outcome('unknown', 'IMAGE_SUBMISSION_UNKNOWN', '原提交尚无可查询的任务回执，请先核对原任务与计费；不会重新提交生成。')
  }
  const budget = AbortSignal.timeout(options.taskTimeoutMs)
  const signal = AbortSignal.any([options.signal, budget])
  const persist = async (next: CreativeImageReceipt): Promise<void> => {
    receipt = next
    const previousPhase = phase
    phase = 'receipt'
    await options.received?.(next)
    phase = previousPhase
  }
  const save = async (value: Record<string, unknown> | undefined): Promise<void> => {
    const previousPhase = phase
    phase = 'saving'
    for (const item of items(value)) {
      signal.throwIfAborted()
      const entry = record(item)
      if (entry === undefined) continue
      const path = await options.save(entry, saved.length, signal)
      if (path !== undefined) saved.push(path)
    }
    phase = previousPhase
  }
  const currentReceipt = (): CreativeImageReceipt => {
    if (receipt === undefined) throw new Error('Image execution has no retained receipt')
    return receipt
  }
  const complete = async (): Promise<ImageTaskOutcome> => {
    await persist({ ...currentReceipt(), phase: 'completed' })
    return outcome('completed')
  }
  try {
    signal.throwIfAborted()
    await options.prepare?.(signal)
    signal.throwIfAborted()
    if (receipt === undefined) {
      await options.submitting?.()
      signal.throwIfAborted()
      await persist({ route: options.route, model: options.model, backendFingerprint: options.backendFingerprint, phase: 'submitting' })
      signal.throwIfAborted()
      phase = 'submitting'
      sent = true
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.submitTimeoutMs)])
      const response = await options.submit(requestSignal)
      unreadResponse = response
      const requestId = identifier(response.headers.get('x-oneapi-request-id')) ?? identifier(response.headers.get('x-request-id'))
      if (requestId !== undefined) await persist({ ...currentReceipt(), requestId })
      const text = await response.text()
      unreadResponse = undefined
      let body: Record<string, unknown> | undefined
      try { body = record(JSON.parse(text)) }
      catch (_invalidReply: unknown) { /* An unreadable reply cannot establish that the paid submission was rejected. */ }
      const acceptedId = taskId(body)
      if (acceptedId !== undefined) await persist({ ...currentReceipt(), taskId: acceptedId, phase: 'accepted' })
      if (!response.ok) {
        if (acceptedId !== undefined) return outcome('pending', 'IMAGE_QUERY_PENDING', '原生成任务已受理，暂时无法确认结果，请查询原任务；不会重新生成。')
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          const balance = isAccountBalanceRejectionText(text, response.status)
          return outcome('failed', balance ? 'INSUFFICIENT_BALANCE' : `HTTP_${String(response.status)}`,
            balance ? '余额不足，请充值' : '生成请求未被受理，请检查登录状态、素材与模型要求。')
        }
        return outcome('unknown', 'IMAGE_SUBMISSION_UNKNOWN', '生成提交结果和计费状态尚未确认，请先核对原任务；不会重新提交。')
      }
      await save(body)
      if (saved.length > 0) return await complete()
    }
    const acceptedTaskId = currentReceipt().taskId
    if (acceptedTaskId === undefined) return outcome('unknown', 'NO_TASK_ID', '提交已发出，但未取得可查询的任务回执，请先核对原任务与计费；不会重新生成。')
    let failures = 0
    let firstRead = true
    while (true) {
      signal.throwIfAborted()
      if (!firstRead) await delay(options.pollIntervalMs, undefined, { signal })
      firstRead = false
      phase = 'querying'
      let response: Response
      let body: Record<string, unknown> | undefined
      try {
        const querySignal = AbortSignal.any([signal, AbortSignal.timeout(options.queryTimeoutMs)])
        response = await options.read(acceptedTaskId, querySignal)
        const text = await response.text()
        if (!response.ok) {
          if (response.status !== 408 && response.status !== 429 && response.status < 500) {
            return outcome('pending', 'IMAGE_QUERY_UNAVAILABLE', '原任务已受理，当前无法读取状态，请稍后查询原任务；不会重新生成。')
          }
          throw new Error('Image task query unavailable')
        }
        body = record(JSON.parse(text))
        if (body === undefined) throw new Error('Image task query invalid')
      } catch (error) {
        if (signal.aborted) throw error
        failures += 1
        if (failures > options.queryRetryLimit) return outcome('pending', 'IMAGE_QUERY_UNAVAILABLE', '原任务已受理，暂时无法读取状态，请稍后查询原任务；不会重新生成。')
        continue
      }
      failures = 0
      const taskStatus = status(body)
      if (['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled'].includes(taskStatus ?? '')) {
        return outcome('failed', 'TASK_FAILED', '原生成任务已结束且未成功，请检查原任务和计费记录。')
      }
      await save(body)
      if (saved.length > 0) return await complete()
      if (['completed', 'success', 'succeed', 'succeeded'].includes(taskStatus ?? '')) {
        return outcome('pending', 'IMAGE_RESULT_UNAVAILABLE', '原任务已完成，产物暂未取回，请继续查询原任务并保存；无需重新生成。')
      }
    }
  } catch (error) {
    if (!sent) return outcome('not-submitted', currentPhase() === 'receipt' ? 'IMAGE_RECEIPT_UNAVAILABLE' : error instanceof VideoProjectError ? error.code
      : signal.aborted ? 'ABORTED' : 'IMAGE_PREPARATION_FAILED', '生成尚未提交，当前操作已停止。')
    if (receipt?.taskId !== undefined) {
      const code = currentPhase() === 'receipt' ? 'IMAGE_RECEIPT_UNAVAILABLE' : budget.aborted ? 'IMAGE_TASK_TIMEOUT'
        : options.signal.aborted ? 'IMAGE_WAIT_STOPPED' : error instanceof VideoProjectError ? error.code
          : currentPhase() === 'saving' ? 'IMAGE_DOWNLOAD_UNAVAILABLE' : currentPhase() === 'preparing' ? 'IMAGE_PREPARATION_FAILED' : 'IMAGE_QUERY_UNAVAILABLE'
      return outcome('pending', code, '原任务已受理，当前等待或保存已停止；上游仍可能继续运行和计费，请查询原任务，不要重新生成。')
    }
    return outcome('unknown', 'IMAGE_SUBMISSION_UNKNOWN', '生成提交结果和计费状态尚未确认，请先核对原任务；不会重新提交。')
  } finally {
    if (unreadResponse?.body !== null && unreadResponse?.body !== undefined) {
      try { await unreadResponse.body.cancel() }
      catch (_alreadyClosed: unknown) { /* A failed or already-consumed response has no remaining dependent work. */ }
    }
  }
}
