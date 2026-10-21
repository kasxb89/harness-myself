// @vitest-environment jsdom
/**
 * Settings shell registration inside the assembled web client: the shell
 * occupies the `sidebar.settings` hole ui-sidebar declares, its ledger
 * projections read the product's real sections, its connection control is the
 * roster's Connection, and it survives a Loader rebuild of the declarer.
 */
import { describe, expect, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { inject } from '../src/client/index.ts'
import type { SettingsRootInjected } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'
import type { DesktopUpdatePresentation } from '../src/types.ts'
import type { DesktopUpdateCheckInjected } from '../src/client/DesktopUpdateCheck.tsx'
import type { createSettingsShellStore } from '../src/client/shell-store.ts'

const SELF = '@deepseek-ai/dsh-client-ui-settings-general'
const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar'
const it = createClientTest({ roster: webApp })
/** The whole roster's first boot pays the cold module transform of every plugin package. */
const COLD_BOOT_TIMEOUT_MS = 60_000

function injectedOf(c: TestClient): SettingsRootInjected {
  const entry = c.ctx.slots.entries('sidebar.settings')[0]!
  return (entry.inject as () => SettingsRootInjected)()
}

function shellStateOf(c: TestClient) {
  const store = c.ctx.slots.entries('sidebar.settings')[0]?.store
  if (typeof store !== 'object' || store === null || !('create' in store)) {
    throw new Error('Expected the settings shell owner store')
  }
  return (store as ReturnType<typeof createSettingsShellStore>).create()
}

function assertUpdateCheckInjected(value: Record<string, unknown> | undefined):
  asserts value is Record<string, unknown> & DesktopUpdateCheckInjected {
  if (value === undefined || typeof value.desktopUpdateAvailable !== 'boolean' || typeof value.activateDesktopUpdate !== 'function') {
    throw new Error('The update-check entry must expose availability and a check callback')
  }
  const hooks = value.hooks
  if (typeof hooks !== 'object' || hooks === null || !('desktopUpdate' in hooks)) {
    throw new Error('The update-check entry must expose its observed state')
  }
  const source = hooks.desktopUpdate
  if (typeof source !== 'object' || source === null || !('getSnapshot' in source) || typeof source.getSnapshot !== 'function'
    || !('subscribe' in source) || typeof source.subscribe !== 'function') {
    throw new Error('The update-check state must be an observable source')
  }
}

function updateCheckInjectedOf(injectFactory: ((...args: never[]) => Record<string, unknown>) | undefined): DesktopUpdateCheckInjected {
  const value = injectFactory?.()
  assertUpdateCheckInjected(value)
  return value
}

/** The shell's child declarations (chrome, actions, sections, and onboarding overlays). */
const CHILD_SPECS = {
  'settings.launcher': { kind: 'single', scope: 'root' },
  'settings.trigger': { kind: 'single', scope: 'root' },
  'settings.header': { kind: 'single', scope: 'root' },
  'settings.action': { kind: 'list', scope: 'root' },
  'settings.close': { kind: 'single', scope: 'root' },
  'settings.section': { kind: 'list', scope: 'root' },
  'settings.onboarding': { kind: 'list', scope: 'root' },
} as const
const CHILD_NAMES = Object.keys(CHILD_SPECS) as Array<keyof typeof CHILD_SPECS>

/**
 * Section ids registered by the product roster, including its enabled skin,
 * messaging, and market plugins, in navigation order.
 */
const PRODUCT_SECTIONS: readonly string[] = [
  'general', 'models', 'plugins', 'agent-presets', 'xmanrui-dsh-im', 'market', 'skin-market',
]
/** Onboarding steps the web-app roster registers, in coordinator order; both come from ui-settings-models. */
const PRODUCT_ONBOARDING: readonly { id: string; order: number }[] = [
  { id: 'welcome-notice', order: -100 },
  { id: 'deepseek-official', order: 0 },
]

describe('ui-settings-general shell', () => {
  it('emits closed only on a visible-to-hidden transition, never on mount or shell teardown', async ({ start }) => {
    const c = await start()
    const closed = vi.fn()
    c.ctx.on('ui-settings/closed', closed)
    const before = shellStateOf(c)
    before.actions.close()
    expect(closed).not.toHaveBeenCalled()
    before.actions.open()
    before.actions.select('general')
    before.actions.openSection('models')
    expect(closed).not.toHaveBeenCalled()
    before.actions.close()
    expect(closed).toHaveBeenCalledTimes(1)
    before.actions.close()
    expect(closed).toHaveBeenCalledTimes(1)

    before.actions.open()
    await c.reload(SIDEBAR)
    await c.flush()
    expect(closed).toHaveBeenCalledTimes(1)
    before.actions.close()
    expect(closed).toHaveBeenCalledTimes(1)
    const after = shellStateOf(c)
    after.actions.openSection('general')
    after.actions.close()
    expect(closed).toHaveBeenCalledTimes(2)
    after.actions.open()
    await c.unload(SELF)
    await c.flush()
    after.actions.close()
    expect(closed).toHaveBeenCalledTimes(2)
  }, COLD_BOOT_TIMEOUT_MS)

  it('opens only installed sections and releases the navigation listener with the shell', async ({ start }) => {
    const c = await start()
    const before = shellStateOf(c)
    expect(before.getSnapshot()).toEqual({ open: false, activeId: undefined })
    c.ctx.emit('ui-settings/open-section', 'missing-editor')
    expect(before.getSnapshot().open).toBe(false)
    const removeEditor = c.ctx.slots.register({ name: 'settings.section', id: 'custom-system-prompt', label: 'Employee editor' }, () => null)
    c.ctx.emit('ui-settings/open-section', 'custom-system-prompt')
    expect(before.getSnapshot()).toEqual({ open: true, activeId: 'custom-system-prompt' })
    before.actions.close()
    removeEditor()
    c.ctx.emit('ui-settings/open-section', 'custom-system-prompt')
    expect(before.getSnapshot()).toEqual({ open: false, activeId: undefined })

    await c.reload(SIDEBAR)
    await c.flush()
    const after = shellStateOf(c)
    expect(after).not.toBe(before)
    c.ctx.emit('ui-settings/open-section', 'general')
    expect(after.getSnapshot()).toEqual({ open: true, activeId: 'general' })
    expect(before.getSnapshot()).toEqual({ open: false, activeId: undefined })
  }, COLD_BOOT_TIMEOUT_MS)

  it('shares one carrier subscription across update controls and checks manually above Mobile', async ({ start }) => {
    const initial = Promise.withResolvers<DesktopUpdatePresentation>()
    let publish: ((state: DesktopUpdatePresentation) => void) | undefined
    const off = vi.fn()
    const subscribe = vi.fn((listener: typeof publish) => { publish = listener; return off })
    const open = vi.fn(async () => {})
    const check = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, updates: { status: () => initial.promise, subscribe, open, check } })
    onTestFinished(() => { vi.unstubAllGlobals(); initial.resolve({ phase: 'idle' }) })
    const c = await start()
    const row = injectedOf(c)
    const badge = (c.ctx.slots.entries('sidebar.toggle.badge')[0]!.inject as () => Pick<SettingsRootInjected, 'hooks'>)()
    const footerEntry = c.ctx.slots.entries('sidebar.footer.action').find(entry => entry.options.id === 'desktop-update-check')!
    const footer = updateCheckInjectedOf(footerEntry.inject)
    const versionEntry = c.ctx.slots.entries('settings.general.item').find(entry => entry.options.id === 'current-version')!
    const version = updateCheckInjectedOf(versionEntry.inject)
    expect(footerEntry.options.order).toBeLessThan(c.ctx.slots.entries('sidebar.footer.action').find(entry => entry.options.id === 'mobile')!.options.order!)
    expect(badge.hooks.desktopUpdate).toBe(row.hooks.desktopUpdate)
    expect(footer.hooks.desktopUpdate).toBe(row.hooks.desktopUpdate)
    expect(version.hooks.desktopUpdate).toBe(row.hooks.desktopUpdate)
    expect(footer.desktopUpdateAvailable).toBe(true)
    expect(subscribe).toHaveBeenCalledOnce()
    const status = { phase: 'available' as const, version: '1.0.1' }
    publish!(status)
    expect(row.hooks.desktopUpdate.getSnapshot().presentation).toEqual(status)
    row.openDesktopUpdate()
    await c.flush()
    expect(open).toHaveBeenCalledOnce()
    footer.activateDesktopUpdate()
    await c.flush()
    version.activateDesktopUpdate()
    await c.flush()
    expect(check).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(3)
    publish!({ phase: 'idle' })
    footer.activateDesktopUpdate()
    await c.flush()
    expect(check).toHaveBeenCalledOnce()
    await c.reload(SIDEBAR)
    await c.flush()
    expect(c.ctx.slots.entries('sidebar.footer.action').filter(entry => entry.options.id === 'desktop-update-check')).toHaveLength(1)
    expect(subscribe).toHaveBeenCalledOnce()
    await c.unload(SELF)
    await c.flush()
    expect(off).toHaveBeenCalledOnce()
    expect(c.ctx.slots.entries('sidebar.toggle.badge')).toHaveLength(0)
    expect(c.ctx.slots.entries('sidebar.footer.action').some(entry => entry.options.id === 'desktop-update-check')).toBe(false)
    publish!({ phase: 'error', version: status.version, failure: 'install' })
    expect(row.hooks.desktopUpdate.getSnapshot().presentation).toEqual({ phase: 'idle' })
  }, COLD_BOOT_TIMEOUT_MS)

  it('declares its services', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.settings', 'configForms', 'shortcuts'])
  })

  it('does not offer permanent manual checks with a legacy v1 preload', async ({ start }) => {
    const open = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, updates: {
      status: async () => ({ phase: 'available', version: '1.0.1' }),
      subscribe: () => () => {}, open,
    } })
    onTestFinished(() => { vi.unstubAllGlobals() })
    const c = await start()
    expect(c.ctx.slots.entries('sidebar.footer.action').some(entry => entry.options.id === 'desktop-update-check')).toBe(false)
    const versionEntry = c.ctx.slots.entries('settings.general.item').find(entry => entry.options.id === 'current-version')!
    const version = updateCheckInjectedOf(versionEntry.inject)
    expect(version.desktopUpdateAvailable).toBe(false)
    expect(() => { version.activateDesktopUpdate() }).not.toThrow()
    expect(open).not.toHaveBeenCalled()
    injectedOf(c).openDesktopUpdate()
    await c.flush()
    expect(open).toHaveBeenCalledOnce()
  })

  it('occupies sidebar.settings, declared by ui-sidebar, and declares every child slot', async ({ start }) => {
    const c = await start()
    expect(c.ctx.slots.entries('sidebar.settings').map(entry => entry.component)).toEqual([SettingsRoot])
    for (const name of CHILD_NAMES) expect(c.ctx.slots.spec(name)).toEqual(CHILD_SPECS[name])
    expect(c.ctx.slots.entries('sidebar.footer.action').some(entry => entry.options.id === 'desktop-update-check')).toBe(false)
    const versionEntry = c.ctx.slots.entries('settings.general.item').find(entry => entry.options.id === 'current-version')!
    expect(updateCheckInjectedOf(versionEntry.inject).desktopUpdateAvailable).toBe(false)
  }, COLD_BOOT_TIMEOUT_MS)

  it('projects the section ledger: product sections in order, defaults for bare rows, stable snapshots', async ({ start }) => {
    const c = await start()
    const { sections } = injectedOf(c).hooks
    const product = sections.getSnapshot()
    expect(product.map(row => row.id)).toEqual(PRODUCT_SECTIONS)
    c.ctx.slots.register({ name: 'settings.section', id: 'z', order: 1_000, label: 'Z' } as never, () => null)
    // No order and no label: both projection defaults apply, and order 0 sorts among the product rows.
    c.ctx.slots.register({ name: 'settings.section', id: 'a' } as never, () => null)
    const rows = sections.getSnapshot()
    expect(rows.at(-1)).toEqual({ id: 'z', order: 1_000, label: 'Z' })
    expect(rows.find(row => row.id === 'a')).toEqual({ id: 'a', order: 0, label: '' })
    expect(rows.map(row => row.order)).toEqual([...rows.map(row => row.order)].sort((x, y) => x - y))
    // Snapshot identity is stable until the ledger moves (uSES contract).
    expect(sections.getSnapshot()).toBe(rows)
    const listener = vi.fn()
    const off = sections.subscribe(listener)
    c.ctx.slots.register({ name: 'settings.section', id: 'b', order: 1, label: 'B' } as never, () => null)
    await Promise.resolve()
    expect(listener).toHaveBeenCalled()
    expect(sections.getSnapshot()).not.toBe(rows)
    off()
  })

  it('keeps the stock account unsubscribed in Desktop and exposes the product Credits entry', async ({ start }) => {
    vi.stubGlobal('dshDesktop', {})
    onTestFinished(() => { vi.unstubAllGlobals() })
    const c = await start()
    const { sections } = injectedOf(c).hooks
    await c.flush()
    expect(sections.getSnapshot().map(row => row.id)).toEqual(PRODUCT_SECTIONS)
    expect(c.mock.log.streams('account/watch')).toHaveLength(0)
    expect(c.ctx.slots.entries('settings.section').some(entry => entry.options.id === 'account')).toBe(false)
    expect(c.ctx.slots.entries('settings.models.sign-in')).toHaveLength(0)
    expect(c.ctx.slots.entries('main').map(entry => entry.options.key)).toEqual(expect.arrayContaining(['credits', 'recharge']))
    expect(c.ctx.slots.entries('sidebar.footer.action').find(entry => entry.options.id === 'credits')).toMatchObject({ locale: 'credits' })
  })

  it('projects the roster Connection control without copying its state; reconnect opens a new $events generation', async ({ start }) => {
    const c = await start()
    const injected = injectedOf(c)
    expect(injected.hooks.connectionState).toBe(c.connection.state)
    expect(injected.hooks.connectionState.getSnapshot()).toBe('connected')
    injected.reconnect()
    await c.mock.streams.opened('$events', 2)
    await vi.waitFor(() => { expect(c.connection.state.getSnapshot()).toBe('connected') })
  })

  it('projects onboarding entries into stable coordinator order', async ({ start }) => {
    const c = await start()
    const { onboardingSteps } = injectedOf(c).hooks
    expect(onboardingSteps.getSnapshot()).toEqual(PRODUCT_ONBOARDING)
    c.ctx.slots.register({ name: 'settings.onboarding', id: 'credential', order: 0 } as never, () => null)
    c.ctx.slots.register({ name: 'settings.onboarding', id: 'welcome', order: -100 } as never, () => null)
    c.ctx.slots.register({ name: 'settings.onboarding', id: 'default-order' } as never, () => null)
    const steps = onboardingSteps.getSnapshot()
    expect(steps.filter(step => !PRODUCT_ONBOARDING.some(known => known.id === step.id))).toEqual([
      { id: 'welcome', order: -100 },
      { id: 'credential', order: 0 },
      { id: 'default-order', order: 0 },
    ])
    expect(onboardingSteps.getSnapshot()).toBe(steps)
    const listener = vi.fn()
    const off = onboardingSteps.subscribe(listener)
    c.ctx.slots.register({ name: 'settings.onboarding', id: 'later', order: 10 } as never, () => null)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
    off()
  })

  it('re-registers after the declarer reloads: the cascade removes the shell, the rebuilt declaration takes it back', async ({ start }) => {
    const c = await start()
    const before = c.ctx.slots.entries('sidebar.settings')[0]
    expect(before).toBeDefined()
    await c.reload(SIDEBAR)
    await c.flush()
    expect(c.ctx.slots.entries('sidebar.settings').map(entry => entry.component)).toEqual([SettingsRoot])
    expect(c.ctx.slots.entries('sidebar.settings')[0]).not.toBe(before)
    for (const name of CHILD_NAMES) expect(c.ctx.slots.spec(name)).toEqual(CHILD_SPECS[name])
  })

  it('unregisters the shell and collapses every child slot when its row unloads', async ({ start }) => {
    const c = await start()
    await c.unload(SELF)
    await c.flush()
    expect(c.ctx.slots.entries('sidebar.settings')).toHaveLength(0)
    for (const name of CHILD_NAMES) expect(c.ctx.slots.spec(name)).toBeUndefined()
  })
})
