import { describe, expect, it } from 'vitest'
import { catalogFromPricing, declaredModelKind, mediaModelIds, type AudioParams, type ImageParams, type VideoParams } from '../src/media.ts'

function capability(id: string, kind: 'image' | 'video' | 'audio', parameters: unknown) {
  const [model] = catalogFromPricing([{ model_name: id, kind, parameters }], null)
  if (model === undefined) throw new Error('Expected a model capability')
  return model
}

describe('explicit public model classification', () => {
  it('keeps conversational MiniMax names out of media and places speech separately', () => {
    const rows = [
      { model_name: 'ycapi-minimax-m3', supported_endpoint_types: ['openai'] },
      { model_name: 'ycapi-minimax-m3', kind: 'text' },
      { model_name: 'ycapi-gpt-4o-mini-tts' },
      { model_name: 'ycapi-gemini-3.1-flash-tts', modality: 'audio' },
      { model_name: 'ycapi-unknown-speech', supported_endpoint_types: ['openai-audio'] },
      { model_name: 'fixture-flux-chat', kind: 'chat' },
      { model_name: 'fixture-kling-chat', supported_endpoint_types: ['chat-completions'] },
    ]
    expect(mediaModelIds(rows)).toEqual(['ycapi-gpt-4o-mini-tts', 'ycapi-gemini-3.1-flash-tts', 'ycapi-unknown-speech'])
    expect(catalogFromPricing(rows, null).map(model => ({ id: model.id, kind: model.kind, route: model.route }))).toMatchInlineSnapshot(`
      [
        {
          "id": "ycapi-gpt-4o-mini-tts",
          "kind": "audio",
          "route": "/v1/audio/speech",
        },
        {
          "id": "ycapi-gemini-3.1-flash-tts",
          "kind": "audio",
          "route": "/v1/audio/speech",
        },
        {
          "id": "ycapi-unknown-speech",
          "kind": "audio",
          "route": "/v1/audio/speech",
        },
      ]
    `)
  })

  it.each([
    { kind: 'bogus' }, { kind: null }, { kind: [] }, { kind: 'image', modality: 'video' },
    { supported_endpoint_types: ['image-generation', 'openai-video'] },
  ])('does not guess a name when its public declaration is invalid: %j', (declaration) => {
    expect(declaredModelKind(declaration)).toBeNull()
    expect(catalogFromPricing([{ model_name: 'kling-video', ...declaration }], null)).toEqual([])
  })

  it('uses declarations before a conflicting model family and preserves absent declarations', () => {
    expect(declaredModelKind({ kind: 'image', modality: 'image' })).toBe('image')
    expect(declaredModelKind({})).toBeUndefined()
    expect(catalogFromPricing([{ model_name: 'fixture-minimax-video', kind: 'image' }], null)[0]?.kind).toBe('image')
    expect(catalogFromPricing([{ model_name: 'MiniMax-H3' }], null)[0]?.kind).toBe('video')
  })
})

describe('live limits override inherited image capabilities', () => {
  it('disables unsupported image count, edits, seed and formats despite Google family defaults', () => {
    const model = capability('ycapi-gemini-3.1-flash-image', 'image', { properties: {
      n: { type: 'integer', enum: [1], maximum: 1 }, reference_images: { type: 'array', maxItems: 0 },
      size: { const: '1024x1024' }, quality: { enum: ['max', 'pro'] },
      background: false, output_format: { enum: ['png'] }, moderation: { enum: [] }, seed: false,
    } })
    expect(model.params).toMatchObject({
      sizes: ['1024x1024'], maxCount: 1, maxEdits: 0, strictReferences: true,
      qualities: ['max', 'pro'], backgrounds: [], formats: ['png'], moderations: [], seed: false,
    })
  })

  it.each([false, { maximum: 0 }, { enum: [] }, { enum: [1, '2'] }, { enum: [1, '2'], maximum: 4 }, { const: '1', maximum: 4 }, { maximum: 129 }])('removes an invalid or disabled count instead of restoring the family: %j', (n) => {
    const params = capability('ycapi-flux-kontext', 'image', { n }).params as ImageParams
    expect(params.maxCount).toBe(0)
  })

  it('retains the existing family only when a limit is absent or merely typed', () => {
    const params = capability('ycapi-flux-kontext', 'image', { n: { type: 'integer' } }).params as ImageParams
    expect(params.maxCount).toBe(4)
    expect(params.maxEdits).toBe(4)
    expect(params.strictReferences).toBeUndefined()
  })
})

