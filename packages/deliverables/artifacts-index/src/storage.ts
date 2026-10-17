/** Local artifact preferences, exclusive output and durable reversible file operations. @module */
import { Service, type Context } from '@deepseek-ai/cordis'
import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import type { ArtifactDestination, ArtifactPublishRequest, ArtifactStorageInfo, ArtifactStorageService, ArtifactWriteRequest } from './types.ts'
import type { ArtifactWorkspaceScope, WorkspaceAccess } from './workspace.ts'

/** Safe business failure exposed by the artifact HTTP owner. */
export class ArtifactError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = 'ArtifactError' }
}
/**
 * Check that an absolute path never depends on the current working drive.
 * @param path - Candidate filesystem path, with control characters forbidden.
 * @param platform - Platform whose absolute path rules apply; defaults to the running Host.
 * @returns Whether the path is fully qualified and excludes Windows alternate streams and device prefixes.
 */
export function qualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return !/[\u0000-\u001f]/u.test(path) && (platform === 'win32'
    ? win32.isAbsolute(path) && !path.replace(/^[A-Za-z]:/u, '').includes(':')
      && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/.?][^\\/]*[\\/]+[^\\/]+)/u.test(path)
    : isAbsolute(path))
}
/**
 * Check a visible portable file name, excluding traversal, Windows devices and alternate streams.
 * @param name - One file name without directory components or a leading dot.
 * @returns Whether the name fits the byte limit and is safe on the supported desktop platforms.
 */
export function validName(name: string): boolean {
  return name.length > 0 && !name.startsWith('.') && Buffer.byteLength(name) <= 255 && !/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(name)
    && !/[. ]$/u.test(name) && name !== '.' && name !== '..' && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
}
/**
 * Compare canonical paths using the current platform's case and drive rules.
 * @param root - Canonical absolute directory that defines the allowed boundary.
 * @param target - Canonical absolute path to test against that boundary.
 * @returns Whether the target equals the root or is one of its descendants.
 */
export function contained(root: string, target: string): boolean {
  const part = relative(root, target)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep))
}
/** One listed version which a mutation must still match. */
export interface ExpectedArtifact { readonly size: number; readonly mtimeMs: number }
interface Preferences {
  version: 1
  directory: string
  revision: number
  roots: string[]
}
interface TrashRecord {
  version: 1
  id: string
  name: string
  originalPath: string
  storedPath: string
  deletedAt: string
  workspaceRoot?: string
}
type FileInfo = Awaited<ReturnType<typeof lstat>>
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function sameFile(left: FileInfo, right: FileInfo): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}
/**
 * Resolve a regular file whose final component is not a link and whose canonical path remains authorized.
 * @param path - Fully qualified file path requested by a trusted caller or authenticated route.
 * @param roots - Retained canonical root boundaries; callers must not replace these with newly resolved symlink targets.
 * @returns The authorized canonical path and the selected file's metadata, or rejects for a missing or unauthorized file.
 */
