import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { GenerationPerformance } from '../src/generation-performance.ts'

describe('content-free generation latency observations', () => {
  it('separates first thinking and visible text and forwards original chunks unchanged', async () => {
    let time = 0
    const observations = new GenerationPerformance(3, () => time)
    const chunks: StreamChunk[] = [
      { type: 'reasoning-delta', index: 0, text: 'private reasoning' },
      { type: 'text-delta', index: 1, text: 'private response' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    async function* source(): AsyncIterable<StreamChunk> {
      for (const chunk of chunks) { time += 10; yield chunk }
    }
    const actual = []
    for await (const chunk of observations.stream({ owner: 'a', name: 'selected-model', reasoningEffort: 'chosen' }, source())) actual.push(chunk)
    actual.forEach((chunk, index) => { expect(chunk).toBe(chunks[index]) })
    expect(observations.read('a')).toMatchObject([{ kind: 'model', name: 'selected-model', elapsed_ms: 30,
      first_reasoning_ms: 10, first_text_ms: 20, reasoning_effort: 'chosen', outcome: 'stop' }])
    expect(JSON.stringify(observations.read('a'))).not.toContain('private')
    expect(observations.read('b')).toEqual([])
  })

  it('retains the original failure and bounds records without summing overlapping work', async () => {
    let time = 10
    const observations = new GenerationPerformance(2, () => time)
    const failure = new Error('private server or file information')
    await expect(observations.tool('a', 'word_create', () => { time = 20; return Promise.reject(failure) })).rejects.toBe(failure)
    expect(observations.read('a')).toMatchObject([{ elapsed_ms: 10, outcome: 'error' }])
    const result = { isError: false, value: 'private document body' }
    expect(await observations.tool('a', 'slides_create', async () => result)).toBe(result)
    await observations.tool('b', 'workbook_create', async () => result)
    expect(observations.read('a')).toHaveLength(1)
    expect(JSON.stringify(observations.read('a'))).not.toContain('private')
    observations.clear()
    expect(observations.read('b')).toEqual([])
  })

  it('does not record disabled observations or confuse early stream return with success', async () => {
    async function* source(): AsyncIterable<StreamChunk> { yield { type: 'text-delta', index: 0, text: 'one' } }
    const disabled = new GenerationPerformance(0)
    for await (const _chunk of disabled.stream({ owner: 'a', name: 'm' }, source())) { /* Drain the real stream. */ }
    expect(disabled.read('a')).toEqual([])
    const observations = new GenerationPerformance(2)
    for await (const _chunk of observations.stream({ owner: 'a', name: 'm' }, source())) break
    expect(observations.read('a')).toMatchObject([{ outcome: 'interrupted' }])
  })
})