describe('image tool visibility from explicit live declarations', () => {
  it('marks only declared optional controls, including disabled menus, without claiming family verification', () => {
    const model = capability('ycapi-unknown-image', 'image', { properties: {
      quality: { enum: ['pro'] }, background: { enum: [] }, format: { enum: ['png'] }, moderation: false, seed: false,
    } })
    expect(model.verified).toBe(false)
    expect(model.notes).toEqual(['qualities', 'backgrounds', 'formats', 'moderations', 'seed'])
    expect(model.params).toMatchObject({ qualities: ['pro'], backgrounds: [], formats: ['png'], moderations: [], seed: false })
    const absent = capability('ycapi-flux-image', 'image', {})
    expect(absent.verified).toBe(false)
    expect(absent.notes).toEqual([])
    expect(absent.params).toMatchObject({ qualities: ['standard', 'fast', 'ultra'], seed: true })
  })

  it('marks complete specifications and their derived quality menu as explicitly available', () => {
    const model = capability('ycapi-unknown-image', 'image', { oneOf: [{ properties: {
      size: { const: '1:1' }, quality: { const: 'pro' },
    } }] })
    expect(model.verified).toBe(false)
    expect(model.notes).toEqual(['specifications', 'qualities'])
    expect(model.params).toMatchObject({ specifications: [{ size: '1:1', quality: 'pro' }], qualities: ['pro'] })
    expect(capability('ycapi-unknown-image', 'image', { oneOf: [] }).notes).toEqual(['specifications'])
  })
})

describe('live video input and output capabilities', () => {
  it('honors explicit zero/false restrictions and published quality independently from mode', () => {
    const params = capability('ycapi-kling-v4', 'video', { properties: {
      seconds: { enum: [5, 10] }, resolution: { enum: ['720p'] }, aspect_ratio: { enum: ['16:9'] },
      frame_images: { maxItems: 0 }, reference_images: false, reference_videos: { maxItems: 0 }, reference_audios: { maxItems: 0 },
      mode: { enum: [] }, quality: { enum: ['fast', 'standard'] }, seed: false,
      audio: { type: 'boolean', const: false }, generate_audio: false, watermark: false,
    } }).params as VideoParams
    expect(params).toMatchObject({
      maxFrameImages: 0, frameSlots: 0, maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0,
      modes: [], qualities: ['fast', 'standard'], seed: false, audio: false, audioOutput: 'unsupported', audioToggle: false, watermark: false,
    })
  })

  it('uses live media bounds, modes and audio controls when explicitly enabled', () => {
    const params = capability('MiniMax-H3', 'video', {
      frame_images: { maxItems: 1 }, reference_images: { maxItems: 2 }, reference_videos: { maxItems: 1 },
      reference_audios: { maxItems: 0 },
      mode: { enum: ['pro'] }, audio: { enum: [true] }, generate_audio: { type: 'boolean' },
      seed: { type: 'integer' }, mix_frames_and_references: { const: true },
    }).params as VideoParams
    expect(params).toMatchObject({ maxFrameImages: 1, frameSlots: 1, maxReferenceImages: 2, maxReferenceVideos: 1, maxReferenceAudios: 0,
      modes: ['pro'], audio: true, audioToggle: true, seed: true, mixFramesAndReferences: true })
  })
})

