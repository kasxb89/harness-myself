/** Durable phone operation identities survive remounts and reject parameter changes. */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { PhoneAuthState } from '../src/phone-auth-state.ts'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yunshu-phone-state-'))
  directories.push(directory)
  const file = join(directory, 'phone.json')
  const api = 'https://example.invalid/harness'
  return { file, api, state: new PhoneAuthState(file, api) }
}

it('persists keys before returning and restores challenge and exchange without storing the code', async () => {
  const { file, api, state } = await fixture()
  expect(await state.reserveChallenge('+8613800000000', 'challenge-a')).toBe('reserved')
  expect(await state.updateChallenge('challenge-a', { challengeId: 'opaque-a', deliveryStatus: 'unknown',
    expiresAt: '9999-01-01T00:00:00Z', resendAt: 1234 })).toBe(true)
  expect(await state.reserveExchange('+8613800000000', 'opaque-a', '908172', 'exchange-a')).toBe('reserved')
  const text = await readFile(file, 'utf8')
  expect(text).toContain('challenge-a')
  expect(text).toContain('exchange-a')
  expect(text).not.toContain('908172')
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  const restarted = new PhoneAuthState(file, api)
  expect(await restarted.phone('opaque-a')).toBe('+8613800000000')
  expect(await restarted.recovery()).toMatchObject({ phone: '+8613800000000', challengeKey: 'challenge-a',
    challengeId: 'opaque-a', exchangeKey: 'exchange-a', deliveryStatus: 'unknown', resendAt: 1234 })
  expect(await restarted.reserveExchange('+8613800000000', 'opaque-a', '908172', 'exchange-a')).toBe('reserved')
  expect(await restarted.reserveExchange('+8613800000000', 'opaque-a', '123456', 'exchange-a')).toBe('conflict')
  expect(await restarted.reserveChallenge('+8613900000000', 'challenge-a')).toBe('conflict')
  expect(await restarted.reserveExchange('+8613800000000', 'opaque-a', '908172', 'challenge-a')).toBe('conflict')
  expect(await restarted.reserveChallenge('+8613800000000', 'exchange-a')).toBe('conflict')
  expect(await restarted.markSecurity('exchange-a', true)).toBe(true)
  expect(await new PhoneAuthState(file, api).securityPending('exchange-a')).toBe(true)
  expect(await new PhoneAuthState(file, api).recovery()).toMatchObject({ securityUnconfirmed: true })
  expect(await restarted.complete('exchange-a')).toBe(true)
  expect(await new PhoneAuthState(file, api).recovery()).toBeNull()
})

it('serializes simultaneous reservations of one key with different phones', async () => {
  const { state, file } = await fixture()
  expect(await Promise.all([
    state.reserveChallenge('+8613800000000', 'concurrent'),
    state.reserveChallenge('+8613900000000', 'concurrent'),
  ])).toEqual(['reserved', 'conflict'])
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ challenges: [{ key: 'concurrent', phone: '+8613800000000' }] })
})

it('keeps malformed and differently bound recovery state visible as unavailable', async () => {
  const { state, file, api } = await fixture()
  await writeFile(file, '{broken')
  expect(await state.reserveChallenge('+8613800000000', 'challenge')).toBe('unavailable')
  expect(await readFile(file, 'utf8')).toBe('{broken')
  await writeFile(file, JSON.stringify({ schema: 1, backendBaseUrl: api + '/different', challenges: [], exchanges: [] }))
  expect(await state.reserveExchange('+8613800000000', 'opaque', '123456', 'exchange')).toBe('unavailable')
  await expect(state.recovery()).rejects.toThrow('phone recovery unavailable')
})

it('uses server expiry for cleanup and allows a new explicit key after not_sent', async () => {
  const { state, api, file } = await fixture()
  await state.reserveChallenge('+8613800000000', 'expired')
  await state.updateChallenge('expired', { challengeId: 'old', deliveryStatus: 'accepted', expiresAt: '2000-01-01T00:00:00Z' })
  expect(await new PhoneAuthState(file, api).recovery()).toBeNull()
  await state.reserveChallenge('+8613800000000', 'not-sent')
  await state.updateChallenge('not-sent', { deliveryStatus: 'not_sent' })
  expect(await state.recovery()).toMatchObject({ challengeKey: null, deliveryStatus: 'not_sent' })
  expect(await state.reserveChallenge('+8613800000000', 'manual-next-request')).toBe('reserved')
  expect(await state.recovery()).toMatchObject({ challengeKey: 'manual-next-request', deliveryStatus: 'sending' })
})


it('retains an unconfirmed exchange across OTP expiry and restart throughout successful-response replay', async () => {
  let now = Date.UTC(2026, 9, 21, 12, 0, 0)
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const { file, api, state } = await fixture()
  const expiresAt = new Date(now + 2000).toISOString()
  await state.reserveChallenge('+8613800000000', 'challenge-near-expiry')
  await state.updateChallenge('challenge-near-expiry', { challengeId: 'opaque-near-expiry',
    deliveryStatus: 'accepted', expiresAt })
  now += 1900
  expect(await state.reserveExchange('+8613800000000', 'opaque-near-expiry', '908172', 'exchange-lost-success')).toBe('reserved')
  // The API may have committed here; the client never received its successful response.
  now += 4 * 60_000 + 900
  const restarted = new PhoneAuthState(file, api)
  expect(await restarted.phone('opaque-near-expiry')).toBe('+8613800000000')
  expect(await restarted.recovery()).toMatchObject({ challengeId: 'opaque-near-expiry',
    exchangeKey: 'exchange-lost-success', expiresAt, deliveryStatus: 'unknown' })
  expect(Date.parse(expiresAt)).toBeLessThan(now)
  expect(await restarted.reserveExchange('+8613800000000', 'opaque-near-expiry', '908172', 'exchange-lost-success')).toBe('reserved')
  expect(await readFile(file, 'utf8')).not.toContain('908172')
  await restarted.complete('exchange-lost-success')
  expect(await new PhoneAuthState(file, api).recovery()).toBeNull()
})
