/** Video billing stays attached to the original product login across every key read. */
import { describe, expect, it, vi } from 'vitest'
import { bindVideoAccount, type LiveVideoAccount } from '../src/video-project-account.ts'
import { VideoProjectError } from '../src/video-project.ts'

const original: LiveVideoAccount = {
  accountId: 'account-seven', token: 'original-private-login-token', key: 'original-private-relay-key',
}

describe('product account binding for video projects', () => {
  it.each([
    undefined, { ...original, token: '' }, { ...original, key: '' },
  ])('requires a current signed-in account with both session and relay credentials (%j)', async (current) => {
    const read = vi.fn(async () => current)
    await expect(bindVideoAccount(read)).rejects.toMatchObject({ code: 'VIDEO_ACCOUNT_REQUIRED' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('exposes only account id and a stable non-secret session fingerprint', async () => {
    const read = vi.fn(async () => ({ ...original }))
    const binding = await bindVideoAccount(read)
    expect(Object.keys(binding.identity).sort()).toEqual(['accountId', 'sessionFingerprint'])
    expect(binding.identity.accountId).toBe(original.accountId)
    expect(binding.identity.sessionFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    const saved = JSON.stringify(binding.identity)
    expect(saved).not.toContain(original.token)
    expect(saved).not.toContain(original.key)
    const sameLogin = await bindVideoAccount(async () => ({ ...original, key: 'rotated-key' }))
    expect(sameLogin.identity).toEqual(binding.identity)
    const otherLogin = await bindVideoAccount(async () => ({ ...original, token: 'another-private-login-token' }))
    expect(otherLogin.identity.sessionFingerprint).not.toBe(binding.identity.sessionFingerprint)
  })

  it.each([
    ['another account', { ...original, accountId: 'account-eight' }],
    ['another login token', { ...original, token: 'new-private-login-token' }],
    ['an expired or signed-out session', undefined],
    ['a missing current relay key', { ...original, key: '' }],
    ['a missing current session token', { ...original, token: '' }],
  ] as const)('refuses a key after the account reader returns %s', async (_case, replacement) => {
    let current: LiveVideoAccount | undefined = { ...original }
    const read = vi.fn(async () => current)
    const binding = await bindVideoAccount(read)
    current = replacement
    const result = binding.key()
    await expect(result).rejects.toBeInstanceOf(VideoProjectError)
    await expect(result).rejects.toMatchObject({ code: 'VIDEO_ACCOUNT_CHANGED' })
    try { await result } catch (error) {
      if (!(error instanceof Error)) throw new Error('Expected an account failure')
      expect(error.message).not.toMatch(/original-private|new-private|account-eight/u)
    }
    expect(read).toHaveBeenCalledTimes(2)
    expect(binding.identity.accountId).toBe(original.accountId)
  })

  it('accepts relay-key rotation for the same account and login, re-reading before every operation', async () => {
    let current: LiveVideoAccount = { ...original }
    const read = vi.fn(async () => current)
    const binding = await bindVideoAccount(read)
    const identity = { ...binding.identity }
    expect(read).toHaveBeenCalledTimes(1)
    current = { ...current, key: 'first-rotated-relay-key' }
    expect(await binding.key()).toBe('first-rotated-relay-key')
    current = { ...current, key: 'second-rotated-relay-key' }
    expect(await binding.key()).toBe('second-rotated-relay-key')
    expect(read).toHaveBeenCalledTimes(3)
    expect(binding.identity).toEqual(identity)
    expect(JSON.stringify(binding.identity)).not.toMatch(/rotated|private-login|private-relay/u)
  })

  it('propagates an unavailable account read without returning the previously captured relay key', async () => {
    const failure = new Error('Account state unavailable')
    const read = vi.fn<() => Promise<LiveVideoAccount | undefined>>()
      .mockResolvedValueOnce({ ...original }).mockRejectedValueOnce(failure)
    const binding = await bindVideoAccount(read)
    await expect(binding.key()).rejects.toBe(failure)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
