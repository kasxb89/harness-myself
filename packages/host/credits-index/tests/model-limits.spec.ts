import { describe, expect, it } from 'vitest'
import { mergeProductModelLimits, productModelLimitsScope, readProductModelLimits } from '../src/model-limits.ts'

describe('product model token capacities', () => {
  it('reads only explicit numeric limits and rejects inconsistent paired limits', () => {
    expect(readProductModelLimits({ context_window: 1_048_576, max_output_tokens: 384_000 }))
      .toEqual({ contextWindow: 1_048_576, maxTokens: 384_000 })
    expect(readProductModelLimits({ contextWindow: 1_048_576, maxTokens: 384_000 })).toEqual({})
    expect(readProductModelLimits({ context_window: 8192, max_output_tokens: 16384 })).toEqual({})
    expect(readProductModelLimits({ context_window: 32768 })).toEqual({ contextWindow: 32768 })
    expect(readProductModelLimits({ max_output_tokens: 8192 })).toEqual({ maxTokens: 8192 })
  })

  it.each([undefined, null, '8192', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'ignores invalid capacities %s without replacing the other valid field', (invalid) => {
      expect(readProductModelLimits({ context_window: invalid, max_output_tokens: 4096 })).toEqual({ maxTokens: 4096 })
      expect(readProductModelLimits({ context_window: 32768, max_output_tokens: invalid })).toEqual({ contextWindow: 32768 })
    },
  )

  it('updates increases and decreases independently while retaining omitted fields for the same owner', () => {
    const previous = { scope: 'account-a', contextWindow: 32768, maxTokens: 4096 }
    expect(mergeProductModelLimits(previous, { contextWindow: 1_048_576, maxTokens: 384_000 }, 'account-a'))
      .toEqual({ scope: 'account-a', contextWindow: 1_048_576, maxTokens: 384_000 })
    expect(mergeProductModelLimits(previous, { contextWindow: 16384, maxTokens: 2048 }, 'account-a'))
      .toEqual({ scope: 'account-a', contextWindow: 16384, maxTokens: 2048 })
    expect(mergeProductModelLimits(previous, { maxTokens: 8192 }, 'account-a'))
      .toEqual({ scope: 'account-a', contextWindow: 32768, maxTokens: 8192 })
    expect(mergeProductModelLimits(previous, undefined, 'account-a')).toEqual(previous)
  })

  it('never adopts the previous backend or account capacities', () => {
    const first = productModelLimitsScope('https://gateway.example/harness', '7')
    expect(first).toMatch(/^[a-f\d]{64}$/u)
    expect(productModelLimitsScope('https://gateway.example/harness', '7')).toBe(first)
    expect(productModelLimitsScope('https://gateway.example/other', '7')).not.toBe(first)
    expect(productModelLimitsScope('https://gateway.example/harness', '8')).not.toBe(first)
    expect(mergeProductModelLimits({ scope: first, contextWindow: 32768, maxTokens: 4096 }, {}, 'another'))
      .toBeUndefined()
    expect(mergeProductModelLimits(null, { maxTokens: 2048 }, first)).toEqual({ scope: first, maxTokens: 2048 })
    expect(mergeProductModelLimits([], undefined, first)).toBeUndefined()
  })
})
