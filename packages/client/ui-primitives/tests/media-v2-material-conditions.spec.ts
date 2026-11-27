import { describe, expect, it } from 'vitest'
import { mediaV2FormIssues, type MediaV2SelectedAsset } from '../src/media-v2-form.ts'
import { mediaV2Object, type MediaV2AssetField, type MediaV2Model, type MediaV2Value } from '../src/media-v2-types.ts'

const now = 1_900_000_000
const model: MediaV2Model = {
  id: 'material-policy-fixture', display_name: 'Material policy fixture', kind: 'video', enabled: true, model_version: 'v1',
  parameters_schema: { type: 'object', properties: {
    mode: { type: 'string', enum: ['reference', 'first-frame'] }, quality: { type: 'string', enum: ['standard', 'high'] },
    sound: { type: 'boolean' }, duration: { type: 'number' }, count: { type: 'integer' }, optional: {},
    images: { type: 'array' }, videos: { type: 'array' }, audios: { type: 'array' },
  } },
  asset_fields: ['images', 'videos', 'audios'].map((name): MediaV2AssetField => ({ name,
    media_kind: name === 'images' ? 'image' : name === 'videos' ? 'video' : 'audio', native_shape: 'multiple',
    min_items: 0, max_items: 10, mime_types: [name === 'images' ? 'image/png' : name === 'videos' ? 'video/mp4' : 'audio/mpeg'], constraints: {},
  })),
  intents: [{ id: 'reference', label: 'Reference', requires_assets: true }, { id: 'frames', label: 'Frames', requires_assets: true }],
  pricing: { display: 'Synthetic', credits_per_yuan: 1000, quote_required: true },
}
const countRule = { id: 'source-count', when: { mode: ['reference'] }, asset_field: 'images', disallowed_counts: [1],
  message: 'A single source image needs explicit frame mode' }
const visualRule = { id: 'sound-source', when: { mode: ['reference'] }, asset_field: 'audios', requires_any_assets: ['images', 'videos'],
  message: 'Audio needs visual media' }
const conditioned = (rules: readonly unknown[] = [countRule]): MediaV2Model => ({ ...model, conditions: { schema_version: 1, rules } })
function selected(field: 'images' | 'videos' | 'audios', id: string, role: 'generation' | 'writing' = 'generation'): MediaV2SelectedAsset {
  const mediaKind = field === 'images' ? 'image' : field === 'videos' ? 'video' : 'audio'
  return { clientId: id, model: model.id, field, name: `${id}.media`, state: 'ready', role,
    asset: { asset_id: `ma2_${id}`, client_asset_id: id, model: model.id, state: 'ready', media_kind: mediaKind,
      mime_type: field === 'images' ? 'image/png' : field === 'videos' ? 'video/mp4' : 'audio/mpeg', bytes: 1024,
      sha256: 'a'.repeat(64), expires_at: now + 1000 } }
}
const image = selected('images', 'image'), secondImage = selected('images', 'second'), video = selected('videos', 'video')
const audio = selected('audios', 'audio')
const issues = (candidate: MediaV2Model, assets: readonly MediaV2SelectedAsset[], values: Readonly<Record<string, MediaV2Value>> = { mode: 'reference' }) =>
  mediaV2FormIssues(candidate, 'reference', values, assets, now)

