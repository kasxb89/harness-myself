/** Named diagnostic channels for the bundled LRU cache; asynchronous context tracing is unsupported. */
import { notImplementedFail } from '../../notImplementedFail.ts'

type Subscriber = (message: unknown, name: string | symbol) => void

class Channel {
  private readonly listeners: Subscriber[] = []
  constructor(readonly name: string | symbol) {}
  get hasSubscribers(): boolean { return this.listeners.length > 0 }
  subscribe(listener: Subscriber): void { this.listeners.push(listener) }
  unsubscribe(listener: Subscriber): boolean {
    const index = this.listeners.indexOf(listener)
    if (index < 0) return false
    this.listeners.splice(index, 1)
    return true
  }
  publish(message: unknown): void {
    for (const listener of this.listeners) {
      try { listener(message, this.name) } catch (error) { queueMicrotask(() => { throw error }) }
    }
  }
}

const channels = new Map<string | symbol, Channel>()

/**
 * Retrieve the shared channel for a diagnostic name.
 * @param name - Diagnostic string or symbol.
 * @returns The same channel and subscription state for each use of the name.
 */
export function channel(name: string | symbol): Channel {
  let existing = channels.get(name)
  if (existing === undefined) { existing = new Channel(name); channels.set(name, existing) }
  return existing
}

/**
 * Retrieve the five named channels observed by the LRU cache's optional tracing path.
 * @param name - Trace name; channel names use Node's `tracing:<name>:<phase>` convention.
 * @returns Real channel metadata; asynchronous store-context tracing refuses explicitly.
 */
export function tracingChannel(name: string): {
  start: Channel
  end: Channel
  asyncStart: Channel
  asyncEnd: Channel
  error: Channel
  readonly hasSubscribers: boolean
  tracePromise: (...args: never[]) => never
} {
  const names = {
    start: channel(`tracing:${name}:start`), end: channel(`tracing:${name}:end`),
    asyncStart: channel(`tracing:${name}:asyncStart`), asyncEnd: channel(`tracing:${name}:asyncEnd`),
    error: channel(`tracing:${name}:error`),
  }
  return {
    ...names,
    get hasSubscribers() { return Object.values(names).some(value => value.hasSubscribers) },
    tracePromise: notImplementedFail('node:diagnostics_channel', 'TracingChannel.tracePromise'),
  }
}

/** CommonJS interop marker. */
export const __esModule = true
/** Exact channel APIs consumed by the bundled cache. */
export default { channel, tracingChannel }
