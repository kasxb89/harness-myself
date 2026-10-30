/** Bounded OpenAI speech execution; submission and original-task recovery never retry a POST. @module */
import { createHash } from 'node:crypto'
import type { AudioParams, ModelCapability } from './media.ts'
import { readMediaBytes, MediaTransferLimitError } from './media-transfer.ts'
import { isAccountBalanceRejectionText } from './account-balance.ts'

/** Complete speech parameters; one request produces one audio file. */
export interface AudioRequest {
  readonly model: string
  readonly input: string
  readonly voice: string
  readonly response_format: 'wav' | 'mp3'
  readonly speed?: number
  readonly instructions?: string
}

/** Free, account-bound estimate for the exact speech request, valid for sixty seconds. */
export interface AudioQuote {
  readonly object: 'audio.quote'
  readonly schema_version: 1
  readonly quote_id: string
  readonly account_binding: string
  readonly model: string
  readonly request_fingerprint: string
  readonly total_quota: number
  readonly estimated_total: string
  readonly currency: 'CNY' | 'USD'
  readonly pricing_revision: string
  readonly created_at: number
  readonly expires_at: number
  readonly estimate_only: true
  readonly charged: false
  readonly submitted: false
  readonly reserved: false
}

/** Stable UI-safe failure identity; no provider message or URL is returned. */
export type AudioFailureCode = 'AUDIO_INVALID_REQUEST' | 'AUDIO_NOT_READY' | 'AUDIO_CANCELLED'
  | 'AUDIO_TIMEOUT' | 'AUDIO_NETWORK' | 'AUDIO_BUSY' | 'AUDIO_PERMISSION' | 'AUDIO_BALANCE'
  | 'AUDIO_RESPONSE_INVALID' | 'AUDIO_TOO_LARGE' | 'AUDIO_TASK_FAILED' | 'AUDIO_UNAVAILABLE'
  | 'AUDIO_OPERATION_FAILED'

/** Validated original-task coordinates; neither identifier authorizes a new submission. */
export interface AudioReceipt {
  readonly taskId?: string
  readonly requestId?: string
}

/** Billing remains unconfirmed when speech fails or its outcome is unknown. */
export type AudioExecutionResult = AudioReceipt & (
  | { readonly status: 'completed'; readonly bytes: Uint8Array; readonly format: 'wav' | 'mp3'; readonly mimeType: string }
  | { readonly status: 'pending' | 'unknown'; readonly code?: AudioFailureCode }
  | { readonly status: 'failed'; readonly code: AudioFailureCode; readonly billing: 'unknown' }
)

interface AudioObservation {
  receipt: AudioReceipt
  readonly received?: (receipt: AudioReceipt) => Promise<void>
}

async function observe(observation: AudioObservation, receipt: AudioReceipt): Promise<void> {
  observation.receipt = { ...observation.receipt, ...receipt }
  await observation.received?.(observation.receipt)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) && !/^(?:sk-|nap_)/iu.test(value)
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 }

/**
 * Validate untrusted speech parameters against explicit live capability declarations.
 * @param value - Caller JSON without authentication or provider routing fields.
 * @param capability - Current account-authorized public model.
 * @returns Normalized parameters, or null when unsupported or undeclared.
 */
export function validateAudioRequest(value: unknown, capability: ModelCapability): AudioRequest | null {
  const request = record(value)
  if (capability.kind !== 'audio' || capability.route !== '/v1/audio/speech' || request === null) return null
  const params = capability.params as AudioParams
  if (params.execution === undefined || request.model !== capability.id || typeof request.input !== 'string'
    || request.input.trim() === '' || Array.from(request.input).length > params.maxCharacters
    || typeof request.voice !== 'string' || !params.voices.includes(request.voice)
    || (request.response_format !== 'wav' && request.response_format !== 'mp3')
    || !params.formats.includes(request.response_format)
    || Object.keys(request).some(key => !['model', 'input', 'voice', 'response_format', 'speed', 'instructions'].includes(key))) return null
  if (request.speed !== undefined && (params.speedRange === undefined || typeof request.speed !== 'number'
    || !Number.isFinite(request.speed) || request.speed < params.speedRange.minimum
    || request.speed > params.speedRange.maximum)) return null
  if (request.instructions !== undefined && (!params.instructions || typeof request.instructions !== 'string'
    || Array.from(request.instructions).length > params.maxCharacters)) return null
  return { model: request.model, input: request.input, voice: request.voice, response_format: request.response_format,
    ...(typeof request.speed === 'number' ? { speed: request.speed } : {}),
    ...(typeof request.instructions === 'string' ? { instructions: request.instructions } : {}) }
}

/**
 * Hash all submitted parameters, including the exact text, in a stable field order.
 * @param request - Validated speech request.
 * @returns SHA-256 hex binding for a server estimate and a local durable submission.
 */
export function audioRequestFingerprint(request: AudioRequest): string {
  return createHash('sha256').update(JSON.stringify({ model: request.model, input: request.input, voice: request.voice,
    response_format: request.response_format, ...(request.speed === undefined ? {} : { speed: request.speed }),
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }) })).digest('hex')
}

