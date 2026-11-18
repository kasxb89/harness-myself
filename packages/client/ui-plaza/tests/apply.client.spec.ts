/** Cordis-owned market provision, withdrawal, independent roots and slot disposal. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { PlazaPage, type PlazaInjected } from '../src/client/PlazaPage.tsx'
import { PlazaPanelIcon } from '../src/client/PlazaPanelIcon.tsx'

function declarePanels(slots: SlotRegistry) {
  return slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, () => null)
}

async function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  return { ctx, locale, slots }
}

function marketFace(slots: SlotRegistry) {
  const entry = slots.entries('main').find(row => row.component === PlazaPage)
  const face: Partial<PlazaInjected> | undefined = entry?.inject?.()
  if (face?.hooks === undefined) throw new Error('Expected the native Plaza market snapshot')
  return face.hooks.marketControl
}

function provideMarket(ctx: Context, text: string) {
  return ctx.plugin({ name: 'fixture-market', apply: (scoped: Context) => {
    scoped.provide('market', { version: 1, render: () => text })
  } })
}

describe('Plaza activation', () => {
  it.each([false, true])('tracks provider withdrawal and re-provision with provider-first=%s', async (providerFirst) => {
    const b = await bench()
    declarePanels(b.slots)
    const first = providerFirst ? provideMarket(b.ctx, 'First market') : undefined
    await first?.await()
    const feature = b.ctx.plugin({ inject: [...inject], apply })
    await feature.await()
    const store = marketFace(b.slots)
    expect(store.getSnapshot()?.render({}) ?? null).toBe(providerFirst ? 'First market' : null)
    const provider = first ?? provideMarket(b.ctx, 'First market')
    await provider.await()
    await expect.poll(() => store.getSnapshot()?.render({})).toBe('First market')
    await provider.dispose()
    await expect.poll(() => store.getSnapshot()).toBeNull()
    const replacement = provideMarket(b.ctx, 'Replacement market')
    await replacement.await()
    await expect.poll(() => store.getSnapshot()?.render({})).toBe('Replacement market')
    const sidebar = b.slots.entries('sidebar.panellist')[0]!
    expect(sidebar.component).toBe(PlazaPanelIcon)
    expect(sidebar.options).toMatchObject({ id: 'plaza', order: 40 })
    expect(resolveSlotLabel(sidebar.options.label)).toBe('广场')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(sidebar.options.label)).toBe('Plaza')
    await feature.dispose()
    expect(store.getSnapshot()).toBeNull()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
  })

  it('keeps two roots independent and survives panel declaration collapse', async () => {
    const a = await bench()
    const b = await bench()
    const removePanels = declarePanels(a.slots)
    const featureA = a.ctx.plugin({ inject: [...inject], apply })
    const featureB = b.ctx.plugin({ inject: [...inject], apply })
    await Promise.all([featureA.await(), featureB.await()])
    expect(b.slots.entries('main')).toHaveLength(0)
    declarePanels(b.slots)
    const providerA = provideMarket(a.ctx, 'Market A')
    const providerB = provideMarket(b.ctx, 'Market B')
    await Promise.all([providerA.await(), providerB.await()])
    const storeA = marketFace(a.slots)
    const storeB = marketFace(b.slots)
    expect(storeA).not.toBe(storeB)
    await expect.poll(() => storeA.getSnapshot()?.render({})).toBe('Market A')
    await expect.poll(() => storeB.getSnapshot()?.render({})).toBe('Market B')
    removePanels()
    expect(a.slots.entries('main')).toHaveLength(0)
    declarePanels(a.slots)
    expect(marketFace(a.slots)).toBe(storeA)
    await providerA.dispose()
    expect(storeA.getSnapshot()).toBeNull()
    expect(storeB.getSnapshot()?.render({})).toBe('Market B')
    await featureA.dispose()
    expect(storeB.getSnapshot()?.render({})).toBe('Market B')
  })
})
