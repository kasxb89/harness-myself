import { describe, expect, it } from 'vitest'
import { catalogFromPricing, videoDurations, type VideoParams } from '../src/media.ts'

describe('internal image capability', () => {
  it('offers six references on the internal task route without granting edits to text-only models', () => {
    const catalog = catalogFromPricing([
      { model_name: 'yunshu-internal-gpt-image-2', supported_endpoint_types: ['image-generation'] },
      { model_name: 'wanx2.1-t2i-turbo', supported_endpoint_types: ['image-generation'] },
    ], null)
    expect(catalog).toMatchObject([
      { id: 'yunshu-internal-gpt-image-2', route: '/toapis/v1/images/generations', params: {
        maxCount: 1, maxEdits: 6, sizes: [], qualities: [], backgrounds: [], formats: [], moderations: [], seed: false,
      } },
      { id: 'wanx2.1-t2i-turbo', params: { maxEdits: 0 } },
    ])
  })
})

function video(fields: Record<string, unknown> = {}): VideoParams {
  const [model] = catalogFromPricing([{
    model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'], enable_groups: ['product'], ...fields,
  }], 'product')
  if (model === undefined) throw new Error('Expected the video capability')
  return model.params as VideoParams
}

describe('explicit live video parameters', () => {
  it('selects the H3 task API while retaining explicit routes and other video protocols', () => {
    const catalog = catalogFromPricing([
      { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'] },
      { model_name: 'MiniMax-H3', supported_endpoint_types: ['openai-video'], route: '/plugin/video/tasks' },
      { model_name: 'fixture-video', supported_endpoint_types: ['openai-video'] },
    ], null)
    expect(catalog.map(model => model.route)).toEqual(['/v1/video/generations', '/plugin/video/tasks', '/v1/videos'])
  })

  it('retains known limits when the old pricing response declares no bounded duration', () => {
    const params = video({
      billing_usage_schema: { seconds: { type: 'number' }, resolution: { enum: ['768P', '2K'] } },
      billing_usage_examples: [{ facts: { seconds: 30, input_images: 90, input_video_seconds: 60 } }],
    })
    expect(params.durations).toEqual(Array.from({ length: 12 }, (_, index) => index + 4))
    expect(params).toMatchObject({ resolutions: ['768P', '2K'], maxReferenceImages: 9, maxReferenceVideos: 3 })
    expect(videoDurations(params, '768P')).not.toContain(30)
  })

  it('accepts a bounded published duration and lets explicit parameters override billing declarations', () => {
    const params = video({
      billing_usage_schema: { seconds: { enum: [4, 5, 15] }, resolution: { enum: ['768P'] } },
      parameters: { type: 'object', properties: {
        duration: { type: 'integer', minimum: 4, maximum: 30 }, resolution: { enum: ['480P', '768P', '1080P', '2K'] },
      } },
    })
    expect(params.durations).toEqual(Array.from({ length: 27 }, (_, index) => index + 4))
    expect(params.resolutions).toEqual(['480P', '768P', '1080P', '2K'])
    expect(params.maxDuration).toBe(30)
  })

  it('accepts direct numeric enums in the existing billing schema', () => {
    const params = video({ billing_usage_schema: { seconds: { enum: [30, 5, 15, 5] } } })
    expect(params.durations).toEqual([5, 15, 30])
  })

  it.each([
    { minimum: 4 }, { maximum: 30 }, { minimum: 0, maximum: 30 },
    { minimum: 4, maximum: 3601 }, { minimum: 4, maximum: Infinity }, { enum: '30', minimum: 4, maximum: 30 },
    { enum: [5, 30], exclusiveMaximum: true }, { minimum: 4, maximum: 30, multipleOf: 0 },
    { enum: [] }, { enum: ['30'] }, { enum: [4, 15.5] }, { enum: [4, NaN] }, { enum: [4, 3601] },
  ])('keeps the known menu for an invalid or unbounded declaration: %j', (seconds) => {
    expect(video({ parameters: { seconds } }).maxDuration).toBe(15)
  })

  it('intersects duration enums with inclusive, exclusive and multiple constraints', () => {
    expect(video({ parameters: { seconds: { enum: [5, 10, 15, 30], minimum: 4, maximum: 15 } } }).durations).toEqual([5, 10, 15])
    const exclusive = video({ parameters: { seconds: { enum: [5, 10, 15, 30], exclusiveMinimum: 5, exclusiveMaximum: 30 } } })
    expect(exclusive.durations).toEqual([10, 15])
    expect(video({ parameters: { seconds: { minimum: 4, maximum: 30, multipleOf: 5 } } }).durations).toEqual([5, 10, 15, 20, 25, 30])
    expect(video({ parameters: { seconds: { minimum: 4.5, exclusiveMaximum: 8 } } }).durations).toEqual([5, 6, 7])
    expect(video({ parameters: { seconds: { enum: [30], maximum: 15 } } }).durations).toEqual([])
    expect(video({ parameters: { seconds: { minimum: 30, maximum: 4 } } }).durations).toEqual([])
  })

  it('intersects a global resolution const with branch enums', () => {
    const params = video({ parameters: { properties: { resolution: { const: '768P' } }, oneOf: [
      { properties: { resolution: { enum: ['480P', '768P'] }, seconds: { minimum: 4, maximum: 30 } } },
    ] } })
    expect(params.resolutions).toEqual(['768P'])
    expect(videoDurations(params, '480P')).toEqual([])
    expect(videoDurations(params, '768P')).toContain(30)
  })

  it('does not offer outputs when global resolution constraints have no intersection', () => {
    const params = video({ parameters: { resolution: { const: '768P', enum: ['480P'] }, seconds: { minimum: 4, maximum: 30 } } })
    expect(params.resolutions).toEqual([])
    expect(params.durations).toEqual([])
  })

  it('preserves explicit resolution-specific menus and rejects missing resolution keys', () => {
    const params = video({ billing_usage_schema: { seconds: { enum: [4, 5, 15] }, resolution: { enum: ['768P', '2K'] } }, parameters: {
      type: 'object', properties: { resolution: { enum: ['480P', '768P', '1080P', '2K'] } },
      oneOf: [
        { properties: { resolution: { enum: ['480P', '768P'] }, seconds: { minimum: 4, maximum: 30 } } },
        { properties: { resolution: { const: '1080P' }, duration: { enum: [5, 10, 15] } } },
        { properties: { resolution: { const: '2K' }, seconds: { minimum: 4, maximum: 15 } } },
      ],
    } })
    expect(videoDurations(params, '480P')).toContain(30)
    expect(videoDurations(params, '768P')).toContain(30)
    expect(videoDurations(params, '1080P')).toEqual([5, 10, 15])
    expect(videoDurations(params, '2K')).not.toContain(30)
    expect(videoDurations(params, null)).toEqual([])
    expect(videoDurations(params, '4K')).toEqual([])
    expect(videoDurations(params, 'constructor')).toEqual([])
    expect({ min: params.minDuration, max: params.maxDuration, resolutions: params.resolutions,
      highResolutionSeconds: videoDurations(params, '1080P') }).toMatchInlineSnapshot(`
      {
        "highResolutionSeconds": [
          5,
          10,
          15,
        ],
        "max": 30,
        "min": 4,
        "resolutions": [
          "480P",
          "768P",
          "1080P",
          "2K",
        ],
      }
    `)
  })

  it('intersects branch durations with explicit global bounds', () => {
    const params = video({ parameters: {
      properties: { seconds: { minimum: 4, maximum: 20 } },
      oneOf: [{ properties: { resolution: { const: '480P' }, seconds: { minimum: 4, maximum: 30 } } }],
    } })
    expect(videoDurations(params, '480P')).toHaveLength(17)
    expect(params.maxDuration).toBe(20)
  })

  it('inherits single-sided parent bounds into finite resolution branch menus', () => {
    const params = video({ parameters: {
      properties: { seconds: { maximum: 15 } },
      oneOf: [{ properties: { resolution: { const: '768P' }, seconds: { minimum: 4, maximum: 30 } } }],
    } })
    expect(videoDurations(params, '768P')).toEqual(Array.from({ length: 12 }, (_, index) => index + 4))
    expect(params.maxDuration).toBe(15)
    expect(video({ parameters: { seconds: { maximum: 10 } } }).durations).toEqual([4, 5, 6, 7, 8, 9, 10])
  })

  it('does not treat incomplete branches as permission for new durations', () => {
    const params = video({ parameters: { oneOf: [
      { properties: { resolution: { const: '480P' }, seconds: { minimum: 4, maximum: 30 } } },
      { properties: { resolution: { const: '2K' } } },
    ] } })
    expect(params.durationByResolution).toBeUndefined()
    expect(params.maxDuration).toBe(15)
  })
})
