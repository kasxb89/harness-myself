// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ILayout, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import * as settings from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS, PANEL_ID } from '../src/client/index.ts'
import { PluginManagerPage } from '../src/client/PluginManagerPage.tsx'
import { PluginRefreshToast, type PluginRefreshToastFace } from '../src/client/PluginRefreshToast.tsx'
import { PluginsPanelIcon } from '../src/client/PluginsPanelIcon.tsx'
import type { PluginManagerFace } from '../src/client/manager-store.ts'
import type { BundleInfo } from '@deepseek-ai/dsh-api-remotes/client'
import { VoiceInputLauncher, type VoiceInputLauncherFace } from '../src/client/VoiceInputLauncher.tsx'

usePinnedBrowserLanguages('zh-CN')
beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class LocaleHolder extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'localeHolder')
    }
  }
  new LocaleHolder(ctx)
  const list = vi.fn(() => Promise.resolve({ ok: true as const, value: { entries: [], managementAvailable: true } }))
  const listBundles = vi.fn<() => Promise<{ ok: true; value: BundleInfo[] }>>(async () => ({ ok: true, value: [] }))
  const setBundleEnabled = vi.fn(async () => ({ ok: true as const, value: {
    changed: true, application: 'applied' as const, stage: 'enable' as const, target: '@deepseek-ai/dsh-experimental-voice-input-bundle',
  } }))
  const remote = new TestRemote(ctx, {
    settings: { describe: vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } })) },
    pluginInventory: { list },
    pluginRegistryProbe: { fastest: vi.fn(async () => ({ ok: true as const, value: null })) },
    pluginManager: {
      listBundles, setBundleEnabled,
      listPlugins: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
      registries: vi.fn(() => Promise.resolve({ ok: true as const, value: { registry: null, fallbackRegistries: [], resolved: null } })),
    },
  })
  const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: null })
  const selectPanel = vi.fn<ILayout['selectPanel']>((activePanelId) => { panelInfo.set({ activePanelId }) })
  ctx.provide('layout', { panelInfo, selectPanel, beginNavigation: () => new AbortController().signal,
    toggleSidebar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn() })
  await ctx.plugin(settings).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, listBundles, setBundleEnabled, remote, selectPanel, panelInfo }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'conversation.input.activity': { kind: 'single', scope: 'session' },
    },
  } as never, () => null)
}

function voiceBundle(overrides: Partial<BundleInfo> = {}): BundleInfo {
  return { name: '@deepseek-ai/dsh-experimental-voice-input-bundle', official: true, availability: 'installation',
    enabled: false, installed: false, optional: true, removable: false, rows: [], overrides: [], ...overrides }
}

function voiceFace(slots: SlotRegistry): VoiceInputLauncherFace {
  const face: object = slots.entries('conversation.input.activity')[0]!.inject!()
  return face as VoiceInputLauncherFace
}

