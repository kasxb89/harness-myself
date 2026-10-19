import { describe, expect, it } from 'vitest'
import { ClientActivitySessions, parseClientActivity } from '../src/client-activity.ts'

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
