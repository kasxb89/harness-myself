/** Same-origin Host transport. Account guards are never bearer credentials. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'
import { id, object, text } from './wire.ts'

/**
 * Captured account identity and epoch; owner guards contain no authentication credential.
 */
export interface DemandOwner { readonly id: string; readonly owner: string; readonly epoch: number }
/**
 * One cancellable same-origin JSON operation or bounded raw upload slice.
 */
export interface DemandRequest {
  readonly method: 'GET' | 'POST' | 'PUT'
  readonly path: string
  readonly body?: string
  readonly blob?: Blob
  readonly offset?: number
  readonly signal: AbortSignal
  readonly onProgress?: (bytes: number) => void
}
/**
 * An owner-verified reply or a classified failure retaining whether the mutation outcome is unknown.
 */
export type DemandResult = { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly code: string; readonly httpStatus: number; readonly unknown: boolean }

function decode(value: unknown, owner: DemandOwner, status: number): DemandResult {
  const row = object(value)
  if (row.account !== undefined && (object(row.account).id !== owner.id || row.accountOwner !== owner.owner)) {
    return { ok: false, code: 'ACCOUNT_CHANGED', httpStatus: 0, unknown: true }
  }
  if (row.ok === true) {
    if (status < 200 || status >= 300 || row.account === undefined || row.accountOwner !== owner.owner || !('payload' in row)) throw new Error('DEMAND_PROTOCOL_INVALID')
    return { ok: true, payload: row.payload }
  }
  if (row.ok !== false) throw new Error('DEMAND_PROTOCOL_INVALID')
  const code = text(row.code, 128)
  return { ok: false, code, httpStatus: typeof row.httpStatus === 'number' && Number.isSafeInteger(row.httpStatus) ? row.httpStatus : status,
    unknown: row.outcome === 'unknown' || status >= 500 || ['DEMAND_TIMEOUT', 'DEMAND_NETWORK', 'DEMAND_PROTOCOL_INVALID', 'ACCOUNT_CHANGED'].includes(code) }
}
function headers(owner: DemandOwner, binary: boolean, offset?: number): Record<string, string> {
  return { accept: 'application/json', 'x-yunshu-account-id': owner.id, 'x-yunshu-account-owner': owner.owner,
    'content-type': binary ? 'application/octet-stream' : 'application/json',
    ...offset === undefined ? {} : { 'upload-offset': String(offset) } }
}
const failure = (signal: AbortSignal): DemandResult => ({ ok: false, code: signal.aborted ? 'DEMAND_CANCELLED' : 'DEMAND_NETWORK', httpStatus: 0, unknown: true })

/**
 * Send exactly once through the Host; the journal owner decides whether to retry.
 * @param owner - Captured account guards to verify in the reply.
 * @param request - Route, immutable body or raw slice, cancellation and progress callback.
 * @returns An owner-verified payload or a safe failure classification.
 */
export async function requestDemand(owner: DemandOwner, request: DemandRequest): Promise<DemandResult> {
  const [path, query, ...extra] = request.path.split('?')
  if (path !== '' && !/^\/[A-Za-z0-9_/-]*$/u.test(path ?? '') || extra.length > 0
    || query !== undefined && !/^[A-Za-z0-9_=&%+.*-]*$/u.test(query)) return { ok: false, code: 'DEMAND_INVALID_INPUT', httpStatus: 400, unknown: false }
  if (request.signal.aborted) return failure(request.signal)
  const url = appPath('/credits/api/demands' + request.path)
  if (request.blob !== undefined && typeof XMLHttpRequest !== 'undefined') {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      let settled = false
      const finish = (answer: DemandResult): void => {
        if (settled) return
        settled = true; request.signal.removeEventListener('abort', abort); resolve(answer)
      }
      const abort = (): void => { xhr.abort(); finish(failure(request.signal)) }
      xhr.open(request.method, url)
      for (const [name, value] of Object.entries(headers(owner, true, request.offset))) xhr.setRequestHeader(name, value)
      xhr.upload.onprogress = (event) => { request.onProgress?.(event.loaded) }
      xhr.onload = () => {
        try {
          if (xhr.responseText.length > 2_097_152) throw new Error('DEMAND_PROTOCOL_INVALID')
          finish(decode(JSON.parse(xhr.responseText) as unknown, owner, xhr.status))
        } catch (_invalid: unknown) { finish({ ok: false, code: 'DEMAND_PROTOCOL_INVALID', httpStatus: xhr.status, unknown: true }) }
      }
      xhr.onerror = () => { finish(failure(request.signal)) }
      xhr.onabort = () => { finish(failure(request.signal)) }
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) { abort(); return }
      xhr.send(request.blob)
    })
  }
  try {
    const response = await fetch(url, { method: request.method, headers: headers(owner, request.blob !== undefined, request.offset),
      signal: request.signal, cache: 'no-store', credentials: 'same-origin',
      ...request.blob === undefined && request.body === undefined ? {} : { body: request.blob ?? request.body } })
    const raw = await response.text()
    if (raw.length > 2_097_152) throw new Error('DEMAND_PROTOCOL_INVALID')
    return decode(JSON.parse(raw) as unknown, owner, response.status)
  } catch (_transport: unknown) { return failure(request.signal) }
}

/**
 * Build a local media URL that the Host re-authorizes for each content request.
 * @param owner - Current account guards, without bearer credentials.
 * @param attachmentId - Authorized attachment identifier.
 * @param disposition - Inline preview or attachment download.
 * @returns A same-origin Host content path.
 */
export function demandContentUrl(owner: Pick<DemandOwner, 'id' | 'owner'>, attachmentId: string, disposition: 'inline' | 'attachment' = 'inline'): string {
  return appPath(`/credits/api/demands/attachments/${encodeURIComponent(id(attachmentId))}/content?${new URLSearchParams({
    account_id: owner.id, account_owner: owner.owner, disposition,
  })}`)
}
