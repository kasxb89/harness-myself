/** Owner-bound product demand proxy. This module never receives an account credential or AI Session. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apiUrl, normalizeApiBaseUrl } from './api-url.ts'
import { accountRetryAfter } from './account-read.ts'
import { DemandProtocolError, demandId, demandInteger, demandObject, demandQuery, demandRequest, demandResponse, demandText } from './demand-protocol.ts'

/** Only the frozen product route family may be supplied by the composition. */
export const DEMAND_UPSTREAM_BASE_PATH = '/api/product/demands'
const LOCAL_BASE_PATH = '/credits/api/demands'

/** Non-secret captured account identity and closures owned by the existing product credential controller. */
export interface DemandAccount {
  /** Stable product account identifier, used to reject stale browser requests. */
  readonly id: string
  /** Opaque login scope; this value never authorizes a request by itself. */
  readonly owner: string
  /**
   * Check the captured Host identity version, backend and login reference.
   * @returns Whether the same product login still owns this operation.
   */
  isCurrent(): Promise<boolean>
  /**
   * Send once after checking this owner; the credential controller adds Bearer privately.
   * @param route - Validated product route, retaining the configured deployment prefix through the controller.
   * @param init - Request method, safe headers, bounded body and cancellation lifetime; streams are never replayed.
   * @returns The original upstream response, without performing an automatic retry.
   */
  fetch(route: string, init: RequestInit & { readonly duplex?: 'half' }): Promise<Response>
}
/** Validated local transport ceilings; backend upload rules continue to determine actual accepted chunk sizes. */
export interface DemandProxyLimits {
  /** Complete JSON request deadline in milliseconds. */
  readonly requestTimeoutMs: number
  /** Complete single-chunk upload deadline in milliseconds. */
  readonly uploadTimeoutMs: number
  /** Complete attachment download deadline in milliseconds. */
  readonly downloadTimeoutMs: number
  /** Maximum buffered JSON request bytes; media never uses this buffer. */
  readonly maxJsonRequestBytes: number
  /** Maximum buffered upstream JSON response bytes. */
  readonly maxJsonResponseBytes: number
  /** Absolute local chunk byte ceiling, independent of the backend's smaller configured chunk size. */
  readonly maxChunkBytes: number
}
/** Narrow composition callbacks that reuse existing Host authentication and account renewal ownership. */
export interface DemandProxyOptions {
  /** Validated backend origin and deployment prefix. */
  readonly baseUrl: string
  /** Explicit canonical demand route-family mapping; omitted uses the frozen product contract. */
  readonly upstreamBasePath?: string
  /** Existing local Connection authority check; undefined accepts and a status code rejects. */
  readonly requestRejection: (request: IncomingMessage) => number | undefined
  /** Capture the existing renewed product login without exposing its credentials. */
  readonly captureAccount: (signal: AbortSignal) => Promise<DemandAccount | null>
  /** Credential-free, redirect-refusing request for an exact validated single-object signed content path. */
  readonly fetchPublic: (route: string, init: RequestInit) => Promise<Response>
  /** Read current validated transport configuration before each operation. */
  readonly limits: () => Partial<DemandProxyLimits>
}
const defaults: DemandProxyLimits = { requestTimeoutMs: 20_000, uploadTimeoutMs: 120_000, downloadTimeoutMs: 300_000,
  maxJsonRequestBytes: 65_536, maxJsonResponseBytes: 2_097_152, maxChunkBytes: 67_108_864 }

