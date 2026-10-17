/** Main-owned staging and post-quit handoff for ad-hoc signed macOS app updates. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { gt, valid } from 'semver'
import { unsignedMacInstallHelper } from './unsigned-mac-install-helper.ts'

const execute = promisify(execFile)
const statuses = ['prepared', 'ready', 'cancelled', 'replacing', 'launching', 'succeeded', 'rolled-back', 'rollback-launch-failed',
  'rollback-failed', 'parent-did-not-exit', 'install-target-changed', 'staged-app-invalid', 'backup-failed', 'launch-unconfirmed',
  'target-in-use', 'target-in-use-check-failed'] as const

/** Durable outcome of the installer, including its retained previous app for recovery. */
export interface UnsignedMacInstallReceipt {
  status: typeof statuses[number]
  version: string
  previousVersion: string
  logPath: string
  backupPath: string
}

/** Main-owned download and installed application identity; never accept these paths from renderer IPC. */
export interface UnsignedMacInstallRequest {
  dmgPath: string
  sha512: string
  version: string
  currentVersion: string
  executablePath: string
  architecture: string
  stateDirectory: string
  signal?: AbortSignal
}

/** Prepared files are complete before task shutdown; launch only after the shared restart guard succeeds. */
export interface PreparedUnsignedMacInstall {
  /** Starts an independent helper and resolves only after it durably waits for this exact process to exit. */
  launch(): Promise<void>
  /** Removes only this unlaunched operation's temporary files; never removes an installed or previous app. */
  dispose(): Promise<void>
}

interface InstallRecord {
  schema: 1
  operationId: string
  target: string
  stageDirectory: string
  version: string
  previousVersion: string
}

async function regularDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('desktop update: expected a real application directory')
}

async function installedApp(executablePath: string): Promise<string> {
  const executable = await realpath(executablePath)
  const macos = dirname(executable)
  const contents = dirname(macos)
  const app = dirname(contents)
  if (basename(macos) !== 'MacOS' || basename(contents) !== 'Contents' || !app.endsWith('.app')) {
    throw new Error('desktop update: automatic installation requires a writable installed application')
  }
  await regularDirectory(app)
  await access(app, constants.W_OK)
  await access(dirname(app), constants.W_OK)
  return app
}

async function plistValue(app: string, key: string): Promise<string> {
  const { stdout } = await execute('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Contents/Info.plist')], { timeout: 10_000 })
  const value = stdout.trim()
  if (value === '' || /[\r\n\0]/u.test(value)) throw new Error('desktop update: application metadata is invalid')
  return value
}

async function appMetadata(app: string): Promise<{ id: string; executable: string; name: string; version: string }> {
  const [id, executable, name, version] = await Promise.all(['CFBundleIdentifier', 'CFBundleExecutable', 'CFBundleName', 'CFBundleShortVersionString']
    .map(key => plistValue(app, key)))
  if (id === undefined || executable === undefined || name === undefined || version === undefined
    || basename(executable) !== executable || executable === '.' || executable === '..') throw new Error('desktop update: application identity is invalid')
  if (await plistValue(app, 'CFBundlePackageType') !== 'APPL') throw new Error('desktop update: replacement must be an application bundle')
  return { id, executable, name, version }
}

async function verifyApp(app: string, executable: string, architecture: string): Promise<void> {
  const binary = join(app, 'Contents/MacOS', executable)
  await verifyBinary(binary, architecture)
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 120_000 })
}

async function verifyBinary(binary: string, architecture: string): Promise<void> {
  const stat = await lstat(binary)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('desktop update: application executable is invalid')
  const { stdout } = await execute('/usr/bin/lipo', ['-archs', binary], { timeout: 10_000 })
  const expected = architecture === 'x64' ? 'x86_64' : architecture === 'arm64' ? 'arm64' : undefined
  if (expected === undefined || !stdout.trim().split(/\s+/u).includes(expected)) throw new Error('desktop update: application architecture does not match this device')
  await execute('/usr/bin/codesign', ['--verify', '--strict', binary], { timeout: 120_000 })
  const signature = await execute('/usr/bin/codesign', ['-d', '--verbose=2', binary], { timeout: 10_000 })
  if (!signature.stderr.split('\n').includes('Signature=adhoc')) throw new Error('desktop update: unsigned release must have an intact ad-hoc signature')
}

async function verifyDmg(path: string, digest: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(digest)) throw new Error('desktop update: invalid installer checksum')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error('desktop update: installer is not a regular file')
    const hash = createHash('sha512')
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted()
      hash.update(chunk as Buffer)
    }
    const after = await lstat(path)
    if (hash.digest('base64') !== digest || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('desktop update: installer changed before staging')
  } finally { await file.close() }
}

