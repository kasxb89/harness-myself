/** Real Loader/HTTP coverage of the local artifact output and recovery boundary. */
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Artifacts from '../src/index.ts'
import { validName, qualified } from '../src/storage.ts'

const fixtures: { ctx: Context; directory: string }[] = []
afterEach(async () => {
  for (const { ctx, directory } of fixtures.splice(0)) {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
})
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
async function boot(existing?: string, options: { connection?: boolean; maxEntries?: number; workspaces?: boolean } = {}) {
  const directory = existing ?? await realpath(await mkdtemp(join(tmpdir(), 'artifacts-storage-')))
  const ctx = new Context()
  fixtures.push({ ctx, directory })
  const output = join(directory, 'output')
  const state = join(directory, 'private-state')
  const custom = join(directory, 'custom')
  await mkdir(custom, { recursive: true })
  const config = join(directory, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { name: 'web', config: { host: '127.0.0.1', port: 0 } },
    { name: 'credentials', config: { path: join(directory, '.credentials.yaml'), dshHome: directory, watch: false } },
    ...options.connection === false ? [] : [{ name: 'connection' }],
    ...options.workspaces !== true ? [] : [
      { name: 'sessions' }, { name: 'persistence', config: { root: join(directory, 'sessions'), compression: 'none' } },
      { name: 'storage' }, { name: 'json', config: { root: join(directory, 'domains') } },
      { name: 'domain', config: { backend: 'json' } }, { name: 'workspaces' }, { name: 'fs', config: { cwd: directory } },
    ],
    { name: 'artifacts', config: { defaultOutputDirectory: output, stateDirectory: state, roots: [], maxEntries: options.maxEntries ?? 2000 } },
  ]))
  const modules = new Map<string, unknown>([
    ['web', WebServer], ['credentials', LocalCredentialProvider], ['connection', Connection], ['artifacts', Artifacts],
    ['sessions', SessionStore], ['persistence', JsonlSessionPersistence], ['storage', Storage], ['json', JsonStorage],
    ['domain', StorageDomain], ['workspaces', WorkspaceRegistry], ['fs', LocalFileSystem],
  ])
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2', async import(...[specifier]: Parameters<ModuleLoaderV2['import']>) {
      if (!modules.has(specifier)) throw new Error('Unexpected fixture import')
      return modules.get(specifier)
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const base = `http://127.0.0.1:${String(ctx.webServer.port)}`
  let cookie: string | undefined
  if (options.connection !== false) {
    const target = new URL(ctx.connection.authenticatedUrl(base))
    ctx.connection.authorizeIndex({ method: 'GET', url: target.pathname + target.search, headers: { host: target.host } }, {
      writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0] }, end() {},
    })
    if (cookie === undefined) throw new Error('Missing fixture browser authentication')
  }
  const request = async (path: string, body?: object, options: {
    origin?: string
    authenticated?: boolean
    noOrigin?: boolean
    headers?: Record<string, string>
    method?: 'HEAD'
    signal?: AbortSignal
  } = {}) => {
    const headers = new Headers(options.headers)
    if (options.noOrigin !== true) headers.set('origin', options.origin ?? base)
    if (options.authenticated !== false && cookie !== undefined) headers.set('cookie', cookie)
    if (body !== undefined) headers.set('content-type', 'application/json')
    return fetch(base + '/artifacts/api/' + path, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers,
      ...options.signal === undefined ? {} : { signal: options.signal },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    })
  }
  const json = async (path: string, body?: object) => object(await (await request(path, body)).json())
  const requestHost = (path: string, host: string): Promise<number> => new Promise((resolveStatus, reject) => {
    const headers = new Headers({ host })
    if (cookie !== undefined) headers.set('cookie', cookie)
    const call = httpRequest(base + '/artifacts/api/' + path, { headers: Object.fromEntries(headers) }, (response) => {
      response.resume()
      response.once('end', () => { resolveStatus(response.statusCode ?? 0) })
    })
    call.once('error', reject)
    call.end()
  })
  const version = async (path: string) => { const value = await stat(path); return { size: value.size, mtimeMs: value.mtimeMs } }
  return { ctx, directory, output, state, custom, base, request, requestHost, json, version }
}
const signal = () => new AbortController().signal

