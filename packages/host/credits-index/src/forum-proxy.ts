/** Exact forum routes reuse the product credential owner's single-attempt transport. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DemandProxyOptions } from './demand-proxy.ts'
import { demandObject, demandText, demandId, demandInteger } from './demand-protocol.ts'

const local = '/credits/api/forum'
const remote = '/api/product/forum'
type Route = 'config' | 'posts' | 'post' | 'comments' | 'like'
function selection(path: string, method: string): Route | null {
  if (path === '/config' && method === 'GET') return 'config'
  if (path === '/posts' && ['GET', 'POST'].includes(method)) return 'posts'
  if (!/^\/posts\/[A-Za-z0-9_-]{1,40}(?:\/(?:comments|like))?$/u.test(path)) return null
  if (path.endsWith('/comments') && ['GET', 'POST'].includes(method)) return 'comments'
  if (path.endsWith('/like') && method === 'PUT') return 'like'
  return !path.endsWith('/comments') && !path.endsWith('/like') && method === 'GET' ? 'post' : null
}
function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('FORUM_PROTOCOL')
  return v
}
function publicContent(value: unknown, post: boolean): Record<string, unknown> {
  const row = demandObject(value),
    author = demandObject(row.author)
  const content: Record<string, unknown> = {
    id: demandId(row.id),
    body: demandText(row.body, post ? 80_000 : 16_000),
    author: { id: demandInteger(author.id), display_name: demandText(author.display_name, 800, true) },
    created_at: demandInteger(row.created_at),
  }
  if (post)
    Object.assign(content, {
      title: demandText(row.title, 800),
      liked: bool(row.liked),
      like_count: demandInteger(row.like_count),
      comment_count: demandInteger(row.comment_count),
    })
  else content.post_id = demandId(row.post_id)
  return content
}
function projection(value: unknown, kind: Route, method: string): Record<string, unknown> {
  const row = demandObject(value)
  if (kind === 'config') return { enabled: bool(row.enabled), revision: demandInteger(row.revision) }
  if ((kind === 'posts' || kind === 'comments') && method === 'GET') {
    if (!Array.isArray(row.items) || row.items.length > 100) throw new Error('FORUM_PROTOCOL')
    return {
      items: row.items.map(item => publicContent(item, kind === 'posts')),
      next_cursor: demandText(row.next_cursor, 256, true),
      has_more: bool(row.has_more),
    }
  }
  const key = kind === 'comments' ? 'comment' : 'post'
  return {
    [key]: publicContent(row[key], key === 'post'),
    ...(method === 'POST' ? { replayed: bool(row.replayed) } : {}),
  }
}
async function bounded(stream: AsyncIterable<Uint8Array>, maximum: number): Promise<unknown> {
  const parts: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > maximum) throw new Error('FORUM_SIZE')
    parts.push(chunk)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
}
function answer(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

/**
 * Forward only public forum operations; credentials and moderation routes never reach the browser.
 * @param options - Existing account capture, local authority and configured deadline.
 * @returns Exact route handler and quiescent cancellation on plugin disposal.
 */
