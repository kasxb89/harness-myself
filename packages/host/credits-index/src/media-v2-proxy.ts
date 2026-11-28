/** Fixed-origin, account-owned media V2 browser bridge. Keys stay in Host closures. @module */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MediaV2Client, MediaV2Error, type MediaV2Account } from './media-v2-client.ts'
import { mediaV2Id, mediaV2Object, mediaV2UUID } from './media-v2-protocol.ts'

/** Existing account controller closures and fixed-route runtime used by the local bridge. */
export interface MediaV2ProxyOptions {
  client: MediaV2Client
  requestRejection(request: IncomingMessage): number | undefined
  capture(signal: AbortSignal): Promise<MediaV2Account & { isCurrent(): Promise<boolean> }>
}
/** Reversible HTTP bridge; closing it aborts and settles only its own active transfers. */
export interface MediaV2Proxy {
  handle(request: IncomingMessage, response: ServerResponse, route: string, method: string): Promise<boolean>
  close(): Promise<void>
}
function reply(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(data))
}
async function bytes(request: IncomingMessage, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0
  for await (const part of request) {
    signal.throwIfAborted(); const value = typeof part === 'string' ? Buffer.from(part) : part instanceof Uint8Array ? Buffer.from(part) : null
    if (value === null) throw new MediaV2Error('invalid_request', '无法读取素材字节，尚未提交生成。', 400)
    size += value.byteLength
    if (size > maximum) throw new MediaV2Error('invalid_request', '媒体请求超过读取上限，尚未提交生成。', 413)
    parts.push(value)
  }
  return Buffer.concat(parts, size)
}
/**
 * Register only the frozen route family, with quiescent disposal of local transfers.
 * @param options - Credential-owning account capture and the fixed-route runtime.
 * @returns A local request handler and its awaited disposal method.
 */
