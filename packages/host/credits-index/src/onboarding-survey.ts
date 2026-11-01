/** Account-owned onboarding questionnaires; registration eligibility comes only from the API. @module */
import { accountRetryAfter } from './account-read.ts'
import { sessionTransportFailure, type SessionFailure } from './session-failure.ts'

/** Stable scenario identifiers of the product-use-v1 questionnaire. */
export const SURVEY_OPTION_IDS = ['daily_qa', 'office_writing', 'coding', 'study_research', 'image_design',
  'video_creation', 'ecommerce_marketing', 'automation', 'other'] as const
export type SurveyOptionId = typeof SURVEY_OPTION_IDS[number]
const identifiers: ReadonlySet<string> = new Set(SURVEY_OPTION_IDS)
const BODY_LIMIT = 32 * 1024

/** Only public questionnaire fields are allowed into the renderer. */
export interface OnboardingSurvey {
  readonly schema_version: 1
  readonly survey_id: 'product-use-v1'
  readonly eligible: boolean
  readonly status: 'not_eligible' | 'pending' | 'deferred' | 'submitted'
  readonly options: readonly { readonly id: SurveyOptionId; readonly label: string; readonly label_en: string }[]
  readonly max_selections: 9
  readonly max_notes_length: 1000
  readonly selected_option_ids: readonly SurveyOptionId[]
  readonly notes: string
  readonly registered_at: number
  readonly submitted_at: number
  readonly deferred_at: number
}

/** Explicit answer or defer request; account coordinates are consumed by the Host, never forwarded. */
export interface SurveyRequest {
  readonly schema_version: 1
  readonly survey_id: 'product-use-v1'
  readonly selected_option_ids?: readonly SurveyOptionId[]
  readonly notes?: string
}

