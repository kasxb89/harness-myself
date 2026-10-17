/**
 * Host half of the sidebar Artifacts panel.
 *
 * Lists and previews canonical root-contained files. Optional local storage
 * preferences and reversible file management require the authenticated Host
 * connection. The shared Host service captures output before billing and
 * publishes exclusive files; old output roots remain browsable after changes.
 *
 * @module @deepseek-ai/dsh-artifacts-index
 */

import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import type { ArtifactStorageService } from './types.ts'
import { ArtifactError, ArtifactStore, authorizedFile, qualified } from './storage.ts'

export type { ArtifactDestination, ArtifactWriteResult, ArtifactWriteRequest, ArtifactPublishRequest, ArtifactStorageService, ArtifactStorageInfo } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional trusted Host artifact output capability. */
    artifactStorage: ArtifactStorageService
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'artifacts-index'

/** The route carrier this plugin registers into. */
export const inject = ['webServer']

/** Plugin config: which directories the panel browses and how far it walks. */
export interface Config {
  /** Default generated output directory, created on first initialization when configured. */
  defaultOutputDirectory?: string
  /** Private preferences and recovery records; never a browsing root. */
  stateDirectory?: string
  /** Absolute directories shown in the panel. An empty list serves nothing. */
  roots?: string[]
  /** Maximum files returned by one listing. */
  maxEntries?: number
  /** Maximum directory depth walked below each root. */
  maxDepth?: number
}

export const Config: z<Config> = z.object({
  defaultOutputDirectory: z.string().default(''),
  stateDirectory: z.string().default(''),
  roots: z.array(z.string()).default([]),
  maxEntries: z.number().step(1).min(1).default(2000),
  maxDepth: z.number().step(1).min(1).default(5),
})

/** Resolved configuration: schemastery already filled every defaulted field. */
type ResolvedConfig = Required<Config>

/** The single prefix this plugin owns. */
const ROUTE_PREFIX = '/artifacts'

/** Artifact kinds the panel filters by. */
export type ArtifactKind =
  | 'image' | 'video' | 'audio' | 'document' | 'sheet' | 'slides' | 'archive' | 'code' | 'text' | 'other'

/** Extension groups, in the order the panel lists them. */
const EXTENSION_GROUPS: readonly (readonly [ArtifactKind, readonly string[]])[] = [
  ['image', ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.heic', '.tiff']],
  ['video', ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']],
  ['audio', ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a']],
  ['document', ['.pdf', '.doc', '.docx', '.rtf', '.txt', '.md', '.odt', '.pages']],
  ['sheet', ['.xls', '.xlsx', '.csv', '.tsv', '.ods', '.numbers']],
  ['slides', ['.ppt', '.pptx', '.key', '.odp']],
  ['archive', ['.zip', '.tar', '.gz', '.7z', '.rar']],
  ['code', [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
    '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.zsh', '.sql', '.lua', '.vue', '.svelte',
  ]],
  ['text', ['.json', '.yaml', '.yml', '.toml', '.ini', '.xml', '.html', '.htm', '.css', '.scss']],
]

/** Extension-to-kind map; anything unmatched is `other`. */
const KIND_BY_EXTENSION: ReadonlyMap<string, ArtifactKind> = new Map(
  EXTENSION_GROUPS.flatMap(([kind, extensions]) => extensions.map(extension => [extension, kind] as const)),
)

/** One entry of a listing, as the panel consumes it. */
export interface ArtifactEntry {
  readonly path: string
  readonly name: string
  readonly kind: ArtifactKind
  readonly size: number
  readonly mtimeMs: number
}

/** Media type per extension used when streaming a preview back. */
const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
}

/** Derive the panel kind from a file name. */
function kindOf(filename: string): ArtifactKind {
  return KIND_BY_EXTENSION.get(extname(filename).toLowerCase()) ?? 'other'
}

/** Resolve the roots once, dropping relative or duplicated entries. */
function resolveRoots(config: ResolvedConfig): readonly string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  for (const root of config.roots) {
    if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) continue
    const normalized = normalize(root)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    roots.push(normalized)
  }
  return roots
}

/**
 * Refuse cross-site callers. The listener is loopback-only, so the remaining
 * exposure is another local process or a page in an unrelated tab; both name
 * themselves in `Origin`.
 */