describe('native material condition v1', () => {
  it.each([[image], [image, video]])('blocks the forbidden source count without changing any bound material: %j', (...assets) => {
    const original = JSON.stringify(assets)
    expect(issues(conditioned(), assets)).toContainEqual({ field: 'images', reason: 'condition' })
    expect(JSON.stringify(assets)).toBe(original)
  })
  it.each([[image, secondImage], [video], [audio]])('allows valid noncontiguous source counts without manufacturing a minimum: %j', (...assets) => {
    expect(issues(conditioned(), assets)).toEqual([])
  })
  it('keeps explicit first-frame mode usable with one image', () => {
    expect(mediaV2FormIssues(conditioned(), 'frames', { mode: 'first-frame' }, [image], now)).toEqual([])
  })
  it('keeps the original nontext intent gate for no generation material', () => {
    expect(issues(conditioned(), [])).toContainEqual({ field: 'intent', reason: 'intent' })
  })
  it('retains legacy empty-condition arrays without inventing a rule', () => {
    expect(issues({ ...model, conditions: [] }, [image])).toEqual([])
  })
  it('does not count writing-only images as generation inputs or mutate their role', () => {
    const writing = { ...image, role: 'writing' as const }, original = JSON.stringify(writing)
    expect(issues(conditioned(), [writing, video])).toEqual([])
    expect(issues(conditioned(), [image, { ...secondImage, role: 'writing' }])).toContainEqual({ field: 'images', reason: 'condition' })
    expect(JSON.stringify(writing)).toBe(original)
  })
  it('requires visual media only when the dependent audio role is populated', () => {
    expect(issues(conditioned([visualRule]), [audio])).toContainEqual({ field: 'audios', reason: 'condition' })
    expect(issues(conditioned([visualRule]), [audio, image])).toEqual([])
    expect(issues(conditioned([visualRule]), [audio, video])).toEqual([])
    expect(issues(conditioned([visualRule]), [image])).toEqual([])
    expect(issues(model, [audio])).toEqual([])
  })
  it('does not let writing-only visual files fulfill an audio generation dependency', () => {
    expect(issues(conditioned([visualRule]), [audio, { ...image, role: 'writing' }])).toContainEqual({ field: 'audios', reason: 'condition' })
  })
  it('uses zero for a disabled dependency role while accepting another available visual role', () => {
    const configured = { ...conditioned([visualRule]), asset_fields: model.asset_fields.filter(field => field.name !== 'images') }
    expect(issues(configured, [audio, video])).toEqual([])
    expect(issues(configured, [audio])).toContainEqual({ field: 'audios', reason: 'condition' })
  })
  it('leaves a disabled primary role inactive and does not let retained hidden media fulfill dependencies', () => {
    const noAudio = { ...conditioned([visualRule]), asset_fields: model.asset_fields.filter(field => field.name !== 'audios') }
    expect(issues(noAudio, [video])).toEqual([])
    const noImages = { ...conditioned([visualRule]), asset_fields: model.asset_fields.filter(field => field.name !== 'images') }
    const result = issues(noImages, [audio, image])
    expect(result).toContainEqual({ field: 'audios', reason: 'condition' })
    expect(result).toContainEqual({ field: 'images', reason: 'unavailable' })
    expect(image.field).toBe('images')
  })
  it('treats a safely named absent policy role as zero without inferring upload permission', () => {
    expect(issues(conditioned([{ ...countRule, asset_field: 'retained_native_role' }]), [video])).toEqual([])
    expect(issues(conditioned([{ ...visualRule, requires_any_assets: ['retained_native_role'] }]), [audio]))
      .toContainEqual({ field: 'audios', reason: 'condition' })
  })
  it('reports a violated hidden primary zero-count rule at the parameter summary', () => {
    const candidate = conditioned([{ ...countRule, asset_field: 'hidden_primary', disallowed_counts: [0] }])
    expect(issues(candidate, [video])).toContainEqual({ field: 'parameters', reason: 'condition' })
  })
  it('uses AND and exact scalar literals without coercing strings, booleans or numbers', () => {
    const candidate = conditioned([{ ...countRule, when: { mode: ['reference'], quality: ['high'], sound: [true], duration: [15], optional: [null] } }])
    const values = { mode: 'reference', quality: 'high', sound: true, duration: 15, optional: null }
    expect(issues(candidate, [image], values)).toContainEqual({ field: 'images', reason: 'condition' })
    for (const changed of [{ quality: 'standard' }, { sound: false }, { duration: '15' }, { optional: '' }]) {
      expect(issues(candidate, [image], { ...values, ...changed }).some(issue => issue.reason === 'condition')).toBe(false)
    }
  })
  it('applies an empty or omitted when map unconditionally', () => {
    const { when: _when, ...rule } = countRule
    expect(issues(conditioned([{ ...rule, when: {} }]), [image], {})).toContainEqual({ field: 'images', reason: 'condition' })
    expect(issues(conditioned([rule]), [image], {})).toContainEqual({ field: 'images', reason: 'condition' })
  })
  it('does not treat an absent parameter as an explicitly selected null', () => {
    const candidate = conditioned([{ ...countRule, when: { optional: [null] } }])
    expect(issues(candidate, [image], {}).some(issue => issue.reason === 'condition')).toBe(false)
    expect(issues(candidate, [image], { optional: null })).toContainEqual({ field: 'images', reason: 'condition' })
  })
  it('rejects an own __proto__ parameter instead of silently dropping an AND predicate', () => {
    const properties = mediaV2Object(JSON.parse('{"mode":{"type":"string"},"__proto__":{"type":"string"}}'))
    if (properties === null) throw new Error('Expected synthetic own parameter properties')
    const when: unknown = JSON.parse('{"mode":["reference"],"__proto__":["required-value"]}')
    const candidate: MediaV2Model = { ...model, parameters_schema: { properties },
      conditions: { schema_version: 1, rules: [{ ...countRule, when }] } }
    expect(issues(candidate, [image])).toContainEqual({ field: 'parameters', reason: 'unsupported' })
  })
  it('keeps valid named numeric predicates in the AND condition', () => {
    const candidate = conditioned([{ ...countRule, when: { mode: ['reference'], count: [2] } }])
    expect(issues(candidate, [image], { mode: 'reference', count: 1 })).toEqual([])
    expect(issues(candidate, [image], { mode: 'reference', count: 2 })).toContainEqual({ field: 'images', reason: 'condition' })
  })
  it('checks every matching rule rather than stopping at an inactive predecessor', () => {
    expect(issues(conditioned([{ ...countRule, when: { mode: ['first-frame'] } }, visualRule]), [audio]))
      .toContainEqual({ field: 'audios', reason: 'condition' })
  })
  it('keeps unconfirmed uploads blocked without treating them as verified dependency material', () => {
    const { asset: _asset, ...pending } = image
    const unconfirmed = { ...pending, state: 'unknown' as const }
    const result = issues(conditioned([visualRule]), [audio, unconfirmed])
    expect(result).toContainEqual({ field: 'images', reason: 'unknown' })
    expect(result).toContainEqual({ field: 'audios', reason: 'condition' })
  })
  it.each([
    { schema_version: 2, rules: [countRule] },
    { schema_version: 1, rules: [countRule], extra: true },
    { schema_version: 1 }, [{ unknown: true }], null,
    { schema_version: 1, rules: [{ ...countRule, script: 'ignore' }] },
    { schema_version: 1, rules: [{ ...countRule, id: '' }] },
    { schema_version: 1, rules: [{ ...countRule, message: '' }] },
    { schema_version: 1, rules: [{ ...countRule, asset_field: '../missing' }] },
    { schema_version: 1, rules: [{ ...countRule, when: { missing: ['reference'] } }] },
    { schema_version: 1, rules: [{ ...countRule, when: { images: [1] } }] },
    { schema_version: 1, rules: [{ ...countRule, when: { mode: [] } }] },
    { schema_version: 1, rules: [{ ...countRule, when: { mode: [{}] } }] },
    { schema_version: 1, rules: [{ ...countRule, disallowed_counts: [] }] },
    { schema_version: 1, rules: [{ ...countRule, disallowed_counts: [-1] }] },
    { schema_version: 1, rules: [{ ...countRule, disallowed_counts: [1.5] }] },
    { schema_version: 1, rules: [{ ...countRule, requires_any_assets: ['videos'] }] },
    { schema_version: 1, rules: [{ ...visualRule, requires_any_assets: [] }] },
    { schema_version: 1, rules: [{ ...visualRule, requires_any_assets: ['missing role'] }] },
    { schema_version: 1, rules: [{ ...visualRule, requires_any_assets: ['x'.repeat(97)] }] },
  ])('fails closed for unsupported rules before selecting an inactive branch: %j', (conditions) => {
    expect(issues({ ...model, conditions }, [image], { mode: 'first-frame' })).toContainEqual({ field: 'parameters', reason: 'unsupported' })
  })
})
