// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactEntry } from '../src/client/ArtifactsPage.tsx'
import { decodeVideoPoster, VideoPosterPool, videoSourceUrl, type ReadVideoPoster } from '../src/client/video-poster.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const entry: ArtifactEntry = { path: '/outputs/电影.mp4', name: '电影.mp4', kind: 'video', size: 1024, mtimeMs: 123 }
const poster = 'data:image/jpeg;base64,Zmlyc3QtZnJhbWU='
const file = (index: number): ArtifactEntry => ({ ...entry, path: `/outputs/${String(index)}.mp4` })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** Native media remains controlled at loadeddata rather than pretending a real codec exists in jsdom. */
function media() {
  const videos: HTMLVideoElement[] = []
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
    if (this instanceof HTMLVideoElement && this.hasAttribute('src')) videos.push(this)
  })
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  const draw = vi.fn()
  const context: Pick<CanvasRenderingContext2D, 'drawImage'> = { drawImage: draw }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(poster)
  return { videos, load, play, draw, encode }
}

describe('zero-time browser video frame decoding', () => {
  it('waits for current frame data, snapshots a bounded JPEG, and releases the source without playback', async () => {
    const device = media()
    const result = decodeVideoPoster({ ...entry, workspaceId: 'workspace-one' }, new AbortController().signal)
    const video = device.videos[0]!
    expect(video.muted && video.defaultMuted && video.playsInline).toBe(true)
    expect(video.currentTime).toBe(0)
    const source = new URL(video.src)
    expect(source.pathname).toBe('/artifacts/api/raw')
    expect(source.searchParams.get('workspaceId')).toBe('workspace-one')
    expect(source.searchParams.get('size')).toBe('1024')
    expect(source.searchParams.get('mtimeMs')).toBe('123')
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 1 }, videoWidth: { value: 1920 }, videoHeight: { value: 1080 },
    })
    video.dispatchEvent(new Event('loadeddata'))
    expect(device.draw).not.toHaveBeenCalled()
    Object.defineProperty(video, 'readyState', { value: 2 })
    video.dispatchEvent(new Event('loadeddata'))
    expect(await result).toBe(poster)
    expect(device.draw).toHaveBeenCalledExactlyOnceWith(video, 0, 0, 320, 180)
    expect(device.encode).toHaveBeenCalledExactlyOnceWith('image/jpeg', 0.8)
    expect(device.play).not.toHaveBeenCalled()
    expect(device.load).toHaveBeenCalledTimes(2)
    expect(video.hasAttribute('src')).toBe(false)
    video.dispatchEvent(new Event('loadeddata'))
    expect(device.draw).toHaveBeenCalledOnce()
  })

  it('releases an aborted decoder and ignores late frame events', async () => {
    const device = media()
    const controller = new AbortController()
    const pending = decodeVideoPoster(entry, controller.signal)
    const video = device.videos[0]!
    controller.abort()
    expect(await pending).toBeNull()
    expect(video.hasAttribute('src')).toBe(false)
    video.dispatchEvent(new Event('loadeddata'))
    expect(device.draw).not.toHaveBeenCalled()
    expect(device.play).not.toHaveBeenCalled()
  })

  it('contains unavailable canvas and codec errors without leaving a media source alive', async () => {
    const device = media()
    const pending = decodeVideoPoster(entry, new AbortController().signal)
    device.videos[0]!.dispatchEvent(new Event('error'))
    expect(await pending).toBeNull()
    expect(device.videos[0]!.hasAttribute('src')).toBe(false)
    expect(device.encode).not.toHaveBeenCalled()
  })
})

