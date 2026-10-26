/** Bounded, content-free local model and tool latency observations. @module */
import { randomUUID } from 'node:crypto'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** One model-call or tool execution; durations are not added across overlapping work. */
export interface GenerationPerformanceRecord {
  readonly id: string
  readonly kind: 'model' | 'tool'
  readonly name: string
  readonly recorded_at: number
  readonly elapsed_ms: number
  readonly first_reasoning_ms?: number
  readonly first_text_ms?: number
  readonly reasoning_effort?: string
  readonly outcome: string
}

/** Process-private bounded observations; no input, output, thinking text, path or credential is retained. */
export class GenerationPerformance {
  private readonly records: { owner: string; value: GenerationPerformanceRecord }[] = []

  /** @param maximum - Validated retained-record limit; zero disables observation. @param now - Monotonic clock. */
  constructor(private readonly maximum: number, private readonly now: () => number = () => performance.now()) {}

  /**
   * Return detached latency records belonging to the current login.
   * @param owner - Exact current login owner.
   * @returns Independent copies of the current owner's records only.
   */
  read(owner: string): GenerationPerformanceRecord[] {
    return this.records.filter(item => item.owner === owner).map(item => ({ ...item.value }))
  }

  /** Remove observations at logout and prevent accidental cross-login display. */
  clear(): void { this.records.length = 0 }

  private append(owner: string, value: GenerationPerformanceRecord): void {
    if (this.maximum === 0) return
    this.records.push({ owner, value })
    if (this.records.length > this.maximum) this.records.splice(0, this.records.length - this.maximum)
  }

  /**
   * Observe a stream without changing requests, chunk identity or failure propagation.
   * @param input - Captured login, selected model and explicitly requested reasoning setting.
   * @param stream - Model-call stream, including preparation; explicit retry calls have separate records.
   * @returns Unchanged chunks; first reasoning and visible text remain separate measurements.
   */
  async *stream(input: { owner: string; name: string; reasoningEffort?: string },
    stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (this.maximum === 0) { yield* stream; return }
    const start = this.now()
    let reasoning: number | undefined
    let text: number | undefined
    let outcome = 'interrupted'
    try {
      for await (const chunk of stream) {
        if (chunk.type === 'reasoning-delta' && chunk.text.length > 0 && reasoning === undefined) reasoning = this.now() - start
        if (chunk.type === 'text-delta' && chunk.text.length > 0 && text === undefined) text = this.now() - start
        if (chunk.type === 'finish') outcome = chunk.reason.kind
        yield chunk
      }
    } finally {
      this.append(input.owner, { id: randomUUID(), kind: 'model', name: input.name, recorded_at: Date.now(),
        elapsed_ms: Math.max(0, this.now() - start), outcome,
        ...reasoning === undefined ? {} : { first_reasoning_ms: Math.max(0, reasoning) },
        ...text === undefined ? {} : { first_text_ms: Math.max(0, text) },
        ...input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort } })
    }
  }

  /**
   * Observe one tool without retaining arguments or result contents.
   * @param owner - Captured current login.
   * @param name - Registered tool name.
   * @param run - Exact delegated execution; errors retain their original identity.
   * @returns The unchanged tool result.
   */
  async tool<T extends { readonly isError: boolean }>(owner: string, name: string, run: () => Promise<T>): Promise<T> {
    if (this.maximum === 0) return await run()
    const start = this.now()
    let outcome = 'error'
    try {
      const result = await run()
      outcome = result.isError ? 'error' : 'returned'
      return result
    } finally {
      this.append(owner, { id: randomUUID(), kind: 'tool', name, recorded_at: Date.now(), elapsed_ms: Math.max(0, this.now() - start), outcome })
    }
  }
}
