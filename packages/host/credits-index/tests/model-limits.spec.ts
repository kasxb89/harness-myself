import { describe, expect, it } from 'vitest'
import { effectiveTextCapability, textCapabilityImageAvailable } from '@deepseek-ai/dsh-llm'
import { mergeProductModelLimits, productModelLimitsScope, readProductModelLimits } from '../src/model-limits.ts'
import { readModelConfigVersion } from '../src/model-config-version.ts'

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
      .toEqual({ scope: 'account-a', authoritative: true, contextWindow: 1_048_576, maxTokens: 384_000 })
    expect(mergeProductModelLimits(previous, { contextWindow: 16384, maxTokens: 2048 }, 'account-a'))
      .toEqual({ scope: 'account-a', authoritative: true, contextWindow: 16384, maxTokens: 2048 })
    expect(mergeProductModelLimits(previous, { maxTokens: 8192 }, 'account-a'))
      .toEqual({ scope: 'account-a', authoritative: true, contextWindow: 32768, maxTokens: 8192 })
    expect(mergeProductModelLimits(previous, undefined, 'account-a')).toEqual({ ...previous, authoritative: true })
    expect(mergeProductModelLimits({ ...previous, authoritative: true }, {}, 'account-a'))
      .toEqual({ ...previous, authoritative: true })
  })

  it('never adopts the previous backend or account capacities', () => {
    const first = productModelLimitsScope('https://gateway.example/harness', '7')
    expect(first).toMatch(/^[a-f\d]{64}$/u)
    expect(productModelLimitsScope('https://gateway.example/harness', '7')).toBe(first)
    expect(productModelLimitsScope('https://gateway.example/other', '7')).not.toBe(first)
    expect(productModelLimitsScope('https://gateway.example/harness', '8')).not.toBe(first)
    expect(mergeProductModelLimits({ scope: first, authoritative: true, contextWindow: 32768, maxTokens: 4096 }, {}, 'another'))
      .toBeUndefined()
    expect(mergeProductModelLimits(null, { maxTokens: 2048 }, first)).toEqual({ scope: first, authoritative: true, maxTokens: 2048 })
    expect(mergeProductModelLimits({ scope: first, authoritative: true }, {}, 'another')).toBeUndefined()
    expect(mergeProductModelLimits([], undefined, first)).toBeUndefined()
  })
})

describe('versioned complete text capacities', () => {
  const first = readModelConfigVersion({ model_config_version: 'a'.repeat(64) })!
  const second = readModelConfigVersion({ model_config_version: 'b'.repeat(64) })!
  const previous = { scope: 'same-account', authoritative: true, modelConfigVersion: first,
    contextWindow: 131072, maxTokens: 32768 }

  it('captures one version with its complete explicit capacity pair', () => {
    expect(readProductModelLimits({ model_config_version: first, context_window: 32768, max_output_tokens: 8192 }))
      .toEqual({ modelConfigVersion: first, contextWindow: 32768, maxTokens: 8192 })
  })

  it.each([{}, { context_window: 32768 }, { max_output_tokens: 8192 },
    { context_window: 8192, max_output_tokens: 16384 }, { context_window: '32768', max_output_tokens: 8192 },
    { context_window: 32768, max_output_tokens: 0 }, { context_window: 2_147_483_648, max_output_tokens: 8192 }])(
    'rejects a versioned row without a complete valid pair %#', (fields) => {
      expect(() => readProductModelLimits({ model_config_version: first, ...fields })).toThrow(/complete valid pair/u)
    },
  )

  it('atomically replaces both capacities with their new version instead of borrowing an old field', () => {
    expect(mergeProductModelLimits(previous,
      { modelConfigVersion: second, contextWindow: 8192, maxTokens: 2048 }, previous.scope))
      .toEqual({ scope: previous.scope, authoritative: true, modelConfigVersion: second, contextWindow: 8192, maxTokens: 2048 })
    expect(() => mergeProductModelLimits(previous, { modelConfigVersion: second, contextWindow: 8192 }, previous.scope))
      .toThrow(/complete valid pair/u)
    expect(() => mergeProductModelLimits(previous, { modelConfigVersion: second, maxTokens: 2048 }, previous.scope))
      .toThrow(/complete valid pair/u)
  })

  it('retains a complete version only for a pending read by the same account', () => {
    expect(mergeProductModelLimits(previous, undefined, previous.scope)).toEqual(previous)
    expect(mergeProductModelLimits(previous, undefined, 'different-account')).toBeUndefined()
    expect(() => mergeProductModelLimits({ ...previous, maxTokens: 262144 }, undefined, previous.scope))
      .toThrow(/complete valid pair/u)
  })

  it('clears an omitted version after a successful legacy listing without changing legacy field retention', () => {
    expect(mergeProductModelLimits(previous, {}, previous.scope)).toEqual({ scope: previous.scope,
      authoritative: true, contextWindow: 131072, maxTokens: 32768 })
    expect(mergeProductModelLimits(previous, { maxTokens: 4096 }, previous.scope)).toEqual({ scope: previous.scope,
      authoritative: true, contextWindow: 131072, maxTokens: 4096 })
    expect(mergeProductModelLimits(previous, { contextWindow: 32768, maxTokens: 8192 }, 'different-account'))
      .toEqual({ scope: 'different-account', authoritative: true, contextWindow: 32768, maxTokens: 8192 })
  })
})


