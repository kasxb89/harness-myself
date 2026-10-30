import { describe, expect, it } from 'vitest'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../src/config.ts'
import { reservedCompletionTokens, resolvedHeadroomTokens } from '../src/request-budget.ts'

const route = { provider: 'live-provider', model: 'live-model' }
const model: LlmResolvedModelInfo = { provider: route.provider, id: route.model, name: 'Live model',
  context: { contextWindow: 32768 }, defaultMaxTokens: 4096, maxOutputTokens: 8192 }

function header(maxTokens: number, adapterDefault = false): EpochHeader {
  return { config: { ...route, maxTokens }, ...adapterDefault ? { adapterDefaults: { maxTokens: true } } : {} }
}

describe('live compaction output budgets', () => {
  it('re-resolves a marked default but preserves explicit and legacy output intent up to the new hard cap', () => {
    expect(reservedCompletionTokens(header(65536, true), model)).toBe(4096)
    expect(reservedCompletionTokens(header(65536), model)).toBe(8192)
    expect(reservedCompletionTokens(header(2048), model)).toBe(2048)
    expect(reservedCompletionTokens(undefined, model)).toBe(4096)
    expect(reservedCompletionTokens(header(65536, true), { ...model, defaultMaxTokens: 16384 })).toBe(8192)
    expect(reservedCompletionTokens({ config: { provider: 'old', model: 'old', maxTokens: 65536 } }, model)).toBe(4096)
    expect(reservedCompletionTokens(undefined, { ...route, id: route.model, name: 'Unknown limits' })).toBe(0)
    expect(reservedCompletionTokens(header(6000), { provider: route.provider, id: route.model, name: 'Legacy model' })).toBe(6000)
  })

  it('adapts omitted headroom across 32K, 1M and lowered 32K capacities for the same model', () => {
    const policy = resolveTargetPolicy(resolveConfig(), route)
    const oldHeader = header(65536, true)
    const budgets = [
      { contextWindow: 32768, output: 8192 },
      { contextWindow: 1048576, output: 196608 },
      { contextWindow: 32768, output: 4096 },
    ].map(({ contextWindow, output }) => {
      const live = { ...model, context: { contextWindow }, defaultMaxTokens: output, maxOutputTokens: output }
      const reserve = reservedCompletionTokens(oldHeader, live)
      const spec = resolveCompactSpec(policy, contextWindow, reserve)
      return { contextWindow, reserve, thresholdTokens: spec.thresholdTokens, retainTokens: spec.retainTokens, maxTokens: spec.maxTokens }
    })
    expect(budgets).toMatchInlineSnapshot(`
      [
        {
          "contextWindow": 32768,
          "maxTokens": 4915,
          "reserve": 8192,
          "retainTokens": 3932,
          "thresholdTokens": 19661,
        },
        {
          "contextWindow": 1048576,
          "maxTokens": 65536,
          "reserve": 196608,
          "retainTokens": 136314,
          "thresholdTokens": 786432,
        },
        {
          "contextWindow": 32768,
          "maxTokens": 5734,
          "reserve": 4096,
          "retainTokens": 4587,
          "thresholdTokens": 22938,
        },
      ]
    `)
  })

  it('keeps explicit global and model headroom exact and keeps explicit summary output independent', () => {
    const explicit = resolveTargetPolicy(resolveConfig({ headroomTokens: 65536, maxTokens: 2048 }), route)
    expect(explicit).not.toHaveProperty('headroomTokensDefaulted')
    expect(() => resolveCompactSpec(explicit, 32768, 8192)).toThrow(/headroom tokens/)
    const modelOverride = resolveTargetPolicy(resolveConfig({ modelPolicies: [{ ...route, headroomTokens: 0, maxTokens: 32 }] }), route)
    expect(resolveCompactSpec(modelOverride, 32768, 8192).maxTokens).toBe(32)
    expect(modelOverride).not.toHaveProperty('headroomTokensDefaulted')
    const explicitSummary = resolveTargetPolicy(resolveConfig({ maxTokens: 2048 }), route)
    expect(resolveCompactSpec(explicitSummary, 32768, 8192).maxTokens).toBe(2048)
    expect(resolvedHeadroomTokens(explicitSummary, 24576)).toBe(4915)
  })

  it('retains a positive default summary cap at a full-window threshold and refuses an exhausted window', () => {
    const policy = resolveTargetPolicy(resolveConfig({ thresholdRatio: 1 }), route)
    expect(resolveCompactSpec(policy, 32768, 8192).maxTokens).toBe(1)
    expect(() => resolveCompactSpec(policy, 8192, 8192)).toThrow(/leaving no message budget/)
  })
})
