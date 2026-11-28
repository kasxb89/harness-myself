/** Preference projection follows declared controls, never indicative prices or legacy model tables. */
import { expect, it } from 'vitest'
import type { ImageParams, VideoParams } from '../src/media.ts'
import type { MediaV2Model, MediaV2Value } from '../src/media-v2-protocol.ts'
import { nativeMediaPreferencePrices, projectNativeMediaPreferences } from '../src/media-native-preferences.ts'
import { validateMediaPreference } from '../src/media-preferences.ts'

function nativeModel(): MediaV2Model {
  return { id: 'neutral-native-42', display_name: 'Native exact controls', kind: 'video', model_version: 'native-v-next',
    enabled: true, pricing: { display: 'Read the original quote', credits_per_yuan: 1250, quote_required: true },
    intents: [{ id: 'text', label: 'Text', requires_assets: false }], asset_fields: [],
    parameters_schema: { type: 'object', additionalProperties: false,
      required: ['prompt', 'mode', 'duration', 'resolution', 'aspect_ratio', 'count'], properties: {
        prompt: { type: 'string', maxLength: 4000 }, mode: { type: 'string', enum: ['text-to-video'] },
        duration: { type: 'string', enum: ['15', '30'], default: '30' },
        resolution: { type: 'string', enum: ['720p'] }, aspect_ratio: { type: 'string', enum: ['16:9'] },
        quality: { type: 'string', enum: ['standard'] }, count: { type: 'integer', const: 1 },
      } } }
}

it('projects declared complete scalar choices with exact native identity and no legacy route', () => {
  const input = nativeModel(), before = structuredClone(input)
  const model = projectNativeMediaPreferences(input)
  expect(model).toMatchObject({ id: input.id, displayName: input.display_name, execution: 'media-v2',
    nativeModelVersion: 'native-v-next', route: '', kind: 'video' })
  expect(model).not.toHaveProperty('modelConfigVersion')
  expect(model?.params).toMatchObject({ specifications: [
    { mode: 'text-to-video', seconds: 15, resolution: '720p', ratio: '16:9', quality: 'standard' },
    { mode: 'text-to-video', seconds: 30, resolution: '720p', ratio: '16:9', quality: 'standard' },
  ], durations: [15, 30], defaultDuration: 30, resolutions: ['720p'], ratios: ['16:9'], qualities: ['standard'],
  maxFrameImages: 0, maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0, frameSlots: 0,
  audioOutput: 'unknown', audioToggle: false, seed: false, watermark: false })
  if (model === undefined) throw new Error('Expected the finite native preference view')
  expect(() => {
    validateMediaPreference('video', { model: input.id, parameters: {
      seconds: 30, resolution: '720p', ratio: '16:9', mode: 'text-to-video', quality: 'standard',
    } }, [model])
  }).not.toThrow()
  expect(input).toEqual(before)
})

it('maps image aspect ratios to the existing size preference without inventing editing support', () => {
  const input = nativeModel()
  input.kind = 'image'
  input.parameters_schema = { type: 'object', required: ['prompt'], properties: {
    prompt: { type: 'string' }, aspect_ratio: { type: 'string', enum: ['1:1', '16:9'] },
    resolution: { type: 'string', enum: ['1k'] }, count: { type: 'integer', enum: [1, 4] },
  } }
  const projected = projectNativeMediaPreferences(input)
  expect(projected?.params).toMatchObject({ sizes: ['1:1', '16:9'], resolutions: ['1k'], maxEdits: 0,
    maxCount: 1, strictReferences: true, specifications: [
      { size: '1:1', resolution: '1k' }, { size: '16:9', resolution: '1k' },
    ] })
  expect((projected?.params as ImageParams | undefined)?.editSpecifications).toBeUndefined()
})

it('does not derive choices or permission from a tempting indicative price row', () => {
  const input = nativeModel()
  input.pricing.specification_rows = [{ id: 'a'.repeat(64), parameters: { duration: '120', resolution: '8k' },
    billing_unit: 'per_video', quantity: 1, unit_price_cny: '0.01', total_cny: '0.01', quote_required: true,
    policy_revision: 'b'.repeat(64) }]
  expect((projectNativeMediaPreferences(input)?.params as VideoParams | undefined)?.durations).toEqual([15, 30])
  expect((projectNativeMediaPreferences(input)?.params as VideoParams | undefined)?.resolutions).toEqual(['720p'])
})

