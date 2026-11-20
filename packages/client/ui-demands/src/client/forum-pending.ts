/** Separate durable forum operations; uncertain submissions retain the original key, target and body. */
import type { ForumOwner } from './forum-api.ts'
import { forumBoolean, forumId, forumInteger, forumJson, forumObject, forumText, forumUuid, ForumWireError } from './forum-wire.ts'

/** Frozen operation stored before its first network attempt. */
export interface ForumOperation {
  readonly version: 1
  readonly operationId: string
  readonly scopeKey: string
  readonly postId: string | null
  readonly kind: 'post' | 'comment' | 'like'
  readonly method: 'POST' | 'PUT'
  readonly path: string
  readonly body: string
  readonly createdAt: number
}
/** Browser storage adapter, independently replaceable in tests. */
export interface ForumStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
/** Synchronous account-isolated pre-send journal. */
export interface ForumJournal {
  read(owner: Pick<ForumOwner, 'id' | 'owner'>): readonly ForumOperation[]
  put(owner: Pick<ForumOwner, 'id' | 'owner'>, operation: ForumOperation): void
  remove(owner: Pick<ForumOwner, 'id' | 'owner'>, operationId: string): void
}
/** Decode a frozen original forum operation.
 * @param value - Persisted record.
 * @returns Validated operation.
 */
export function parseForumOperation(value: unknown): ForumOperation {
  const row = forumObject(value), operationId = forumUuid(row.operationId), scopeKey = forumText(row.scopeKey, 200)
  const postId = row.postId === null ? null : forumId(row.postId), path = forumText(row.path, 200)
  const body = forumText(row.body, 100_000), payload = forumObject(forumJson(body))
  if (row.version !== 1 || !['post', 'comment', 'like'].includes(String(row.kind))) throw new ForumWireError()
  const kind = row.kind as ForumOperation['kind'], method = kind === 'like' ? 'PUT' : 'POST'
  const images = payload.attachment_ids === undefined ? [] : payload.attachment_ids
  if (!Array.isArray(images) || images.length > 100 || new Set(images).size !== images.length) throw new ForumWireError()
  for (const id of images) forumUuid(id)
  if (row.method !== method) throw new ForumWireError()
  if (kind === 'post') {
    if (postId !== null || path !== '/posts' || payload.client_request_id !== operationId
      || Object.keys(payload).some(key => !['body', 'client_request_id', 'title', 'attachment_ids'].includes(key))) throw new ForumWireError()
    forumText(payload.title, 200); forumText(payload.body, 20_000, images.length > 0)
  } else {
    if (postId === null || scopeKey !== `post:${postId}` || path !== `/posts/${postId}/${kind === 'like' ? 'like' : 'comments'}`) {
      throw new ForumWireError()
    }
    if (kind === 'comment') {
      if (payload.client_request_id !== operationId
        || Object.keys(payload).some(key => !['body', 'client_request_id', 'attachment_ids', 'reply_to_comment_id', 'title'].includes(key))
        || payload.title !== undefined && payload.title !== '') throw new ForumWireError()
      forumText(payload.body, 4000, images.length > 0)
      if (payload.reply_to_comment_id !== undefined && payload.reply_to_comment_id !== '') forumUuid(payload.reply_to_comment_id)
    } else {
      if (Object.keys(payload).join(',') !== 'liked') throw new ForumWireError()
      forumBoolean(payload.liked)
    }
  }
  return { version: 1, operationId, scopeKey, postId, kind, method, path, body, createdAt: forumInteger(row.createdAt) }
}
/**
 * Create the independent forum journal, refusing changed bodies and corrupt records.
 * @param storage - Browser-compatible persistence adapter.
 * @returns Owner-bound pre-send journal.
 */
export function createForumJournal(storage?: ForumStorage): ForumJournal {
  const backing = (): ForumStorage => storage ?? globalThis.localStorage
  const key = (owner: Pick<ForumOwner, 'id' | 'owner'>): string => `yunshu.forum.pending.v1:${JSON.stringify([owner.id, owner.owner])}`
  const read = (owner: Pick<ForumOwner, 'id' | 'owner'>): readonly ForumOperation[] => {
    const raw = backing().getItem(key(owner))
    if (raw === null) return []
    if (raw.length > 8_388_608) throw new Error('FORUM_PENDING_INVALID')
    const row = forumObject(forumJson(raw))
    if (row.version !== 1 || row.accountId !== owner.id || row.accountOwner !== owner.owner
      || !Array.isArray(row.operations) || row.operations.length > 256) throw new Error('FORUM_PENDING_INVALID')
    const operations = row.operations.map(parseForumOperation)
    if (new Set(operations.map(item => item.operationId)).size !== operations.length) throw new Error('FORUM_PENDING_INVALID')
    return operations
  }
  const write = (owner: Pick<ForumOwner, 'id' | 'owner'>, operations: readonly ForumOperation[]): void => {
    if (operations.length === 0) { backing().removeItem(key(owner)); return }
    const raw = JSON.stringify({ version: 1, accountId: owner.id, accountOwner: owner.owner, operations })
    if (raw.length > 8_388_608) throw new Error('FORUM_PENDING_FULL')
    backing().setItem(key(owner), raw)
  }
  return { read,
    put(owner, operation) {
      const next = parseForumOperation(operation), previous = read(owner)
      const original = previous.find(item => item.operationId === next.operationId)
      if (original !== undefined && JSON.stringify(original) !== JSON.stringify(next)) throw new Error('FORUM_PENDING_BODY_CHANGED')
      if (original === undefined && previous.length >= 256) throw new Error('FORUM_PENDING_FULL')
      write(owner, [...previous.filter(item => item.operationId !== next.operationId), next])
    },
    remove(owner, id) { write(owner, read(owner).filter(item => item.operationId !== id)) },
  }
}
