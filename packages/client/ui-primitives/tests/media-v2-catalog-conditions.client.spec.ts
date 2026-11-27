import { describe, expect, it } from 'vitest'
import { parseMediaV2Catalog, parseMediaV2Record } from '../src/media-v2-types.ts'

const model = { id: 'synthetic-native', display_name: 'Synthetic media', kind: 'video', model_version: 'new-schema', enabled: true,
  parameters_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['reference', 'first-frame'] } } },
  asset_fields: ['images', 'videos', 'audios'].map(name => ({ name, media_kind: name === 'images' ? 'image' : name === 'videos' ? 'video' : 'audio',
    native_shape: 'multiple', min_items: 0, max_items: 2, mime_types: [name === 'images' ? 'image/png' : name === 'videos' ? 'video/mp4' : 'audio/wav'], constraints: {} })),
  intents: [{ id: 'reference', label: 'Reference', requires_assets: true }],
  pricing: { display: 'Synthetic quote only', credits_per_yuan: 1000, quote_required: true } }

describe('native material-condition catalog data', () => {
  it.each([true, false, undefined])('retains the optional capability without defaulting support: %s', (advertised) => {
    const parsed = parseMediaV2Catalog({ credits_per_yuan: 1000, models: [model],
      capabilities: advertised === undefined ? {} : { material_conditions_v1: advertised } })
    expect(parsed.capabilities.material_conditions_v1).toBe(advertised)
    expect('material_conditions_v1' in parsed.capabilities).toBe(advertised !== undefined)
  })

  it.each([[null], [1], ['true'], [{}], [[]]])('rejects malformed capability data: %s', (advertised) => {
    expect(() => parseMediaV2Catalog({ credits_per_yuan: 1000, models: [model],
      capabilities: { material_conditions_v1: advertised } })).toThrow('MEDIA_V2_CATALOG_INVALID')
  })

  it.each([
    { schema_version: 1, rules: [{ id: 'reference-image-count', when: { mode: ['reference'] }, asset_field: 'images',
      disallowed_counts: [1], message: 'Select explicit first-frame mode for one image' }] },
    { schema_version: 1, rules: [{ id: 'reference-audio-requires-visual', when: { mode: ['reference'] }, asset_field: 'audios',
      requires_any_assets: ['images', 'videos'], message: 'Reference audio needs a visual reference' }] },
    { schema_version: 2, rules: [{ '$future-rule': { any_of: ['images', 'videos'] } }] },
    { schema_version: 1, rules: 'unknown rule array' },
  ])('retains condition JSON for per-model evaluation without breaking an unaffected model', (conditions) => {
    const input = { credits_per_yuan: 1000, capabilities: { material_conditions_v1: true },
      models: [{ ...model, conditions }, { ...model, id: 'unaffected-model' }] }
    const before = JSON.stringify(input), parsed = parseMediaV2Catalog(input)
    expect(parsed.models[0]?.conditions).toEqual(conditions)
    expect(parsed.models[1]?.conditions).toBeUndefined()
    expect(JSON.stringify(input)).toBe(before)
  })

  it('retains an accepted original operation independently of newer model conditions and count limits', () => {
    const originalId = '02d6a836-08a6-4db8-8e08-1e562c50ee3c'
    const input = { version: 1, owner: 'original-owner', state: 'accepted', updated_at: 2,
      request: { client_operation_id: originalId, model: model.id, model_version: 'original-version', intent: 'reference',
        parameters: { mode: 'reference', count: 2 }, assets: { videos: ['first-video', 'second-video'] } },
      task: { id: 'original-task', model: model.id, kind: 'video', status: 'succeeded', is_final: true,
        artifacts: [{ key: 'original', type: 'video', mime_type: 'video/mp4', order: 0, filename: 'original.mp4' }] } }
    const before = JSON.stringify(input), parsed = parseMediaV2Record(input)
    expect(parsed.request.client_operation_id).toBe(originalId)
    expect(parsed.request.model_version).toBe('original-version')
    expect(parsed.request.parameters).toEqual({ mode: 'reference', count: 2 })
    expect(parsed.request.assets).toEqual({ videos: ['first-video', 'second-video'] })
    expect(parsed.task?.artifacts).toEqual(input.task.artifacts)
    expect(JSON.stringify(input)).toBe(before)
  })
})

it.each([true, false, undefined])('retains the separate parameter-rule capability without inventing support: %s', (advertised) => {
  const parsed = parseMediaV2Catalog({ credits_per_yuan: 1000, models: [model],
    capabilities: advertised === undefined ? {} : { parameter_conditions_v1: advertised } })
  expect(parsed.capabilities.parameter_conditions_v1).toBe(advertised)
  expect('parameter_conditions_v1' in parsed.capabilities).toBe(advertised !== undefined)
})
it.each([{ schema_version: 2, rules: [{ id: 'new-rule', parameter: 'mode', disallowed_values: ['reference'], message: 'Blocked' }] },
  { schema_version: 999, future: { '$unknown': true } }, null])('preserves separate parameter-rule data without breaking other models: %j', (parameter_conditions) => {
  const input = { credits_per_yuan: 1000, capabilities: { parameter_conditions_v1: true },
    models: [{ ...model, parameter_conditions }, { ...model, id: 'unaffected' }] }
  const before = JSON.stringify(input), parsed = parseMediaV2Catalog(input)
  expect(parsed.models[0]?.parameter_conditions).toEqual(parameter_conditions)
  expect(parsed.models[1]?.parameter_conditions).toBeUndefined()
  expect(JSON.stringify(input)).toBe(before)
})
