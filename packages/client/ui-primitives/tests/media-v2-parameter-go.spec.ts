/** Cross-check actual Go factory/validator output without starting any service or supplier request. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { mediaV2ParameterIssues } from '../src/media-v2-parameter-conditions.ts'
import { isMediaV2Value, mediaV2Object } from '../src/media-v2-types.ts'
import type { MediaV2Model, MediaV2Value } from '../src/media-v2-types.ts'

const model: MediaV2Model = { id: 'neutral-policy-consumer', display_name: 'Neutral policy consumer', kind: 'image', model_version: 'v1',
  enabled: true, parameters_schema: { properties: {} }, asset_fields: [],
  intents: [{ id: 'text', label: 'Text', requires_assets: false }], pricing: { display: '', quote_required: true, credits_per_yuan: 1000 } }
function fixture(name: string): { readonly bytes: Buffer; readonly data: Record<string, unknown> } {
  const bytes = readFileSync(new URL(`./fixtures/media-v2-reviewed-parameters/${name}`, import.meta.url))
  const value: unknown = JSON.parse(bytes.toString('utf8')), data = mediaV2Object(value)
  if (data === null) throw new Error('Expected actual Go evidence')
  return { bytes, data }
}
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Expected actual Go cases')
  const entries: readonly unknown[] = value
  return entries.map((entry) => {
    const row = mediaV2Object(entry)
    if (row === null) throw new Error('Expected actual Go case fields')
    return row
  })
}
function parameters(value: unknown): Record<string, MediaV2Value> {
  const row = mediaV2Object(value)
  if (row === null) throw new Error('Expected actual Go parameters')
  const result: Record<string, MediaV2Value> = {}
  for (const [name, entry] of Object.entries(row)) {
    if (!isMediaV2Value(entry)) throw new Error('Expected canonical actual Go JSON parameters')
    result[name] = entry
  }
  return result
}
const mj = fixture('actual-go-mj-conditions.json'), boundaries = fixture('actual-go-parameter-boundaries.json')

it('retains byte-exact actual Go evidence with zero supplier/HTTP/paid qualification', () => {
  expect(mj.data).toMatchObject({ synthetic: true, supplier_requests: 0, paid: 0, case_count: 69 })
  expect(boundaries.data).toMatchObject({ synthetic: true, http_requests: 0, paid: 0 })
  expect(createHash('sha256').update(mj.bytes).digest('hex')).toBe('8537567e7a770c6fe44407be8df993f9350b17f135e86a263d1dc3cb63073ea1')
  expect(createHash('sha256').update(boundaries.bytes).digest('hex')).toBe('f75be9a073d2a461c64ae61a08df09489cd8bab8145ad4da1802efdc033029b5')
})
it.each(rows(mj.data.cases))('matches the actual Go reviewed parameter result without rewriting: $name', (entry) => {
  const values = parameters(entry.params), before = JSON.stringify(values)
  const issues = mediaV2ParameterIssues({ ...model, parameter_conditions: mj.data.parameter_conditions }, values)
  expect(issues.length === 0).toBe(entry.want_valid)
  expect(JSON.stringify(values)).toBe(before)
})
it.each(rows(boundaries.data.policy_cases))('matches complete-policy actual Go boundary semantics: $name', (entry) => {
  const values = parameters(entry.params), before = JSON.stringify(values)
  expect(mediaV2ParameterIssues({ ...model, parameter_conditions: entry.conditions }, values).length === 0).toBe(entry.valid)
  expect(JSON.stringify(values)).toBe(before)
})
it.each(rows(boundaries.data.lexer_cases))('matches the fixed Go Unicode/token lexer without coercion: $name', (entry) => {
  if (typeof entry.text !== 'string') throw new Error('Expected actual Go text')
  const values = { prompt: entry.text }, before = JSON.stringify(values)
  const parameter_conditions = { schema_version: 2, rules: [{ id: 'actual-go-lexer', parameter: 'prompt',
    text_flags: entry.text_flags, message: 'Actual Go fixed lexer' }] }
  expect(mediaV2ParameterIssues({ ...model, parameter_conditions }, values).length === 0).toBe(entry.valid)
  expect(JSON.stringify(values)).toBe(before)
})
