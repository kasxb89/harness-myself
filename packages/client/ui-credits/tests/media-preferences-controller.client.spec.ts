/** Account lifetime, compare-and-save, and prompt metadata use the acknowledged Host state. */
import { describe, expect, it, vi } from 'vitest'
import { createMediaPreferences } from '../src/client/media-preferences-controller.ts'
import type { CreditsSnapshot } from '../src/client/session-store.ts'
import type { PreferenceReply, requestPreferences } from '../src/client/media-preferences.ts'

const owner = 'a'.repeat(64)
const initial: PreferenceReply = { accountId: '7', accountOwner: owner, preferences: { schema_version: 1, scope: 'b'.repeat(64), revision: 'c'.repeat(64), image: null, video: null } }
function source() {
  let snapshot: CreditsSnapshot = { accountEpoch: 1, loaded: true, balance: null, failure: null, session: { signedIn: true, creditsPerYuan: 1000, account: { id: '7', phone: 'fixture' }, accountOwner: owner } }
  const listeners = new Set<() => void>()
  return { getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  },
  set: (next: CreditsSnapshot) => { snapshot = next; for (const listener of listeners) listener() } }
}
async function settle() { await Promise.resolve(); await Promise.resolve() }

describe('root composer preference lifetime', () => {
  it('uses confirmed private selections and does not replace them before the save reply', async () => {
    let finish: ((value: Awaited<ReturnType<typeof requestPreferences>>) => void) | undefined
    const transport = vi.fn<typeof requestPreferences>(async operation => operation === 'save'
      ? new Promise((resolve) => { finish = resolve }) : { ok: true, reply: initial })
    const root = createMediaPreferences(source(), 20_000, transport)
    const stop = root.start(); await settle()
    expect(root.promptHint()).toBeUndefined()
    const promise = root.savePreference('video', { model: 'h3', parameters: { resolution: '768P', seconds: 15 } })
    expect(root.hooks.mediaPreferences.getSnapshot().saved?.video).toBeNull()
    expect(root.hooks.mediaPreferences.getSnapshot().saving).toBe(true)
    const updated = { ...initial, preferences: { ...initial.preferences, revision: 'd'.repeat(64), video: { model: 'h3', parameters: { resolution: '768P', seconds: 15 } } } }
    finish?.({ ok: true, reply: updated }); expect(await promise).toBe(true)
    expect(root.promptHint()).toEqual({ scope: 'b'.repeat(64), revision: 'd'.repeat(64), accountOwner: owner })
    expect(transport.mock.calls.find(([operation]) => operation === 'save')?.[2]).toMatchObject({ expected_account_owner: owner, expected_revision: 'c'.repeat(64), image: null, video: updated.preferences.video })
    stop(); expect(root.promptHint()).toBeUndefined()
  })
  it('keeps acknowledged values on conflict and requires a new explicit save after rechecking', async () => {
    const transport = vi.fn<typeof requestPreferences>(async operation => operation === 'save' ? { ok: false, failure: 'conflict' } : { ok: true, reply: initial })
    const root = createMediaPreferences(source(), 20_000, transport)
    const stop = root.start(); await settle()
    expect(await root.savePreference('image', { model: 'picture', parameters: {} })).toBe(false)
    expect(root.hooks.mediaPreferences.getSnapshot()).toMatchObject({ failure: 'conflict', saved: initial.preferences, saving: false })
    expect(transport.mock.calls.filter(([operation]) => operation === 'save')).toHaveLength(1)
    stop()
  })
  it('clears the previous login and ignores late reads and saves after account changes', async () => {
    const account = source()
    const completes: ((value: Awaited<ReturnType<typeof requestPreferences>>) => void)[] = []
    const transport = vi.fn<typeof requestPreferences>(async () => new Promise((resolve) => { completes.push(resolve) }))
    const root = createMediaPreferences(account, 20_000, transport)
    const stop = root.start()
    account.set({ ...account.getSnapshot(), accountEpoch: 2, session: { signedIn: true, creditsPerYuan: 1000, account: { id: '8', phone: 'other' }, accountOwner: 'e'.repeat(64) } })
    completes[0]?.({ ok: true, reply: initial }); await settle()
    expect(root.hooks.mediaPreferences.getSnapshot().saved).toBeNull()
    const other = { ...initial, accountId: '8', accountOwner: 'e'.repeat(64) }
    completes[1]?.({ ok: true, reply: other }); await settle()
    const save = root.savePreference('image', { model: 'picture', parameters: {} })
    account.set({ ...account.getSnapshot(), accountEpoch: 3, session: { signedIn: false, creditsPerYuan: 1000 } })
    completes[3]?.({ ok: true, reply: { ...other, preferences: { ...other.preferences, image: { model: 'picture', parameters: {} } } } })
    expect(await save).toBe(false)
    expect(root.hooks.mediaPreferences.getSnapshot()).toMatchObject({ identity: null, saved: null, catalog: null })
    stop()
  })
})