describe('explicit gateway text execution declarations', () => {
  const wire = { tools: false, vision: false, reasoning: false, stream: true, max_input_tokens: 32000 }
  const expected = { tools: false, vision: false, reasoning: false, stream: true, maxInputTokens: 32000 }
  it('maps complete snake-case declarations without confusing the native window and input ceiling', () => {
    expect(readProductModelLimits({ context_window: 1000000, max_output_tokens: 8192,
      parameters: { 'x-text-capabilities': wire } }))
      .toEqual({ contextWindow: 1000000, maxTokens: 8192, textCapabilities: expected })
  })
  it.each([null, [], {}, { ...wire, tools: 'false' }, { ...wire, max_input_tokens: 0 },
    { ...wire, max_input_tokens: '32000' }, { ...wire, max_input_tokens: 1.5 }])('refuses an incomplete or malformed declaration %#', (declaration) => {
    expect(() => readProductModelLimits({ parameters: { 'x-text-capabilities': declaration } })).toThrow(/text execution declaration/)
  })
  it('retains current metadata while a listing is pending, clears an explicitly omitted declaration, and rejects account transfer', () => {
    const previous = { scope: 'a', authoritative: true, contextWindow: 1000000, maxTokens: 8192, textCapabilities: expected }
    expect(mergeProductModelLimits(previous, undefined, 'a')).toEqual(previous)
    expect(mergeProductModelLimits(previous, {}, 'a')).toEqual({ scope: 'a', authoritative: true, contextWindow: 1000000, maxTokens: 8192 })
    expect(mergeProductModelLimits(previous, {}, 'b')).toBeUndefined()
    expect(mergeProductModelLimits({ scope: 'a', textCapabilities: expected }, {}, 'a')).toBeUndefined()
    expect(readProductModelLimits({ parameters: {} })).toEqual({})
    expect(readProductModelLimits({ parameters: null })).toEqual({})
    expect(readProductModelLimits({ parameters: 'legacy metadata' })).toEqual({})
  })
})