export function createForumProxy(
  options: Pick<DemandProxyOptions, 'captureAccount' | 'requestRejection' | 'limits'>,
): {
  handle(request: IncomingMessage, response: ServerResponse, route: string, method: string): Promise<boolean>
  close(): Promise<void>
} {
  const life = new AbortController(),
    operations = new Set<Promise<void>>()
  const execute = async (
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    method: string,
    kind: Route,
  ): Promise<void> => {
    const rejected = options.requestRejection(request)
    if (rejected !== undefined) {
      answer(response, rejected, { ok: false, code: 'FORUM_AUTH_REQUIRED' })
      return
    }
    const disconnect = new AbortController(),
      timeout = AbortSignal.timeout(options.limits().requestTimeoutMs ?? 20_000)
    const signal = AbortSignal.any([life.signal, disconnect.signal, timeout])
    const closed = (): void => {
      if (!response.writableEnded) disconnect.abort()
    }
    response.once('close', closed)
    const abort = (): void => {
      if (!request.complete) request.destroy()
    }
    signal.addEventListener('abort', abort, { once: true })
    let sent = false
    try {
      const account = await options.captureAccount(signal)
      if (!account) {
        answer(response, 401, { ok: false, code: 'FORUM_AUTH_REQUIRED' })
        return
      }
      if (
        request.headers['x-yunshu-account-id'] !== account.id ||
        request.headers['x-yunshu-account-owner'] !== account.owner ||
        !(await account.isCurrent())
      ) {
        answer(response, 409, { ok: false, code: 'ACCOUNT_CHANGED' })
        return
      }
      const owner = { account: { id: account.id }, accountOwner: account.owner }
      const query = new URL(request.url ?? '/', 'http://forum.local').searchParams
      for (const [key, val] of query) {
        if (
          method !== 'GET' ||
          !['posts', 'comments'].includes(kind) ||
          !['cursor', 'limit'].includes(key) ||
          query.getAll(key).length !== 1 ||
          (key === 'cursor' && !/^[A-Za-z0-9_-]{0,256}$/u.test(val)) ||
          (key === 'limit' && (!/^\d{1,3}$/u.test(val) || +val < 1 || +val > 100))
        ) {
          answer(response, 400, { ok: false, code: 'FORUM_INVALID_INPUT', ...owner })
          return
        }
      }
      let body: string | undefined
      if (method !== 'GET') {
        const raw = demandObject(await bounded(request, 128 * 1024))
        body = JSON.stringify(
          kind === 'like'
            ? { liked: bool(raw.liked) }
            : {
              client_request_id: demandText(raw.client_request_id, 80),
              body: demandText(raw.body, kind === 'comments' ? 16_000 : 80_000),
              ...(kind === 'posts' ? { title: demandText(raw.title, 800) } : {}),
            },
        )
      }
      if (!(await account.isCurrent())) {
        answer(response, 409, { ok: false, code: 'ACCOUNT_CHANGED' })
        return
      }
      sent = true
      const result = await account.fetch(remote + path + (query.size ? '?' + query.toString() : ''), {
        method,
        signal,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      })
      if (result.status >= 300 && result.status < 400) {
        await result.body?.cancel()
        throw new Error('FORUM_PROTOCOL')
      }
      if (result.headers.get('content-type')?.split(';')[0] !== 'application/json' || result.body === null) {
        await result.body?.cancel()
        throw new Error('FORUM_PROTOCOL')
      }
      const reader = result.body.getReader()
      const cancel = (): void => {
        void reader.cancel().catch((_cancelled: unknown) => {
          /* Disposal owns this reader. */
        })
      }
      signal.addEventListener('abort', cancel, { once: true })
      let value: unknown
      try {
        value = await bounded(
          {
            async *[Symbol.asyncIterator]() {
              for (;;) {
                signal.throwIfAborted()
                const r = await reader.read()
                if (r.done) return
                yield r.value
              }
            },
          },
          4 * 1024 * 1024,
        )
      } finally {
        signal.removeEventListener('abort', cancel)
        await reader.cancel()
        reader.releaseLock()
      }
      signal.throwIfAborted()
      if (!(await account.isCurrent())) {
        answer(response, 409, { ok: false, code: 'ACCOUNT_CHANGED' })
        return
      }
      const envelope = demandObject(value)
      if (!result.ok || envelope.success !== true) {
        const codes = [
          'FORUM_CLOSED',
          'FORUM_NOT_FOUND',
          'FORUM_REQUEST_CONFLICT',
          'FORUM_INVALID_INPUT',
          'FORUM_AUTH_REQUIRED',
          'FORUM_FORBIDDEN',
        ]
        const code =
          typeof envelope.code === 'string' && codes.includes(envelope.code)
            ? envelope.code
            : result.status === 429
              ? 'FORUM_RATE_LIMITED'
              : result.status === 401
                ? 'FORUM_AUTH_REQUIRED'
                : 'FORUM_UNAVAILABLE'
        answer(response, result.ok ? 502 : result.status, {
          ok: false,
          code,
          httpStatus: result.status,
          outcome: method !== 'GET' && result.status >= 500 ? 'unknown' : 'rejected',
          ...owner,
        })
        return
      }
      answer(response, result.status, {
        ok: true,
        payload: projection(envelope.data, kind, method),
        ...owner,
      })
    } catch (_failure: unknown) {
      answer(response, 502, {
        ok: false,
        code: 'FORUM_UNAVAILABLE',
        outcome: sent && method !== 'GET' ? 'unknown' : 'rejected',
      })
    } finally {
      response.removeListener('close', closed)
      signal.removeEventListener('abort', abort)
    }
  }
  return {
    async handle(request, response, route, method) {
      if (route !== local && !route.startsWith(local + '/')) return false
      const path = route.slice(local.length),
        kind = selection(path, method)
      if (life.signal.aborted || kind === null) {
        answer(response, kind === null ? 404 : 503, { ok: false, code: 'FORUM_NOT_FOUND' })
        return true
      }
      const pending = execute(request, response, path, method, kind)
      operations.add(pending)
      try {
        await pending
      } finally {
        operations.delete(pending)
      }
      return true
    },
    async close() {
      life.abort()
      await Promise.allSettled(operations)
    },
  }
}
