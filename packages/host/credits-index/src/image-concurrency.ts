/** Scheduling for independent, already requested image invocations. @module */

/** Local default; this is neither an image count nor a provider reservation. */
export const DEFAULT_IMAGE_CONCURRENCY = 10

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Read an exact model's enforced ceiling without inferring capacity from account counts.
 * @param rows - Current gateway pricing rows before capability projection.
 * @param model - Exact image model being requested.
 * @returns A verified ceiling, or no additional ceiling when undeclared or invalid.
 */
export function imageConcurrencyCeiling(rows: readonly unknown[], model: string): number | undefined {
  if (model.length === 0) return undefined
  const matches = rows.map(object).filter(row => row?.model_name === model)
  if (matches.length !== 1) return undefined
  const hint = object(object(matches[0]?.parameters)?.['x-client-concurrency'])
  const maximum = hint?.max_parallelism
  if (hint?.schema !== 1 || hint.atomic_admission !== true || hint.model !== model
    || hint.scope !== 'shared_account_pool' || hint.reservation !== false
    || typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64) return undefined
  return maximum
}

interface WaitingImage {
  readonly model: string
  readonly signal: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly aborted: () => void
}

/** Host-wide image execution slots, separate from video scheduling and batch n. */
export class ImageConcurrency {
  private active = 0
  private readonly models = new Map<string, number>()
  private readonly ceilings = new Map<string, number>()
  private readonly waiting: WaitingImage[] = []
  private scope: number | undefined

  /** @param maximum - Explicit local ceiling; omitted follows verified pool capacity or defaults to ten. */
  constructor(private readonly maximum?: number) {
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64)) {
      throw new RangeError('Invalid image concurrency')
    }
  }

  /**
   * Wait without submitting or retrying a request. Release is idempotent.
   * @param model - Exact model for the invocation.
   * @param ceiling - Optional current gateway-enforced model ceiling.
   * @param signal - Cancellation while queued; admitted execution keeps its own signal.
   * @param scope - Current Host login epoch; earlier accounts cannot lend their observed capacity.
   * @returns A release callback for the invocation's finalizer.
   */
  acquire(model: string, ceiling: number | undefined, signal: AbortSignal, scope = 0): Promise<() => void> {
    signal.throwIfAborted()
    if (ceiling !== undefined && (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 64)) {
      throw new RangeError('Invalid image model concurrency')
    }
    if (this.scope !== scope) { this.scope = scope; this.ceilings.clear() }
    this.ceilings.set(model, this.maximum === undefined ? ceiling ?? DEFAULT_IMAGE_CONCURRENCY
      : Math.min(this.maximum, ceiling ?? this.maximum))
    return new Promise((resolve, reject) => {
      const aborted = (): void => {
        const index = this.waiting.indexOf(entry)
        if (index < 0) return
        this.waiting.splice(index, 1)
        signal.removeEventListener('abort', aborted)
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Image execution cancelled', 'AbortError'))
        this.forgetIdle(entry.model)
        this.pump()
      }
      const entry: WaitingImage = { model, signal, resolve, aborted }
      this.waiting.push(entry)
      signal.addEventListener('abort', aborted, { once: true })
      this.pump()
    })
  }

  /** Admit the oldest eligible invocation; a saturated model does not block others. */
  private pump(): void {
    const maximum = this.maximum ?? Math.max(DEFAULT_IMAGE_CONCURRENCY, ...this.ceilings.values())
    while (this.active < maximum) {
      const index = this.waiting.findIndex(entry => (this.models.get(entry.model) ?? 0)
        < (this.ceilings.get(entry.model) ?? this.maximum ?? DEFAULT_IMAGE_CONCURRENCY))
      if (index < 0) return
      const entry = this.waiting.splice(index, 1)[0]
      if (entry === undefined) return
      entry.signal.removeEventListener('abort', entry.aborted)
      this.active += 1
      this.models.set(entry.model, (this.models.get(entry.model) ?? 0) + 1)
      let released = false
      entry.resolve(() => {
        if (released) return
        released = true
        this.active -= 1
        const remaining = (this.models.get(entry.model) ?? 1) - 1
        if (remaining === 0) this.models.delete(entry.model)
        else this.models.set(entry.model, remaining)
        this.forgetIdle(entry.model)
        this.pump()
      })
    }
  }

  /** Retain declarations only for currently observed active or queued work. */
  private forgetIdle(model: string): void {
    if (!this.models.has(model) && !this.waiting.some(entry => entry.model === model)) this.ceilings.delete(model)
  }
}
