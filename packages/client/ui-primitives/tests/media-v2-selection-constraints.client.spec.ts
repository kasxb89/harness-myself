/** Generic R02 finite selections, independent from actual Go fixtures or supplier qualification. */
import { expect, it } from 'vitest'
import { mediaV2Choices, mediaV2Fields, mediaV2FormIssues, type MediaV2SelectedAsset } from '../src/media-v2-form.ts'
import { parseMediaV2Catalog, type MediaV2Model } from '../src/media-v2-types.ts'
import { mediaV2SelectionIssues } from '../src/media-v2-selection-constraints.ts'
const combination = (duration: number, resolution: string) => ({ parameters: {
  duration: { allowed_values: [duration] }, resolution: { allowed_values: [resolution] },
}, required_parameters: ['duration', 'resolution'] })
const selection = { schema_version: 1, combinations: [combination(30, '768P'), combination(15, '1080P')] }
const model: MediaV2Model = { id: 'finite-controls', display_name: 'Finite controls', kind: 'video', enabled: true, model_version: 'v1',
  parameters_schema: { type: 'object', properties: { duration: { type: 'integer', enum: [15, 30] },
    resolution: { type: 'string', enum: ['768P', '1080P'] } } },
  asset_fields: [], intents: [{ id: 'text', label: 'Text', requires_assets: false }],
  pricing: { display: 'Quote required', credits_per_yuan: 1000, quote_required: true } }
const candidate = () => parseMediaV2Catalog({ models: [{ ...model, selection_constraints: selection }],
  credits_per_yuan: 1000, capabilities: { selection_constraints_v1: true } }).models[0]!
it('generic finite selections: retains the separate policy and its explicit capability', () => {
  const catalog = parseMediaV2Catalog({ models: [{ ...model, selection_constraints: selection }],
    credits_per_yuan: 1000, capabilities: { selection_constraints_v1: true } })
  expect(catalog.models[0]).toHaveProperty('selection_constraints', selection)
  expect(catalog.capabilities).toHaveProperty('selection_constraints_v1', true)
})
it('generic finite selections: admits supported 30 and old 15 but rejects the unsupported cross-combination', () => {
  expect(mediaV2FormIssues(candidate(), 'text', { duration: 30, resolution: '768P' }, [], 0)).toEqual([])
  expect(mediaV2FormIssues(candidate(), 'text', { duration: 30, resolution: '1080P' }, [], 0))
    .toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
  expect(mediaV2FormIssues(candidate(), 'text', { duration: 15, resolution: '1080P' }, [], 0)).toEqual([])
})
it('generic finite selections: disables an incompatible retained choice without rewriting it', () => {
  const current = candidate(), values = { duration: 30, resolution: '1080P' }, before = JSON.stringify(values)
  const field = mediaV2Fields(current).find(item => item.name === 'duration')
  if (field === undefined) throw new Error('Expected duration control')
  expect(mediaV2Choices(field, values, current)).toEqual([
    { value: 15, label: '15', available: true }, { value: 30, label: '30', available: false },
  ])
  expect(JSON.stringify(values)).toBe(before)
})

