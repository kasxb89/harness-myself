import { describe, expect, it } from 'vitest'
import { videoProjectParallelism } from '../src/video-concurrency.ts'

const declared = { schema: 1, atomic_admission: true, max_parallelism: 16,
  model: 'MiniMax-H3', scope: 'shared_account_pool', reservation: false }

function row(hint: unknown, model = 'MiniMax-H3'): object {
  return { model_name: model, parameters: { 'x-client-concurrency': hint } }
}

describe('enforced video project concurrency hints', () => {
  it.each([1, 2, 4, 16])('accepts the declared shared-pool ceiling %s without treating it as free slots', (maximum) => {
    expect(videoProjectParallelism([row({ ...declared, max_parallelism: maximum })], 'MiniMax-H3')).toBe(maximum)
  })

  it.each(['sd2.5-720p-x2', 'provider-video-v2', 'video-SpecificCase'])('accepts the same exact enforced declaration for %s', (model) => {
    expect(videoProjectParallelism([row({ ...declared, model, max_parallelism: 4 }, model)], model)).toBe(4)
  })

  it.each([
    undefined, null, [], {}, { ...declared, schema: 2 }, { ...declared, schema: '1' },
    { ...declared, atomic_admission: false }, { ...declared, atomic_admission: 'true' },
    { ...declared, model: 'minimax-h3' }, { ...declared, scope: 'account' },
    { ...declared, reservation: true }, { ...declared, reservation: undefined },
    ...[0, -1, 1.5, 17, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '16']
      .map(max_parallelism => ({ ...declared, max_parallelism })),
  ])('uses the local default for an absent or invalid declaration: %j', (hint) => {
    expect(videoProjectParallelism([row(hint)], 'MiniMax-H3')).toBe(4)
  })

  it('does not infer a ceiling from duplicate rows, another model, or an unversioned key count', () => {
    expect(videoProjectParallelism([], 'MiniMax-H3')).toBe(4)
    expect(videoProjectParallelism([null, [], 'MiniMax-H3'], 'MiniMax-H3')).toBe(4)
    expect(videoProjectParallelism([row(declared), row(declared)], 'MiniMax-H3')).toBe(4)
    expect(videoProjectParallelism([{ model_name: 'another-video', parameters: { 'x-client-concurrency': declared } }], 'MiniMax-H3')).toBe(4)
    expect(videoProjectParallelism([{ model_name: 'MiniMax-H3', account_count: 4, max_parallelism: 16 }], 'MiniMax-H3')).toBe(4)
  })

  it('does not reuse another model ceiling or merge conflicting declarations', () => {
    const model = 'sd2.5-720p-x2'
    const own = row({ ...declared, model, max_parallelism: 4 }, model)
    expect(videoProjectParallelism([row(declared), own], model)).toBe(4)
    expect(videoProjectParallelism([row(declared)], model)).toBe(4)
    expect(videoProjectParallelism([row(declared, model)], model)).toBe(4)
    expect(videoProjectParallelism([own, row({ ...declared, model, max_parallelism: 8 }, model)], model)).toBe(4)
    expect(videoProjectParallelism([row({ ...declared, model: '' }, '')], '')).toBe(4)
  })

  it('retains a verified lower ceiling even when duplicate rows cannot raise the default', () => {
    const model = 'sd2.5-720p-x2'
    expect(videoProjectParallelism([row({ ...declared, model, max_parallelism: 2 }, model),
      row({ ...declared, model, max_parallelism: 16 }, model)], model)).toBe(2)
  })
})
