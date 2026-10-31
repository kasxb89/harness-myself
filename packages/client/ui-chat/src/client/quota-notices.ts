/** Live product-balance notices are admitted by the current product login owner. */
import type {} from '@deepseek-ai/dsh-tools/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One producer-confirmed balance failure; scope is opaque and never displayed. */
export interface BalanceNoticeRequest {
  readonly scope: string
  readonly key: string
}

/** The product account owner admits scope; Chat owns publication and duplicate suppression. */
export interface QuotaNotices {
  /**
   * Publish one confirmed rejection only when the current product login admits its scope.
   * @param notice - Producer-confirmed rejection and stable submission or job key.
   * @returns Whether a new notice was published; duplicates, stale scopes and held notices return false.
   */
  publishBalance(notice: BalanceNoticeRequest): boolean
  /**
   * Correlate a live media-start acknowledgement with a terminal job, in either delivery order.
   * @param jobId - Job acknowledged by a newly appended native media start result.
   */
  registerLiveJob(jobId: string): void
  /**
   * Retain a terminal balance action without announcing unrelated historical failures.
   * @param notice - Retained terminal balance action.
   * @param transitioned - Whether this client observed the job running before its failure.
   * @returns Whether a live transition or acknowledged job published a new notice.
   */
  observeBalanceJob(notice: BalanceNoticeRequest, transitioned: boolean): boolean
  /**
   * Admit only the product login whose current scope matches a producer-confirmed failure.
   * @param accept - Current product-login scope predicate.
   * @returns Lifecycle release for this account owner's predicate.
   */
  registerBalanceScope(accept: (scope: string) => boolean): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Frame-wide, product-login-guarded quota notice publication. */
    quotaNotices: QuotaNotices
  }
}

/**
 * Create the transient notice owner shared by tools and background jobs.
 * @param publish - Chat-owned notice writer.
 * @returns A login-guarded, duplicate-suppressing publisher.
 */
export function createQuotaNotices(publish: (scope: string) => boolean): QuotaNotices {
  const guards = new Set<(scope: string) => boolean>()
  let seenScope: string | undefined
  const seen = new Set<string>()
  const liveJobs = new Set<string>()
  const failedJobs = new Map<string, BalanceNoticeRequest>()
  const publishBalance = ({ scope, key }: BalanceNoticeRequest): boolean => {
    if (scope === '' || key === '' || ![...guards].some(accept => accept(scope))) return false
    if (seenScope !== scope) { seen.clear(); seenScope = scope }
    if (seen.has(key)) return false
    seen.add(key)
    return publish(scope)
  }
  return {
    publishBalance,
    registerLiveJob(jobId) {
      const key = `job:${jobId}`
      liveJobs.add(key)
      const failure = failedJobs.get(key)
      if (failure !== undefined) publishBalance(failure)
    },
    observeBalanceJob(notice, transitioned) {
      failedJobs.set(notice.key, notice)
      return transitioned || liveJobs.has(notice.key) ? publishBalance(notice) : false
    },
    registerBalanceScope(accept) {
      guards.add(accept)
      return () => { guards.delete(accept) }
    },
  }
}

const MEDIA_TOOLS = new Set([
  'generate_image', 'generate_video', 'generate_video_project', 'resume_video_project',
  'query_image_task', 'query_video_task', 'video_project_status',
])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function action(value: unknown): string | undefined {
  return record(value) && value.code === 'INSUFFICIENT_BALANCE'
    && typeof value.scope === 'string' && value.scope !== '' ? value.scope : undefined
}

/**
 * Read producer-owned metadata or a named native media tool's structured result, never diagnostic prose.
 * @param event - Newly appended result.
 * @param toolName - Recorded dispatch name, absent when its call is outside the live window.
 * @param sessionId - Owner used only for a result with no stable submission identity.
 * @returns A scoped request, or undefined for unrelated/unconfirmed failures.
 */
export function toolBalanceNotice(
  event: SessionEvent<'tool/result' | 'tool/ptc-dispatch'>, toolName: string | undefined, sessionId: string,
): BalanceNoticeRequest | undefined {
  const meta = event.data.meta
  const name = event.type === 'tool/ptc-dispatch' ? event.data.name : toolName
  const content = event.type === 'tool/ptc-dispatch' ? event.data.content : event.data.message.content
  const callId = event.type === 'tool/ptc-dispatch' ? event.data.subCallId : event.data.message.source.callId
  if (record(meta)) {
    const scope = action(meta.actionRequired)
    if (scope !== undefined && typeof meta.jobId === 'string' && meta.jobId !== '') {
      return { scope, key: `job:${meta.jobId}` }
    }
  }
  if (name === undefined || !MEDIA_TOOLS.has(name)) return undefined
  for (const block of content) {
    if (block.type !== 'text') continue
    let value: unknown
    try { value = JSON.parse(block.text) } catch (_invalidResult) { continue }
    if (!record(value)) continue
    const scope = action(value.actionRequired)
    if (scope === undefined) continue
    for (const field of ['job_id', 'work_id', 'work_request_id', 'operation_id', 'submission_id', 'request_id']) {
      const id = value[field]
      if (typeof id === 'string' && id !== '') return { scope, key: `${field === 'job_id' ? 'job' : 'submission'}:${id}` }
    }
    return { scope, key: `tool:${sessionId}:${callId}` }
  }
  return undefined
}


/**
 * Link only a newly appended, named media background acknowledgement to its terminal roster.
 * @param event - Native result or nested PTC dispatch; history never calls this reader.
 * @param toolName - Recorded native call name.
 * @returns Its explicit background job id, or undefined for non-start results and unrelated tools.
 */
export function toolBackgroundJob(
  event: SessionEvent<'tool/result' | 'tool/ptc-dispatch'>, toolName: string | undefined,
): string | undefined {
  const name = event.type === 'tool/ptc-dispatch' ? event.data.name : toolName
  if (name !== 'generate_video_project' && name !== 'resume_video_project') return undefined
  const content = event.type === 'tool/ptc-dispatch' ? event.data.content : event.data.message.content
  for (const block of content) {
    if (block.type !== 'text') continue
    let value: unknown
    try { value = JSON.parse(block.text) } catch (_invalidResult) { continue }
    if (record(value) && value.status === 'background' && typeof value.job_id === 'string' && value.job_id !== '') return value.job_id
  }
  return undefined
}