describe('version2 fixed-route capability facts', () => {
  const wire = { schema_version: 2, revision: 'fixture-v2', checked_at: '2026-10-31T00:00:00Z', tools: true, vision: true,
    reasoning: true, stream: true, max_input_tokens: 32000,
    verification: { tools: 'supported', vision: 'supported', reasoning: 'supported' }, input_modalities: ['text', 'image'],
    tools_config: { protocol: 'openai-chat', roundtrip_verified: true, verified_tool_choices: ['auto'], parallel_calls: 'unverified' },
    vision_config: { verified_transports: ['data_url'], verified_mime_types: ['image/png'], billing: 'input_tokens' },
    reasoning_mode: 'configurable', reasoning_controls: { type: 'object', properties: { enable_thinking: { type: 'boolean', default: false } }, additionalProperties: false },
    reasoning_omit_behavior: 'provider_default', operational_status: 'available' }
  const read = (value: unknown) => readProductModelLimits({ parameters: { 'x-text-capabilities': value } })
  it('replaces legacy all-false with explicit facts, image input and exact controls', () => {
    const incoming = read(wire)
    const old = { scope: 'same', textCapabilities: { tools: false, vision: false, reasoning: false, stream: true, maxInputTokens: 32000 } }
    const result = mergeProductModelLimits(old, incoming, 'same')
    expect(result?.textCapabilities).toMatchObject({ schemaVersion: 2, revision: 'fixture-v2', inputModalities: ['text', 'image'],
      reasoningControls: { properties: { enable_thinking: { type: 'boolean', default: false } } } })
    expect(effectiveTextCapability(result?.textCapabilities, 'tools')).toBe(true)
    expect(mergeProductModelLimits(result, undefined, 'same')).toEqual(result)
    expect(mergeProductModelLimits(result, undefined, 'other')).toBeUndefined()
    expect(mergeProductModelLimits(result, {}, 'same')).toBeUndefined()
  })
  it('keeps unverified separate from unsupported and detaches nested schemas', () => {
    const input = structuredClone(wire)
    input.tools = false; input.verification.tools = 'unverified'
    const incoming = read(input)
    expect(effectiveTextCapability(incoming.textCapabilities, 'tools')).toBeUndefined()
    input.reasoning_controls.properties.enable_thinking.default = true
    input.vision_config.verified_mime_types.push('image/jpeg')
    expect(incoming.textCapabilities?.visionConfig?.verifiedMimeTypes).toEqual(['image/png'])
    expect(incoming.textCapabilities?.reasoningControls?.properties.enable_thinking?.default).toBe(false)
    expect(effectiveTextCapability(read({ ...wire, tools: false, verification: { ...wire.verification, tools: 'unsupported' } }).textCapabilities, 'tools')).toBe(false)
  })
  it('retains localized image outages and gateway-only reasoning mappings on pending reads', () => {
    const incoming = read({ ...wire, vision: false, input_modalities: ['text'],
      verification: { ...wire.verification, vision: 'unverified' },
      vision_config: { ...wire.vision_config, operational_status: 'temporarily_unavailable', operational_reason: 'Image input is temporarily unavailable.' },
      reasoning_control_mapping: { enable_thinking_with_effort: true, omit_effort_on_none: true } })
    const value = incoming.textCapabilities
    expect(value).toMatchObject({ operationalStatus: 'available', vision: false, verification: { vision: 'unverified' },
      visionConfig: { operationalStatus: 'temporarily_unavailable', operationalReason: 'Image input is temporarily unavailable.' },
      reasoningControlMapping: { enableThinkingWithEffort: true, omitEffortOnNone: true } })
    expect(effectiveTextCapability(value, 'vision')).toBeUndefined()
    expect(effectiveTextCapability(value, 'tools')).toBe(true)
    expect(textCapabilityImageAvailable(value)).toBe(false)
    const saved = mergeProductModelLimits(undefined, incoming, 'same')
    expect(mergeProductModelLimits(saved, undefined, 'same')).toEqual(saved)
    saved!.textCapabilities!.reasoningControlMapping!.omitEffortOnNone = false
    expect(value?.reasoningControlMapping?.omitEffortOnNone).toBe(true)
  })
  it('retains an explicitly empty reasoning mapping without inventing companion fields', () => {
    const incoming = read({ ...wire, reasoning_control_mapping: {} })
    expect(incoming.textCapabilities?.reasoningControlMapping).toEqual({})
    const saved = mergeProductModelLimits(undefined, incoming, 'same')
    expect(mergeProductModelLimits(saved, undefined, 'same')).toEqual(saved)
  })
  it.each([
    { reasoning_control_mapping: { enable_thinking_with_effort: false, omit_effort_on_none: true } },
    { reasoning_control_mapping: { enable_thinking_with_effort: true } },
    { reasoning_control_mapping: { enable_thinking_with_effort: true, omit_effort_on_none: false, model: 'override' } },
    { vision_config: { ...wire.vision_config, operational_status: 'unsupported' } },
    { vision_config: { ...wire.vision_config, operational_reason: 123 } },
  ])('rejects malformed localized outage or native mapping $reasoning_control_mapping', (delta) => {
    expect(() => read({ ...wire, ...delta })).toThrow(/version2/)
  })
  it('rejects controls that could overwrite reserved request fields', () => {
    expect(() => read({ ...wire, reasoning_controls: { type: 'object', properties: { model: { type: 'string', enum: ['evil'] } }, additionalProperties: false } })).toThrow(/version2/)
    expect(() => read({ ...wire, verification: { tools: 'unverified' } })).toThrow(/version2/)
    expect(() => read({ ...wire, reasoning_omit_behavior: 'always_off' })).toThrow(/version2/)
  })
})
