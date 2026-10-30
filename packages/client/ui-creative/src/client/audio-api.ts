/** Public, same-origin speech APIs; provider credentials and procurement data never reach the browser. @module */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AudioParams } from '@deepseek-ai/dsh-credits-index/src/media.ts'
import type { AudioQuote, AudioRequest } from '@deepseek-ai/dsh-credits-index/src/audio-generation.ts'

/** Speech model with explicitly declared parameter menus and optional execution readiness. */
export interface AudioModel { readonly id: string; readonly displayName: string; readonly params: AudioParams }

/** One independent durable speech submission; unknown outcomes remain queryable without a new POST. */
export interface AudioSubmission {
  readonly submissionId: string
  readonly model: string
  readonly status: 'pending' | 'unknown' | 'completed' | 'failed'
  readonly taskId?: string
  readonly code?: string
  readonly mediaUrl?: string
  readonly filename?: string
}

/** Localized error selection never uses a provider's free-form message. */
export type AudioApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 && value.every(item => typeof item === 'string' && item !== '' && item.length <= 128)
}
function model(value: unknown): value is AudioModel {
  if (!record(value) || value.kind !== 'audio' || value.route !== '/v1/audio/speech' || typeof value.id !== 'string'
    || typeof value.displayName !== 'string' || !record(value.params)) return false
  const params = value.params
  return texts(params.voices) && texts(params.formats) && params.formats.every(format => format === 'mp3' || format === 'wav')
    && typeof params.maxCharacters === 'number' && Number.isSafeInteger(params.maxCharacters) && params.maxCharacters > 0
    && params.maxCharacters <= 1_000_000 && typeof params.instructions === 'boolean'
    && (params.speedRange === undefined || record(params.speedRange) && typeof params.speedRange.minimum === 'number'
      && Number.isFinite(params.speedRange.minimum) && params.speedRange.minimum > 0 && typeof params.speedRange.maximum === 'number'
      && Number.isFinite(params.speedRange.maximum) && params.speedRange.maximum >= params.speedRange.minimum)
    && (params.execution === undefined || record(params.execution) && params.execution.protocol === 'openai-speech-v1'
      && params.execution.quoteRoute === '/v1/audio/quote' && params.execution.taskRoute === '/v1/tasks')
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(value)
}
function submission(value: unknown, sessionId: string): value is AudioSubmission {
  if (!record(value) || !uuid(value.submissionId) || typeof value.model !== 'string'
    || typeof value.status !== 'string' || !['pending', 'unknown', 'completed', 'failed'].includes(value.status)) return false
  if (value.taskId !== undefined && typeof value.taskId !== 'string' || value.code !== undefined && typeof value.code !== 'string'
    || value.filename !== undefined && typeof value.filename !== 'string') return false
  if (value.mediaUrl !== undefined) {
    if (typeof value.mediaUrl !== 'string') return false
    const expected = `/credits/api/audio/content?${new URLSearchParams({ session_id: sessionId, submission_id: value.submissionId })}`
    if (value.mediaUrl !== expected) return false
  }
  return value.status !== 'completed' || value.mediaUrl !== undefined
}
async function json(path: string, signal: AbortSignal, body?: unknown): Promise<AudioApiResult<unknown>> {
  let response: Response
  try {
    response = await fetch(appPath(path), { signal, cache: 'no-store', credentials: 'same-origin',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  } catch (error) { return { ok: false, code: signal.aborted ? 'AUDIO_CANCELLED'
    : error instanceof Error && error.name === 'TimeoutError' ? 'AUDIO_TIMEOUT'
      : error instanceof TypeError ? 'AUDIO_NETWORK' : 'AUDIO_OPERATION_FAILED' } }
  const httpFailure = response.status === 401 || response.status === 403 ? 'AUDIO_PERMISSION'
    : response.status === 429 ? 'AUDIO_BUSY' : response.status === 408 || response.status === 504 ? 'AUDIO_TIMEOUT'
      : response.status === 400 || response.status === 422 ? 'AUDIO_INVALID_REQUEST' : 'AUDIO_UNAVAILABLE'
  let value: unknown
  try { value = await response.json() }
  catch (_invalidResponse) { return { ok: false, code: response.ok ? 'AUDIO_RESPONSE_INVALID' : httpFailure } }
  if (!response.ok || !record(value) || value.ok !== true) return { ok: false,
    code: record(value) && typeof value.code === 'string' ? value.code : response.ok ? 'AUDIO_RESPONSE_INVALID' : httpFailure }
  return { ok: true, value }
}

/**
 * Read the current account’s explicitly declared speech models.
 * @param signal - View lifetime.
 * @returns Authorized public models and their owning product account, or a safe read failure.
 */
export async function readAudioModels(signal: AbortSignal): Promise<AudioApiResult<{
  readonly accountId: string
  readonly models: readonly AudioModel[]
}>> {
  const result = await json('/credits/api/audio/models', signal)
  if (!result.ok) return result
  if (!record(result.value) || typeof result.value.accountId !== 'string' || !Array.isArray(result.value.models) || result.value.models.length > 256
    || !result.value.models.every(model)) return { ok: false, code: 'AUDIO_RESPONSE_INVALID' }
  return { ok: true, value: { accountId: result.value.accountId, models: result.value.models } }
}

/**
 * Read retained speech attempts for this exact account and chat.
 * @param accountId - signed-in model discovery owner.
 * @param sessionId - owning chat.
 * @param signal - view lifetime.
 * @returns Retained independent submissions.
 */
export async function readAudioSubmissions(accountId: string, sessionId: string,
  signal: AbortSignal): Promise<AudioApiResult<readonly AudioSubmission[]>> {
  const result = await json(`/credits/api/audio/submissions?${new URLSearchParams({ account_id: accountId, session_id: sessionId })}`, signal)
  if (!result.ok) return result
  return record(result.value) && Array.isArray(result.value.submissions)
    && result.value.submissions.every(item => submission(item, sessionId))
    ? { ok: true, value: result.value.submissions } : { ok: false, code: 'AUDIO_RESPONSE_INVALID' }
}

/**
 * Request a free estimate for the exact speech parameters.
 * @param accountId - signed-in model discovery owner.
 * @param sessionId - owning chat.
 * @param request - exact parameters.
 * @param signal - form lifetime.
 * @returns Free estimate only.
 */
export async function quoteAudio(accountId: string, sessionId: string, request: AudioRequest,
  signal: AbortSignal): Promise<AudioApiResult<AudioQuote>> {
  const result = await json('/credits/api/audio/quote', signal, { account_id: accountId, session_id: sessionId, ...request })
  if (!result.ok) return result
  const quote = record(result.value) ? result.value.quote : undefined
  if (!record(quote) || quote.object !== 'audio.quote' || quote.schema_version !== 1 || typeof quote.quote_id !== 'string'
    || typeof quote.account_binding !== 'string' || quote.model !== request.model || typeof quote.request_fingerprint !== 'string'
    || !/^[a-f\d]{64}$/u.test(quote.request_fingerprint) || typeof quote.estimated_total !== 'string'
    || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,12})?$/u.test(quote.estimated_total) || typeof quote.total_quota !== 'number'
    || !Number.isSafeInteger(quote.total_quota) || quote.total_quota < 0 || (quote.currency !== 'CNY' && quote.currency !== 'USD')
    || typeof quote.pricing_revision !== 'string' || typeof quote.created_at !== 'number' || !Number.isSafeInteger(quote.created_at)
    || typeof quote.expires_at !== 'number' || !Number.isSafeInteger(quote.expires_at) || quote.expires_at - quote.created_at !== 60
    || quote.created_at > Date.now() / 1000 + 5 || quote.expires_at <= Date.now() / 1000
    || quote.estimate_only !== true || quote.charged !== false || quote.submitted !== false || quote.reserved !== false) {
    return { ok: false, code: 'AUDIO_RESPONSE_INVALID' }
  }
  return { ok: true, value: { object: 'audio.quote', schema_version: 1, quote_id: quote.quote_id,
    account_binding: quote.account_binding, model: request.model, request_fingerprint: quote.request_fingerprint,
    estimated_total: quote.estimated_total, total_quota: quote.total_quota, currency: quote.currency === 'CNY' ? 'CNY' : 'USD',
    pricing_revision: quote.pricing_revision, created_at: quote.created_at, expires_at: quote.expires_at,
    estimate_only: true, charged: false, submitted: false, reserved: false } }
}

