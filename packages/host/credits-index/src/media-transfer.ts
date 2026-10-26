/** Bounded ordered media preparation with cancellation and quiescent failure cleanup. @module */

/**
 * Apply independent transfers in input order while bounding active work.
 * @param values - Already validated inputs.
 * @param concurrency - Validated deployment-specific transfer limit.
 * @param signal - Operation cancellation.
 * @param run - One transfer; failure cancels active siblings, never an already-settled response.
 * @returns Results in original order, after every started transfer has settled.
 */
export async function transferMedia<T, R>(values: readonly T[], concurrency: number, signal: AbortSignal,
  run: (value: T, index: number, signal: AbortSignal) => Promise<R>): Promise<R[]> {
  signal.throwIfAborted()
  const active = new Set<AbortController>()
  const results: R[] = []
  const queue = values.entries()
  const failure: { occurred: boolean; error: unknown } = { occurred: false, error: undefined }
  const claimFailure = (error: unknown): boolean => {
    if (failure.occurred) return false
    failure.occurred = true
    failure.error = error
    return true
  }
  const worker = async (): Promise<void> => {
    while (!signal.aborted && !failure.occurred) {
      const entry = queue.next()
      if (entry.done) return
      const [index, value] = entry.value
      const controller = new AbortController()
      active.add(controller)
      try { results[index] = await run(value, index, AbortSignal.any([signal, controller.signal])) }
      catch (error: unknown) {
        if (claimFailure(error)) {
          for (const sibling of active) if (sibling !== controller) sibling.abort()
        }
        return
      } finally { active.delete(controller) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  if (failure.occurred) throw failure.error
  signal.throwIfAborted()
  return results
}

/**
 * Read one complete image without allowing an unbounded download allocation.
 * @param response - Actual successful download response.
 * @param maximumBytes - Validated per-image byte budget.
 * @param signal - Generation owner's cancellation.
 * @returns Complete image bytes; oversized and interrupted transfers never publish partial files.
 */
export async function readMediaBytes(response: Response, maximumBytes: number, signal: AbortSignal): Promise<Buffer> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maximumBytes) {
    await response.body?.cancel()
    throw new MediaTransferLimitError()
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const parts: Buffer[] = []
  let size = 0
  let complete = false
  const abort = (): void => { void reader.cancel().catch((_cancelFailure: unknown) => { /* Read failure remains authoritative. */ }) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) { complete = true; break }
      size += next.value.byteLength
      if (size > maximumBytes) throw new MediaTransferLimitError()
      parts.push(Buffer.from(next.value))
    }
    signal.throwIfAborted()
    return Buffer.concat(parts, size)
  } finally {
    signal.removeEventListener('abort', abort)
    if (!complete) await reader.cancel().catch((_cancelFailure: unknown) => { /* No partial image is committed. */ })
    reader.releaseLock()
  }
}

/** Configured transfer bound was exceeded before publishing an image. */
export class MediaTransferLimitError extends Error {
  /** Construct a credential-free diagnostic. */
  constructor() { super('Image transfer exceeds the configured byte budget'); this.name = 'MediaTransferLimitError' }
}