async function identity(path: string): Promise<string> {
  const { stdout } = await execute('/usr/bin/stat', ['-f', '%d:%i', path], { timeout: 10_000 })
  return stdout.trim()
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}

async function exitedWithin(completion: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([completion.then(() => true), new Promise<boolean>((resolve) => {
      timer = setTimeout(() => { resolve(false) }, milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

async function stopUnlaunchedHelper(child: ChildProcess, completion: Promise<void>): Promise<void> {
  if (await exitedWithin(completion, 3_000)) return
  child.kill('SIGTERM')
  if (!await exitedWithin(completion, 3_000)) throw new Error('desktop update: installer helper did not stop; its files and handoff lock were retained')
}

async function pendingOperation(stateDirectory: string): Promise<string | undefined> {
  const pointer = await readFile(join(stateDirectory, 'pending.json'), 'utf8').catch((cause: unknown) => {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return undefined
    throw cause
  })
  if (pointer === undefined) return undefined
  const value: unknown = JSON.parse(pointer)
  if (typeof value !== 'object' || value === null || !('operationId' in value) || typeof value.operationId !== 'string'
    || !/^install-[A-Za-z0-9]+$/u.test(value.operationId)) throw new Error('desktop update: invalid installation receipt pointer')
  return value.operationId
}

async function releaseHandoff(stateDirectory: string, operationId: string): Promise<void> {
  const lock = join(stateDirectory, 'handoff.lock')
  const owner = await readFile(join(lock, 'operation'), 'utf8').catch((cause: unknown) => {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return undefined
    throw cause
  })
  if (owner === operationId) await rm(lock, { recursive: true })
}

async function assertNoPendingHandoff(stateDirectory: string): Promise<void> {
  const operationId = await pendingOperation(stateDirectory)
  if (operationId !== undefined) {
    const operation = join(stateDirectory, operationId)
    const status = (await readFile(join(operation, 'status'), 'utf8')).trim()
    const record = parseRecord(JSON.parse(await readFile(join(operation, 'record.json'), 'utf8')), operationId)
    const acknowledged = await readFile(join(operation, 'acknowledged'), 'utf8').catch((cause: unknown) => {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return undefined
      throw cause
    })
    const safe = ['succeeded', 'rolled-back', 'cancelled', 'parent-did-not-exit', 'install-target-changed', 'staged-app-invalid',
      'backup-failed', 'target-in-use', 'target-in-use-check-failed']
    if (!safe.includes(status) && acknowledged?.trim() !== record.version) {
      throw new Error('desktop update: an earlier installation has an unresolved outcome; check its retained log before retrying')
    }
    await releaseHandoff(stateDirectory, operationId)
  }
  const active = await lstat(join(stateDirectory, 'handoff.lock')).catch((cause: unknown) => {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return undefined
    throw cause
  })
  if (active !== undefined) throw new Error('desktop update: another installation already owns the update handoff')
}

/**
 * Mount a verified DMG read-only, validate its one matching app and stage a complete same-volume replacement.
 * Preparation failures leave the installed app and running Host untouched. The helper never downloads or elevates privileges.
 * @param request - Main-owned release, paths and current process identity.
 * @returns An unlaunched operation, owned by the caller until handoff or disposal.
 */
export async function prepareUnsignedMacInstall(request: UnsignedMacInstallRequest): Promise<PreparedUnsignedMacInstall> {
  request.signal?.throwIfAborted()
  if (process.platform !== 'darwin') throw new Error('desktop update: unsigned Mac installation is available only on macOS')
  if (!isAbsolute(request.stateDirectory) || !isAbsolute(request.dmgPath)) throw new Error('desktop update: installer paths must be absolute')
  const target = await installedApp(request.executablePath)
  const targetIdentity = await identity(target)
  const current = await appMetadata(target)
  if (basename(request.executablePath) !== current.executable) throw new Error('desktop update: installed executable does not match its app metadata')
  if (current.version !== request.currentVersion || valid(request.version) === null || valid(current.version) === null
    || !gt(request.version, current.version)) {
    throw new Error('desktop update: replacement must be newer than the installed application')
  }
  await verifyDmg(request.dmgPath, request.sha512, request.signal)
  await mkdir(request.stateDirectory, { recursive: true, mode: 0o700 })
  await regularDirectory(request.stateDirectory)
  await chmod(request.stateDirectory, 0o700)
  await assertNoPendingHandoff(request.stateDirectory)
  const operation = await mkdtemp(join(request.stateDirectory, 'install-'))
  const stageDirectory = await mkdtemp(join(dirname(target), `.${basename(target)}.update-`))
  await chmod(stageDirectory, 0o700)
  const next = join(stageDirectory, 'previous.app')
  const backup = join(stageDirectory, 'previous.app')
  const mount = join(operation, 'volume')
  await mkdir(mount, { mode: 0o700 })
  let mounted = false
  let launched = false
  let helperStarted = false
  let helperChild: ChildProcess | undefined
  let helperCompletion: Promise<void> | undefined
  let launchStarted = false
  const lifecycle = { disposed: false }
  const isDisposed = (): boolean => lifecycle.disposed
  let disposal: Promise<void> | undefined
  try {
    await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, request.dmgPath], { timeout: 120_000 })
    mounted = true
    const apps = (await readdir(mount, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
    const entry = apps[0]
    if (apps.length !== 1 || entry === undefined || entry.name !== basename(target)) throw new Error('desktop update: installer must contain exactly the matching application')
    const source = join(mount, entry.name)
    const incoming = await appMetadata(source)
    if (incoming.id !== current.id || incoming.executable !== current.executable || incoming.name !== current.name
      || incoming.version !== request.version) {
      throw new Error('desktop update: replacement application identity or version differs from the approved release')
    }
    await verifyApp(source, incoming.executable, request.architecture)
    request.signal?.throwIfAborted()
    const copying = execute('/usr/bin/ditto', ['--rsrc', '--extattr', source, next], { timeout: 600_000,
      ...(request.signal === undefined ? {} : { signal: request.signal }) })
    const copyClosed = new Promise<void>((resolve) => { copying.child.once('close', () => { resolve() }) })
    try { await copying }
    finally { await copyClosed }
    request.signal?.throwIfAborted()
    await verifyApp(next, incoming.executable, request.architecture)
    await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 })
    mounted = false
    const record: InstallRecord = { schema: 1, operationId: basename(operation), target, stageDirectory,
      version: request.version, previousVersion: current.version }
    await writeFile(join(operation, 'record.json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    await writeFile(join(operation, 'status'), 'prepared\n', { mode: 0o600, flag: 'wx' })
    const swap = join(target, 'Contents/Resources/unsigned-mac-swap')
    await verifyBinary(swap, request.architecture)
    const privateSwap = join(operation, 'unsigned-mac-swap')
    await copyFile(swap, privateSwap, constants.COPYFILE_EXCL)
    await chmod(privateSwap, 0o700)
    await verifyBinary(privateSwap, request.architecture)
    const helper = join(operation, 'install.sh')
    await writeFile(helper, unsignedMacInstallHelper, { mode: 0o700, flag: 'wx' })
    return {
      async launch() {
        if (launchStarted || isDisposed()) throw new Error('desktop update: installation was already handed off or disposed')
        launchStarted = true
        if (await identity(target) !== targetIdentity || (await appMetadata(target)).version !== current.version) {
          throw new Error('desktop update: installed application changed after preparation')
        }
        await verifyApp(next, incoming.executable, request.architecture)
        if (isDisposed()) throw new Error('desktop update: prepared installation was disposed')
        const parentStart = (await execute('/bin/ps', ['-p', `${process.pid}`, '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 10_000 })).stdout.trimEnd()
        const args = [helper, target, next, backup, `${process.pid}`, parentStart, targetIdentity, await identity(next), operation, current.version, current.executable]
        await assertNoPendingHandoff(request.stateDirectory)
        await mkdir(join(request.stateDirectory, 'handoff.lock'), { mode: 0o700 })
        await writeFile(join(request.stateDirectory, 'handoff.lock/operation'), record.operationId, { mode: 0o600, flag: 'wx' })
        await atomicWrite(join(request.stateDirectory, 'pending.json'), JSON.stringify({ operationId: record.operationId }))
        const log = await open(join(operation, 'install.log'), 'a', 0o600)
        const child = spawn('/bin/sh', args, { detached: true, stdio: ['ignore', log.fd, log.fd], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } })
        helperStarted = true
        helperChild = child
        helperCompletion = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
        const childState: { failure?: Error; exited: boolean } = { exited: false }
        child.once('error', (error) => { childState.failure = error })
        child.once('exit', () => { childState.exited = true })
        await log.close()
        for (let attempt = 0; attempt < 100; attempt++) {
          if (childState.failure !== undefined) throw childState.failure
          const status = (await readFile(join(operation, 'status'), 'utf8')).trim()
          if (status === 'ready') {
            if (isDisposed()) throw new Error('desktop update: prepared installation was disposed')
            await writeFile(join(operation, 'authorized'), 'authorized\n', { mode: 0o600, flag: 'wx' })
            if (isDisposed()) throw new Error('desktop update: prepared installation was disposed')
            launched = true
            child.unref()
            return
          }
          if (childState.exited) throw new Error(`desktop update: installer helper exited before readiness (${status})`)
          await delay(50)
        }
        throw new Error('desktop update: installer helper did not acknowledge readiness')
      },
      async dispose() {
        if (launched) return
        lifecycle.disposed = true
        disposal ??= (async () => {
          if (helperStarted) await writeFile(join(operation, 'cancelled'), 'cancelled\n', { mode: 0o600 })
          if (helperChild !== undefined && helperCompletion !== undefined) await stopUnlaunchedHelper(helperChild, helperCompletion)
          await releaseHandoff(request.stateDirectory, record.operationId)
          if (await pendingOperation(request.stateDirectory) === record.operationId) await rm(join(request.stateDirectory, 'pending.json'))
          await rm(stageDirectory, { recursive: true, force: true })
          if (!helperStarted) await rm(operation, { recursive: true, force: true })
        })()
        await disposal
      },
    }
  } catch (cause) {
    if (mounted) {
      try { await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 }) }
      catch (detachFailure) { throw new AggregateError([cause, detachFailure], 'desktop update: staging failed and the read-only installer could not be detached') }
    }
    await rm(stageDirectory, { recursive: true, force: true })
    await rm(operation, { recursive: true, force: true })
    throw cause
  }
}

function parseRecord(value: unknown, operationId: string): InstallRecord {
  if (typeof value !== 'object' || value === null || !('schema' in value) || value.schema !== 1
    || !('operationId' in value) || value.operationId !== operationId || !('target' in value) || typeof value.target !== 'string' || !isAbsolute(value.target)
    || !('stageDirectory' in value) || typeof value.stageDirectory !== 'string' || !isAbsolute(value.stageDirectory)
    || dirname(value.stageDirectory) !== dirname(value.target) || !basename(value.stageDirectory).startsWith(`.${basename(value.target)}.update-`)
    || !('version' in value) || typeof value.version !== 'string' || valid(value.version) === null
    || !('previousVersion' in value) || typeof value.previousVersion !== 'string' || valid(value.previousVersion) === null) throw new Error('desktop update: invalid retained installation record')
  return { schema: 1, operationId, target: value.target, stageDirectory: value.stageDirectory,
    version: value.version, previousVersion: value.previousVersion }
}

/**
 * Read the last helper result and acknowledge startup only for the exact newly installed app/version.
 * Previous bundles stay in the reported backup directory; failed or unconfirmed installation remains visible for recovery.
 * @param request - Main-owned state directory and this running app's identity.
 * @returns The durable outcome, or undefined when this user has never handed off an unsigned update.
 */
export async function acknowledgeUnsignedMacInstall(
  request: { stateDirectory: string; executablePath: string; version: string },
): Promise<UnsignedMacInstallReceipt | undefined> {
  const operationId = await pendingOperation(request.stateDirectory)
  if (operationId === undefined) return undefined
  const operation = join(request.stateDirectory, operationId)
  await regularDirectory(operation)
  const record = parseRecord(JSON.parse(await readFile(join(operation, 'record.json'), 'utf8')), operationId)
  const raw = (await readFile(join(operation, 'status'), 'utf8')).trim()
  const status = statuses.find(status => status === raw)
  if (status === undefined) throw new Error('desktop update: invalid installer status')
  if (request.version === record.version && await installedApp(request.executablePath) === resolve(record.target)
    && (await appMetadata(record.target)).version === record.version
    && (status === 'replacing' || status === 'launching' || status === 'launch-unconfirmed' || status === 'succeeded')) {
    await writeFile(join(operation, 'acknowledged'), `${request.version}\n`, { mode: 0o600, flag: 'w' })
    await atomicWrite(join(operation, 'status'), 'succeeded\n')
    await releaseHandoff(request.stateDirectory, record.operationId)
    return { status: 'succeeded', version: record.version, previousVersion: record.previousVersion,
      logPath: join(operation, 'install.log'), backupPath: join(record.stageDirectory, 'previous.app') }
  }
  return { status, version: record.version, previousVersion: record.previousVersion,
    logPath: join(operation, 'install.log'), backupPath: join(record.stageDirectory, 'previous.app') }
}
