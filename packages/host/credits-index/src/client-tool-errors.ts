/** Bounded, content-free reports of declared creation-tool failures. @module */
import { apiUrl } from './api-url.ts'

type ClientErrorTool = 'generate_video' | 'generate_video_project' | 'generate_image' | 'generate_image_project'
type ClientErrorStage = 'preflight' | 'submit' | 'query' | 'local-save'
type ClientErrorCode = 'DURATION_NOT_SUPPORTED' | 'AUDIO_NOT_SUPPORTED' | 'SHOT_DURATION_UNSUPPORTED'
  | 'MODEL_NOT_AVAILABLE' | 'INVALID_ARGUMENT' | 'CREATIVE_VIDEO_INTENT_UNAVAILABLE' | 'CREATIVE_SUBMISSION_UNKNOWN' | 'TRANSPORT_TIMEOUT'
  | 'QUEUE_WAIT_TIMEOUT' | 'TASK_FAILED' | 'LOCAL_SAVE_FAILED'

/** Client-observed workflow categories, without fault attribution, association ids or user content. */
export interface ClientToolErrorReport {
  readonly tool: ClientErrorTool
  readonly code: ClientErrorCode
  readonly stage: ClientErrorStage
  readonly model?: string
}

type Classification = Pick<ClientToolErrorReport, 'code' | 'stage'>
const CODES: Readonly<Record<string, Classification>> = {
  DURATION_NOT_SUPPORTED: { code: 'DURATION_NOT_SUPPORTED', stage: 'preflight' },
  AUDIO_NOT_SUPPORTED: { code: 'AUDIO_NOT_SUPPORTED', stage: 'preflight' },
  SHOT_DURATION_UNSUPPORTED: { code: 'SHOT_DURATION_UNSUPPORTED', stage: 'preflight' },
  MODEL_NOT_AVAILABLE: { code: 'MODEL_NOT_AVAILABLE', stage: 'preflight' },
  VIDEO_MODEL_UNAVAILABLE: { code: 'MODEL_NOT_AVAILABLE', stage: 'preflight' },
  IMAGE_MODEL_UNAVAILABLE: { code: 'MODEL_NOT_AVAILABLE', stage: 'preflight' },
  INVALID_ARGUMENT: { code: 'INVALID_ARGUMENT', stage: 'preflight' },
  INVALID_DURATION: { code: 'INVALID_ARGUMENT', stage: 'preflight' },
  INVALID_SHOT_DURATION: { code: 'INVALID_ARGUMENT', stage: 'preflight' },
  SHOT_DURATION_MISMATCH: { code: 'INVALID_ARGUMENT', stage: 'preflight' },
  SHOT_COUNT_MISMATCH: { code: 'INVALID_ARGUMENT', stage: 'preflight' },
  RESOLUTION_NOT_SUPPORTED: { code: 'INVALID_ARGUMENT', stage: 'preflight' },
  RATIO_NOT_SUPPORTED: { code: 'INVALID_ARGUMENT', stage: 'preflight' },
  CREATIVE_VIDEO_INTENT_UNAVAILABLE: { code: 'CREATIVE_VIDEO_INTENT_UNAVAILABLE', stage: 'preflight' },
  CREATIVE_SUBMISSION_UNKNOWN: { code: 'CREATIVE_SUBMISSION_UNKNOWN', stage: 'submit' },
  SUBMISSION_UNKNOWN: { code: 'CREATIVE_SUBMISSION_UNKNOWN', stage: 'submit' },
  VIDEO_SUBMISSION_UNKNOWN: { code: 'CREATIVE_SUBMISSION_UNKNOWN', stage: 'submit' },
  VIDEO_SUBMIT_UNKNOWN: { code: 'CREATIVE_SUBMISSION_UNKNOWN', stage: 'submit' },
  IMAGE_SUBMIT_UNKNOWN: { code: 'CREATIVE_SUBMISSION_UNKNOWN', stage: 'submit' },
  NO_TASK_ID: { code: 'CREATIVE_SUBMISSION_UNKNOWN', stage: 'submit' },
  VIDEO_SUBMIT_TIMEOUT: { code: 'TRANSPORT_TIMEOUT', stage: 'submit' },
  IMAGE_SUBMIT_TIMEOUT: { code: 'TRANSPORT_TIMEOUT', stage: 'submit' },
  VIDEO_QUERY_TIMEOUT: { code: 'TRANSPORT_TIMEOUT', stage: 'query' },
  IMAGE_QUERY_TIMEOUT: { code: 'TRANSPORT_TIMEOUT', stage: 'query' },
  QUEUE_WAIT_TIMEOUT: { code: 'QUEUE_WAIT_TIMEOUT', stage: 'query' },
  VIDEO_TASK_TIMEOUT: { code: 'QUEUE_WAIT_TIMEOUT', stage: 'query' },
  TASK_FAILED: { code: 'TASK_FAILED', stage: 'query' },
  PROVIDER_TASK_FAILED: { code: 'TASK_FAILED', stage: 'query' },
  LOCAL_SAVE_FAILED: { code: 'LOCAL_SAVE_FAILED', stage: 'local-save' },
  PROJECT_STORAGE_FAILED: { code: 'LOCAL_SAVE_FAILED', stage: 'local-save' },
  ARTIFACT_PUBLISH_FAILED: { code: 'LOCAL_SAVE_FAILED', stage: 'local-save' },
  VIDEO_RECEIPT_SAVE_FAILED: { code: 'LOCAL_SAVE_FAILED', stage: 'local-save' },
  IMAGE_RECEIPT_SAVE_FAILED: { code: 'LOCAL_SAVE_FAILED', stage: 'local-save' },
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function admittedTool(tool: string): tool is ClientErrorTool {
  return tool === 'generate_video' || tool === 'generate_video_project'
    || tool === 'generate_image' || tool === 'generate_image_project'
}

/**
 * Select finite failure metadata from the canonical tool value, independently of isError.
 * @param tool - Actual registered tool name, not a result-supplied name.
 * @param args - Parsed invocation arguments; only a known exact model id may be selected.
 * @param value - Structured execution value; prose and rendered content are never parsed.
 * @param knownModelIds - Trusted current catalog ids; unrecognized model values are omitted.
 * @returns Safe report, or null for successful, ordinary waiting, malformed or undeclared outcomes.
 */
export function parseClientToolError(
  tool: string, args: unknown, value: unknown, knownModelIds: ReadonlySet<string>,
): ClientToolErrorReport | null {
  if (!admittedTool(tool)) return null
  const result = record(value)
  if (result === undefined || typeof result.status !== 'string' || !['failed', 'unknown', 'pending'].includes(result.status)
    || typeof result.code !== 'string') return null
  let classification: Classification | undefined
  if (result.code === 'TRANSPORT_TIMEOUT') {
    if (result.stage === 'submit' || result.stage === 'query') classification = { code: 'TRANSPORT_TIMEOUT', stage: result.stage }
  } else if (Object.hasOwn(CODES, result.code)) classification = CODES[result.code]
  if (classification === undefined) return null
  if ((classification.stage === 'preflight' || classification.code === 'TASK_FAILED') && result.status !== 'failed') return null
  const model = [result.model, record(args)?.model].find((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 255 && knownModelIds.has(candidate))
  return { tool, ...classification, ...model === undefined ? {} : { model } }
}

/** Ephemeral current login; identity is checked locally and only the token enters Authorization. */
export interface ClientToolErrorAccount {
  readonly accountId: string
  readonly token: string
}

/** Host-owned transport and current login; reports never accept a credential from tool values. */
export interface ClientToolErrorReporterOptions {
  /** Complete account API base, including its deployment prefix. */
  readonly baseUrl: string
  /** Complete report deadline, 1–3000 ms, including credential lookup and response cleanup. */
  readonly timeoutMs: number
  /** @returns Current valid product login and access token, never the model relay key. */
  readonly key: () => Promise<ClientToolErrorAccount | undefined>
  /** @returns Trusted model ids already read for the current account; no catalog request is started here. */
  readonly knownModelIds: () => ReadonlySet<string>
  /** Optional same-base transport; default fetch refuses redirects. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

/** Stop waiting on a late credential or transport without dispatching follow-up work after disposal. */
async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => { reject(new Error('Client error report stopped')) }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
  })
  // Both promises must be observed even when cancellation preceded this call.
  try { return await Promise.race([aborted, pending]) }
  finally { if (stop !== undefined) signal.removeEventListener('abort', stop) }
}