it('generic finite selections: uses OR semantics, allows an empty branch and retains root checks', () => {
  const current = { ...candidate(), selection_constraints: { schema_version: 1,
    combinations: [combination(30, '768P'), combination(30, '768P')] } }
  expect(mediaV2FormIssues(current, 'text', { duration: 30, resolution: '768P' }, [], 0)).toEqual([])
  const optional: MediaV2Model = { ...model, selection_constraints: { schema_version: 1, combinations: [{ parameters: {} }] } }
  expect(mediaV2FormIssues(optional, 'text', {}, [], 0)).toEqual([])
  const required: MediaV2Model = { ...model, selection_constraints: { schema_version: 1,
    combinations: [{ parameters: {}, required_parameters: ['duration'] }] } }
  expect(mediaV2FormIssues(required, 'text', {}, [], 0)).toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
  expect(mediaV2FormIssues(required, 'text', { duration: 31 }, [], 0)).toContainEqual({ field: 'duration', reason: 'invalid' })
})
it('generic finite selections: compares literal types and finite native numeric ranges without coercion', () => {
  const current: MediaV2Model = { ...model, parameters_schema: { type: 'object', properties: {
    duration: { type: 'integer' }, enabled: { type: 'boolean' },
  } }, selection_constraints: { schema_version: 1, combinations: [{ parameters: {
    duration: { minimum: 15, maximum: 30, allowed_values: [15, 30] }, enabled: { allowed_values: [false] },
  } }] } }
  expect(mediaV2FormIssues(current, 'text', { duration: 30, enabled: false }, [], 0)).toEqual([])
  expect(mediaV2FormIssues(current, 'text', { duration: '30', enabled: false }, [], 0))
    .toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
  expect(mediaV2FormIssues(current, 'text', { duration: 20, enabled: true }, [], 0))
    .toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
})
it.each([undefined, false, null])('generic finite selections: disabled scalar matches only absent false or null before independent root validation: %j', (value) => {
  const current: MediaV2Model = { ...model, parameters_schema: { properties: { flag: { type: 'boolean' } } },
    selection_constraints: { schema_version: 1, combinations: [{ parameters: { flag: { disabled: true } } }] } }
  const values = value === undefined ? {} : { flag: value }
  expect(mediaV2FormIssues(current, 'text', values, [], 0).some(issue => issue.reason === 'parameterCondition')).toBe(false)
  if (value === null) expect(mediaV2FormIssues(current, 'text', values, [], 0)).toContainEqual({ field: 'flag', reason: 'invalid' })
  expect(mediaV2FormIssues(current, 'text', { flag: true }, [], 0)).toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
})
it.each([
  null, { schema_version: 999, combinations: [combination(30, '768P')] },
  { schema_version: 1, combinations: [], future: true }, { schema_version: 1, combinations: [] },
  { schema_version: 1, combinations: Array.from({ length: 129 }, () => combination(30, '768P')) },
  { schema_version: 1, combinations: [{ parameters: {}, default: 30 }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { future_operator: true } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { allowed_values: [] } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { allowed_values: [30, 30] } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { allowed_values: ['30'] } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { allowed_values: [null] } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { allowed_values: Array.from({ length: 129 }, (_, i) => i) } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { minimum: 30, maximum: 15 } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { minimum: Infinity } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { disabled: false } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { disabled: true, maximum: 30 } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { min_items: 0 } } }] },
  { schema_version: 1, combinations: [{ parameters: { resolution: { maximum: 30 } } }] },
  { schema_version: 1, combinations: [{ parameters: { undeclared: {} } }] },
  { schema_version: 1, combinations: [{ parameters: {}, required_parameters: ['undeclared'] }] },
  { schema_version: 1, combinations: [{ parameters: {}, required_parameters: null }] },
  { schema_version: 1, combinations: [{ parameters: {}, required_parameters: ['duration', 'duration'] }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { disabled: true } }, required_parameters: ['duration'] }] },
  { schema_version: 1, combinations: [combination(30, '768P'), { parameters: { duration: { oneOf: [] } } }] },
  { schema_version: 1, combinations: [{ parameters: { resolution: { allowed_values: ['字'.repeat(90000)] } } }] },
])('generic finite selections: rejects every unknown shape before considering any alternative: %j', (selection_constraints) => {
  const current: MediaV2Model = { ...model, selection_constraints }
  expect(mediaV2FormIssues(current, 'text', { duration: 30, resolution: '768P' }, [], 0))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
})
it('generic finite selections: rejects unsafe own field keys and global malformed capability without disturbing unknown model data', () => {
  const policy: unknown = JSON.parse('{"schema_version":1,"combinations":[{"parameters":{"__proto__":{}}}]}')
  const current: MediaV2Model = { ...model, selection_constraints: policy }
  expect(mediaV2FormIssues(current, 'text', {}, [], 0)).toContainEqual({ field: 'parameters', reason: 'unsupported' })
  expect(() => parseMediaV2Catalog({ models: [model], credits_per_yuan: 1000,
    capabilities: { selection_constraints_v1: 'true' } })).toThrow('MEDIA_V2_CATALOG_INVALID')
})
it('generic finite selections: leaves unknown JSON Schema oneOf blocked instead of treating it as the new OR policy', () => {
  const current: MediaV2Model = { ...candidate(), parameters_schema: { ...model.parameters_schema,
    oneOf: [{ type: 'object', properties: { duration: { const: 30 } } }] } }
  expect(mediaV2FormIssues(current, 'text', { duration: 30, resolution: '768P' }, [], 0))
    .toContainEqual({ field: 'parameters', reason: 'unsupported' })
})

