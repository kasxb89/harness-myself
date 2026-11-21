// @vitest-environment jsdom
/** Navigation stays available while authenticated demand services retain their own guards. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as clientPlugin from '../src/client/index.ts'
import { DemandPage } from '../src/client/DemandPage.tsx'
import type { DemandWorkspaceFace } from '../src/client/types.ts'
import { exampleCommunityConfig } from './community-model-fixtures.client.ts'
import { forumExampleConfig } from './forum-model-fixtures.client.ts'
import * as hostPlugin from '../src/index.ts'
import { DEMANDS_CONFIG_GLOBAL, type Config } from '../src/config.ts'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

type AccountSnapshot = ReturnType<Context['creditsSession']['getSnapshot']>
type FixtureFace = Pick<DemandWorkspaceFace, 'hooks' | 'refresh' | 'loadMoreRequests' | 'openRequest' | 'startRequest'
  | 'startServiceRequest' | 'send' | 'addAttachments' | 'openLogin' | 'showcaseItems' | 'showcases'> & {
    community: Pick<DemandWorkspaceFace['community'], 'refresh' | 'loadOrders' | 'openOrder' | 'startPublication'
    | 'publish' | 'sendMessage' | 'addAttachments'>
    forum: Pick<DemandWorkspaceFace['forum'], 'refresh' | 'openPost' | 'startPost' | 'publishPost' | 'sendComment' | 'setLiked'>
  }
const ownerHash = 'a'.repeat(64)
const owners = new Set<Fiber>()

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasFunctions(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return record(value) && names.every(name => typeof value[name] === 'function')
}

function fixtureFace(value: Record<string, unknown>): value is Record<string, unknown> & FixtureFace {
  const hooks = value.hooks
  return hasFunctions(value, ['refresh', 'loadMoreRequests', 'openRequest', 'startRequest', 'startServiceRequest',
    'send', 'addAttachments', 'openLogin'])
    && hasFunctions(value.community, ['refresh', 'loadOrders', 'openOrder', 'startPublication', 'publish', 'sendMessage', 'addAttachments'])
    && hasFunctions(value.forum, ['refresh', 'openPost', 'startPost', 'publishPost', 'sendComment', 'setLiked'])
    && hasFunctions(value.showcases, ['refreshShowcases', 'loadMoreShowcases', 'setShowcaseCategory'])
    && record(hooks) && ['demands', 'community', 'forum', 'showcases'].every(key => hasFunctions(hooks[key], ['getSnapshot', 'subscribe']))
}

function FixtureFrame({ renderSlot }: PropsRenderSlots<'main' | 'sidebar.panellist'>) {
  return <>{renderSlot('main', {})}{renderSlot('sidebar.panellist', { size: 20, active: false })}</>
}

afterEach(async () => {
  try { await Promise.all([...owners].map(owner => owner.dispose())) }
  finally { owners.clear(); vi.unstubAllGlobals(); localStorage.clear() }
})

async function mount(state: 'signed-out' | 'loading' | 'error' | 'disabled' = 'signed-out', enabled?: boolean, hostConfig?: Config) {
  const signedIn = state === 'error' || state === 'disabled'
  const account = createSnapshotStore<AccountSnapshot>({ accountEpoch: 1, loaded: state !== 'loading', balance: null, failure: null,
    session: signedIn ? { signedIn: true, creditsPerYuan: 1000, account: { id: '1', phone: '' }, accountOwner: ownerHash }
      : state === 'loading' ? null : { signedIn: false, creditsPerYuan: 1000 } })
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const payload = path === '/credits/api/demands/config' ? { config: { enabled: false, categories: [], upload_rules: {
      max_image_bytes: 20_971_520, max_video_bytes: 536_870_912, max_attachments: 8, chunk_bytes: 4,
      allowed_mime_types: ['image/png', 'video/mp4'], upload_ttl_seconds: 86400,
    } }, server_time: 100, capabilities: { polling: true, resumable_upload: true } }
      : path === '/credits/api/community-demands/config' ? exampleCommunityConfig(false)
        : path === '/credits/api/forum/config' ? forumExampleConfig(false)
          : { items: [], next_cursor: '', next_before_id: null, has_more: false, server_time: 100 }
    return new Response(JSON.stringify(state === 'disabled'
      ? { ok: true, account: { id: '1' }, accountOwner: ownerHash, payload }
      : { ok: false, code: 'SERVICE_UNAVAILABLE' }), {
      status: state === 'disabled' ? 200 : 503, headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetcher)
  const root = new Context()
  let ctx: Context | undefined
  const owner = root.plugin((owned: Context) => { ctx = owned })
  owners.add(owner)
  await owner.await()
  if (ctx === undefined) throw new Error('Demand fixture owner did not activate')
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('creditsSession', account)
  const selectPanel = vi.fn()
  ctx.provide('layout', { panelInfo: createSnapshotStore({ activePanelId: null }), selectPanel })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' } } }, FixtureFrame)
  if (hostConfig !== undefined) {
    const host = ctx.plugin(hostPlugin, hostConfig)
    await host.await()
    const rows: IndexInjection[] = []
    ctx.emit('webserver/index-inject', rows)
    for (const row of rows) if (row.kind === 'global') vi.stubGlobal(row.name, row.value)
  }
  const plugin = ctx.plugin(clientPlugin, enabled === undefined ? {} : { enabled })
  await plugin.await()
  const entry = slots.entries('main').find(row => row.options.key === 'demands' && row.component === DemandPage)
  if (entry?.inject === undefined) throw new Error('Demand page inject was not registered')
  const face = entry.inject()
  if (!fixtureFace(face)) throw new Error('Demand page commands or observables were not registered')
  return { slots, plugin, face, fetcher, account, selectPanel }
}

describe('demand navigation registration', () => {
  it('consumes Host-projected public cases instead of silently using empty browser defaults', async () => {
    const showcaseItems: NonNullable<Config['showcaseItems']> = [{ id: 'public-case', title: '产品界面', description: '公开素材',
      category: 'web', coverUrl: '/case-media/cover.png', media: [{ kind: 'image', url: '/case-media/image.png' }],
      sourceName: 'Original author', sourceUrl: 'https://example.com/project', attribution: 'MIT' }]
    const h = await mount('signed-out', undefined, { enabled: false, showcaseItems })
    expect(h.face.showcaseItems).toEqual([{ ...showcaseItems[0], media: [{ ...showcaseItems[0]?.media[0], posterUrl: '' }] }])
    expect(h.slots.entries('sidebar.panellist')).toEqual([])
    expect(h.fetcher).not.toHaveBeenCalled()
  })

  it('keeps an explicit Client setting authoritative over the public bootstrap default', async () => {
    const h = await mount('signed-out', true, { enabled: false })
    expect(h.slots.entries('sidebar.panellist').map(entry => entry.options.id)).toEqual(['demands'])
  })

  it('rejects malformed public bootstrap data before activating account reads', async () => {
    vi.stubGlobal(DEMANDS_CONFIG_GLOBAL, { showcaseItems: 'not-a-catalogue' })
    await expect(mount()).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['signed-out', 'loading', 'error', 'disabled'] as const)('retains Publish request while service availability is %s', async (state) => {
    const h = await mount(state, true)
    const availability = state === 'signed-out' ? 'login-required' : state
    await vi.waitFor(() => {
      expect(h.face.hooks.demands.getSnapshot().availability).toBe(availability)
      expect(h.face.hooks.community.getSnapshot().availability).toBe(availability)
      expect(h.face.hooks.forum.getSnapshot().availability).toBe(availability)
    })
    expect(h.slots.entries('sidebar.panellist').map(entry => entry.options.id)).toEqual(['demands'])
    const entries = h.slots.entries('sidebar.panellist')
    h.account.set({ accountEpoch: 2, loaded: true, session: { signedIn: false, creditsPerYuan: 1000 }, balance: null, failure: null })
    expect(h.slots.entries('sidebar.panellist')).toBe(entries)
    await h.plugin.dispose()
    expect(h.slots.entries('sidebar.panellist')).toEqual([])
    expect(h.slots.entries('main')).toEqual([])
  })

  it('defaults the local carrier to a visible entry', async () => {
    const h = await mount()
    expect(h.slots.entries('sidebar.panellist').map(entry => entry.options.id)).toEqual(['demands'])
  })

  it('preserves an explicit local disable without starting authenticated service reads', async () => {
    const disabled = await mount('disabled', false)
    expect(disabled.slots.entries('sidebar.panellist')).toEqual([])
    expect(disabled.fetcher).not.toHaveBeenCalled()
  })

  it('starts public case reads only after login and stops refresh commands on sign-out', async () => {
    const h = await mount()
    expect(h.fetcher).not.toHaveBeenCalled()
    h.account.set({ accountEpoch: 2, loaded: true, balance: null, failure: null,
      session: { signedIn: true, creditsPerYuan: 1000, account: { id: '1', phone: '' }, accountOwner: ownerHash } })
    await vi.waitFor(() => {
      expect(h.fetcher.mock.calls.filter(([input]) => input === '/credits/api/demand-showcases/config')).toHaveLength(1)
    })
    h.account.set({ accountEpoch: 3, loaded: true, session: { signedIn: false, creditsPerYuan: 1000 }, balance: null, failure: null })
    h.face.showcases.refreshShowcases()
    await Promise.resolve()
    expect(h.fetcher.mock.calls.filter(([input]) => input === '/credits/api/demand-showcases/config')).toHaveLength(1)
  })

  it('keeps guest private lists, chats, uploads and all three services behind the existing account guard', async () => {
    const h = await mount()
    const file = new File(['private'], 'private.png', { type: 'image/png' })
    h.face.refresh(); h.face.loadMoreRequests(); h.face.openRequest('private-demand')
    h.face.startRequest('engineer'); h.face.startServiceRequest('service'); h.face.send(); h.face.addAttachments([file])
    h.face.community.refresh(); h.face.community.loadOrders('all'); h.face.community.openOrder('private-order')
    h.face.community.startPublication(); h.face.community.publish('private-draft'); h.face.community.sendMessage('private-order')
    h.face.community.addAttachments({ kind: 'order', orderId: 'private-order' }, 'conversation', [file])
    h.face.forum.refresh(); h.face.forum.openPost('private-post'); h.face.forum.startPost()
    h.face.forum.publishPost('private-draft'); h.face.forum.sendComment('private-post'); h.face.forum.setLiked('private-post', true)
    await Promise.resolve()
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(h.face.hooks.demands.getSnapshot()).toMatchObject({ availability: 'login-required', requests: [], conversation: null })
    expect(h.face.hooks.community.getSnapshot()).toMatchObject({ availability: 'login-required', accountId: null, conversation: null })
    expect(h.face.hooks.forum.getSnapshot()).toMatchObject({ availability: 'login-required', accountId: null })
    h.face.openLogin()
    expect(h.selectPanel).toHaveBeenCalledExactlyOnceWith('credits')
  })
})