describe('complete media specification alternatives', () => {
  const branch = (quality: string, resolution: string, seconds: number) => ({ properties: {
    quality: { const: quality }, resolution: { const: resolution }, seconds: { const: seconds }, ratio: { const: '16:9' },
  } })

  it('preserves different qualities at the same resolution/duration without inventing other combinations', () => {
    const params = capability('ycapi-seedance-2-0-official', 'video', { oneOf: [
      branch('mini', '720p', 5), branch('fast', '720p', 5), branch('standard', '1080p', 10),
    ] }).params as VideoParams
    expect(params.specifications).toEqual([
      { resolution: '720p', seconds: 5, ratio: '16:9', quality: 'mini' },
      { resolution: '720p', seconds: 5, ratio: '16:9', quality: 'fast' },
      { resolution: '1080p', seconds: 10, ratio: '16:9', quality: 'standard' },
    ])
    expect(params.durationByResolution).toEqual({ '720p': [5], '1080p': [10] })
    expect(params.qualities).toEqual(['mini', 'fast', 'standard'])
    expect(params.specifications).not.toContainEqual({ resolution: '1080p', seconds: 5, ratio: '16:9', quality: 'fast' })
  })

  it('intersects parent menus and numeric bounds with each complete branch', () => {
    const params = capability('ycapi-video', 'video', { properties: { seconds: { maximum: 5 }, quality: { enum: ['fast'] } },
      oneOf: [branch('fast', '720p', 5), branch('fast', '1080p', 10), branch('mini', '720p', 5)],
    }).params as VideoParams
    // An individually excluded branch contributes no legal choice; it does not broaden the alternatives.
    expect(params.specifications).toEqual([{ resolution: '720p', seconds: 5, ratio: '16:9', quality: 'fast' }])
  })

  it('omits explicitly disabled optional dimensions while rejecting them when required or branched', () => {
    const make = (required: readonly string[] = [], mode: unknown = { enum: [] }) => ({
      properties: { mode }, required, oneOf: [branch('fast', '720p', 5)],
    })
    expect((capability('ycapi-video', 'video', make()).params as VideoParams).specifications).toEqual([
      { resolution: '720p', seconds: 5, ratio: '16:9', quality: 'fast' },
    ])
    expect((capability('ycapi-video', 'video', make([], false)).params as VideoParams).specifications).toHaveLength(1)
    expect((capability('ycapi-video', 'video', make(['mode'])).params as VideoParams).specifications).toEqual([])
    expect((capability('ycapi-video', 'video', { properties: { quality: { enum: [] } }, oneOf: [branch('fast', '720p', 5)] }).params as VideoParams).specifications).toEqual([])
  })

  it('expands a global finite duration menu with branch quality without dropping numeric values', () => {
    const params = capability('ycapi-video', 'video', {
      properties: { seconds: { enum: [5, 10] }, ratio: { const: '16:9' }, resolution: { const: '720p' } },
      oneOf: [{ properties: { quality: { const: 'fast' } } }],
    }).params as VideoParams
    expect(params.specifications).toEqual([
      { resolution: '720p', seconds: 5, ratio: '16:9', quality: 'fast' },
      { resolution: '720p', seconds: 10, ratio: '16:9', quality: 'fast' },
    ])
  })

  it('does not count duplicated enum values as additional oneOf matches', () => {
    const params = capability('ycapi-video', 'video', { oneOf: [{ properties: {
      quality: { enum: ['fast', 'fast'] }, resolution: { const: '720p' }, seconds: { const: 5 },
    } }] }).params as VideoParams
    expect(params.specifications).toEqual([{ resolution: '720p', seconds: 5, quality: 'fast' }])
  })

  it('removes duplicated oneOf tuples because they satisfy more than one alternative', () => {
    const params = capability('ycapi-video', 'video', { oneOf: [branch('fast', '720p', 5), branch('fast', '720p', 5)] }).params as VideoParams
    expect(params.specifications).toEqual([])
    expect(params.durations).toEqual([])
  })

  it('uses image quality and resolution from the same whole specification', () => {
    const params = capability('ycapi-flux-kontext', 'image', { oneOf: [
      { properties: { quality: { const: 'max' }, size: { const: '1024x1024' }, resolution: { const: '2k' } } },
      { properties: { quality: { const: 'pro' }, size: { const: '1024x1024' }, resolution: { const: '1k' } } },
    ] }).params as ImageParams
    expect(params.specifications).toEqual([{ size: '1024x1024', resolution: '2k', quality: 'max' }, { size: '1024x1024', resolution: '1k', quality: 'pro' }])
    expect(params.qualities).toEqual(['max', 'pro'])
    expect(params.resolutions).toEqual(['2k', '1k'])
  })

  it('normalizes image ratios to the standard size field without silently dropping conflicts or modes', () => {
    const params = capability('ycapi-image', 'image', { properties: { ratio: { const: '1:1' } }, oneOf: [
      { properties: { quality: { const: 'pro' } } },
    ] }).params as ImageParams
    expect(params.specifications).toEqual([{ size: '1:1', quality: 'pro' }])
    for (const properties of [
      { ratio: { const: '1:1' }, size: { const: '16:9' } },
      { mode: { const: 'pro' } }, { seconds: { const: 5 } },
    ]) {
      expect((capability('ycapi-image', 'image', { oneOf: [{ properties }] }).params as ImageParams).specifications).toEqual([])
    }
  })

  it.each([
    { oneOf: [{ properties: { quality: { const: 'fast' }, seconds: { enum: ['5'] } } }] },
    { oneOf: [{ properties: { quality: { const: 'fast' }, seconds: { enum: [5] } } }, { properties: { seconds: { enum: [10] } } }] },
    { oneOf: Array.from({ length: 129 }, () => branch('fast', '720p', 5)) },
    { oneOf: [{ properties: { quality: { enum: Array.from({ length: 64 }, (_, index) => `q${index}`) }, seconds: { minimum: 1, maximum: 10 } } }] },
  ])('keeps malformed or oversized complete declarations unavailable: %j', (parameters) => {
    const params = capability('ycapi-video', 'video', parameters).params as VideoParams
    expect(params.specifications).toEqual([])
    expect(params.durations).toEqual([])
  })
})

