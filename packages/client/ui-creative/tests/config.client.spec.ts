import { expect, it } from 'vitest'
import { Config } from '../src/client/index.ts'

it('resolves the visible refresh default and rejects invalid supervision cadences', () => {
  expect(Config({})).toEqual({ pollIntervalMs: 2000 })
  expect(Config({ pollIntervalMs: 500 }).pollIntervalMs).toBe(500)
  expect(Config({ pollIntervalMs: 60_000 }).pollIntervalMs).toBe(60_000)
  for (const pollIntervalMs of [0, -1, 499, 60_001, 1000.5, NaN, Infinity]) {
    expect(() => Config({ pollIntervalMs })).toThrow()
  }
})