it('keeps declared optional materials out of scalar preferences and legacy reference permissions', () => {
  const input = nativeModel()
  input.asset_fields = [{ name: 'subject_images', media_kind: 'image', native_shape: 'multiple', min_items: 0,
    max_items: 3, mime_types: ['image/png'], constraints: {} }]
  const properties = input.parameters_schema.properties as Record<string, unknown>
  properties.subject_images = { type: 'array', items: { type: 'string' }, maxItems: 3 }
  const projected = projectNativeMediaPreferences(input)
  expect((projected?.params as VideoParams | undefined)?.maxReferenceImages).toBe(0)
  expect(JSON.stringify(projected?.params)).not.toContain('subject_images')
})

it.each([
  { duration: { type: 'string', enum: ['30.5'] } },
  { duration: { type: 'string', pattern: '^\\d+$' } },
  { duration: { type: 'number', enum: [30] } },
  { duration: { type: 'string', enum: ['30', '030'] } },
  { resolution: { type: 'string' } },
])('omits a scalar surface that cannot be represented exactly: %j', (changed) => {
  const input = nativeModel()
  input.parameters_schema.properties = { ...(input.parameters_schema.properties as object), ...changed }
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
})

it.each(['allOf', 'anyOf', 'if', 'dependentSchemas', '$ref'])('omits unimplemented root grammar %s', (keyword) => {
  const input = nativeModel()
  input.parameters_schema[keyword] = []
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
})

it('omits unknown required nested controls and reference-only models', () => {
  const input = nativeModel()
  input.parameters_schema.required = [...input.parameters_schema.required as string[], 'advanced']
  input.parameters_schema.properties = { ...(input.parameters_schema.properties as object), advanced: { type: 'object' } }
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
  const reference = nativeModel()
  reference.intents = [{ id: 'reference', label: 'Reference', requires_assets: true }]
  expect(projectNativeMediaPreferences(reference)).toBeUndefined()
})

it('does not publish disabled models or speech as image/video scalar defaults', () => {
  const input = nativeModel()
  input.enabled = false
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
  input.enabled = true; input.kind = 'audio'
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
})

it('does not replace an invalid declared duration default with an invented preference', () => {
  const input = nativeModel()
  input.parameters_schema.properties = { ...(input.parameters_schema.properties as object),
    duration: { type: 'string', enum: ['15', '30'], default: '5' } }
  const model = projectNativeMediaPreferences(input)
  expect(model).toBeDefined()
  expect((model?.params as VideoParams | undefined)?.defaultDuration).toBeUndefined()
})

function constrainedModel(): MediaV2Model {
  const input = nativeModel()
  input.parameters_schema.properties = { ...(input.parameters_schema.properties as object),
    resolution: { type: 'string', enum: ['768p', '1080p'] } }
  input.parameters_schema['x-model-kind'] = 'video'
  input.parameters_schema['x-media-assets'] = []
  input.selection_constraints = { schema_version: 1, combinations: [
    { parameters: { duration: { allowed_values: ['30'] }, resolution: { allowed_values: ['768p'] } },
      required_parameters: ['duration', 'resolution'] },
    { parameters: { duration: { allowed_values: ['15'] }, resolution: { allowed_values: ['1080p'] } } },
  ] }
  return input
}

it('intersects formal OR combinations before publishing exact duration and resolution choices', () => {
  const model = projectNativeMediaPreferences(constrainedModel())
  expect(model?.params).toMatchObject({ specifications: [
    { seconds: 30, resolution: '768p' }, { seconds: 15, resolution: '1080p' },
  ], durationByResolution: { '768p': [30], '1080p': [15] } })
  if (model === undefined) throw new Error('Expected formal scalar combinations')
  expect(() => {
    validateMediaPreference('video', { model: model.id, parameters: { seconds: 30, resolution: '1080p' } }, [model])
  }).toThrow('所选模型参数不合法')
})

it('uses OR union when valid combinations overlap, including empty predicates and root-declared required fields', () => {
  const input = constrainedModel()
  input.selection_constraints = { schema_version: 1, combinations: [
    { parameters: {} }, { parameters: { duration: {} }, required_parameters: ['resolution'] },
  ] }
  expect((projectNativeMediaPreferences(input)?.params as VideoParams | undefined)?.specifications).toHaveLength(4)
})

it('projects absence for an optional disabled scalar without dropping unrelated declared choices', () => {
  const input = constrainedModel()
  input.selection_constraints = { schema_version: 1, combinations: [{ parameters: { quality: { disabled: true } } }] }
  const projected = projectNativeMediaPreferences(input)
  expect((projected?.params as VideoParams | undefined)?.specifications).toHaveLength(4)
  expect((projected?.params as VideoParams | undefined)?.qualities).toEqual([])
})