describe('declared speech capabilities', () => {
  const execution = { protocol: 'openai-speech-v1', quoteRoute: '/v1/audio/quote', taskRoute: '/v1/tasks' }
  const parameters = { properties: {
    voice: { enum: ['voice-a', 'voice-b'] }, response_format: { enum: ['wav'] }, input: { maxLength: 2000 },
    speed: { minimum: 0.5, maximum: 2 }, instructions: { type: 'string' },
  }, x_client_audio_execution: execution }

  it('exposes only declared voices, formats, input bounds and protocol', () => {
    const model = capability('ycapi-gemini-tts', 'audio', parameters)
    expect(model.params).toEqual({ voices: ['voice-a', 'voice-b'], formats: ['wav'], maxCharacters: 2000,
      speedRange: { minimum: 0.5, maximum: 2 }, instructions: true, execution })
    expect(model.verified).toBe(true)
  })

  it('does not grant speech execution from a model name or undeclared voices', () => {
    const params = capability('ycapi-gpt-4o-mini-tts', 'audio', {}).params as AudioParams
    expect(params).toEqual({ voices: [], formats: [], maxCharacters: 0, instructions: false })
  })

  it.each([
    { ...execution, quoteRoute: '/api/ycapi/quote-preview' }, { ...execution, taskRoute: 'https://other.invalid/tasks' },
    { ...execution, protocol: 'raw-provider' }, { ...execution, lane: 'hidden' },
  ])('rejects non-public execution declarations: %j', (x_client_audio_execution) => {
    const params = capability('ycapi-tts', 'audio', { ...parameters, x_client_audio_execution }).params as AudioParams
    expect(params.execution).toBeUndefined()
  })
})
