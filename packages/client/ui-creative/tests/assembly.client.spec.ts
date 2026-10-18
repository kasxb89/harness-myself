// @vitest-environment jsdom
/** The shipped roster boots the real Loader row and releases its registrations on unload. */
import { afterEach, describe, expect, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { CreativeBody, CreativeTitle } from '../src/client/CreativeBody.tsx'
import { CreativeDraftNotice } from '../src/client/CreativeDraftNotice.tsx'

const SELF = '@deepseek-ai/dsh-client-ui-creative'
const it = createClientTest({ roster: webApp })
afterEach(() => { vi.unstubAllGlobals() })

function readable(value: unknown): value is { getSnapshot: () => unknown } {
  return typeof value === 'object' && value !== null && 'getSnapshot' in value && typeof value.getSnapshot === 'function'
}

function selection(value: unknown): value is (id: string) => void {
  return typeof value === 'function'
}

function creativeFace(injected: Record<string, unknown>) {
  const hooks = injected.hooks
  if (typeof hooks !== 'object' || hooks === null || !('creative' in hooks) || !readable(hooks.creative)
    || !selection(injected.selectProject) || !selection(injected.selectShot)) {
    throw new Error('Creation injection must provide a readable project source and selection callbacks')
  }
  return { source: hooks.creative, selectProject: injected.selectProject, selectShot: injected.selectShot }
}

describe('creative sidebar real Loader composition', () => {
  it('registers the ordinary keyed right-sidebar tab and removes every contribution on unload', async ({ start }) => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== '/credits/api/session') throw new Error(`Unexpected fixture fetch: ${url}`)
      return Response.json({ ok: true, payload: { signedIn: false, creditsPerYuan: 1000 } })
    })
    vi.stubGlobal('fetch', fetcher)
    const c = await start()
    expect(c.ctx.sidebarRightTabs.get('creative')?.id).toBe(SELF)
    expect(c.ctx.slots.entries('sidebar.right.pane.tab').find(entry => entry.options.key === SELF)?.component).toBe(CreativeBody)
    expect(c.ctx.slots.entries('sidebar.right.pane.tab.title').find(entry => entry.options.key === SELF)?.component).toBe(CreativeTitle)
    expect(c.ctx.slots.entries('shell.overlay').some(entry => entry.component === CreativeDraftNotice)).toBe(true)
    expect(c.ctx.slots.snapshot('factory:creation.projects')).toMatchObject([{ name: 'creation.projects', scope: 'session-maybe' }])
    const sidebar = c.ctx.slots.entries('sidebar.right.pane.tab').find(entry => entry.component === CreativeBody)!
    const chat = creativeFace(sidebar.inject!('session-a' as never))
    const reopened = creativeFace(sidebar.inject!('session-a' as never))
    const other = creativeFace(sidebar.inject!('session-b' as never))
    expect(chat.source).toBe(reopened.source)
    expect(chat.source).not.toBe(other.source)
    expect(chat.selectProject).toBeTypeOf('function')
    expect(chat.selectShot).toBeTypeOf('function')
    reopened.selectProject('cp_unowned'); chat.selectShot('unowned')
    expect(chat.source.getSnapshot()).toMatchObject({ phase: 'signed-out', projects: [] })
    const t = c.ctx.locale.bind('creative')
    expect(t('title')).toBe('Creation')
    expect(t('verify.pending')).toContain('unverified')
    await c.unload(SELF)
    await c.flush()
    expect(c.ctx.sidebarRightTabs.get('creative')).toBeUndefined()
    expect(c.ctx.slots.snapshot('factory:creation.projects')).toEqual([])
    expect(c.ctx.slots.entries('sidebar.right.pane.tab').some(entry => entry.options.key === SELF)).toBe(false)
    expect(c.ctx.slots.entries('shell.overlay').some(entry => entry.component === CreativeDraftNotice)).toBe(false)
    expect(() => { c.ctx.locale.register('creative', 'zh', {})() }).not.toThrow()
    await vi.waitFor(() => { expect(c.ctx.slots.entries('sidebar.right.pane.tab.title').some(entry => entry.options.key === SELF)).toBe(false) })
  }, 60_000)
})
