/** Retained image-task coordinates used to prevent blind paid resubmission. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'

/** Original image task coordinates and query eligibility retained for one account and conversation. */
export interface ImageSubmission {
  readonly accountId: string
  readonly sessionId: string
  readonly state: 'pending' | 'unknown'
  readonly planId?: string
  readonly operationId?: string
  readonly taskId?: string
  readonly requestId?: string
  readonly canQuery: boolean
}

interface Owner {
  readonly accountId: string
  readonly sessionId: string
}
type CheckResult = { readonly ok: true; readonly submission: ImageSubmission | null; readonly completed: boolean }
  | { readonly ok: false }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    && !/^(?:sk-|nap_)/iu.test(value)
}

/**
 * Identify view state belonging to one account and conversation.
 * @param owner - Captured account and conversation.
 * @returns A view-state key without credentials.
 */
export function submissionKey(owner: Owner): string { return JSON.stringify([owner.accountId, owner.sessionId]) }

/**
 * Retain ambiguous submission coordinates without treating an HTTP response as a saved image.
 * @param answer - local Host envelope, whose receipt fields are top-level.
 * @param owner - account and chat captured before the paid request.
 * @returns a conservative lock for pending/unknown outcomes, otherwise no unsettled view state.
 */
export function submissionFromAnswer(answer: unknown, owner: Owner): ImageSubmission | null {
  if (!object(answer)) return { ...owner, state: 'unknown', canQuery: false }
  const malformedSuccess = answer.ok === true && (!object(answer.payload)
    || typeof answer.payload.path !== 'string' || answer.payload.path === '')
  if (!malformedSuccess && ['not-submitted', 'failed', 'completed'].includes(String(answer.submission_state))) return null
  const httpFailure = typeof answer.httpStatus === 'number' && answer.httpStatus >= 400
    || typeof answer.code === 'string' && /^HTTP_\d{3}$/u.test(answer.code)
  const unconfirmed = answer.ok !== true && (httpFailure
    || ['TIMEOUT', 'TRANSPORT', 'NO_TASK_ID', 'UNKNOWN', 'CANCELLED', 'ABORTED', 'USER_CANCELLED'].includes(String(answer.code)))
  if (answer.submission_state !== 'pending' && answer.submission_state !== 'unknown' && !unconfirmed && !malformedSuccess) return null
  return { ...owner, state: answer.submission_state === 'pending' ? 'pending' : 'unknown', canQuery: false,
    ...identifier(answer.plan_id) ? { planId: answer.plan_id } : {},
    ...identifier(answer.operation_id) ? { operationId: answer.operation_id } : {},
    ...identifier(answer.task_id) ? { taskId: answer.task_id } : {},
    ...identifier(answer.request_id) ? { requestId: answer.request_id } : {} }
}

function listing(value: unknown, owner: Owner, retained: ImageSubmission | null): CheckResult {
  if (!object(value) || value.ok !== true || !object(value.payload) || value.payload.accountId !== owner.accountId
    || !Array.isArray(value.payload.projects)) return { ok: false }
  let matched: { status: string; projectId: string; task: Record<string, unknown> } | undefined
  const pending: { status: string; projectId: string; task: Record<string, unknown> }[] = []
  for (const project of value.payload.projects) {
    if (!object(project) || project.sessionId !== owner.sessionId || !identifier(project.id) || !Array.isArray(project.tasks)) {
      return { ok: false }
    }
    if (project.kind !== 'image') continue
    for (const task of project.tasks) {
      if (!object(task) || !identifier(task.id) || typeof task.status !== 'string'
        || !['planned', 'running', 'saving', 'editing', 'unknown', 'interrupted', 'completed', 'failed', 'cancelled'].includes(task.status)) {
        return { ok: false }
      }
      const fact = { status: task.status, projectId: project.id, task }
      if (project.id === retained?.planId && task.id === retained.operationId) matched = fact
      if (['running', 'saving', 'editing', 'unknown'].includes(task.status)
        || task.status === 'interrupted' && object(task.imageReceipt)) pending.push(fact)
    }
  }
  const candidate = matched !== undefined && pending.includes(matched) ? matched
    : pending.find(item => item.task.canQuery === true) ?? pending[0]
  if (candidate !== undefined) {
    const receipt = object(candidate.task.imageReceipt) ? candidate.task.imageReceipt : undefined
    const taskId = identifier(receipt?.taskId) ? receipt.taskId : undefined
    return { ok: true, completed: false, submission: { ...owner, planId: candidate.projectId, operationId: String(candidate.task.id),
      state: ['running', 'saving', 'editing'].includes(candidate.status) ? 'pending' : 'unknown',
      canQuery: candidate.task.canQuery === true && taskId !== undefined,
      ...taskId === undefined ? {} : { taskId },
      ...identifier(receipt?.requestId) ? { requestId: receipt.requestId } : {} } }
  }
  const settled = matched !== undefined && (['completed', 'failed', 'cancelled'].includes(matched.status)
    || matched.status === 'interrupted' && !object(matched.task.imageReceipt))
  if (retained !== null && !settled) {
    return { ok: true, submission: retained, completed: false }
  }
  return { ok: true, submission: null, completed: matched?.status === 'completed' }
}

/**
 * Reconcile the captured task against the owned Host listing, preserving missing/ambiguous records.
 * @param owner - current account and explicitly selected chat.
 * @param retained - earlier unsettled request, if one was captured by this view.
 * @param signal - view/account lifetime cancellation.
 * @returns current original-task state; failed reads never release a captured lock.
 */
export async function readImageSubmission(owner: Owner, retained: ImageSubmission | null, signal: AbortSignal): Promise<CheckResult> {
  try {
    const response = await fetch(appPath(`/credits/api/creative/projects?${new URLSearchParams({ session_id: owner.sessionId })}`), {
      credentials: 'same-origin', cache: 'no-store', signal, headers: { accept: 'application/json' },
    })
    if (!response.ok) return { ok: false }
    return listing(await response.json(), owner, retained)
  } catch (_readFailure) { return { ok: false } }
}

/**
 * Query only a Host-admitted original task, without another generation request.
 * @param retained - current owner and original task coordinates.
 * @param signal - view/account lifetime cancellation.
 * @returns the accepted query listing; no failure automatically retries or clears the retained task.
 */
export async function queryImageSubmission(retained: ImageSubmission, signal: AbortSignal): Promise<CheckResult> {
  if (!retained.canQuery || retained.planId === undefined || retained.operationId === undefined || retained.taskId === undefined) {
    return { ok: false }
  }
  try {
    const response = await fetch(appPath('/credits/api/creative/image/recover'), {
      method: 'POST', signal, credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ session_id: retained.sessionId, project_id: retained.planId, operation_id: retained.operationId }),
    })
    if (response.status !== 202) return { ok: false }
    return listing(await response.json(), retained, retained)
  } catch (_queryFailure) { return { ok: false } }
}