const imageModel: MediaV2Model = { ...model, parameters_schema: { type: 'object', properties: {
  mode: { type: 'string', enum: ['reference', 'text-to-video'] }, images: { type: 'array' }, duration: { type: 'integer' },
} }, asset_fields: [{ name: 'images', media_kind: 'image', native_shape: 'multiple', min_items: 0, max_items: 4,
  mime_types: ['image/png'], constraints: {} }], intents: [{ id: 'text', label: 'Text', requires_assets: false },
  { id: 'reference', label: 'Reference', requires_assets: true }], selection_constraints: { schema_version: 1, combinations: [
  { parameters: { mode: { allowed_values: ['reference'] }, images: { min_items: 1, max_items: 2 } }, required_parameters: ['mode', 'images'] },
  { parameters: { mode: { allowed_values: ['text-to-video'] }, images: { disabled: true } }, required_parameters: ['mode'] },
] } }
const material = (id: string): MediaV2SelectedAsset => ({ clientId: id, model: model.id, field: 'images', name: `${id}.png`,
  state: 'ready', role: 'generation', asset: { asset_id: `ma2_${id}`, client_asset_id: id, model: model.id, state: 'ready',
    media_kind: 'image', mime_type: 'image/png', bytes: 1, sha256: 'a'.repeat(64), expires_at: 200 } })
it('generic finite selections: counts only real ready generation bindings and retains all material arrays unchanged', () => {
  const one = material('one'), two = material('two'), three = material('three'), input = [one, two, three], before = JSON.stringify(input)
  expect(mediaV2FormIssues(imageModel, 'reference', { mode: 'reference' }, [one, two], 100)).toEqual([])
  expect(mediaV2FormIssues(imageModel, 'reference', { mode: 'reference' }, input, 100))
    .toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
  expect(mediaV2FormIssues(imageModel, 'text', { mode: 'text-to-video' }, [{ ...one, role: 'writing' }], 100)).toEqual([])
  expect(mediaV2SelectionIssues(imageModel, { mode: 'reference' }, [{ ...one, role: 'writing' }], 100))
    .toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
  expect(mediaV2SelectionIssues(imageModel, { mode: 'reference' }, [one], 201))
    .toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
  expect(mediaV2SelectionIssues(imageModel, { mode: 'reference' }, [{ ...one, model: 'different' }], 100))
    .toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
  expect(mediaV2FormIssues(imageModel, 'text', { mode: 'text-to-video' }, [one], 100))
    .toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
  expect(JSON.stringify(input)).toBe(before)
})
it('generic finite selections: absent optional assets skip their predicate while required empty bindings fail', () => {
  const optional: MediaV2Model = { ...imageModel, selection_constraints: { schema_version: 1,
    combinations: [{ parameters: { images: { min_items: 1 } } }] } }
  expect(mediaV2SelectionIssues(optional, {}, [], 100)).toEqual([])
  const required: MediaV2Model = { ...optional, selection_constraints: { schema_version: 1,
    combinations: [{ parameters: {}, required_parameters: ['images'] }] } }
  expect(mediaV2SelectionIssues(required, { images: ['invented-reference'] }, [], 100))
    .toContainEqual({ field: 'parameters', reason: 'parameterCondition' })
  expect(mediaV2SelectionIssues(required, {}, [material('one')], 100)).toEqual([])
})
it('generic finite selections: uses materials in option availability but never deletes them to fit the text branch', () => {
  const field = mediaV2Fields(imageModel).find(item => item.name === 'mode'), one = material('one')
  if (field === undefined) throw new Error('Expected explicit mode control')
  expect(mediaV2Choices(field, { mode: 'reference' }, imageModel, [one], 100)).toEqual([
    { value: 'reference', label: 'reference', available: true }, { value: 'text-to-video', label: 'text-to-video', available: false },
  ])
  expect(one.role).toBe('generation')
})
it('generic finite selections: rejects asset scalar literals, invalid item bounds and oversized native field sets', () => {
  for (const rule of [{ allowed_values: ['private-image-id'] }, { min_items: -1 }, { max_items: 1.5 }, { min_items: 3, max_items: 2 }]) {
    const current: MediaV2Model = { ...imageModel, selection_constraints: { schema_version: 1,
      combinations: [{ parameters: { images: rule } }] } }
    expect(mediaV2SelectionIssues(current, {}, [], 100)).toContainEqual({ field: 'parameters', reason: 'unsupported' })
  }
  const fields = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, { type: 'string' }]))
  const current: MediaV2Model = { ...model, parameters_schema: { properties: fields }, selection_constraints: { schema_version: 1,
    combinations: [{ parameters: Object.fromEntries(Object.keys(fields).map(name => [name, {}])) }] } }
  expect(mediaV2SelectionIssues(current, {}, [], 100)).toContainEqual({ field: 'parameters', reason: 'unsupported' })
})
