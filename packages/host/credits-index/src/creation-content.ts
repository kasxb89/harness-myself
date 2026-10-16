/** Bounded, credential-free relay of the local administration publication. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'

const ASSET_ID = /^cc_[a-f0-9]{64}$/
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'])
const MEDIA_LIMIT = 100 * 1024 * 1024
const JSON_LIMIT = 5 * 1024 * 1024

function failure(response: ServerResponse, status: number, contentRange?: string): void {
  if (response.headersSent) { response.destroy(); return }
  for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) response.removeHeader(header)
  if (contentRange !== undefined) response.setHeader('content-range', contentRange)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify({ ok: false, code: 'CREATION_CONTENT_UNAVAILABLE' }))
}

/**
 * Relay a published document or immutable asset without account credentials.
 * @param request Browser request.
 * @param response Browser response.
 * @param route Credits-relative path.
 * @param baseUrl Validated loopback service origin.
 * @param timeoutMs Request deadline.
 * @param life Plugin lifetime cancellation.
 * @returns Resolves after transfer or a contained failure.
 */
export async function relayCreationContent(
  request: IncomingMessage, response: ServerResponse, route: string, baseUrl: string, timeoutMs: number, life: AbortSignal,
): Promise<void> {
  const isContent = route === '/api/creation/content'
  const assetId = route.slice('/api/creation/assets/'.length)
  if (!isContent && !ASSET_ID.test(assetId)) { failure(response, 400); return }
  const peer = new AbortController()
  const disconnected = (): void => { if (!response.writableEnded) peer.abort() }
  response.once('close', disconnected)
  const signal = AbortSignal.any([peer.signal, life, AbortSignal.timeout(timeoutMs)])
  try {
    const headers: Record<string, string> = { accept: isContent ? 'application/json' : 'image/png,image/jpeg,image/webp,video/mp4,video/webm' }
    if (!isContent && request.headers.range !== undefined) {
      if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(request.headers.range)) { failure(response, 400); return }
      headers.range = request.headers.range
    }
    const upstream = await fetch(`${baseUrl}${isContent ? '/api/creation/content' : `/api/creation/assets/${assetId}`}`, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'manual', signal,
    })
    if (!upstream.ok) {
      await upstream.body?.cancel()
      const contentRange = upstream.headers.get('content-range')
      failure(response, upstream.status === 404 ? 404 : upstream.status === 416 ? 416 : 502,
        upstream.status === 416 && contentRange !== null && /^bytes \*\/\d+$/.test(contentRange) ? contentRange : undefined)
      return
    }
    const mediaType = upstream.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    const limit = isContent ? JSON_LIMIT : MEDIA_LIMIT
    const length = upstream.headers.get('content-length')
    if ((isContent ? mediaType !== 'application/json' : !MEDIA_TYPES.has(mediaType))
      || (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))) {
      await upstream.body?.cancel()
      failure(response, 502)
      return
    }
    if (!isContent) {
      response.statusCode = upstream.status
      response.setHeader('content-type', mediaType)
      response.setHeader('cache-control', 'public, max-age=31536000, immutable')
      response.setHeader('x-content-type-options', 'nosniff')
      for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name)
        if (value !== null) response.setHeader(name, value)
      }
    }
    if (request.method === 'HEAD') { response.end(); return }
    if (upstream.body === null) { failure(response, 502); return }
    const reader = upstream.body.getReader()
    let size = 0
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > limit) throw new Error('Creation publication exceeds transfer limit')
        if (isContent) chunks.push(chunk.value)
        else if (!response.write(chunk.value)) await once(response, 'drain', { signal })
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    if (isContent) {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof value !== 'object' || value === null || !('success' in value) || value.success !== true || !('data' in value)) throw new Error('Creation publication rejected')
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(JSON.stringify({ ok: true, payload: value.data }))
    } else response.end()
  } catch (error) {
    // Upstream bodies and transport diagnostics never enter browser errors.
    void error
    if (!response.destroyed) failure(response, 502)
  } finally { response.removeListener('close', disconnected) }
}
