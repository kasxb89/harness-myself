/** Unit references are public defaults, never a generation quote or inferred free use. */
import { describe, expect, it } from 'vitest'
import { mediaPreferencePrices } from '../src/media-preference-pricing.ts'
import { catalogFromPricing } from '../src/media.ts'
import fixture from './fixtures/official-price-comparison-api.json' with { type: 'json' }
import { preferenceModels } from './media-preferences.fixture.ts'

const image = (params: object = { size: '1:1', resolution: '1k', count: 1 }, price: unknown = '0.19912') =>
  ({ params, retail_cny: price, unit: 'CNY / image' })
const video = (params: object = { resolution: '720P', seconds: 5, ratio: '16:9', count: 1 }, price: unknown = '0.25') =>
  ({ params, retail_cny: price, unit: 'CNY / second' })
const raw = (rows: readonly unknown[], kind: 'image' | 'video' = 'image') =>
  [{ model_name: kind === 'image' ? 'image-a' : 'video-b', kind, retail_price_rows: rows }]

it('converts actual public image/video decimals with the configured rate and maps declared aliases to exact specifications', () => {
  const models = catalogFromPricing(fixture.data, null)
  const projected = mediaPreferencePrices(fixture.data, models, 1250)
  const image = projected.get('ycapi-gemini-nano-banana-2.1-image')
  expect(image).toMatchObject({ schema_version: 1, basis: 'default', source: 'public-retail', unit: 'points/image',
    status: 'available', coverage: 'complete', credits_per_yuan: '1250' })
  expect(image?.rows[0]).toEqual({ parameters: { size: '1:1', resolution: '1K', count: 1 }, points: '224.12', input: 'text' })
  const video = projected.get('ycapi-minimax-h3')
  expect(video).toMatchObject({ status: 'available', unit: 'points/second', coverage: 'complete' })
  expect(video?.rows[0]).toEqual({ parameters: { resolution: '2k', seconds: 5, ratio: '16:9', count: 1 },
    points: '556.533', input: 'text' })
  expect(JSON.stringify([...projected.values()])).not.toMatch(/official_reference|supplier|billing_expr|lane|source_url|quota_type/u)
})

it('folds only the audited YCAPI minimal offer field and leaves unknown suppliers, versions and ambiguous offers unpriced', () => {
  const models = catalogFromPricing(fixture.data, null)
  const actual = fixture.data.find(model => model.model_name === 'ycapi-gemini-3.1-flash-image')!
  const untouched = structuredClone(actual)
  const price = mediaPreferencePrices([actual], models, 1250).get(actual.model_name)
  expect(price).toMatchObject({ status: 'available', coverage: 'complete' })
  expect(price?.rows).toHaveLength(4)
  expect(price?.rows[0]).toEqual({ input: 'text', points: '238.9775',
    parameters: { count: 1, resolution: '0.5K', size: '1:1' } })
  expect(JSON.stringify(price)).not.toContain('thinking_level')
  expect(actual).toEqual(untouched)
  for (const adapter of [{ key: 'other', api_version: 1, version: '1.0.0' },
    { key: 'ycapi', api_version: 2, version: '1.0.0' }, { key: 'ycapi', api_version: 1, version: '1.0.1' },
    { key: 'ycapi', version: '1.0.0' }]) {
    expect(mediaPreferencePrices([{ ...actual, parameters: { ...actual.parameters, 'x-task-plugin': adapter } }], models, 1250)
      .get(actual.model_name)?.status).toBe('unavailable')
  }
  const rows = actual.retail_price_rows!
  const changed = [{ ...rows[0], params: { ...rows[0]!.params, thinking_level: 'high' } }, ...rows.slice(1)]
  expect(mediaPreferencePrices([{ ...actual, retail_price_rows: changed }], models, 1250).get(actual.model_name)?.status)
    .toBe('unavailable')
  const missing = rows.map((row) => {
    if (!('thinking_level' in row.params)) return row
    const { thinking_level: _fixed, ...params } = row.params
    return { ...row, params }
  })
  expect(mediaPreferencePrices([{ ...actual, retail_price_rows: [rows[0], missing[1]] }], models, 1250)
    .get(actual.model_name)?.status).toBe('unavailable')
  const ambiguous = { params: { mode: 'text-to-image', count: 1, thinking_level: 'minimal' },
    unit: 'CNY / image', retail_cny: '0.1' }
  expect(mediaPreferencePrices([{ ...actual, retail_price_rows: [ambiguous] }], models, 1250)
    .get(actual.model_name)?.status).toBe('unavailable')
})

it.each([
  ['0.19912', 1000, '199.12'], ['0.19912', 1.25, '0.2489'], ['0.000001', 1234.5, '0.0012345'],
  ['0.000000000000000000000001', 1000, '0.000000000000000000001'], ['999999999999999999', 1, '999999999999999999'],
])('retains exact positive decimal %s at rate %s without floating-point rounding', (price, rate, points) => {
  expect(mediaPreferencePrices(raw([image(undefined, price)]), preferenceModels, rate).get('image-a')?.rows[0]?.points).toBe(points)
})

