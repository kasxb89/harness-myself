import { describe, expect, it } from 'vitest'
import { catalogFromPricing, videoDurations, type MediaSpecification, type VideoParams } from '../src/media.ts'
import { resolveMediaSpecification, videoSpecificationDurations } from '../src/media-request-specification.ts'
import fixture from './fixtures/media-video-parameters-actual-go-20261120.json' with { type: 'json' }

const expectedMenus: Readonly<Record<string, readonly {
  readonly resolution: string
  readonly seconds: readonly number[]
  readonly quality?: string
}[]>> = {
  'ycapi-grok-imagine-1.5': [{ resolution: '1080p', seconds: [10] }, { resolution: '480p', seconds: [10] }],
  'ycapi-grok-imagine-video': [{ resolution: '480p', seconds: [5, 10] }, { resolution: '720p', seconds: [5, 10] }],
  'ycapi-seedance-2-5': [{ resolution: '1080p', seconds: [5, 10] }],
  'ycapi-seedance-2-5-promo': [{ resolution: '1080p', seconds: [5, 10] }, { resolution: '720p', seconds: [5, 10] }],
  'ycapi-omni-flash-1-1': [{ resolution: '1080p', seconds: [10] }, { resolution: '720p', seconds: [10] }],
  'ycapi-seedance-2-0-official': [
    { resolution: '480p', seconds: [5, 10], quality: 'mini' },
    { resolution: '720p', seconds: [5, 10], quality: 'fast' },
    { resolution: '720p', seconds: [5, 10], quality: 'mini' },
    { resolution: '720p', seconds: [5, 10], quality: '标准' },
  ],
  'ycapi-minimax-h3': [{ resolution: '2k', seconds: [5, 10] }, { resolution: '768p', seconds: [5, 10] }],
  'ycapi-kling-v4': [{ resolution: '1080p', seconds: [5, 10] }, { resolution: '720p', seconds: [5, 10] }],
}

describe('actual Go video parameter publications consumed by the Client Host', () => {
  it.each(fixture.cases)('preserves native output and input limits for $case_id', (input) => {
    expect(fixture.source).toBe('158a140c1c80dd0566fcc15ff842f4ff206d45ec')
    expect(fixture.cases).toHaveLength(12)
    const [model] = catalogFromPricing([input], null)
    if (model === undefined || model.kind !== 'video') throw new Error(`Expected one video capability for ${input.case_id}`)
    expect(model.id).toBe(input.model_name)
    const params = model.params as VideoParams
    if (input.model_name === 'MiniMax-H3') {
      expect(model.route).toBe('/v1/video/generations')
      expect(params).toMatchObject({ maxFrameImages: 2, frameSlots: 2, maxReferenceImages: 9,
        maxReferenceVideos: 3, maxReferenceAudios: 3, mixFramesAndReferences: false, minDuration: 4, maxDuration: 30 })
      expect(params.specifications).toBeUndefined()
      expect(params.resolutions).toEqual(['768P', '480P', '1080P', '2K'])
      expect(params.ratios).toEqual(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])
      for (const resolution of ['768P', '480P', '1080P']) {
        const expected = Array.from({ length: 27 }, (_, index) => index + 4)
        expect(videoDurations(params, resolution)).toEqual(expected)
        expect(videoSpecificationDurations(params, { resolution })).toEqual(expected)
      }
      expect(videoSpecificationDurations(params, { resolution: '2K' }))
        .toEqual(Array.from({ length: 12 }, (_, index) => index + 4))
      expect(videoDurations(params, '2K')).not.toContain(30)
      expect(videoDurations(params, '4K')).toEqual([])
      return
    }
    expect(model.route).toBe('/v1/videos')
    expect(params).toMatchObject({ strictReferences: true, maxFrameImages: 0, frameSlots: 0,
      maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0 })
    const expected = expectedMenus[input.model_name]
    if (expected === undefined) throw new Error(`Missing independent video expectations for ${input.case_id}`)
    const specifications: MediaSpecification[] = expected.flatMap(({ resolution, seconds, quality }) => seconds.map(duration => ({
      resolution, seconds: duration, ratio: '16:9', ...quality === undefined ? {} : { quality },
    })))
    expect(params.specifications).toEqual(specifications)
    expect(params.resolutions).toEqual([...new Set(expected.map(value => value.resolution))])
    expect(params.ratios).toEqual(['16:9'])
    expect(params.qualities).toEqual([...new Set(expected.flatMap(value => value.quality === undefined ? [] : [value.quality]))])
    for (const specification of specifications) {
      expect(resolveMediaSpecification(params.specifications, specification)).toEqual({ ok: true, specification })
      expect(videoSpecificationDurations(params, {
        ...specification.resolution === undefined ? {} : { resolution: specification.resolution },
        ...specification.quality === undefined ? {} : { quality: specification.quality },
      }))
        .toEqual([...new Set(specifications.filter(value => value.resolution === specification.resolution
          && value.quality === specification.quality).flatMap(value => value.seconds === undefined ? [] : [value.seconds]))])
      expect(resolveMediaSpecification(params.specifications, { ...specification, ratio: '9:16' }))
        .toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
      expect(resolveMediaSpecification(params.specifications, { ...specification, seconds: 30 }))
        .toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
    }
    if (input.model_name === 'ycapi-seedance-2-0-official') {
      expect(resolveMediaSpecification(params.specifications, { resolution: '480p', seconds: 5, quality: 'fast' }))
        .toMatchObject({ ok: false, code: 'SPECIFICATION_NOT_SUPPORTED' })
      expect(resolveMediaSpecification(params.specifications, { resolution: '720p', seconds: 5 }))
        .toMatchObject({ ok: false, code: 'SPECIFICATION_REQUIRED' })
    }
  })
})

