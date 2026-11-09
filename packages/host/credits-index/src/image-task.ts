/** Single-submission image execution with durable receipts and read-only recovery. @module */
import { setTimeout as delay } from 'node:timers/promises'
import type { CreativeImageReceipt, CreativeImageServerTaskId } from './creative-types.ts'
import { imageServerTaskId } from './image-server-task.ts'
import { accountBalanceFailure, isAccountBalanceRejectionText } from './account-balance.ts'
import { VideoProjectError } from './video-project.ts'
import {
  hasMediaSubmissionReceipt, mediaSubmissionTaskId, mediaSubmissionRejection, mediaSubmissionQueryRejection, mediaSubmissionMessage,
  hasMediaSubmissionUnknown, mediaSubmissionUnknownTaskId,
} from './media-submission-receipt.ts'
import type { ArtifactOrigin } from '@deepseek-ai/dsh-artifacts-index'
import { creationTaskActivity } from './creation-activity.ts'
import { mediaModelConfigRejection, matchesModelConfigAcceptance, type MediaModelConfigBinding } from './media-model-config-result.ts'
import { transferMedia, readMediaBytes, MediaTransferLimitError } from './media-transfer.ts'
import { validateImageResultItems, type ImageResultItem, type ImageRetainedResult } from './image-result-store.ts'
import type { CreationActivityOutcome, CreationTaskObserver } from './creation-activity.ts'

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
  readonly serverTaskId?: CreativeImageServerTaskId
  readonly path?: string
  readonly paths?: readonly string[]
  /** Valid image sources were received; this says nothing about final billing or completed local saves. */
  readonly resultReceived?: true
}

