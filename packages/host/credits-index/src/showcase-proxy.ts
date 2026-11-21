/** Read-only public cases use a fixed backend and never capture product credentials. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DemandProxyOptions } from './demand-proxy.ts'
import { SHOWCASE_LOCAL_BASE_PATH, SHOWCASE_UPSTREAM_BASE_PATH, ShowcaseProtocolError,
  showcaseId, showcaseQuery, showcaseResponse } from './showcase-protocol.ts'

export { SHOWCASE_LOCAL_BASE_PATH, SHOWCASE_UPSTREAM_BASE_PATH } from './showcase-protocol.ts'
/** Existing Connection authority, fixed backend and credential-free transport supplied by Host composition. */
export type ShowcaseProxyOptions = Pick<DemandProxyOptions, 'baseUrl' | 'requestRejection' | 'fetchPublic' | 'limits'>
type Route = { kind: 'config' | 'list' | 'detail' | 'content'; suffix: string }
function route(path: string, method: string): Route | undefined {
  if (method !== 'GET' && method !== 'HEAD') return undefined
  if (method === 'GET' && path === '') return { kind: 'list', suffix: '' }
  if (method === 'GET' && path === '/config') return { kind: 'config', suffix: path }
  const detail = /^\/([a-f\d-]{36})$/iu.exec(path)
  if (method === 'GET' && detail !== null) {
    try { showcaseId(detail[1]); return { kind: 'detail', suffix: path } } catch { return undefined }
  }
  const asset = /^\/assets\/([a-f\d-]{36})\/([a-f\d-]{36})\/content$/iu.exec(path)
  if (asset !== null) {
    try { showcaseId(asset[1]); showcaseId(asset[2]); return { kind: 'content', suffix: path } } catch { return undefined }
  }
  return undefined
}
function json(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(payload))
}
function code(status: number): string {
  return status === 401 ? 'SHOWCASE_UNAUTHORIZED' : status === 403 ? 'SHOWCASE_FORBIDDEN'
    : status === 404 ? 'SHOWCASE_NOT_FOUND' : status === 429 ? 'SHOWCASE_RATE_LIMITED'
      : status >= 500 ? 'SHOWCASE_SERVICE_UNAVAILABLE' : 'SHOWCASE_INVALID_INPUT'
}
async function readJson(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new ShowcaseProtocolError()
  const parts: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const row = await reader.read()
      if (row.done) break
      size += row.value.byteLength
      if (size > maximum) throw new ShowcaseProtocolError()
      parts.push(row.value)
    }
  } catch (error: unknown) {
    await reader.cancel().catch((_cancelFailure: unknown) => { /* Preserve the original bounded-read failure. */ }); throw error
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
}
/**
 * Create the closed public showcase facade with bounded reads and quiescent disposal.
 * @param options - Existing local authority, configured API base and credential-free fetch.
 * @returns Public GET/HEAD handling only; no account reads, mutations or retries are performed.
 */