function limitsOf(value: Partial<DemandProxyLimits>): DemandProxyLimits {
  const next = { ...defaults, ...value }
  for (const [key, number] of Object.entries(next)) {
    const maximum = key.endsWith('Ms') ? 3_600_000 : key === 'maxJsonRequestBytes' ? 1_048_576
      : key === 'maxJsonResponseBytes' ? 16_777_216 : 67_108_864
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`Invalid demand proxy configuration: ${key}`)
  }
  return next
}
type Route = {
  readonly kind: string
  readonly suffix: string
  readonly method: string
  readonly uploadId?: string
  readonly attachmentId?: string
}
function selectRoute(path: string, method: string): Route | undefined {
  const exact: Record<string, Readonly<Record<string, string>>> = {
    '': { GET: 'list', POST: 'create' }, '/config': { GET: 'config' }, '/engineers': { GET: 'engineers' },
    '/unread': { GET: 'unread' }, '/uploads': { POST: 'upload-init' },
  }
  const direct = exact[path]?.[method]
  if (direct !== undefined) return { kind: direct, suffix: path, method }
  const upload = /^\/uploads\/([A-Za-z0-9_-]{1,128})(\/(chunks|complete))?$/u.exec(path)
  if (upload !== null) {
    const kind = upload[3] === 'chunks' && method === 'PUT' ? 'upload-chunk'
      : upload[3] === 'complete' && method === 'POST' ? 'upload-complete' : upload[3] === undefined && method === 'GET' ? 'upload-status' : undefined
    return kind === undefined ? undefined : { kind, suffix: path, method, uploadId: upload[1] ?? '' }
  }
  const asset = /^\/attachments\/([A-Za-z0-9_-]{1,128})\/(link|content)$/u.exec(path)
  if (asset !== null && (asset[2] === 'link' && method === 'POST' || asset[2] === 'content' && (method === 'GET' || method === 'HEAD'))) {
    return { kind: asset[2] === 'link' ? 'link' : 'content', suffix: path, method, attachmentId: asset[1] ?? '' }
  }
  const item = /^\/[A-Za-z0-9_-]{1,128}(\/(messages|read|actions))?$/u.exec(path)
  if (item === null) return undefined
  const kind = item[2] === 'messages' ? method === 'GET' ? 'messages' : method === 'POST' ? 'message' : undefined
    : item[2] === 'read' && method === 'POST' ? 'read' : item[2] === 'actions' && method === 'POST' ? 'action'
      : item[2] === undefined && method === 'GET' && !['/config', '/engineers', '/unread', '/uploads'].includes(path) ? 'detail' : undefined
  return kind === undefined ? undefined : { kind, suffix: path, method }
}
class DemandInputError extends Error {
  constructor(readonly code: string) { super(code) }
}
class DemandTransportError extends Error {
  constructor() { super('Demand transport unavailable') }
}
async function transfer(send: () => Promise<Response>): Promise<Response> {
  try { return await send() } catch (_transportFailed: unknown) { throw new DemandTransportError() }
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  if (Array.isArray(value)) throw new DemandInputError('DEMAND_INVALID_INPUT')
  return value
}
function expectedOwner(request: IncomingMessage, account: DemandAccount, query?: URLSearchParams): boolean {
  const id = query === undefined ? header(request, 'x-yunshu-account-id') : query.get('account_id')
  const owner = query === undefined ? header(request, 'x-yunshu-account-owner') : query.get('account_owner')
  return id === account.id && owner === account.owner && /^[a-f\d]{64}$/u.test(account.owner)
}
async function readInput(request: IncomingMessage, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (header(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new DemandInputError('DEMAND_INVALID_INPUT')
  const parts: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    signal.throwIfAborted()
    length += (chunk as Uint8Array).byteLength
    if (length > maximum) throw new DemandInputError('DEMAND_INVALID_INPUT')
    parts.push(Buffer.from(chunk as Uint8Array))
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) }
  catch (_invalidJson: unknown) { throw new DemandInputError('DEMAND_INVALID_INPUT') }
}
async function readResult(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || response.body === null) throw new DemandProtocolError()
  const reader = response.body.getReader(), parts: Uint8Array[] = []
  const abort = (): void => { void reader.cancel().catch((_cancelled: unknown) => {}) }
  signal.addEventListener('abort', abort, { once: true })
  let length = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await reader.read()
      signal.throwIfAborted()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximum) throw new DemandProtocolError()
      parts.push(next.value)
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
  } catch (error) {
    throw error instanceof SyntaxError || error instanceof DemandProtocolError ? new DemandProtocolError() : new DemandTransportError()
  }
  finally { signal.removeEventListener('abort', abort); await reader.cancel().catch((_cancelled: unknown) => {}); reader.releaseLock() }
}
function httpFailure(status: number): string {
  return status === 401 ? 'DEMAND_AUTH_REQUIRED' : status === 403 ? 'DEMAND_PERMISSION_DENIED' : status === 404 ? 'DEMAND_NOT_FOUND'
    : status === 409 ? 'DEMAND_CONFLICT' : status === 413 ? 'DEMAND_UPLOAD_TOO_LARGE' : status === 415 ? 'DEMAND_UPLOAD_UNSUPPORTED'
      : status === 429 ? 'DEMAND_RATE_LIMITED' : status >= 500 ? 'DEMAND_SERVICE_UNAVAILABLE' : 'DEMAND_INVALID_INPUT'
}
const remoteCodes = new Set(['DEMAND_INVALID_INPUT', 'DEMAND_EMPTY_MESSAGE', 'DEMAND_UPLOAD_INVALID', 'DEMAND_CURSOR_INVALID',
  'DEMAND_AUTH_REQUIRED', 'DEMAND_ENGINEER_REQUIRED', 'DEMAND_PERMISSION_DENIED', 'DEMAND_NOT_FOUND', 'DEMAND_ATTACHMENT_NOT_FOUND',
  'DEMAND_IDEMPOTENCY_CONFLICT', 'DEMAND_REVISION_CONFLICT', 'DEMAND_STATUS_CONFLICT', 'DEMAND_ENGINEER_UNAVAILABLE',
  'DEMAND_UPLOAD_OFFSET_CONFLICT', 'DEMAND_ATTACHMENT_IN_USE', 'DEMAND_UPLOAD_TOO_LARGE', 'DEMAND_UPLOAD_UNSUPPORTED',
  'DEMAND_RATE_LIMITED', 'DEMAND_DISABLED', 'DEMAND_STORAGE_UNAVAILABLE'])