describe('page-owned video poster leases and limits', () => {
  it('decodes at most two identities concurrently and shares one job across row and detail leases', async () => {
    const work = Array.from({ length: 3 }, () => deferred<string | null>())
    const decode = vi.fn(async (selected: ArtifactEntry) => await work[Number(selected.path.match(/\d+/u)?.[0])]?.promise ?? null)
    const pool = new VideoPosterPool(15_000, decode)
    try {
      const row = new AbortController()
      const a = pool.read(file(0), row.signal)
      const detail = pool.read(file(0), new AbortController().signal)
      const b = pool.read(file(1), new AbortController().signal)
      const c = pool.read(file(2), new AbortController().signal)
      await vi.waitFor(() => { expect(decode).toHaveBeenCalledTimes(2) })
      row.abort()
      expect(await a).toBeNull()
      work[0]!.resolve(poster)
      expect(await detail).toBe(poster)
      await vi.waitFor(() => { expect(decode).toHaveBeenCalledTimes(3) })
      work[1]!.resolve(poster)
      work[2]!.resolve(poster)
      expect(await Promise.all([b, c])).toEqual([poster, poster])
      expect(await pool.read(file(0), new AbortController().signal)).toBe(poster)
      expect(decode).toHaveBeenCalledTimes(3)
    } finally { pool.dispose() }
  })

  it('keeps the shared decoder alive when one consumer cancels, then aborts after the last lease', async () => {
    let signal: AbortSignal | undefined
    const stopped = deferred<string | null>()
    const decode = vi.fn((_entry: ArtifactEntry, current: AbortSignal) => { signal = current; return stopped.promise })
    const pool = new VideoPosterPool(15_000, decode)
    const row = new AbortController()
    const detail = new AbortController()
    try {
      const first = pool.read(entry, row.signal)
      const second = pool.read(entry, detail.signal)
      await vi.waitFor(() => { expect(signal).toBeDefined() })
      row.abort()
      expect(await first).toBeNull()
      expect(signal?.aborted).toBe(false)
      detail.abort()
      expect(await second).toBeNull()
      expect(signal?.aborted).toBe(true)
      stopped.resolve(poster)
    } finally { pool.dispose() }
  })

  it('uses scope, size and mtime in cache identity and forgets removed files', async () => {
    const decode = vi.fn(async () => poster)
    const pool = new VideoPosterPool(15_000, decode)
    const read = async (value: ArtifactEntry) => await pool.read(value, new AbortController().signal)
    try {
      for (const value of [entry, { ...entry, workspaceId: 'a' }, { ...entry, workspaceId: 'b' },
        { ...entry, size: 1025 }, { ...entry, mtimeMs: 124 }]) expect(await read(value)).toBe(poster)
      expect(decode).toHaveBeenCalledTimes(5)
      expect(await read(entry)).toBe(poster)
      expect(decode).toHaveBeenCalledTimes(5)
      pool.retain([])
      expect(await read(entry)).toBe(poster)
      expect(decode).toHaveBeenCalledTimes(6)
      expect(videoSourceUrl({ ...entry, mtimeMs: 124 })).not.toBe(videoSourceUrl(entry))
    } finally { pool.dispose() }
  })

  it('bounds retained results at 64 and evicts the least recently read cover', async () => {
    const decode = vi.fn(async () => poster)
    const pool = new VideoPosterPool(15_000, decode)
    try {
      for (let index = 0; index < 65; index++) await pool.read(file(index), new AbortController().signal)
      expect(decode).toHaveBeenCalledTimes(65)
      await pool.read(file(64), new AbortController().signal)
      expect(decode).toHaveBeenCalledTimes(65)
      await pool.read(file(0), new AbortController().signal)
      expect(decode).toHaveBeenCalledTimes(66)
    } finally { pool.dispose() }
  })

  it('times out queued and active reads, releases the native source, and caches an ordinary unavailable result', async () => {
    vi.useFakeTimers()
    const device = media()
    const pool = new VideoPosterPool(15_000)
    try {
      const requests = [0, 1, 2].map(index => pool.read(file(index), new AbortController().signal))
      await vi.advanceTimersByTimeAsync(0)
      expect(device.videos).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await Promise.all(requests)).toEqual([null, null, null])
      expect(device.videos.every(video => !video.hasAttribute('src'))).toBe(true)
      expect(await pool.read(file(0), new AbortController().signal)).toBeNull()
      expect(device.videos).toHaveLength(2)
      expect(device.play).not.toHaveBeenCalled()
    } finally { pool.dispose() }
  })

  it('settles disposal and replacement before late decodes can publish stale covers', async () => {
    const old = deferred<string | null>()
    const next = deferred<string | null>()
    // Separate barriers deliberately ignore abort to prove stale completion cannot re-enter the cache.
    const decoder = vi.fn<ReadVideoPoster>().mockImplementationOnce(() => old.promise).mockImplementation(() => next.promise)
    const pool = new VideoPosterPool(15_000, decoder)
    const changed = { ...entry, mtimeMs: entry.mtimeMs + 1 }
    const first = pool.read(entry, new AbortController().signal)
    await vi.waitFor(() => { expect(decoder).toHaveBeenCalledOnce() })
    pool.retain([changed])
    expect(await first).toBeNull()
    const second = pool.read(changed, new AbortController().signal)
    await vi.waitFor(() => { expect(decoder).toHaveBeenCalledTimes(2) })
    old.resolve('data:image/jpeg;base64,b2xk')
    next.resolve(poster)
    expect(await second).toBe(poster)
    expect(await pool.read(changed, new AbortController().signal)).toBe(poster)
    const queued = pool.read(file(3), new AbortController().signal)
    pool.dispose()
    expect(await queued).toBeNull()
    expect(await pool.read(changed, new AbortController().signal)).toBeNull()
  })
})
