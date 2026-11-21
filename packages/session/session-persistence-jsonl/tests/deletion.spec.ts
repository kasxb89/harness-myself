/** Permanent deletion exercises real files, ownership leases, and restart reads. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyOwnedError, SessionDeletionCwdConflictError, SessionHandleClosedError,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '../src/index.ts'
import { generationLogPath, logPath, sessionDir } from '../src/format.ts'
import { SessionWriteLease } from '../src/lease.ts'

const refusal = vi.hoisted(() => ({ path: '' }))
const namespace = vi.hoisted(() => ({ operations: [] as string[] }))
vi.mock('../src/win32.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/win32.ts')>()
  const fs = await import('node:fs/promises')
  return { ...actual, publishNewFileWin32: async (source: string, target: string) => {
    namespace.operations.push(`retire:${source}`)
    await fs.rename(source, target)
  } }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: (async (...args: Parameters<typeof actual.rm>) => {
    if (String(args[0]) === refusal.path) throw new Error('synthetic unlink refusal')
    if (String(args[0]).includes('.deleted-')) namespace.operations.push('unlink-retired')
    return actual.rm(...args)
  }) }
})

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  refusal.path = ''
  namespace.operations.length = 0
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function backend(root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  if (root === undefined) roots.push(directory)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' })
  return { ctx, root: directory, persistence: ctx.sessionPersistence }
}

function header(id: string, cwd = '/owned-workspace'): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, cwd, isSeeded: false }
}

async function seed(persistence: Context['sessionPersistence'], metadata: SessionHeader) {
  const writer = await persistence.create(metadata)
  await writer.flush()
  await writer.close()
}

describe('JSONL permanent Session deletion', () => {
  it('removes all log generations across restart, retaining forks, lock inode, and independent files', async () => {
    const { persistence, root } = await backend()
    const metadata = header('../encoded-session')
    await seed(persistence, metadata)
    const fork = { ...header('independent-fork'), parentSession: metadata.id }
    await seed(persistence, fork)
    const path = logPath(root, metadata.cwd, metadata.id, 'none')
    await writeFile(generationLogPath(root, metadata.cwd, metadata.id, 0, 'none'), await readFile(path))
    const retained = join(sessionDir(root, metadata.cwd, metadata.id), 'independent-output.png')
    await writeFile(retained, 'retained-file')
    const reader = await persistence.open(metadata.id, 'read')
    await persistence.delete(metadata.id, { expectedCwd: metadata.cwd! })
    expect(await persistence.stat(metadata.id)).toBeUndefined()
    await expect(persistence.delete(metadata.id, { expectedCwd: metadata.cwd! })).resolves.toBeUndefined()
    await expect(reader.read()).rejects.toBeInstanceOf(SessionHandleClosedError)
    expect(await readFile(retained, 'utf8')).toBe('retained-file')
    expect(await readdir(sessionDir(root, metadata.cwd, metadata.id))).toEqual(expect.arrayContaining(['session.lock', 'independent-output.png']))
    const restarted = await backend(root)
    expect((await restarted.persistence.list()).map(row => row.header.id)).toEqual([fork.id])
    await expect(restarted.persistence.open(metadata.id, 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  })

  it('refuses same-process and foreign-process-equivalent writer leases without deleting bytes', async () => {
    const { persistence, root } = await backend()
    const metadata = header('owned-session')
    const writer = await persistence.create(metadata)
    await writer.flush()
    const path = logPath(root, metadata.cwd, metadata.id, 'none')
    const original = await readFile(path)
    await expect(persistence.delete(metadata.id, { expectedCwd: metadata.cwd! })).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    const foreign = await backend(root)
    await expect(foreign.persistence.delete(metadata.id, { expectedCwd: metadata.cwd! })).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    expect(await readFile(path)).toEqual(original)
    await writer.close()
    await foreign.persistence.delete(metadata.id, { expectedCwd: metadata.cwd! })
    expect(await persistence.stat(metadata.id)).toBeUndefined()
  })

  it('refuses a mismatched workspace and leaves the selected record intact after an I/O failure', async () => {
    const { persistence, root } = await backend()
    const metadata = header('failure-session')
    await seed(persistence, metadata)
    const path = logPath(root, metadata.cwd, metadata.id, 'none')
    const original = await readFile(path)
    await expect(persistence.delete(metadata.id, { expectedCwd: '/other-workspace' })).rejects.toBeInstanceOf(SessionDeletionCwdConflictError)
    expect(await readFile(path)).toEqual(original)
    refusal.path = path
    await expect(persistence.delete(metadata.id, { expectedCwd: metadata.cwd! })).rejects.toThrow('synthetic unlink refusal')
    expect(await readFile(path)).toEqual(original)
    expect(await persistence.stat(metadata.id)).toBeDefined()
    refusal.path = ''
    await persistence.delete(metadata.id, { expectedCwd: metadata.cwd! })
    expect(await persistence.stat(metadata.id)).toBeUndefined()
  })

  it('unlinks an older canonical symlink without deleting its target or reviving its history', async () => {
    const { persistence, root } = await backend()
    const metadata = header('linked-generation')
    await seed(persistence, metadata)
    const path = logPath(root, metadata.cwd, metadata.id, 'none')
    const target = join(root, 'retained-original.json')
    const original = await readFile(path)
    await writeFile(target, original)
    await symlink(target, generationLogPath(root, metadata.cwd, metadata.id, 0, 'none'))
    await persistence.delete(metadata.id, { expectedCwd: metadata.cwd! })
    expect(await readFile(target)).toEqual(original)
    expect(await persistence.stat(metadata.id)).toBeUndefined()
    expect(await persistence.list()).toEqual([])
  })

  it('retires older Windows canonical names before the selected name using write-through publication', async () => {
    const { persistence, root } = await backend()
    const metadata = header('windows-namespace-order')
    await seed(persistence, metadata)
    const current = logPath(root, metadata.cwd, metadata.id, 'none')
    const older = generationLogPath(root, metadata.cwd, metadata.id, 0, 'none')
    await writeFile(older, await readFile(current))
    // Only namespace ordering is emulated here. The lease is a real host
    // lease acquired before switching this test's platform discriminator.
    const lease = await SessionWriteLease.acquire(sessionDir(root, metadata.cwd, metadata.id), metadata.id)
    const acquire = vi.spyOn(SessionWriteLease, 'acquire').mockResolvedValue(lease)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      await persistence.delete(metadata.id, { expectedCwd: metadata.cwd! })
    } finally {
      Object.defineProperty(process, 'platform', platform)
      acquire.mockRestore()
      await lease.release()
    }
    expect(namespace.operations).toEqual([
      `retire:${older}`, 'unlink-retired', `retire:${current}`, 'unlink-retired',
    ])
    expect(await persistence.stat(metadata.id)).toBeUndefined()
    expect(await readdir(sessionDir(root, metadata.cwd, metadata.id))).toEqual(['session.lock'])
  })
})