function uploadStream(request: IncomingMessage, length: number, maximum: number,
  signal: AbortSignal, current: () => Promise<boolean>): ReadableStream<Uint8Array> {
  const iterator = request[Symbol.asyncIterator]()
  let loaded = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted()
        const next = await iterator.next()
        signal.throwIfAborted()
        if (!await current()) throw new DemandInputError('ACCOUNT_CHANGED')
        if (next.done) {
          if (loaded !== length) throw new DemandInputError('DEMAND_UPLOAD_INVALID')
          controller.close(); return
        }
        const chunk: unknown = next.value
        if (!(chunk instanceof Uint8Array)) throw new DemandInputError('DEMAND_UPLOAD_INVALID')
        loaded += chunk.byteLength
        if (loaded > maximum || loaded > length) throw new DemandInputError('DEMAND_UPLOAD_TOO_LARGE')
        controller.enqueue(chunk)
      } catch (error) { controller.error(error) }
    },
    async cancel() { request.destroy(); await iterator.return?.() },
  })
}

function attachmentRoute(value: unknown, id: string, baseUrl: string, upstream: string): { path: string; expires: number } {
  const data = demandObject(value), raw = demandText(data.url, 4096)
  let url: URL
  try { url = new URL(raw.startsWith(upstream + '/') ? apiUrl(baseUrl, raw) : raw, baseUrl + '/') }
  catch (_invalidUrl: unknown) { throw new DemandProtocolError() }
  const expected = new URL(apiUrl(baseUrl, `${upstream}/attachments/${id}/content`))
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash !== '' || url.username !== '' || url.password !== ''
    || url.searchParams.size !== 1 || !url.searchParams.has('token') || url.searchParams.get('token') === '') throw new DemandProtocolError()
  const prefix = new URL(baseUrl).pathname.replace(/\/+$/u, '')
  return { path: url.pathname.slice(prefix.length) + url.search, expires: demandInteger(data.expires_at) }
}

/**
 * Build a local attachment URL whose opaque owner query guards against account-switch races.
 * @param id - Validated attachment identity.
 * @param account - Captured account id and non-secret login scope.
 * @param disposition - Already validated inline or attachment presentation intent.
 * @returns The local Host path; no production Bearer or upstream signed capability is exposed.
 */
