// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { SkillHubPage, type SkillHubInjected } from '../src/client/SkillHubPage.tsx'
import { SkillHubPanelIcon } from '../src/client/SkillHubPanelIcon.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps the macOS header below window controls using a scoped page inset', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/client/SkillHubPage.module.css'), 'utf8')
  expect(css).toMatch(/:global\(\[data-platform='darwin'\]\) \.page\s*\{\s*padding-top: calc\(var\(--dsh-frame-top-clearance\) \+ 16px\);/u)
  expect(css).toContain('border-radius: var(--dsw-radius-xl)')
  expect(css).toContain('@media (prefers-reduced-motion: reduce)')
})

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const slots = new SlotRegistry(ctx)
  slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, (() => null) as never)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, locale, fiber }
}

it('registers the native page and sidebar order 45, with dictionaries and HMR cleanup', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const { slots, locale, fiber } = await fixture()
  expect(inject).toEqual(['slots', 'locale'])
  expect(slots.entries('main')[0]).toMatchObject({ component: SkillHubPage, options: { key: 'skillhub' }, locale: 'skillhub' })
  const sidebar = slots.entries('sidebar.panellist')[0]!
  expect(sidebar).toMatchObject({ component: SkillHubPanelIcon, options: { id: 'skillhub', order: 45 }, locale: 'skillhub' })
  expect(typeof sidebar.options.label === 'function' ? sidebar.options.label() : sidebar.options.label).toBe('技能商店')
  expect(locale.bind('skillhub')('panel')).toBe('技能商店')
  locale.setLocale('en')
  expect(typeof sidebar.options.label === 'function' ? sidebar.options.label() : sidebar.options.label).toBe('Skill store')
  expect(fetch).not.toHaveBeenCalled()
  expect(render(createElement(SkillHubPanelIcon)).container.querySelector('svg')).toBeTruthy()
  await fiber.dispose()
  expect(slots.entries('main')).toEqual([])
  expect(slots.entries('sidebar.panellist')).toEqual([])
  expect(locale.bind('skillhub')('panel')).toBe('panel')
})

it('invalidates conversation skill catalogs only after an acknowledged successful installation', async () => {
  const receipt = { slug: '@community/review', name: 'Review', version: '1.0.0' }
  const fetch = vi.fn(async () => Response.json({ ok: true, skill: receipt }))
  vi.stubGlobal('fetch', fetch)
  const { ctx, slots } = await fixture()
  const invalidate = vi.fn()
  ctx.on('skills/catalog-invalidated', invalidate)
  const install = slots.entries('main')[0]!.inject!()['install'] as SkillHubInjected['install']
  const signal = new AbortController().signal
  expect(await install(receipt.slug, signal)).toEqual({ ok: true, skill: receipt })
  expect(invalidate).toHaveBeenCalledTimes(1)
  fetch.mockResolvedValueOnce(Response.json({ ok: false, code: 'install-failed' }, { status: 502 }))
  expect(await install(receipt.slug, signal)).toEqual({ ok: false, code: 'install-failed' })
  expect(invalidate).toHaveBeenCalledTimes(1)
})