export async function authorizedFile(path: string, roots: readonly string[]): Promise<{ path: string; info: FileInfo }> {
  if (!qualified(path)) throw new ArtifactError('ARTIFACT_PATH_INVALID', 400, 'Invalid absolute file path')
  const target = resolve(path)
  const canonical = await realpath(target).catch(() => { throw new ArtifactError('ARTIFACT_NOT_FOUND', 404, 'File not found') })
  const info = await lstat(target)
  if (info.isSymbolicLink() || !info.isFile() || !roots.some(root => contained(root, canonical))) {
    throw new ArtifactError('ARTIFACT_PATH_FORBIDDEN', 403, 'File must be a regular file within an artifact root')
  }
  return { path: canonical, info }
}
function expectedVersion(info: FileInfo, expected: ExpectedArtifact): void {
  if (!Number.isSafeInteger(expected.size) || expected.size < 0 || !Number.isFinite(expected.mtimeMs)
    || info.size !== expected.size || info.mtimeMs !== expected.mtimeMs) {
    throw new ArtifactError('ARTIFACT_STALE', 409, 'The file changed; refresh before trying again')
  }
}
async function exclusiveMove(source: string, target: string, before: FileInfo): Promise<void> {
  try { await link(source, target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ArtifactError('ARTIFACT_CONFLICT', 409, 'A file with that name already exists')
    throw new ArtifactError('ARTIFACT_MOVE_UNSUPPORTED', 409, 'This filesystem cannot safely move this file without overwriting')
  }
  try {
    const [current, linked] = await Promise.all([lstat(source), lstat(target)])
    if (!sameFile(before, current) || !sameFile(before, linked)) throw new ArtifactError('ARTIFACT_STALE', 409, 'The file changed during the operation')
    await unlink(source)
  } catch (error) {
    const linked = await lstat(target).catch(() => undefined)
    let cleaned = linked === undefined
    if (linked !== undefined && sameFile(before, linked)) {
      try { await unlink(target); cleaned = true } catch { /* Preserve any uncertain target for explicit inspection. */ }
    }
    if (!cleaned) throw new ArtifactError('ARTIFACT_OPERATION_UNKNOWN', 409, 'Refresh to inspect the partially completed operation')
    if (error instanceof ArtifactError) throw error
    throw new ArtifactError('ARTIFACT_OPERATION_UNKNOWN', 409, 'The operation could not be confirmed; refresh before continuing')
  }
}
async function atomicJson(path: string, value: object): Promise<void> {
  const temporary = join(dirname(path), '.' + randomUUID() + '.json')
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() }
  finally { await handle.close() }
  try { await rename(temporary, path) }
  finally { await unlink(temporary).catch(() => {}) }
}

