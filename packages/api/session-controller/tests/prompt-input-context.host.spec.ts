import { describe, expect, it } from 'vitest'
import { admitPromptInputContext } from '../src/prompt-input-context.ts'

describe('prompt input context', () => {
  it('preserves omitted callers and detaches JSON namespaces', () => {
    expect(admitPromptInputContext(undefined)).toBeUndefined()
    const original = { plugin_a: { revision: 'first', values: [1, true, null] } }
    const admitted = admitPromptInputContext(original)
    original.plugin_a.revision = 'changed'
    expect(admitted).toEqual({ plugin_a: { revision: 'first', values: [1, true, null] } })
    expect(Object.isFrozen(admitted)).toBe(true)
    expect(Object.isFrozen(admitted?.plugin_a)).toBe(true)
  })

  it.each([
    null, [], 'text', 1, { plugin: undefined }, { plugin: NaN }, { plugin: Infinity },
    { plugin: -0 }, { plugin: () => {} }, { plugin: new Date() },
    { 'Bad Namespace': {} }, { plugin: { constructor: 'bad' } },
    JSON.parse('{"plugin":{"__proto__":{"polluted":true}}}'),
    { plugin: { [Symbol('hidden')]: true } },
  ])('rejects unsafe or lossy context %#', (value: unknown) => {
    expect(() => admitPromptInputContext(value)).toThrow(/inputContext/)
  })

  it('rejects cycles, accessors, sparse arrays and hidden properties without invoking getters', () => {
    const cycle: Record<string, unknown> = {}
    cycle.plugin = cycle
    let reads = 0
    const accessor = Object.defineProperty({}, 'plugin', { enumerable: true, get: () => { reads++; return {} } })
    const hidden = { plugin: Object.defineProperty({}, 'hidden', { value: true }) }
    for (const value of [cycle, accessor, hidden, { plugin: Array(1) }]) {
      expect(() => admitPromptInputContext(value)).toThrow(/inputContext/)
    }
    expect(reads).toBe(0)
  })

  it('bounds complete serialized UTF-8 bytes, nesting, and value count', () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ plugin: '' }))
    const exact = { plugin: 'a'.repeat(16 * 1024 - emptyBytes) }
    expect(admitPromptInputContext(exact)).toEqual(exact)
    expect(() => admitPromptInputContext({ plugin: `${exact.plugin}a` })).toThrow(/inputContext/)
    expect(() => admitPromptInputContext({ plugin: '图'.repeat(6000) })).toThrow(/inputContext/)
    let nested: unknown = null
    for (let index = 0; index < 9; index++) nested = { child: nested }
    expect(() => admitPromptInputContext({ plugin: nested })).toThrow(/inputContext/)
    expect(() => admitPromptInputContext({ plugin: Array.from({ length: 1024 }, () => true) })).toThrow(/inputContext/)
  })
})
