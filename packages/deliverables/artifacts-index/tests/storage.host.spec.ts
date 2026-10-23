/** Real Loader/HTTP coverage of the local artifact output and recovery boundary. */
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
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
import type { OfficeToPdfRequest, OfficeToPdfResult } from '@deepseek-ai/dsh-office-to-pdf'
import * as Artifacts from '../src/index.ts'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { validName, qualified } from '../src/storage.ts'
import { originPath } from '../src/origin.ts'
import { videoRolePath } from '../src/video-role.ts'

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
async function boot(existing?: string, options: {
  connection?: boolean
  maxEntries?: number
  maxDepth?: number
  workspaces?: boolean
  rootsOnly?: boolean
} = {}) {
  const directory = existing ?? await realpath(await mkdtemp(join(tmpdir(), 'artifacts-storage-')))
  const ctx = new Context()
  fixtures.push({ ctx, directory })
  const output = join(directory, 'output')
  const state = join(directory, 'private-state')
  const custom = join(directory, 'custom')
  await mkdir(custom, { recursive: true })
  if (options.rootsOnly === true) await mkdir(output, { recursive: true })
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
    { name: 'artifacts', config: {
      defaultOutputDirectory: options.rootsOnly === true ? '' : output,
      stateDirectory: options.rootsOnly === true ? '' : state,
      roots: options.rootsOnly === true ? [output] : [],
      maxEntries: options.maxEntries ?? 2000, maxDepth: options.maxDepth ?? 5,
    } },
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

const pdf = Buffer.from('%PDF-1.4\nconverted fixture\n%%EOF')
const converted = (): OfficeToPdfResult => ({
  pdf, missingFonts: ['Private font name'],
  cacheKey: 'fixture-cache' as OfficeToPdfResult['cacheKey'], generation: 'fixture-generation' as OfficeToPdfResult['generation'],
})
function provideConverter(ctx: Context, convert: (request: OfficeToPdfRequest, signal: AbortSignal) => Promise<OfficeToPdfResult>) {
  const call = vi.fn((request: OfficeToPdfRequest, upstream?: AbortSignal) => convert(request, upstream ?? signal()))
  const dispose = ctx.reflect.provide('officeToPdf', { convert: call })
  ctx.effect(() => dispose)
  return call
}

describe('artifact storage through the real Loader and HTTP routes', () => {
  it('classifies exact producer videos across rename, recovery and restart without guessing names or trusting changed files', async () => {
    const f = await boot()
    const destination = await f.ctx.artifactStorage.capture(signal())
    const final = await f.ctx.artifactStorage.write({ destination, filename: 'clip-001.mp4', bytes: Uint8Array.of(1, 2),
      videoRole: 'final', signal: signal() })
    const source = join(f.custom, 'source.mp4')
    await writeFile(source, Uint8Array.of(3, 4))
    const shot = await f.ctx.artifactStorage.publish({ destination, sourcePath: source, filename: 'finished.mp4',
      videoRole: 'shot', signal: signal() })
    const legacy = join(f.output, 'clips-project-final.mp4')
    await writeFile(legacy, Uint8Array.of(5, 6))
    const listing = await f.json('list')
    expect(listing.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: final.path, kind: 'video', videoRole: 'final' }),
      expect.objectContaining({ path: shot.path, kind: 'video', videoRole: 'shot' }),
    ]))
    expect((listing.items as Record<string, unknown>[]).find(entry => entry.path === legacy)).not.toHaveProperty('videoRole')
    expect((await f.request('list', undefined, { authenticated: false })).status).toBe(401)
    const renamed = object((await f.json('rename', { path: shot.path, name: 'renamed.mp4', expected: await f.version(shot.path) })).item)
    expect(renamed.videoRole).toBe('shot')
    if (typeof renamed.path !== 'string') throw new Error('Expected renamed output path')
    const { trashId } = await f.json('trash', { path: renamed.path, expected: await f.version(renamed.path) })
    expect(object((await f.json('restore', { id: trashId })).item).videoRole).toBe('shot')
    await f.ctx.fiber.dispose()
    fixtures.splice(fixtures.findIndex(value => value.ctx === f.ctx), 1)
    const restarted = await boot(f.directory)
    expect((await restarted.json('list')).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: renamed.path, videoRole: 'shot' }),
    ]))
    await writeFile(videoRolePath(f.state, await stat(final.path)), '{"version":1,"identity":"wrong","videoRole":"shot"}')
    await writeFile(renamed.path, 'replaced video')
    const changed = (await restarted.json('list')).items as Record<string, unknown>[]
    for (const path of [final.path, renamed.path, legacy]) expect(changed.find(entry => entry.path === path)).not.toHaveProperty('videoRole')
  })

  it('records only new authorized presentation appends, preserves existing generating chats and ignores seeded history', async () => {
    const f = await boot(undefined, { workspaces: true })
    const workspace = await f.ctx.workspaceRegistry.create(f.custom)
    const query = async (path: string, workspaceId?: string) => `origin?${new URLSearchParams({ path,
      ...Object.fromEntries(Object.entries(await f.version(path)).map(([key, value]) => [key, String(value)])),
      ...workspaceId === undefined ? {} : { workspaceId } })}`
    const document = join(f.custom, 'document.txt')
    const oldDocument = join(f.custom, 'history.txt')
    const outside = join(f.directory, 'outside.txt')
    for (const path of [document, oldDocument, outside]) await writeFile(path, 'document')
    const session = f.ctx.sessions.create(SessionId('present-source'), { meta: { cwd: f.custom } })
    const { seq } = session.append('deliverables/presented', { turn: 1, callId: ToolCallId('present-one'), files: [{ path: 'document.txt' }] })
    const origin = { sessionId: session.id, turn: 1, eventSeq: seq, toolCallId: 'present-one' }
    await vi.waitFor(async () => { expect(await f.json(await query(document, String(workspace.id)))).toEqual({ origin }) })
    f.ctx.sessions.create(SessionId('old-history'), { meta: { cwd: f.custom }, seed: [{ type: 'deliverables/presented',
      seq: SessionSeq(0), time: 0, data: { turn: 1, callId: ToolCallId('old-present'), files: [{ path: oldDocument }] } }] })
    expect(await f.json(await query(oldDocument, String(workspace.id)))).toEqual({ origin: null })
    const destination = await f.ctx.artifactStorage.capture(signal())
    const generatingOrigin = { sessionId: SessionId('original-generator'), turn: 4, toolCallId: ToolCallId('generate') }
    const generated = await f.ctx.artifactStorage.write({ destination, filename: 'generated.txt', bytes: Uint8Array.of(1), origin: generatingOrigin, signal: signal() })
    const marker = join(f.custom, 'marker.txt')
    await writeFile(marker, 'marker')
    const other = f.ctx.sessions.create(SessionId('other-chat'), { meta: { cwd: f.custom } })
    const warning = vi.spyOn(f.ctx.logger, 'warn')
    other.append('deliverables/presented', { turn: 2, callId: ToolCallId('present-two'), files: [
      { path: document }, { path: generated.path }, { path: outside }, { path: marker },
    ] })
    await vi.waitFor(async () => {
      expect(object((await f.json(await query(marker, String(workspace.id)))).origin).sessionId).toBe(other.id)
    })
    expect(await f.json(await query(document, String(workspace.id)))).toEqual({ origin })
    expect(await f.json(await query(generated.path))).toEqual({ origin: generatingOrigin })
    await expect(readFile(originPath(f.state, await stat(outside)))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(warning).toHaveBeenCalled()
    expect(await readFile(outside, 'utf8')).toBe('document')
    warning.mockRestore()
    const nested = join(f.custom, 'nested.txt')
    await writeFile(nested, 'nested')
    other.append('tool/ptc-dispatch-start', { rootCallId: ToolCallId('run-code'), parentCallId: ToolCallId('run-code'),
      subCallId: ToolCallId('present-child'), name: 'present', arguments: { files: [{ path: nested }] } })
    other.append('deliverables/presented', { turn: 2, callId: ToolCallId('present-child'), files: [{ path: nested }] })
    await vi.waitFor(async () => { expect(object((await f.json(await query(nested, String(workspace.id)))).origin).toolCallId).toBe('run-code') })
  })

  it('retains exact generating locations across rename, recycle, restore and restart while refusing replaced or legacy files', async () => {
    const f = await boot()
    const destination = await f.ctx.artifactStorage.capture(signal())
    const origin = { sessionId: SessionId('source-chat'), turn: 3, eventSeq: SessionSeq(12), toolCallId: ToolCallId('image-call') }
    const { path } = await f.ctx.artifactStorage.write({ destination, filename: 'source.png', bytes: Uint8Array.of(1, 2), origin, signal: signal() })
    const query = async (selected: string) => `origin?${new URLSearchParams({ path: selected,
      ...Object.fromEntries(Object.entries(await f.version(selected)).map(([key, value]) => [key, String(value)])) })}`
    expect(await f.json(await query(path))).toEqual({ origin })
    expect((await f.request(await query(path), undefined, { authenticated: false })).status).toBe(401)
    const renamed = object((await f.json('rename', { path, name: 'renamed.png', expected: await f.version(path) })).item).path as string
    expect(await f.json(await query(renamed))).toEqual({ origin })
    const { trashId } = await f.json('trash', { path: renamed, expected: await f.version(renamed) })
    await f.json('restore', { id: trashId })
    expect(await f.json(await query(renamed))).toEqual({ origin })
    await f.ctx.fiber.dispose()
    fixtures.splice(fixtures.findIndex(value => value.ctx === f.ctx), 1)
    const restarted = await boot(f.directory)
    expect(await restarted.json(await query(renamed))).toEqual({ origin })
    const selected = await query(renamed)
    await writeFile(renamed, 'different output')
    expect(await restarted.json(selected)).toEqual({ code: 'ARTIFACT_STALE' })
    expect(await restarted.json(await query(renamed))).toEqual({ origin: null })
    const legacy = join(f.output, 'source.png')
    await writeFile(legacy, Uint8Array.of(1, 2))
    expect(await restarted.json(await query(legacy))).toEqual({ origin: null })
    const published = await restarted.ctx.artifactStorage.publish({ destination, sourcePath: legacy, filename: 'copy.png', origin, signal: signal() })
    expect(await restarted.json(await query(published.path))).toEqual({ origin })
  })

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
    const restored = object((await restarted.json('restore', { id: result.trashId })).item)
    expect(restored.path).toBe(path)
    expect(restored.workspaceId).toBeUndefined()
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

  it('reports an offline retained save directory as partial while keeping healthy output authenticated and visible', async () => {
    const f = await boot()
    await f.json('storage', { directory: f.custom, expectedRevision: 0 })
    await writeFile(join(f.custom, 'old.png'), 'old image')
    await f.json('storage', { directory: f.output, expectedRevision: 1 })
    await writeFile(join(f.output, 'current.png'), 'healthy image')
    await rename(f.custom, join(f.directory, 'disconnected-custom'))
    expect((await f.request('list', undefined, { authenticated: false })).status).toBe(401)
    expect(await f.json('list')).toMatchObject({
      roots: [f.output], truncated: true, items: [{ path: join(f.output, 'current.png') }],
      storage: { directory: f.output, roots: [f.output, f.custom] },
    })
  })

  it('opens a managed output deeper than the inventory limit through authenticated directory drilldown', async () => {
    const f = await boot(undefined, { maxDepth: 1 })
    const parts = ['第一层', '第二层', 'third', 'fourth', 'fifth', 'sixth']
    const folder = join(f.output, ...parts)
    await mkdir(folder, { recursive: true })
    const path = join(folder, '深层产物.png')
    await writeFile(path, 'deep generated image')
    expect(await f.json('list')).toMatchObject({ items: [], truncated: true })
    for (let index = 0; index <= parts.length; index++) {
      const directory = parts.slice(0, index).join('/')
      const page = await f.json('directory?' + new URLSearchParams({ root: f.output, directory }).toString())
      expect(page).toMatchObject({
        root: f.output, directory, absoluteDirectory: join(f.output, ...parts.slice(0, index)),
        parentDirectory: index === 0 ? null : parts.slice(0, index - 1).join('/'),
        offset: 0, nextOffset: null, truncated: false,
      })
      if (index < parts.length) {
        expect(page.directories).toEqual([{ name: parts[index], directory: parts.slice(0, index + 1).join('/') }])
      } else {
        expect(page.items).toEqual([expect.objectContaining({ path, name: '深层产物.png', kind: 'image' })])
        if (!Array.isArray(page.items)) throw new Error('Missing deep output')
        const entry = object(page.items[0])
        expect(entry.workspaceId).toBeUndefined()
        if (typeof entry.path !== 'string') throw new Error('Missing output path')
        const preview = await f.request('raw?' + new URLSearchParams({ path: entry.path }).toString())
        expect(preview.status).toBe(200)
        expect(await preview.text()).toBe('deep generated image')
      }
    }
  })

  it('restricts managed directory browsing to current exact roots and portable relative directories', async () => {
    const f = await boot()
    const route = 'directory?' + new URLSearchParams({ root: f.output }).toString()
    expect((await f.request(route, undefined, { authenticated: false })).status).toBe(401)
    expect(await f.requestHost(route, 'attacker.invalid')).toBe(403)
    expect((await f.request(route, undefined, { origin: 'https://attacker.invalid' })).status).toBe(403)
    const noConnection = await boot(undefined, { connection: false, rootsOnly: true })
    expect((await noConnection.request('directory?' + new URLSearchParams({ root: noConnection.output }).toString())).status).toBe(403)
    for (const root of [f.directory, f.custom, f.state, 'C:relative', '\\rooted']) {
      expect(await f.json('directory?' + new URLSearchParams({ root }).toString())).toEqual({ code: 'ARTIFACT_PATH_FORBIDDEN' })
    }
    for (const directory of ['..', '../outside', '/tmp', 'C:/Windows', 'sub\\path', 'folder:stream', './drafts']) {
      expect(await f.json('directory?' + new URLSearchParams({ root: f.output, directory }).toString()))
        .toEqual({ code: 'ARTIFACT_DIRECTORY_INVALID' })
    }
    await mkdir(join(f.output, '.private'))
    expect(await f.json('directory?' + new URLSearchParams({ root: f.output, directory: '.private' }).toString()))
      .toEqual({ code: 'ARTIFACT_PATH_FORBIDDEN' })
    await symlink(f.custom, join(f.output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await f.json('directory?' + new URLSearchParams({ root: f.output, directory: 'linked' }).toString()))
      .toEqual({ code: 'ARTIFACT_DIRECTORY_INVALID' })
    expect((await f.json(route)).directories).toEqual([])
    await rename(f.output, join(f.directory, 'offline-output'))
    expect(await f.json(route)).toEqual({ code: 'ARTIFACT_PATH_FORBIDDEN' })
    await symlink(f.custom, f.output, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await f.json(route)).toEqual({ code: 'ARTIFACT_PATH_FORBIDDEN' })
  })

  it('continues managed and workspace directory pages without overlaps or excluded-entry offsets', async () => {
    const f = await boot(undefined, { workspaces: true, maxEntries: 2 })
    const workspace = await f.ctx.workspaceRegistry.create(f.custom)
    for (const root of [f.output, f.custom]) {
      await mkdir(join(root, '.ignored'))
      await writeFile(join(root, '.ignored', 'hidden.txt'), 'ignored')
      for (const name of ['one.txt', 'two.txt', '最后一份.txt']) await writeFile(join(root, name), name)
    }
    const queries: readonly { route: string; params: Record<string, string> }[] = [
      { route: 'directory', params: { root: f.output } },
      { route: 'workspace', params: { workspaceId: String(workspace.id) } },
    ]
    for (const query of queries) {
      const route = query.route + '?' + new URLSearchParams(query.params).toString()
      const first = await f.json(route)
      const next = await f.json(route + '&offset=' + String(first.nextOffset))
      expect(first).toMatchObject({ offset: 0, nextOffset: 2, truncated: true })
      expect(next).toMatchObject({ offset: 2, nextOffset: null, truncated: false })
      if (!Array.isArray(first.items) || !Array.isArray(next.items)) throw new Error('Missing continuation files')
      const all = first.items.map(object).concat(next.items.map(object))
      expect(all.map(entry => entry.name).sort()).toEqual(['one.txt', 'two.txt', '最后一份.txt'].sort())
      expect(new Set(all.map(entry => entry.path)).size).toBe(3)
      const last = object(next.items[0])
      if (typeof last.path !== 'string') throw new Error('Missing continued output path')
      const coordinates = new URLSearchParams({ path: last.path })
      if (typeof last.workspaceId === 'string') coordinates.set('workspaceId', last.workspaceId)
      expect((await f.request('raw?' + coordinates.toString())).status).toBe(200)
      for (const offset of ['-1', '1.5', 'NaN', '9007199254740992', '+1']) {
        expect(await f.json(route + '&offset=' + encodeURIComponent(offset))).toEqual({ code: 'ARTIFACT_DIRECTORY_INVALID' })
      }
    }
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

  it('offers authorized Unicode-named downloads and serves htm with the HTML sandbox', async () => {
    const f = await boot()
    const path = join(f.output, "报告 'final'.txt")
    await writeFile(path, 'keep original bytes')
    const query = 'raw?' + new URLSearchParams({ path, download: '1' }).toString()
    const result = await f.request(query, undefined, { headers: { range: 'bytes=0-3' } })
    expect(result.status).toBe(206)
    expect(await result.text()).toBe('keep')
    expect(result.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(result.headers.get('content-disposition')).toBe('attachment; filename="____final_.txt"; filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A%20%27final%27.txt')
    expect((await f.request(query, undefined, { authenticated: false })).status).toBe(401)
    const head = await f.request(query, undefined, { method: 'HEAD' })
    expect(head.headers.get('content-disposition')).toBe(result.headers.get('content-disposition'))
    expect(await head.text()).toBe('')
    const html = join(f.output, 'page.htm')
    await writeFile(html, '<script>parent.fetch("/artifacts/api/trash")</script>')
    const page = await f.request('raw?' + new URLSearchParams({ path: html }).toString())
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('content-security-policy')).toContain('sandbox; default-src \'none\'')
    expect(page.headers.get('content-disposition')).toBeNull()
    const unknown = join(f.output, 'opaque.xlsx')
    await writeFile(unknown, new Uint8Array([0, 255, 1]))
    expect((await f.request('raw?' + new URLSearchParams({ path: unknown }).toString())).headers.get('content-type')).toBe('application/octet-stream')
  })

  it('reports missing conversion providers after authorization and rejects unsupported preview formats', async () => {
    const f = await boot()
    const path = join(f.output, 'report.docx')
    await writeFile(path, 'office bytes')
    const query = 'preview?' + new URLSearchParams({ path }).toString()
    expect((await f.request(query, undefined, { authenticated: false })).status).toBe(401)
    expect(await f.requestHost(query, 'attacker.invalid')).toBe(403)
    const unavailable = await f.request(query)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ code: 'preview-unavailable' })
    const text = join(f.output, 'notes.txt')
    await writeFile(text, 'plain text')
    expect(await f.json('preview?' + new URLSearchParams({ path: text }).toString())).toEqual({ code: 'preview-invalid' })
  })

  it.each(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])('converts admitted %s bytes with cancellation and version metadata, preserving the original', async (extension) => {
    const f = await boot()
    const path = join(f.output, `report.${extension}`)
    await writeFile(path, 'original office source')
    const convert = provideConverter(f.ctx, async (request, upstream) => {
      expect(request.extension).toBe(extension)
      expect(request.priority).toBe('foreground')
      expect(JSON.parse(String(request.source.key))).toEqual(['artifacts', 'library', path])
      expect(request.source.bytes).toBe(22)
      const source = await request.source.read(upstream, 100)
      expect(Buffer.from(source.bytes).toString()).toBe('original office source')
      expect(source.version).toBe(request.source.version)
      return converted()
    })
    const query = 'preview?' + new URLSearchParams({ path }).toString()
    const result = await f.request(query)
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toBe('application/pdf')
    expect(result.headers.get('content-length')).toBe(String(pdf.length))
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    expect(result.headers.get('x-artifact-preview-missing-fonts')).toBe('1')
    expect([...result.headers.values()].join(' ')).not.toContain('Private font name')
    expect(Buffer.from(await result.arrayBuffer())).toEqual(pdf)
    const head = await f.request(query, undefined, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(pdf.length))
    expect(await head.text()).toBe('')
    expect(convert).toHaveBeenCalledTimes(2)
    expect(await readFile(path, 'utf8')).toBe('original office source')
  })

  it('bounds the deferred read and refuses a source changed while waiting for converter admission', async () => {
    const f = await boot()
    const path = join(f.output, 'report.docx')
    await writeFile(path, 'longer than capacity')
    const convert = provideConverter(f.ctx, async (request, upstream) => {
      await request.source.read(upstream, 3)
      return converted()
    })
    const query = 'preview?' + new URLSearchParams({ path }).toString()
    const tooLarge = await f.request(query)
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toEqual({ code: 'preview-too-large' })
    const admitted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    convert.mockImplementationOnce(async (request, upstream) => {
      admitted.resolve(undefined)
      await release.promise
      await request.source.read(upstream ?? signal(), 100)
      return converted()
    })
    const pending = f.request(query)
    await admitted.promise
    await writeFile(path, 'replacement office source')
    release.resolve(undefined)
    const stale = await pending
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ code: 'preview-stale' })
    expect(await readFile(path, 'utf8')).toBe('replacement office source')
  })

  it.each([
    ['input-too-large', 413, 'preview-too-large'], ['output-too-large', 413, 'preview-too-large'],
    ['invalid-document', 422, 'preview-invalid'], ['unsupported-format', 422, 'preview-invalid'],
    ['source-changed', 409, 'preview-stale'], ['unavailable', 503, 'preview-unavailable'],
    ['busy', 503, 'preview-busy'], ['timeout', 500, 'preview-failed'],
  ])('contains converter %s failures without returning engine diagnostics', async (code, status, expected) => {
    const f = await boot()
    const path = join(f.output, 'report.docx')
    await writeFile(path, 'office source')
    provideConverter(f.ctx, () => Promise.reject(Object.assign(new Error('/private/engine-secret'), { name: 'OfficeToPdfError', code })))
    const result = await f.request('preview?' + new URLSearchParams({ path }).toString())
    expect(result.status).toBe(status)
    expect(await result.json()).toEqual({ code: expected })
  })

  it('aborts the converter when its browser request disconnects', async () => {
    const f = await boot()
    const path = join(f.output, 'report.docx')
    await writeFile(path, 'office source')
    const admitted = Promise.withResolvers<AbortSignal>()
    provideConverter(f.ctx, (_request, upstream) => {
      admitted.resolve(upstream)
      return new Promise((_resolve, reject) => {
        upstream.addEventListener('abort', () => { reject(new Error('Converter cancelled', { cause: upstream.reason })) }, { once: true })
      })
    })
    const browser = new AbortController()
    const pending = f.request('preview?' + new URLSearchParams({ path }).toString(), undefined, { signal: browser.signal })
    const upstream = await admitted.promise
    browser.abort()
    await expect(pending).rejects.toThrow()
    await vi.waitFor(() => { expect(upstream.aborted).toBe(true) })
    expect(await readFile(path, 'utf8')).toBe('office source')
  })

  it('keeps Office conversion within the selected live workspace and rechecks it before returning', async () => {
    const f = await boot(undefined, { workspaces: true })
    const root = join(f.directory, 'project')
    const other = join(f.directory, 'other-project')
    await mkdir(root)
    await mkdir(other)
    const workspace = await f.ctx.workspaceRegistry.create(root)
    const otherWorkspace = await f.ctx.workspaceRegistry.create(other)
    const path = join(root, 'report.docx')
    await writeFile(path, 'office source')
    const admitted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const convert = provideConverter(f.ctx, async (request, upstream) => {
      await request.source.read(upstream, 100)
      admitted.resolve(undefined)
      await release.promise
      return converted()
    })
    const query = 'preview?' + new URLSearchParams({ workspaceId: String(workspace.id), path }).toString()
    expect((await f.request('preview?' + new URLSearchParams({ path }).toString())).status).toBe(403)
    expect((await f.request('preview?' + new URLSearchParams({ workspaceId: String(otherWorkspace.id), path }).toString())).status).toBe(403)
    const outside = join(other, 'secret.docx')
    await writeFile(outside, 'secret')
    await symlink(outside, join(root, 'link.docx'))
    expect((await f.request('preview?' + new URLSearchParams({ workspaceId: String(workspace.id), path: join(root, 'link.docx') }).toString())).status).toBe(403)
    expect(convert).not.toHaveBeenCalled()
    const pending = f.request(query)
    await admitted.promise
    await f.ctx.workspaceRegistry.delete(workspace.id)
    release.resolve(undefined)
    const result = await pending
    expect(result.status).toBe(404)
    expect(await result.json()).toEqual({ code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' })
    expect(await readFile(path, 'utf8')).toBe('office source')
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
  it('merges saved output and nested shell files across workspaces, preserving usable file-operation coordinates', async () => {
    const f = await boot(undefined, { workspaces: true, maxEntries: 3 })
    const root = join(f.directory, '项目 空间')
    const nested = join(root, '草稿', '版本二')
    const media = join(root, 'media')
    await mkdir(nested, { recursive: true })
    await mkdir(media)
    const workspace = await f.ctx.workspaceRegistry.create(root)
    const second = await f.ctx.workspaceRegistry.create(f.custom)
    await f.json('storage', { directory: media, expectedRevision: 0 })
    const managed = join(media, '聊天生成图.png')
    const independent = join(nested, '脚本生成文档.md')
    const other = join(f.custom, '另一个工作区.txt')
    await writeFile(managed, 'generated image')
    await writeFile(independent, 'shell output without Session history or Git')
    await writeFile(other, 'other workspace output')
    const page = await f.json('list')
    expect(page.truncated).toBe(false)
    expect(page.issues).toBeUndefined()
    if (!Array.isArray(page.items)) throw new Error('Missing unified artifact list')
    expect(page.items).toHaveLength(3)
    const saved = page.items.map(object).find(value => value.path === managed)
    expect(saved).toMatchObject({ name: '聊天生成图.png' })
    expect(saved?.workspaceId).toBeUndefined()
    const shell = page.items.map(object).find(value => value.path === independent)
    expect(shell).toMatchObject({ workspaceId: workspace.id, name: '脚本生成文档.md' })
    expect(page.items).toContainEqual(expect.objectContaining({ path: other, workspaceId: second.id }))
    if (shell === undefined || typeof shell.path !== 'string' || typeof shell.workspaceId !== 'string') throw new Error('Missing file coordinates')
    const coordinates = { workspaceId: shell.workspaceId, path: shell.path }
    expect(await (await f.request('raw?' + new URLSearchParams(coordinates).toString())).text()).toBe('shell output without Session history or Git')
    const changed = await f.json('rename', { ...coordinates, name: '重命名 文档.md', expected: await f.version(shell.path) })
    const changedPath = join(nested, '重命名 文档.md')
    expect(changed.item).toMatchObject({ path: changedPath, workspaceId: shell.workspaceId })
    const removed = await f.json('trash', { workspaceId: shell.workspaceId, path: changedPath, expected: await f.version(changedPath) })
    expect((await f.json('list')).items).toHaveLength(2)
    await f.json('restore', { id: removed.trashId })
    expect((await f.json('list')).items).toHaveLength(3)
    expect((await f.json('storage')).roots).toEqual([f.output, media])
  })

  it('reflects registry removal and restart without retaining workspace directories as output roots', async () => {
    const f = await boot(undefined, { workspaces: true })
    await writeFile(join(f.custom, 'generated.txt'), 'persisted file')
    const workspace = await f.ctx.workspaceRegistry.create(f.custom)
    expect((await f.json('list')).items).toEqual([expect.objectContaining({ workspaceId: workspace.id })])
    await f.ctx.fiber.dispose()
    fixtures.splice(fixtures.findIndex(value => value.ctx === f.ctx), 1)
    const restarted = await boot(f.directory, { workspaces: true })
    expect((await restarted.json('list')).items).toEqual([expect.objectContaining({ workspaceId: workspace.id })])
    await restarted.ctx.workspaceRegistry.delete(workspace.id)
    expect((await restarted.json('list')).items).toEqual([])
    expect((await restarted.json('storage')).roots).toEqual([f.output])
    expect(await (await restarted.request('raw?' + new URLSearchParams({ workspaceId: workspace.id, path: join(f.custom, 'generated.txt') }).toString())).json())
      .toEqual({ code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' })
  })

  it('requires authentication before adding workspace files to a roots-only deployment', async () => {
    const noConnection = await boot(undefined, { workspaces: true, rootsOnly: true, connection: false })
    await writeFile(join(noConnection.custom, 'private.txt'), 'do not expose')
    await noConnection.ctx.workspaceRegistry.create(noConnection.custom)
    expect(await noConnection.json('list')).toEqual({ code: 'ARTIFACT_AUTH_REQUIRED' })
    expect((await noConnection.request('list', undefined, { noOrigin: true })).status).toBe(403)
    const authenticated = await boot(undefined, { workspaces: true, rootsOnly: true })
    await writeFile(join(authenticated.custom, 'generated.txt'), 'authenticated output')
    const workspace = await authenticated.ctx.workspaceRegistry.create(authenticated.custom)
    expect((await authenticated.request('list', undefined, { authenticated: false })).status).toBe(401)
    expect((await authenticated.json('list')).items).toEqual([expect.objectContaining({ workspaceId: workspace.id })])
  })

  it('returns available files alongside safe issues for offline and unsupported mounts', async () => {
    const f = await boot(undefined, { workspaces: true })
    const missing = join(f.directory, 'missing')
    const remote = join(f.directory, 'remote')
    await mkdir(missing)
    await mkdir(remote)
    const offline = await f.ctx.workspaceRegistry.create(missing)
    const unsupported = await f.ctx.workspaceRegistry.create(remote)
    const healthy = await f.ctx.workspaceRegistry.create(f.custom)
    await writeFile(join(f.output, 'saved.png'), 'saved image')
    await writeFile(join(f.custom, 'visible.txt'), 'healthy workspace')
    await rename(missing, join(f.directory, 'offline-copy'))
    const original = f.ctx.fs.processPathFromHostPath.bind(f.ctx.fs)
    const mapping = vi.spyOn(f.ctx.fs, 'processPathFromHostPath').mockImplementation(path => path === remote ? undefined : original(path))
    try {
      const page = await f.json('list')
      expect(page.issues).toEqual(expect.arrayContaining([
        { workspaceId: offline.id, title: offline.title, code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' },
        { workspaceId: unsupported.id, title: unsupported.title, code: 'ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED' },
      ]))
      expect(page.issues).toHaveLength(2)
      expect(page.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: join(f.output, 'saved.png') }),
        expect.objectContaining({ path: join(f.custom, 'visible.txt'), workspaceId: healthy.id }),
      ]))
      expect(JSON.stringify(page.issues)).not.toContain(f.directory)
    } finally { mapping.mockRestore() }
  })

  it('drops a workspace removed during filesystem validation and omits unexpected exception details', async () => {
    const f = await boot(undefined, { workspaces: true })
    const workspace = await f.ctx.workspaceRegistry.create(f.custom)
    await writeFile(join(f.custom, 'generated.txt'), 'must follow live registration')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = f.ctx.fs.resolve.bind(f.ctx.fs)
    const mapping = vi.spyOn(f.ctx.fs, 'resolve').mockImplementationOnce(async (path, options) => {
      entered.resolve(undefined)
      await release.promise
      return original(path, options)
    })
    try {
      const pending = f.json('list')
      await entered.promise
      await f.ctx.workspaceRegistry.delete(workspace.id)
      release.resolve(undefined)
      expect(await pending).toMatchObject({
        items: [], issues: [{ workspaceId: workspace.id, title: workspace.title, code: 'ARTIFACT_WORKSPACE_UNAVAILABLE' }],
      })
      const current = await f.ctx.workspaceRegistry.create(f.custom)
      mapping.mockRejectedValueOnce(new Error('Private mount error at ' + f.custom))
      const failed = await f.json('list')
      expect(failed.issues).toEqual([{ workspaceId: current.id, title: current.title, code: 'ARTIFACT_OPERATION_FAILED' }])
      expect(JSON.stringify(failed.issues)).not.toContain(f.custom)
    } finally {
      release.resolve(undefined)
      mapping.mockRestore()
    }
  })

  it('reports depth and file limits, considering later sources before choosing the newest retained entries', async () => {
    const f = await boot(undefined, { workspaces: true, maxDepth: 1, maxEntries: 2 })
    const root = join(f.directory, 'project')
    await mkdir(join(root, 'level-one', 'level-two'), { recursive: true })
    await f.ctx.workspaceRegistry.create(root)
    const deep = join(root, 'level-one', 'level-two', 'too-deep.txt')
    const included = join(root, 'level-one', 'newest.txt')
    await writeFile(deep, 'visible only at greater configured depth')
    await writeFile(included, 'recent workspace output')
    const old = join(f.output, 'old.txt')
    await writeFile(old, 'old output')
    await utimes(old, new Date(1000), new Date(1000))
    const depthPage = await f.json('list')
    expect(depthPage.truncated).toBe(true)
    expect(depthPage.items).toEqual([
      expect.objectContaining({ path: included }), expect.objectContaining({ path: old }),
    ])
    await writeFile(join(f.output, 'second.txt'), 'second managed file')
    await writeFile(join(f.output, 'third.txt'), 'third managed file')
    await utimes(included, new Date(9_000_000_000_000), new Date(9_000_000_000_000))
    const capped = await f.json('list')
    expect(capped.truncated).toBe(true)
    expect(capped.items).toHaveLength(2)
    expect(capped.items).toEqual(expect.arrayContaining([expect.objectContaining({ path: included })]))
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports unreadable workspace folders without hiding readable sibling output', async () => {
    const f = await boot(undefined, { workspaces: true })
    const root = join(f.directory, 'project')
    const denied = join(root, 'unreadable')
    await mkdir(denied, { recursive: true })
    await writeFile(join(denied, 'private.txt'), 'inaccessible file')
    await writeFile(join(root, 'visible.txt'), 'visible output')
    const workspace = await f.ctx.workspaceRegistry.create(root)
    await chmod(denied, 0)
    try {
      const page = await f.json('list')
      expect(page.items).toEqual([expect.objectContaining({ path: join(root, 'visible.txt'), workspaceId: workspace.id })])
      expect(page.issues).toEqual([{ workspaceId: workspace.id, title: workspace.title, code: 'ARTIFACT_PERMISSION_DENIED' }])
    } finally { await chmod(denied, 0o700) }
  })

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
    const library = await f.json('list')
    expect(library.truncated).toBe(false)
    expect(library.issues).toBeUndefined()
    expect(library.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspaceId: second.id, path: join(beta, 'other.png') }),
      expect.objectContaining({ workspaceId: first.id, path: join(alpha, 'drafts', 'nested.md') }),
      expect.objectContaining({ workspaceId: first.id, path: join(alpha, 'outside-tool.txt') }),
    ]))
    expect(library.items).toHaveLength(3)
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
    const restored = object((await restarted.json('restore', { id: removed.trashId })).item)
    expect(restored).toMatchObject({ path: renamedPath, workspaceId: next.id })
    if (typeof restored.path !== 'string' || typeof restored.workspaceId !== 'string') throw new Error('Missing restored coordinates')
    const restoredRead = await restarted.request('raw?' + new URLSearchParams({ path: restored.path, workspaceId: restored.workspaceId }).toString())
    expect(restoredRead.status).toBe(200)
    expect(await restoredRead.text()).toBe('original deliverable')
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
    const library = await f.json('list')
    if (!Array.isArray(library.items)) throw new Error('Missing unified artifact list')
    const libraryPaths = library.items.map(value => object(value).path)
    for (const path of paths) expect(libraryPaths).not.toContain(path)
    expect(libraryPaths).not.toContain(join(root, 'escape', 'secret.txt'))
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

  it.each([
    ['disconnect', 'workspace'], ['dispose', 'workspace'], ['disconnect', 'list'], ['dispose', 'list'],
  ] as const)('cancels a pending Workspace read on %s from %s without retaining its request', async (kind, route) => {
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
    const request = f.request(route === 'list' ? 'list' : 'workspace?' + new URLSearchParams({ workspaceId: workspace.id }).toString(), undefined, { signal: abort.signal })
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
