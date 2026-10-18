// @vitest-environment jsdom
/** Native controls stream authorized media and retire playback with each renderer revision. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { DocumentContent } from '../src/client/document/contract.ts'
import { MediaBody, type MediaBodyProps } from '../src/client/media/MediaBody.tsx'
import { en, zh } from '../src/client/media/locales.ts'
import { mediaUrl } from '../src/client/media/source.ts'
import { harness, SESSION } from './fixtures.client.ts'

let pauseSpy: MockInstance<() => void>
let loadSpy: MockInstance<() => void>

beforeEach(() => {
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup(name = 'movie.mp4') {
  const h = harness()
  const loaded = vi.fn()
  const failed = vi.fn()
  const reload = vi.fn()
  const request: Extract<DocumentContent, { kind: 'renderer' }> = { kind: 'renderer', revision: 1, loaded, failed, reload }
  const base = h.props()
  const absolutePath = `D:\\Mounted\\${name}`
  h.useResource.mockImplementation(() => ({ status: 'live', value: h.file === undefined ? undefined : { ...h.file, absolutePath }, failure: undefined }))
  const props: MediaBodyProps = {
    ...base, content: request, resourceAddress: `dsh-resource://file/session/${SESSION}/work/${name}`,
    wrap: false, scrollportRef: vi.fn(), addResource: vi.fn(), setResources: vi.fn(), t: makeTranslate(en),
    useWorkspaces: selector => selector({ phase: 'ready', items: [
      { workspaceId: 'wrong' as never, title: 'Other', path: '/other', sessionIds: ['other-session' as never], createdAt: '', updatedAt: '' },
      { workspaceId: 'real' as never, title: 'Mounted', path: 'D:\\Mounted', sessionIds: [SESSION], createdAt: '', updatedAt: '' },
    ], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', error: null }),
  }
  return { h, props, loaded, failed, reload, absolutePath }
}

it('shows an inline MP4 player with native controls and metadata loading, without whole-file reads', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const h = setup()
  const view = render(<MediaBody {...h.props} />)
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe(en.loading)
  const player = await screen.findByLabelText('Media preview: movie.mp4') as HTMLVideoElement
  expect(player.tagName).toBe('VIDEO')
  expect(player.controls).toBe(true)
  expect(player.playsInline).toBe(true)
  expect(player.preload).toBe('metadata')
  expect(player.getAttribute('src')).toBe(mediaUrl(h.absolutePath, 'v1'))
  expect(player.autoplay).toBe(false)
  fireEvent.loadedMetadata(player)
  expect(h.loaded).toHaveBeenCalledExactlyOnceWith('v1')
  expect(screen.queryByRole('status')).toBeNull()
  expect(h.h.bytes).not.toHaveBeenCalled()
  expect(h.h.read).not.toHaveBeenCalled()
  expect(view.container.querySelector('video')).toBe(player)
})

it('streams mounted files using the addressed Session membership instead of another selected Workspace', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const h = setup()
  render(<MediaBody {...h.props} />)
  const player = await screen.findByLabelText('Media preview: movie.mp4')
  expect(new URL(player.getAttribute('src')!, 'https://app.invalid').searchParams.get('workspaceId')).toBe('real')
})

it('takes Workspace membership from a foreign file address rather than the surrounding Session', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 })))
  const h = setup()
  render(<MediaBody {...h.props} resourceAddress="dsh-resource://file/session/other-session/work/movie.mp4" />)
  const player = await screen.findByLabelText('Media preview: movie.mp4')
  expect(new URL(player.getAttribute('src')!, 'https://app.invalid').searchParams.get('workspaceId')).toBe('wrong')
})

it('waits for Host metadata instead of guessing an absolute path from the file address', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const h = setup()
  h.h.useResource.mockReturnValue({ status: 'loading', value: undefined, failure: undefined })
  const view = render(<MediaBody {...h.props} />)
  expect(fetch).not.toHaveBeenCalled()
  expect(screen.getByRole('status')).toBeTruthy()
  h.h.useResource.mockReturnValue({ status: 'live', value: { absolutePath: h.absolutePath, version: 'v1', bytes: 42 }, failure: undefined })
  view.rerender(<MediaBody {...h.props} />)
  expect(await screen.findByLabelText('Media preview: movie.mp4')).toBeTruthy()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('shows a failed metadata read without waiting forever or issuing a guessed stream request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const h = setup()
  h.h.useResource.mockReturnValue({ status: 'none', value: undefined, failure: undefined })
  render(<MediaBody {...h.props} />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.unavailable)
  expect(fetch).not.toHaveBeenCalled()
  expect(h.failed).toHaveBeenCalledOnce()
})

it('renders audio with the same streamed source and controls', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  const h = setup('dialogue.wav')
  render(<MediaBody {...h.props} />)
  const player = await screen.findByLabelText('Media preview: dialogue.wav') as HTMLAudioElement
  expect(player.tagName).toBe('AUDIO')
  expect(player.controls).toBe(true)
  expect(player.preload).toBe('metadata')
  fireEvent.loadedMetadata(player)
  expect(h.loaded).toHaveBeenCalledWith('v1')
})

it.each([en, zh])('reports a decoder failure in the active locale and retains retry', async (dictionary) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  const h = setup()
  render(<MediaBody {...h.props} t={makeTranslate(dictionary)} />)
  const player = await screen.findByLabelText(makeTranslate(dictionary)('preview', { name: 'movie.mp4' }))
  fireEvent.error(player)
  expect(screen.getByText(dictionary.failed)).toBeTruthy()
  expect(h.failed).toHaveBeenCalledOnce()
  expect(h.loaded).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: dictionary.retry }))
  expect(h.reload).toHaveBeenCalledOnce()
  expect(player.getAttribute('src')).toBeNull()
})

it('reports a denied source without marking its version as loaded', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })))
  const h = setup()
  render(<MediaBody {...h.props} />)
  expect(await screen.findByText(en.unavailable)).toBeTruthy()
  expect(h.failed).toHaveBeenCalledOnce()
  expect(h.loaded).not.toHaveBeenCalled()
})

it('keeps the displayed version until the owner requests another revision, then releases the old stream', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const h = setup()
  const view = render(<MediaBody {...h.props} />)
  const old = await screen.findByLabelText('Media preview: movie.mp4')
  fireEvent.loadedMetadata(old)
  h.h.setVersion('v2')
  view.rerender(<MediaBody {...h.props} />)
  expect(screen.getByLabelText('Media preview: movie.mp4')).toBe(old)
  expect(fetch).toHaveBeenCalledTimes(1)
  view.rerender(<MediaBody {...h.props} content={{ ...h.props.content, kind: 'renderer', revision: 2, loaded: h.loaded, failed: h.failed, reload: h.reload }} />)
  await waitFor(() => { expect(screen.getByLabelText('Media preview: movie.mp4')).not.toBe(old) })
  expect(old.getAttribute('src')).toBeNull()
  expect(pauseSpy).toHaveBeenCalled()
  expect(loadSpy).toHaveBeenCalled()
  fireEvent.loadedMetadata(screen.getByLabelText('Media preview: movie.mp4'))
  expect(h.loaded).toHaveBeenLastCalledWith('v2')
})

it.each(['unmount', 'close', 'replace'] as const)('cancels an outstanding source request on %s without publishing late results', async (transition) => {
  const pending = Promise.withResolvers<Response>()
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(pending.promise)
  vi.stubGlobal('fetch', fetch)
  const h = setup()
  const view = render(<MediaBody {...h.props} />)
  const signal = fetch.mock.calls[0]?.[1]?.signal
  if (transition === 'unmount') view.unmount()
  else if (transition === 'close') act(() => { h.h.controller.abort() })
  else view.rerender(<MediaBody {...h.props} content={{ kind: 'bytes', data: new Uint8Array() }} />)
  expect(signal?.aborted).toBe(true)
  await act(async () => { pending.resolve(new Response(null, { status: 200 })); await pending.promise })
  expect(h.loaded).not.toHaveBeenCalled()
  expect(h.failed).not.toHaveBeenCalled()
  expect(view.container.querySelector('video')).toBeNull()
})

it('releases native playback on tab closure while the body is still mounted', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  const h = setup()
  const view = render(<MediaBody {...h.props} />)
  const player = await screen.findByLabelText('Media preview: movie.mp4')
  act(() => { h.h.controller.abort() })
  expect(view.container.querySelector('video')).toBeNull()
  expect(player.getAttribute('src')).toBeNull()
  expect(pauseSpy).toHaveBeenCalledOnce()
})
