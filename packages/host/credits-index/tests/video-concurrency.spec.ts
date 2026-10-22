import { describe, expect, it } from 'vitest'
import { h3ProjectParallelism } from '../src/video-concurrency.ts'

const declared = { schema: 1, atomic_admission: true, max_parallelism: 16,
  model: 'MiniMax-H3', scope: 'shared_account_pool', reservation: false }

function row(hint: unknown): object {
  return { model_name: 'MiniMax-H3', parameters: { 'x-client-concurrency': hint } }
}

describe('enforced H3 project concurrency hints', () => {
  it.each([1, 4, 16])('accepts the declared shared-pool ceiling %s without treating it as free slots', (maximum) => {
    expect(h3ProjectParallelism([row({ ...declared, max_parallelism: maximum })])).toBe(maximum)
  })

  it.each([
    undefined, null, [], {}, { ...declared, schema: 2 }, { ...declared, schema: '1' },
    { ...declared, atomic_admission: false }, { ...declared, atomic_admission: 'true' },
    { ...declared, model: 'minimax-h3' }, { ...declared, scope: 'account' },
    { ...declared, reservation: true }, { ...declared, reservation: undefined },
    ...[0, -1, 1.5, 17, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '16']
      .map(max_parallelism => ({ ...declared, max_parallelism })),
  ])('keeps an absent or invalid declaration serial: %j', (hint) => {
    expect(h3ProjectParallelism([row(hint)])).toBe(1)
  })

  it('does not infer a ceiling from duplicate rows, another model, or an unversioned key count', () => {
    expect(h3ProjectParallelism([])).toBe(1)
    expect(h3ProjectParallelism([null, [], 'MiniMax-H3'])).toBe(1)
    expect(h3ProjectParallelism([row(declared), row(declared)])).toBe(1)
    expect(h3ProjectParallelism([{ model_name: 'another-video', parameters: { 'x-client-concurrency': declared } }])).toBe(1)
    expect(h3ProjectParallelism([{ model_name: 'MiniMax-H3', account_count: 4, max_parallelism: 16 }])).toBe(1)
  })
})
