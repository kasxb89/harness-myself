import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { audioRequestFingerprint, parseAudioQuote, readAudioTask, submitAudio, validateAudioRequest,
  type AudioReceipt, type AudioRequest } from '../src/audio-generation.ts'
import type { ModelCapability } from '../src/media.ts'

const request: AudioRequest = { model: 'speech-demo', input: '你好', voice: 'calm', response_format: 'wav' }
const capability: ModelCapability = { id: request.model, kind: 'audio', displayName: 'Speech', groups: [], route: '/v1/audio/speech',
  source: 'newapi', notes: [], verified: true, params: { voices: ['calm'], formats: ['wav'], maxCharacters: 2000,
    instructions: false, execution: { protocol: 'openai-speech-v1', quoteRoute: '/v1/audio/quote', taskRoute: '/v1/tasks' } } }
const signal = (): AbortSignal => new AbortController().signal
const wav = Buffer.from('RIFF0000WAVEdata')
function quote(): Record<string, unknown> {
  return { object: 'audio.quote', schema_version: 1, quote_id: 'quote-1', account_binding: 'opaque-owner', model: request.model,
    request_fingerprint: audioRequestFingerprint(request), total_quota: 123, estimated_total: '0.0123', currency: 'CNY',
    pricing_revision: 'rev-1', created_at: 1000, expires_at: 1060, estimate_only: true, charged: false, submitted: false, reserved: false }
}

describe('speech request authorization and exact estimates', () => {
  it('requires execution readiness and model-specific voices, formats, limits and knobs', () => {
    expect(validateAudioRequest(request, capability)).toEqual(request)
    for (const invalid of [{ ...request, voice: 'foreign' }, { ...request, response_format: 'mp3' },
      { ...request, input: 'a'.repeat(2001) }, { ...request, speed: 1 }, { ...request, instructions: 'whisper' },
      { ...request, upstream_url: 'https://private.invalid' }]) expect(validateAudioRequest(invalid, capability)).toBeNull()
    expect(validateAudioRequest(request, { ...capability, params: { voices: ['calm'], formats: ['wav'], maxCharacters: 2000, instructions: false } })).toBeNull()
  })
  it('binds all parameters and exact text to a sixty-second, free quote', () => {
    expect(parseAudioQuote(quote(), { request, now: 1030 })?.estimated_total).toBe('0.0123')
    expect(parseAudioQuote(quote(), { request: { ...request, input: '不同文本' }, now: 1030 })).toBeNull()
    expect(parseAudioQuote(quote(), { request, now: 1060 })).toBeNull()
    expect(parseAudioQuote({ ...quote(), charged: true }, { request, now: 1030 })).toBeNull()
    expect(parseAudioQuote({ ...quote(), expires_at: 1061 }, { request, now: 1030 })).toBeNull()
    expect(parseAudioQuote({ ...quote(), procurement: 3 }, { request, now: 1030 })).toBeNull()
    expect(parseAudioQuote(quote(), { request, now: 1030, accountBinding: 'another-owner' })).toBeNull()
  })
})