export function demandContentPath(id: string, account: Pick<DemandAccount, 'id' | 'owner'>, disposition: string): string {
  return `${LOCAL_BASE_PATH}/attachments/${encodeURIComponent(demandId(id))}/content?${new URLSearchParams({
    account_id: account.id, account_owner: account.owner, disposition,
  })}`
}

/**
 * Create a finite-lifetime route handler with strict account binding and quiescent disposal.
 * @param options - Existing credential-owner callbacks, explicit backend mapping and validated transport ceilings.
 * @returns A guarded demand route handler and an idempotent close operation that aborts and joins all owned I/O.
 */
export function createDemandProxy(options: DemandProxyOptions): {
  handle(request: IncomingMessage, response: ServerResponse, route: string, method: string): Promise<boolean>
  close(): Promise<void>
} {
  const baseUrl = normalizeApiBaseUrl(options.baseUrl), upstream = options.upstreamBasePath ?? DEMAND_UPSTREAM_BASE_PATH
  if (!/^\/api\/[A-Za-z0-9_/-]+$/u.test(upstream) || upstream.endsWith('/') || upstream.includes('//')) throw new Error('Invalid demand API mapping')
  apiUrl(baseUrl, upstream)
  limitsOf(options.limits())
  const life = new AbortController(), operations = new Set<Promise<void>>()
  let closed: Promise<void> | undefined

  const run = async (request: IncomingMessage, response: ServerResponse, route: Route): Promise<void> => {
    const rejected = options.requestRejection(request)
    if (rejected !== undefined) { json(response, { ok: false, code: 'DEMAND_HOST_AUTH_REQUIRED' }, rejected); return }
    const limits = limitsOf(options.limits()), disconnected = new AbortController()
    const disconnect = (): void => { if (!response.writableEnded) disconnected.abort() }
    const timeout = AbortSignal.timeout(route.kind === 'upload-chunk' ? limits.uploadTimeoutMs : route.kind === 'content' ? limits.downloadTimeoutMs : limits.requestTimeoutMs)
    const signal = AbortSignal.any([life.signal, disconnected.signal, timeout])
    const abortInput = (): void => { if (!request.complete) request.destroy() }
    response.once('close', disconnect)
    signal.addEventListener('abort', abortInput, { once: true })
    let sent = false, operationKey: string | undefined, captured: DemandAccount | null = null, linkDisposition = 'inline'
    const writing = !['GET', 'HEAD'].includes(route.method) && route.kind !== 'link'
    try {
      signal.throwIfAborted()
      const account = await options.captureAccount(signal)
      captured = account
      if (account === null) { json(response, { ok: false, code: 'DEMAND_AUTH_REQUIRED', httpStatus: 401 }); return }
      const query = new URL(request.url ?? '/', 'http://demand.invalid').searchParams
      if (!expectedOwner(request, account, route.kind === 'content' ? query : undefined) || !await account.isCurrent()) {
        json(response, { ok: false, code: 'ACCOUNT_CHANGED' }); return
      }
      const ownerFields = { account: { id: account.id }, accountOwner: account.owner }
      let init: RequestInit & { duplex?: 'half' } = { method: route.method, headers: { accept: 'application/json' }, signal }
      let suffix = route.suffix
      if (route.kind === 'content') {
        for (const key of query.keys()) {
          if (!['account_id', 'account_owner', 'disposition'].includes(key) || query.getAll(key).length !== 1) {
            throw new DemandInputError('DEMAND_INVALID_INPUT')
          }
        }
        const disposition = query.get('disposition') ?? 'inline'
        if (disposition !== 'inline' && disposition !== 'attachment') throw new DemandInputError('DEMAND_INVALID_INPUT')
        const range = header(request, 'range'), ifRange = header(request, 'if-range')
        if (range !== undefined && (!/^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/u.test(range) || range === 'bytes=-')) throw new DemandInputError('DEMAND_RANGE_INVALID')
        if (ifRange !== undefined && (ifRange.length > 256 || /[^\x20-\x7e]/u.test(ifRange))) throw new DemandInputError('DEMAND_RANGE_INVALID')
        const link = await transfer(() => account.fetch(`${upstream}/attachments/${route.attachmentId}/link`, { method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ disposition }), signal }))
        if (!link.ok) {
          await link.body?.cancel()
          json(response, { ok: false, code: httpFailure(link.status), httpStatus: link.status }); return
        }
        const envelope = demandObject(await readResult(link, limits.maxJsonResponseBytes, signal)), data = demandObject(envelope.data)
        if (envelope.success !== true) throw new DemandProtocolError()
        const linkRoute = attachmentRoute(data, route.attachmentId ?? '', baseUrl, upstream)
        if (!await account.isCurrent()) { json(response, { ok: false, code: 'ACCOUNT_CHANGED' }); return }
        const media = await transfer(() => options.fetchPublic(linkRoute.path, { method: route.method, signal,
          headers: { ...range === undefined ? {} : { range }, ...ifRange === undefined ? {} : { 'if-range': ifRange } } }))
        if (!await account.isCurrent()) { await media.body?.cancel(); json(response, { ok: false, code: 'ACCOUNT_CHANGED' }); return }
        if (!media.ok && media.status !== 416) {
          await media.body?.cancel()
          json(response, { ok: false, code: httpFailure(media.status), httpStatus: media.status }); return
        }
        const headers: Record<string, string> = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition']) {
          const value = media.headers.get(key)
          if (value !== null) headers[key] = value
        }
        const mediaType = media.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (media.status !== 416 && (mediaType === undefined || !/^(?:image\/(?!svg)[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/u.test(mediaType))) {
          await media.body?.cancel(); throw new DemandProtocolError()
        }
        response.writeHead(media.status, headers)
        if (route.method === 'HEAD' || media.body === null) { await media.body?.cancel(); response.end(); return }
        const reader = media.body.getReader()
        const stopRead = (): void => { void reader.cancel().catch((_cancelled: unknown) => {}) }
        signal.addEventListener('abort', stopRead, { once: true })
        try {
          for (;;) {
            signal.throwIfAborted()
            const chunk = await reader.read()
            signal.throwIfAborted()
            if (!await account.isCurrent()) { response.destroy(); return }
            if (chunk.done) break
            if (!response.write(chunk.value)) await new Promise<void>((resolve, reject) => {
              const clean = (): void => { response.off('drain', drain); signal.removeEventListener('abort', abort) }
              const drain = (): void => { clean(); resolve() }
              const abort = (): void => { clean(); reject(signal.reason instanceof Error ? signal.reason : new Error('Demand read cancelled')) }
              response.once('drain', drain); signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
            })
          }
          response.end()
        } finally { signal.removeEventListener('abort', stopRead); await reader.cancel().catch((_cancelled: unknown) => {}); reader.releaseLock() }
        return
      }
      if (route.kind === 'upload-chunk') {
        if (query.size !== 0 || header(request, 'content-type')?.split(';', 1)[0]?.trim() !== 'application/octet-stream') throw new DemandInputError('DEMAND_UPLOAD_INVALID')
        const offset = header(request, 'upload-offset'), length = header(request, 'content-length')
        if (offset === undefined || !/^\d{1,16}$/u.test(offset) || !Number.isSafeInteger(Number(offset)) || length === undefined
          || !/^\d{1,10}$/u.test(length) || Number(length) < 1 || Number(length) > limits.maxChunkBytes) throw new DemandInputError('DEMAND_UPLOAD_INVALID')
        operationKey = `${route.uploadId}:${offset}`
        init = { method: 'PUT', signal, duplex: 'half', body: uploadStream(request, Number(length), limits.maxChunkBytes, signal, () => account.isCurrent()),
          headers: { accept: 'application/json', 'content-type': 'application/octet-stream', 'content-length': length, 'upload-offset': offset } }
      } else if (route.method === 'POST') {
        if (query.size !== 0) throw new DemandInputError('DEMAND_INVALID_INPUT')
        let body: ReturnType<typeof demandRequest>
        try { body = demandRequest(route.kind, await readInput(request, limits.maxJsonRequestBytes, signal)) }
        catch (error) { throw error instanceof DemandProtocolError ? new DemandInputError('DEMAND_INVALID_INPUT') : error }
        const key = body.client_request_id ?? body.client_message_id ?? body.client_action_id ?? body.client_upload_id
        if (route.kind === 'link') linkDisposition = demandText(body.disposition, 10)
        operationKey = typeof key === 'string' ? key : route.kind === 'upload-complete' ? `${route.uploadId}:complete` : undefined
        init = { method: 'POST', signal, headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }
      } else {
        let selected: URLSearchParams
        try { selected = demandQuery(route.kind, query) } catch (_invalidQuery: unknown) { throw new DemandInputError('DEMAND_INVALID_INPUT') }
        if (selected.size > 0) suffix += `?${selected}`
      }
      if (!await account.isCurrent()) { json(response, { ok: false, code: 'ACCOUNT_CHANGED' }); return }
      sent = true
      const result = await transfer(() => account.fetch(upstream + suffix, init))
      const raw: unknown = await readResult(result, limits.maxJsonResponseBytes, signal)
      if (!await account.isCurrent()) { json(response, { ok: false, code: 'ACCOUNT_CHANGED' }); return }
      const envelope = demandObject(raw)
      if (!result.ok || envelope.success === false) {
        const retryAfterSeconds = accountRetryAfter(result.headers)
        json(response, { ok: false, code: typeof envelope.code === 'string' && remoteCodes.has(envelope.code) ? envelope.code : httpFailure(result.status),
          ...retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
          httpStatus: result.status, ...ownerFields, ...writing && result.status >= 500 ? { outcome: 'unknown', operationKey } : {} }); return
      }
      if (route.kind === 'link') {
        const value = demandObject(envelope.data)
        if (envelope.success !== true) throw new DemandProtocolError()
        const valid = attachmentRoute(value, route.attachmentId ?? '', baseUrl, upstream)
        json(response, { ok: true, payload: { url: demandContentPath(route.attachmentId ?? '', account, linkDisposition),
          expires_at: valid.expires }, httpStatus: result.status, ...ownerFields }); return
      }
      json(response, { ok: true, payload: demandResponse(route.kind, raw), httpStatus: result.status, ...ownerFields })
    } catch (error) {
      if (response.headersSent) { response.destroy(); return }
      const current = captured === null || await captured.isCurrent().catch(() => false)
      const code = !current ? 'ACCOUNT_CHANGED' : error instanceof DemandInputError ? error.code : error instanceof DemandProtocolError ? 'DEMAND_PROTOCOL_INVALID'
        : timeout.aborted ? 'DEMAND_TIMEOUT' : signal.aborted ? 'DEMAND_CANCELLED'
          : error instanceof DemandTransportError ? 'DEMAND_NETWORK' : 'DEMAND_UNAVAILABLE'
      json(response, { ok: false, code, ...writing && sent ? { outcome: 'unknown', operationKey } : {} })
    } finally { signal.removeEventListener('abort', abortInput); response.off('close', disconnect) }
  }

  return {
    async handle(request, response, path, method) {
      const local = path.startsWith('/credits/') ? path.slice('/credits'.length) : path
      if (local !== '/api/demands' && !local.startsWith('/api/demands/')) return false
      if (life.signal.aborted) { json(response, { ok: false, code: 'DEMAND_UNAVAILABLE' }); return true }
      const route = selectRoute(local.slice('/api/demands'.length), method)
      if (route === undefined) { json(response, { ok: false, code: 'DEMAND_NOT_FOUND' }, 404); return true }
      const operation = run(request, response, route)
      operations.add(operation)
      try { await operation } finally { operations.delete(operation) }
      return true
    },
    close() {
      if (closed === undefined) { life.abort(); closed = Promise.allSettled([...operations]).then(() => undefined) }
      return closed
    },
  }
}