/** Safe result without authentication material or untrusted remote diagnostics. */
export type OnboardingSurveyResult = {
  readonly ok: true
  readonly payload: OnboardingSurvey
} | {
  readonly ok: false
  readonly code: string
  readonly httpStatus?: number
  readonly retryAfterSeconds?: number
  readonly failure?: SessionFailure
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function label(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
}
function note(value: unknown): value is string {
  return typeof value === 'string' && Array.from(value).length <= 1000 && !/[\u0000\u000b\u000c]/u.test(value)
}
function choices(value: unknown, required: boolean): SurveyOptionId[] | undefined {
  if (!Array.isArray(value) || value.length > 9 || required && value.length === 0
    || value.some(item => typeof item !== 'string' || !identifiers.has(item)) || new Set(value).size !== value.length) return undefined
  return SURVEY_OPTION_IDS.filter(id => value.includes(id))
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validate the current account's authority and retain only declared questionnaire fields.
 * @param value - Successful API data object, never a phone-login heuristic.
 * @returns The safe versioned survey, or absence for incomplete or conflicting data.
 */
export function parseOnboardingSurvey(value: unknown): OnboardingSurvey | undefined {
  const data = object(value)
  if (data?.schema_version !== 1 || data.survey_id !== 'product-use-v1' || typeof data.eligible !== 'boolean'
    || typeof data.status !== 'string' || !['not_eligible', 'pending', 'deferred', 'submitted'].includes(data.status)
    || data.max_selections !== 9 || data.max_notes_length !== 1000 || !Array.isArray(data.options) || data.options.length !== 9
    || !note(data.notes) || !timestamp(data.registered_at) || !timestamp(data.submitted_at)
    || !timestamp(data.deferred_at)) return undefined
  const options: OnboardingSurvey['options'][number][] = []
  for (const raw of data.options) {
    const item = object(raw)
    if (typeof item?.id !== 'string' || !identifiers.has(item.id) || !label(item.label) || !label(item.label_en)
      || options.some(option => option.id === item.id)) return undefined
    options.push({ id: item.id as SurveyOptionId, label: item.label, label_en: item.label_en })
  }
  const selected = choices(data.selected_option_ids, data.status === 'submitted')
  if (selected === undefined || !data.eligible && (data.status !== 'not_eligible' || data.registered_at !== 0)
    || data.eligible && (data.status === 'not_eligible' || data.registered_at === 0)
    || data.status === 'submitted' && data.submitted_at === 0
    || data.status !== 'submitted' && (data.submitted_at !== 0 || selected.length !== 0 || data.notes !== '')
    || data.status === 'deferred' && data.deferred_at === 0
    || (data.status === 'pending' || data.status === 'not_eligible') && data.deferred_at !== 0) return undefined
  return { schema_version: 1, survey_id: 'product-use-v1', eligible: data.eligible,
    status: data.status as OnboardingSurvey['status'], options, max_selections: 9, max_notes_length: 1000,
    selected_option_ids: selected, notes: data.notes, registered_at: data.registered_at,
    submitted_at: data.submitted_at, deferred_at: data.deferred_at }
}

/**
 * Select one explicit answer/defer payload after the route has checked the observed login.
 * @param value - Browser request including local owner guards.
 * @param defer - Whether the user explicitly chose to defer.
 * @returns Only fields accepted by the current-user API, or absence for invalid/extra fields.
 */
export function parseSurveyRequest(value: unknown, defer: boolean): SurveyRequest | undefined {
  const data = object(value)
  const allowed = ['schema_version', 'survey_id', 'expected_account_id', 'expected_account_owner',
    ...defer ? [] : ['selected_option_ids', 'notes']]
  if (data?.schema_version !== 1 || data.survey_id !== 'product-use-v1' || Object.keys(data).some(key => !allowed.includes(key))) return undefined
  if (defer) return { schema_version: 1, survey_id: 'product-use-v1' }
  const selected = choices(data.selected_option_ids, true)
  const notes = typeof data.notes === 'string'
    ? data.notes.replace(/\r\n/gu, '\n').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') : data.notes
  if (selected === undefined || notes !== undefined && !note(notes)) return undefined
  return { schema_version: 1, survey_id: 'product-use-v1', selected_option_ids: selected,
    ...typeof notes === 'string' ? { notes } : {} }
}

function failure(code: string, status?: number, retryAfterSeconds?: number): OnboardingSurveyResult {
  const reason: SessionFailure['reason'] = status === 401 || status === 403 ? 'upstream_rejected'
    : status === 429 ? 'rate_limited' : status === 408 || status === 504 ? 'timeout'
      : code === 'SURVEY_INVALID_RESPONSE' ? 'protocol' : 'upstream_unavailable'
  return { ok: false, code, ...status === undefined ? {} : { httpStatus: status },
    ...retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
    failure: { reason, stage: 'account-read', ...status === undefined ? {} : { status },
      ...retryAfterSeconds === undefined ? {} : { retryAfterSeconds } } }
}

/**
 * Read a bounded current-account result for a fixed GET or explicit mutation.
 * @param send - Authorized fixed-route account transport, owned by the initiating login.
 * @param signal - Request, plugin disposal, peer disconnect and deadline lifetime.
 * @returns Safe public state or observed failures; raw bodies and diagnostics never leave the Host.
 */
export async function readOnboardingSurvey(send: () => Promise<Response>, signal: AbortSignal): Promise<OnboardingSurveyResult> {
  try {
    signal.throwIfAborted()
    const response = await send()
    const status = response.status
    if (status === 404) { await response.body?.cancel(); return { ok: false, code: 'SURVEY_UNSUPPORTED', httpStatus: status } }
    if (status === 401 || status === 429 || status === 408 || status >= 500) {
      await response.body?.cancel().catch(() => {})
      return failure(status === 401 ? 'SURVEY_AUTH_REQUIRED' : status === 429 ? 'SURVEY_RATE_LIMITED'
        : status === 408 || status === 504 ? 'SURVEY_TIMEOUT' : 'SURVEY_UNAVAILABLE', status, accountRetryAfter(response.headers))
    }
    const reader = response.body?.getReader()
    if (reader === undefined) return failure('SURVEY_INVALID_RESPONSE', status)
    const chunks: Uint8Array[] = []
    let size = 0
    const interrupted = (): void => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', interrupted, { once: true })
    let decoded: unknown
    try {
      for (;;) {
        signal.throwIfAborted()
        const part = await reader.read()
        signal.throwIfAborted()
        if (part.done) break
        size += part.value.byteLength
        if (size > BODY_LIMIT) return failure('SURVEY_INVALID_RESPONSE', status)
        chunks.push(part.value)
      }
      try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return failure('SURVEY_INVALID_RESPONSE', status) }
    } finally { signal.removeEventListener('abort', interrupted); await reader.cancel().catch(() => {}) }
    const body = object(decoded)
    if (response.ok && body?.success === true) {
      const survey = parseOnboardingSurvey(body.data)
      return survey === undefined ? failure('SURVEY_INVALID_RESPONSE', status) : { ok: true, payload: survey }
    }
    const expected = new Map<number, readonly string[]>([[400, ['SURVEY_INVALID_REQUEST']], [403, ['SURVEY_NOT_ELIGIBLE']],
      [409, ['SURVEY_ALREADY_SUBMITTED']], [503, ['SURVEY_UNAVAILABLE']]])
    const code = typeof body?.code === 'string' && expected.get(status)?.includes(body.code) === true ? body.code
      : status === 401 ? 'SURVEY_AUTH_REQUIRED' : status === 403 ? 'SURVEY_ACCESS_DENIED'
        : status === 429 ? 'SURVEY_RATE_LIMITED' : status === 408 || status === 504 ? 'SURVEY_TIMEOUT'
          : response.ok ? 'SURVEY_INVALID_RESPONSE' : 'SURVEY_UNAVAILABLE'
    return failure(code, status, accountRetryAfter(response.headers))
  } catch (error) {
    const observed = sessionTransportFailure(signal.aborted ? signal.reason : error, 'account-read')
    return { ok: false, code: observed.reason === 'timeout' ? 'SURVEY_TIMEOUT' : 'SURVEY_NETWORK_ERROR', failure: observed }
  }
}
