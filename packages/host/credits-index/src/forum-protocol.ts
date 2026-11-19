/** Strict public forum projections, separate from private demands and community orders. */
import { DemandProtocolError, demandInteger, demandObject, demandText, type DemandObject } from './demand-protocol.ts'

/** Domain error codes may be shown without forwarding upstream diagnostic messages. */
export const FORUM_ERRORS: ReadonlySet<string> = new Set([
  'FORUM_AUTH_REQUIRED', 'FORUM_FORBIDDEN', 'FORUM_INVALID_INPUT', 'FORUM_CURSOR_INVALID', 'FORUM_CLOSED',
  'FORUM_NOT_FOUND', 'FORUM_REQUEST_CONFLICT', 'FORUM_REVISION_CONFLICT', 'FORUM_UNAVAILABLE',
])
/** A forum post/comment identity can only select a UUID within the fixed forum route family. */
export type ForumId = string & { readonly __forumId: 'ForumId' }

/**
 * Validate an opaque forum resource before interpolation in a fixed path.
 * @param value - Untrusted post or comment identifier.
 * @returns The original UUID, without normalizing or inventing another resource.
 */
export function forumId(value: unknown): ForumId {
  const result = demandText(value, 36)
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(result)) throw new DemandProtocolError()
  return result as ForumId
}
function text(value: unknown, maximum: number, empty = false): string {
  const result = demandText(value, maximum * 2, empty)
  if (Array.from(result).length > maximum) throw new DemandProtocolError()
  return result
}
function content(value: unknown, maximum: number): string {
  const result = text(value, maximum)
  if (result.trim() === '') throw new DemandProtocolError()
  return result
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DemandProtocolError()
  return value
}
function positive(value: unknown): number {
  const result = demandInteger(value)
  if (result === 0) throw new DemandProtocolError()
  return result
}
function array<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 100) throw new DemandProtocolError()
  return value.map(parse)
}
function author(input: unknown): DemandObject {
  const value = demandObject(input)
  return { id: positive(value.id), display_name: text(value.display_name, 200, true) }
}
function post(input: unknown): DemandObject {
  const value = demandObject(input)
  return { id: forumId(value.id), title: content(value.title, 200), body: content(value.body, 20_000),
    author: author(value.author), created_at: demandInteger(value.created_at), like_count: demandInteger(value.like_count),
    comment_count: demandInteger(value.comment_count), liked: bool(value.liked) }
}
function comment(input: unknown): DemandObject {
  const value = demandObject(input)
  return { id: forumId(value.id), post_id: forumId(value.post_id), body: content(value.body, 4000),
    author: author(value.author), created_at: demandInteger(value.created_at) }
}
function page(value: DemandObject): DemandObject {
  return { next_cursor: text(value.next_cursor, 256, true), has_more: bool(value.has_more) }
}

/**
 * Retain only the exact ordinary-user mutation fields, preserving original idempotency content.
 * @param kind - A closed forum operation selected by the Host route table.
 * @param input - Untrusted renderer JSON.
 * @returns The unchanged key/content or desired like state, without media or admin fields.
 */
export function forumRequest(kind: string, input: unknown): DemandObject {
  const value = demandObject(input)
  if (kind === 'create-post') return { client_request_id: text(value.client_request_id, 80),
    title: content(value.title, 200), body: content(value.body, 20_000) }
  if (kind === 'create-comment') return { client_request_id: text(value.client_request_id, 80), body: content(value.body, 4000) }
  if (kind === 'like') return { liked: bool(value.liked) }
  throw new DemandProtocolError()
}

/**
 * Accept only source-supported ordinary pagination; admin search/review filters are never forwarded.
 * @param kind - Closed forum read operation.
 * @param source - Untrusted query parameters.
 * @returns Bounded pagination without an account, authority or privileged selector.
 */
export function forumQuery(kind: string, source: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams()
  for (const [key, value] of source) {
    if (!['posts', 'comments'].includes(kind) || !['cursor', 'limit'].includes(key) || result.has(key)) throw new DemandProtocolError()
    if (key === 'cursor') text(value, 256, true)
    else {
      if (!/^\d{1,16}$/u.test(value) || demandInteger(Number(value), 100) === 0) throw new DemandProtocolError()
    }
    result.set(key, value)
  }
  return result
}

/**
 * Decode one exact source wrapper and project public text fields under the captured account.
 * @param kind - Closed forum operation.
 * @param input - Untrusted upstream envelope.
 * @param account - Captured current account, used to verify creation authors.
 * @param route - Fixed route identity for detail and parent-bound comments.
 * @returns A public DTO without moderation/private fields, diagnostics or signed URLs.
 */
export function forumResponse(kind: string, input: unknown, account: { readonly id: string },
  route: { readonly resourceId?: string } = {}): DemandObject {
  const envelope = demandObject(input)
  if (envelope.success !== true) throw new DemandProtocolError()
  const value = demandObject(envelope.data)
  const boundPost = (input: unknown): DemandObject => {
    const result = post(input)
    if (route.resourceId !== undefined && result.id !== route.resourceId) throw new DemandProtocolError()
    return result
  }
  const boundComment = (input: unknown): DemandObject => {
    const result = comment(input)
    if (route.resourceId !== undefined && result.post_id !== route.resourceId) throw new DemandProtocolError()
    return result
  }
  if (kind === 'config') {
    const capabilities = demandObject(value.capabilities)
    return { revision: demandInteger(value.revision), enabled: bool(value.enabled), capabilities: {
      immediate_publish: bool(capabilities.immediate_publish), likes: bool(capabilities.likes), comments: bool(capabilities.comments),
    } }
  }
  if (kind === 'posts' || kind === 'comments') {
    const values = array(value.items, kind === 'posts' ? post : boundComment)
    if (new Set(values.map(item => item.id)).size !== values.length) throw new DemandProtocolError()
    return { items: values, ...page(value) }
  }
  if (kind === 'post' || kind === 'like') return { post: boundPost(value.post) }
  if (kind === 'create-post' || kind === 'create-comment') {
    const field = kind === 'create-post' ? 'post' : 'comment'
    const result = kind === 'create-post' ? post(value.post) : boundComment(value.comment)
    if (String(demandObject(result.author).id) !== account.id) throw new DemandProtocolError()
    return { [field]: result, replayed: bool(value.replayed) }
  }
  throw new DemandProtocolError()
}