describe('artifact storage through the real Loader and HTTP routes', () => {
  it('creates the default, persists changed directory and historical roots, and keeps captured writes in their original directory', async () => {
    const f = await boot()
    expect(await f.json('storage')).toEqual({ directory: f.output, defaultDirectory: f.output, revision: 0, roots: [f.output] })
    const old = await f.ctx.artifactStorage.capture(signal())
    expect(await f.json('storage', { directory: f.custom, expectedRevision: 0 })).toEqual({ directory: f.custom, defaultDirectory: f.output, revision: 1, roots: [f.output, f.custom] })
    expect(await (await f.request('storage', { directory: f.output, expectedRevision: 0 })).json()).toEqual({ code: 'ARTIFACT_STALE' })
    const saved = await f.ctx.artifactStorage.write({ destination: old, filename: 'old.png', bytes: new Uint8Array([1, 2]), signal: signal() })
    expect(saved.path).toBe(join(f.output, 'old.png'))
    const current = await f.ctx.artifactStorage.capture(signal())
    expect((await f.ctx.artifactStorage.write({ destination: current, filename: 'new.png', bytes: new Uint8Array([3]), signal: signal() })).path).toBe(join(f.custom, 'new.png'))
    const prefs = object(JSON.parse(await readFile(join(f.state, 'storage.json'), 'utf8')))
    expect(prefs.directory).toBe(f.custom)
    expect(object(await f.json('list')).items).toHaveLength(2)
    await f.ctx.fiber.dispose()
    fixtures.splice(fixtures.findIndex(value => value.ctx === f.ctx), 1)
    const restarted = await boot(f.directory)
    expect(await restarted.json('storage')).toEqual({ directory: f.custom, defaultDirectory: f.output, revision: 1, roots: [f.output, f.custom] })
    // Durable project destinations are plain JSON, not ephemeral object identities.
    await expect(restarted.ctx.artifactStorage.validate({ directory: old.directory }, signal())).resolves.toBeUndefined()
  })

  it('authenticates management endpoints and rejects opaque, cross-origin and adjacent-loopback writes', async () => {
    const f = await boot()
    expect((await f.request('storage', undefined, { authenticated: false })).status).toBe(401)
    for (const origin of ['null', 'https://attacker.invalid', 'http://127.0.0.1:1']) {
      const response = await f.request('storage', { directory: f.custom, expectedRevision: 0 }, { origin })
      expect(response.status).toBe(403)
    }
    expect((await f.json('storage')).revision).toBe(0)
  })

  it('authenticates list and raw reads, rejecting untrusted Host headers even without Origin', async () => {
    const f = await boot()
    const path = join(f.output, 'private.txt')
    await writeFile(path, 'private output')
    for (const route of ['list', 'raw?path=' + encodeURIComponent(path)]) {
      expect((await f.request(route, undefined, { authenticated: false, noOrigin: true })).status).toBe(401)
      expect(await f.requestHost(route, 'attacker.invalid')).toBe(403)
      expect((await f.request(route)).status).toBe(200)
    }
    const missingConnection = await boot(undefined, { connection: false })
    for (const route of ['storage', 'list', 'raw?path=' + encodeURIComponent(join(missingConnection.output, 'private.txt'))]) {
      const response = await missingConnection.request(route)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ code: 'ARTIFACT_AUTH_REQUIRED' })
    }
  })

  it('deduplicates overlapping retained roots before consuming the global listing limit', async () => {
    const f = await boot(undefined, { maxEntries: 2 })
    const nested = join(f.output, 'nested')
    await mkdir(nested)
    const first = join(f.output, 'first.txt')
    const second = join(nested, 'second.txt')
    await writeFile(first, 'first')
    await writeFile(second, 'second')
    await f.json('storage', { directory: nested, expectedRevision: 0 })
    const listed = await f.json('list')
    expect(listed.truncated).toBe(false)
    if (!Array.isArray(listed.items)) throw new Error('Missing artifact list')
    expect(listed.items.map(value => object(value).path).sort()).toEqual([first, second].sort())
    await writeFile(join(nested, 'third.txt'), 'third')
    const limited = await f.json('list')
    expect(limited.truncated).toBe(true)
    if (!Array.isArray(limited.items)) throw new Error('Missing artifact list')
    expect(limited.items).toHaveLength(2)
    expect(new Set(limited.items.map(value => object(value).path)).size).toBe(2)
  })

  it('renames only the selected version and refuses existing files and Windows-dangerous names', async () => {
    const f = await boot()
    const source = join(f.output, 'first.txt')
    const existing = join(f.output, 'existing.txt')
    await writeFile(source, 'original')
    await writeFile(existing, 'keep')
    const expected = await f.version(source)
    expect(await f.json('rename', { path: source, name: 'existing.txt', expected })).toEqual({ code: 'ARTIFACT_CONFLICT' })
    expect(await f.json('rename', { path: source, name: 'new.txt', expected: { ...expected, size: 999 } })).toEqual({ code: 'ARTIFACT_STALE' })
    for (const name of ['../escape', 'CON.txt', 'a:stream', 'last.', 'last ', 'folder\\file', '', '.hidden.png']) {
      expect(await f.json('rename', { path: source, name, expected })).toEqual({ code: 'ARTIFACT_NAME_INVALID' })
    }
    expect(object((await f.json('rename', { path: source, name: 'renamed.txt', expected })).item).name).toBe('renamed.txt')
    expect(await readFile(join(f.output, 'renamed.txt'), 'utf8')).toBe('original')
    expect(await readFile(existing, 'utf8')).toBe('keep')
  })

  it('retains a durable recoverable deletion across Loader restart and never overwrites an occupied restore path', async () => {
    const f = await boot()
    const path = join(f.output, 'restore.txt')
    await writeFile(path, 'recover me')
    const result = await f.json('trash', { path, expected: await f.version(path) })
    expect(typeof result.trashId).toBe('string')
    expect(await readFile(path).catch(() => null)).toBeNull()
    expect((await f.json('list')).items).toEqual([])
    await f.ctx.fiber.dispose()
    fixtures.splice(fixtures.findIndex(value => value.ctx === f.ctx), 1)
    const restarted = await boot(f.directory)
    const rows = (await restarted.json('trash')).items
    if (!Array.isArray(rows)) throw new Error('Missing recovery list')
    expect(rows).toEqual([{ id: result.trashId, name: 'restore.txt', originalPath: path, deletedAt: object(rows[0]).deletedAt }])
    await writeFile(path, 'new user file')
    expect(await restarted.json('restore', { id: result.trashId })).toEqual({ code: 'ARTIFACT_CONFLICT' })
    expect(await readFile(path, 'utf8')).toBe('new user file')
    // Rename the new user file through the same safe API before restoring.
    await restarted.json('rename', { path, name: 'new-user-file.txt', expected: await restarted.version(path) })
    expect(object((await restarted.json('restore', { id: result.trashId })).item).path).toBe(path)
    expect(await readFile(path, 'utf8')).toBe('recover me')
    expect(await readFile(join(f.output, 'new-user-file.txt'), 'utf8')).toBe('new user file')
    expect((await restarted.json('trash')).items).toEqual([])
  })

  it('rejects root escapes, symlink reads and mutations, and never indexes a linked outside directory', async () => {
    const f = await boot()
    const outside = join(f.directory, 'outside')
    await mkdir(outside)
    const secret = join(outside, 'keep.txt')
    await writeFile(secret, 'keep private')
    await symlink(outside, join(f.output, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir')
    const linked = join(f.output, 'linked-directory', 'keep.txt')
    expect((await f.json('list')).items).toEqual([])
    expect((await f.request('raw?path=' + encodeURIComponent(linked))).status).toBe(404)
    expect(await f.json('trash', { path: linked, expected: await f.version(secret) })).toEqual({ code: 'ARTIFACT_PATH_FORBIDDEN' })
    expect(await f.json('rename', { path: secret, name: 'moved.txt', expected: await f.version(secret) })).toEqual({ code: 'ARTIFACT_PATH_FORBIDDEN' })
    expect(await readFile(secret, 'utf8')).toBe('keep private')
    expect(await f.json('storage', { directory: f.state, expectedRevision: 0 })).toEqual({ code: 'ARTIFACT_STORAGE_INVALID' })
  })

  it('never follows a retained root redirected to an outside directory or private state', async () => {
    const f = await boot()
    await f.json('storage', { directory: f.custom, expectedRevision: 0 })
    await writeFile(join(f.custom, 'keep.txt'), 'current output')
    const outside = join(f.directory, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'outside secret')
    await rename(f.output, join(f.directory, 'original-output'))
    for (const redirected of [outside, f.state]) {
      await symlink(redirected, f.output, process.platform === 'win32' ? 'junction' : 'dir')
      const listed = await f.json('list')
      expect(listed.roots).toEqual([f.custom])
      if (!Array.isArray(listed.items)) throw new Error('Missing artifact list')
      expect(listed.items.map(value => object(value).name)).toEqual(['keep.txt'])
      const name = redirected === outside ? 'secret.txt' : 'storage.json'
      for (const path of [join(f.output, name), join(redirected, name)]) {
        expect((await f.request('raw?path=' + encodeURIComponent(path))).status).toBe(404)
      }
      await rm(f.output)
    }
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside secret')
  })

  it('publishes an edited file without removing its source, refuses duplicate output names and honors cancellation', async () => {
    const f = await boot()
    const source = join(f.directory, 'finished.mp4')
    await writeFile(source, 'video bytes')
    const destination = await f.ctx.artifactStorage.capture(signal())
    const published = await f.ctx.artifactStorage.publish({ destination, sourcePath: source, filename: 'final.mp4', signal: signal() })
    expect(await readFile(published.path, 'utf8')).toBe('video bytes')
    await expect(f.ctx.artifactStorage.publish({
      destination: { directory: f.custom }, sourcePath: source, filename: 'unapproved.mp4', signal: signal(),
    })).rejects.toMatchObject({ code: 'ARTIFACT_OUTPUT_INVALID' })
    expect(await readFile(source, 'utf8')).toBe('video bytes')
    await expect(f.ctx.artifactStorage.write({ destination, filename: 'final.mp4', bytes: new Uint8Array([9]), signal: signal() })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    expect(await readFile(published.path, 'utf8')).toBe('video bytes')
    const abort = new AbortController(); abort.abort()
    await expect(f.ctx.artifactStorage.capture(abort.signal)).rejects.toThrow()
    await expect(f.ctx.artifactStorage.write({ destination, filename: 'cancelled.mp4', bytes: new Uint8Array([9]), signal: abort.signal })).rejects.toThrow()
    expect(await readFile(join(f.output, 'cancelled.mp4')).catch(() => null)).toBeNull()
  })

  it('sandboxes generated HTML/SVG and preserves byte-range video previews', async () => {
    const f = await boot()
    for (const name of ['page.html', 'picture.svg']) {
      const path = join(f.output, name)
      await writeFile(path, '<script>parent.fetch("/artifacts/api/trash")</script>')
      const result = await f.request('raw?path=' + encodeURIComponent(path))
      expect(result.headers.get('content-security-policy')).toContain('sandbox')
      expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    }
    const path = join(f.output, 'clip.mp4')
    await writeFile(path, 'abcdef')
    const result = await f.request('raw?path=' + encodeURIComponent(path), undefined, { headers: { range: 'bytes=1-3' } })
    expect(result.status).toBe(206)
    expect(await result.text()).toBe('bcd')
    const head = await f.request('raw?path=' + encodeURIComponent(path), undefined, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('6')
    expect(await head.text()).toBe('')
  })

  it('validates retained destinations before resuming and refuses an offline or redirected old root', async () => {
    const f = await boot()
    const captured = await f.ctx.artifactStorage.capture(signal())
    await f.json('storage', { directory: f.custom, expectedRevision: 0 })
    await expect(f.ctx.artifactStorage.validate({ directory: captured.directory }, signal())).resolves.toBeUndefined()
    await expect(f.ctx.artifactStorage.validate({ directory: f.directory }, signal())).rejects.toMatchObject({ code: 'ARTIFACT_OUTPUT_INVALID' })
    await rename(f.output, join(f.directory, 'offline'))
    await expect(f.ctx.artifactStorage.validate(captured, signal())).rejects.toMatchObject({ code: 'ARTIFACT_STORAGE_INVALID' })
    await symlink(f.custom, f.output, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.ctx.artifactStorage.validate(captured, signal())).rejects.toMatchObject({ code: 'ARTIFACT_STORAGE_INVALID' })
  })

  it('reports damaged recovery records visibly and preserves the recoverable payload', async () => {
    const f = await boot()
    const path = join(f.output, 'recover.txt')
    await writeFile(path, 'preserved')
    const removed = await f.json('trash', { path, expected: await f.version(path) })
    const recordPath = join(f.state, 'trash', String(removed.trashId) + '.json')
    const original = await readFile(recordPath, 'utf8')
    await writeFile(recordPath, '{damaged')
    expect(await f.json('trash')).toEqual({ code: 'ARTIFACT_TRASH_INVALID' })
    expect(await f.json('restore', { id: removed.trashId })).toEqual({ code: 'ARTIFACT_TRASH_INVALID' })
    await writeFile(recordPath, original)
    await f.json('restore', { id: removed.trashId })
    expect(await readFile(path, 'utf8')).toBe('preserved')
    expect((await f.request('restore', { id: removed.trashId })).status).toBe(404)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps original bytes when rename or capture fails for directory permissions', async () => {
    const f = await boot()
    const path = join(f.output, 'keep.txt')
    await writeFile(path, 'keep original')
    const expected = await f.version(path)
    await chmod(f.output, 0o500)
    try {
      expect(await f.json('rename', { path, name: 'new.txt', expected })).toEqual({ code: 'ARTIFACT_MOVE_UNSUPPORTED' })
      await expect(f.ctx.artifactStorage.capture(signal())).rejects.toMatchObject({ code: 'ARTIFACT_STORAGE_UNWRITABLE' })
      expect(await readFile(path, 'utf8')).toBe('keep original')
      expect(await readFile(join(f.output, 'new.txt')).catch(() => null)).toBeNull()
    } finally { await chmod(f.output, 0o700) }
  })

  it('finishes an admitted output before disposal and refuses later writes on the retired service', async () => {
    const f = await boot()
    const storage = f.ctx.artifactStorage
    const destination = await storage.capture(signal())
    const saving = storage.write({ destination, filename: 'pending.bin', bytes: new Uint8Array(1024 * 1024), signal: signal() })
    const entry = [...f.ctx.loader.entries()].find(value => value.options.name === 'artifacts')
    await entry?.fiber?.dispose()
    expect(await readFile((await saving).path)).toHaveLength(1024 * 1024)
    expect(f.ctx.get('artifactStorage')).toBeUndefined()
    await expect(storage.write({ destination, filename: 'later.bin', bytes: new Uint8Array([1]), signal: signal() })).rejects.toMatchObject({ code: 'ARTIFACT_STORAGE_UNAVAILABLE' })
  })

  it('unregisters the shared service and HTTP routes with the owning Loader fiber', async () => {
    const f = await boot()
    const entry = [...f.ctx.loader.entries()].find(value => value.options.name === 'artifacts')
    await entry?.fiber?.dispose()
    expect(f.ctx.get('artifactStorage')).toBeUndefined()
    expect((await f.request('list')).status).toBe(404)
  })
})

describe('registered Workspace files through the real Loader', () => {
  it('browses new non-Git files and one directory layer across registered Workspaces without expanding output preferences', async () => {
    const f = await boot(undefined, { workspaces: true })
    const alpha = join(f.directory, 'alpha')
    const beta = join(f.directory, 'beta')
    await mkdir(join(alpha, 'drafts'), { recursive: true })
    await mkdir(beta)
    await writeFile(join(alpha, 'outside-tool.txt'), 'written independently of Session tools')
    await writeFile(join(alpha, 'drafts', 'nested.md'), 'nested output')
    await writeFile(join(beta, 'other.png'), 'other workspace')
    const first = await f.ctx.workspaceRegistry.create(alpha)
    const second = await f.ctx.workspaceRegistry.create(beta)
    const page = await f.json('workspace?' + new URLSearchParams({ workspaceId: first.id }).toString())
    expect(page).toMatchObject({
      workspace: { id: first.id, title: 'alpha', path: alpha }, directory: '', absoluteDirectory: alpha,
      parentDirectory: null, directories: [{ name: 'drafts', directory: 'drafts' }], truncated: false,
      items: [{ name: 'outside-tool.txt', path: join(alpha, 'outside-tool.txt'), workspaceId: first.id, kind: 'document' }],
    })
    expect(await f.json('workspace?' + new URLSearchParams({ workspaceId: first.id, directory: 'drafts' }).toString())).toMatchObject({
      directory: 'drafts', absoluteDirectory: join(alpha, 'drafts'), parentDirectory: '', directories: [],
      items: [{ name: 'nested.md', workspaceId: first.id }],
    })
    expect(await f.json('workspace?' + new URLSearchParams({ workspaceId: second.id }).toString())).toMatchObject({
      items: [{ name: 'other.png', workspaceId: second.id }],
    })
    expect(await f.json('storage')).toEqual({ directory: f.output, defaultDirectory: f.output, revision: 0, roots: [f.output] })
    expect((await f.json('list')).items).toEqual([])
    expect((await f.request('raw?' + new URLSearchParams({ workspaceId: first.id, path: join(alpha, 'outside-tool.txt') }).toString())).status).toBe(200)
    expect((await f.request('raw?' + new URLSearchParams({ path: join(alpha, 'outside-tool.txt') }).toString())).status).toBe(404)
    expect((await f.request('raw?' + new URLSearchParams({ workspaceId: second.id, path: join(alpha, 'outside-tool.txt') }).toString())).status).toBe(403)
    expect((await f.request('workspace?' + new URLSearchParams({ workspaceId: first.id }).toString(), undefined, { authenticated: false })).status).toBe(401)
    expect(await f.requestHost('workspace?' + new URLSearchParams({ workspaceId: first.id }).toString(), 'attacker.invalid')).toBe(403)
  })

  it('keeps Workspace deletion recoverable after registration removal, restart and re-registration under a new id', async () => {
    const f = await boot(undefined, { workspaces: true })
    const root = join(f.directory, 'project')
    await mkdir(root)
    const workspace = await f.ctx.workspaceRegistry.create(root)
    const path = join(root, 'deliverable.txt')
    const occupied = join(root, 'occupied.txt')
    await writeFile(path, 'original deliverable')
    await writeFile(occupied, 'keep occupied')
    const expected = await f.version(path)
    expect(await f.json('rename', { workspaceId: workspace.id, path, name: 'occupied.txt', expected })).toEqual({ code: 'ARTIFACT_CONFLICT' })
    expect(await f.json('rename', { workspaceId: workspace.id, path, name: 'fresh.txt', expected: { ...expected, size: 999 } })).toEqual({ code: 'ARTIFACT_STALE' })
    const renamed = await f.json('rename', { workspaceId: workspace.id, path, name: 'renamed.txt', expected })
    const renamedPath = join(root, 'renamed.txt')
    expect(renamed).toMatchObject({ item: { path: renamedPath, workspaceId: workspace.id } })
    const removed = await f.json('trash', { workspaceId: workspace.id, path: renamedPath, expected: await f.version(renamedPath) })
    const recoveryItems = (await f.json('trash')).items
    expect(recoveryItems).toMatchObject([{ id: removed.trashId, name: 'renamed.txt', originalPath: renamedPath }])
    if (!Array.isArray(recoveryItems)) throw new Error('Missing recovery list')
    expect(typeof object(recoveryItems[0]).deletedAt).toBe('string')
    await f.ctx.workspaceRegistry.delete(workspace.id)
    expect(await f.json('workspace?' + new URLSearchParams({ workspaceId: workspace.id }).toString())).toEqual({ code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' })
    expect(await (await f.request('raw?' + new URLSearchParams({ workspaceId: workspace.id, path: occupied }).toString())).json()).toEqual({ code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' })
    expect(await f.json('trash', { workspaceId: workspace.id, path: occupied, expected: await f.version(occupied) })).toEqual({ code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' })
    expect(await f.json('restore', { id: removed.trashId })).toEqual({ code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' })
    expect((await f.json('trash')).items).toHaveLength(1)
    await f.ctx.fiber.dispose()
    fixtures.splice(fixtures.findIndex(value => value.ctx === f.ctx), 1)
    const restarted = await boot(f.directory, { workspaces: true })
    expect(restarted.ctx.workspaceRegistry.list()).toEqual([])
    expect((await restarted.json('trash')).items).toHaveLength(1)
    const next = await restarted.ctx.workspaceRegistry.create(root)
    expect(next.id).not.toBe(workspace.id)
    expect(await restarted.json('restore', { id: removed.trashId })).toMatchObject({ item: { path: renamedPath } })
    expect(await readFile(renamedPath, 'utf8')).toBe('original deliverable')
    expect(await readFile(occupied, 'utf8')).toBe('keep occupied')
    expect((await restarted.json('trash')).items).toEqual([])
    await restarted.ctx.fiber.dispose()
    fixtures.splice(fixtures.findIndex(value => value.ctx === restarted.ctx), 1)
    const final = await boot(f.directory, { workspaces: true })
    expect(final.ctx.workspaceRegistry.list().map(value => value.id)).toEqual([next.id])
    expect((await final.json('storage')).roots).toEqual([f.output])
  })

  it('excludes hidden, dependency, private-state and symlink paths from browsing, previews and mutations', async () => {
    const f = await boot(undefined, { workspaces: true })
    const workspace = await f.ctx.workspaceRegistry.create(f.directory)
    await mkdir(join(f.directory, 'node_modules'))
    await mkdir(join(f.directory, '.git'))
    if (process.platform !== 'win32') {
      await mkdir(join(f.directory, 'nonportable:directory'))
      await mkdir(join(f.directory, 'nonportable\\directory'))
    }
    const paths = [join(f.directory, 'node_modules', 'package.json'), join(f.directory, '.git', 'config'), join(f.state, 'private.txt')]
    for (const path of paths) await writeFile(path, 'do not expose')
    const outside = join(f.directory, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'outside secret')
    const root = join(f.directory, 'nested-root')
    await mkdir(root)
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const nested = await f.ctx.workspaceRegistry.create(root)
    const listed = await f.json('workspace?' + new URLSearchParams({ workspaceId: workspace.id }).toString())
    if (!Array.isArray(listed.directories)) throw new Error('Missing directory list')
    expect(listed.directories.map(value => object(value).name)).not.toContain('node_modules')
    expect(listed.directories.map(value => object(value).name)).not.toContain('.git')
    expect(listed.directories.map(value => object(value).name)).not.toContain('private-state')
    expect(listed.directories.map(value => object(value).name)).not.toContain('nonportable:directory')
    expect(listed.directories.map(value => object(value).name)).not.toContain('nonportable\\directory')
    for (const path of paths) {
      expect((await f.request('raw?' + new URLSearchParams({ workspaceId: workspace.id, path }).toString())).status).toBe(403)
      expect(await f.json('trash', { workspaceId: workspace.id, path, expected: await f.version(path) })).toEqual({ code: 'ARTIFACT_PATH_FORBIDDEN' })
      expect(await readFile(path, 'utf8')).toBe('do not expose')
    }
    expect(await f.json('workspace?' + new URLSearchParams({ workspaceId: nested.id }).toString())).toMatchObject({ directories: [], items: [] })
    expect((await f.request('raw?' + new URLSearchParams({ workspaceId: nested.id, path: join(root, 'escape', 'secret.txt') }).toString())).status).toBe(403)
    expect((await f.request('workspace?' + new URLSearchParams({ workspaceId: nested.id, directory: 'escape' }).toString())).status).toBe(400)
    for (const directory of ['..', '../outside', '/tmp', 'C:/Windows', 'sub\\path', 'folder:stream', './drafts']) {
      expect(await f.json('workspace?' + new URLSearchParams({ workspaceId: nested.id, directory }).toString())).toEqual({ code: 'ARTIFACT_DIRECTORY_INVALID' })
    }
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside secret')
  })

  it('refuses redirected registered roots and unsupported remote mappings', async () => {
    const f = await boot(undefined, { workspaces: true })
    const root = join(f.directory, 'project')
    await mkdir(root)
    const workspace = await f.ctx.workspaceRegistry.create(root)
    await rename(root, join(f.directory, 'offline'))
    await symlink(f.state, root, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await f.json('workspace?' + new URLSearchParams({ workspaceId: workspace.id }).toString())).toEqual({ code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' })
    await rm(root)
    await rename(join(f.directory, 'offline'), root)
    const mapping = vi.spyOn(f.ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    try {
      expect(await f.json('workspace?' + new URLSearchParams({ workspaceId: workspace.id }).toString())).toEqual({ code: 'ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED' })
    } finally { mapping.mockRestore() }
    expect(await f.json('workspace?' + new URLSearchParams({ workspaceId: 'not-registered' }).toString())).toEqual({ code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' })
  })

  it('bounds files and directories together and reports actual truncation', async () => {
    const f = await boot(undefined, { workspaces: true, maxEntries: 2 })
    const root = join(f.directory, 'project')
    await mkdir(root)
    await mkdir(join(root, 'directory'))
    await writeFile(join(root, 'file.txt'), 'one')
    const workspace = await f.ctx.workspaceRegistry.create(root)
    const route = 'workspace?' + new URLSearchParams({ workspaceId: workspace.id }).toString()
    expect(await f.json(route)).toMatchObject({ truncated: false })
    await writeFile(join(root, 'another.txt'), 'two')
    const listed = await f.json(route)
    expect(listed.truncated).toBe(true)
    if (!Array.isArray(listed.items) || !Array.isArray(listed.directories)) throw new Error('Missing bounded page')
    expect(listed.items.length + listed.directories.length).toBe(2)
  })

  it.each(['disconnect', 'dispose'] as const)('cancels a pending Workspace read on %s without retaining its request', async (kind) => {
    const f = await boot(undefined, { workspaces: true })
    const root = join(f.directory, 'project')
    await mkdir(root)
    const workspace = await f.ctx.workspaceRegistry.create(root)
    let entered!: () => void
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted })
    const original = f.ctx.fs.resolve.bind(f.ctx.fs)
    const mapping = vi.spyOn(f.ctx.fs, 'resolve').mockImplementationOnce(async (path, options) => {
      const control = options?.signal
      if (control === undefined) throw new Error('Missing request lifetime')
      entered()
      await new Promise<void>((_resolve, reject) => {
        if (control.aborted) reject(new Error('Fixture mapping cancelled', { cause: control.reason }))
        else control.addEventListener('abort', () => { reject(new Error('Fixture mapping cancelled', { cause: control.reason })) }, { once: true })
      })
      return original(path, options)
    })
    const abort = new AbortController()
    const request = f.request('workspace?' + new URLSearchParams({ workspaceId: workspace.id }).toString(), undefined, { signal: abort.signal })
      .then(() => false, () => true)
    await started
    if (kind === 'disconnect') abort.abort()
    else await [...f.ctx.loader.entries()].find(value => value.options.name === 'artifacts')?.fiber?.dispose()
    expect(await request).toBe(true)
    mapping.mockRestore()
  })
})

it.each(['C:relative', '\\rooted', '/rooted', '\\\\server', '\\\\?\\C:\\private', 'C:\\root\\file:stream'])('rejects a Windows noncanonical directory form %s', (path) => {
  expect(qualified(path, 'win32')).toBe(false)
})
it.each(['C:\\Users\\name\\artifacts', '\\\\server\\share\\artifacts'])('accepts fully qualified Windows paths %s', (path) => {
  expect(qualified(path, 'win32')).toBe(true)
})
it.each(['CON', 'nul.txt', 'COM1.mp4', 'a:b.mp4', '../bad', 'last.', 'last '])('rejects portable unsafe filename %s', (name) => {
  expect(validName(name)).toBe(false)
})
