/** Unit estimates retain exact public points, complete legal specifications and optional metadata isolation. */
import { describe, expect, it } from 'vitest'
import { mediaPreferencePrice } from '../src/client/media-preference-prices.ts'
import { creditUnitRange, formatCreditUnitPrice } from '../src/client/price-comparisons.ts'
import { decodePreferenceReply, type PreferenceModel, type PreferencePricing } from '../src/client/media-preferences.ts'

const firstSpec = { resolution: '768P', seconds: 15, ratio: '16:9' }
const secondSpec = { resolution: '2K', seconds: 5, ratio: '9:16' }
const specs = [firstSpec, secondSpec]
const firstRow = { parameters: { ...firstSpec, count: 1 }, points: '137.5', input: 'unspecified' as const }
const pricing: PreferencePricing = { schema_version: 1, status: 'available', basis: 'default', source: 'public-retail',
  unit: 'points/second', credits_per_yuan: '550', coverage: 'complete', rows: [
    firstRow,
    { parameters: { ...secondSpec, count: 1 }, points: '387.500000000000000001', input: 'unspecified' },
  ] }
const video: PreferenceModel = { id: 'video-one', displayName: 'Video One', kind: 'video', source: 'fixture', verified: true,
  notes: [], params: { specifications: specs, seed: true, audioToggle: true }, pricing }
const envelope = (model: unknown) => ({ ok: true, account: { id: '7' }, accountOwner: 'a'.repeat(64), payload: {
  schema_version: 1, scope: 'b'.repeat(64), revision: 'c'.repeat(64), image: null, video: { model: video.id, parameters: {} },
  catalog: { image: [], video: [model] }, defaults: { image: { model: null, configured: false, available: false },
    video: { model: video.id, configured: true, available: true } },
} })
function readPrice(value: unknown) {
  const decoded = decodePreferenceReply(envelope(value), true)
  if (!decoded.ok) throw new Error('Price metadata must never remove an authorized model')
  return { reply: decoded.reply, price: mediaPreferencePrice(decoded.reply.catalog?.video[0]) }
}

