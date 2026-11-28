/** Generic wire regressions; actual Go configuration fixtures are consumed separately when handed back. */
import { expect, it } from 'vitest'
import { mediaV2FormIssues } from '../src/media-v2-form.ts'
import { parseMediaV2Catalog } from '../src/media-v2-types.ts'

const revision = 'b'.repeat(64)
const row = { id: 'c'.repeat(64), parameters: { mode: 'text-to-video', duration: '30', count: 1,
  aspect_ratio: '16:9', resolution: '720p' }, billing_unit: 'per_video', quantity: 1,
unit_price_cny: '1.2852', total_cny: '1.2852', quote_required: true, policy_revision: revision }
const model = { id: 'generic-priced-video', display_name: 'Generic priced video', kind: 'video', model_version: 'generic-v1', enabled: true,
  parameters_schema: { type: 'object', properties: {
    mode: { type: 'string', enum: ['text-to-video'], default: 'text-to-video' }, duration: { type: 'string', enum: ['15', '30'] },
    count: { type: 'integer', minimum: 1, maximum: 1, default: 1 }, aspect_ratio: { type: 'string', enum: ['16:9'] },
    resolution: { type: 'string', enum: ['720p'] },
  } }, asset_fields: [], intents: [{ id: 'text', label: 'Text', requires_assets: false }],
  pricing: { display: 'Backend indicative video price', credits_per_yuan: 1250, quote_required: true,
    currency: 'CNY', policy_revision: revision, specification_rows: [row] } }
const catalog = (pricing: unknown = model.pricing) => parseMediaV2Catalog({ models: [{ ...model, pricing }], credits_per_yuan: 1000,
  capabilities: { exact_specification_pricing_v1: true, explicit_requote_v1: true } })

it('generic exact pricing: retains authoritative unit rows and both explicit capabilities without replacing model credit scale', () => {
  const parsed = catalog()
  expect(parsed.models[0]?.pricing).toEqual(model.pricing)
  expect(parsed.capabilities).toMatchObject({ exact_specification_pricing_v1: true, explicit_requote_v1: true })
})
it('generic exact pricing: isolates malformed unit metadata to the affected new quote instead of dropping it', () => {
  const parsed = catalog({ ...model.pricing, currency: 'USD' }), candidate = parsed.models[0]
  if (candidate === undefined) throw new Error('Malformed price metadata must retain the model')
  expect(mediaV2FormIssues(candidate, 'text', row.parameters, [], 0)).toContainEqual({ field: 'parameters', reason: 'unsupported' })
})

it('generic exact pricing: accepts absent legacy metadata and optional rows without manufacturing a price', () => {
  const legacy = { display: 'Legacy', credits_per_yuan: 1250, quote_required: true }
  const first = catalog(legacy).models[0], second = catalog({ ...legacy, currency: 'CNY', policy_revision: revision }).models[0]
  if (first === undefined || second === undefined) throw new Error('Expected retained models')
  expect(mediaV2FormIssues(first, 'text', row.parameters, [], 0)).toEqual([])
  expect(mediaV2FormIssues(second, 'text', row.parameters, [], 0)).toEqual([])
  expect(second.pricing).not.toHaveProperty('specification_rows')
})
it.each([
  { currency: 'USD' }, { policy_revision: 'A'.repeat(64) }, { specification_rows: null },
  { specification_rows: [{ ...row, billing_unit: 'per_token' }] },
  { specification_rows: [{ ...row, policy_revision: 'a'.repeat(64) }] },
  { specification_rows: [{ ...row, unit_price_cny: '-1' }] },
  { specification_rows: [{ ...row, total_cny: '1e3' }] },
  { specification_rows: [{ ...row, total_cny: '9'.repeat(65) }] },
  { specification_rows: [{ ...row, quantity: 0 }] },
  { specification_rows: [{ ...row, quantity: 30 }] },
  { specification_rows: [{ ...row, parameters: { prompt: 'private text' } }] },
  { specification_rows: [{ ...row, parameters: { duration: null } }] },
  { specification_rows: [{ ...row, parameters: { duration: ['30'] } }] },
  { specification_rows: [{ ...row, parameters: { mode: 'text\n-to-video' } }] },
  { specification_rows: [{ ...row, future_rule: true }] },
  { specification_rows: [row, row] },
])('generic exact pricing: preserves invalid metadata but blocks only its new quote: %j', (changed) => {
  const candidate = catalog({ ...model.pricing, ...changed }).models[0]
  if (candidate === undefined) throw new Error('Unknown price metadata must retain the model')
  expect(mediaV2FormIssues(candidate, 'text', row.parameters, [], 0)).toContainEqual({ field: 'parameters', reason: 'unsupported' })
})
it.each(['exact_specification_pricing_v1', 'explicit_requote_v1'])('generic exact pricing: rejects malformed capability %s', (name) => {
  expect(() => parseMediaV2Catalog({ models: [model], credits_per_yuan: 1000, capabilities: { [name]: 'true' } }))
    .toThrow('MEDIA_V2_CATALOG_INVALID')
})