/** Provider operations are supplied by the account-bound Host and never retried as submissions. */
export interface ImageTaskOptions {
  /** Trusted original POST scope; never used for poll-only recovery or model reselection. */
  readonly modelConfigBinding?: MediaModelConfigBinding
  /** Configured independent save/download limit; omitted callers retain serial behavior. */
  readonly downloadConcurrency?: number
  /** Complete HTTP JSON body bound, enforced while reading before parsing or inline decoding. */
  readonly responseMaxBytes?: number
  /** Per-image decoded inline byte bound, checked before Buffer.from can allocate. */
  readonly imageMaxBytes?: number
  /** Content-free local phases; an end notification does not cancel accepted upstream work. */
  readonly activity?: CreationTaskObserver
  readonly origin?: ArtifactOrigin
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
  /** Final synchronous login check after receipt persistence and immediately before dispatch. */
  readonly beforeSubmit?: () => void
  readonly received?: (receipt: CreativeImageReceipt) => Promise<void>
  /** Private original sources must be durably retained before any dependent save. */
  readonly receivedResult?: (items: readonly ImageResultItem[], receipt: CreativeImageReceipt) => Promise<void>
  /** Commit a verified save checkpoint using the stable provider result index. */
  readonly savedResult?: (index: number, path: string) => Promise<void>
  readonly resumeReceipt?: CreativeImageReceipt
  /** Private, owner-verified sources permit save-only recovery even without a provider task id. */
  readonly resumeResult?: ImageRetainedResult
  readonly submit: (signal: AbortSignal) => Promise<Response>
  /** Canonical reads select only the Host-owned /v1/tasks path, never a response-supplied URL. */
  readonly read: (taskId: string, signal: AbortSignal, canonical?: boolean) => Promise<Response>
  /** Exact supported gateway metadata enables header capture for a new submission only. */
  readonly serverResultRecovery?: boolean
  /** Original server status; this operation must never fall back to a provider route. */
  readonly readServerTask?: (taskId: CreativeImageServerTaskId, signal: AbortSignal) => Promise<Response>
  /** Original server artifact manifest, not an image-generation operation. */
  readonly readArtifacts?: (taskId: CreativeImageServerTaskId, signal: AbortSignal) => Promise<Response>
  /** Admit only this backend's original task and artifact URL, preserving its private access query. */
  readonly resolveArtifactUrl?: (taskId: CreativeImageServerTaskId, key: string, url: string) => string | undefined
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
 * Submit at most once; recover through original task GETs or private retained sources without resubmitting.
 * @param options - Account-owned HTTP, persistence and save operations with complete time budgets.
 * @returns Saved outputs or a safe outcome retaining task identity and possible billing after cancellation or failure.
 */
export async function executeImageTask(options: ImageTaskOptions): Promise<ImageTaskOutcome> {
  const activity = creationTaskActivity(options.activity)
  let activityOutcome: CreationActivityOutcome = 'unknown'
  let receipt = options.resumeReceipt ?? options.resumeResult?.receipt
  let canonicalRead = receipt?.taskId?.startsWith('task_') === true
  let sent = receipt !== undefined
  const saved = new Map(options.resumeResult?.saved.map(item => [item.index, item.path]))
  let resultReceived = options.resumeResult !== undefined
  let unreadResponse: Response | undefined
  let phase: 'preparing' | 'submitting' | 'querying' | 'saving' | 'receipt' | 'result' | 'response' = 'preparing'
  const currentPhase = (): typeof phase => phase
  const outcome = (submissionState: ImageTaskOutcome['submissionState'], code?: string, message?: string): ImageTaskOutcome => {
    activityOutcome = submissionState === 'completed' ? 'completed' : submissionState === 'failed' ? 'failed'
      : submissionState === 'not-submitted' ? 'stopped' : 'unknown'
    if (activityOutcome === 'unknown') activity.stage('unknown')
    const paths = [...saved].sort(([a], [b]) => a - b).map(([, path]) => path)
    return {
      ok: submissionState === 'completed', submissionState, model: receipt?.model ?? options.model,
      ...code === undefined ? {} : { code }, ...message === undefined ? {} : { message },
      ...receipt === undefined ? {} : { imageReceipt: receipt, ...receipt.taskId === undefined ? {} : { taskId: receipt.taskId },
        ...receipt.serverTaskId === undefined ? {} : { serverTaskId: receipt.serverTaskId },
        ...receipt.requestId === undefined ? {} : { requestId: receipt.requestId } },
      ...paths.length === 0 ? {} : { path: paths[0], paths }, ...resultReceived ? { resultReceived: true as const } : {},
    }
  }
  if (receipt !== undefined && receipt.backendFingerprint !== options.backendFingerprint) {
    const result = outcome('pending', 'IMAGE_BACKEND_CHANGED', '原任务所属服务已变化，请恢复原服务配置后查询；不会重新提交生成。')
    activity.end(activityOutcome)
    return result
  }
  if (receipt !== undefined && receipt.taskId === undefined && receipt.serverTaskId === undefined && options.resumeResult === undefined) {
    const result = outcome('unknown', 'IMAGE_SUBMISSION_UNKNOWN', '原提交尚无可查询的任务回执，请先核对原任务与计费；不会重新提交生成。')
    activity.end(activityOutcome)
    return result
  }
  const budget = AbortSignal.timeout(options.taskTimeoutMs)
  const signal = AbortSignal.any([options.signal, budget])
  const persist = async (next: CreativeImageReceipt): Promise<void> => {
    receipt = next
    const previousPhase = phase
    phase = 'receipt'
    await options.received?.(next)
    phase = previousPhase
    if (next.phase === 'accepted') activity.stage('accepted')
  }
  const saveItems = async (values: readonly unknown[], retain = true): Promise<void> => {
    if (values.length === 0) return
    const previousPhase = phase
    phase = 'result'
    const sources = validateImageResultItems(values, options.imageMaxBytes, options.responseMaxBytes)
    resultReceived = true
    if (retain) await options.receivedResult?.(sources, currentReceipt())
    phase = 'saving'
    await transferMedia(sources.map((item, index) => ({ item, index })).filter(entry => !saved.has(entry.index)),
      options.downloadConcurrency ?? 1, signal, async ({ item, index }, _pendingIndex, transferSignal) => {
        transferSignal.throwIfAborted()
        activity.stage('saving')
        const path = await options.save(item, index, transferSignal)
        if (path === undefined) throw new VideoProjectError('IMAGE_DOWNLOAD_UNAVAILABLE', '原图片尚未保存，请继续保存原结果；无需重新生成。')
        saved.set(index, path)
        await options.savedResult?.(index, path)
      })
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
  const recoverServerResult = async (): Promise<ImageTaskOutcome> => {
    const id = currentReceipt().serverTaskId
    if (id === undefined || options.readServerTask === undefined
      || options.readArtifacts === undefined || options.resolveArtifactUrl === undefined) {
      return outcome('pending', 'IMAGE_RESULT_UNAVAILABLE', '原图片回执已保留，当前暂时无法读取原产物；请保留原任务，不要重新生成。')
    }
    activity.stage('accepted')
    let failures = 0, firstRead = true
    while (true) {
      signal.throwIfAborted()
      if (!firstRead) await delay(options.pollIntervalMs, undefined, { signal })
      firstRead = false
      phase = 'querying'
      try {
        const querySignal = AbortSignal.any([signal, AbortSignal.timeout(options.queryTimeoutMs)])
        const response = await options.readServerTask(id, querySignal)
        unreadResponse = response
        const text = (await readMediaBytes(response, options.responseMaxBytes ?? 134_217_728, querySignal)).toString('utf8')
        unreadResponse = undefined
        if (!response.ok) {
          if (response.status === 408 || response.status === 429 || response.status >= 500) throw new Error('Server image status unavailable')
          return outcome('pending', 'IMAGE_QUERY_UNAVAILABLE', '原图片任务暂时无法查询，请保留原任务稍后继续；不会重新生成。')
        }
        const body = record(JSON.parse(text)), data = record(body?.data)
        if (taskId(body) !== id || (body?.model ?? data?.model) !== currentReceipt().model) {
          return outcome('pending', 'IMAGE_STATUS_INVALID', '原图片任务身份尚未完整核对，请保留原任务，不要重新生成。')
        }
        const rejection = mediaSubmissionQueryRejection(currentReceipt().model, 'image', response.status, body, id)
        if (rejection !== undefined) return outcome('failed', rejection.code, mediaSubmissionMessage(rejection))
        const state = status(body)
        if (['queued', 'pending', 'not_start', 'created', 'submitted', 'in_queue'].includes(state ?? '')) {
          activity.stage('queued'); failures = 0; continue
        }
        if (state === 'unknown') {
          failures = 0
          continue
        }
        if (['running', 'processing', 'in_progress', 'generating'].includes(state ?? '')) {
          activity.stage('generating'); failures = 0; continue
        }
        if (!['completed', 'success', 'succeed', 'succeeded'].includes(state ?? '')) {
          return outcome('pending', 'IMAGE_STATUS_INVALID', '原图片状态和计费尚未完整核对，请保留原任务，不要重新生成。')
        }
        const manifestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.queryTimeoutMs)])
        const manifestResponse = await options.readArtifacts(id, manifestSignal)
        unreadResponse = manifestResponse
        const manifestText = (await readMediaBytes(manifestResponse, options.responseMaxBytes ?? 134_217_728, manifestSignal)).toString('utf8')
        unreadResponse = undefined
        if (!manifestResponse.ok) {
          if (manifestResponse.status === 408 || manifestResponse.status === 429 || manifestResponse.status >= 500) throw new Error('Server image manifest unavailable')
          return outcome('pending', 'IMAGE_RESULT_UNAVAILABLE', '原图片产物暂时无法取回，请保留原任务稍后继续；不会重新生成。')
        }
        const manifest = record(JSON.parse(manifestText)), artifacts = manifest?.artifacts
        if (manifest?.task_id !== id || !Array.isArray(artifacts) || artifacts.length === 0 || artifacts.length > 64) {
          return outcome('pending', 'IMAGE_RESULT_UNAVAILABLE', '原图片产物清单尚未完整核对，请保留原任务，不要重新生成。')
        }
        const sources: { url: string }[] = [], keys = new Set<string>()
        for (const value of artifacts) {
          const item = record(value), key = item?.key
          if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(key) || keys.has(key)
            || item?.type !== 'image' || typeof item.content_url !== 'string' || item.content_url.length > 16_384) {
            return outcome('pending', 'IMAGE_RESULT_UNAVAILABLE', '原图片产物清单尚未完整核对，请保留原任务，不要重新生成。')
          }
          const url = options.resolveArtifactUrl(id, key, item.content_url)
          if (url === undefined) return outcome('pending', 'IMAGE_RESULT_UNAVAILABLE', '原图片下载地址尚未完整核对，请保留原任务，不要重新生成。')
          keys.add(key); sources.push({ url })
        }
        if (options.resumeResult !== undefined && options.resumeResult.items.length !== sources.length) {
          return outcome('pending', 'IMAGE_RESULT_UNAVAILABLE', '原图片产物数量尚未完整核对，请保留原任务，不要重新生成。')
        }
        await saveItems(sources, options.resumeResult === undefined)
        return await complete()
      } catch (error) {
        if (unreadResponse?.body !== null && unreadResponse?.body !== undefined) {
          try { await unreadResponse.body.cancel() }
          catch (_closedQueryBody: unknown) { /* Failed reads may have already closed the response. */ }
          unreadResponse = undefined
        }
        if (signal.aborted || currentPhase() !== 'querying') throw error
        if (error instanceof MediaTransferLimitError) return outcome('pending', 'IMAGE_RESPONSE_TOO_LARGE', '原图片查询超过读取资源上限，请保留原任务，不要重新生成。')
        failures += 1
        if (failures > options.queryRetryLimit) return outcome('pending', 'IMAGE_QUERY_UNAVAILABLE', '原图片查询暂未完成，请稍后继续查询原任务；不会重新生成。')
      }
    }
  }
  try {
    activity.stage('preparing')
    signal.throwIfAborted()
    await options.prepare?.(signal)
    signal.throwIfAborted()
    if (options.resumeResult !== undefined && receipt?.taskId === undefined) {
      try {
        await saveItems(options.resumeResult.items, false)
        return await complete()
      } catch (error) {
        if (signal.aborted || currentReceipt().serverTaskId === undefined || currentPhase() !== 'saving') throw error
        return await recoverServerResult()
      }
    }
    if (receipt?.serverTaskId !== undefined) return await recoverServerResult()
    if (receipt === undefined) {
      await options.submitting?.()
      signal.throwIfAborted()
      await persist({ route: options.route, model: options.model, backendFingerprint: options.backendFingerprint, phase: 'submitting',
        ...options.origin === undefined ? {} : { origin: options.origin } })
      signal.throwIfAborted()
      phase = 'submitting'
      options.beforeSubmit?.()
      sent = true
      activity.stage('submitting')
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.submitTimeoutMs)])
      const response = await options.submit(requestSignal)
      unreadResponse = response
      const requestId = identifier(response.headers.get('x-oneapi-request-id')) ?? identifier(response.headers.get('x-request-id'))
      if (requestId !== undefined) await persist({ ...currentReceipt(), requestId })
      const serverTaskId = options.serverResultRecovery === true ? imageServerTaskId(response.headers.get('x-new-api-task-id')) : undefined
      if (serverTaskId !== undefined) await persist({ ...currentReceipt(), serverTaskId, phase: 'accepted' })
      phase = 'response'
      let text: string
      try { text = (await readMediaBytes(response, options.responseMaxBytes ?? 134_217_728, requestSignal)).toString('utf8') }
      catch (error) {
        if (signal.aborted || currentReceipt().serverTaskId === undefined) throw error
        try { await response.body?.cancel() }
        catch (_closedSubmissionBody: unknown) { /* A broken or consumed response may already be closed. */ }
        unreadResponse = undefined
        return await recoverServerResult()
      }
      unreadResponse = undefined
      let body: Record<string, unknown> | undefined
      try { body = record(JSON.parse(text)) }
      catch (_invalidReply: unknown) { /* An unreadable reply cannot establish that the paid submission was rejected. */ }
      const configRejection = options.modelConfigBinding === undefined ? undefined
        : mediaModelConfigRejection(response, body, options.modelConfigBinding)
      if (configRejection !== undefined) return outcome('not-submitted', configRejection.code, configRejection.message)
      const marked = hasMediaSubmissionReceipt(body)
      const uncertain = hasMediaSubmissionUnknown(body)
      const canonicalId = uncertain ? mediaSubmissionUnknownTaskId(options.model, 'image', response.status, body) : undefined
      const acceptedId = marked ? mediaSubmissionTaskId(options.model, 'image', body) : uncertain ? canonicalId : taskId(body)
      const rejection = mediaSubmissionRejection(options.model, 'image', response.status, body)
      if (rejection !== undefined) {
        if (currentReceipt().serverTaskId !== undefined && currentReceipt().serverTaskId !== rejection.taskId) {
          return outcome('pending', 'IMAGE_STATUS_INVALID', '原图片回执与提交证明尚未完整核对，请保留原任务，不要重新生成。')
        }
        await persist({ ...currentReceipt(), taskId: rejection.taskId })
        const balance = isAccountBalanceRejectionText(text, response.status)
        return outcome('failed', balance ? 'INSUFFICIENT_BALANCE' : rejection.code,
          (balance ? '余额不足，请充值；' : '') + mediaSubmissionMessage(rejection))
      }
      if (acceptedId !== undefined) {
        canonicalRead = marked || canonicalId !== undefined || acceptedId.startsWith('task_')
        await persist({ ...currentReceipt(), taskId: acceptedId, phase: 'accepted' })
      }
      if (response.ok && !matchesModelConfigAcceptance(response, options.modelConfigBinding?.modelConfigVersion)) {
        const sources = validateImageResultItems(items(body), options.imageMaxBytes)
        if (sources.length > 0) {
          resultReceived = true
          await options.receivedResult?.(sources, currentReceipt())
        }
        return outcome(acceptedId === undefined && currentReceipt().serverTaskId === undefined ? 'unknown' : 'pending',
          'MODEL_CONFIG_CONFIRMATION_UNAVAILABLE', '提交已发出，但尚无法确认受理的模型配置版本；请保留原任务查询，不要重复生成。')
      }
      if (currentReceipt().serverTaskId !== undefined && (marked || uncertain && canonicalId === undefined)) {
        return await recoverServerResult()
      }
      if (marked) return outcome(acceptedId === undefined ? 'unknown' : 'pending',
        acceptedId === undefined ? 'IMAGE_SUBMISSION_UNKNOWN' : 'IMAGE_STATUS_INVALID',
        '原图片回执尚未通过完整核对，请保留已有任务与计费记录，不要重新生成。')
      if (uncertain && canonicalId === undefined) return outcome('unknown', 'IMAGE_SUBMISSION_UNKNOWN',
        '生成提交结果和计费状态尚未确认，请先核对原任务；不会重新提交。')
      if (!response.ok) {
        const balance = isAccountBalanceRejectionText(text, response.status)
        if (currentReceipt().serverTaskId !== undefined) return await recoverServerResult()
        if (acceptedId !== undefined) return outcome('pending', balance ? 'INSUFFICIENT_BALANCE' : 'IMAGE_QUERY_PENDING',
          (balance ? '余额不足，请充值；' : '') + '原生成任务已受理，暂时无法确认结果，请查询原任务；不会重新生成。')
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          return outcome('failed', balance ? 'INSUFFICIENT_BALANCE' : `HTTP_${String(response.status)}`,
            balance ? '余额不足，请充值' : '生成请求未被受理，请检查登录状态、素材与模型要求。')
        }
        return outcome('unknown', 'IMAGE_SUBMISSION_UNKNOWN', '生成提交结果和计费状态尚未确认，请先核对原任务；不会重新提交。')
      }
      if (!uncertain) await saveItems(items(body))
      if (saved.size > 0) return await complete()
      if (currentReceipt().serverTaskId !== undefined) return await recoverServerResult()
    }
    const acceptedTaskId = currentReceipt().taskId
    if (acceptedTaskId === undefined) return outcome('unknown', 'NO_TASK_ID', '提交已发出，但未取得可查询的任务回执，请先核对原任务与计费；不会重新生成。')
    let failures = 0
    let firstRead = true
    activity.stage('accepted')
    while (true) {
      signal.throwIfAborted()
      if (!firstRead) await delay(options.pollIntervalMs, undefined, { signal })
      firstRead = false
      phase = 'querying'
      let response: Response
      let body: Record<string, unknown> | undefined
      try {
        const querySignal = AbortSignal.any([signal, AbortSignal.timeout(options.queryTimeoutMs)])
        response = canonicalRead || currentReceipt().route === '/v1/tasks'
          ? await options.read(acceptedTaskId, querySignal, true) : await options.read(acceptedTaskId, querySignal)
        const text = (await readMediaBytes(response, options.responseMaxBytes ?? 134_217_728, querySignal)).toString('utf8')
        if (!response.ok) {
          if (response.status !== 408 && response.status !== 429 && response.status < 500) {
            const balance = isAccountBalanceRejectionText(text, response.status)
            return outcome('pending', balance ? 'INSUFFICIENT_BALANCE' : 'IMAGE_QUERY_UNAVAILABLE',
              (balance ? '余额不足，请充值；' : '') + '原任务已受理，当前无法读取状态，请稍后查询原任务；不会重新生成。')
          }
          throw new Error('Image task query unavailable')
        }
        body = record(JSON.parse(text))
        if (body === undefined) throw new Error('Image task query invalid')
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof MediaTransferLimitError) return outcome('pending', 'IMAGE_RESPONSE_TOO_LARGE',
          '原任务已受理，但查询结果超过当前读取资源上限；请保留原任务，不要重新生成。')
        failures += 1
        if (failures > options.queryRetryLimit) return outcome('pending', 'IMAGE_QUERY_UNAVAILABLE', '原任务已受理，暂时无法读取状态，请稍后查询原任务；不会重新生成。')
        continue
      }
      failures = 0
      const rejection = mediaSubmissionQueryRejection(currentReceipt().model, 'image', response.status, body, acceptedTaskId)
      const balance = accountBalanceFailure(body.failure_code ?? record(body.data)?.failure_code)
      if (rejection !== undefined) return outcome('failed', balance?.code ?? rejection.code,
        (balance === undefined ? '' : `${balance.message}；`) + mediaSubmissionMessage(rejection))
      if (hasMediaSubmissionReceipt(body) || hasMediaSubmissionUnknown(body)) return outcome('pending', 'IMAGE_STATUS_INVALID',
        '原图片回执尚未通过完整核对，请保留原任务编号，不要重新生成。')
      const taskStatus = status(body)
      if (canonicalRead && taskStatus === 'unknown') return outcome('pending', 'IMAGE_STATUS_INVALID',
        '原图片状态尚未明确，请保留原任务编号继续核对，不要重新生成。')
      const failed = ['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled'].includes(taskStatus ?? '')
      if (canonicalRead && failed) return outcome('pending', balance?.code ?? 'IMAGE_STATUS_INVALID',
        (balance === undefined ? '' : `${balance.message}；`) + '原图片失败状态尚无完整提交与计费证明，请保留原任务编号继续核对，不要重新生成。')
      if (!canonicalRead && currentReceipt().route === '/toapis/v1/images/generations'
        && (failed || ['queued', 'pending', 'unknown', 'not_start', 'created', 'submitted'].includes(taskStatus ?? ''))) {
        const querySignal = AbortSignal.any([signal, AbortSignal.timeout(options.queryTimeoutMs)])
        const canonical = await options.read(acceptedTaskId, querySignal, true)
        const text = (await readMediaBytes(canonical, options.responseMaxBytes ?? 134_217_728, querySignal)).toString('utf8')
        let original: unknown
        try { original = JSON.parse(text) } catch (_invalidOriginalTask: unknown) { /* Keep the original receipt unresolved. */ }
        const proof = mediaSubmissionQueryRejection(currentReceipt().model, 'image', canonical.status, original, acceptedTaskId)
        const originalBody = record(original)
        const originalStatus = status(originalBody)
        const originalFailed = ['failed', 'failure', 'fail', 'error', 'cancelled', 'canceled'].includes(originalStatus ?? '')
        const originalBalance = canonical.ok && originalFailed
          ? accountBalanceFailure(originalBody?.failure_code ?? record(originalBody?.data)?.failure_code)
          : isAccountBalanceRejectionText(text, canonical.status) ? accountBalanceFailure('insufficient_user_quota') : undefined
        if (proof !== undefined) return outcome('failed', originalBalance?.code ?? proof.code,
          (originalBalance === undefined ? '' : `${originalBalance.message}；`) + mediaSubmissionMessage(proof))
        if (failed || hasMediaSubmissionReceipt(original) || hasMediaSubmissionUnknown(original)
          || canonical.ok && (originalStatus === 'unknown' || originalFailed)) {
          const failure = originalBalance ?? balance
          return outcome('pending', failure?.code ?? 'IMAGE_STATUS_INVALID', (failure === undefined ? '' : `${failure.message}；`)
            + '原图片状态尚无完整提交与计费证明，请保留原任务编号继续核对，不要重新生成。')
        }
        if (!canonical.ok && canonical.status !== 404) {
          const funding = isAccountBalanceRejectionText(text, canonical.status)
          return outcome('pending', funding ? 'INSUFFICIENT_BALANCE' : 'IMAGE_QUERY_UNAVAILABLE',
            (funding ? '余额不足，请充值；' : '') + '原任务当前无法完整核对，请稍后继续查询原任务；不会重新生成。')
        }
      }
      if (failed) {
        if (currentReceipt().route === '/v1/tasks') return outcome('pending', balance?.code ?? 'IMAGE_STATUS_INVALID',
          (balance === undefined ? '' : `${balance.message}；`) + '原图片失败状态尚无完整提交与计费证明，请保留原任务编号继续核对，不要重新生成。')
        return outcome('failed', balance?.code ?? 'TASK_FAILED',
          (balance === undefined ? '' : `${balance.message}；`) + '原生成任务已结束且未成功，请检查原任务和计费记录。')
      }
      if (['queued', 'pending', 'not_start', 'created', 'submitted', 'in_queue'].includes(taskStatus ?? '')) activity.stage('queued')
      else if (['running', 'processing', 'in_progress', 'generating'].includes(taskStatus ?? '')) activity.stage('generating')
      await saveItems(items(body))
      if (saved.size > 0) return await complete()
      if (['completed', 'success', 'succeed', 'succeeded'].includes(taskStatus ?? '')) {
        return outcome('pending', 'IMAGE_RESULT_UNAVAILABLE', '原任务已完成，产物暂未取回，请继续查询原任务并保存；无需重新生成。')
      }
    }
  } catch (error) {
    if (!sent) return outcome('not-submitted', currentPhase() === 'receipt' ? 'IMAGE_RECEIPT_UNAVAILABLE' : error instanceof VideoProjectError ? error.code
      : signal.aborted ? 'ABORTED' : 'IMAGE_PREPARATION_FAILED', '生成尚未提交，当前操作已停止。')
    if (resultReceived) {
      const code = currentPhase() === 'result' ? 'IMAGE_RESULT_PERSISTENCE_UNAVAILABLE'
        : currentPhase() === 'receipt' ? 'IMAGE_RECEIPT_UNAVAILABLE'
          : budget.aborted ? 'IMAGE_TASK_TIMEOUT' : options.signal.aborted ? 'IMAGE_WAIT_STOPPED'
            : error instanceof VideoProjectError ? error.code : currentPhase() === 'preparing' ? 'IMAGE_PREPARATION_FAILED'
              : currentPhase() === 'querying' ? 'IMAGE_QUERY_UNAVAILABLE' : 'IMAGE_DOWNLOAD_UNAVAILABLE'
      return outcome('pending', code, '原图片结果已收到，但本地保存尚未完成；请继续保存原结果，不要重新生成。')
    }
    if (receipt?.taskId !== undefined || receipt?.serverTaskId !== undefined) {
      const code = error instanceof MediaTransferLimitError ? 'IMAGE_RESPONSE_TOO_LARGE'
        : currentPhase() === 'result' ? 'IMAGE_RESULT_INVALID'
          : currentPhase() === 'receipt' ? 'IMAGE_RECEIPT_UNAVAILABLE' : budget.aborted ? 'IMAGE_TASK_TIMEOUT'
            : options.signal.aborted ? 'IMAGE_WAIT_STOPPED' : error instanceof VideoProjectError ? error.code
              : currentPhase() === 'saving' ? 'IMAGE_DOWNLOAD_UNAVAILABLE' : currentPhase() === 'preparing' ? 'IMAGE_PREPARATION_FAILED' : 'IMAGE_QUERY_UNAVAILABLE'
      return outcome('pending', code, '原任务已受理，当前等待或保存已停止；上游仍可能继续运行和计费，请查询原任务，不要重新生成。')
    }
    return outcome('unknown', error instanceof MediaTransferLimitError ? 'IMAGE_RESPONSE_TOO_LARGE'
      : currentPhase() === 'result' ? 'IMAGE_RESULT_INVALID' : 'IMAGE_SUBMISSION_UNKNOWN',
    '生成提交结果和计费状态尚未确认，请先核对原任务；不会重新提交。')
  } finally {
    if (unreadResponse?.body !== null && unreadResponse?.body !== undefined) {
      try { await unreadResponse.body.cancel() }
      catch (_alreadyClosed: unknown) { /* A failed or already-consumed response has no remaining dependent work. */ }
    }
    activity.end(activityOutcome)
  }
}