describe('independent H3 input limits beside native duration alternatives', () => {
  const native = (() => {
    const input = fixture.cases.find(value => value.case_id === 'MiniMax-H3/live-unmodified')
    if (input === undefined) throw new Error('Missing actual-Go native H3 parameters')
    return input.parameters
  })()
  function params(properties: Readonly<Record<string, unknown>>, extra: Readonly<Record<string, unknown>> = {}): VideoParams {
    const [model] = catalogFromPricing([{ model_name: 'MiniMax-H3', kind: 'video',
      parameters: { ...native, ...extra, properties: { ...native.properties, ...properties } } }], null)
    if (model === undefined || model.kind !== 'video') throw new Error('Expected H3 capability')
    return model.params as VideoParams
  }

  it.each(['frame_images', 'reference_images', 'reference_videos', 'reference_audios'])(
    'retains duration alternatives while independently restricting %s', (field) => {
      for (const declaration of [false, { maxItems: 0 }, { type: 'array', items: { type: 'string' }, maxItems: 1 }] as const) {
        const capability = params({ [field]: declaration })
        expect(capability.specifications).toBeUndefined()
        expect(videoDurations(capability, '768P')).toContain(30)
        expect(videoDurations(capability, '2K')).not.toContain(30)
        const name = { frame_images: 'maxFrameImages', reference_images: 'maxReferenceImages',
          reference_videos: 'maxReferenceVideos', reference_audios: 'maxReferenceAudios' } as const
        expect(capability[name[field as keyof typeof name]]).toBe(declaration === false ? 0 : declaration.maxItems)
      }
    },
  )

  it.each([
    { type: 'object', maxItems: 1 }, { type: 'array' }, { maxItems: -1 }, { maxItems: 1.5 }, { maxItems: 129 },
    { maxItems: 1, minItems: 1 }, { maxItems: 1, items: { type: 'object' } },
    { maxItems: 1, items: { type: 'string', enum: ['required-image'] } },
  ])('does not flatten unhandled input schema constraints: %j', (reference_images) => {
    const capability = params({ reference_images })
    expect(capability.specifications).toEqual([])
    expect(capability.durations).toEqual([])
  })

  it.each([
    { properties: { reference_images: { maxItems: 1 } }, required: ['reference_images'] },
    { properties: { quality: { const: 'pro' }, reference_images: { maxItems: 1 } } },
    { properties: { reference_images: { maxItems: 1 } }, 'x-task-plugin': { key: 'ycapi', api_version: 1, version: '1.0.0' } },
  ])('keeps complete parsing authoritative for additional restrictions: %j', ({ properties, ...extra }) => {
    expect(params(properties, extra).specifications).toEqual([])
  })
})
