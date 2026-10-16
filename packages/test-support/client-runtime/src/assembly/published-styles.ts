/** Published bundle styles shared by independently owned clients in one document. */

interface TrackedStyle {
  readonly element: HTMLStyleElement
  readonly parent: Node
  readonly preceding: readonly ChildNode[]
  readonly following: readonly ChildNode[]
  readonly created: boolean
  holders: number
}

const styles = new Map<Node, TrackedStyle>()

/** One client's ownership of synchronous published-script and factory styles. */
export interface PublishedStyleLease {
  /**
   * Retain shared package styles and capture styles inserted synchronously, including before a throw.
   * @param packageName - Published package whose existing styles this factory reuses.
   * @param factory - Synchronous script or factory; its return value and thrown error pass through.
   * @returns The factory result; without a document no styles are tracked.
   * @throws when this lease has already been released, without executing the factory.
   */
  capture<T>(packageName: string, factory: () => T): T
  /** Release after plugin teardown; preserve prior styles and restore styles still held by other clients. */
  release(): void
}

function restore(state: TrackedStyle, pending: Set<TrackedStyle>): void {
  if (state.element.isConnected || pending.has(state)) return
  pending.add(state)
  try {
    for (const candidate of state.preceding) {
      const tracked = styles.get(candidate)
      if (tracked !== undefined) restore(tracked, pending)
      if (candidate.parentNode === state.parent) {
        state.parent.insertBefore(state.element, candidate.nextSibling)
        return
      }
    }
    for (const candidate of state.following) {
      const tracked = styles.get(candidate)
      if (tracked !== undefined) restore(tracked, pending)
      if (candidate.parentNode === state.parent) {
        state.parent.insertBefore(state.element, candidate)
        return
      }
    }
    state.parent.insertBefore(state.element, state.parent.childNodes[state.preceding.length] ?? null)
  } finally {
    pending.delete(state)
  }
}

/**
 * Own styles created by published factories without deleting page-owned or concurrently shared nodes.
 * @returns An idempotently releasable lease; captures after release fail before running their factory.
 */
export function createPublishedStyleLease(): PublishedStyleLease {
  const held = new Set<TrackedStyle>()
  let released = false

  const retain = (element: HTMLStyleElement, created: boolean): void => {
    let state = styles.get(element)
    if (state === undefined) {
      const parent = element.parentNode as ParentNode
      const preceding: ChildNode[] = []
      for (let previous = element.previousSibling; previous !== null; previous = previous.previousSibling) preceding.push(previous)
      const following: ChildNode[] = []
      for (let next = element.nextSibling; next !== null; next = next.nextSibling) following.push(next)
      state = { element, parent, preceding, following, created, holders: 0 }
      styles.set(element, state)
    }
    if (held.has(state)) return
    held.add(state)
    state.holders++
  }

  const isReleased = (): boolean => released

  const releaseHeld = (): void => {
    if (held.size === 0) return
    const prior: TrackedStyle[] = []
    for (const state of held) {
      state.holders--
      if (state.holders !== 0) continue
      if (state.created) {
        styles.delete(state.element)
        state.element.remove()
      } else prior.push(state)
    }
    held.clear()
    for (const state of styles.values()) restore(state, new Set())
    for (const state of prior) styles.delete(state.element)
  }

  return {
    capture<T>(packageName: string, factory: () => T): T {
      if (released) throw new Error('client-test-runtime: published style lease is released')
      if (typeof document === 'undefined') return factory()
      const owner = document
      const before = new Set(owner.querySelectorAll<HTMLStyleElement>('style'))
      for (const element of before) {
        if (element.getAttribute('data-plugin') === packageName) retain(element, false)
      }
      try {
        return factory()
      } finally {
        for (const element of owner.querySelectorAll<HTMLStyleElement>('style[data-plugin]')) {
          if (!before.has(element)) retain(element, true)
          else if (element.getAttribute('data-plugin') === packageName) retain(element, false)
        }
        if (isReleased()) releaseHeld()
      }
    },
    release(): void {
      if (released) return
      released = true
      releaseHeld()
    },
  }
}
