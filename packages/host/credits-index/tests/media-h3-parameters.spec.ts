import { describe, expect, it } from 'vitest'
import { catalogFromPricing, videoDurations, type VideoParams } from '../src/media.ts'
import h3Http from './fixtures/h3-resolution-seconds-http.json' with { type: 'json' }

function video(parameters: unknown): VideoParams {
  const [model] = catalogFromPricing([{ model_name: 'MiniMax-H3', kind: 'video', parameters }], null)
  if (model === undefined || model.kind !== 'video') throw new Error('Expected the H3 video capability')
  return model.params as VideoParams
}

describe('independent ratios in published resolution and seconds alternatives', () => {
  it('retains the actual HTTP ratio menu without expanding hundreds of complete specifications', () => {
    const params = video(h3Http.qualified)
    expect(params.specifications).toBeUndefined()
    expect(params.ratios).toEqual(h3Http.qualified.properties.ratio.enum)
    expect(new Set(params.resolutions)).toEqual(new Set(h3Http.qualified.properties.resolution.enum))
    expect(params.minDuration).toBe(4)
    expect(params.maxDuration).toBe(30)
    for (const resolution of ['480P', '768P', '1080P']) {
      expect(videoDurations(params, resolution)).toEqual(Array.from({ length: 27 }, (_, index) => index + 4))
    }
    expect(videoDurations(params, '2K')).toEqual(Array.from({ length: 12 }, (_, index) => index + 4))
    expect(videoDurations(params, '2K')).not.toContain(16)
    expect(videoDurations(params, '2K')).not.toContain(30)
    expect(videoDurations(params, '4K')).toEqual([])
  })

  it('keeps conservative HTTP declarations and absent metadata at their original fifteen seconds', () => {
    for (const parameters of [h3Http.conservative, undefined]) {
      const params = video(parameters)
      expect(params.maxDuration).toBe(15)
      expect(params.durations).not.toContain(30)
      expect(params.resolutions).toEqual(['768P', '2K'])
    }
  })

  it('intersects independent alternatives with the parent seconds maximum', () => {
    const params = video({ ...h3Http.qualified, properties: { ...h3Http.qualified.properties,
      seconds: { ...h3Http.qualified.properties.seconds, maximum: 15 },
    } })
    expect(params.specifications).toBeUndefined()
    expect(params.maxDuration).toBe(15)
    expect(videoDurations(params, '768P')).not.toContain(16)
  })

  it.each([
    { key: 'ycapi', api_version: 1, version: '1.0.0' },
    { key: 'other', api_version: 1, version: '1.0.0' },
    null,
  ])('keeps task-plugin complete specifications authoritative: %j', (marker) => {
    const params = video({ ...h3Http.qualified, 'x-task-plugin': marker, additionalProperties: false })
    expect(params.specifications).toEqual([])
    expect(params.durations).toEqual([])
  })

  it.each([
    { allOf: [{ properties: { seconds: { maximum: 15 } } }] },
    { additionalProperties: false },
    { required: ['context_ir_enabled'] },
    { properties: { ...h3Http.qualified.properties, mode: { const: 'fast' } } },
  ])('retains complete parsing for additional parent restrictions: %j', (extra) => {
    const params = video({ ...h3Http.qualified, ...extra })
    expect(params.specifications).toEqual([])
    expect(params.durations).toEqual([])
  })

  it.for([
    [...h3Http.qualified.oneOf, h3Http.qualified.oneOf[0]],
    h3Http.qualified.oneOf.slice(1),
    [{ properties: { resolution: { enum: ['768P'] } } }, ...h3Http.qualified.oneOf.slice(1)],
    [{ ...h3Http.qualified.oneOf[0], properties: { ...h3Http.qualified.oneOf[0]?.properties, hidden: { const: true } } },
      ...h3Http.qualified.oneOf.slice(1)],
    [{ ...h3Http.qualified.oneOf[0], not: { properties: { seconds: { const: 30 } } } }, ...h3Http.qualified.oneOf.slice(1)],
    [{ ...h3Http.qualified.oneOf[0], required: ['hidden'] }, ...h3Http.qualified.oneOf.slice(1)],
    [{ properties: { resolution: { enum: ['768P'], not: { const: '768P' } }, seconds: { minimum: 4, maximum: 30 } } },
      ...h3Http.qualified.oneOf.slice(1)],
    [{ properties: { resolution: { enum: ['768P'] }, seconds: { minimum: 4, maximum: 30, not: { const: 30 } } } },
      ...h3Http.qualified.oneOf.slice(1)],
  ])('does not flatten overlapping, incomplete or unrecognized branch constraints: %j', (oneOf) => {
    const params = video({ ...h3Http.qualified, oneOf })
    expect(params.specifications).toEqual([])
    expect(params.durations).toEqual([])
  })
})