describe('public chat media unit estimates', () => {
  it('uses Host point decimals without multiplying by conversion rate, duration or work count', () => {
    expect(mediaPreferencePrice(video)).toEqual({ kind: 'range', points: { minimum: '137.5', maximum: '387.500000000000000001' } })
    expect(mediaPreferencePrice(video, { resolution: '2K', seconds: 5, ratio: '9:16' }))
      .toEqual({ kind: 'exact', points: { minimum: '387.500000000000000001', maximum: '387.500000000000000001' } })
    expect(mediaPreferencePrice(video, { resolution: '2K', seconds: 15 })).toEqual({ kind: 'unknown' })
    const image: PreferenceModel = { ...video, kind: 'image', params: { maxCount: 2, sizes: ['1:1'] },
      pricing: { ...pricing, unit: 'points/image', rows: [
        { parameters: { size: '1:1', count: 1 }, points: '110', input: 'unspecified' },
        { parameters: { size: '1:1', count: 2 }, points: '99', input: 'unspecified' },
      ] } }
    expect(mediaPreferencePrice(image, { size: '1:1', count: 2 })).toEqual({ kind: 'exact', points: { minimum: '99', maximum: '99' } })
  })

  it('labels partial coverage or omitted priced conditions as a starting price and excludes illegal cheap rows', () => {
    expect(mediaPreferencePrice({ ...video, pricing: { ...pricing, coverage: 'partial', rows: [firstRow] } }))
      .toEqual({ kind: 'from', points: { minimum: '137.5', maximum: '137.5' } })
    expect(mediaPreferencePrice({ ...video, pricing: { ...pricing, coverage: 'partial', rows: [firstRow] } }, { resolution: '2K' }))
      .toEqual({ kind: 'unknown' })
    expect(mediaPreferencePrice(video, { resolution: '768P', audio: true })).toMatchObject({ kind: 'from' })
    const illegal = { ...video, pricing: { ...pricing, rows: [firstRow,
      { parameters: { resolution: '4K', seconds: 15 }, points: '0.01', input: 'unspecified' as const }] } }
    expect(mediaPreferencePrice(illegal)).toEqual({ kind: 'from', points: { minimum: '137.5', maximum: '137.5' } })
  })

  it('keeps text-only references conditional and matches an explicitly declared input mode', () => {
    const conditional = { ...video, pricing: { ...pricing, rows: pricing.rows.map(row => ({ ...row, input: 'text' as const })) } }
    expect(mediaPreferencePrice(conditional, { resolution: '768P' })).toMatchObject({ kind: 'from' })
    const inputModel: PreferenceModel = { ...video, params: { modes: ['text-to-video', 'image-to-video'] },
      pricing: { ...pricing, rows: [{ parameters: {}, points: '55', input: 'text' }] } }
    expect(mediaPreferencePrice(inputModel, { mode: 'image-to-video' })).toEqual({ kind: 'unknown' })
    expect(mediaPreferencePrice(inputModel, { mode: 'text-to-video' })).toMatchObject({ kind: 'exact', points: { minimum: '55' } })
  })

  it.each(['image_to_video', 'i2v', 'I2V', 'img2img'])('matches Host reference-input alias %s without using text-only prices', (mode) => {
    const inputModel: PreferenceModel = { ...video, params: { modes: [mode] },
      pricing: { ...pricing, rows: [{ parameters: {}, points: '55', input: 'text' }] } }
    expect(mediaPreferencePrice(inputModel, { mode })).toEqual({ kind: 'unknown' })
    expect(mediaPreferencePrice({ ...inputModel, pricing: { ...pricing,
      rows: [{ parameters: {}, points: '82.5', input: 'reference' }] } }, { mode }))
      .toMatchObject({ kind: 'exact', points: { minimum: '82.5' } })
  })

  it.each([
    ['missing metadata', { ...video, pricing: undefined }],
    ['wrong unit', { ...video, pricing: { ...pricing, unit: 'points/image' } }],
    ['negative price', { ...video, pricing: { ...pricing, rows: [{ ...pricing.rows[0], points: '-1' }] } }],
    ['nondecimal price', { ...video, pricing: { ...pricing, rows: [{ ...pricing.rows[0], points: '1e3' }] } }],
    ['numeric price', { ...video, pricing: { ...pricing, rows: [{ ...pricing.rows[0], points: 12 }] } }],
    ['unsupported zero', { ...video, pricing: { ...pricing, rows: [{ ...pricing.rows[0], points: '0' }] } }],
    ['invalid row', { ...video, pricing: { ...pricing, rows: [{ ...pricing.rows[0], parameters: { resolution: {} } }] } }],
  ])('retains the model but waits for a reliable price for %s', (_label, value) => {
    const result = readPrice(value)
    expect(result.reply.catalog?.video[0]?.id).toBe(video.id)
    expect(result.reply.preferences.video?.model).toBe(video.id)
    expect(result.price).toEqual({ kind: 'unknown' })
  })

  it('omits private pricing metadata and retains exact point values from the owner-bound catalog', () => {
    const result = readPrice({ ...video, pricing: { ...pricing, cost: 'private', lane: 'private', rows: pricing.rows.map(row => ({ ...row, cost: 'private' })) } })
    expect(result.price).toMatchObject({ kind: 'range' })
    expect(JSON.stringify(result.reply.catalog)).not.toContain('private')
    expect(result.reply.catalog?.video[0]?.pricing?.credits_per_yuan).toBe('550')
  })

  it('compares and formats points exactly with conservative display rounding and no positive zero', () => {
    expect(creditUnitRange(['10.000000000000000002', '10.000000000000000001']))
      .toEqual({ minimum: '10.000000000000000001', maximum: '10.000000000000000002' })
    expect(creditUnitRange([])).toBeUndefined()
    expect(creditUnitRange(['0'])).toBeUndefined()
    expect(creditUnitRange(['not-a-price'])).toBeUndefined()
    expect(formatCreditUnitPrice('0.000000000000000000000001', 'zh-CN')).toBe('0.000001')
    expect(formatCreditUnitPrice('137.5', 'en-US')).toBe('137.5')
    expect(formatCreditUnitPrice('900719925474099312345.0000001', 'zh-CN')).toBe('900,719,925,474,099,312,345.000001')
  })
})
