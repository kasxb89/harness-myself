// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateAudio, quoteAudio, readAudioModels, readAudioSubmissions, recoverAudio } from '../src/client/audio-api.ts'

const request = { model: 'speech-demo', input: '你好', voice: 'calm', response_format: 'wav' as const }
const id = '09bcae45-e147-4b03-8afc-6b32cdcaf384'
const signal = (): AbortSignal => new AbortController().signal
afterEach(() => { vi.unstubAllGlobals() })

describe('same-origin speech transport', () => {
  it('discovers only explicitly declared audio and never calls private catalog endpoints', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true, accountId: 'owner-1', models: [{ id: request.model,
      displayName: 'Speech', kind: 'audio', route: '/v1/audio/speech', params: { voices: ['calm'], formats: ['wav'],
        maxCharacters: 2000, instructions: false } }] }))
    vi.stubGlobal('fetch', fetch)
    const result = await readAudioModels(signal())
    expect(result.ok).toBe(true)
    expect(fetch.mock.calls[0]?.[0]).toBe('/credits/api/audio/models')
  })
  it('submits exactly one POST with account, chat, quote, and submission identity', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true, submissionId: id, model: request.model, status: 'pending' }))
    vi.stubGlobal('fetch', fetch)
    expect((await generateAudio('owner-1', 'chat-1', request, 'quote-1', id, signal())).ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    const init = fetch.mock.calls[0]?.[1]
    expect(init?.method).toBe('POST')
    if (typeof init?.body !== 'string') throw new Error('Expected an audio JSON request body')
    expect(JSON.parse(init.body)).toEqual({ account_id: 'owner-1', session_id: 'chat-1', ...request,
      quote_id: 'quote-1', submission_id: id })
  })
  it('validates same-chat saved audio URLs and rejects other-chat or remote destinations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true,
      submissions: [{ submissionId: id, model: request.model,
        status: 'completed', filename: 'audio.wav', mediaUrl: `/credits/api/audio/content?session_id=chat-1&submission_id=${id}` }] }))
    vi.stubGlobal('fetch', fetch)
    expect((await readAudioSubmissions('owner-1', 'chat-1', signal())).ok).toBe(true)
    expect((await readAudioSubmissions('owner-1', 'chat-2', signal())).ok).toBe(false)
    fetch.mockImplementationOnce(async () => Response.json({ ok: true, submissions: [{ submissionId: id, model: request.model,
      status: 'completed', mediaUrl: 'https://private-provider.invalid/secret' }] }))
    expect((await readAudioSubmissions('owner-1', 'chat-1', signal())).ok).toBe(false)
  })
  it('rejects charged, expired and malformed estimates', async () => {
    const now = Math.floor(Date.now() / 1000)
    const quote = { object: 'audio.quote', schema_version: 1, quote_id: 'quote-1', account_binding: 'opaque-owner',
      model: request.model, request_fingerprint: 'a'.repeat(64), total_quota: 2, estimated_total: '0.002', currency: 'CNY',
      pricing_revision: 'rev-1', created_at: now, expires_at: now + 60, estimate_only: true, charged: false, submitted: false, reserved: false }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true, quote }))
    vi.stubGlobal('fetch', fetch)
    expect((await quoteAudio('owner-1', 'chat-1', request, signal())).ok).toBe(true)
    for (const invalid of [{ ...quote, charged: true }, { ...quote, estimated_total: 'NaN' },
      { ...quote, created_at: now - 61, expires_at: now - 1 }]) {
      fetch.mockImplementationOnce(async () => Response.json({ ok: true, quote: invalid }))
      expect(await quoteAudio('owner-1', 'chat-1', request, signal())).toEqual({ ok: false, code: 'AUDIO_RESPONSE_INVALID' })
    }
  })
  it('queries an original submission without dispatching a generate request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true, submissionId: id, model: request.model, status: 'unknown' }))
    vi.stubGlobal('fetch', fetch)
    expect((await recoverAudio('owner-1', 'chat-1', id, signal())).ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('/credits/api/audio/recover')
  })
  it('contains malformed JSON and non-string status without calling them network errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{invalid', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await readAudioModels(signal())).toEqual({ ok: false, code: 'AUDIO_RESPONSE_INVALID' })
    fetch.mockImplementationOnce(async () => Response.json({ ok: true, submissions: [{ submissionId: id,
      model: request.model, status: { toString: 1 } }] }))
    expect(await readAudioSubmissions('owner-1', 'chat-1', signal())).toEqual({ ok: false, code: 'AUDIO_RESPONSE_INVALID' })
    fetch.mockImplementationOnce(async () => new Response('busy', { status: 429 }))
    expect(await readAudioModels(signal())).toEqual({ ok: false, code: 'AUDIO_BUSY' })
  })
})
