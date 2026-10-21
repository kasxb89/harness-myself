// @vitest-environment jsdom
/** The legacy custom-loader protocol reuses authenticated playback and its original cancellation. */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { registerLegacyMediaViewer } from '../src/client/media/legacy-viewer.tsx'
import { en } from '../src/client/media/locales.ts'
import { mediaUrl } from '../src/client/media/source.ts'

interface Descriptor {
  readonly id: string
  readonly exts: readonly string[]
  readonly fetchStrategy: 'custom'
  readonly load: (path: string, scope: { sessionId: string; cwd?: string }, signal?: AbortSignal) => Promise<unknown>
  readonly component: (props: { customData?: unknown }) => ReactNode
}

/** Exact custom load/cleanup/component sequence used by better-sidebar 0.19.1 EditorHost. */
function LegacyHost(props: { readonly descriptor: Descriptor; readonly path: string; readonly sessionId: string }) {
  const [load, setLoad] = useState<{ readonly customData: unknown }>()
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoad(undefined)
    void props.descriptor.load(props.path, { sessionId: props.sessionId, cwd: '/unrelated/current' }, controller.signal)
      .then((customData) => { if (!cancelled) setLoad({ customData }) })
    return () => { cancelled = true; controller.abort() }
  }, [props.descriptor, props.path, props.sessionId])
  return load === undefined ? null : createElement(props.descriptor.component, { customData: load.customData })
}

type WorkspaceSnapshot = ReturnType<Context['workspaces']['list']['getSnapshot']>
const SESSION = 'session-one'
const PATH = 'D:\\云枢\\media\\角色 #1.mp4'

function initialWorkspaces(): WorkspaceSnapshot {
  return { phase: 'ready', state: 'idle', error: null, archivedSessionIds: [], pinnedSessionIds: [], items: [
    { workspaceId: 'unrelated' as never, title: 'Current', path: '/unrelated/current', sessionIds: ['unrelated' as never], createdAt: '', updatedAt: '' },
    { workspaceId: 'addressed' as never, title: 'Addressed', path: 'D:\\云枢', sessionIds: [SESSION as never], createdAt: '', updatedAt: '' },
  ] }
}

const owners: Array<Context['fiber']> = []
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(async () => {
  cleanup()
  await Promise.all(owners.splice(0).map(fiber => fiber.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function boot(legacy = true, snapshot = initialWorkspaces()) {
  const ctx = new Context()
  const workspaces = createSnapshotStore(snapshot)
  const stat = vi.fn<ClientRemote['workspaceFiles']['stat']>().mockResolvedValue({ ok: true, value: { absolutePath: PATH, version: 'v1', bytes: 42 } })
  ctx.provide('locale', { bind: () => makeTranslate(en) } as never)
  ctx.provide('remote', { workspaceFiles: { stat } } as never)
  ctx.provide('remote.workspaceFiles', { stat } as never)
  ctx.provide('workspaces', { list: workspaces } as never)
  const descriptors: Descriptor[] = []
  const registerFileViewer = vi.fn((descriptor: Descriptor) => {
    descriptors.push(descriptor)
    return () => { descriptors.splice(descriptors.indexOf(descriptor), 1) }
  })
  const provide = () => ctx.plugin((scope) => { scope.provide('betterSidebar', { registerFileViewer }) })
  const service = legacy ? provide() : undefined
  if (service !== undefined) { owners.push(service); await service.await() }
  const fiber = ctx.plugin((scope) => { registerLegacyMediaViewer(scope, ['mp4', 'wav']) })
  owners.push(fiber)
  await fiber.await()
  if (legacy) await waitFor(() => { expect(descriptors).toHaveLength(1) })
  const descriptor = (): Descriptor => {
    if (descriptors[0] === undefined) throw new Error('legacy descriptor not registered')
    return descriptors[0]
  }
  return { ctx, fiber, service, provide, descriptors, descriptor, stat, workspaces, registerFileViewer }
}

it('registers only when the optional service appears, and replaces registrations with the service lifetime', async () => {
  const h = await boot(false)
  expect(h.descriptors).toEqual([])
  const first = h.provide()
  owners.push(first)
  await first.await()
  await waitFor(() => { expect(h.descriptors).toHaveLength(1) })
  expect(h.descriptor().exts).toEqual(['mp4', 'wav'])
  expect(h.descriptor().fetchStrategy).toBe('custom')
  await first.dispose()
  expect(h.descriptors).toEqual([])
  const second = h.provide()
  owners.push(second)
  await second.await()
  await waitFor(() => { expect(h.descriptors).toHaveLength(1) })
  expect(h.registerFileViewer).toHaveBeenCalledTimes(2)
  await h.fiber.dispose()
  expect(h.descriptors).toEqual([])
})

it('uses Host metadata for Windows paths and the opened Session membership, ignoring legacy cwd', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const h = await boot()
  render(<LegacyHost descriptor={h.descriptor()} path={PATH} sessionId={SESSION} />)
  const video = await screen.findByLabelText('Media preview: 角色 #1.mp4') as HTMLVideoElement
  expect(h.stat).toHaveBeenCalledWith(SESSION, PATH, expect.any(AbortSignal))
  expect(video.getAttribute('src')).toBe(mediaUrl(PATH, 'v1', 'addressed'))
  expect(video.controls).toBe(true)
  expect(video.playsInline).toBe(true)
  expect(video.autoplay).toBe(false)
  fireEvent.loadedMetadata(video)
  expect(screen.queryByRole('status')).toBeNull()
})

it.each([403, 404])('shows retry after an authorization %s and does not guess a missing membership', async (status) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status }))
  vi.stubGlobal('fetch', fetch)
  const h = await boot(true, { ...initialWorkspaces(), items: [] })
  render(<LegacyHost descriptor={h.descriptor()} path={PATH} sessionId={SESSION} />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.unavailable)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(screen.queryByLabelText('Media preview: 角色 #1.mp4')).toBeNull()
})