/**
 * Submit one explicitly confirmed estimate under its stable submission UUID.
 * @param accountId - signed-in model discovery owner.
 * @param sessionId - owning chat.
 * @param request - quoted parameters.
 * @param quoteId - current free estimate.
 * @param submissionId - one click identity.
 * @param signal - view lifetime.
 * @returns Retained outcome; never retries submission.
 */
export async function generateAudio(accountId: string, sessionId: string, request: AudioRequest, quoteId: string, submissionId: string,
  signal: AbortSignal): Promise<AudioApiResult<AudioSubmission>> {
  const result = await json('/credits/api/audio/generate', signal, { account_id: accountId, session_id: sessionId, ...request,
    quote_id: quoteId, submission_id: submissionId })
  if (!result.ok) return result
  return submission(result.value, sessionId) && result.value.submissionId === submissionId && result.value.model === request.model
    ? { ok: true, value: result.value } : { ok: false, code: 'AUDIO_RESPONSE_INVALID' }
}

/**
 * Recover the original speech attempt without requesting another generation.
 * @param accountId - signed-in model discovery owner.
 * @param sessionId - owning chat.
 * @param submissionId - original submission.
 * @param signal - view lifetime.
 * @returns Original task only; never generates again.
 */
export async function recoverAudio(accountId: string, sessionId: string, submissionId: string,
  signal: AbortSignal): Promise<AudioApiResult<AudioSubmission>> {
  const result = await json('/credits/api/audio/recover', signal, { account_id: accountId, session_id: sessionId, submission_id: submissionId })
  if (!result.ok) return result
  return submission(result.value, sessionId) && result.value.submissionId === submissionId
    ? { ok: true, value: result.value } : { ok: false, code: 'AUDIO_RESPONSE_INVALID' }
}