export function createShowcaseProxy(options: ShowcaseProxyOptions): {
  handle(request: IncomingMessage, response: ServerResponse, path: string, method: string): Promise<boolean>
  close(): Promise<void>
} {
  const life = new AbortController(), operations = new Set<Promise<void>>()
  const perform = async (
    request: IncomingMessage, response: ServerResponse, selected: Route, query: URLSearchParams, method: string,
  ): Promise<void> => {
    const rejection = options.requestRejection(request)
    if (rejection !== undefined) { json(response, rejection, { ok: false, code: 'SHOWCASE_FORBIDDEN', httpStatus: rejection }); return }
    const limits = options.limits(), timeout = selected.kind === 'content' ? limits.downloadTimeoutMs ?? 300_000 : limits.requestTimeoutMs ?? 20_000
    const abort = new AbortController(), signal = AbortSignal.any([life.signal, abort.signal, AbortSignal.timeout(timeout)])
    let inputAccepted = false
    const disconnected = (): void => { if (!response.writableEnded) abort.abort() }
    request.once('aborted', disconnected); response.once('close', disconnected)
    try {
      const checked = showcaseQuery(selected.kind, query), suffix = checked.size === 0 ? '' : '?' + checked.toString()
      const headers: Record<string, string> = { accept: selected.kind === 'content' ? 'image/*,video/*' : 'application/json' }
      const range = request.headers.range
      if (range !== undefined) {
        if (selected.kind !== 'content' || !/^bytes=(?:\d+-\d*|-\d+)$/u.test(range)) throw new ShowcaseProtocolError()
        headers.range = range
      }
      inputAccepted = true
      const upstream = await options.fetchPublic(SHOWCASE_UPSTREAM_BASE_PATH + selected.suffix + suffix,
        { method, headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' })
      if (selected.kind === 'content') {
        if (!upstream.ok && upstream.status !== 416) {
          await upstream.body?.cancel()
          json(response, upstream.status, { ok: false, code: code(upstream.status), httpStatus: upstream.status }); return
        }
        if (upstream.status === 416) {
          const unsatisfied = upstream.headers.get('content-range')
          await upstream.body?.cancel()
          response.writeHead(416, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
            ...unsatisfied !== null && /^bytes \*\/\d+$/u.test(unsatisfied) ? { 'content-range': unsatisfied } : {} })
          response.end(); return
        }
        const mime = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        const validType = mime !== undefined && /^(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|webm|quicktime))$/u.test(mime)
        if (!validType) {
          await upstream.body?.cancel(); throw new ShowcaseProtocolError()
        }
        const outgoing: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const value = upstream.headers.get(key); if (value !== null) outgoing[key] = value
        }
        response.writeHead(upstream.status, outgoing)
        if (method === 'HEAD' || upstream.body === null) { await upstream.body?.cancel(); response.end(); return }
        const reader = upstream.body.getReader()
        try {
          for (;;) {
            const row = await reader.read()
            if (row.done) break
            if (signal.aborted) throw new ShowcaseProtocolError()
            if (!response.write(row.value)) await new Promise<void>((resolve, reject) => {
              const drained = (): void => { cleanup(); resolve() }
              const closed = (): void => { cleanup(); reject(new Error('closed')) }
              const cleanup = (): void => {
                response.off('drain', drained); response.off('close', closed); signal.removeEventListener('abort', closed)
              }
              response.once('drain', drained); response.once('close', closed)
              signal.addEventListener('abort', closed, { once: true }); if (signal.aborted) closed()
            })
          }
          response.end()
        } finally { await reader.cancel().catch((_cancelFailure: unknown) => { /* Preserve the original content-stream outcome. */ }) }
        return
      }
      if (!upstream.ok) {
        await upstream.body?.cancel()
        json(response, upstream.status, { ok: false, code: code(upstream.status), httpStatus: upstream.status }); return
      }
      const value = await readJson(upstream, Math.min(16_777_216, limits.maxJsonResponseBytes ?? 8_388_608))
      if (value === null || typeof value !== 'object' || !('success' in value) || value.success !== true || !('data' in value)) throw new ShowcaseProtocolError()
      json(response, 200, { ok: true, payload: showcaseResponse(selected.kind, value.data, options.baseUrl), httpStatus: upstream.status })
    } catch (error: unknown) {
      if (response.headersSent) { response.destroy(); return }
      if (!inputAccepted && error instanceof ShowcaseProtocolError) {
        json(response, 400, { ok: false, code: 'SHOWCASE_INVALID_INPUT', httpStatus: 400 }); return
      }
      const failure = signal.aborted ? 'SHOWCASE_TIMEOUT' : error instanceof ShowcaseProtocolError || error instanceof SyntaxError
        ? 'SHOWCASE_PROTOCOL_INVALID' : 'SHOWCASE_NETWORK'
      json(response, 502, { ok: false, code: failure, httpStatus: 502 })
    } finally { request.off('aborted', disconnected); response.off('close', disconnected) }
  }
  return {
    async handle(request, response, path, method): Promise<boolean> {
      const local = path.startsWith('/credits/') ? path.slice('/credits'.length) : path
      const prefix = SHOWCASE_LOCAL_BASE_PATH.slice('/credits'.length)
      if (local !== prefix && !local.startsWith(prefix + '/')) return false
      const selected = route(local.slice(prefix.length), method)
      if (selected === undefined) return false
      if (life.signal.aborted) { json(response, 503, { ok: false, code: 'SHOWCASE_SERVICE_UNAVAILABLE', httpStatus: 503 }); return true }
      const query = new URL(request.url ?? '/', 'http://showcase.invalid').searchParams
      const task = perform(request, response, selected, query, method)
      operations.add(task)
      try { await task } finally { operations.delete(task) }
      return true
    },
    async close(): Promise<void> { life.abort(); await Promise.allSettled([...operations]) },
  }
}
