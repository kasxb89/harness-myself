/**
 * Host half of the sidebar Artifacts panel.
 *
 * Two routes under one `webServer` prefix: `/artifacts/api/list` returns the
 * files found under the configured roots with their derived kind, and
 * `/artifacts/api/raw` streams one file back for preview. Both are guarded by a
 * same-machine origin fence, and every read is resolved against a root before
 * it touches the filesystem, so a crafted `path` cannot leave the roots.
 *
 * @module @deepseek-ai/dsh-artifacts-index
 */

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'artifacts-index'

/** The route carrier this plugin registers into. */
export const inject = ['webServer']

/** Plugin config: which directories the panel browses and how far it walks. */
export interface Config {
  /** Absolute directories shown in the panel. An empty list serves nothing. */
  roots?: string[]
  /** Maximum files returned by one listing. */
  maxEntries?: number
  /** Maximum directory depth walked below each root. */
  maxDepth?: number
}

export const Config: z<Config> = z.object({
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

/** True when `target` is one of the roots or sits below one. */
function insideRoots(target: string, roots: readonly string[]): boolean {
  const normalized = normalize(target)
  return roots.some(root => normalized === root || normalized.startsWith(root.endsWith(sep) ? root : root + sep))
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
async function collect(root: string, limit: number, maxDepth: number): Promise<ArtifactEntry[]> {
  const entries: ArtifactEntry[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
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
        info = await stat(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (current.depth < maxDepth) queue.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!info.isFile()) continue
      entries.push({ path: full, name: basename(full), kind: kindOf(child), size: info.size, mtimeMs: info.mtimeMs })
    }
  }
  return entries
}

/** Serve one preview read, honouring a single byte range for media seeking. */
async function serveFile(response: ServerResponse, request: IncomingMessage, target: string): Promise<void> {
  let info
  try {
    info = await stat(target)
  } catch {
    json(response, 404, { error: 'not found' })
    return
  }
  if (!info.isFile()) {
    json(response, 404, { error: 'not a file' })
    return
  }
  const mediaType = MEDIA_TYPE_BY_EXTENSION[extname(target).toLowerCase()] ?? 'application/octet-stream'
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
    createReadStream(target, { start, end }).pipe(response)
    return
  }
  response.writeHead(200, {
    'content-type': mediaType,
    'content-length': info.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  })
  createReadStream(target).pipe(response)
}

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const roots = resolveRoots(resolved)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!originAllowed(request)) {
        json(response, 403, { error: 'forbidden origin' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(ROUTE_PREFIX.length)
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        json(response, 405, { error: 'method not allowed' })
        return
      }
      if (route === '/api/list') {
        const items: ArtifactEntry[] = []
        for (const root of roots) {
          if (items.length >= resolved.maxEntries) break
          items.push(...await collect(root, resolved.maxEntries - items.length, resolved.maxDepth))
        }
        items.sort((left, right) => right.mtimeMs - left.mtimeMs)
        json(response, 200, { roots, items, truncated: items.length >= resolved.maxEntries })
        return
      }
      if (route === '/api/raw') {
        const target = url.searchParams.get('path')
        if (target === null || !isAbsolute(target) || !insideRoots(resolve(target), roots)) {
          json(response, 403, { error: 'path outside the configured roots' })
          return
        }
        await serveFile(response, request, resolve(target))
        return
      }
      json(response, 404, { error: 'not found' })
    },
  }), 'artifacts-index: routes')
}
