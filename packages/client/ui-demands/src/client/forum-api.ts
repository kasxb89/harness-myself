/** One-attempt account-verified forum transport through the fixed same-origin Host proxy. */
import { appPath } from '@deepseek-ai/dsh-client-ui-primitives'
import { forumInteger, forumJson, forumObject, forumText } from './forum-wire.ts'

/** Captured existing login identity and its account-switch epoch. */
export interface ForumOwner { readonly id: string; readonly owner: string; readonly epoch: number }
/** Immutable JSON request, cancellable by the owning account lifecycle. */
export interface ForumRequest {
  readonly method: 'GET' | 'POST' | 'PUT'
  readonly path: string
  readonly body?: string
  readonly signal: AbortSignal
}
/** Verified payload or classified failure retaining unknown mutation outcomes. */
export type ForumResult = { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly code: string; readonly httpStatus: number; readonly unknown: boolean }
const failed = (code: string, httpStatus = 0, unknown = true): ForumResult => ({ ok: false, code, httpStatus, unknown })
const maxBytes = 8_388_608
const aborted = (signal: AbortSignal): boolean => signal.aborted
class ForumResponseError extends Error {}
async function readResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder('utf-8', { fatal: true }), parts: string[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) { await reader.cancel().catch(() => {}); throw new ForumResponseError() }
      try { parts.push(decoder.decode(chunk.value, { stream: true })) }
      catch (_encoding: unknown) { await reader.cancel().catch(() => {}); throw new ForumResponseError() }
    }
    try { parts.push(decoder.decode()) } catch (_encoding: unknown) { throw new ForumResponseError() }
    return parts.join('')
  } finally { reader.releaseLock() }
}
function decode(raw: string, owner: ForumOwner, status: number, mutation: boolean): ForumResult {
  const row = forumObject(forumJson(raw))
  if (row.account !== undefined && (forumObject(row.account).id !== owner.id || row.accountOwner !== owner.owner)) {
    return failed('FORUM_ACCOUNT_CHANGED', status, mutation)
  }
  if (row.ok === true) {
    if (status < 200 || status >= 300 || row.account === undefined || row.accountOwner !== owner.owner || !('payload' in row)) {
      return failed('FORUM_PROTOCOL_INVALID', status, mutation)
    }
    return { ok: true, payload: row.payload }
  }
  if (row.ok !== false) return failed('FORUM_PROTOCOL_INVALID', status, mutation)
  const code = forumText(row.code, 128), httpStatus = row.httpStatus === undefined ? status : forumInteger(row.httpStatus)
  return failed(code, httpStatus, mutation && (row.outcome === 'unknown' || status >= 500
    || ['FORUM_NETWORK', 'FORUM_TIMEOUT', 'FORUM_PROTOCOL_INVALID', 'FORUM_ACCOUNT_CHANGED', 'ACCOUNT_CHANGED'].includes(code)))
}
/**
 * Send one forum request without retries or exposed production credentials.
 * @param owner - Captured account guards.
 * @param request - Original method, path and frozen body.
 * @returns Verified payload or an explicit failure classification.
 */
export async function requestForum(owner: ForumOwner, request: ForumRequest): Promise<ForumResult> {
  const mutation = request.method !== 'GET', [path, query, ...extra] = request.path.split('?')
  if (!/^\/[A-Za-z0-9_/-]*$/u.test(path ?? '') || extra.length > 0
    || query !== undefined && !/^[A-Za-z0-9_=&%+.*-]*$/u.test(query)) return failed('FORUM_INVALID_INPUT', 400, false)
  if (request.signal.aborted) return failed('FORUM_CANCELLED', 0, false)
  let response: Response
  try {
    response = await fetch(appPath('/credits/api/forum' + request.path), {
      method: request.method, signal: request.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/json',
        'x-yunshu-account-id': owner.id, 'x-yunshu-account-owner': owner.owner },
      ...request.body === undefined ? {} : { body: request.body },
    })
  } catch (_network: unknown) { return failed(aborted(request.signal) ? 'FORUM_CANCELLED' : 'FORUM_NETWORK', 0, mutation) }
  let raw: string
  try { raw = await readResponse(response) }
  catch (failure: unknown) {
    return failed(failure instanceof ForumResponseError ? 'FORUM_PROTOCOL_INVALID'
      : aborted(request.signal) ? 'FORUM_CANCELLED' : 'FORUM_NETWORK', response.status, mutation)
  }
  try { return decode(raw, owner, response.status, mutation) }
  catch (_protocol: unknown) { return failed('FORUM_PROTOCOL_INVALID', response.status, mutation) }
}
