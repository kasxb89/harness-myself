/** Confirmed target requirements survive ordinary check failures and application restarts. */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopFeedMandatoryUpdate, type FeedMandatoryUpdateIdentity } from '../src/feed-mandatory-update.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const identity: FeedMandatoryUpdateIdentity = { authority: 'https://8.133.202.230/harness', platform: 'darwin', arch: 'arm64', version: '0.2.1-alpha.2.20261020.2' }
const next = '0.2.1-alpha.2.20261020.3'
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'desktop-feed-required-'))
  homes.push(home)
  const report = vi.fn()
  const policy = new DesktopFeedMandatoryUpdate(home, identity, report)
  return { home, report, policy }
}

it('does not invent a requirement from unavailable discovery, errors, or prepared-target events', async () => {
  const { home, policy, report } = fixture()
  const states: DesktopUpdateState[] = [
    { phase: 'idle' }, { phase: 'checking' }, { phase: 'ready', version: next },
    ...(['source-disabled', 'source-target-missing', 'source-unavailable'] as const).map(sourceFailure => ({
      phase: 'error' as const, sourceFailure, failedOperation: 'check' as const,
    })),
    { phase: 'available', version: identity.version }, { phase: 'available', version: '0.1.0' },
  ]
  for (const state of states) policy.observe(state)
  await policy.dispose()
  expect(policy.state).toEqual({ blocking: false, checking: false })
  expect(readdirSync(home)).toEqual([])
  expect(report).not.toHaveBeenCalled()
})

it.each(['darwin', 'win32'] as const)('retains the highest confirmed version across failures and offline restarts on %s', async (platform) => {
  const { home, report } = fixture()
  const target = { ...identity, platform, arch: platform === 'win32' ? 'x64' : 'arm64' }
  const policy = new DesktopFeedMandatoryUpdate(home, target, report)
  policy.observe({ phase: 'available', version: next })
  expect(policy.state.blocking).toBe(true)
  policy.observe({ phase: 'available', version: '0.2.1-alpha.2.20261020.10' })
  policy.observe({ phase: 'available', version: next })
  policy.observe({ phase: 'error', failedOperation: 'check', sourceFailure: 'source-disabled' })
  policy.observe({ phase: 'error', failedOperation: 'download', version: next })
  policy.observe({ phase: 'idle' })
  await policy.dispose()
  expect(policy.version).toBe('0.2.1-alpha.2.20261020.10')
  const restarted = new DesktopFeedMandatoryUpdate(home, { ...target, authority: `${target.authority}/` }, report)
  expect(restarted.state.blocking).toBe(true)
  expect(restarted.version).toBe(policy.version)
  const upgraded = new DesktopFeedMandatoryUpdate(home, { ...target, version: policy.version! }, report)
  expect(upgraded.state.blocking).toBe(false)
  expect(new DesktopFeedMandatoryUpdate(home, { ...target, authority: 'https://another.example/harness' }, report).state.blocking).toBe(false)
  expect(new DesktopFeedMandatoryUpdate(home, { ...target, arch: 'other' }, report).state.blocking).toBe(false)
  expect(report).not.toHaveBeenCalled()
})

it.each(['invalid-json', 'wrong-authority', 'invalid-version', 'oversized'])('reports an unreadable %s record without fabricating a version', async (kind) => {
  const { home, policy, report } = fixture()
  policy.observe({ phase: 'available', version: next })
  await policy.dispose()
  const directory = join(home, 'desktop')
  const file = join(directory, readdirSync(directory)[0]!)
  writeFileSync(file, kind === 'invalid-json' ? '{' : kind === 'oversized' ? ' '.repeat(4097)
    : JSON.stringify({ schemaVersion: 1, authorityTarget: kind === 'wrong-authority' ? 'other' : file.match(/required-update-(.+)\.json$/u)?.[1], version: kind === 'invalid-version' ? 'latest' : next }))
  expect(new DesktopFeedMandatoryUpdate(home, identity, report).state.blocking).toBe(false)
  expect(report).toHaveBeenCalledOnce()
})

it('keeps an in-memory requirement and reports a cache write failure', async () => {
  const { home, policy, report } = fixture()
  writeFileSync(join(home, 'desktop'), 'not a directory')
  policy.observe({ phase: 'available', version: next })
  await policy.dispose()
  expect(policy.state.blocking).toBe(true)
  expect(report).toHaveBeenCalledOnce()
})

it('ignores a coordinator result that arrives after shutdown', async () => {
  const { home, policy } = fixture()
  await policy.dispose()
  policy.observe({ phase: 'available', version: next })
  expect(policy.state.blocking).toBe(false)
  expect(readdirSync(home)).toEqual([])
})