it('never substitutes a total price for a unit rate or derives currency conversion from private fields', () => {
  const projected = mediaPreferencePrices(raw([{ ...video(), retail_total_cny: '777', cost: '0.001', lane: 'private-lane',
    supplier_key: 'sk-private', official_reference: null }], 'video'), preferenceModels, 2000)
  expect(projected.get('video-b')?.rows[0]?.points).toBe('500')
  expect(JSON.stringify([...projected.values()])).not.toMatch(/777|private|supplier|cost|lane/u)
  expect(mediaPreferencePrices(raw([{ params: {}, retail_total_cny: '777', unit: 'CNY / image' }]), preferenceModels, 1000)
    .get('image-a')).toMatchObject({ status: 'unavailable', coverage: 'none', rows: [] })
})

it.each([undefined, null, '', '0', '0.000', 0, -1, '1e-3', '1.2 ', 'NaN', 'Infinity', '1'.repeat(19), '0.' + '1'.repeat(25)])(
  'does not present missing, zero or invalid public amount %j as free', (price) => {
    expect(mediaPreferencePrices(raw([image({}, price)]), preferenceModels, 1000).get('image-a'))
      .toMatchObject({ status: 'unavailable', coverage: 'none', rows: [] })
  },
)

it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1e21])('contains invalid conversion rate %s within price metadata', (rate) => {
  expect(mediaPreferencePrices(raw([image()]), preferenceModels, rate).get('image-a'))
    .toEqual({ schema_version: 1, basis: 'default', source: 'public-retail', unit: 'points/image',
      status: 'unavailable', coverage: 'none', rows: [] })
})

it('keeps complete specifications coupled and marks partially missing or invalid prices as partial coverage', () => {
  const full = [image(), image({ size: '16:9', resolution: '2k', count: 1 }, '0.4')]
  expect(mediaPreferencePrices(raw(full), preferenceModels, 1000).get('image-a')?.coverage).toBe('complete')
  const invalid = image({ size: '1:1', resolution: '2k', count: 1 }, '0.9')
  expect(mediaPreferencePrices(raw([full[0], invalid]), preferenceModels, 1000).get('image-a'))
    .toMatchObject({ status: 'available', coverage: 'partial', rows: [{ points: '199.12' }] })
  expect(mediaPreferencePrices(raw([image({})]), preferenceModels, 1000).get('image-a'))
    .toMatchObject({ status: 'unavailable', rows: [] })
  const alias = image({ aspect_ratio: '16:9', size: '2k', count: 1, mode: 'text-to-image' })
  expect(mediaPreferencePrices(raw([alias]), preferenceModels, 1000).get('image-a')?.rows[0]?.parameters)
    .toEqual({ size: '16:9', resolution: '2k', count: 1 })
})

it('retains supported batch conditions, rejects multi-work video rates, and never drops unknown price-affecting controls', () => {
  expect(mediaPreferencePrices(raw([image({ size: '1:1', resolution: '1k', n: 2 })]), preferenceModels, 1000)
    .get('image-a')?.rows[0]?.parameters.count).toBe(2)
  for (const params of [{ size: '1:1', resolution: '1k', n: 2, count: 1 },
    { size: '1:1', resolution: '1k', thinking_level: 'minimal' },
    { size: '1:1', resolution: '1k', supplier_token: 'private-token' },
    { size: '1:1', resolution: '1k', mode: 'unknown-private-mode' }]) {
    expect(mediaPreferencePrices(raw([image(params)]), preferenceModels, 1000).get('image-a')?.status).toBe('unavailable')
  }
  expect(mediaPreferencePrices(raw([video({ resolution: '720P', duration: '5', aspect_ratio: '16:9', n: 1,
    mode: 'text-to-video' })], 'video'), preferenceModels, 1000).get('video-b')?.rows[0])
    .toMatchObject({ input: 'text', parameters: { seconds: 5, ratio: '16:9', count: 1 } })
  expect(mediaPreferencePrices(raw([video({ resolution: '720P', seconds: 5, ratio: '16:9', count: 2 })], 'video'),
    preferenceModels, 1000).get('video-b')?.status).toBe('unavailable')
})

it('cannot expose disabled model rows and leaves legacy models, conflicting model records and wrong units unpriced', () => {
  const onlyAllowed = preferenceModels.filter(model => model.id === 'image-a')
  const projected = mediaPreferencePrices([...raw([image()]), ...raw([video()], 'video'),
    { model_name: 'disabled-private', retail_price_rows: [image()] }], onlyAllowed, 1000)
  expect([...projected.keys()]).toEqual(['image-a'])
  expect(projected.has('disabled-private')).toBe(false)
  expect(mediaPreferencePrices([], preferenceModels, 1000).get('MiniMax-H3'))
    .toMatchObject({ status: 'unavailable', coverage: 'none', rows: [] })
  expect(mediaPreferencePrices([...raw([image()]), ...raw([image({}, '99')])], onlyAllowed, 1000).get('image-a')?.status)
    .toBe('unavailable')
  for (const changed of [{ unit: 'USD / image' }, { unit: 'CNY / million tokens' }, { currency: 'USD' }, { direction: 'input' }]) {
    expect(mediaPreferencePrices(raw([{ ...image(), ...changed }]), onlyAllowed, 1000).get('image-a')?.status).toBe('unavailable')
  }
})

describe('bounded public metadata', () => {
  it('declines excessive rows without adding any request or changing the model catalog', () => {
    const models = structuredClone(preferenceModels)
    expect(mediaPreferencePrices(raw(Array.from({ length: 513 }, () => image())), models, 1000).get('image-a')?.status)
      .toBe('unavailable')
    expect(models).toEqual(preferenceModels)
  })
})
