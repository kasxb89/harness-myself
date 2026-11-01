import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseClientMediaDefaultsStatus, parseClientModelConfigStatus, ClientModelConfigError } from '../src/client-model-config.ts'
import { mediaDefaultSelection, MediaDefaultsCache, requireMediaDefault } from '../src/media-defaults.ts'
import { CreativeError } from '../src/creative-store.ts'
import { catalogFromPricing } from '../src/media.ts'
import actualStatus from './fixtures/announcement-banner-api/status.json' with { type: 'json' }

const status = (image = '', video = '') => ({ success: true, data: {
  client_model_config: { schema_version: 1, default_chat_model: 'chat', model_order: ['chat'] },
  client_media_defaults: { schema_version: 1, default_image_model: image, default_video_model: video },
} })
const catalog = catalogFromPricing([
  { model_name: 'image-a', supported_endpoint_types: ['image-generation'] },
  { model_name: 'image-b', supported_endpoint_types: ['image-generation'] },
  { model_name: 'MiniMax-H3', supported_endpoint_types: ['video-generation'] },
  { model_name: 'video-b', supported_endpoint_types: ['video-generation'] },
], null)
afterEach(() => { vi.useRealTimers() })

describe('public media defaults independent from legacy chat preferences', () => {
  it('consumes the actual public API status without changing legacy chat parsing', () => {
    expect(parseClientMediaDefaultsStatus(actualStatus)).toEqual({ defaultImageModel: 'yunshu-internal-gpt-image-2', defaultVideoModel: 'MiniMax-H3' })
    expect(parseClientModelConfigStatus(actualStatus)).toBeDefined()
  })
  it('preserves exact old chat configuration and distinguishes old/empty from configured defaults', () => {
    expect(parseClientModelConfigStatus(status('image-b', 'video-b'))).toEqual({ defaultChatModel: 'chat', modelOrder: ['chat'] })
    expect(parseClientMediaDefaultsStatus({ success: true, data: {} })).toBeUndefined()
    expect(parseClientMediaDefaultsStatus(status())).toEqual({ defaultImageModel: null, defaultVideoModel: null })
    expect(parseClientMediaDefaultsStatus(status('image-b', 'video-b')))
      .toEqual({ defaultImageModel: 'image-b', defaultVideoModel: 'video-b' })
  })
  it('refuses unknown versions, incomplete fields, control characters and extra fields', () => {
    for (const value of [null, {}, { schema_version: 2, default_image_model: '', default_video_model: '' },
      { ...status().data.client_media_defaults, default_image_model: ' padded' },
      { ...status().data.client_media_defaults, default_video_model: 'bad\nmodel' },
      { ...status().data.client_media_defaults, user_id: 7 }]) {
      expect(() => parseClientMediaDefaultsStatus({ success: true, data: { client_media_defaults: value } }))
        .toThrow(ClientModelConfigError)
    }
  })
  it('requires the configured ID to occur in the account same-modality intersection, never its title', () => {
    const visible = new Set(['image-a', 'image-b', 'MiniMax-H3', 'video-b'])
    expect(mediaDefaultSelection(undefined, 'image', catalog, visible)).toEqual({ model: 'image-a', configured: false, available: true })
    expect(mediaDefaultSelection(undefined, 'video', catalog, visible)).toEqual({ model: 'MiniMax-H3', configured: false, available: true })
    const defaults = parseClientMediaDefaultsStatus(status('image-b', 'video-b'))
    expect(requireMediaDefault(mediaDefaultSelection(defaults, 'image', catalog, visible))).toBe('image-b')
    expect(requireMediaDefault(mediaDefaultSelection(defaults, 'video', catalog, visible))).toBe('video-b')
    for (const selected of [mediaDefaultSelection(defaults, 'video', catalog, new Set(['MiniMax-H3'])),
      mediaDefaultSelection({ defaultImageModel: 'video-b', defaultVideoModel: null }, 'image', catalog, visible)]) {
      expect(() => requireMediaDefault(selected)).toThrow(expect.objectContaining({ code: 'DEFAULT_MEDIA_MODEL_UNAVAILABLE' }))
    }
  })
})

describe('owner-bound default status reads', () => {
  it('caches only the same owner and refreshes after TTL; an explicit clear also rereads', async () => {
    vi.useFakeTimers()
    const cache = new MediaDefaultsCache(30_000)
    const send = vi.fn(async () => Response.json(status('image-b', 'video-b')))
    const current = async () => {}
    const signal = new AbortController().signal
    await cache.read('owner-a', send, signal, current)
    await cache.read('owner-a', send, signal, current)
    expect(send).toHaveBeenCalledTimes(1)
    await cache.read('owner-b', send, signal, current)
    expect(send).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(30_001)
    await cache.read('owner-b', send, signal, current)
    cache.clear()
    await cache.read('owner-b', send, signal, current)
    expect(send).toHaveBeenCalledTimes(4)
  })
  it('does not publish a late owner response or silently replace an unavailable status with old defaults', async () => {
    const cache = new MediaDefaultsCache(30_000)
    let same = true
    const current = async () => { if (!same) throw new CreativeError('ACCOUNT_CHANGED', 409, 'changed') }
    const late = Promise.withResolvers<Response>()
    const promise = cache.read('owner-a', () => late.promise, new AbortController().signal, current)
    await Promise.resolve()
    same = false
    late.resolve(Response.json(status('image-b', 'video-b')))
    await expect(promise).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    const fresh = vi.fn(async () => Response.json({ success: true, data: {} }))
    expect(await cache.read('owner-b', fresh, new AbortController().signal, async () => {})).toBeUndefined()
    expect(fresh).toHaveBeenCalledTimes(1)
    cache.clear()
    await expect(cache.read('owner-b', async () => new Response('', { status: 503 }),
      new AbortController().signal, async () => {})).rejects.toMatchObject({ code: 'DEFAULT_MEDIA_CONFIG_UNAVAILABLE' })
    await expect(cache.read('owner-b', async () => Response.json(status('bad\nmodel')), new AbortController().signal,
      async () => {})).rejects.toMatchObject({ code: 'DEFAULT_MEDIA_CONFIG_UNAVAILABLE' })
  })
})
