/**
 * Host half of the sidebar Artifacts panel.
 *
 * Lists and previews retained output and currently registered local Workspace files. Optional local storage
 * preferences and reversible file management require the authenticated Host
 * connection. The shared Host service captures output before billing and
 * publishes exclusive files; old output roots remain browsable after changes.
 *
 * @module @deepseek-ai/dsh-artifacts-index
 */

import { constants } from 'node:fs'
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-tools/types'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import type { ArtifactStorageService, ArtifactVideoRole } from './types.ts'
import { ArtifactError, ArtifactStore, authorizedFile, contained, qualified } from './storage.ts'
import { listDirectory, WorkspaceAccess } from './workspace.ts'
import { serveOfficePreview, type AuthorizePreview } from './preview.ts'

export type { ArtifactDestination, ArtifactOrigin, ArtifactWriteResult, ArtifactWriteRequest, ArtifactPublishRequest, ArtifactStorageService, ArtifactStorageInfo, ArtifactVideoRole } from './types.ts'

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
  /** Private preferences, origin associations and recovery records; never a browsing root. */
  stateDirectory?: string
  /** Retained output directories shown alongside currently registered local Workspaces. */
  roots?: string[]
  /** Maximum returned files; also bounds files and directories scanned per root. */
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
  readonly videoRole?: ArtifactVideoRole
  /** Present for a file addressed through a currently registered local Workspace. */
  readonly workspaceId?: string
}

/** Media type per extension used when streaming a preview back. */
const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  ...Object.fromEntries(['.yaml', '.yml', '.toml', '.ini', '.xml', '.css', '.scss', '.log', '.srt', '.vtt',
    ...EXTENSION_GROUPS.flatMap(([kind, extensions]) => kind === 'code' ? extensions : [])]
    .map(extension => [extension, 'text/plain; charset=utf-8'])),
}

