// @vitest-environment jsdom
/** Product-panel launch navigation across slot declaration and plugin lifetimes. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayoutController, type MainPanelId } from '../../ui-layout/src/client/service.ts'
import { createLayoutStore } from '../../ui-layout/src/client/stores.ts'
import { apply, Config, inject } from '../src/client/index.ts'
import type { CreditsPageInjected } from '../src/client/CreditsPage.tsx'
import type { QuotaNoticeOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { BalanceNoticeInjected } from '../src/client/BalanceNotice.tsx'

const roots: Context[] = []
const existingPanel = 'existing-panel' as MainPanelId

it('validates the configurable statistics deadline independently from generation settings', () => {
  expect(Config({})).toEqual({ chatUsageReadTimeoutMs: 20_000 })
  expect(Config({ chatUsageReadTimeoutMs: 30_000 })).toEqual({ chatUsageReadTimeoutMs: 30_000 })
  for (const chatUsageReadTimeoutMs of [0, 999, 120_001, 2000.5, Number.NaN]) {
    expect(() => Config({ chatUsageReadTimeoutMs })).toThrow()
  }
})

afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose()
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

async function bench(search: string) {
  window.history.replaceState(null, '', `/${search}`)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots')!
  const state = createLayoutStore().create()
  const layout = new LayoutController(state.actions, id =>
    slots.entries('main').some(entry => entry.options.key === id), {
    getSnapshot: () => state.getSnapshot().panelInfo,
    subscribe: listener => state.subscribe(listener),
  })
  ctx.provide('layout', layout)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const select = vi.spyOn(layout, 'selectPanel')
  const start = async (): Promise<Fiber> => {
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    return fiber
  }
  const declare = async (): Promise<Fiber> => {
    const frame = ctx.plugin({
      inject: ['slots'],
      apply(owned: Context) {
        owned.slots.register({
          name: 'root',
          children: {
            main: { kind: 'keyed', scope: 'root' },
            'sidebar.panellist': { kind: 'list', scope: 'root' },
            'sidebar.footer.action': { kind: 'list', scope: 'root' },
            'shell.overlay': { kind: 'list', scope: 'root' },
            'shell.quota-notice': { kind: 'chain', scope: 'root' },
            'conversation.input.dock': { kind: 'list', scope: 'session' },
          },
        }, ({ renderSlot }: PropsRenderSlots<'shell.overlay'>) => renderSlot('shell.overlay', {}))
      },
    })
    await frame.await()
    return frame
  }
  return { ctx, slots, layout, select, start, declare }
}

describe('Credits launch entry', () => {
  it('claims only product funding failures and uses the existing recharge panel', async () => {
    const b = await bench('')
    await b.start()
    await b.declare()
    const notice = b.slots.entries('shell.quota-notice')[0]
    if (notice?.select === undefined || notice.inject === undefined) throw new Error('Missing product balance notice entry')
    // The real registry intentionally erases owner and injection types at storage.
    const select = notice.select as (owner: QuotaNoticeOwnerProps) => QuotaNoticeOwnerProps | null
    const owner = { code: 'INSUFFICIENT_BALANCE' as const, message: 'safe', dismiss: () => {}, keepOpen: () => () => {} }
    expect(select(owner)).toBe(owner)
    expect(select({ ...owner, code: 'ACCOUNT_QUOTA' })).toBeNull()
    expect(select({ ...owner, code: 'QUOTA' })).toBeNull()
    const face = notice.inject()
    if (typeof face.openRecharge !== 'function') throw new Error('Missing recharge navigation')
    const openRecharge = face.openRecharge as BalanceNoticeInjected['openRecharge']
    openRecharge()
    expect(b.layout.panelInfo.getSnapshot().activePanelId).toBe('recharge')
    expect(b.select).toHaveBeenCalledExactlyOnceWith('recharge')
  })
  it('waits for the main declaration before opening the registered product panel', async () => {
    const b = await bench('?panel=credits&workspace=kept#conversation')
    window.history.replaceState({ entry: 'welcome' }, '', window.location.href)
    await b.start()
    expect(b.select).not.toHaveBeenCalled()
    expect(b.slots.entries('main')).toEqual([])
    expect(b.layout.panelInfo.getSnapshot().activePanelId).toBeNull()

    await b.declare()

    expect(b.slots.entries('main').map(entry => entry.options.key)).toEqual(['credits', 'recharge'])
    expect(b.select).toHaveBeenCalledExactlyOnceWith('credits')
    expect(b.layout.panelInfo.getSnapshot().activePanelId).toBe('credits')
    expect(window.location.search).toBe('?workspace=kept')
    expect(window.location.hash).toBe('#conversation')
    expect(window.history.state).toEqual({ entry: 'welcome' })
  })

  it('returns a completed phone sign-in to the Conversation and preserves later panel choices', async () => {
    const b = await bench('?panel=credits')
    await b.start()
    const frame = await b.declare()
    const page = b.slots.entries('main').find(entry => entry.options.key === 'credits')
    const completeSignIn = page!.inject!()['completeSignIn'] as CreditsPageInjected['completeSignIn']

    completeSignIn()

    expect(b.select).toHaveBeenLastCalledWith(null)
    expect(b.layout.panelInfo.getSnapshot().activePanelId).toBeNull()
    b.layout.selectPanel('credits' as MainPanelId)
    expect(b.layout.panelInfo.getSnapshot().activePanelId).toBe('credits')
    b.layout.selectPanel('recharge' as MainPanelId)
    b.select.mockClear()
    await frame.dispose()
    await b.declare()
    expect(b.select).not.toHaveBeenCalled()
    expect(b.layout.panelInfo.getSnapshot().activePanelId).toBe('recharge')
  })

  it('does not take navigation away from a different panel when sign-in finishes late', async () => {
    const b = await bench('?panel=credits')
    await b.start()
    await b.declare()
    const page = b.slots.entries('main').find(entry => entry.options.key === 'credits')
    const completeSignIn = page!.inject!()['completeSignIn'] as CreditsPageInjected['completeSignIn']
    b.layout.selectPanel('recharge' as MainPanelId)
    b.select.mockClear()

    completeSignIn()

    expect(b.select).not.toHaveBeenCalled()
    expect(b.layout.panelInfo.getSnapshot().activePanelId).toBe('recharge')
  })

  it.each(['', '?panel=unknown', '?panel=recharge'])('preserves navigation without a Credits launch request (%s)', async (search) => {
    const b = await bench(search)
    await b.declare()
    b.slots.register({ name: 'main', key: existingPanel }, () => null)
    b.layout.selectPanel(existingPanel)
    b.select.mockClear()

    await b.start()

    expect(b.select).not.toHaveBeenCalled()
    expect(b.layout.panelInfo.getSnapshot().activePanelId).toBe(existingPanel)
    expect(b.slots.entries('main').map(entry => entry.options.key)).toContain('credits')
  })

  it('removes entries and pending launch effects when the plugin is released', async () => {
    const b = await bench('?panel=credits')
    const credits = await b.start()
    const frame = await b.declare()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(b.slots.entries('conversation.input.dock').map(entry => entry.options.id)).toEqual(['workspace-guide'])
    expect(b.slots.entries('shell.overlay').map(entry => entry.options.id)).toEqual(['workspace-guide-notice'])
    expect(b.ctx.locale.bind('credits')('panel')).not.toBe('panel')

    await credits.dispose()

    expect(b.slots.entries('main')).toEqual([])
    expect(b.slots.entries('sidebar.footer.action')).toEqual([])
    expect(b.slots.entries('conversation.input.dock')).toEqual([])
    expect(b.slots.entries('shell.overlay')).toEqual([])
    expect(b.ctx.locale.bind('credits')('panel')).toBe('panel')
    b.select.mockClear()
    await frame.dispose()
    await b.declare()
    expect(b.slots.entries('main')).toEqual([])
    expect(b.slots.entries('sidebar.footer.action')).toEqual([])
    expect(b.select).not.toHaveBeenCalled()
  })

  it('cancels a launch that is still waiting for the main declaration', async () => {
    const b = await bench('?panel=credits')
    const credits = await b.start()
    await credits.dispose()

    await b.declare()

    expect(b.slots.entries('main')).toEqual([])
    expect(b.slots.entries('sidebar.footer.action')).toEqual([])
    expect(b.select).not.toHaveBeenCalled()
    expect(b.layout.panelInfo.getSnapshot().activePanelId).toBeNull()
  })
})
