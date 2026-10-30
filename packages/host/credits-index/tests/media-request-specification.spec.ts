import { describe, expect, it } from 'vitest'
import { resolveMediaSpecification, videoSpecificationDurations } from '../src/media-request-specification.ts'

import { catalogFromPricing, type VideoParams } from '../src/media.ts'

const menu = [
  { resolution: '720p', seconds: 5, ratio: '16:9', quality: 'mini' },
  { resolution: '720p', seconds: 5, ratio: '16:9', quality: 'fast' },
  { resolution: '1080p', seconds: 10, ratio: '16:9', quality: 'standard' },
]

describe('complete public media specifications', () => {
  it('requires a quality choice when the same resolution and duration have distinct paid offers', () => {
    expect(resolveMediaSpecification(menu, { resolution: '720p', seconds: 5 })).toMatchObject({ ok: false, code: 'SPECIFICATION_REQUIRED' })
  })
  it('does not invent a resolution-duration-quality cartesian product', () => {
    expect(resolveMediaSpecification(menu, { resolution: '1080p', seconds: 5, quality: 'mini' }))
      .toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
  })
  it('fills missing dimensions only from a unique published combination', () => {
    expect(resolveMediaSpecification(menu, { resolution: '720p', quality: 'fast' }))
      .toEqual({ ok: true, specification: menu[1] })
  })
  it('preserves legacy independent menus and refuses an explicitly empty complete menu', () => {
    expect(resolveMediaSpecification(undefined, { resolution: '768P', seconds: 15 }))
      .toEqual({ ok: true, specification: { resolution: '768P', seconds: 15 } })
    expect(resolveMediaSpecification([], {})).toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
  })
})

describe('planning native durations for the chosen paid variant', () => {
  function params(parameters: unknown): VideoParams {
    const [model] = catalogFromPricing([{ model_name: 'fixture-video', kind: 'video', parameters }], null)
    if (model === undefined) throw new Error('Expected video capability')
    return model.params as VideoParams
  }
  const parameters = { oneOf: [
    { properties: { resolution: { const: '720p' }, quality: { const: 'mini' }, mode: { const: 'std' }, seconds: { const: 5 } } },
    { properties: { resolution: { const: '720p' }, quality: { const: 'fast' }, mode: { const: 'pro' }, seconds: { const: 10 } } },
    { properties: { resolution: { const: '1080p' }, quality: { const: 'fast' }, mode: { const: 'pro' }, seconds: { const: 15 } } },
  ] }
  it('plans only native seconds belonging to the exact resolution, quality and mode', () => {
    const capability = params(parameters)
    expect(videoSpecificationDurations(capability, { resolution: '720p', quality: 'mini', mode: 'std' })).toEqual([5])
    expect(videoSpecificationDurations(capability, { resolution: '720p', quality: 'fast', mode: 'pro' })).toEqual([10])
    expect(videoSpecificationDurations(capability, { resolution: '1080p', quality: 'fast', mode: 'pro' })).toEqual([15])
    expect(videoSpecificationDurations(capability, { resolution: '720p', quality: 'fast', mode: 'std' })).toEqual([])
    expect(videoSpecificationDurations(capability, { resolution: '4k' })).toEqual([])
  })
  it('retains independent legacy duration menus when no complete specifications exist', () => {
    const legacy = params({ oneOf: [{ properties: { resolution: { const: '720p' }, seconds: { enum: [5, 10] } } }] })
    expect(legacy.specifications).toBeUndefined()
    expect(videoSpecificationDurations(legacy, { resolution: '720p' })).toEqual([5, 10])
    expect(videoSpecificationDurations(legacy, { resolution: '1080p' })).toEqual([])
  })
  it('keeps portrait and native-size duration menus separate when quality and resolution are equal', () => {
    const capability = params({ oneOf: [
      { properties: { resolution: { const: '720p' }, quality: { const: 'std' }, ratio: { const: '9:16' },
        size: { const: '720x1280' }, seconds: { const: 5 } } },
      { properties: { resolution: { const: '720p' }, quality: { const: 'std' }, ratio: { const: '16:9' },
        size: { const: '1280x720' }, seconds: { const: 10 } } },
      { properties: { resolution: { const: '720p' }, quality: { const: 'std' }, ratio: { const: '9:16' },
        size: { const: '1080x1920' }, seconds: { const: 10 } } },
    ] })
    expect(videoSpecificationDurations(capability, { resolution: '720p', quality: 'std', ratio: '9:16', size: '720x1280' }))
      .toEqual([5])
    expect(videoSpecificationDurations(capability, { resolution: '720p', quality: 'std', ratio: '16:9', size: '1280x720' }))
      .toEqual([10])
    expect(videoSpecificationDurations(capability, { resolution: '720p', quality: 'std', ratio: '9:16', size: '1280x720' }))
      .toEqual([])
  })
  it('requires native durations in a complete declaration while allowing models without a resolution field', () => {
    expect(params({ oneOf: [{ properties: { quality: { const: 'fast' } } }] }).specifications).toEqual([])
    const capability = params({ properties: { seconds: { enum: [5, 10] } }, oneOf: [{ properties: { quality: { const: 'fast' } } }] })
    expect(videoSpecificationDurations(capability, { quality: 'fast' })).toEqual([5, 10])
    expect(capability.durationByResolution).toBeUndefined()
  })
})