/**
 * Accept only a free, current estimate bound to the complete speech request.
 * @param value - Public estimate JSON from the gateway.
 * @param expected - Exact request and optional previously captured opaque account binding; now is Unix seconds.
 * @returns Validated estimate or null; unknown fields cannot change charging semantics.
 */
export function parseAudioQuote(value: unknown, expected: {
  readonly request: AudioRequest
  readonly accountBinding?: string
  readonly now?: number
}): AudioQuote | null {
  const quote = record(value)
  const now = expected.now ?? Date.now() / 1000
  if (quote === null || quote.object !== 'audio.quote' || quote.schema_version !== 1 || !identifier(quote.quote_id)
    || !text(quote.account_binding) || expected.accountBinding !== undefined && quote.account_binding !== expected.accountBinding
    || quote.model !== expected.request.model || quote.request_fingerprint !== audioRequestFingerprint(expected.request)
    || typeof quote.total_quota !== 'number' || !Number.isSafeInteger(quote.total_quota) || quote.total_quota < 0
    || typeof quote.estimated_total !== 'string' || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,12})?$/u.test(quote.estimated_total)
    || (quote.currency !== 'CNY' && quote.currency !== 'USD') || !text(quote.pricing_revision)
    || typeof quote.created_at !== 'number' || !Number.isSafeInteger(quote.created_at)
    || typeof quote.expires_at !== 'number' || !Number.isSafeInteger(quote.expires_at)
    || quote.expires_at - quote.created_at !== 60 || quote.created_at > now + 5 || quote.expires_at <= now
    || quote.estimate_only !== true || quote.charged !== false || quote.submitted !== false || quote.reserved !== false) return null
  const allowed = ['object', 'schema_version', 'quote_id', 'account_binding', 'model', 'request_fingerprint', 'total_quota',
    'estimated_total', 'currency', 'pricing_revision', 'created_at', 'expires_at', 'estimate_only', 'charged', 'submitted', 'reserved']
  if (Object.keys(quote).some(key => !allowed.includes(key))) return null
  return { object: 'audio.quote', schema_version: 1, quote_id: quote.quote_id, account_binding: quote.account_binding,
    model: expected.request.model, request_fingerprint: audioRequestFingerprint(expected.request), total_quota: quote.total_quota,
    estimated_total: quote.estimated_total, currency: quote.currency, pricing_revision: quote.pricing_revision,
    created_at: quote.created_at, expires_at: quote.expires_at, estimate_only: true, charged: false, submitted: false, reserved: false }
}

function audio(bytes: Uint8Array, format: AudioRequest['response_format']): AudioExecutionResult {
  const wav = bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WAVE'
  const marker = bytes[1]
  const mp3 = bytes.length >= 3 && (Buffer.from(bytes.subarray(0, 3)).toString('ascii') === 'ID3'
    || bytes[0] === 0xff && marker !== undefined && (marker & 0xe0) === 0xe0 && (marker & 0x06) !== 0)
  if (format === 'wav' ? !wav : !mp3) return { status: 'unknown', code: 'AUDIO_RESPONSE_INVALID' }
  return { status: 'completed', bytes, format, mimeType: format === 'wav' ? 'audio/wav' : 'audio/mpeg' }
}

function failure(error: unknown, signal: AbortSignal): AudioFailureCode {
  if (error instanceof MediaTransferLimitError) return 'AUDIO_TOO_LARGE'
  if (error instanceof Error && error.name === 'TimeoutError'
    || signal.reason instanceof Error && signal.reason.name === 'TimeoutError') return 'AUDIO_TIMEOUT'
  if (signal.aborted || error instanceof Error && error.name === 'AbortError') return 'AUDIO_CANCELLED'
  return error instanceof TypeError ? 'AUDIO_NETWORK' : 'AUDIO_OPERATION_FAILED'
}