function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined || origin === 'null') return true
  if (origin === 'dsh-app://app') return true
  try {
    const { hostname, protocol } = new URL(origin)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/** Write one JSON response. */
function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** Walk one root and collect the files it holds, breadth-first and bounded. */
async function collect(root: string, limit: number, maxDepth: number, seen: Set<string>, pinned: boolean): Promise<ArtifactEntry[]> {
  const entries: ArtifactEntry[] = []
  const canonical = await realpath(root).catch(() => undefined)
  if (canonical === undefined || pinned && canonical !== root) return entries
  const queue: { dir: string; depth: number }[] = [{ dir: canonical, depth: 0 }]
  while (queue.length > 0 && entries.length < limit) {
    const current = queue.shift()
    if (current === undefined) break
    let children: string[]
    try {
      children = await readdir(current.dir)
    } catch {
      continue
    }
    for (const child of children) {
      if (entries.length >= limit) break
      if (child.startsWith('.')) continue
      const full = join(current.dir, child)
      let info
      try {
        info = await lstat(full)
        if (info.isSymbolicLink() || await realpath(full) !== full) continue
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (current.depth < maxDepth) queue.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!info.isFile()) continue
      if (seen.has(full)) continue
      seen.add(full)
      entries.push({
        path: join(root, relative(canonical, full)), name: basename(full), kind: kindOf(child), size: info.size, mtimeMs: info.mtimeMs,
      })
    }
  }
  return entries
}

/** Serve one preview read, honouring a single byte range for media seeking. */
async function serveFile(
  response: ServerResponse, request: IncomingMessage, target: string, roots: readonly string[], signal: AbortSignal, pinned: boolean,
): Promise<void> {
  let info
  try {
    info = (await authorizedFile(target, pinned ? roots : await Promise.all(roots.map(root => realpath(root))))).info
  } catch {
    json(response, 404, { error: 'not found' })
    return
  }
  if (!info.isFile()) {
    json(response, 404, { error: 'not a file' })
    return
  }
  const mediaType = MEDIA_TYPE_BY_EXTENSION[extname(target).toLowerCase()] ?? 'application/octet-stream'
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.mtimeMs !== info.mtimeMs) {
      throw new ArtifactError('ARTIFACT_STALE', 409, 'File changed during preview')
    }
    response.setHeader('x-content-type-options', 'nosniff')
    if (mediaType === 'image/svg+xml' || mediaType.startsWith('text/html')) {
      response.setHeader('content-security-policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
    }
    const stream = (range?: { start: number; end: number }): Promise<void> => {
      if (request.method === 'HEAD') { response.end(); return Promise.resolve() }
      const input = handle.createReadStream(range)
      return new Promise<void>((resolveStream) => {
        const stop = (): void => { input.destroy() }
        response.once('close', stop)
        signal.addEventListener('abort', stop, { once: true })
        input.once('close', () => {
          response.off('close', stop)
          signal.removeEventListener('abort', stop)
          resolveStream()
        })
        input.on('error', () => { response.destroy() })
        if (signal.aborted) stop()
        else input.pipe(response)
      })
    }
    const range = request.headers.range
    const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
    if (match !== null) {
      const start = match[1] === '' ? Math.max(0, info.size - Number(match[2])) : Number(match[1])
      const end = match[2] === '' || match[1] === '' ? info.size - 1 : Math.min(Number(match[2]), info.size - 1)
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= info.size) {
        response.writeHead(416, { 'content-range': `bytes */${String(info.size)}` })
        response.end()
        return
      }
      response.writeHead(206, {
        'content-type': mediaType,
        'content-length': end - start + 1,
        'content-range': `bytes ${String(start)}-${String(end)}/${String(info.size)}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      })
      await stream({ start, end })
      return
    }
    response.writeHead(200, {
      'content-type': mediaType,
      'content-length': info.size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    })
    await stream()
  } finally { await handle.close().catch(() => {}) }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  const configuredRoots = resolveRoots(resolved)
  const store = resolved.defaultOutputDirectory === '' || resolved.stateDirectory === '' ? undefined
    : await ArtifactStore.create(ctx, resolved.defaultOutputDirectory, resolved.stateDirectory, configuredRoots)
  const lifetime = new AbortController()
  const requests = new Set<Promise<void>>()
  const rootsNow = async (): Promise<readonly string[]> => {
    const paths = store?.info().roots ?? configuredRoots
    const roots: string[] = []
    for (const path of paths) {
      if (!qualified(path)) continue
      const canonical = await realpath(path).catch(() => undefined)
      if (canonical === undefined || store !== undefined && canonical !== path) continue
      if ((await lstat(canonical).catch(() => undefined))?.isDirectory() === true) roots.push(store === undefined ? path : canonical)
    }
    return [...new Set(roots)]
  }
  /** Parse bounded JSON only after authentication; query strings never authorize mutations. */
  const body = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'JSON body required')
    const chunks: Buffer[] = []
    let size = 0
    const stop = (): void => { request.destroy() }
    lifetime.signal.throwIfAborted()
    lifetime.signal.addEventListener('abort', stop, { once: true })
    try {
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'Invalid request bytes')
        size += Buffer.byteLength(chunk)
        if (size > 16_384) throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 413, 'Request too large')
        chunks.push(Buffer.from(chunk))
      }
    } finally { lifetime.signal.removeEventListener('abort', stop) }
    let value: unknown
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'Invalid JSON') }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'JSON object required')
    return value as Record<string, unknown>
  }
  const item = async (path: string): Promise<ArtifactEntry> => {
    const info = await stat(path).catch(() => {
      throw new ArtifactError('ARTIFACT_OPERATION_UNKNOWN', 409, 'Refresh to inspect the completed file operation')
    })
    return { path, name: basename(path), kind: kindOf(path), size: info.size, mtimeMs: info.mtimeMs }
  }
  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (request, response) => {
        const operation = (async () => {
          try {
            if (!originAllowed(request)) {
              json(response, 403, { code: 'ARTIFACT_AUTH_REQUIRED' })
              return
            }
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            const route = url.pathname.slice(ROUTE_PREFIX.length)
            const connection = ctx.get('connection')
            if (route.startsWith('/api/') && (connection !== undefined || store !== undefined)) {
              const rejection = connection === undefined ? 403 : connection.requestRejection(request)
              if (rejection !== undefined) { json(response, rejection, { code: 'ARTIFACT_AUTH_REQUIRED' }); return }
            }
            if (['/api/storage', '/api/rename', '/api/trash', '/api/restore'].includes(route)) {
              if (connection === undefined) { json(response, 403, { code: 'ARTIFACT_AUTH_REQUIRED' }); return }
              if (store === undefined) throw new ArtifactError('ARTIFACT_STORAGE_UNAVAILABLE', 503, 'Artifact storage is not configured')
              if (route === '/api/storage' && request.method === 'GET') { json(response, 200, store.info()); return }
              if (route === '/api/trash' && request.method === 'GET') { json(response, 200, { items: await store.trashed() }); return }
              if (request.method !== 'POST') throw new ArtifactError('ARTIFACT_METHOD_INVALID', 405, 'POST required')
              const value = await body(request)
              if (route === '/api/storage') {
                if (typeof value.directory !== 'string' || typeof value.expectedRevision !== 'number') throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'Directory and revision required')
                json(response, 200, await store.setDirectory(value.directory, value.expectedRevision, lifetime.signal)); return
              }
              if (route === '/api/restore') {
                if (typeof value.id !== 'string') throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'Recovery id required')
                json(response, 200, { item: await item(await store.restore(value.id)) }); return
              }
              const expected = value.expected
              if (typeof value.path !== 'string' || expected === null || typeof expected !== 'object' || Array.isArray(expected)
          || !('size' in expected) || typeof expected.size !== 'number' || !('mtimeMs' in expected) || typeof expected.mtimeMs !== 'number') {
                throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'Path and selected file version required')
              }
              const selectedVersion = { size: expected.size, mtimeMs: expected.mtimeMs }
              if (route === '/api/rename') {
                if (typeof value.name !== 'string') throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'File name required')
                json(response, 200, { item: await item(await store.rename(value.path, value.name, selectedVersion)) }); return
              }
              json(response, 200, { trashId: await store.trash(value.path, selectedVersion) }); return
            }
            if (request.method !== 'GET' && request.method !== 'HEAD') {
              json(response, 405, { error: 'method not allowed' })
              return
            }
            if (route === '/api/list') {
              const roots = await rootsNow()
              const items: ArtifactEntry[] = []
              const seen = new Set<string>()
              for (const root of roots) {
                if (items.length > resolved.maxEntries) break
                items.push(...await collect(root, resolved.maxEntries + 1 - items.length, resolved.maxDepth, seen, store !== undefined))
              }
              items.sort((left, right) => right.mtimeMs - left.mtimeMs)
              json(response, 200, {
                roots, items: items.slice(0, resolved.maxEntries), truncated: items.length > resolved.maxEntries,
                ...store === undefined ? {} : { storage: store.info() },
              })
              return
            }
            if (route === '/api/raw') {
              const target = url.searchParams.get('path')
              const roots = await rootsNow()
              if (target === null || !qualified(target)) {
                json(response, 403, { error: 'path outside the configured roots' })
                return
              }
              await serveFile(response, request, resolve(target), roots, lifetime.signal, store !== undefined)
              return
            }
            json(response, 404, { error: 'not found' })
          } catch (error) {
            if (response.headersSent) { response.destroy(); return }
            const permission = error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
            json(response, error instanceof ArtifactError ? error.status : permission ? 403 : 500, {
              code: error instanceof ArtifactError ? error.code : permission ? 'ARTIFACT_PERMISSION_DENIED' : 'ARTIFACT_OPERATION_FAILED',
            })
          }
        })()
        requests.add(operation)
        try { await operation } finally { requests.delete(operation) }
      },
    })
    return async () => {
      unregister()
      lifetime.abort()
      await Promise.allSettled([...requests])
    }
  }, 'artifacts-index: routes')
}
