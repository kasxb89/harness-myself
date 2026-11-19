/** One-attempt same-origin community transport; account guards are not bearer credentials. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'
import { communityId, communityInteger, communityJson, communityObject, communityText } from './community-wire.ts'

/** Captured product account and login epoch. */
export interface CommunityOwner { readonly id: string; readonly owner: string; readonly epoch: number }
/** One cancellable JSON mutation/read or bounded upload slice. */
export interface CommunityRequest {
  readonly method: 'GET' | 'POST' | 'PUT'
  readonly path: string
  readonly body?: string
  readonly blob?: Blob
  readonly offset?: number
  readonly signal: AbortSignal
  readonly onProgress?: (bytes: number) => void
}
/** Verified payload or a failure preserving mutation uncertainty. */
export type CommunityResult = { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly code: string; readonly httpStatus: number; readonly unknown: boolean }
const maxResponseBytes = 8_388_608
class CommunityResponseError extends Error {}
async function boundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder('utf-8', { fatal: true }), parts: string[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxResponseBytes) { await reader.cancel().catch(() => {}); throw new CommunityResponseError() }
      try { parts.push(decoder.decode(chunk.value, { stream: true })) }
      catch (_encoding: unknown) { await reader.cancel().catch(() => {}); throw new CommunityResponseError() }
    }
    try { parts.push(decoder.decode()) } catch (_encoding: unknown) { throw new CommunityResponseError() }
    return parts.join('')
  } finally { reader.releaseLock() }
}
const failed = (code: string, status = 0, unknown = true): CommunityResult => ({ ok: false, code, httpStatus: status, unknown })
const cancelled = (signal: AbortSignal): CommunityResult => failed(signal.aborted ? 'COMMUNITY_CANCELLED' : 'COMMUNITY_NETWORK')
function decode(value: unknown, owner: CommunityOwner, status: number, mutation: boolean): CommunityResult {
  const row = communityObject(value)
  if (row.account !== undefined && (communityObject(row.account).id !== owner.id || row.accountOwner !== owner.owner)) {
    return failed('COMMUNITY_ACCOUNT_CHANGED')
  }
  if (row.ok === true) {
    if (status < 200 || status >= 300 || row.account === undefined || row.accountOwner !== owner.owner || !('payload' in row)) {
      return failed('COMMUNITY_PROTOCOL_INVALID', status, mutation)
    }
    return { ok: true, payload: row.payload }
  }
  if (row.ok !== false) return failed('COMMUNITY_PROTOCOL_INVALID', status, mutation)
  const code = communityText(row.code, 128)
  const httpStatus = row.httpStatus === undefined ? status : communityInteger(row.httpStatus, 599)
  return failed(code, httpStatus, mutation && (row.outcome === 'unknown' || status >= 500
    || ['COMMUNITY_NETWORK', 'COMMUNITY_TIMEOUT', 'COMMUNITY_PROTOCOL_INVALID', 'COMMUNITY_ACCOUNT_CHANGED'].includes(code)))
}
function headers(owner: CommunityOwner, request: CommunityRequest): Record<string, string> {
  return { accept: 'application/json', 'x-yunshu-account-id': owner.id, 'x-yunshu-account-owner': owner.owner,
    'content-type': request.blob === undefined ? 'application/json' : 'application/octet-stream',
    ...request.offset === undefined ? {} : { 'upload-offset': String(communityInteger(request.offset)) } }
}
/**
 * Submit one request to the fixed local community namespace without automatic retries.
 * @param owner - Captured product account guards.
 * @param request - Immutable request body or bounded binary slice.
 * @returns Account-verified payload or classified failure.
 */
export async function requestCommunity(owner: CommunityOwner, request: CommunityRequest): Promise<CommunityResult> {
  const [path, query, ...extra] = request.path.split('?'), mutation = request.method !== 'GET'
  if (!/^\/[A-Za-z0-9_/-]*$/u.test(path ?? '') || extra.length > 0
    || query !== undefined && !/^[A-Za-z0-9_=&%+.*-]*$/u.test(query)) return failed('COMMUNITY_INVALID_INPUT', 400, false)
  if (request.signal.aborted) return cancelled(request.signal)
  const url = appPath('/credits/api/community-demands' + request.path)
  if (request.blob !== undefined && typeof XMLHttpRequest !== 'undefined') {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      let settled = false
      const finish = (answer: CommunityResult): void => {
        if (settled) return
        settled = true; request.signal.removeEventListener('abort', abort); resolve(answer)
      }
      const abort = (): void => { xhr.abort(); finish(cancelled(request.signal)) }
      xhr.open(request.method, url)
      for (const [name, value] of Object.entries(headers(owner, request))) xhr.setRequestHeader(name, value)
      xhr.upload.onprogress = (event) => { request.onProgress?.(event.loaded) }
      xhr.onprogress = () => {
        if (new TextEncoder().encode(xhr.responseText).byteLength > maxResponseBytes) {
          finish(failed('COMMUNITY_PROTOCOL_INVALID', xhr.status, mutation)); xhr.abort()
        }
      }
      xhr.onload = () => {
        try {
          if (new TextEncoder().encode(xhr.responseText).byteLength > maxResponseBytes) throw new Error('COMMUNITY_PROTOCOL_INVALID')
          finish(decode(communityJson(xhr.responseText), owner, xhr.status, mutation))
        } catch (_invalid: unknown) { finish(failed('COMMUNITY_PROTOCOL_INVALID', xhr.status, mutation)) }
      }
      xhr.onerror = () => { finish(cancelled(request.signal)) }
      xhr.onabort = () => { finish(cancelled(request.signal)) }
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) { abort(); return }
      xhr.send(request.blob)
    })
  }
  let response: Response
  try {
    response = await fetch(url, { method: request.method, headers: headers(owner, request), signal: request.signal,
      cache: 'no-store', credentials: 'same-origin', redirect: 'error',
      ...request.blob === undefined && request.body === undefined ? {} : { body: request.blob ?? request.body } })
  } catch (_network: unknown) { return cancelled(request.signal) }
  let raw: string
  try { raw = await boundedResponse(response) }
  catch (failure: unknown) {
    return failure instanceof CommunityResponseError ? failed('COMMUNITY_PROTOCOL_INVALID', response.status, mutation)
      : cancelled(request.signal)
  }
  try { return decode(communityJson(raw), owner, response.status, mutation) }
  catch (_protocol: unknown) { return failed('COMMUNITY_PROTOCOL_INVALID', response.status, mutation) }
}
/**
 * Build an account-guarded local content URL; the Host rechecks current ACL for each read.
 * @param owner - Current account guards without credentials.
 * @param attachmentId - Community attachment identifier.
 * @param disposition - Preview or original-name download.
 * @returns Same-origin content URL.
 */
export function communityContentUrl(owner: Pick<CommunityOwner, 'id' | 'owner'>, attachmentId: string,
  disposition: 'inline' | 'attachment' = 'inline'): string {
  return appPath(`/credits/api/community-demands/attachments/${encodeURIComponent(communityId(attachmentId))}/content?${new URLSearchParams({
    account_id: owner.id, account_owner: owner.owner, disposition,
  })}`)
}
