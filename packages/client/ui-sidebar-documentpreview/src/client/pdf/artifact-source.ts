/** Bounded complete-byte reads for authorized artifact PDF URLs. @module */

/** User-presentable source failures; transport diagnostics remain in their causes. */
export class ArtifactPdfReadError extends Error {
  /** @param code - Localizable source failure. @param cause - Original transport or size failure. */
  constructor(readonly code: 'sourceFailed' | 'tooLarge', cause?: unknown) {
    super(code, { cause })
  }
}

/**
 * Read an authorized raw or Blob PDF without trusting its advertised size.
 * @param url - URL supplied by the artifact owner after file authorization.
 * @param signal - Selected artifact's read lifetime.
 * @param maxBytes - Validated PDF source capacity.
 * @returns Owned complete bytes, bounded by actual stream consumption.
 */
export async function readArtifactPdf(url: string, signal: AbortSignal, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const response = await fetch(url, { signal, headers: { accept: 'application/pdf' } })
    if (signal.aborted || !response.ok) {
      await response.body?.cancel()
      signal.throwIfAborted()
      throw new ArtifactPdfReadError('sourceFailed')
    }
    const reader = response.body?.getReader()
    if (reader === undefined) return new Uint8Array(0)
    let closing: Promise<void> | undefined
    const cancel = (): Promise<void> => closing ??= reader.cancel().catch((error: unknown) => {
      console.error('[pdf] source cleanup failed', error)
    })
    const aborted = (): void => { void cancel() }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      if (Number(response.headers.get('content-length')) > maxBytes) throw new ArtifactPdfReadError('tooLarge')
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        signal.throwIfAborted()
        const part = await reader.read()
        signal.throwIfAborted()
        if (part.done) break
        size += part.value.byteLength
        if (size > maxBytes) throw new ArtifactPdfReadError('tooLarge')
        chunks.push(part.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return bytes
    } finally {
      signal.removeEventListener('abort', aborted)
      await cancel()
      reader.releaseLock()
    }
  } catch (error) {
    signal.throwIfAborted()
    throw error instanceof ArtifactPdfReadError ? error : new ArtifactPdfReadError('sourceFailed', error)
  }
}
