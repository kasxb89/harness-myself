/** Consume the six actual Go projections; only the public DTO envelope and local asset receipts are synthetic. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mediaV2Choices, mediaV2Defaults, mediaV2Fields, mediaV2FormIssues, type MediaV2SelectedAsset } from '../src/media-v2-form.ts'
import { isMediaV2Value, mediaV2Object, parseMediaV2Catalog } from '../src/media-v2-types.ts'
import type { MediaV2Intent, MediaV2Kind, MediaV2Model, MediaV2Value } from '../src/media-v2-types.ts'

const bytes = readFileSync(new URL('./fixtures/native-six-20261128/actual-go-six-models.json', import.meta.url))
const raw: unknown = JSON.parse(bytes.toString('utf8'))
function object(value: unknown): Record<string, unknown> {
  const row = mediaV2Object(value)
  if (row === null) throw new Error('Expected actual Go object')
  return row
}
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Expected actual Go rows')
  return value.map(object)
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected actual Go string')
  return value
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected actual Go number')
  return value
}
function kind(value: unknown): MediaV2Kind {
  if (value !== 'image' && value !== 'video' && value !== 'audio') throw new Error('Expected actual Go media kind')
  return value
}
function intent(value: unknown): MediaV2Intent {
  if (value !== 'text' && value !== 'reference' && value !== 'frames' && value !== 'transform') throw new Error('Expected actual Go intent')
  return value
}
const fixture = object(raw), entries = rows(fixture.models), cases = rows(fixture.cases), now = 1_900_000_000
const mimes = { image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], video: ['video/mp4', 'video/webm'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/mp4'] } as const
// Match the existing service DTO naming/MIME fallback. No route, supplier qualification or pricing is inferred.
const envelope = { models: entries.map((entry) => {
  const contract = object(entry.contract), native = object(contract.param_schema)
  return { id: entry.model, display_name: contract.name, model_version: 'synthetic-six-projection',
    enabled: contract.available, kind: contract.kind, parameters_schema: entry.schema,
    asset_fields: rows(entry.asset_fields).map(field => ({ name: field.name, media_kind: field.media_kind,
      native_shape: field.shape, min_items: field.min, max_items: field.max,
      mime_types: Array.isArray(field.mime_types) && field.mime_types.length > 0 ? field.mime_types : mimes[kind(field.media_kind)],
      constraints: native[text(field.name)] })),
    intents: (Array.isArray(entry.intents) ? entry.intents : []).map((value) => {
      const id = intent(value); return { id, label: id, requires_assets: id !== 'text' }
    }),
    ...entry.material_conditions === null ? {} : { conditions: entry.material_conditions },
    ...entry.parameter_conditions === null ? {} : { parameter_conditions: entry.parameter_conditions },
    pricing: { display: 'Synthetic declaration consumption only', credits_per_yuan: 1000, quote_required: true },
  }
}), credits_per_yuan: 1000 }
const catalog = parseMediaV2Catalog(envelope)
function model(id: string): MediaV2Model {
  const candidate = catalog.models.find(item => item.id === id)
  if (candidate === undefined) throw new Error(`Missing actual Go model ${id}`)
  return candidate
}
function entryForCase(entry: Record<string, unknown>): Record<string, unknown> {
  const candidate = entries.find((item) => {
    const contract = object(item.contract)
    return [item.model, contract.native_id, contract.upstream_public_id].includes(entry.model)
  })
  if (candidate === undefined) throw new Error('Missing actual Go contract for case')
  return candidate
}
function caseDraft(entry: Record<string, unknown>):
{ model: MediaV2Model; values: Record<string, MediaV2Value>; assets: MediaV2SelectedAsset[] } {
  const candidate = model(text(entryForCase(entry).model)), metadata = object(entry.asset_metadata)
  const values = { ...mediaV2Defaults(candidate) }
  const assets: MediaV2SelectedAsset[] = []
  for (const [field, value] of Object.entries(object(entry.params))) {
    if (Array.isArray(value) && value.length > 0 && value.every(id => typeof id === 'string' && Object.hasOwn(metadata, id))) {
      for (const originalId of value) {
        const id = text(originalId), meta = object(metadata[id]), mediaKind = kind(meta.kind)
        assets.push({ clientId: id, name: id, model: candidate.id, field, role: 'generation', state: 'ready',
          asset: { asset_id: id, client_asset_id: id, model: candidate.id, state: 'ready', media_kind: mediaKind,
            mime_type: text(meta.mime_type), bytes: number(meta.bytes), sha256: 'a'.repeat(64), expires_at: now + 600,
            width: number(meta.width), height: number(meta.height),
            duration_seconds: number(meta.duration_seconds), fps: number(meta.fps) } })
      }
    } else {
      if (!isMediaV2Value(value)) throw new Error('Expected exact actual Go JSON parameter')
      values[field] = value
    }
  }
  return { model: candidate, values, assets }
}
function namedCase(name: string): Record<string, unknown> {
  const entry = cases.find(item => item.name === name)
  if (entry === undefined) throw new Error('Missing actual Go case')
  return entry
}
const apiOnly = ['MJ 1981 Unicode runes rejected', 'Veo unavailable default rejects omission']

describe('focused actual Go six-model declaration consumption', () => {
  it('pins the original bytes and exact six projections without claiming supplier or paid qualification', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('91543c365b0e06a64cb77dc092c09296075d8cc5329af1cf844bf27cdf9e2035')
    expect(fixture).toMatchObject({ fixture_kind: 'actual-Go-focused-six-declarations', synthetic: true,
      execution_qualified: false, model_count: 6, case_count: 48 })
    expect(catalog.models.map(item => item.id)).toEqual(entries.map(item => item.model))
    expect(catalog.models.filter(item => item.kind === 'image')).toHaveLength(1)
    expect(catalog.models.filter(item => item.kind === 'video')).toHaveLength(5)
  })
  it.each(entries)('preserves complete Go schema, role constraints and known conditions: $model', (entry) => {
    const candidate = model(text(entry.model)), contract = object(entry.contract), native = object(contract.param_schema)
    expect(candidate.parameters_schema).toEqual(entry.schema)
    expect(candidate.asset_fields.map(field => ({ name: field.name,
      min: field.min_items, max: field.max_items, shape: field.native_shape })))
      .toEqual(rows(entry.asset_fields).map(field => ({ name: field.name, min: field.min, max: field.max, shape: field.shape })))
    for (const field of candidate.asset_fields) expect(field.constraints).toEqual(native[field.name])
    expect(candidate.intents.map(item => item.id)).toEqual(entry.intents)
    expect(candidate.conditions).toEqual(entry.material_conditions ?? undefined)
    expect(candidate.parameter_conditions).toEqual(entry.parameter_conditions ?? undefined)
  })
  it.each(cases.filter(entry => !apiOnly.includes(text(entry.name))))('validates supported local constraints without changing references or values: $name', (entry) => {
    const draft = caseDraft(entry), before = JSON.stringify(draft)
    const issues = mediaV2FormIssues(draft.model, intent(entry.intent), draft.values, draft.assets, now)
    expect(issues.length === 0).toBe(entry.runtime_valid)
    expect(JSON.stringify(draft)).toBe(before)
    expect(entry.request_bytes_unchanged).toBe(true)
  })
  it('keeps MJ 1980-code-point declaration and forwards accepted prompt bytes without inventing a client maxLength', () => {
    const mj = entries.find(item => item.model === 'ycapi-mj_imagine')
    if (mj === undefined) throw new Error('Missing actual Go MJ declaration')
    expect(object(mj.contract).max_prompt_chars).toBe(1980)
    expect(object(object(mj.schema).properties).prompt).toEqual({ type: 'string' })
    const draft = caseDraft(namedCase('MJ exact 1980 Unicode runes'))
    expect(Array.from(text(draft.values.prompt))).toHaveLength(1980)
    expect(mediaV2FormIssues(draft.model, 'text', draft.values, [], now)).toEqual([])
    const rejected = namedCase('MJ 1981 Unicode runes rejected')
    expect(rejected).toMatchObject({ quote_valid: false, runtime_valid: false, expected_quote_failure: 'prompt' })
    const astral = { ...draft.values, prompt: '🦊'.repeat(1980) }
    expect(mediaV2FormIssues(draft.model, 'text', astral, [], now)).toEqual([])
    expect(astral.prompt).toBe('🦊'.repeat(1980))
  })
  it('keeps the unavailable default absent rather than inventing a legal duration before the API free-quote guard', () => {
    const candidate = model('ycapi-veo-4-omni'), values = mediaV2Defaults(candidate)
    expect(values.duration).toBeUndefined()
    const field = mediaV2Fields(candidate).find(item => item.name === 'duration')
    if (field === undefined) throw new Error('Missing actual Go duration')
    expect(mediaV2Choices(field, values).filter(item => item.available).map(item => item.value)).toEqual(['4', '6', '8', '10'])
    expect(mediaV2Choices(field, { ...values, duration: '3' }).find(item => item.value === '3')).toEqual({ value: '3', label: '3', available: false })
    expect(values.duration).toBeUndefined()
    expect(namedCase('Veo unavailable default rejects omission')).toMatchObject({ quote_valid: false, runtime_valid: false, expected_quote_failure: 'duration' })
  })
  it('keeps Magi special default12 and Pixverse default3 with their exact currently allowed options', () => {
    for (const [id, expectedDefault, expectedChoices] of [
      ['ycapi-magi-2-special', '12', ['4', '5', '6', '7', '8', '9', '10', '11', '12']],
      ['ycapi-pixverse-c1', '3', ['3', '5', '6', '8', '9', '12', '15']],
    ] as const) {
      const candidate = model(id), values = mediaV2Defaults(candidate)
      expect(values.duration).toBe(expectedDefault)
      const field = mediaV2Fields(candidate).find(item => item.name === 'duration')
      if (field === undefined) throw new Error('Missing actual Go duration')
      expect(mediaV2Choices(field, values).filter(item => item.available).map(item => item.value)).toEqual(expectedChoices)
    }
  })
})