it('keeps zero generation bindings absent for required and optional material predicates', () => {
  const input = constrainedModel()
  input.asset_fields = [{ name: 'images', media_kind: 'image', native_shape: 'multiple', min_items: 0,
    max_items: 3, mime_types: ['image/png'], constraints: {} }]
  input.parameters_schema['x-media-assets'] = [{ name: 'images' }]
  input.parameters_schema.properties = { ...(input.parameters_schema.properties as object),
    images: { type: 'array', items: { type: 'string' } } }
  input.selection_constraints = { schema_version: 1, combinations: [
    { parameters: { duration: { allowed_values: ['30'] }, images: { min_items: 1 } }, required_parameters: ['images'] },
    { parameters: { duration: { allowed_values: ['15'] }, images: { disabled: true } } },
  ] }
  const projected = projectNativeMediaPreferences(input)
  expect((projected?.params as VideoParams | undefined)?.durations).toEqual([15])
  expect((projected?.params as VideoParams | undefined)?.maxReferenceImages).toBe(0)
  input.selection_constraints = { schema_version: 1, combinations: [
    { parameters: { images: { min_items: 1 } } },
  ] }
  expect(projectNativeMediaPreferences(input)).toBeDefined()
})

it.each([
  { schema_version: 2, combinations: [{ parameters: {} }] },
  { schema_version: 1, combinations: [] },
  { schema_version: 1, combinations: [{ parameters: {}, required_parameters: null }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { allowed_values: [30] } } }] },
  { schema_version: 1, combinations: [{ parameters: { absent: {} } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { disabled: false } } }] },
  { schema_version: 1, combinations: [{ parameters: { duration: { disabled: true, allowed_values: ['30'] } } }] },
  { schema_version: 1, combinations: [{ parameters: { resolution: { min_items: 1 } } }] },
  { schema_version: 1, combinations: [{ parameters: { count: { minimum: 2, maximum: 1 } } }] },
  { schema_version: 1, combinations: [{ parameters: {}, required_parameters: ['not_declared'] }] },
  { schema_version: 1, combinations: [{ parameters: { resolution: { disabled: true } }, required_parameters: ['resolution'] }] },
  { schema_version: 1, combinations: [{ parameters: { resolution: { allowed_values: ['768p', '768p'] } } }] },
])('rejects an entire malformed formal policy rather than falling through to the flat menu: %j', (policy) => {
  const input = constrainedModel()
  input.selection_constraints = policy
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
})

it('compiles every OR combination before using a matching one and respects encoded and collection bounds', () => {
  const input = constrainedModel()
  input.selection_constraints = { schema_version: 1, combinations: [
    { parameters: {} }, { parameters: { duration: { unknown: true } } },
  ] }
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
  input.selection_constraints = { schema_version: 1,
    combinations: Array.from({ length: 129 }, () => ({ parameters: {} })) }
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
  input.selection_constraints = { schema_version: 1, combinations: [
    { parameters: { duration: { allowed_values: ['x'.repeat(262144)] } } },
  ] }
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
})

it('keeps unreviewed root oneOf unsupported even when native annotations are recognized', () => {
  const input = nativeModel()
  input.parameters_schema.oneOf = [{ type: 'object', properties: { duration: { const: '30' } } }]
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
})

it('retains a valid flat native model with matching annotations and no optional selection policy', () => {
  const input = constrainedModel()
  delete input.selection_constraints
  expect((projectNativeMediaPreferences(input)?.params as VideoParams | undefined)?.specifications).toHaveLength(4)
})

it.each(['kind', 'unknown-asset', 'asset-shape'] as const)('rejects mismatched flat native annotation %s', (changed) => {
  const input = constrainedModel()
  delete input.selection_constraints
  if (changed === 'kind') input.parameters_schema['x-model-kind'] = 'image'
  else {
    input.asset_fields = [{ name: 'images', media_kind: 'image', native_shape: 'multiple', min_items: 0,
      max_items: 3, mime_types: ['image/png'], constraints: {} }]
    input.parameters_schema.properties = { ...(input.parameters_schema.properties as object),
      images: { type: 'array', items: { type: 'string' } } }
    input.parameters_schema['x-media-assets'] = [{ name: changed === 'unknown-asset' ? 'unavailable' : 'images',
      shape: changed === 'asset-shape' ? 'single' : 'multiple' }]
  }
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
})

