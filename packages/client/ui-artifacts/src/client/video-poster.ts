/** Page-owned first-frame decoding; no playback, uploads or persistent media cache. */
import type { ArtifactEntry } from './ArtifactsPage.tsx'

/** A local thumbnail read shared by rows and the selected player. */
export type ReadVideoPoster = (entry: ArtifactEntry, signal: AbortSignal) => Promise<string | null>
type Decoder = ReadVideoPoster

/**
 * Include file scope and version so replacements never inherit an old cover.
 * @param entry - Listed file identity and authorization scope.
 * @returns A stable cache key for this exact file version.
 */
export function videoPosterKey(entry: ArtifactEntry): string {
  return JSON.stringify([entry.workspaceId ?? null, entry.path, entry.size, entry.mtimeMs])
}

/**
 * Build the authenticated playback URL with this listed version's cache identity.
 * @param entry - Listed file identity and authorization scope.
 * @returns A same-origin raw-file URL scoped to the selected workspace and version.
 */
export function videoSourceUrl(entry: ArtifactEntry): string {
  const query = new URLSearchParams({ path: entry.path, size: String(entry.size), mtimeMs: String(entry.mtimeMs) })
  if (entry.workspaceId !== undefined) query.set('workspaceId', entry.workspaceId)
  return `/artifacts/api/raw?${query.toString()}`
}

/**
 * Capture the initial decoded frame without advancing or playing the source.
 * @param entry - Currently authorized file scope and version.
 * @param signal - Pool-owned deadline or last-consumer cancellation.
 * @returns A bounded JPEG data URL, or null for an unavailable decoder/frame.
 */
export function decodeVideoPoster(entry: ArtifactEntry, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const video = document.createElement('video')
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      video.removeEventListener('loadeddata', capture)
      video.removeEventListener('error', failed)
      signal.removeEventListener('abort', failed)
      video.removeAttribute('src')
      video.load()
      resolve(value)
    }
    const failed = (): void => { finish(null) }
    const capture = (): void => {
      if (signal.aborted) { finish(null); return }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) return
      // No seek or playback occurs: loadeddata supplies the frame at the initial time zero.
      if (video.currentTime !== 0) { finish(null); return }
      try {
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight))
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
        const context = canvas.getContext('2d')
        if (context === null) { finish(null); return }
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const url = canvas.toDataURL('image/jpeg', 0.8)
        // Bound the entire retained value even if a browser fails to honor JPEG encoding.
        finish(url.startsWith('data:image/jpeg;') && url.length <= 256 * 1024 ? url : null)
      } catch { finish(null) }
    }
    video.preload = 'auto'
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    video.addEventListener('loadeddata', capture)
    video.addEventListener('error', failed)
    signal.addEventListener('abort', failed, { once: true })
    video.src = videoSourceUrl(entry)
    video.load()
  })
}

interface Consumer {
  finish(value: string | null): void
}
interface Job {
  readonly key: string
  readonly controller: AbortController
  readonly consumers: Set<Consumer>
  readonly timer: ReturnType<typeof setTimeout>
  readonly deadline: number
  readonly entry: ArtifactEntry
  started: boolean
}

/**
 * One mounted page owns at most two decoders, 64 pending identities and 64 cached results.
 * Each consumer has its own abort lease; cancelling a row cannot interrupt its detail player.
 * Failures are cached for the current file version and remain ordinary video icons.
 */
export class VideoPosterPool {
  private readonly jobs = new Map<string, Job>()
  private readonly cache = new Map<string, string | null>()
  private active = 0
  private disposed = false

  constructor(private readonly timeoutMs: number, private readonly decode: Decoder = decodeVideoPoster) {}

  /** Join one version's existing work; the deadline includes time waiting for a decoder. */
  readonly read: ReadVideoPoster = (entry, signal) => {
    if (this.disposed || signal.aborted || entry.kind !== 'video') return Promise.resolve(null)
    const key = videoPosterKey(entry)
    if (this.cache.has(key)) {
      const value = this.cache.get(key) ?? null
      this.cache.delete(key)
      this.cache.set(key, value)
      return Promise.resolve(value)
    }
    let job = this.jobs.get(key)
    if (job === undefined) {
      if (this.jobs.size >= 64) return Promise.resolve(null)
      job = { key, entry, controller: new AbortController(), consumers: new Set(), started: false, deadline: Date.now() + this.timeoutMs,
        timer: setTimeout(() => {
          if (job !== undefined) this.complete(job, null)
        }, this.timeoutMs) }
      this.jobs.set(key, job)
    }
    const current = job
    return new Promise((resolve) => {
      const consumer: Consumer = { finish: (value) => {
        signal.removeEventListener('abort', cancel)
        current.consumers.delete(consumer)
        resolve(value)
      } }
      const cancel = (): void => {
        consumer.finish(null)
        if (current.consumers.size === 0) this.cancel(current)
      }
      current.consumers.add(consumer)
      signal.addEventListener('abort', cancel, { once: true })
      this.pump()
    })
  }

  /**
   * Drop deleted, unauthorized or replaced versions after an authoritative listing changes.
   * @param entries - Files still present and authorized in the current page listing.
   */
  retain(entries: readonly ArtifactEntry[]): void {
    const allowed = new Set(entries.filter(entry => entry.kind === 'video').map(videoPosterKey))
    for (const key of this.cache.keys()) if (!allowed.has(key)) this.cache.delete(key)
    for (const job of this.jobs.values()) if (!allowed.has(job.key)) this.cancel(job)
  }

  /** Stop every decoder and settle every lease before the page leaves. */
  dispose(): void {
    this.disposed = true
    for (const job of this.jobs.values()) this.cancel(job)
    this.cache.clear()
  }

  private cancel(job: Job): void {
    if (this.jobs.get(job.key) !== job) return
    this.jobs.delete(job.key)
    clearTimeout(job.timer)
    job.controller.abort()
    for (const consumer of job.consumers) consumer.finish(null)
    this.pump()
  }

  private complete(job: Job, value: string | null): void {
    if (this.jobs.get(job.key) !== job) return
    this.cache.set(job.key, value)
    while (this.cache.size > 64) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    this.jobs.delete(job.key)
    clearTimeout(job.timer)
    job.controller.abort()
    for (const consumer of job.consumers) consumer.finish(value)
    this.pump()
  }

  private pump(): void {
    if (this.disposed) return
    for (const job of this.jobs.values()) {
      if (Date.now() >= job.deadline) { this.complete(job, null); continue }
      if (this.active >= 2) break
      if (job.started) continue
      job.started = true
      this.active++
      void Promise.resolve().then(() => this.decode(job.entry, job.controller.signal))
        .then((value) => { this.complete(job, value) }, () => { this.complete(job, null) })
        .finally(() => { this.active--; this.pump() })
    }
  }
}
