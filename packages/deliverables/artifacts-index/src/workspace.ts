/** Registered local Workspace authorization and bounded one-level file browsing. @module */
import { lstat, opendir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-fs'
import { ArtifactError, authorizedFile, contained, qualified } from './storage.ts'

/** Detached registered Workspace identity returned to the browser. */
export interface ArtifactWorkspace { readonly id: string; readonly title: string; readonly path: string }
/** Filesystem metadata before the HTTP owner adds its presentation kind. */
export interface WorkspaceFile { readonly path: string; readonly name: string; readonly size: number; readonly mtimeMs: number }
/** One bounded directory listing, with portable relative navigation coordinates. */
export interface WorkspaceDirectory {
  readonly workspace: ArtifactWorkspace
  readonly directory: string
  readonly absoluteDirectory: string
  readonly parentDirectory: string | null
  readonly directories: readonly { name: string; directory: string }[]
  readonly items: readonly WorkspaceFile[]
  readonly truncated: boolean
}
/** Authenticated operation coordinates; the directory is always resolved from the registry. */
export interface ArtifactWorkspaceScope { readonly workspaceId: string; readonly signal: AbortSignal }

// Dependency trees are navigation exclusions, not configurable output destinations.
const DEPENDENCIES = new Set(['node_modules', 'bower_components', 'vendor', '__pycache__', 'venv'])

/** Trusted Host reader; Workspace roots never become retained output preferences. */
export class WorkspaceAccess {
  /**
   * @param ctx - Host context carrying the current registry and filesystem mapping.
   * @param stateDirectory - Read the canonical private artifact state directory after storage initialization, if configured.
   */
  constructor(private readonly ctx: Context, private readonly stateDirectory: () => string | undefined = () => undefined) {}

  /**
   * Resolve a currently registered Workspace and verify its original local directory.
   * @param id - Opaque Workspace identity supplied by the authenticated browser.
   * @param signal - Request or Host lifetime cancellation.
   * @returns Registered identity with a pinned canonical Host directory; unknown or unsupported roots reject.
   */
  async resolve(id: string, signal: AbortSignal): Promise<ArtifactWorkspace> {
    signal.throwIfAborted()
    const workspace = this.ctx.get('workspaceRegistry')?.list().find(candidate => String(candidate.id) === id)
    if (workspace === undefined || !qualified(workspace.path)) throw this.unavailable()
    const root = { id: String(workspace.id), title: workspace.title, path: workspace.path }
    const canonical = await realpath(root.path).catch(() => undefined)
    signal.throwIfAborted()
    if (canonical !== root.path || !(await lstat(root.path).catch(() => undefined))?.isDirectory()) throw this.unavailable()
    const stateDirectory = this.stateDirectory()
    if (stateDirectory !== undefined && contained(stateDirectory, root.path)) throw this.unavailable()
    const fs = this.ctx.get('fs')
    const mapped = fs?.processPathFromHostPath(root.path)
    if (fs === undefined || mapped === undefined
      || fs.processPath(await fs.resolve(mapped, { signal })) !== root.path) {
      throw new ArtifactError('ARTIFACT_WORKSPACE_REMOTE_UNSUPPORTED', 409, 'Workspace files must map to this Host filesystem')
    }
    signal.throwIfAborted()
    if (await realpath(root.path).catch(() => undefined) !== root.path) throw this.unavailable()
    return root
  }

  /**
   * Recover a registered root for a durable deletion, allowing a new registry id for the same directory.
   * @param path - Original pinned Workspace root recorded at deletion time.
   * @param signal - Request or Host lifetime cancellation.
   * @returns Its current registered identity; an unregistered root never gains authorization from the record alone.
   */
  byRoot(path: string, signal: AbortSignal): Promise<ArtifactWorkspace> {
    const workspace = this.ctx.get('workspaceRegistry')?.list().find(candidate => candidate.path === path)
    if (workspace === undefined) return Promise.reject(this.unavailable())
    return this.resolve(String(workspace.id), signal)
  }

  /**
   * Reject hidden, dependency, private-state, and outside paths before filesystem access.
   * @param workspace - Root already verified against the current registry.
   * @param path - Absolute Host path whose visible location is requested.
   * @returns The normalized relative location, using native filesystem separators.
   */
  visible(workspace: Pick<ArtifactWorkspace, 'path'>, path: string): string {
    const part = relative(workspace.path, path)
    const stateDirectory = this.stateDirectory()
    if (!qualified(path) || !contained(workspace.path, path)
      || stateDirectory !== undefined && contained(stateDirectory, path)
      || part.split(sep).some(segment => segment.startsWith('.') || DEPENDENCIES.has(segment.toLowerCase()))) {
      throw new ArtifactError('ARTIFACT_PATH_FORBIDDEN', 403, 'Workspace path is not available in the file browser')
    }
    return part
  }

  /**
   * Authorize one visible regular local file under a currently verified root.
   * @param workspace - Registered root verified for this operation.
   * @param path - Fully qualified Host file path, never an arbitrary new root.
   * @param signal - Cancellation before the caller begins its file operation.
   * @returns Canonical file coordinates and metadata; symlink aliases and hidden paths reject.
   */
  async file(workspace: ArtifactWorkspace, path: string, signal: AbortSignal): ReturnType<typeof authorizedFile> {
    this.visible(workspace, path)
    signal.throwIfAborted()
    const file = await authorizedFile(path, [workspace.path])
    if (file.path !== path) throw new ArtifactError('ARTIFACT_PATH_FORBIDDEN', 403, 'Workspace file path changed')
    signal.throwIfAborted()
    return file
  }

  /**
   * Browse one directory without traversing its descendants or loading Session history.
   * @param id - Currently registered Workspace identity.
   * @param directory - Slash-separated relative directory; the root is an empty string.
   * @param limit - Complete result limit shared by files and navigable directories.
   * @param signal - Cancellation between filesystem operations and directory entries.
   * @returns One bounded page with native absolute paths and portable relative navigation coordinates.
   */
  async list(id: string, directory: string, limit: number, signal: AbortSignal): Promise<WorkspaceDirectory> {
    const workspace = await this.resolve(id, signal)
    if (directory !== '' && (isAbsolute(directory) || /[\\:\u0000-\u001f\u007f]/u.test(directory)
      || directory.split('/').some(part => part === '' || part === '.' || part === '..'))) {
      throw new ArtifactError('ARTIFACT_DIRECTORY_INVALID', 400, 'Use a relative Workspace directory')
    }
    const absoluteDirectory = directory === '' ? workspace.path : join(workspace.path, ...directory.split('/'))
    this.visible(workspace, absoluteDirectory)
    if (await realpath(absoluteDirectory).catch(() => undefined) !== absoluteDirectory
      || !(await lstat(absoluteDirectory).catch(() => undefined))?.isDirectory()) {
      throw new ArtifactError('ARTIFACT_DIRECTORY_INVALID', 400, 'Workspace directory is unavailable or redirected')
    }
    signal.throwIfAborted()
    const directories: { name: string; directory: string }[] = []
    const items: WorkspaceFile[] = []
    let truncated = false
    for await (const child of await opendir(absoluteDirectory)) {
      signal.throwIfAborted()
      const path = join(absoluteDirectory, child.name)
      try { this.visible(workspace, path) } catch { continue }
      if (child.isSymbolicLink() || !child.isDirectory() && !child.isFile()) continue
      const info = await lstat(path).catch(() => undefined)
      if (info === undefined || info.isSymbolicLink() || await realpath(path).catch(() => undefined) !== path) continue
      signal.throwIfAborted()
      if (!info.isDirectory() && !info.isFile()) continue
      if (info.isDirectory() && /[\\:\u0000-\u001f\u007f]/u.test(child.name)) continue
      if (directories.length + items.length >= limit) { truncated = true; break }
      if (info.isDirectory()) directories.push({ name: child.name, directory: directory === '' ? child.name : directory + '/' + child.name })
      else items.push({ path, name: basename(path), size: info.size, mtimeMs: info.mtimeMs })
    }
    signal.throwIfAborted()
    directories.sort((left, right) => left.name.localeCompare(right.name))
    items.sort((left, right) => right.mtimeMs - left.mtimeMs)
    return {
      workspace, directory, absoluteDirectory,
      parentDirectory: directory === '' ? null : directory.split('/').slice(0, -1).join('/'),
      directories, items, truncated,
    }
  }

  private unavailable(): ArtifactError {
    return new ArtifactError('ARTIFACT_WORKSPACE_UNAVAILABLE', 404, 'Workspace is no longer registered or its directory is unavailable')
  }
}
