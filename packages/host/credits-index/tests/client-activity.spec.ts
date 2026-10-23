import { describe, expect, it, vi } from 'vitest'
import { ClientActivitySessions, parseClientActivity, readClientActivityAcknowledgement } from '../src/client-activity.ts'

const sample = { session_id: '01234567-89ab-4cde-8fab-0123456789ab', event: 'heartbeat', foreground: true, platform: 'win32', app_version: '1.2.3-alpha.1' }

describe('current-account activity fields', () => {
  it('accepts only the content-free native fields', () => {
    expect(parseClientActivity(sample)).toEqual(sample)
    for (const input of [null, [], {}, { ...sample, user_id: 99 }, { ...sample, prompt: 'private' },
      { ...sample, foreground: 'yes' }, { ...sample, event: 'charge' }, { ...sample, app_version: 'bad\nversion' },
      { ...sample, session_id: 'hardware-fingerprint' }, { ...sample, platform: 'other' }]) expect(parseClientActivity(input)).toBeNull()
  })

  it('uses fresh random account epochs and never exposes the private login token', () => {
    const sessions = new ClientActivitySessions()
    const first = sessions.resolve(sample.session_id, 'private-login-one')
    expect(sessions.resolve(sample.session_id, 'private-login-one')).toBe(first)
    expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u)
    const changed = sessions.resolve(sample.session_id, 'private-login-two')
    expect(changed).not.toBe(first)
    sessions.clear()
    expect(sessions.resolve(sample.session_id, 'private-login-two')).not.toBe(changed)
    expect(first).not.toContain('private-login')
  })
})

describe('presence acknowledgement', () => {
  it('accepts only confirmed JSON object success and permits exactly 2048 bytes', async () => {
    const valid = JSON.stringify({ success: true })
    expect(await readClientActivityAcknowledgement(new Response(valid), new AbortController().signal)).toBe(true)
    const boundary = `${' '.repeat(2048 - Buffer.byteLength(valid))}${valid}`
    expect(Buffer.byteLength(boundary)).toBe(2048)
    const response = new Response(boundary)
    expect(await readClientActivityAcknowledgement(response, new AbortController().signal)).toBe(true)
    expect(response.body?.locked).toBe(false)
  })

  it.each(['{', '', 'null', 'true', '[]', '[{"success":true}]', '{}', '{"success":false}',
    '{"success":"true"}', '{"success":1}'])('rejects unconfirmed JSON %j', async (body) => {
    expect(await readClientActivityAcknowledgement(new Response(body), new AbortController().signal)).toBe(false)
  })

  it('rejects non-success HTTP without reading its affirmative body and cancels the stream', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"success":true}')) }, cancel,
    }), { status: 503 })
    expect(await readClientActivityAcknowledgement(response, new AbortController().signal)).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
    expect(await readClientActivityAcknowledgement(new Response(null, { status: 204 }), new AbortController().signal)).toBe(false)
  })

  it('rejects oversized bodies by actual bytes, invalid UTF-8 and interrupted body reads', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ success: true, detail: '界'.repeat(700) }))) },
      cancel,
    }), { headers: { 'content-length': '16' } })
    expect(await readClientActivityAcknowledgement(response, new AbortController().signal)).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
    const invalid = Buffer.concat([Buffer.from('{"success":true,"detail":"'), Buffer.from([255]), Buffer.from('"}')])
    expect(await readClientActivityAcknowledgement(new Response(invalid), new AbortController().signal)).toBe(false)
    const failed = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('Private transport detail')) } }))
    expect(await readClientActivityAcknowledgement(failed, new AbortController().signal)).toBe(false)
    expect(failed.body?.locked).toBe(false)
  })

  it('settles abort cancellation before resolving and releases the body lock', async ({ onTestFinished }) => {
    const reading = Promise.withResolvers<undefined>()
    const cancelling = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const cancel = vi.fn(() => { cancelling.resolve(undefined); return release.promise })
    const response = new Response(new ReadableStream<Uint8Array>({ pull() { reading.resolve(undefined) }, cancel }))
    const lifetime = new AbortController()
    const pending = readClientActivityAcknowledgement(response, lifetime.signal)
    onTestFinished(async () => { lifetime.abort(); release.resolve(undefined); await pending })
    await reading.promise
    lifetime.abort()
    await cancelling.promise
    let settled = false
    const result = pending.then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve(undefined)
    expect(await result).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
  })

  it('cancels a pre-aborted body and safely rejects a reader owned elsewhere', async ({ onTestFinished }) => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
    expect(await readClientActivityAcknowledgement(response, AbortSignal.abort())).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
    const locked = new Response('{"success":true}')
    const reader = locked.body?.getReader()
    onTestFinished(async () => { await reader?.cancel(); reader?.releaseLock() })
    expect(await readClientActivityAcknowledgement(locked, new AbortController().signal)).toBe(false)
  })
})
