/** Cross-process preparation ownership without expiring a live installer. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Resolved installation wait limits. */
export interface InstallationLockOptions {
  /** Maximum time waiting for another installer; never its ownership lifetime. */
  readonly lockWaitMs: number
  /** Interval between ownership checks. */
  readonly lockPollMs: number
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

async function lockOwner(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('primary runtime: installation lock must be a real directory')
    return await readFile(join(path, 'owner.json'), 'utf8')
  } catch (error) { if (missing(error)) return undefined; throw error }
}

async function recoverDeadOwner(path: string, owner: string): Promise<void> {
  const value: unknown = JSON.parse(owner)
  if (typeof value !== 'object' || value === null || !('pid' in value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
    throw new Error('primary runtime: invalid installation lock owner; inspection is required')
  }
  try { process.kill(Number(value.pid), 0); return } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
  }
  // Only one reaper may remove this dead owner's directory. A live owner is never timed out.
  try { await writeFile(join(path, 'recover'), JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { flag: 'wx', mode: 0o600 }) } catch (error) {
    if (missing(error)) return
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      let recovery: unknown
      try { recovery = JSON.parse(await readFile(join(path, 'recover'), 'utf8')) } catch (failure) {
        if (missing(failure)) return
        throw new Error('primary runtime: interrupted installation recovery requires inspection', { cause: failure })
      }
      if (typeof recovery !== 'object' || recovery === null || !('pid' in recovery) || !Number.isSafeInteger(recovery.pid) || Number(recovery.pid) <= 0) {
        throw new Error('primary runtime: invalid installation recovery marker; inspection is required')
      }
      try { process.kill(Number(recovery.pid), 0) } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'ESRCH') throw new Error(`primary runtime: interrupted recovery at ${path} requires inspection before retrying`)
      }
      return
    }
    throw error
  }
  if (await lockOwner(path) !== owner) throw new Error('primary runtime: installation lock changed during recovery')
  const retired = `${path}.dead-${randomUUID()}`
  await rename(path, retired)
  await rm(retired, { recursive: true })
}

/**
 * Run one installation under a PID-owned cross-process lock; process death permits recovery.
 * @param root - Logical installation directory, whose sibling holds the lock.
 * @param options - Caller-resolved polling and waiting bounds.
 * @param run - Installation transaction, including rollback and cleanup.
 * @returns The installation result after releasing its own lock.
 */
export async function withInstallationLock<T>(root: string, options: InstallationLockOptions, run: () => Promise<T>): Promise<T> {
  const parent = dirname(root)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const path = `${root}.install-lock`
  const candidate = await mkdtemp(join(parent, '.runtime-install-lock-'))
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() })
  let acquired = false
  const started = performance.now()
  try {
    await writeFile(join(candidate, 'owner.json'), owner, { mode: 0o600, flag: 'wx' })
    while (!acquired) {
      try { await rename(candidate, path); acquired = true } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error
        const prior = await lockOwner(path)
        if (prior !== undefined) await recoverDeadOwner(path, prior)
        if (performance.now() - started >= options.lockWaitMs) throw new Error('primary runtime: another application is preparing dependencies; retry after it finishes')
        await delay(options.lockPollMs)
      }
    }
    return await run()
  } finally {
    if (acquired) {
      if (await lockOwner(path) !== owner) throw new Error('primary runtime: installation ownership changed before release')
      // Rename before recursive cleanup; removing owner.json in place would expose an empty lock directory.
      await rename(path, candidate)
      await rm(candidate, { recursive: true })
    } else await rm(candidate, { recursive: true, force: true })
  }
}
