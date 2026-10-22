/** Fresh Desktop permissions and explicit choices through the shipped profile's Loader configuration. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { mountPermissionProfile } from './permission-profile.ts'

const fixtures: { ctx: Context; directory: string }[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const { ctx, directory } of fixtures.splice(0)) {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
})

async function fixture(options: { profile?: string; savedDefault?: string; mode?: string } = {}) {
  vi.stubEnv('DSH_PERMISSION_MODE', options.mode)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-permission-'))
  const ctx = new Context()
  fixtures.push({ ctx, directory })
  await mountPermissionProfile(ctx, directory, options)
  return ctx
}

it('pins Full access and never approval into a fresh Desktop session', async () => {
  const ctx = await fixture()
  const session = ctx.sessions.create(SessionId('desktop-fresh'))
  expect(ctx.permissionPresets.defaultPreset).toBe('danger-full-access')
  expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('danger-full-access')
  expect(ctx.approval.overrideOf(session)).toBe('never')
  expect(session.snapshotEvents().map(event => [event.type, event.data])).toEqual([
    ['permission/preset', { preset: 'danger-full-access' }],
    ['sandbox/mode', { mode: 'danger-full-access' }],
    ['approval/policy', { policy: 'never' }],
  ])
  expect(ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
  expect(ctx.approval.config.policy).toBe('ask')
})

it.each(['read-only', 'workspace-write'])('retains an explicit %s deployment default', async (mode) => {
  const ctx = await fixture({ mode })
  const session = ctx.sessions.create(SessionId(`desktop-explicit-${mode}`))
  expect(ctx.permissionPresets.current(session)).toBe(mode)
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe(mode)
  expect(ctx.approval.overrideOf(session)).toBe('ask')
})

it('retains a saved lower default for future Desktop sessions', async () => {
  const ctx = await fixture({ savedDefault: 'workspace-write' })
  const session = ctx.sessions.create(SessionId('desktop-user-default'))
  expect(ctx.permissionPresets.defaultPreset).toBe('workspace-write')
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
  expect(ctx.approval.overrideOf(session)).toBe('ask')
})

it('preserves explicit permissions and uninitialized legacy permissions when restoring sessions', async () => {
  const ctx = await fixture()
  const previous = Session.create(SessionId('desktop-existing-source'))
  previous.append('permission/preset', { preset: 'read-only' })
  previous.append('sandbox/mode', { mode: 'read-only' })
  previous.append('approval/policy', { policy: 'ask' })
  const priorEvents = previous.snapshotEvents()
  const restored = ctx.sessions.create(SessionId('desktop-restored-explicit'), { seed: priorEvents })
  expect(ctx.sandboxPolicy.resolve({ session: restored }).mode).toBe('read-only')
  expect(ctx.approval.overrideOf(restored)).toBe('ask')
  expect(restored.snapshotEvents().slice(0, priorEvents.length)).toEqual(priorEvents)
  expect(restored.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(1)

  const legacy = ctx.sessions.create(SessionId('desktop-restored-legacy'), { seed: [] })
  expect(ctx.permissionPresets.current(legacy)).toBe('workspace-write')
  expect(ctx.sandboxPolicy.resolve({ session: legacy }).mode).toBe('workspace-write')
  expect(ctx.approval.overrideOf(legacy)).toBe('ask')
})

it('keeps the Web profile on its existing workspace default', async () => {
  const ctx = await fixture({ profile: 'web' })
  const session = ctx.sessions.create(SessionId('web-unchanged'))
  expect(ctx.permissionPresets.current(session)).toBe('workspace-write')
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
  expect(ctx.approval.overrideOf(session)).toBe('ask')
})