export function createMediaV2Proxy(options: MediaV2ProxyOptions): MediaV2Proxy {
  const life = new AbortController(), active = new Set<Promise<void>>()
  return {
    async handle(request: IncomingMessage, response: ServerResponse, route: string, method: string): Promise<boolean> {
      if (route !== '/api/media-v2' && !route.startsWith('/api/media-v2/')) return false
      const rejected = options.requestRejection(request)
      if (rejected !== undefined || life.signal.aborted) { reply(response, { success: false, error: { code: 'auth_required', message: '请从已连接的云枢客户端使用媒体创作。' } }, rejected ?? 503); return true }
      const lifetime = new AbortController(), signal = AbortSignal.any([life.signal, lifetime.signal])
      const disconnected = (): void => { if (!response.writableEnded) lifetime.abort() }
      response.once('close', disconnected)
      const operation = (async () => {
        try {
          const account = await options.capture(signal)
          const suffix = route.slice('/api/media-v2'.length), url = new URL(request.url ?? '/', 'http://localhost')
          const uploadRecovery = /^\/assets\/by-client-id\/([a-f0-9-]{36})$/iu.exec(suffix)
          const recovery = /^\/operations\/([a-f0-9-]{36})$/iu.exec(suffix)
          const content = /^\/tasks\/([^/]{1,768})\/artifacts\/([^/]{1,768})\/content$/u.exec(suffix)
          let data: unknown
          if (suffix === '/models' && method === 'GET') data = await options.client.catalog(account, signal)
          else if (suffix === '/operations' && method === 'GET') data = { operations: await options.client.records(account) }
          else if (uploadRecovery !== null && method === 'GET') data = await options.client.assetByClientId(account,
            uploadRecovery[1] ?? '', url.searchParams.get('model') ?? '', signal)
          else if (recovery !== null && method === 'GET') data = await options.client.query(account, recovery[1] ?? '', signal)
          else if (suffix === '/save' && method === 'POST') {
            const body = mediaV2Object(JSON.parse((await bytes(request, 16 * 1024, signal)).toString('utf8')))
            data = await options.client.saveArtifacts(account, mediaV2UUID(body.client_operation_id), signal)
          }
          else if (suffix === '/quotes' && method === 'POST') {
            const reconfirm = request.headers['x-yunshu-media-requote']
            if (reconfirm !== undefined && reconfirm !== '1') throw new MediaV2Error('invalid_request', '重新核价标记无效，尚未请求新报价。', 400)
            data = await options.client.quote(account, JSON.parse((await bytes(request, 1024 * 1024, signal)).toString('utf8')),
              signal, undefined, reconfirm === '1' ? { reconfirmPrice: true } : undefined)
          }
          else if (suffix === '/tasks' && method === 'POST') {
            const body = mediaV2Object(JSON.parse((await bytes(request, 16 * 1024, signal)).toString('utf8')))
            data = await options.client.submit(account, mediaV2UUID(body.client_operation_id), signal)
          } else if (suffix === '/assets' && method === 'POST') {
            const filename = decodeURIComponent(String(request.headers['x-file-name'] ?? ''))
            if (filename === '' || filename.length > 256 || /[\u0000-\u001f\u007f/\\]/u.test(filename)) throw new MediaV2Error('invalid_request', '请选择有效的素材文件名。', 400)
            data = await options.client.upload(account, { model: mediaV2Id(url.searchParams.get('model')),
              clientAssetId: mediaV2UUID(url.searchParams.get('client_asset_id')), filename,
              ...url.searchParams.has('field') ? { field: url.searchParams.get('field') ?? '' } : {},
              mime: (request.headers['content-type'] ?? 'application/octet-stream').split(';')[0] ?? 'application/octet-stream',
              ...request.headers['content-length'] === undefined ? {} : { size: Number(request.headers['content-length']) },
              stream: uploadSignal => (async function* () {
                const stop = (): void => { request.destroy(new Error('Media upload cancelled', { cause: uploadSignal.reason })) }
                uploadSignal.addEventListener('abort', stop, { once: true })
                try {
                  uploadSignal.throwIfAborted()
                  for await (const chunk of request) {
                    if (!(chunk instanceof Uint8Array)) throw new MediaV2Error('invalid_request', '无法读取素材原字节。', 400)
                    yield chunk
                  }
                } finally { uploadSignal.removeEventListener('abort', stop) }
              })() }, signal)
          } else if (content !== null && (method === 'GET' || method === 'HEAD')) {
            const upstream = await options.client.content(account, mediaV2Id(decodeURIComponent(content[1] ?? '')),
              mediaV2Id(decodeURIComponent(content[2] ?? '')), { method,
                headers: request.headers.range === undefined ? {} : { range: request.headers.range }, signal })
            if (!await account.isCurrent()) { await upstream.body?.cancel(); throw new MediaV2Error('auth_required', '账号已变化，请回原账号查看原产物。', 401) }
            if (!upstream.ok && upstream.status !== 416) { await upstream.body?.cancel(); throw new MediaV2Error('asset_not_found', '原产物暂时无法读取，请保留原任务。', upstream.status) }
            const headers: Record<string, string> = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'none'; sandbox" }
            for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
              const value = upstream.headers.get(key); if (value !== null) headers[key] = value
            }
            const mime = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
            // Vectors are downloadable files, never live SVG documents in the app origin.
            if (mime === 'image/svg+xml' || url.searchParams.get('download') === '1') headers['content-disposition'] = 'attachment'
            response.writeHead(upstream.status, headers)
            if (method === 'HEAD' || upstream.body === null) { await upstream.body?.cancel(); response.end(); return }
            const reader = upstream.body.getReader(), stop = (): void => { void reader.cancel().catch(() => undefined) }
            signal.addEventListener('abort', stop, { once: true })
            try {
              for (;;) {
                signal.throwIfAborted(); const chunk = await reader.read()
                if (chunk.done) break
                if (!await account.isCurrent()) { response.destroy(); break }
                if (!response.write(chunk.value)) await new Promise<void>((resolve, reject) => {
                  const clean = (): void => { response.off('drain', drain); signal.removeEventListener('abort', abort) }
                  const drain = (): void => { clean(); resolve() }, abort = (): void => { clean(); reject(new Error('Media transfer cancelled')) }
                  response.once('drain', drain); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
                })
              }
              if (!response.destroyed) response.end()
            } finally { signal.removeEventListener('abort', stop); await reader.cancel().catch(() => undefined); reader.releaseLock() }
            return
          } else { reply(response, { success: false, error: { code: 'invalid_request', message: '不支持此媒体接口或请求方式。' } }, 404); return }
          if (!await account.isCurrent()) throw new MediaV2Error('auth_required', '登录账号已变化，原操作保留。', 401)
          reply(response, { success: true, data })
        } catch (error) {
          if (response.headersSent) { response.destroy(); return }
          if (!response.destroyed) reply(response, { success: false, error: { code: error instanceof MediaV2Error ? error.code : 'operation_unknown',
            message: error instanceof MediaV2Error ? error.message : '媒体操作结果尚未确认，请保留原操作编号并查询，不要重复提交。' } }, error instanceof MediaV2Error ? error.status : 502)
        }
      })()
      active.add(operation)
      try { await operation } finally { active.delete(operation); response.off('close', disconnected) }
      return true
    },
    async close(): Promise<void> { life.abort(); await Promise.allSettled([...active]) },
  }
}
