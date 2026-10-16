/** Lifecycle-owned publication reader with stable observable snapshots. */
import type { Config } from '../index.ts'
import type { CreationContentCatalog, CreationContentSnapshot } from './types.ts'
import { parseContent } from './parse.ts'

/** One catalog instance per plugin activation; disposal aborts pending reads. */
export class Catalog implements CreationContentCatalog {
  private snapshot: CreationContentSnapshot = { status: 'loading', content: null }
  private readonly listeners = new Set<() => void>()
  private readonly life = new AbortController()
  private pending: Promise<void> | undefined

  constructor(private readonly config: Config, private readonly report: (error: unknown) => void) {}

  getSnapshot = (): CreationContentSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    if (this.life.signal.aborted) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  refresh = (): Promise<void> => {
    if (this.life.signal.aborted) return Promise.resolve()
    this.pending ??= this.read().finally(() => { this.pending = undefined })
    return this.pending
  }

  /** Close subscriptions and await the cancelled read. @returns Resolves when the reader is quiescent. */
  async dispose(): Promise<void> {
    this.listeners.clear()
    this.life.abort()
    await this.pending
  }

  private async read(): Promise<void> {
    try {
      const response = await fetch('/credits/api/creation/content', {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([this.life.signal, AbortSignal.timeout(this.config.timeoutMs)]),
      })
      if (!response.ok) throw new Error('Creation content unavailable')
      const value: unknown = await response.json()
      if (typeof value !== 'object' || value === null || !('ok' in value) || value.ok !== true || !('payload' in value)) throw new Error('Creation content unavailable')
      const content = parseContent(value.payload)
      if (this.life.signal.aborted) return
      if (this.snapshot.status === 'ready' && this.snapshot.content?.revision === content.revision) return
      this.publish({ status: 'ready', content })
    } catch (error) {
      if (this.life.signal.aborted) return
      if (this.snapshot.status !== 'error') this.publish({ status: 'error', content: this.snapshot.content })
      this.report(error)
    }
  }

  private publish(snapshot: CreationContentSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { this.report(error) }
    }
  }
}
