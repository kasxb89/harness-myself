/**
 * `node:events`: a minimal EventEmitter with the members harness code uses.
 * Emission order and listener identity follow Node; anything beyond the basic
 * on/once/off/emit set throws.
 */

type Listener = (...args: unknown[]) => void

/**
 * A `once` wrapper, carrying the listener it stands for. Node publishes the same
 * `listener` member, and `removeListener(event, original)` matches through it, so
 * a caller that registered with `once` can withdraw with the function it wrote.
 */
type OnceWrapper = Listener & { listener: Listener }

const registries = new WeakMap<object, Map<string, Listener[]>>()

/** Legacy subclasses and prototype borrowers initialize state on their own first use. */
function registryOf(emitter: object): Map<string, Listener[]> {
  let registry = registries.get(emitter)
  if (registry === undefined) { registry = new Map(); registries.set(emitter, registry) }
  return registry
}

/** The `node:events` subset the harness registers on: add, remove, and emit. */
export class EventEmitter {

  /**
   * Register a listener.
   * @param event - event name.
   * @param listener - the listener.
   * @returns this emitter.
   */
  on(event: string, listener: Listener): this {
    const list = registryOf(this).get(event) ?? []
    list.push(listener)
    registryOf(this).set(event, list)
    return this
  }

  /**
   * Register a listener removed after its first call.
   * @param event - event name.
   * @param listener - the listener.
   * @returns this emitter.
   */
  once(event: string, listener: Listener): this {
    const wrapper = ((...args: unknown[]): void => {
      this.off(event, wrapper)
      listener.apply(this, args)
    }) as OnceWrapper
    wrapper.listener = listener
    return this.on(event, wrapper)
  }

  /**
   * Register a listener ahead of the existing ones.
   * @param event - event name.
   * @param listener - the listener.
   * @returns this emitter.
   */
  prependListener(event: string, listener: Listener): this {
    const list = registryOf(this).get(event) ?? []
    list.unshift(listener)
    registryOf(this).set(event, list)
    return this
  }

  /**
   * Remove a listener, by the function that was registered or by the one a
   * `once` wrapper stands for.
   * @param event - event name.
   * @param listener - the listener.
   * @returns this emitter.
   */
  off(event: string, listener: Listener): this {
    const list = registryOf(this).get(event)
    if (list !== undefined) {
      // Last registration first, as Node removes it.
      for (let at = list.length - 1; at >= 0; at--) {
        const registered = list[at]
        if (registered === listener || (registered as OnceWrapper | undefined)?.listener === listener) {
          list.splice(at, 1)
          break
        }
      }
    }
    return this
  }

  /**
   * Alias of {@link off}.
   * @param event - event name.
   * @param listener - the listener.
   * @returns this emitter.
   */
  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener)
  }

  /**
   * Drop listeners for one event, or all of them.
   * @param event - event name; omitted clears every event.
   * @returns this emitter.
   */
  removeAllListeners(event?: string): this {
    if (event === undefined) registryOf(this).clear()
    else registryOf(this).delete(event)
    return this
  }

  /**
   * Emit an event.
   * @param event - event name.
   * @param args - listener arguments.
   * @returns whether any listener ran.
   */
  emit(event: string, ...args: unknown[]): boolean {
    const list = registryOf(this).get(event)
    if (list === undefined || list.length === 0) {
      if (event === 'error') {
        const error = args[0]
        if (error instanceof Error) throw error
        throw Object.assign(new Error(`Unhandled error: ${String(error)}`), { code: 'ERR_UNHANDLED_ERROR', context: error })
      }
      return false
    }
    for (const listener of [...list]) listener.apply(this, args)
    return true
  }

  /**
   * Listeners of one event.
   * @param event - event name.
   * @returns a copy of the listener list.
   */
  listeners(event: string): Listener[] {
    return [...registryOf(this).get(event) ?? []]
  }

  /**
   * Listener count of one event.
   * @param event - event name.
   * @returns the count.
   */
  listenerCount(event: string): number {
    return registryOf(this).get(event)?.length ?? 0
  }

  /**
   * Node's max-listener knob has no effect here.
   * @returns This emitter, for chaining.
   */
  setMaxListeners(): this {
    return this
  }
}

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/**
 * The `node:events` declarations this module stands in for. `EventEmitter` keeps
 * this module's own class: Node's declaration carries the promise helpers and
 * statics (`once`, `on`, `getEventListeners`, `errorMonitor`) that no worker
 * caller registers through.
 */
type NodeFace = Partial<Omit<typeof import('node:events'), 'EventEmitter'>> & Record<'EventEmitter', unknown>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default Object.assign(EventEmitter, { EventEmitter }) satisfies NodeFace
