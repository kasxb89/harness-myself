/** Authorized, cancellable Office previews through the shared Host converter. @module */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { OfficeExtension, OfficeSourceKey, OfficeToPdfRequest } from '@deepseek-ai/dsh-office-to-pdf'
import { ArtifactError, type authorizedFile } from './storage.ts'

type PreviewFile = Awaited<ReturnType<typeof authorizedFile>>

/**
 * Authorize the source again before reading and before returning a converted document.
 * @param signal - Request or converter cancellation.
 * @returns Current canonical file and its metadata within the live browsing scope.
 */
export type AuthorizePreview = (signal: AbortSignal) => Promise<PreviewFile>

function version(file: PreviewFile): string {
  const { dev, ino, size, mtimeMs, ctimeMs } = file.info
  return JSON.stringify([file.path, dev, ino, size, mtimeMs, ctimeMs])
}

function unchanged(expected: PreviewFile, actual: PreviewFile): void {
  if (version(expected) !== version(actual)) throw new ArtifactError('preview-stale', 409, 'The preview source changed')
}

function officeExtension(path: string): OfficeExtension {
  const extension = extname(path).slice(1).toLowerCase()
  if (extension === 'doc' || extension === 'docx' || extension === 'xls' || extension === 'xlsx'
    || extension === 'ppt' || extension === 'pptx') return extension
  throw new ArtifactError('preview-invalid', 422, 'Unsupported preview format')
}

/** Read only an admitted source, including one sentinel byte beyond its capacity. */
async function readSource(
  source: PreviewFile, authorize: AuthorizePreview, signal: AbortSignal, maxBytes: number,
): Promise<{ bytes: Uint8Array; version: string }> {
  signal.throwIfAborted()
  const current = await authorize(signal)
  unchanged(source, current)
  const handle = await open(current.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    unchanged(source, { path: current.path, info: await handle.stat() })
    signal.throwIfAborted()
    const input = handle.createReadStream({ autoClose: false, start: 0, end: maxBytes })
    const stop = (): void => { input.destroy() }
    signal.addEventListener('abort', stop, { once: true })
    const chunks: Buffer[] = []
    let size = 0
    try {
      if (signal.aborted) stop()
      for await (const chunk of input) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Unexpected source stream encoding')
        chunks.push(chunk)
        size += chunk.length
      }
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', stop)
    }
    unchanged(source, { path: current.path, info: await handle.stat() })
    unchanged(source, await authorize(signal))
    if (size > maxBytes) throw new ArtifactError('preview-too-large', 413, 'The preview source exceeds its reserved capacity')
    return { bytes: Buffer.concat(chunks, size), version: version(source) }
  } finally { await handle.close() }
}

function failure(code: string, status: number, error: unknown): ArtifactError {
  const result = new ArtifactError(code, status, 'Document preview failed')
  result.cause = error
  return result
}

function conversionFailure(error: unknown): ArtifactError {
  if (error instanceof ArtifactError) return error
  if (error instanceof Error && error.name === 'OfficeToPdfError' && 'code' in error) {
    switch (error.code) {
      case 'input-too-large': case 'output-too-large': return failure('preview-too-large', 413, error)
      case 'invalid-document': case 'unsupported-format': return failure('preview-invalid', 422, error)
      case 'source-changed': return failure('preview-stale', 409, error)
      case 'unavailable': return failure('preview-unavailable', 503, error)
      case 'busy': return failure('preview-busy', 503, error)
    }
  }
  return failure('preview-failed', 500, error)
}

/**
 * Convert a currently authorized Office file to PDF without changing its source.
 * @param ctx - Host carrying the optional shared Office converter.
 * @param response - Authenticated artifact response.
 * @param request - GET or HEAD request; conversion metadata is shared by both.
 * @param authorize - Rechecks the current root, registry membership, and file containment.
 * @param scope - Stable authorization scope used with the canonical source path for converter deduplication.
 * @param signal - Request disconnect or Host disposal cancellation.
 * @returns After the complete PDF or a classified failure; sources are never modified.
 */
export async function serveOfficePreview(
  ctx: Context, response: ServerResponse, request: IncomingMessage,
  authorize: AuthorizePreview, scope: string, signal: AbortSignal,
): Promise<void> {
  const source = await authorize(signal)
  const extension = officeExtension(source.path)
  const converter = ctx.get('officeToPdf')
  if (converter === undefined) throw new ArtifactError('preview-unavailable', 503, 'The document converter is unavailable')
  try {
    const input: OfficeToPdfRequest = { extension, priority: 'foreground', source: {
      key: JSON.stringify(['artifacts', scope, source.path]) as OfficeSourceKey,
      version: version(source), bytes: Number(source.info.size),
      read: (upstream, maxBytes) => readSource(source, authorize, upstream, maxBytes),
    } }
    const result = await converter.convert(input, signal)
    signal.throwIfAborted()
    unchanged(source, await authorize(signal))
    response.writeHead(200, {
      'content-type': 'application/pdf', 'content-length': result.pdf.byteLength,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'x-artifact-preview-missing-fonts': String(result.missingFonts.length),
    })
    response.end(request.method === 'HEAD' ? undefined : result.pdf)
  } catch (error) {
    signal.throwIfAborted()
    throw conversionFailure(error)
  }
}