describe('restored personal model display', () => {
  const personal: PreferenceReply = { ...initial, preferences: { ...initial.preferences,
    video: { model: 'ycapi-video-one', parameters: { resolution: '768P' } } } }
  const directory = { image: [], video: [{ id: 'ycapi-video-one', displayName: 'Video One', kind: 'video' as const,
    verified: true, source: 'fixture', notes: [], params: { resolutions: ['768P'] } }],
  defaults: { image: { model: null, configured: false, available: false },
    video: { model: 'ycapi-video-one', configured: true, available: true } } }

  it('restores saved metadata first, then coalesces a background directory read for the friendly name', async () => {
    let finish: ((value: Awaited<ReturnType<typeof requestPreferences>>) => void) | undefined
    const transport = vi.fn<typeof requestPreferences>(async operation => operation === 'catalog'
      ? new Promise((resolve) => { finish = resolve }) : { ok: true, reply: personal })
    const root = createMediaPreferences(source(), 20_000, transport)
    const stop = root.start(); await settle()
    expect(transport.mock.calls.map(([operation]) => operation)).toEqual(['read', 'catalog'])
    expect(root.hooks.mediaPreferences.getSnapshot()).toMatchObject({ saved: personal.preferences, catalog: null, loading: true })
    expect(root.promptHint()).toEqual({ scope: personal.preferences.scope, revision: personal.preferences.revision, accountOwner: owner })
    const first = root.loadCatalog()
    const second = root.loadCatalog()
    expect(first).toBe(second)
    expect(transport.mock.calls.filter(([operation]) => operation === 'catalog')).toHaveLength(1)
    finish?.({ ok: true, reply: { ...personal, catalog: directory } }); await first
    expect(root.hooks.mediaPreferences.getSnapshot()).toMatchObject({ loading: false, catalog: {
      video: [{ id: 'ycapi-video-one', displayName: 'Video One' }],
    } })
    stop()
  })

  it('reads the directory once in the background for platform defaults without delaying text metadata', async () => {
    let signal: AbortSignal | undefined
    const transport = vi.fn<typeof requestPreferences>(async (operation, ownerSignal) => {
      if (operation === 'catalog') {
        signal = ownerSignal
        return new Promise(() => {})
      }
      return { ok: true, reply: initial }
    })
    const root = createMediaPreferences(source(), 20_000, transport)
    const stop = root.start(); await settle()
    expect(transport.mock.calls.map(([operation]) => operation)).toEqual(['read', 'catalog'])
    expect(root.promptHint()).toBeUndefined()
    expect(root.hooks.mediaPreferences.getSnapshot()).toMatchObject({ saved: initial.preferences, catalog: null, loading: true })
    stop()
    expect(signal?.aborted).toBe(true)
  })

  it('retains confirmed metadata when the background directory fails without blocking later text context', async () => {
    const transport = vi.fn<typeof requestPreferences>(async operation => operation === 'catalog'
      ? { ok: false, failure: 'network' } : { ok: true, reply: personal })
    const root = createMediaPreferences(source(), 20_000, transport)
    const stop = root.start(); await settle()
    expect(root.hooks.mediaPreferences.getSnapshot()).toMatchObject({ saved: personal.preferences, failure: 'network' })
    expect(root.promptHint()).toEqual({ scope: personal.preferences.scope, revision: personal.preferences.revision, accountOwner: owner })
    stop()
  })

  it('aborts the previous account directory and rejects its late response after switching accounts', async () => {
    const account = source()
    let finish: ((value: Awaited<ReturnType<typeof requestPreferences>>) => void) | undefined
    let oldSignal: AbortSignal | undefined
    let catalogs = 0
    let reads = 0
    const other: PreferenceReply = { ...initial, accountId: '8', accountOwner: 'e'.repeat(64),
      preferences: { ...initial.preferences, scope: 'f'.repeat(64) } }
    const transport = vi.fn<typeof requestPreferences>(async (operation, signal) => {
      if (operation === 'catalog') {
        catalogs += 1
        if (catalogs > 1) return { ok: false, failure: 'unavailable' }
        oldSignal = signal
        return new Promise((resolve) => { finish = resolve })
      }
      reads += 1
      return { ok: true, reply: reads === 1 ? personal : other }
    })
    const root = createMediaPreferences(account, 20_000, transport)
    const stop = root.start(); await settle()
    expect(transport.mock.calls.map(([operation]) => operation)).toEqual(['read', 'catalog'])
    account.set({ ...account.getSnapshot(), accountEpoch: 2,
      session: { signedIn: true, creditsPerYuan: 1000, account: { id: '8', phone: 'other' }, accountOwner: other.accountOwner } })
    expect(oldSignal?.aborted).toBe(true)
    await settle()
    finish?.({ ok: true, reply: { ...personal, catalog: directory } }); await settle()
    expect(root.hooks.mediaPreferences.getSnapshot()).toMatchObject({ saved: other.preferences, catalog: null, loading: false })
    expect(root.promptHint()).toBeUndefined()
    expect(transport.mock.calls.filter(([operation]) => operation === 'catalog')).toHaveLength(2)
    stop()
  })

  it('does not read preferences or a remote directory while signed out', async () => {
    const account = source()
    account.set({ ...account.getSnapshot(), session: { signedIn: false, creditsPerYuan: 1000 } })
    const transport = vi.fn<typeof requestPreferences>()
    const root = createMediaPreferences(account, 20_000, transport)
    const stop = root.start(); await settle()
    expect(transport).not.toHaveBeenCalled()
    expect(root.promptHint()).toBeUndefined()
    stop()
  })

  it('aborts the background price read before saving and never lets its late reply replace the acknowledged choice', async () => {
    let finish: ((value: Awaited<ReturnType<typeof requestPreferences>>) => void) | undefined
    let signal: AbortSignal | undefined
    const updated = { ...personal, preferences: { ...personal.preferences, revision: 'd'.repeat(64) } }
    const transport = vi.fn<typeof requestPreferences>(async (operation, ownerSignal) => {
      if (operation === 'catalog') {
        signal = ownerSignal
        return new Promise((resolve) => { finish = resolve })
      }
      return { ok: true, reply: operation === 'save' ? updated : initial }
    })
    const root = createMediaPreferences(source(), 20_000, transport)
    const stop = root.start(); await settle()
    expect(transport.mock.calls.map(([operation]) => operation)).toEqual(['read', 'catalog'])
    expect(await root.savePreference('video', personal.preferences.video)).toBe(true)
    expect(signal?.aborted).toBe(true)
    finish?.({ ok: true, reply: { ...initial, catalog: directory } }); await settle()
    expect(root.hooks.mediaPreferences.getSnapshot()).toMatchObject({
      saved: updated.preferences, catalog: null, saving: false, failure: null,
    })
    expect(root.promptHint()?.revision).toBe(updated.preferences.revision)
    stop()
  })
})
