/** Host wire parsing and complete-specification controls for personal media preferences. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePreferenceReply, preferenceFields, requestPreferences, validPreferenceSelection, type PreferenceModel } from '../src/client/media-preferences.ts'

const metadata = { schema_version: 1, scope: 'b'.repeat(64), revision: 'c'.repeat(64), image: null, video: null }
const model: PreferenceModel = { id: 'video-one', displayName: 'Video One', kind: 'video', source: 'fixture', verified: true, notes: [], params: {
  specifications: [{ resolution: '768P', seconds: 15, ratio: '16:9', mode: 'fast' }, { resolution: '2K', seconds: 5, ratio: '9:16', mode: 'quality' }],
  resolutions: ['768P', '2K'], durations: [5, 15], ratios: ['16:9', '9:16'], modes: ['fast', 'quality'], seed: true, audioToggle: true } }
const answer = (payload: unknown = metadata) => ({ ok: true, account: { id: '7' }, accountOwner: 'a'.repeat(64), payload })
afterEach(() => { vi.unstubAllGlobals() })

describe('personal media preference wire reads', () => {
  it('requires complete metadata and catalogs owned by the authenticated account', () => {
    expect(decodePreferenceReply(answer())).toMatchObject({ ok: true, reply: { accountId: '7', preferences: metadata } })
    expect(decodePreferenceReply(answer({ ...metadata, revision: 'wrong' }))).toEqual({ ok: false, failure: 'unavailable' })
    const nestedParameter = { model: 'picture', parameters: { local_path: {} } }
    expect(decodePreferenceReply(answer({ ...metadata, image: nestedParameter })))
      .toEqual({ ok: false, failure: 'unavailable' })
    expect(decodePreferenceReply(answer(), true)).toEqual({ ok: false, failure: 'unavailable' })
    const payload = { ...metadata, catalog: { image: [], video: [model] }, defaults: {
      image: { model: null, configured: false, available: false },
      video: { model: model.id, configured: true, available: true },
    } }
    expect(decodePreferenceReply(answer(payload), true)).toMatchObject({ ok: true, reply: { catalog: { video: [model] } } })
    expect(decodePreferenceReply(answer({ ...payload, catalog: { image: [model], video: [] } }), true).ok).toBe(false)
    expect(decodePreferenceReply({ ok: false, code: 'MEDIA_PREFERENCES_CONFLICT' })).toEqual({ ok: false, failure: 'conflict' })
  })
  it('uses PUT with CAS fields and distinguishes a network interruption', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(answer()))
    vi.stubGlobal('fetch', fetcher)
    const body = { schema_version: 1, expected_account_owner: 'a'.repeat(64), expected_revision: 'c'.repeat(64), image: null, video: { model: model.id, parameters: {} } }
    expect((await requestPreferences('save', new AbortController().signal, body)).ok).toBe(true)
    expect(fetcher.mock.calls[0]).toMatchObject(['/credits/api/media/preferences', { method: 'PUT', body: JSON.stringify(body) }])
    fetcher.mockRejectedValueOnce(new TypeError('offline'))
    expect(await requestPreferences('catalog', new AbortController().signal)).toEqual({ ok: false, failure: 'network' })
    fetcher.mockResolvedValueOnce(Response.json({ ok: true }, { status: 500 }))
    expect((await requestPreferences('read', new AbortController().signal)).ok).toBe(false)
  })
})

describe('declared specification choices', () => {
  it('filters linked parameters without manufacturing unsupported combinations', () => {
    const fields = preferenceFields(model, { resolution: '2K' })
    expect(fields.find(field => field.key === 'seconds')?.values).toEqual([5])
    expect(fields.find(field => field.key === 'ratio')?.values).toEqual(['9:16'])
    expect(validPreferenceSelection(model, { model: model.id, parameters: { resolution: '2K', seconds: 15 } })).toBe(false)
    expect(validPreferenceSelection(model, { model: model.id, parameters: { resolution: '2K', seconds: 5, ratio: '9:16' } })).toBe(true)
    expect(validPreferenceSelection(model, { model: model.id, parameters: {} })).toBe(true)
    expect(validPreferenceSelection(undefined, { model: 'disabled', parameters: {} })).toBe(false)
    expect(validPreferenceSelection(model, { model: model.id, parameters: { seed: -1 } })).toBe(true)
    expect(validPreferenceSelection(model, { model: model.id, parameters: { audio: false, seed: 7 } })).toBe(true)
    expect(validPreferenceSelection(model, { model: model.id, parameters: { prompt: 'unsaved' } })).toBe(false)
  })
  it('uses legacy duration-by-resolution and only declared image controls', () => {
    const legacy = { ...model, params: { resolutions: ['720P', '1080P'], durations: [5, 10], durationByResolution: { '720P': [5, 10], '1080P': [5] } } }
    expect(preferenceFields(legacy, { resolution: '1080P' }).find(field => field.key === 'seconds')?.values).toEqual([5])
    const image: PreferenceModel = { ...model, kind: 'image', params: { sizes: ['1:1'], maxCount: 1, backgrounds: ['transparent'], formats: ['png'] } }
    expect(preferenceFields(image, {}).map(field => field.key)).toEqual(['size', 'background', 'format', 'count'])
    expect(validPreferenceSelection(image, { model: image.id, parameters: { count: 2 } })).toBe(false)
  })
})