/** At most two active, single-attempt reports; capacity overflow and all failures are discarded. */
export class ClientToolErrorReporter {
  private readonly url: string
  private readonly active = new Set<{ abort: AbortController; done: Promise<void> }>()
  private readonly seen = new WeakSet<object>()
  private closed = false

  /** @param options - Validated report deadline, configured API base and current-account access. */
  constructor(private readonly options: ClientToolErrorReporterOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3000) {
      throw new RangeError('Client error report timeout must be 1–3000 milliseconds')
    }
    this.url = apiUrl(options.baseUrl, '/api/client-errors')
  }

  /**
   * Admit one report without awaiting credentials or I/O on the tool workflow.
   * @param tool - Actual registered tool name.
   * @param args - Original parsed arguments; no content is retained.
   * @param value - Structured tool value, including semantic failed values with isError false.
   * @param invocation - Optional execution identity for duplicate-hook suppression; never serialized.
   * @param expectedAccountId - Original account captured before generation; absence suppresses the report.
   */
  submit(tool: string, args: unknown, value: unknown, invocation?: object, expectedAccountId?: string): void {
    if (expectedAccountId === undefined || expectedAccountId === '' || this.closed
      || invocation !== undefined && this.seen.has(invocation)) return
    if (invocation !== undefined) this.seen.add(invocation)
    if (this.active.size >= 2) return
    let report: ClientToolErrorReport | null
    try { report = parseClientToolError(tool, args, value, this.options.knownModelIds()) }
    catch (_invalidCatalog: unknown) { return /* Diagnostic admission never changes the creation outcome. */ }
    if (report === null) return
    const body = JSON.stringify(report)
    if (Buffer.byteLength(body) > 2048) return
    const operation = { abort: new AbortController(), done: Promise.resolve() }
    this.active.add(operation)
    operation.done = this.send(body, operation.abort.signal, expectedAccountId).finally(() => { this.active.delete(operation) })
  }

  /** Abort admitted reports and wait until none can initiate another request. */
  async dispose(): Promise<void> {
    this.closed = true
    const active = [...this.active]
    for (const operation of active) operation.abort.abort()
    await Promise.all(active.map(operation => operation.done))
  }

  private async send(body: string, owner: AbortSignal, expectedAccountId: string): Promise<void> {
    const signal = AbortSignal.any([owner, AbortSignal.timeout(this.options.timeoutMs)])
    try {
      const account = await bounded(Promise.resolve().then(() => { signal.throwIfAborted(); return this.options.key() }), signal)
      if (account === undefined || account.accountId !== expectedAccountId || account.token === '') return
      signal.throwIfAborted()
      const pending = (this.options.fetch ?? fetch)(this.url, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' }, body,
      })
      // An injected transport may settle after cancellation; close that late response too.
      void pending.then((response) => {
        if (signal.aborted) void response.body?.cancel().catch((_closedBody: unknown) => { /* No diagnostics are recursively reported. */ })
      }, (_transportFailure: unknown) => { /* The bounded wait owns the same failure. */ })
      const response = await bounded(pending, signal)
      if (response.body !== null) await bounded(response.body.cancel(), signal)
      // Status and body never trigger retry, another report, or a user-visible failure.
    } catch (_reportFailure: unknown) { /* Reporting is best effort and independent of creation. */ }
  }
}