describe('ui-plugin-manager browser plugin', () => {
  it('keeps the composer launcher as a lifecycle-owned fallback while the optional voice control replaces it', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('conversation.input.activity')).toHaveLength(0)
    const removeRoot = declare(b.slots)
    expect(b.slots.entriesOfSlot('conversation.input.activity').map(entry => entry.component)).toEqual([VoiceInputLauncher])
    expect(b.slots.entriesOfSlot('conversation.input.activity')[0]!.options).toMatchObject({ priority: 100 })
    const OptionalVoice = () => null
    const voice = b.ctx.plugin({ inject: ['slots'], apply: (ctx: Context) => {
      ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({ name: 'conversation.input.activity' }, OptionalVoice))
    } })
    await voice.await()
    expect(b.slots.entries('conversation.input.activity')).toHaveLength(2)
    expect(b.slots.entriesOfSlot('conversation.input.activity').map(entry => entry.component)).toEqual([OptionalVoice])
    await voice.dispose()
    expect(b.slots.entriesOfSlot('conversation.input.activity').map(entry => entry.component)).toEqual([VoiceInputLauncher])
    removeRoot()
    expect(b.slots.entries('conversation.input.activity')).toHaveLength(0)
    declare(b.slots)
    expect(b.slots.entriesOfSlot('conversation.input.activity').map(entry => entry.component)).toEqual([VoiceInputLauncher])
    await fiber.dispose()
    expect(b.slots.entries('conversation.input.activity')).toHaveLength(0)
  })

  it('loads inventory before the manager page opens and enables only the available voice bundle', async () => {
    const b = await bench()
    declare(b.slots)
    b.listBundles.mockResolvedValue({ ok: true, value: [voiceBundle()] })
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const launcher = voiceFace(b.slots)
    expect(b.list).not.toHaveBeenCalled()
    expect(await launcher.openVoiceSetup(new AbortController().signal)).toBe('opened')
    expect(b.setBundleEnabled.mock.calls).toEqual([['@deepseek-ai/dsh-experimental-voice-input-bundle', true]])
    expect(b.panelInfo.getSnapshot().activePanelId).toBe(PANEL_ID)
    const entry = b.slots.entries('main')[0]!
    assert(entry.store && 'create' in entry.store)
    expect(entry.store.create().getSnapshot()).toEqual({ view: { kind: 'package', name: '@deepseek-ai/dsh-experimental-voice-input-bundle' } })
  })

  it('leaves missing catalog packages to the existing installation surface and does not re-enable an enabled bundle', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.listBundles.mockResolvedValue({ ok: true, value: [voiceBundle({ availability: 'missing', installTarget: {
      spec: '@deepseek-ai/dsh-experimental-voice-input-bundle@0.2.1-alpha.2', version: '0.2.1-alpha.2',
    } })] })
    expect(await voiceFace(b.slots).openVoiceSetup(new AbortController().signal)).toBe('opened')
    expect(b.setBundleEnabled).not.toHaveBeenCalled()
    b.listBundles.mockResolvedValue({ ok: true, value: [voiceBundle({ enabled: true })] })
    expect(await voiceFace(b.slots).openVoiceSetup(new AbortController().signal)).toBe('opened')
    expect(b.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('makes failed and unavailable inventory retryable and cancels activation after dialog close or plugin disposal', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const launcher = voiceFace(b.slots)
    b.listBundles.mockRejectedValueOnce(new Error('offline'))
    expect(await launcher.openVoiceSetup(new AbortController().signal)).toBe('failed')
    expect(await launcher.openVoiceSetup(new AbortController().signal)).toBe('unavailable')
    b.listBundles.mockResolvedValue({ ok: true, value: [voiceBundle()] })
    const closed = new AbortController(); closed.abort()
    expect(await launcher.openVoiceSetup(closed.signal)).toBe('cancelled')
    const pending = launcher.openVoiceSetup(new AbortController().signal)
    await fiber.dispose()
    expect(await pending).toBe('cancelled')
    expect(b.setBundleEnabled).not.toHaveBeenCalled()
    expect(b.selectPanel).not.toHaveBeenCalled()
  })

  it('resets bundle selection when leaving Plugins and releases its panel observer with the registration', async () => {
    const b = await bench()
    const removeRoot = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('main')[0]!
    assert(entry.store && 'create' in entry.store)
    const navigation = entry.store.create()
    expect(navigation.getSnapshot()).toEqual({ view: { kind: 'list' } })
    b.ctx.pluginNavigation.openBundle('dsh-navigation-test')
    expect(b.panelInfo.getSnapshot().activePanelId).toBe(PANEL_ID)
    expect(navigation.getSnapshot()).toEqual({ view: { kind: 'package', name: 'dsh-navigation-test' } })
    b.selectPanel(null)
    expect(navigation.getSnapshot()).toEqual({ view: { kind: 'list' } })
    b.selectPanel(PANEL_ID)
    expect(navigation.getSnapshot()).toEqual({ view: { kind: 'list' } })
    assert(navigation.actions.setView)
    navigation.actions.setView({ kind: 'more' })
    b.selectPanel(null)
    expect(navigation.getSnapshot()).toEqual({ view: { kind: 'list' } })
    b.ctx.pluginNavigation.openBundle('dsh-navigation-test')
    removeRoot()
    b.selectPanel(null)
    expect(navigation.getSnapshot()).toEqual({ view: { kind: 'package', name: 'dsh-navigation-test' } })
  })

  it('shares refresh failures with the overlay after navigation and releases both registrations across reloads', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    const removeRoot = declare(b.slots)
    const mainInjected: object = b.slots.entries('main')[0]!.inject!()
    const face = mainInjected as PluginManagerFace
    const overlayInjected: object = b.slots.entries('shell.overlay')[0]!.inject!()
    const overlay = overlayInjected as PluginRefreshToastFace
    expect(overlay.hooks.pluginManager).toBe(face.hooks.pluginManager)
    face.ensure()
    await vi.waitFor(() => { expect(face.hooks.pluginManager.getSnapshot().status).toBe('ready') })
    b.selectPanel(PANEL_ID)
    b.list.mockRejectedValueOnce(new Error('offline'))
    face.refresh()
    b.selectPanel(null)
    await vi.waitFor(() => { expect(overlay.hooks.pluginManager.getSnapshot().notice?.kind).toBe('refresh-failed') })
    overlay.dismissNotice()
    expect(face.hooks.pluginManager.getSnapshot().notice).toBeNull()
    removeRoot()
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.slots.entries('main')).toHaveLength(0)
    declare(b.slots)
    const remountedInjected: object = b.slots.entries('shell.overlay')[0]!.inject!()
    expect((remountedInjected as PluginRefreshToastFace).hooks.pluginManager).toBe(face.hooks.pluginManager)
    await fiber.dispose()
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.slots.entries('main')).toHaveLength(0)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const reloadedInjected: object = b.slots.entries('shell.overlay')[0]!.inject!()
    expect((reloadedInjected as PluginRefreshToastFace).hooks.pluginManager).not.toBe(face.hooks.pluginManager)
    expect((reloadedInjected as PluginRefreshToastFace).hooks.pluginManager.getSnapshot().notice).toBeNull()
  })

  it('declares only the services the page and its Remote methods use', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.pluginInventory', 'remote.pluginRegistryProbe', 'configForms', 'layout'])
  })

  it('registers the sidebar entry and its page, which reads the Host only once rendered and follows Host changes', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    b.ctx.pluginNavigation.openBundle('dsh-navigation-test')
    expect(b.selectPanel).toHaveBeenCalledWith(PANEL_ID)
    const entry = b.slots.entries('main')[0]!
    assert(entry.store && 'create' in entry.store)
    expect(entry.store.create().getSnapshot()).toEqual({ view: { kind: 'package', name: 'dsh-navigation-test' } })
    expect(entry.component).toBe(PluginManagerPage)
    expect(entry.options).toMatchObject({ key: PANEL_ID })
    expect(entry.locale).toBe(NS)
    // The sidebar entry addresses the page by the same id and speaks the dictionary.
    const icon = b.slots.entries('sidebar.panellist')[0]!
    expect(icon.component).toBe(PluginsPanelIcon)
    const unread = () => { throw new Error('The sidebar icon must not read application state') }
    const glyph = render(<PluginsPanelIcon size={18} active={false}
      usePanelInfo={unread} useSessions={unread} useSessionStatus={unread} useSessionRetainInfo={unread}
      useWorkspaces={unread} useResource={unread} />)
    expect(glyph.container.querySelector('svg')?.getAttribute('width')).toBe('18')
    // The conversation row leads the panel list, so the plugin row sorts after it.
    expect(icon.options).toMatchObject({ id: PANEL_ID, order: 50 })
    expect(icon.locale).toBe(NS)
    expect(resolveSlotLabel(icon.options.label)).toBe('插件')
    // The page declares the slots a plugin's configuration arrives through, and binds their projection beside its state.
    expect(b.slots.spec('plugins.add.actions')).toMatchObject({ kind: 'list', scope: 'root' })
    expect(b.slots.spec('plugins.item')).toMatchObject({ kind: 'list', scope: 'root' })
    expect(b.slots.spec('plugins.bundle.config')).toMatchObject({ kind: 'keyed', scope: 'root' })
    expect(b.slots.spec('plugins.row.config')).toMatchObject({ kind: 'keyed', scope: 'root' })
    for (const name of ['plugins.detail.actions', 'plugins.detail.badge', 'plugins.detail.section'] as const) {
      expect(b.slots.spec(name)).toMatchObject({ kind: 'list', scope: 'root' })
    }
    const injected: object = entry.inject!()
    const face = injected as PluginManagerFace
    const overlay = b.slots.entries('shell.overlay')[0]!
    expect(overlay.component).toBe(PluginRefreshToast)
    expect(overlay.options).toMatchObject({ id: 'plugin-manager.refresh-toast' })
    expect(overlay.locale).toBe(NS)
    const overlayInjected: object = overlay.inject!()
    const overlayFace = overlayInjected as PluginRefreshToastFace
    expect(overlayFace.hooks.pluginManager).toBe(face.hooks.pluginManager)
    expect(overlayFace.dismissNotice).toBe(face.dismissNotice)
    expect(Object.keys(overlayFace).sort()).toEqual(['dismissNotice', 'hooks'])
    expect(Object.keys(overlayFace.hooks)).toEqual(['pluginManager'])
    const text = { en: 'Local tools', zh: '本地工具' }
    expect(face.resolveText(text)).toBe('本地工具')
    b.locale.setLocale('en')
    expect(face.resolveText(text)).toBe('Local tools')
    b.locale.setLocale('zh')
    expect(face.hooks.configLedger.getSnapshot()).toEqual({ items: [], bundles: new Set(), rows: new Set() })
    // A Host change before the first render is not a reason to read.
    b.remote.emit('plugin-manager/changed', [{ reason: 'install' }])
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.list).not.toHaveBeenCalled()
    face.ensure()
    await vi.waitFor(() => { expect(face.hooks.pluginManager.getSnapshot().status).toBe('ready') })
    expect(b.list).toHaveBeenCalledTimes(1)
    b.remote.emit('plugin-manager/changed', [{ reason: 'bundle' }])
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(2) })
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(3) })

    // Install output folds into an open run only.
    face.openInstall()
    face.editInstallSpec('pkg')
    b.remote.emit('plugin-manager/install-log', [{ jobId: 'j', argv: ['pnpm', 'add', 'pkg'], cwd: '/p', stream: 'stdout', text: 'early' }])
    b.remote.emit('plugin-manager/install-state', [{ requestId: 'foreign', phase: 'installing' }])
    expect(face.hooks.pluginManager.getSnapshot().install.runs).toEqual([])

    await fiber.dispose()
    expect(b.ctx.get('pluginNavigation')).toBeUndefined()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    b.remote.emit('plugin-manager/changed', [{ reason: 'install' }])
    await Promise.resolve()
    expect(b.list).toHaveBeenCalledTimes(3)
  })
})