/** Product-owned output service; account media producers capture one destination before billing. */
export class ArtifactStore extends Service implements ArtifactStorageService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly operations = new Set<Promise<unknown>>()
  private closed = false
  private constructor(
    ctx: Context, readonly defaultDirectory: string, private readonly stateDirectory: string, private prefs: Preferences,
    private readonly workspaces?: WorkspaceAccess,
  ) {
    super(ctx, 'artifactStorage')
    ctx.effect(() => async () => {
      this.closed = true
      // Admitted multi-step file mutations finish before the service leaves.
      await Promise.allSettled([...this.operations])
    }, 'artifactStorage: admitted operations')
  }
  /**
   * Initialize private preferences and the configured default output directory.
   * @param ctx - Host context that owns the registered service and waits for admitted operations during disposal.
   * @param defaultPath - Fully qualified default output directory, created if needed and canonicalized once.
   * @param statePath - Separate fully qualified private directory for preferences and recovery records.
   * @param legacyRoots - Existing configured browsing directories to retain after canonicalization and state-boundary checks.
   * @param workspaces - Optional trusted current-Workspace resolver, kept separate from retained output preferences.
   * @returns The registered storage service with validated persisted preferences, or rejects without exposing private state.
   */
  static async create(
    ctx: Context, defaultPath: string, statePath: string, legacyRoots: readonly string[], workspaces?: WorkspaceAccess,
  ): Promise<ArtifactStore> {
    if (!qualified(defaultPath) || !qualified(statePath)) throw new ArtifactError('ARTIFACT_STORAGE_INVALID', 400, 'Storage directories must be fully qualified')
    await mkdir(defaultPath, { recursive: true })
    await mkdir(statePath, { recursive: true, mode: 0o700 })
    const [directory, stateDirectory] = await Promise.all([realpath(defaultPath), realpath(statePath)])
    if (contained(directory, stateDirectory) || contained(stateDirectory, directory)) throw new ArtifactError('ARTIFACT_STORAGE_INVALID', 400, 'Output and private state must be separate directories')
    await mkdir(join(stateDirectory, 'trash'), { mode: 0o700, recursive: true })
    let prefs: Preferences = { version: 1, directory, revision: 0, roots: [directory] }
    try {
      const value: unknown = JSON.parse(await readFile(join(stateDirectory, 'storage.json'), 'utf8'))
      if (!record(value) || value.version !== 1 || typeof value.directory !== 'string' || !qualified(value.directory)
        || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.roots)) {
        throw new Error('Invalid artifact preferences')
      }
      const history: string[] = []
      for (const root of value.roots) {
        if (typeof root !== 'string' || !qualified(root)) throw new Error('Invalid artifact root history')
        history.push(root)
      }
      prefs = {
        version: 1, directory: value.directory, revision: value.revision, roots: [...new Set([directory, ...history, value.directory])],
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    for (const root of legacyRoots) {
      const canonical = await realpath(root).catch(() => undefined)
      if (canonical !== undefined && !contained(canonical, stateDirectory) && !contained(stateDirectory, canonical)) {
        prefs.roots.push(canonical)
      }
    }
    prefs.roots = [...new Set(prefs.roots)]
    if (prefs.roots.some(root => contained(root, stateDirectory) || contained(stateDirectory, root))) {
      throw new Error('Private state cannot be an artifact browsing root')
    }
    return new ArtifactStore(ctx, directory, stateDirectory, prefs, workspaces)
  }
  /**
   * Snapshot committed preferences without exposing mutable internal history.
   * @returns The current and default directories, revision, and a copy of the retained canonical browsing roots.
   */
  info(): ArtifactStorageInfo {
    return {
      directory: this.prefs.directory, defaultDirectory: this.defaultDirectory, revision: this.prefs.revision, roots: [...this.prefs.roots],
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.track(() => this.queue.then(operation))
    this.queue = next.catch(() => {})
    return next
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ArtifactError('ARTIFACT_STORAGE_UNAVAILABLE', 503, 'Artifact storage is closing'))
    const pending = operation()
    this.operations.add(pending)
    void pending.finally(() => { this.operations.delete(pending) }).catch(() => {})
    return pending
  }
  private async directory(path: string, signal: AbortSignal, expected?: string): Promise<string> {
    signal.throwIfAborted()
    if (!qualified(path)) throw new ArtifactError('ARTIFACT_STORAGE_INVALID', 400, 'Directory must be fully qualified')
    const canonical = await realpath(path).catch(() => { throw new ArtifactError('ARTIFACT_STORAGE_INVALID', 400, 'Choose an existing directory') })
    if (expected !== undefined && canonical !== expected) throw new ArtifactError('ARTIFACT_STORAGE_INVALID', 409, 'Captured output directory changed')
    if (!(await lstat(canonical)).isDirectory() || contained(canonical, this.stateDirectory) || contained(this.stateDirectory, canonical)) {
      throw new ArtifactError('ARTIFACT_STORAGE_INVALID', 400, 'Choose a separate output directory')
    }
    const probe = join(canonical, '.yunshu-write-probe-' + randomUUID())
    const linkedProbe = probe + '.linked'
    let probeInfo: FileInfo | undefined
    let linked = false
    try {
      try {
        const handle = await open(probe, 'wx', 0o600)
        try { probeInfo = await handle.stat() }
        finally { await handle.close() }
      } catch { throw new ArtifactError('ARTIFACT_STORAGE_UNWRITABLE', 409, 'The output directory is not writable') }
      // Publication needs exclusive same-volume linking as well as creating a file.
      try { await link(probe, linkedProbe); linked = true }
      catch { throw new ArtifactError('ARTIFACT_MOVE_UNSUPPORTED', 409, 'This filesystem cannot safely publish without overwriting') }
    } finally {
      if (probeInfo !== undefined) {
        let cleanupFailed = false
        for (const owned of linked ? [linkedProbe, probe] : [probe]) {
          try {
            const current = await lstat(owned)
            if (sameFile(probeInfo, current)) await unlink(owned)
            else cleanupFailed = true
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') cleanupFailed = true
          }
        }
        if (cleanupFailed) throw new ArtifactError('ARTIFACT_OPERATION_UNKNOWN', 409, 'Output probe cleanup could not be confirmed')
      }
    }
    signal.throwIfAborted()
    return canonical
  }
  /**
   * Commit a directory choice without reloading any in-flight account jobs.
   * @param path - Existing output directory, validated and canonicalized before it can become a retained root.
   * @param revision - Last observed preferences revision; a mismatch rejects instead of overwriting concurrent changes.
   * @param signal - Cancellation checked while validating the directory before committing preferences.
   * @returns The durably committed storage snapshot with an incremented revision and all previous roots retained.
   */
  setDirectory(path: string, revision: number, signal: AbortSignal): Promise<ArtifactStorageInfo> {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(revision) || revision !== this.prefs.revision) throw new ArtifactError('ARTIFACT_STALE', 409, 'Storage settings changed; refresh first')
      const directory = await this.directory(path, signal)
      const next: Preferences = {
        version: 1, directory, revision: this.prefs.revision + 1, roots: [...new Set([...this.prefs.roots, directory])],
      }
      await atomicJson(join(this.stateDirectory, 'storage.json'), next)
      this.prefs = next
      return this.info()
    })
  }
  capture(signal: AbortSignal): Promise<ArtifactDestination> {
    return this.track(async () => {
      const destination = { directory: this.prefs.directory }
      await this.directory(destination.directory, signal, destination.directory)
      return destination
    })
  }
  /** Validate the retained original destination before resuming further billable work. */
  validate(destination: ArtifactDestination, signal: AbortSignal): Promise<void> {
    return this.track(async () => {
      if (!this.prefs.roots.includes(destination.directory)) throw new ArtifactError('ARTIFACT_OUTPUT_INVALID', 400, 'Unknown output destination')
      await this.directory(destination.directory, signal, destination.directory)
    })
  }
  private output(
    destination: ArtifactDestination, filename: string, signal: AbortSignal, prepare: (temporary: string) => Promise<void>,
  ): Promise<{ path: string }> {
    return this.track(async () => {
      signal.throwIfAborted()
      if (!this.prefs.roots.includes(destination.directory) || !validName(filename)) throw new ArtifactError('ARTIFACT_OUTPUT_INVALID', 400, 'Use a captured directory and a portable filename')
      const canonical = await realpath(destination.directory)
      if (canonical !== destination.directory) throw new ArtifactError('ARTIFACT_STORAGE_INVALID', 409, 'Captured output directory changed')
      const temporary = join(canonical, '.yunshu-output-' + randomUUID())
      const target = join(canonical, filename)
      try {
        await prepare(temporary)
        signal.throwIfAborted()
        const info = await lstat(temporary)
        await exclusiveMove(temporary, target, info)
        return { path: target }
      } finally { await unlink(temporary).catch(() => {}) }
    })
  }
  write(request: ArtifactWriteRequest): Promise<{ path: string }> {
    return this.output(request.destination, request.filename, request.signal, async (temporary) => {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(request.bytes, { signal: request.signal }); await handle.sync() }
      finally { await handle.close() }
    })
  }
  publish(request: ArtifactPublishRequest): Promise<{ path: string }> {
    return this.output(request.destination, request.filename, request.signal, async (temporary) => {
      const source = await lstat(request.sourcePath)
      if (!source.isFile() || source.isSymbolicLink()) throw new ArtifactError('ARTIFACT_PATH_INVALID', 400, 'Publication source must be a regular file')
      await copyFile(request.sourcePath, temporary, constants.COPYFILE_EXCL)
      if (!sameFile(source, await lstat(request.sourcePath))) throw new ArtifactError('ARTIFACT_STALE', 409, 'Publication source changed')
    })
  }
  private async source(path: string, scope?: ArtifactWorkspaceScope): Promise<{
    path: string
    info: FileInfo
    workspaceRoot?: string
  }> {
    if (scope === undefined) return authorizedFile(path, this.prefs.roots)
    if (this.workspaces === undefined) throw new ArtifactError('ARTIFACT_WORKSPACE_UNAVAILABLE', 404, 'Workspace files are unavailable')
    const workspace = await this.workspaces.resolve(scope.workspaceId, scope.signal)
    return { ...await this.workspaces.file(workspace, path, scope.signal), workspaceRoot: workspace.path }
  }
  /**
   * Rename only the version the user selected, using an exclusive same-volume operation.
   * @param path - Existing regular file within a retained canonical artifact root.
   * @param name - Portable visible replacement name in the same directory, without path components.
   * @param expected - Listed size and modification time that must still match before the move.
   * @param scope - Optional authenticated Workspace coordinates; omitted addresses managed output roots only.
   * @returns The canonical renamed path; stale, occupied, or unsupported moves reject without overwriting another file.
   */
  rename(path: string, name: string, expected: ExpectedArtifact, scope?: ArtifactWorkspaceScope): Promise<string> {
    return this.serialize(async () => {
      if (!validName(name)) throw new ArtifactError('ARTIFACT_NAME_INVALID', 400, 'Invalid file name')
      const source = await this.source(path, scope)
      expectedVersion(source.info, expected)
      const target = join(dirname(source.path), name)
      if (source.workspaceRoot !== undefined && this.workspaces !== undefined) {
        this.workspaces.visible({ path: source.workspaceRoot }, target)
      }
      if (target === source.path) return target
      await exclusiveMove(source.path, target, source.info)
      return target
    })
  }
  /**
   * Move into an exclusively created hidden same-volume container, retaining a durable recovery record.
   * @param path - Existing regular artifact to remove from its visible original location.
   * @param expected - Listed size and modification time that must still match before the move.
   * @param scope - Optional authenticated Workspace coordinates; omitted addresses managed output roots only.
   * @returns A durable recovery identifier after the move succeeds; the payload is retained rather than permanently deleted.
   */
  trash(path: string, expected: ExpectedArtifact, scope?: ArtifactWorkspaceScope): Promise<string> {
    return this.serialize(async () => {
      const source = await this.source(path, scope)
      expectedVersion(source.info, expected)
      const id = randomUUID()
      const container = join(dirname(source.path), '.yunshu-trash-' + id)
      await mkdir(container, { mode: 0o700 })
      const value: TrashRecord = {
        version: 1, id, name: basename(source.path), originalPath: source.path,
        storedPath: join(container, 'payload'), deletedAt: new Date().toISOString(),
        ...source.workspaceRoot === undefined ? {} : { workspaceRoot: source.workspaceRoot },
      }
      await atomicJson(join(this.stateDirectory, 'trash', id + '.json'), value)
      await exclusiveMove(source.path, value.storedPath, source.info)
      return id
    })
  }
  private async trashRecord(id: string): Promise<TrashRecord> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id)) throw new ArtifactError('ARTIFACT_TRASH_INVALID', 400, 'Invalid recovery record')
    let value: unknown
    try { value = JSON.parse(await readFile(join(this.stateDirectory, 'trash', id + '.json'), 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactError('ARTIFACT_NOT_FOUND', 404, 'Recovery record not found')
      if (error instanceof SyntaxError) throw new ArtifactError('ARTIFACT_TRASH_INVALID', 409, 'Recovery record is damaged')
      throw new ArtifactError('ARTIFACT_OPERATION_FAILED', 500, 'Recovery record could not be read')
    }
    if (!record(value) || value.version !== 1 || value.id !== id || typeof value.originalPath !== 'string' || !qualified(value.originalPath)
      || value.workspaceRoot !== undefined && (typeof value.workspaceRoot !== 'string' || !qualified(value.workspaceRoot))
      || typeof value.name !== 'string' || !(typeof value.workspaceRoot === 'string'
      ? contained(value.workspaceRoot, value.originalPath) : this.prefs.roots.some(root => contained(root, String(value.originalPath))))
      || value.storedPath !== join(dirname(value.originalPath), '.yunshu-trash-' + id, 'payload') || value.name !== basename(value.originalPath)
      || typeof value.deletedAt !== 'string' || !Number.isFinite(Date.parse(value.deletedAt))) {
      throw new ArtifactError('ARTIFACT_TRASH_INVALID', 409, 'Invalid recovery record')
    }
    return {
      version: 1, id, name: value.name, originalPath: value.originalPath,
      storedPath: value.storedPath, deletedAt: value.deletedAt,
      ...typeof value.workspaceRoot === 'string' ? { workspaceRoot: value.workspaceRoot } : {},
    }
  }
  private async recoveryRoots(value: TrashRecord, signal: AbortSignal): Promise<readonly string[]> {
    if (value.workspaceRoot === undefined) return this.prefs.roots
    if (this.workspaces === undefined) throw new ArtifactError('ARTIFACT_WORKSPACE_UNAVAILABLE', 404, 'Register the original Workspace to restore its file')
    const workspace = await this.workspaces.byRoot(value.workspaceRoot, signal)
    this.workspaces.visible(workspace, value.originalPath)
    return [workspace.path]
  }
  /**
   * List only recoverable payloads; failed or completed moves expose no phantom deletion.
   * @param signal - Cancellation while reading recovery records and authorizing their current Workspace roots.
   * @returns Recovery identifiers and original display metadata, newest first; damaged records reject visibly.
   */
  trashed(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ id: string; name: string; originalPath: string; deletedAt: string }[]> {
    return this.track(async () => {
      const items: { id: string; name: string; originalPath: string; deletedAt: string }[] = []
      for (const filename of await readdir(join(this.stateDirectory, 'trash'))) {
        signal.throwIfAborted()
        if (!filename.endsWith('.json')) continue
        const value = await this.trashRecord(filename.slice(0, -5))
        try {
          const roots = await this.recoveryRoots(value, signal)
          await authorizedFile(value.storedPath, roots)
          items.push({ id: value.id, name: value.name, originalPath: value.originalPath, deletedAt: value.deletedAt })
        } catch (error) {
          // Detached Workspace records stay visible so re-registering the original root can recover them.
          if (error instanceof ArtifactError && (error.code === 'ARTIFACT_WORKSPACE_UNAVAILABLE'
            || error.code === 'ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED')) {
            items.push({ id: value.id, name: value.name, originalPath: value.originalPath, deletedAt: value.deletedAt })
            continue
          }
          // An absent payload belongs to a failed delete or an already completed restore.
          if (!(error instanceof ArtifactError) || error.code !== 'ARTIFACT_NOT_FOUND') throw error
        }
      }
      return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
    })
  }
  /**
   * Restore the recorded original location without replacing a new file at that path.
   * @param id - Durable recovery identifier returned by a successful reversible deletion.
   * @param signal - Cancellation during authorization, before the admitted restoration begins moving files.
   * @returns The restored canonical path; an occupied or redirected original directory rejects while retaining the payload.
   */
  restore(id: string, signal: AbortSignal = new AbortController().signal): Promise<string> {
    return this.serialize(async () => {
      const value = await this.trashRecord(id)
      const source = await authorizedFile(value.storedPath, await this.recoveryRoots(value, signal))
      if (await realpath(dirname(value.originalPath)) !== dirname(value.originalPath)) throw new ArtifactError('ARTIFACT_PATH_FORBIDDEN', 403, 'Original directory changed')
      signal.throwIfAborted()
      await exclusiveMove(source.path, value.originalPath, source.info)
      // The payload is now absent, so a failed record cleanup never repeats the restore.
      await unlink(join(this.stateDirectory, 'trash', id + '.json')).catch(() => {})
      return value.originalPath
    })
  }
}