describe('speech dispatch and original-task recovery', () => {
  it('accepts bounded binary audio, not JSON or HTML masquerading as a file', async () => {
    const submit = vi.fn(async () => new Response(wav, { headers: { 'content-type': 'audio/wav' } }))
    const result = await submitAudio({ request, signal: signal(), maxBytes: 1024, submit })
    expect(result.status).toBe('completed')
    expect(submit).toHaveBeenCalledTimes(1)
    const invalid = await submitAudio({ request, signal: signal(), maxBytes: 1024,
      submit: async () => new Response('<html>private exception</html>') })
    expect(invalid).toEqual({ status: 'unknown', code: 'AUDIO_RESPONSE_INVALID' })
  })
  it('retains an accepted task and reads that exact task without a second POST', async () => {
    const submit = vi.fn(async () => Response.json({ task_id: 'task_123', status: 'queued' }, { status: 202 }))
    expect(await submitAudio({ request, signal: signal(), maxBytes: 1024, submit })).toEqual({ status: 'pending', taskId: 'task_123' })
    const read = vi.fn(async () => Response.json({ task_id: 'task_123', status: 'completed',
      result: { audio: { data: wav.toString('base64'), format: 'wav' } } }))
    const result = await readAudioTask('task_123', { request, signal: signal(), maxBytes: 1024, read })
    expect(result.status).toBe('completed'); expect(read).toHaveBeenCalledWith('task_123', expect.any(AbortSignal))
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('keeps timeout and network outcomes unknown, without retrying or leaking provider errors', async () => {
    const submit = vi.fn(async () => { throw new DOMException('secret-token', 'TimeoutError') })
    expect(await submitAudio({ request, signal: signal(), maxBytes: 1024, submit })).toEqual({ status: 'unknown', code: 'AUDIO_TIMEOUT' })
    expect(submit).toHaveBeenCalledTimes(1)
    const read = vi.fn(async () => { throw new TypeError('private provider URL') })
    expect(await readAudioTask('task_123', { request, signal: signal(), maxBytes: 1024, read }))
      .toEqual({ status: 'unknown', taskId: 'task_123', code: 'AUDIO_NETWORK' })
  })
  it('bounds response allocation and rejects task identity substitution', async () => {
    expect(await submitAudio({ request, signal: signal(), maxBytes: 4,
      submit: async () => new Response(wav) })).toEqual({ status: 'unknown', code: 'AUDIO_TOO_LARGE' })
    expect(await readAudioTask('task_123', { request, signal: signal(), maxBytes: 1024,
      read: async () => Response.json({ task_id: 'task_other', status: 'failed' }) }))
      .toEqual({ status: 'unknown', taskId: 'task_123', code: 'AUDIO_RESPONSE_INVALID' })
  })
  it('does not claim refunds or repeat generation when an upstream task fails', async () => {
    expect(await readAudioTask('task_123', { request, signal: signal(), maxBytes: 1024,
      read: async () => Response.json({ task_id: 'task_123', status: 'failed', fail_reason: 'sensitive-provider-error' }) }))
      .toEqual({ status: 'failed', taskId: 'task_123', code: 'AUDIO_TASK_FAILED', billing: 'unknown' })
    expect(await submitAudio({ request, signal: signal(), maxBytes: 1024,
      submit: async () => new Response('sensitive-provider-error', { status: 429 }) }))
      .toEqual({ status: 'unknown', code: 'AUDIO_BUSY' })
  })
  it('does not dispatch after local cancellation', async () => {
    const abort = new AbortController(); abort.abort()
    const submit = vi.fn(async () => new Response(wav))
    expect(await submitAudio({ request, signal: abort.signal, maxBytes: 1024, submit }))
      .toEqual({ status: 'failed', code: 'AUDIO_CANCELLED', billing: 'unknown' })
    expect(submit).not.toHaveBeenCalled()
  })
  it('distinguishes confirmed product balance from upstream quota, parameters, busy and service errors', async () => {
    for (const [status, body, code] of [
      [403, { code: 'insufficient_user_quota' }, 'AUDIO_BALANCE'],
      [403, { error: { code: 'insufficient_user_quota', type: 'new_api_error' } }, 'AUDIO_BALANCE'],
      [403, { error: { code: 'insufficient_quota', type: 'upstream_error', message: 'secret' } }, 'AUDIO_PERMISSION'],
      [400, { error: { message: 'secret' } }, 'AUDIO_INVALID_REQUEST'],
      [429, {}, 'AUDIO_BUSY'], [408, {}, 'AUDIO_TIMEOUT'], [502, {}, 'AUDIO_UNAVAILABLE'],
    ] as const) {
      expect(await submitAudio({ request, signal: signal(), maxBytes: 1024,
        submit: async () => Response.json(body, { status }) })).toEqual({ status: 'unknown', code })
    }
  })
  it('retains known paid-task coordinates when completed audio is malformed', async () => {
    const received = vi.fn(async (_receipt: AudioReceipt) => {})
    const result = await submitAudio({ request, signal: signal(), maxBytes: 1024, received,
      submit: async () => Response.json({ task_id: 'known-paid-task', model: request.model, status: 'completed',
        result: { audio: { format: 'wav', data: 'AAAA' } } }, { headers: { 'x-request-id': 'known-request' } }) })
    expect(result).toEqual({ status: 'unknown', taskId: 'known-paid-task', requestId: 'known-request', code: 'AUDIO_RESPONSE_INVALID' })
    expect(received.mock.calls.map(([receipt]) => receipt)).toEqual([
      { requestId: 'known-request' }, { requestId: 'known-request', taskId: 'known-paid-task' },
    ])
  })
  it('returns observed coordinates when their durable checkpoint fails, before decoding any audio', async () => {
    const received = vi.fn(async (receipt: AudioReceipt) => {
      if (receipt.taskId !== undefined) throw new Error('Synthetic private state write failure')
    })
    const result = await submitAudio({ request, signal: signal(), maxBytes: 1024, received,
      submit: async () => Response.json({ task_id: 'known-paid-task', model: request.model, status: 'completed',
        result: { audio: { format: 'wav', data: 'AAAA' } } }, { headers: { 'x-request-id': 'known-request' } }) })
    expect(result).toEqual({ status: 'unknown', taskId: 'known-paid-task', requestId: 'known-request', code: 'AUDIO_OPERATION_FAILED' })
    expect(received).toHaveBeenCalledTimes(2)
  })
  it('keeps validated request coordinates if reading the response fails', async () => {
    const received = vi.fn(async (_receipt: AudioReceipt) => {})
    const result = await submitAudio({ request, signal: signal(), maxBytes: 4, received,
      submit: async () => new Response(wav, { headers: { 'x-request-id': 'known-request' } }) })
    expect(result).toEqual({ status: 'unknown', requestId: 'known-request', code: 'AUDIO_TOO_LARGE' })
    expect(received).toHaveBeenCalledWith({ requestId: 'known-request' })
  })
  it('releases unread audio when the request checkpoint fails', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(wav) }, cancel })
    const result = await submitAudio({ request, signal: signal(), maxBytes: 1024,
      submit: async () => new Response(stream, { headers: { 'x-request-id': 'known-request' } }),
      received: async () => { throw new Error('Synthetic checkpoint unavailable') } })
    expect(result).toEqual({ status: 'unknown', requestId: 'known-request', code: 'AUDIO_OPERATION_FAILED' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('persists original-task coordinates before a local save fails and recovers only that task', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-audio-receipt-'))
    const checkpoint = join(directory, 'receipt.json')
    const unavailableOutput = join(directory, 'blocked.wav')
    const submit = vi.fn(async () => Response.json({ task_id: 'known-paid-task', model: request.model, status: 'completed',
      result: { audio: { format: 'wav', data: wav.toString('base64') } } }, { headers: { 'x-request-id': 'known-request' } }))
    try {
      await mkdir(unavailableOutput)
      const result = await submitAudio({ request, signal: signal(), maxBytes: 1024, submit,
        received: async (receipt) => { await writeFile(checkpoint, JSON.stringify(receipt), { mode: 0o600 }) } })
      expect(result).toMatchObject({ status: 'completed', taskId: 'known-paid-task', requestId: 'known-request' })
      if (result.status !== 'completed') throw new Error('Expected original audio bytes')
      await expect(writeFile(unavailableOutput, result.bytes)).rejects.toMatchObject({ code: 'EISDIR' })
      const retained: unknown = JSON.parse(await readFile(checkpoint, 'utf8'))
      expect(retained).toEqual({ taskId: 'known-paid-task', requestId: 'known-request' })
      const read = vi.fn(async () => new Response(wav, { headers: { 'x-request-id': 'recovery-request' } }))
      const recovered = await readAudioTask(result.taskId ?? '', { request, signal: signal(), maxBytes: 1024, read })
      expect(recovered).toMatchObject({ status: 'completed', taskId: 'known-paid-task', requestId: 'recovery-request' })
      expect(submit).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalledWith('known-paid-task', expect.any(AbortSignal))
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('does not persist a replacement task from another model', async () => {
    const received = vi.fn(async (_receipt: AudioReceipt) => {})
    const result = await readAudioTask('known-paid-task', { request, signal: signal(), maxBytes: 1024, received,
      read: async () => Response.json({ task_id: 'other-task', model: 'other-model', status: 'completed',
        result: { audio: { format: 'wav', data: wav.toString('base64') } } }, { headers: { 'x-request-id': 'known-request' } }) })
    expect(result).toEqual({ status: 'unknown', taskId: 'known-paid-task', requestId: 'known-request', code: 'AUDIO_RESPONSE_INVALID' })
    expect(received.mock.calls.map(([receipt]) => receipt)).toEqual([{ taskId: 'known-paid-task', requestId: 'known-request' }])
  })
})
