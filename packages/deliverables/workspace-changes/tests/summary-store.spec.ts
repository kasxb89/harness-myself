/**
 * Durable summaries: a summary recorded while a Session is observed is stored,
 * and the service keeps serving it after that Session is disposed (and after a
 * Host restart, which the same read path covers). Storage is optional, and every
 * failure on that path is soft.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as WorkspaceChanges from '../src/index.ts'
import { summaryKey, type SummaryRecord } from '../src/spec.ts'
import { openSummaryStore } from '../src/store.ts'
import { changes, endTurn, git, mutate, scratchDir, settle, startTurn } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

/** A stub facility whose open resolves or rejects on demand, over one in-memory table. */
function standIn(options: {
  reject?: Error
  records?: Map<string, SummaryRecord>
  put?: (key: string, value: SummaryRecord) => Promise<void>
} = {}) {
  const records = options.records ?? new Map<string, SummaryRecord>()
  const close = vi.fn(async (): Promise<void> => {})
  const table = {
    get: (key: string) => records.get(key),
    put: options.put ?? (async (key: string, value: SummaryRecord) => { records.set(key, value) }),
  }
  const domain = { table: (name: string) => name === 'summaries' ? table : undefined, close }
  const opened = deferred<typeof domain>()
  const open = vi.fn(() => options.reject === undefined ? opened.promise : Promise.reject(options.reject))
  return { open, opened, domain, close, records }
}

/** A promise with its settle functions, for tests that control when an open resolves. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const summary: SummaryRecord = {
  turn: 1,
  cwd: '/work',
  files: [
    { path: 'a.txt', display: 'a.txt', added: 2, deleted: 1 },
    { path: 'bin.dat', display: 'bin.dat', added: 0, deleted: 0, binary: true },
    { path: 'big.txt', display: 'big.txt', added: 0, deleted: 0, oversized: true },
  ],
  total: 3,
  added: 2,
  deleted: 1,
  snapshot: { before: 'aa', after: 'bb' },
}

describe('the durable summary store', () => {
  it('answers from storage, including the markers and snapshot it stored', async () => {
    const records = new Map([[summaryKey(SessionId('s'), 4), summary]])
    const storage = standIn({ records })
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('storageDomain', storage as never)
    const store = openSummaryStore(ctx)
    storage.opened.resolve(storage.domain)
    await Promise.resolve()

    expect(store.get(SessionId('s'), 4)).toEqual({
      turn: 1, cwd: '/work', total: 3, added: 2, deleted: 1,
      files: [
        { path: 'a.txt', display: 'a.txt', added: 2, deleted: 1 },
        { path: 'bin.dat', display: 'bin.dat', added: 0, deleted: 0, binary: true },
        { path: 'big.txt', display: 'big.txt', added: 0, deleted: 0, oversized: true },
      ],
      snapshot: { before: 'aa', after: 'bb' },
    })
    expect(store.get(SessionId('s'), 5)).toBeUndefined()

    // A record that carries neither a snapshot nor a refusal marker adopts to
    // exactly the summary it stored, with no optional key left behind.
    records.set(summaryKey(SessionId('s'), 6), {
      turn: 2, cwd: '/work', total: 1, added: 3, deleted: 0,
      files: [{ path: 'a.txt', display: 'a.txt', added: 3, deleted: 0 }],
    })
    expect(store.get(SessionId('s'), 6)).toEqual({
      turn: 2, cwd: '/work', total: 1, added: 3, deleted: 0,
      files: [{ path: 'a.txt', display: 'a.txt', added: 3, deleted: 0 }],
    })
  })

  it('stores what it is given, keyed by the Session and the announcing sequence', async () => {
    const storage = standIn()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('storageDomain', storage as never)
    const store = openSummaryStore(ctx)
    storage.opened.resolve(storage.domain)
    // The domain is adopted in a promise callback; one macrotask flushes it.
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    store.put(SessionId('s'), 7, { turn: 2, cwd: '/work', files: [], total: 0, added: 0, deleted: 0 })
    await vi.waitFor(() => { expect(storage.records.get(summaryKey(SessionId('s'), 7))?.turn).toBe(2) })
  })

  it('keeps working in memory when the composition mounts no storage', () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const store = openSummaryStore(ctx)
    expect(store.get(SessionId('s'), 1)).toBeUndefined()
    expect(() => { store.put(SessionId('s'), 1, { turn: 1, cwd: '/work', files: [], total: 0, added: 0, deleted: 0 }) }).not.toThrow()
  })

  it('warns and stays in memory when the domain cannot open', async () => {
    const storage = standIn({ reject: new Error('no medium') })
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.provide('storageDomain', storage as never)
    const store = openSummaryStore(ctx)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('no medium')) })
    expect(store.get(SessionId('s'), 1)).toBeUndefined()
    store.put(SessionId('s'), 1, { turn: 1, cwd: '/work', files: [], total: 0, added: 0, deleted: 0 })
  })

  it('closes a domain that arrives after the plugin was disposed, and stores nothing through it', async () => {
    const storage = standIn()
    const ctx = new Context()
    ctx.provide('storageDomain', storage as never)
    const store = openSummaryStore(ctx)
    await ctx.fiber.dispose()

    storage.opened.resolve(storage.domain)
    await vi.waitFor(() => { expect(storage.close).toHaveBeenCalledTimes(1) })
    expect(store.get(SessionId('s'), 1)).toBeUndefined()
  })

  it('warns when a write fails and keeps serving from memory', async () => {
    const storage = standIn({ put: () => Promise.reject(new Error('disk full')) })
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.provide('storageDomain', storage as never)
    const store = openSummaryStore(ctx)
    storage.opened.resolve(storage.domain)
    // The domain is adopted in a promise callback; one macrotask flushes it.
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    store.put(SessionId('s'), 1, { turn: 9, cwd: '/work', files: [], total: 0, added: 0, deleted: 0 })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn 9 was not stored')) })
  })
})

describe('a stored summary outlives its Session', () => {
  it('serves the closing turn’s card after the Session is disposed', async () => {
    const cwd = await scratchDir('dsh-workspace-changes-store-', cleanups)
    git(cwd, 'init', '-q', '-b', 'main')
    await writeFile(join(cwd, 'a.txt'), 'l1\nl2\n')
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', 'init')

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(WorkspaceChanges, {} as WorkspaceChanges.Config)

    const session = ctx.sessions.create(SessionId('stored'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'edit', { file_path: 'a.txt', old_string: 'l2', new_string: 'l2 stored' },
      'a.txt', () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 stored\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    const [recorded] = changes(ctx, session)
    expect(recorded?.turn).toBe(1)
    const announced = session.snapshotEvents().filter(event => event.type === 'workspace/changes').at(-1)
    if (announced === undefined) throw new Error('no announcement')

    ctx.emit('session/disposed', session)

    // The recorder is gone; the stored summary is what still answers.
    expect(ctx.workspaceChanges.summary(session.id, announced.seq)).toEqual(recorded)
    await expect(ctx.workspaceChanges.diff(session.id, announced.seq, 0, new AbortController().signal)).resolves.toBeUndefined()
  })
})
