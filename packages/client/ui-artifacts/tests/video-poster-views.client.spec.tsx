// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactPreview } from '../src/client/ArtifactPreview.tsx'
import type { ArtifactEntry } from '../src/client/ArtifactsPage.tsx'
import { VideoThumbnail } from '../src/client/VideoPoster.tsx'
import { VideoPosterPool, type ReadVideoPoster } from '../src/client/video-poster.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
const entry: ArtifactEntry = { path: '/old/video.mp4', name: 'video.mp4', kind: 'video', size: 1024, mtimeMs: 100 }
const cover = 'data:image/jpeg;base64,Zmlyc3Q='
const t = (key: string): string => key

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** A controlled viewport transition; actual browser codecs are covered in the built Web lane. */
function viewport() {
  const observers: Observer[] = []
  class Observer implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = '0px'
    readonly scrollMargin = '0px'
    readonly thresholds = [0]
    readonly targets = new Set<Element>()
    constructor(readonly callback: IntersectionObserverCallback) { observers.push(this) }
    observe(target: Element): void { this.targets.add(target) }
    unobserve(target: Element): void { this.targets.delete(target) }
    disconnect(): void { this.targets.clear() }
    takeRecords(): IntersectionObserverEntry[] { return [] }
  }
  vi.stubGlobal('IntersectionObserver', Observer)
  return (visible: boolean): void => {
    for (const observer of observers) observer.callback([...observer.targets].map(target =>
      ({ target, isIntersecting: visible } as IntersectionObserverEntry)), observer)
  }
}

describe('visible artifact rows and shared selected-player posters', () => {
  it('leaves unseen videos inert, decodes intersecting rows, and keeps the filename button free of thumbnail copy', async () => {
    const visible = viewport()
    const read = vi.fn<ReadVideoPoster>().mockResolvedValue(cover)
    const { container, unmount } = render(<VideoThumbnail entry={entry} read={read} />)
    expect(container.querySelector('[data-video-poster]')?.getAttribute('data-video-poster')).toBe('idle')
    expect(read).not.toHaveBeenCalled()
    act(() => { visible(true) })
    await waitFor(() => { expect(container.querySelector('img')?.getAttribute('src')).toBe(cover) })
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('')
    expect(container.querySelector('[data-video-poster]')?.getAttribute('data-video-poster')).toBe('ready')
    expect(read).toHaveBeenCalledOnce()
    const signal = read.mock.calls[0]?.[1]
    unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('shares a row lease with detail, and cancelling the row does not remove the player cover or controls', async () => {
    const visible = viewport()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load')
    const frame = deferred<string | null>()
    let decoderSignal: AbortSignal | undefined
    const decode = vi.fn<ReadVideoPoster>((_selected, signal) => { decoderSignal = signal; return frame.promise })
    const pool = new VideoPosterPool(15_000, decode)
    try {
      const { container, unmount } = render(<>
        <VideoThumbnail entry={entry} read={pool.read} />
        <ArtifactPreview entry={entry} t={t} readVideoPoster={pool.read} />
      </>)
      await waitFor(() => { expect(decode).toHaveBeenCalledOnce() })
      act(() => { visible(true) })
      act(() => { visible(false) })
      expect(decoderSignal?.aborted).toBe(false)
      expect(container.querySelector('span[data-video-poster]')?.getAttribute('data-video-poster')).toBe('idle')
      await act(async () => { frame.resolve(cover); await frame.promise })
      const player = container.querySelector('video')!
      await waitFor(() => { expect(player.getAttribute('poster')).toBe(cover) })
      expect(player.controls).toBe(true)
      expect(player.autoplay).toBe(false)
      expect(player.preload).toBe('metadata')
      expect(container.querySelector('a[download]')).not.toBeNull()
      expect(decode).toHaveBeenCalledOnce()
      unmount()
      expect(player.hasAttribute('src')).toBe(false)
      expect(pause).toHaveBeenCalledOnce()
      expect(load).toHaveBeenCalledOnce()
    } finally { pool.dispose() }
  })

  it('drops an old poster immediately on replacement and leaves an unavailable replacement playable', async () => {
    const first = deferred<string | null>()
    const second = deferred<string | null>()
    const read = vi.fn<ReadVideoPoster>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { container, rerender } = render(<ArtifactPreview entry={entry} t={t} readVideoPoster={read} />)
    await act(async () => { first.resolve(cover); await first.promise })
    await waitFor(() => { expect(container.querySelector('video')?.getAttribute('poster')).toBe(cover) })
    rerender(<ArtifactPreview entry={{ ...entry, mtimeMs: 101 }} t={t} readVideoPoster={read} />)
    expect(container.querySelector('video')?.getAttribute('poster')).toBeNull()
    expect(read.mock.calls[0]?.[1].aborted).toBe(true)
    await act(async () => { second.resolve(null); await second.promise })
    await waitFor(() => { expect(container.querySelector('video')?.getAttribute('data-video-poster')).toBe('failed') })
    expect(container.querySelector('video')?.controls).toBe(true)
    expect(container.querySelector('a[download]')).not.toBeNull()
  })

  it('ends failed row loading with its video icon and leaves failed cover reads playable', async () => {
    const visible = viewport()
    const read = vi.fn<ReadVideoPoster>().mockResolvedValue(null)
    const { container } = render(<>
      <VideoThumbnail entry={entry} read={read} />
      <ArtifactPreview entry={entry} t={t} readVideoPoster={read} />
    </>)
    act(() => { visible(true) })
    await waitFor(() => {
      expect(container.querySelector('span[data-video-poster]')?.getAttribute('data-video-poster')).toBe('failed')
      expect(container.querySelector('video')?.getAttribute('data-video-poster')).toBe('failed')
    })
    expect(container.querySelector('span[data-video-poster] svg')).not.toBeNull()
    expect(container.querySelector('span[data-video-poster] img')).toBeNull()
    expect(container.querySelector('video')?.controls).toBe(true)
  })
})