it('retains all representable older scalar choices under the explicit8192 preference-only bound', () => {
  const input = nativeModel()
  input.parameters_schema.properties = { ...(input.parameters_schema.properties as object),
    duration: { type: 'string', enum: Array.from({ length: 60 }, (_, index) => String(index + 1)) },
    resolution: { type: 'string', enum: Array.from({ length: 20 }, (_, index) => `tier${String(index)}`) },
    aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] } }
  expect((projectNativeMediaPreferences(input)?.params as VideoParams | undefined)?.specifications).toHaveLength(7200)
  input.parameters_schema.properties = { ...(input.parameters_schema.properties as object),
    duration: { type: 'string', enum: Array.from({ length: 70 }, (_, index) => String(index + 1)) } }
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
})

it('filters existing native option dependencies without creating legacy reference permissions', () => {
  const input = nativeModel()
  input.parameters_schema.properties = { ...(input.parameters_schema.properties as object),
    mode: { type: 'string', enum: ['text-to-video', 'reference'] },
    quality: { type: 'string', enum: ['standard', 'flash'] },
    resolution: { type: 'string', enum: ['720p', '1080p'], 'x-ycapi-contract': {
      enum_values_by_quality: { standard: ['720p', '1080p'], flash: ['720p'] },
    } },
    aspect_ratio: { type: 'string', enum: ['16:9'], 'x-ycapi-contract': { available_when: { mode: ['text-to-video'] } } },
  }
  const projected = projectNativeMediaPreferences(input), specifications = (projected?.params as VideoParams | undefined)?.specifications
  expect(specifications).toBeDefined()
  expect(specifications?.some(row => row.quality === 'flash' && row.resolution === '1080p')).toBe(false)
  expect(specifications?.some(row => row.mode === 'reference' && row.ratio === undefined)).toBe(true)
  expect((projected?.params as VideoParams | undefined)?.maxReferenceImages).toBe(0)
})

it('omits scalar policies that the existing preference format cannot encode without losing their conditions', () => {
  const input = nativeModel()
  input.parameter_conditions = { schema_version: 1, rules: [{ id: 'restricted', when: {}, parameter: 'resolution',
    disallowed_values: ['720p'] }] }
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
  input.parameter_conditions = { schema_version: 2, rules: [] }
  expect(projectNativeMediaPreferences(input)).toBeUndefined()
  input.parameter_conditions = { schema_version: 1, rules: [] }
  expect(projectNativeMediaPreferences(input)).toBeDefined()
})

function pricedModel(unit: 'per_video' | 'per_second' = 'per_video'): MediaV2Model {
  const model = nativeModel(), revision = 'b'.repeat(64)
  model.pricing = { ...model.pricing, currency: 'CNY', policy_revision: revision,
    specification_rows: ['15', '30'].map((duration, index) => ({ id: String(index + 1).repeat(64),
      parameters: { duration, count: 1, mode: 'text-to-video', quality: 'standard', resolution: '720p', aspect_ratio: '16:9' },
      billing_unit: unit, quantity: unit === 'per_video' ? 1 : Number(duration),
      unit_price_cny: unit === 'per_video' ? '1.3700001' : '0.05',
      total_cny: unit === 'per_video' ? '1.3700001' : duration === '15' ? '0.75' : '1.5',
      quote_required: true, policy_revision: revision })) }
  return model
}

it.each(['per_video', 'per_second'] as const)('reuses exact public price conversion for %s without multiplying quantity', (unit) => {
  const model = pricedModel(unit), projected = projectNativeMediaPreferences(model)
  if (projected === undefined) throw new Error('Expected scalar preferences')
  const before = structuredClone(model), price = nativeMediaPreferencePrices([model], [projected]).get(model.id)
  expect(price).toMatchObject({ status: 'available', coverage: 'complete',
    unit: unit === 'per_video' ? 'points/video' : 'points/second', credits_per_yuan: '1250',
    rows: [{ points: unit === 'per_video' ? '1712.500125' : '62.5', parameters: { seconds: 15, ratio: '16:9' } },
      { points: unit === 'per_video' ? '1712.500125' : '62.5', parameters: { seconds: 30, ratio: '16:9' } }] })
  expect(model).toEqual(before)
  expect(projected.params).not.toHaveProperty('pricing')
})

it('keeps malformed optional pricing local to its model and leaves the scalar directory intact', () => {
  const broken = pricedModel(), valid = pricedModel()
  valid.id = 'independent-native-model'
  broken.pricing.policy_revision = 'not-a-policy'
  const models = [broken, valid], projected = models.flatMap((model) => {
    const result = projectNativeMediaPreferences(model)
    return result === undefined ? [] : [result]
  })
  const prices = nativeMediaPreferencePrices(models, projected)
  expect(projected).toHaveLength(2)
  expect(prices.has(broken.id)).toBe(false)
  expect(prices.get(valid.id)?.status).toBe('available')
})

