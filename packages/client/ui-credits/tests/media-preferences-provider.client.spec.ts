// @vitest-environment jsdom
/** Root admission metadata exists independently of any mounted composer. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, it, vi } from 'vitest'
import { LayoutController } from '../../ui-layout/src/client/service.ts'
import { createLayoutStore } from '../../ui-layout/src/client/stores.ts'
import { apply, inject } from '../src/client/index.ts'
import * as credits from '../src/client/session-store.ts'
import * as mediaPreferences from '../src/client/media-preferences-controller.ts'
import type { CreditsSnapshot } from '../src/client/session-store.ts'

const roots: Context[] = []
afterEach(async () => { for (const root of roots.splice(0)) await root.fiber.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const pathOf = (url: RequestInfo | URL): string => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
const owner = 'a'.repeat(64)
const preference = { schema_version: 1, scope: 'b'.repeat(64), revision: 'c'.repeat(64), image: null, video: { model: 'h3', parameters: { resolution: '768P' } } }
async function fixture(wait: false | 'restore' | 'catalog' = false, followDefaults = false) {
  const createPreferences = mediaPreferences.createMediaPreferences
  let controller: ReturnType<typeof createPreferences> | undefined
  vi.spyOn(mediaPreferences, 'createMediaPreferences').mockImplementation((...args) => {
    controller = createPreferences(...args)
    return controller
  })
  let storedPreference = { ...preference, video: followDefaults ? null : preference.video }
  const snapshot: CreditsSnapshot = { loaded: true, accountEpoch: 1, balance: null, failure: null,
    session: { signedIn: true, creditsPerYuan: 1000, account: { id: '7', phone: 'fixture' }, accountOwner: owner } }
  vi.spyOn(credits, 'createCreditsSessionSource').mockReturnValue({ getSnapshot: () => snapshot, subscribe: () => () => {} })
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (pathOf(url).endsWith('/media/preferences/catalog') && wait === 'catalog') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
      })
    }
    if (pathOf(url).endsWith('/media/preferences')) {
      if (wait === 'restore') return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }) })
      if (init?.method === 'PUT') storedPreference = { ...preference, revision: 'd'.repeat(64),
        video: { model: 'h3', parameters: { resolution: '2K' } } }
      return Response.json({ ok: true, account: { id: '7' }, accountOwner: owner, payload: storedPreference })
    }
    return Response.json({ ok: false, code: 'UNAVAILABLE' })
  })
  vi.stubGlobal('fetch', fetcher)
  const ctx = new Context(); roots.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  const state = createLayoutStore().create()
  ctx.provide('layout', new LayoutController(state.actions, () => false, {
    getSnapshot: () => state.getSnapshot().panelInfo, subscribe: listener => state.subscribe(listener),
  }))
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin({ inject: [...inject], apply }).await()
  if (controller === undefined) throw new Error('Missing root media preferences controller')
  return { ctx, fetcher, controller }
}
it('delegates other providers and supplies only acknowledged scope and revision before a composer mounts', async () => {
  const { ctx } = await fixture()
  await vi.waitFor(() => { expect(ctx.creditsSession.getSnapshot().session?.accountOwner).toBe(owner) })
  const request = { sessionId: 'new-chat' as PropsRuntime<'conversation.input.right'>['sessionId'], mode: 'queue' as const }
  await vi.waitFor(async () => {
    expect(await ctx.waterfall('conversation/prompt-context', request, () => Promise.resolve({ sibling: { retained: true } })))
      .toEqual({ sibling: { retained: true }, credits_media_preferences: {
        scope: preference.scope, revision: preference.revision, accountOwner: owner,
      } })
  })
})
it('returns ordinary text prompt context immediately while the preference restore is unavailable', async () => {
  const { ctx, fetcher } = await fixture('restore')
  const request = { sessionId: 'new-chat' as PropsRuntime<'conversation.input.right'>['sessionId'], mode: 'queue' as const }
  expect(await ctx.waterfall('conversation/prompt-context', request, () => Promise.resolve({}))).toEqual({})
  expect(fetcher.mock.calls.some(([url]) => pathOf(url).includes('/catalog'))).toBe(false)
})
it('keeps acknowledged prompt metadata immediately available while the background directory remains pending', async () => {
  const { ctx, fetcher } = await fixture('catalog')
  await vi.waitFor(() => { expect(fetcher.mock.calls.some(([url]) => pathOf(url).endsWith('/media/preferences/catalog'))).toBe(true) })
  const request = { sessionId: 'new-chat' as PropsRuntime<'conversation.input.right'>['sessionId'], mode: 'queue' as const }
  expect(await ctx.waterfall('conversation/prompt-context', request, () => Promise.resolve({}))).toEqual({
    credits_media_preferences: { scope: preference.scope, revision: preference.revision, accountOwner: owner },
  })
})
it('does not delay ordinary text while default-model unit prices are loading in the background', async () => {
  const { ctx, fetcher } = await fixture('catalog', true)
  await vi.waitFor(() => { expect(fetcher.mock.calls.some(([url]) => pathOf(url).endsWith('/media/preferences/catalog'))).toBe(true) })
  const request = { sessionId: 'new-chat' as PropsRuntime<'conversation.input.right'>['sessionId'], mode: 'queue' as const }
  expect(await ctx.waterfall('conversation/prompt-context', request, () => Promise.resolve({}))).toEqual({})
})
it('captures the prior revision before a slow sibling provider while later submissions use the completed save', async () => {
  const { ctx, controller } = await fixture()
  const request = { sessionId: 'new-chat' as PropsRuntime<'conversation.input.right'>['sessionId'], mode: 'queue' as const }
  await vi.waitFor(() => { expect(controller.promptHint()?.revision).toBe(preference.revision) })
  let resume: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { resume = resolve })
  let entered = false
  const pending = ctx.waterfall('conversation/prompt-context', request, async () => {
    entered = true
    await gate
    return { sibling: { retained: true } }
  })
  await vi.waitFor(() => { expect(entered).toBe(true) })
  expect(await controller.savePreference('video', { model: 'h3', parameters: { resolution: '2K' } })).toBe(true)
  expect(controller.promptHint()?.revision).toBe('d'.repeat(64))
  if (resume === undefined) throw new Error('Missing sibling provider continuation')
  resume()
  expect(await pending).toEqual({ sibling: { retained: true }, credits_media_preferences: {
    scope: preference.scope, revision: preference.revision, accountOwner: owner,
  } })
  expect(await ctx.waterfall('conversation/prompt-context', request, () => Promise.resolve({}))).toEqual({
    credits_media_preferences: { scope: preference.scope, revision: 'd'.repeat(64), accountOwner: owner },
  })
})
