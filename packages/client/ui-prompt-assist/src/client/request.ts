import type { PromptAssistKey } from './locales.ts'
import type { PromptAssistOwner } from './index.ts'

interface AssistRequest {
  readonly accountId: string
  readonly sessionId: string | null
  readonly expectedSelection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | null
  readonly kind: PromptAssistOwner['kind']
  readonly prompt: string
  readonly instruction: string
  readonly references: readonly string[]
  readonly generation: PromptAssistOwner['generation']
}

/** Localized failure classification; raw upstream messages never reach the UI. */
export class AssistFailure extends Error {
  constructor(readonly key: PromptAssistKey) { super(key) }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recheck the live local account before model dispatch or replacing the main prompt.
 * @param accountId - Account identity captured by the creation workspace.
 * @param signal - Cancellation for the account check.
 */
export async function verifyAccount(accountId: string, signal: AbortSignal): Promise<void> {
  try {
    const response = await fetch('/credits/api/session', { headers: { accept: 'application/json' }, signal })
    if (!response.ok) throw new AssistFailure('accountCheckFailed')
    const envelope: unknown = await response.json()
    if (!object(envelope) || envelope.ok !== true) throw new AssistFailure('accountCheckFailed')
    const session = object(envelope.payload) && typeof envelope.payload.signedIn === 'boolean' ? envelope.payload : envelope
    if (session.signedIn !== true || !object(session.account) || session.account.id !== accountId) {
      throw new AssistFailure('accountChanged')
    }
  } catch (failure) {
    if (signal.aborted || failure instanceof AssistFailure) throw failure
    throw new AssistFailure('accountCheckFailed')
  }
}

/**
 * Send only creation data; the Host resolves the signed-in account credential.
 * @param body - Creation draft, revision feedback, references, and expected account.
 * @param signal - Cancellation for the prompt-writing request.
 * @returns The validated replacement prompt.
 */
export async function requestPrompt(body: AssistRequest, signal: AbortSignal): Promise<string> {
  const response = await fetch('/credits/api/prompt/assist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (response.status === 401) throw new AssistFailure('expired')
  if (response.status === 402) throw new AssistFailure('balance')
  const envelope: unknown = await response.json()
  if (!object(envelope)) throw new AssistFailure('resultUnknown')
  if (!response.ok || envelope.ok !== true) {
    if (envelope.sessionInvalid === true
      || envelope.code === 'SESSION_REQUIRED' || envelope.code === 'RELAY_MISSING') {
      throw new AssistFailure('expired')
    }
    if (envelope.code === 'INSUFFICIENT_BALANCE') throw new AssistFailure('balance')
    if (envelope.code === 'ACCOUNT_CHANGED') throw new AssistFailure('accountChanged')
    if (envelope.code === 'PROMPT_ASSIST_SELECTION_CHANGED') throw new AssistFailure('selectionChanged')
    if (envelope.code === 'PROMPT_ASSIST_VISION_REQUIRED') throw new AssistFailure('visionRequired')
    if (envelope.code === 'PROMPT_ASSIST_NOT_CONFIGURED'
      || envelope.code === 'PROMPT_ASSIST_MODEL_UNAVAILABLE') throw new AssistFailure('unavailable')
    if (envelope.code === 'INVALID_REQUEST') throw new AssistFailure('invalid')
    if (envelope.code === 'PROMPT_ASSIST_REFERENCE_INVALID') throw new AssistFailure('referenceInvalid')
    if (envelope.code === 'PROMPT_ASSIST_REFERENCE_LIMIT') throw new AssistFailure('referenceLimit')
    if (envelope.code === 'PROMPT_ASSIST_STORAGE_FAILED') throw new AssistFailure('storage')
    if (envelope.code === 'PROMPT_ASSIST_RESULT_STORAGE_FAILED') throw new AssistFailure('resultStorage')
    if (envelope.code === 'PROMPT_ASSIST_RESULT_UNKNOWN') throw new AssistFailure('resultUnknown')
    if (envelope.code === 'PROMPT_ASSIST_INVALID_RESPONSE') throw new AssistFailure('invalidResponse')
    if (envelope.code === 'PROMPT_ASSIST_TIMEOUT' || envelope.code === 'PROMPT_ASSIST_UNAVAILABLE'
      || envelope.code === 'PROMPT_ASSIST_CANCELLED') throw new AssistFailure('error')
    throw new AssistFailure('resultUnknown')
  }
  const payload = envelope.payload
  if (!object(payload) || typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
    throw new AssistFailure('invalidResponse')
  }
  return payload.prompt.trim()
}