it('leaves price-only unsupported specifications unavailable without adding a model choice', () => {
  const model = pricedModel(), projected = projectNativeMediaPreferences(model)
  if (projected === undefined) throw new Error('Expected scalar preferences')
  model.pricing.specification_rows = [{ id: 'c'.repeat(64), policy_revision: 'b'.repeat(64),
    parameters: { duration: '120', resolution: '8k', aspect_ratio: '16:9', count: 1 }, billing_unit: 'per_video',
    quantity: 1, unit_price_cny: '0.01', total_cny: '0.01', quote_required: true }]
  expect(nativeMediaPreferencePrices([model], [projected]).has(model.id)).toBe(false)
  expect((projected.params as VideoParams).durations).toEqual([15, 30])
})

function extraDefaultPrice(): MediaV2Model {
  const model = pricedModel()
  model.parameters_schema.properties = { ...(model.parameters_schema.properties as object),
    dynamic_range: { type: 'string', enum: ['sdr', 'hdr'], default: 'sdr' },
    mute_voice: { type: 'boolean', default: false }, style_preset: { type: 'string', enum: ['none', 'cinematic'], default: 'none' } }
  model.pricing.specification_rows = (model.pricing.specification_rows as { parameters: object }[]).map(row => ({ ...row,
    parameters: { ...row.parameters, dynamic_range: 'sdr', mute_voice: false, style_preset: 'none' } }))
  return model
}

it('displays a partial starting reference for validated optional native defaults without changing their original parameters', () => {
  const model = extraDefaultPrice(), projected = projectNativeMediaPreferences(model), before = structuredClone(model)
  if (projected === undefined) throw new Error('Expected scalar preference view')
  const price = nativeMediaPreferencePrices([model], [projected]).get(model.id)
  expect(price).toMatchObject({ status: 'available', coverage: 'partial', rows: [{ points: '1712.500125' }, { points: '1712.500125' }] })
  expect(price?.rows[0]?.parameters).not.toHaveProperty('dynamic_range')
  expect(model).toEqual(before)
  expect(projected.params).not.toHaveProperty('dynamic_range')
})

it.each(['nondefault', 'unknown', 'required', 'policy'] as const)('does not strip %s native controls to invent a compact price', (change) => {
  const model = extraDefaultPrice(), projected = projectNativeMediaPreferences(model)
  if (projected === undefined) throw new Error('Expected scalar preference view')
  if (change === 'required') model.parameters_schema.required = [...model.parameters_schema.required as string[], 'dynamic_range']
  if (change === 'policy') model.selection_constraints = { schema_version: 1, combinations: [
    { parameters: { dynamic_range: { allowed_values: ['hdr'] } } },
  ] }
  if (change === 'nondefault' || change === 'unknown') {
    model.pricing.specification_rows = (model.pricing.specification_rows as { parameters: object }[]).map(row => ({ ...row,
      parameters: { ...row.parameters, ...change === 'nondefault' ? { dynamic_range: 'hdr' } : { unlisted: 'none' } } }))
  }
  expect(nativeMediaPreferencePrices([model], [projected]).has(model.id)).toBe(false)
})

it('does not merge per-second and per-video rows into one misleading price range', () => {
  const model = pricedModel(), projected = projectNativeMediaPreferences(model)
  if (projected === undefined) throw new Error('Expected scalar preferences')
  model.pricing.specification_rows = [...model.pricing.specification_rows as { [key: string]: MediaV2Value }[]].map((row, index) =>
    index === 0 ? row : { ...row, billing_unit: 'per_second', quantity: 30, unit_price_cny: '0.05', total_cny: '1.5' })
  expect(nativeMediaPreferencePrices([model], [projected]).get(model.id)?.status).toBe('unavailable')
})

it.each([
  { parameters: { duration: 30, count: 1, mode: 'text-to-video', quality: 'standard', resolution: '720p', aspect_ratio: '16:9' } },
  { parameters: { duration: '30', count: 1, mode: 'text-to-video', quality: 'standard', resolution: '720P', aspect_ratio: '16:9' } },
  { billing_unit: 'per_second', quantity: 15, unit_price_cny: '0.05', total_cny: '1.5' },
])('does not normalize a contradictory native price row into a valid static choice: %j', (changed) => {
  const model = pricedModel(), projected = projectNativeMediaPreferences(model)
  if (projected === undefined) throw new Error('Expected scalar preferences')
  const row = (model.pricing.specification_rows as object[])[1]
  model.pricing.specification_rows = [{ ...row, ...changed }]
  expect(nativeMediaPreferencePrices([model], [projected]).has(model.id)).toBe(false)
})