/** An ASCII fallback plus an encoded Unicode filename, with no header control bytes. */
function downloadDisposition(path: string): string {
  const name = basename(path)
  const fallback = name.replace(/[^A-Za-z0-9._-]/gu, '_') || 'download'
  const encoded = encodeURIComponent(name).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
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

/** Stable public failure codes omit filesystem paths and exception text. */
function issueCode(error: unknown): string {
  if (error instanceof ArtifactError && ['ARTIFACT_WORKSPACE_UNAVAILABLE', 'ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED'].includes(error.code)) return error.code
  if (error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')) return 'ARTIFACT_PERMISSION_DENIED'
  return 'ARTIFACT_OPERATION_FAILED'
}

/** Walk one root without following links; duplicates do not consume the file budget. */
async function collect(
  root: string, limit: number, maxDepth: number, seen: Set<string>, pinned: boolean,
  signal: AbortSignal, visible?: (path: string) => void,
): Promise<{ items: ArtifactEntry[]; truncated: boolean; issue?: string }> {
  const entries: ArtifactEntry[] = []
  let truncated = false
  let issue: string | undefined
  const record = (error: unknown): void => { issue ??= issueCode(error) }
  const canonical = await realpath(root).catch((error: unknown) => { record(error); return undefined })
  if (canonical === undefined || pinned && canonical !== root) {
    return { items: entries, truncated, issue: issue ?? 'ARTIFACT_WORKSPACE_UNAVAILABLE' }
  }
  const queue: { dir: string; depth: number }[] = [{ dir: canonical, depth: 0 }]
  let directoryCount = 1
  let cursor = 0
  traversal: while (cursor < queue.length) {
    signal.throwIfAborted()
    const current = queue[cursor++]
    if (current === undefined) break
    let directory
    try {
      directory = await opendir(current.dir)
    } catch (error) {
      record(error)
      continue
    }
    try {
      for await (const child of directory) {
        signal.throwIfAborted()
        if (child.name.startsWith('.')) continue
        const full = join(current.dir, child.name)
        if (visible !== undefined) {
          try { visible(full) } catch (error) {
            if (error instanceof ArtifactError && error.code === 'ARTIFACT_PATH_FORBIDDEN') continue
            throw error
          }
        }
        let info
        try {
          info = await lstat(full)
          if (info.isSymbolicLink() || await realpath(full) !== full) continue
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) record(error)
          continue
        }
        if (info.isDirectory()) {
          if (current.depth >= maxDepth || directoryCount >= limit) { truncated = true; continue }
          queue.push({ dir: full, depth: current.depth + 1 })
          directoryCount++
          continue
        }
        if (!info.isFile() || seen.has(full)) continue
        if (entries.length >= limit) { truncated = true; break traversal }
        seen.add(full)
        entries.push({
          path: join(root, relative(canonical, full)), name: basename(full), kind: kindOf(child.name),
          size: info.size, mtimeMs: info.mtimeMs,
        })
      }
    } catch (error) {
      signal.throwIfAborted()
      record(error)
    }
  }
  signal.throwIfAborted()
  return { items: entries, truncated, ...issue === undefined ? {} : { issue } }
}

/** Serve one preview read, honouring a single byte range for media seeking. */
async function serveFile(
  response: ServerResponse, request: IncomingMessage, target: string, roots: readonly string[],
  signal: AbortSignal, pinned: boolean, download: boolean,
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
    if (download) response.setHeader('content-disposition', downloadDisposition(target))
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
  let privateState: string | undefined
  const workspaces = new WorkspaceAccess(ctx, () => privateState)
  const store = resolved.defaultOutputDirectory === '' || resolved.stateDirectory === '' ? undefined
    : await ArtifactStore.create(ctx, resolved.defaultOutputDirectory, resolved.stateDirectory, configuredRoots, workspaces)
  if (store !== undefined) privateState = await realpath(resolved.stateDirectory)
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
  const presentedRoots = new WeakMap<Session, Map<ToolCallId, ToolCallId>>()
  ctx.on('session/event', (session, event) => {
    if (store === undefined || lifetime.signal.aborted) return
    if (event.type === 'turn/start') { presentedRoots.delete(session); return }
    if (event.type === 'tool/ptc-dispatch-start') {
      let roots = presentedRoots.get(session)
      if (roots === undefined) { roots = new Map(); presentedRoots.set(session, roots) }
      roots.set(event.data.subCallId, event.data.rootCallId)
      return
    }
    if (event.type !== 'deliverables/presented') return
    const cwd = ctx.get('workingDirectory')?.get(session) ?? session.header.cwd
    const toolCallId = presentedRoots.get(session)?.get(event.data.callId) ?? event.data.callId
    const operation = (async () => {
      for (const file of event.data.files) {
        try {
          const path = qualified(file.path) ? resolve(file.path)
            : cwd !== undefined && qualified(cwd) ? resolve(cwd, file.path) : undefined
          if (path === undefined) throw new ArtifactError('ARTIFACT_PATH_INVALID', 400, 'The presenting Session has no local directory')
          const fs = ctx.get('fs')
          const mapped = fs?.processPathFromHostPath(path)
          if (fs === undefined || mapped === undefined || fs.processPath(await fs.resolve(mapped, { signal: lifetime.signal })) !== path) {
            throw new ArtifactError('ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED', 409, 'Presented files must map to this Host filesystem')
          }
          const origin = { sessionId: session.id, turn: event.data.turn, eventSeq: event.seq, toolCallId }
          if ((await rootsNow()).some(root => contained(root, path))) {
            await store.rememberOrigin(path, origin, lifetime.signal)
            continue
          }
          let recorded = false
          for (const identity of workspaces.registered()) {
            const workspace = await workspaces.resolve(identity.id, lifetime.signal).catch((error: unknown) => {
              if (error instanceof ArtifactError && (error.code === 'ARTIFACT_WORKSPACE_UNAVAILABLE'
                || error.code === 'ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED')) return undefined
              throw error
            })
            if (workspace === undefined) continue
            if (!contained(workspace.path, path)) continue
            await store.rememberOrigin(path, origin, lifetime.signal, { workspaceId: workspace.id, signal: lifetime.signal })
            recorded = true
            break
          }
          if (!recorded) throw new ArtifactError('ARTIFACT_PATH_FORBIDDEN', 403, 'Presented file is outside authorized roots')
        } catch (error) {
          ctx.logger.warn('A presented file remains available, but its source chat could not be recorded. Open the original chat to continue. (%s)', issueCode(error))
        }
      }
    })()
    requests.add(operation)
    void operation.finally(() => { requests.delete(operation) }).catch((error: unknown) => {
      ctx.logger.warn('Presented file source recording stopped; files remain available. (%s)', issueCode(error))
    })
  })
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
  const describeVideo = async (entry: ArtifactEntry, signal: AbortSignal): Promise<ArtifactEntry> => {
    if (entry.kind !== 'video' || store === undefined) return entry
    signal.throwIfAborted()
    let videoRole: ArtifactVideoRole | undefined
    try {
      videoRole = await store.videoRole(entry.path, entry,
        entry.workspaceId === undefined ? undefined : { workspaceId: entry.workspaceId, signal })
    } catch (_unavailable: unknown) { /* A changed or unavailable association never classifies a file by its name. */ }
    signal.throwIfAborted()
    return videoRole === undefined ? entry : { ...entry, videoRole }
  }
  const describeVideos = async (entries: readonly ArtifactEntry[], signal: AbortSignal): Promise<ArtifactEntry[]> => {
    const described: ArtifactEntry[] = []
    for (const entry of entries) described.push(await describeVideo(entry, signal))
    return described
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
        const disconnected = new AbortController()
        const stop = (): void => { disconnected.abort() }
        request.once('aborted', stop)
        response.once('close', stop)
        const signal = AbortSignal.any([lifetime.signal, disconnected.signal])
        const operation = (async () => {
          try {
            if (!originAllowed(request)) {
              json(response, 403, { code: 'ARTIFACT_AUTH_REQUIRED' })
              return
            }
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            const route = url.pathname.slice(ROUTE_PREFIX.length)
            const connection = ctx.get('connection')
            const registeredWorkspaces = route === '/api/list' ? workspaces.registered() : []
            if (route.startsWith('/api/') && (connection !== undefined || store !== undefined
              || registeredWorkspaces.length > 0
              || route === '/api/preview' || route === '/api/workspace' || route === '/api/directory'
              || route === '/api/raw' && url.searchParams.has('workspaceId'))) {
              const rejection = connection === undefined ? 403 : connection.requestRejection(request)
              if (rejection !== undefined) { json(response, rejection, { code: 'ARTIFACT_AUTH_REQUIRED' }); return }
            }
            if (['/api/storage', '/api/rename', '/api/trash', '/api/restore', '/api/origin'].includes(route)) {
              if (connection === undefined) { json(response, 403, { code: 'ARTIFACT_AUTH_REQUIRED' }); return }
              if (route === '/api/origin' && request.method === 'GET') {
                if (store === undefined) { json(response, 200, { origin: null }); return }
                const path = url.searchParams.get('path')
                const size = url.searchParams.get('size')
                const mtimeMs = url.searchParams.get('mtimeMs')
                if (path === null || size === null || mtimeMs === null
                  || !Number.isSafeInteger(Number(size)) || !Number.isFinite(Number(mtimeMs))) {
                  throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'Path and selected file version required')
                }
                const workspaceId = url.searchParams.get('workspaceId')
                json(response, 200, { origin: await store.origin(path, { size: Number(size), mtimeMs: Number(mtimeMs) },
                  workspaceId === null ? undefined : { workspaceId, signal }) })
                return
              }
              if (store === undefined) throw new ArtifactError('ARTIFACT_STORAGE_UNAVAILABLE', 503, 'Artifact storage is not configured')
              if (route === '/api/storage' && request.method === 'GET') { json(response, 200, store.info()); return }
              if (route === '/api/trash' && request.method === 'GET') { json(response, 200, { items: await store.trashed(signal) }); return }
              if (request.method !== 'POST') throw new ArtifactError('ARTIFACT_METHOD_INVALID', 405, 'POST required')
              const value = await body(request)
              if (route === '/api/storage') {
                if (typeof value.directory !== 'string' || typeof value.expectedRevision !== 'number') throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'Directory and revision required')
                json(response, 200, await store.setDirectory(value.directory, value.expectedRevision, lifetime.signal)); return
              }
              if (route === '/api/restore') {
                if (typeof value.id !== 'string') throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'Recovery id required')
                const restored = await store.restore(value.id, signal)
                json(response, 200, { item: await describeVideo({
                  ...await item(restored.path), ...restored.workspaceId === undefined ? {} : { workspaceId: restored.workspaceId },
                }, signal) }); return
              }
              const expected = value.expected
              if (typeof value.path !== 'string' || expected === null || typeof expected !== 'object' || Array.isArray(expected)
          || !('size' in expected) || typeof expected.size !== 'number' || !('mtimeMs' in expected) || typeof expected.mtimeMs !== 'number') {
                throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'Path and selected file version required')
              }
              const selectedVersion = { size: expected.size, mtimeMs: expected.mtimeMs }
              if (value.workspaceId !== undefined && typeof value.workspaceId !== 'string') {
                throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'Workspace identity must be a string')
              }
              const scope = typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId, signal } : undefined
              if (route === '/api/rename') {
                if (typeof value.name !== 'string') throw new ArtifactError('ARTIFACT_REQUEST_INVALID', 400, 'File name required')
                json(response, 200, { item: await describeVideo({
                  ...await item(await store.rename(value.path, value.name, selectedVersion, scope)),
                  ...scope === undefined ? {} : { workspaceId: scope.workspaceId },
                }, signal) }); return
              }
              json(response, 200, { trashId: await store.trash(value.path, selectedVersion, scope) }); return
            }
            if (request.method !== 'GET' && request.method !== 'HEAD') {
              json(response, 405, { error: 'method not allowed' })
              return
            }
            const directoryOffset = (): number => {
              const raw = url.searchParams.get('offset') ?? '0'
              const offset = Number(raw)
              if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(offset) || offset < 0) {
                throw new ArtifactError('ARTIFACT_DIRECTORY_INVALID', 400, 'Directory offset must be a nonnegative integer')
              }
              return offset
            }
            if (route === '/api/workspace') {
              const workspaceId = url.searchParams.get('workspaceId')
              if (workspaceId === null) throw new ArtifactError('ARTIFACT_WORKSPACE_UNAVAILABLE', 404, 'Select a registered Workspace')
              const page = await workspaces.list(workspaceId, url.searchParams.get('directory') ?? '', resolved.maxEntries, signal, directoryOffset())
              json(response, 200, {
                ...page, items: await describeVideos(page.items.map(entry => ({
                  ...entry, kind: kindOf(entry.name), workspaceId: page.workspace.id,
                })), signal),
              })
              return
            }
            if (route === '/api/directory') {
              const root = url.searchParams.get('root')
              const authorize = async (): Promise<string> => {
                signal.throwIfAborted()
                if (root === null || !qualified(root) || !(await rootsNow()).includes(root)
                  || await realpath(root).catch(() => undefined) !== root) {
                  throw new ArtifactError('ARTIFACT_PATH_FORBIDDEN', 403, 'Select a currently available retained output root')
                }
                return root
              }
              const pinnedRoot = await authorize()
              const page = await listDirectory(pinnedRoot, url.searchParams.get('directory') ?? '', resolved.maxEntries, signal,
                (path) => { workspaces.visible({ path: pinnedRoot }, path) }, directoryOffset())
              await authorize()
              json(response, 200, { ...page, root: pinnedRoot,
                items: await describeVideos(page.items.map(entry => ({ ...entry, kind: kindOf(entry.name) })), signal) })
              return
            }
            if (route === '/api/list') {
              const roots = await rootsNow()
              const items: ArtifactEntry[] = []
              const seen = new Set<string>()
              const issues: { workspaceId: string; title: string; code: string }[] = []
              let truncated = roots.length < (store?.info().roots ?? configuredRoots).length
              for (const root of roots) {
                const page = await collect(root, resolved.maxEntries + 1, resolved.maxDepth, seen, store !== undefined, signal)
                items.push(...page.items)
                truncated ||= page.truncated || page.issue !== undefined
              }
              for (const identity of registeredWorkspaces) {
                try {
                  const workspace = await workspaces.resolve(identity.id, signal)
                  const scopedSeen = new Set(seen)
                  const page = await collect(workspace.path, resolved.maxEntries + 1, resolved.maxDepth, scopedSeen, true,
                    signal, (path) => { workspaces.visible(workspace, path) })
                  const current = await workspaces.resolve(identity.id, signal)
                  if (current.path !== workspace.path) throw new ArtifactError('ARTIFACT_WORKSPACE_UNAVAILABLE', 404, 'Workspace directory changed')
                  for (const entry of page.items) {
                    seen.add(entry.path)
                    items.push({ ...entry, workspaceId: workspace.id })
                  }
                  truncated ||= page.truncated
                  if (page.issue !== undefined) issues.push({ workspaceId: identity.id, title: identity.title, code: page.issue })
                } catch (error) {
                  signal.throwIfAborted()
                  issues.push({ workspaceId: identity.id, title: identity.title, code: issueCode(error) })
                }
              }
              items.sort((left, right) => right.mtimeMs - left.mtimeMs)
              json(response, 200, {
                roots, items: await describeVideos(items.slice(0, resolved.maxEntries), signal),
                truncated: truncated || items.length > resolved.maxEntries,
                ...issues.length === 0 ? {} : { issues },
                ...store === undefined ? {} : { storage: store.info() },
              })
              return
            }
            if (route === '/api/raw' || route === '/api/preview') {
              const target = url.searchParams.get('path')
              if (target === null || !qualified(target)) {
                json(response, 403, { error: 'path outside the configured roots' })
                return
              }
              const workspaceId = url.searchParams.get('workspaceId')
              if (route === '/api/preview') {
                const authorize: AuthorizePreview = async (upstream) => {
                  upstream.throwIfAborted()
                  if (workspaceId !== null) {
                    const workspace = await workspaces.resolve(workspaceId, upstream)
                    return workspaces.file(workspace, target, upstream)
                  }
                  const roots = await rootsNow()
                  return authorizedFile(resolve(target), store === undefined ? await Promise.all(roots.map(root => realpath(root))) : roots)
                }
                await serveOfficePreview(ctx, response, request, authorize, workspaceId ?? 'library', signal)
                return
              }
              const download = url.searchParams.get('download') === '1'
              if (workspaceId !== null) {
                const workspace = await workspaces.resolve(workspaceId, signal)
                const file = await workspaces.file(workspace, target, signal)
                await serveFile(response, request, file.path, [workspace.path], signal, true, download)
              } else {
                await serveFile(response, request, resolve(target), await rootsNow(), signal, store !== undefined, download)
              }
              return
            }
            json(response, 404, { error: 'not found' })
          } catch (error) {
            if (signal.aborted) { response.destroy(); return }
            if (response.headersSent) { response.destroy(); return }
            const permission = error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
            json(response, error instanceof ArtifactError ? error.status : permission ? 403 : 500, {
              code: error instanceof ArtifactError ? error.code : permission ? 'ARTIFACT_PERMISSION_DENIED' : 'ARTIFACT_OPERATION_FAILED',
            })
          }
        })()
        requests.add(operation)
        try { await operation } finally {
          requests.delete(operation)
          request.off('aborted', stop)
          response.off('close', stop)
        }
      },
    })
    return async () => {
      unregister()
      lifetime.abort()
      await Promise.allSettled([...requests])
    }
  }, 'artifacts-index: routes')
}