async function responseResult(response: Response, request: AudioRequest, signal: AbortSignal, maxBytes: number,
  observation: AudioObservation,
  originalTaskId?: string): Promise<AudioExecutionResult> {
  const requestId = response.headers.get('x-oneapi-request-id') ?? response.headers.get('x-request-id')
  if (identifier(requestId)) await observe(observation, { requestId })
  const retained = observation.receipt
  if (!response.ok) {
    if (response.status === 403) {
      const errorBody = await readMediaBytes(response, Math.min(maxBytes, 64 * 1024), signal)
      return { status: 'unknown', ...retained, code: isAccountBalanceRejectionText(errorBody.toString('utf8'), response.status)
        ? 'AUDIO_BALANCE' : 'AUDIO_PERMISSION' }
    }
    await response.body?.cancel()
    return { status: 'unknown', ...retained, code: response.status === 429 ? 'AUDIO_BUSY'
      : response.status === 401 ? 'AUDIO_PERMISSION' : response.status === 400 || response.status === 422 ? 'AUDIO_INVALID_REQUEST'
        : response.status === 408 || response.status === 504 ? 'AUDIO_TIMEOUT' : 'AUDIO_UNAVAILABLE' }
  }
  const bytes = await readMediaBytes(response, maxBytes, signal)
  if (!response.headers.get('content-type')?.includes('json')) return { ...audio(bytes, request.response_format), ...retained }
  let value: Record<string, unknown> | null
  try { value = record(JSON.parse(bytes.toString('utf8'))) }
  catch (_invalidJson) { return { status: 'unknown', ...retained, code: 'AUDIO_RESPONSE_INVALID' } }
  const taskValue = record(value?.data) ?? value
  const taskId = taskValue?.task_id
  if (originalTaskId !== undefined && taskId !== undefined && taskId !== originalTaskId) {
    return { status: 'unknown', ...retained, code: 'AUDIO_RESPONSE_INVALID' }
  }
  if (taskId !== undefined && !identifier(taskId) || taskValue?.model !== undefined && taskValue.model !== request.model) {
    return { status: 'unknown', ...retained, code: 'AUDIO_RESPONSE_INVALID' }
  }
  const task = identifier(taskId) ? taskId : originalTaskId
  if (task !== undefined) await observe(observation, { taskId: task })
  const identity = observation.receipt
  if (taskValue?.status === 'failed' || taskValue?.status === 'cancelled') {
    return { status: 'failed', ...identity, code: 'AUDIO_TASK_FAILED', billing: 'unknown' }
  }
  const result = record(record(taskValue?.result)?.audio)
  if (taskValue?.status === 'completed' && result !== null && result.format === request.response_format
    && typeof result.data === 'string' && result.data.length <= Math.ceil(maxBytes / 3) * 4
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(result.data)) {
    const decoded = Buffer.from(result.data, 'base64')
    if (decoded.length > maxBytes) return { status: 'unknown', ...identity, code: 'AUDIO_TOO_LARGE' }
    return { ...audio(decoded, request.response_format), ...identity }
  }
  if (task !== undefined && typeof taskValue?.status === 'string' && ['pending', 'queued', 'running', 'processing', 'submitted'].includes(taskValue.status)) {
    return { status: 'pending', ...identity }
  }
  return { status: 'unknown', ...identity, code: 'AUDIO_RESPONSE_INVALID' }
}

/**
 * Dispatch one speech POST through account-owned transport. Persist the submission before calling.
 * @param options - Validated request, bounded response read, and authenticated transport; transport sends the quote id.
 * @returns Audio bytes, retained original task identity, or a safe unknown outcome. No automatic retry occurs.
 */
export async function submitAudio(options: {
  readonly request: AudioRequest
  readonly signal: AbortSignal
  readonly maxBytes: number
  readonly submit: (request: AudioRequest, signal: AbortSignal) => Promise<Response>
  /** Persist validated coordinates before reading binary audio or decoding a task result. Failure stops dependent work. */
  readonly received?: (receipt: AudioReceipt) => Promise<void>
}): Promise<AudioExecutionResult> {
  if (options.signal.aborted) return { status: 'failed', code: 'AUDIO_CANCELLED', billing: 'unknown' }
  const observation: AudioObservation = { receipt: {}, ...options.received === undefined ? {} : { received: options.received } }
  let response: Response | undefined
  try {
    response = await options.submit(options.request, options.signal)
    return await responseResult(response, options.request, options.signal, options.maxBytes, observation)
  }
  catch (error) {
    await response?.body?.cancel().catch((_cancelFailure: unknown) => { /* Preserve the original failure and receipt. */ })
    return { status: 'unknown', ...observation.receipt, code: failure(error, options.signal) }
  }
}

/**
 * Query exactly the original audio task through a Host-owned GET route.
 * @param taskId - Retained, account-verified original task id.
 * @param options - Original parameters, bounded response read and read-only transport.
 * @returns Current outcome without ever authorizing or dispatching another generation.
 */
export async function readAudioTask(taskId: string, options: {
  readonly request: AudioRequest
  readonly signal: AbortSignal
  readonly maxBytes: number
  readonly read: (taskId: string, signal: AbortSignal) => Promise<Response>
  /** Persist newly observed coordinates before decoding a recovered result. Failure stops dependent work. */
  readonly received?: (receipt: AudioReceipt) => Promise<void>
}): Promise<AudioExecutionResult> {
  if (!identifier(taskId)) return { status: 'unknown', code: 'AUDIO_RESPONSE_INVALID' }
  const observation: AudioObservation = { receipt: { taskId }, ...options.received === undefined ? {} : { received: options.received } }
  let response: Response | undefined
  try {
    response = await options.read(taskId, options.signal)
    return await responseResult(response, options.request, options.signal, options.maxBytes, observation, taskId)
  }
  catch (error) {
    await response?.body?.cancel().catch((_cancelFailure: unknown) => { /* Preserve the original failure and receipt. */ })
    return { status: 'unknown', ...observation.receipt, code: failure(error, options.signal) }
  }
}