it('retries missing metadata and decoder failures with a fresh Host stat in the 0.19 host', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  const h = await boot()
  h.stat.mockResolvedValueOnce({ ok: false, error: { code: 'workspace-file/not-found', message: 'absent', details: {} } } as never)
  render(<LegacyHost descriptor={h.descriptor()} path={PATH} sessionId={SESSION} />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.unavailable)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  const old = await screen.findByLabelText('Media preview: 角色 #1.mp4')
  expect(h.stat).toHaveBeenCalledTimes(2)
  fireEvent.error(old)
  expect(screen.getByRole('alert')).toHaveProperty('textContent', en.failed)
  expect(old.getAttribute('src')).toBeNull()
  h.stat.mockResolvedValue({ ok: true, value: { absolutePath: PATH, version: 'v2', bytes: 42 } })
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  const next = await screen.findByLabelText('Media preview: 角色 #1.mp4')
  expect(next.getAttribute('src')).toBe(mediaUrl(PATH, 'v2'))
  expect(h.stat).toHaveBeenCalledTimes(3)
})

it('waits for the Workspace baseline and cancels its subscription when the old host closes', async () => {
  const h = await boot(true, { ...initialWorkspaces(), phase: 'pending', state: 'loading', items: [] })
  const subscribe = vi.spyOn(h.workspaces, 'subscribe')
  const view = render(<LegacyHost descriptor={h.descriptor()} path={PATH} sessionId={SESSION} />)
  await waitFor(() => { expect(subscribe).toHaveBeenCalledOnce() })
  const signal = h.stat.mock.calls[0]?.[2]
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { h.workspaces.set(initialWorkspaces()) })
  expect(view.container.querySelector('video')).toBeNull()
  await h.fiber.dispose()
})

it('cancels a pending custom load on tab replacement and never publishes the old result', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  const h = await boot()
  const pending = Promise.withResolvers<Awaited<ReturnType<ClientRemote['workspaceFiles']['stat']>>>()
  h.stat.mockReturnValueOnce(pending.promise)
  const view = render(<LegacyHost descriptor={h.descriptor()} path={PATH} sessionId={SESSION} />)
  await waitFor(() => { expect(h.stat).toHaveBeenCalledOnce() })
  const oldSignal = h.stat.mock.calls[0]?.[2]
  view.rerender(<LegacyHost descriptor={h.descriptor()} path="new.wav" sessionId={SESSION} />)
  expect(oldSignal?.aborted).toBe(true)
  expect(await screen.findByLabelText('Media preview: new.wav')).toHaveProperty('tagName', 'AUDIO')
  await act(async () => { pending.resolve({ ok: true, value: { absolutePath: '/stale.mp4', version: 'old' } }); await pending.promise })
  expect(screen.queryByLabelText('Media preview: 角色 #1.mp4')).toBeNull()
})

it('releases playback on tab switch and service removal while the custom component is mounted', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  const h = await boot()
  const view = render(<LegacyHost descriptor={h.descriptor()} path={PATH} sessionId={SESSION} />)
  const first = await screen.findByLabelText('Media preview: 角色 #1.mp4')
  view.rerender(<LegacyHost descriptor={h.descriptor()} path="second.mp4" sessionId={SESSION} />)
  const second = await screen.findByLabelText('Media preview: second.mp4')
  expect(first.getAttribute('src')).toBeNull()
  await act(async () => { await h.service?.dispose() })
  expect(second.getAttribute('src')).toBeNull()
  expect(view.container.querySelector('video')).toBeNull()
  expect(h.descriptors).toEqual([])
})
